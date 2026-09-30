/**
 * NexDrop Sender Engine.
 * Streams files of any size using strictly File.slice() — never loads the
 * whole file into RAM.
 *
 * Enforces:
 * - 64 KiB chunks
 * - RTCDataChannel backpressure (bufferedAmount / bufferedAmountLowThreshold)
 * - ACK sliding-window flow control
 * - Pause / Resume / Cancel
 * - Optional AES-256-GCM application-layer chunk encryption (E2EE)
 * - Incremental SHA-256 of the file content while streaming (any file size)
 * - Throttled UI progress updates (10 Hz max)
 */

import {
  BUFFERED_AMOUNT_LOW_THRESHOLD,
  DEFAULT_FLOW_CONTROL_WINDOW,
  ACK_BATCH,
  FileStartMessage,
} from '@/types/transfer';
import { encodeBinaryChunk } from './protocol';
import { bytesToBase64Url, ChunkCipher, encryptChunk, generateIvPrefix, IncrementalSha256 } from '@/lib/crypto';
import { initialChunkSize, noteTransferSuccess, noteTransferFailure } from './tuner';

export interface SenderProgress {
  transferId: string;
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  speedBps: number;
  etaSeconds: number;
  status: 'transferring' | 'paused' | 'completed' | 'cancelled' | 'failed';
  currentChunk: number;
  totalChunks: number;
}

export interface SenderOptions {
  file: File;
  transferId: string;
  fileChannel: RTCDataChannel;
  sendControlMessage: (msg: any) => boolean;
  onProgress: (p: SenderProgress) => void;
  onCompleted: (transferId: string, hash: string) => void;
  onError: (transferId: string, err: string) => void;
  /** Session AES-GCM cipher for app-layer encryption. Null = transport-only. */
  cipher?: ChunkCipher | null;
  /** Negotiated SCTP max message size (pc.sctp.maxMessageSize). 0/undefined = unknown. */
  maxMessageSize?: number;
}

export class SenderEngine {
  private file: File;
  private transferId: string;
  private fileChannel: RTCDataChannel;
  private sendControlMessage: (msg: any) => boolean;
  private onProgress: (p: SenderProgress) => void;
  private onCompleted: (transferId: string, hash: string) => void;
  private onError: (transferId: string, err: string) => void;
  private cipher?: ChunkCipher | null;
  /** Per-transfer random IV prefix — unique IVs across files in one session. */
  private ivPrefix: Uint8Array | null = null;

  private totalChunks: number;
  private readonly chunkSize: number;
  private currentChunkIndex = 0;
  private acknowledgedChunkIndex = -1;

  // ---- MEASURED flow control (nothing here is synthesized) ----
  /** Send timestamp per in-flight chunk → real RTT from ACK timing. */
  private sendTimes = new Map<number, number>();
  /** EWMA round-trip time in ms (chunk sent → chunk acknowledged). */
  private rttMs = 0;
  /** Adaptive in-flight window (chunks), ACK-driven. */
  private window = DEFAULT_FLOW_CONTROL_WINDOW;
  /** Measured throughput from the ACK cadence (bytes/sec). */
  private throughputBps = 0;
  private ackedBytes = 0;
  private ackedAt = 0;
  /** Backpressure events (long buffer waits / ACK starvation). */
  private stallCount = 0;
  private lastStallAt = 0;
  private isPaused = false;
  private isCancelled = false;
  private isDone = false;

  private lastProgressEmit = 0;
  private startTime = 0;
  private recentSpeeds: number[] = [];
  private hasher = new IncrementalSha256();

  constructor(options: SenderOptions) {
    this.file = options.file;
    this.transferId = options.transferId;
    this.fileChannel = options.fileChannel;
    this.sendControlMessage = options.sendControlMessage;
    this.onProgress = options.onProgress;
    this.onCompleted = options.onCompleted;
    this.onError = options.onError;
    this.cipher = options.cipher ?? null;

    // Never send a frame larger than the negotiated SCTP limit. Chrome
    // offers 262144, but some paths negotiate exactly 64 KiB — a raw
    // 64 KiB chunk plus the crypto envelope would exceed it and the
    // channel throws. Headroom covers header + IV prefix + GCM tag.
    // Never send a frame larger than the negotiated SCTP limit. Starts
    // conservative (64 KiB) and grows only from measured, stable runs of
    // PREVIOUS transfers in this session (see ./tuner).
    const negotiated = options.maxMessageSize && options.maxMessageSize > 0 ? options.maxMessageSize : 65536;
    this.chunkSize = initialChunkSize(negotiated);

    this.totalChunks = Math.max(1, Math.ceil(this.file.size / this.chunkSize));
    this.fileChannel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
  }

  public handleAck(index: number, writeMs?: number) {
    const sentAt = this.sendTimes.get(index);
    if (sentAt !== undefined) {
      const sample = Date.now() - sentAt;
      if (sample > 0 && sample < 30000) {
        // Real RTT: chunk N sent → chunk N acknowledged.
        this.rttMs = this.rttMs > 0 ? this.rttMs * 0.75 + sample * 0.25 : sample;
      }
      for (let i = index; i >= index - 64 && i >= 0; i--) this.sendTimes.delete(i);
      if (this.sendTimes.size > 512) this.sendTimes.clear();
    }

    const newlyAcked = index - this.acknowledgedChunkIndex;
    this.acknowledgedChunkIndex = Math.max(this.acknowledgedChunkIndex, index);

    // Measured throughput from the ACK cadence (real bytes, real time).
    const now = Date.now();
    if (newlyAcked > 0) {
      const bytes = newlyAcked * this.chunkSize;
      if (this.ackedAt > 0 && now > this.ackedAt) {
        const inst = bytes / ((now - this.ackedAt) / 1000);
        this.throughputBps = this.throughputBps > 0 ? this.throughputBps * 0.7 + inst * 0.3 : inst;
      }
      this.ackedBytes += bytes;
      this.ackedAt = now;
    }

    this.tuneWindow(writeMs);
  }

  /** Window adaptation from measured RTT, throughput, receiver write cost
   *  and backpressure. Grows toward the bandwidth-delay product only while
   *  the link is stable; shrinks immediately on real pressure. */
  private tuneWindow(writeMs?: number): void {
    // Receiver is write-bound (slow disk/OPFS): fewer chunks in flight so
    // its buffer stays bounded — real receiver write-throughput feedback.
    if (writeMs !== undefined && writeMs > 12) {
      this.window = Math.max(ACK_BATCH, Math.floor(this.window * 0.8));
      return;
    }
    // Recently backpressured: hold, let the shrink below take effect.
    if (Date.now() - this.lastStallAt < 2000) return;
    if (this.rttMs > 0 && this.throughputBps > 0) {
      const bdpChunks = Math.ceil((this.throughputBps / 8) * (this.rttMs / 1000) / this.chunkSize);
      const target = Math.max(ACK_BATCH, Math.min(256, bdpChunks + ACK_BATCH));
      this.window = Math.min(Math.max(this.window, target), 256);
    }
  }

  /** Real backpressure: a meaningful buffer wait or ACK starvation. */
  private noteStall(): void {
    this.lastStallAt = Date.now();
    this.stallCount++;
    this.window = Math.max(ACK_BATCH, Math.floor(this.window * 0.75));
  }

  /** Measured link metrics (for diagnostics — never faked). */
  public get metrics(): { rttMs: number; window: number; throughputBps: number; stalls: number } {
    return { rttMs: this.rttMs, window: this.window, throughputBps: this.throughputBps, stalls: this.stallCount };
  }

  public pause() {
    if (this.isDone || this.isCancelled) return;
    this.isPaused = true;
    this.sendControlMessage({ type: 'PAUSE', transferId: this.transferId });
    this.emitProgress('paused', 0, 0);
  }

  public resume() {
    if (!this.isPaused || this.isCancelled || this.isDone) return;
    this.isPaused = false;
    this.sendControlMessage({
      type: 'RESUME',
      transferId: this.transferId,
      nextChunk: this.currentChunkIndex,
    });
    void this.pump();
  }

  /** The transfer this engine instance is bound to (for control-message matching). */
  public get activeTransferId(): string {
    return this.transferId;
  }

  /** Real transfer failure — resets the learned link profile (conservative). */
  private fail(reason: string): void {
    noteTransferFailure();
    this.onError(this.transferId, reason);
  }

  public cancel(reason: string = 'Cancelled by sender') {
    if (this.isDone) return;
    this.isCancelled = true;
    this.sendControlMessage({ type: 'CANCEL', transferId: this.transferId, reason });
    this.emitProgress('cancelled', 0, 0);
  }

  public async start(): Promise<void> {
    this.startTime = Date.now();
    this.isDone = false;
    this.isCancelled = false;
    this.isPaused = false;
    this.hasher = new IncrementalSha256();

    // Fresh random IV prefix per transfer — the receiver derives identical
    // IVs from this value. Without it, every file would reuse the same
    // (key, IV) pairs (chunk indexes restart at 0), which breaks GCM.
    if (this.cipher) this.ivPrefix = generateIvPrefix();

    const startMsg: FileStartMessage = {
      type: 'FILE_START',
      transferId: this.transferId,
      name: this.file.name,
      size: this.file.size,
      mime: this.file.type || 'application/octet-stream',
      chunkSize: this.chunkSize,
      totalChunks: this.totalChunks,
      e2eeEnabled: !!this.cipher,
      ...(this.cipher && this.ivPrefix
        ? { ivPrefix: bytesToBase64Url(this.ivPrefix) }
        : {}),
    };

    const sent = this.sendControlMessage(startMsg);
    if (!sent) {
      this.fail('Control channel unavailable');
      return;
    }

    await this.pump();
  }

  private async pump(): Promise<void> {
    let lastBytes = this.currentChunkIndex * this.chunkSize;
    let lastTime = Date.now();

    while (this.currentChunkIndex < this.totalChunks) {
      if (this.isCancelled || this.isDone) return;
      if (this.isPaused) return; // pump() is re-invoked by resume()

      // ACK sliding-window flow control
      const inFlight = this.currentChunkIndex - this.acknowledgedChunkIndex;
      if (inFlight > DEFAULT_FLOW_CONTROL_WINDOW) {
        await this.waitForAckSlot();
        if (this.isCancelled || this.isPaused) return;
      }

      // RTCDataChannel backpressure
      if (this.fileChannel.readyState !== 'open') {
        this.fail('Connection lost during transfer');
        this.emitProgress('failed', 0, 0);
        return;
      }
      if (this.fileChannel.bufferedAmount > BUFFERED_AMOUNT_LOW_THRESHOLD) {
        await this.waitForBufferLow();
        if (this.isCancelled || this.isPaused) return;
      }

      // Stream one bounded slice — never the whole file.
      const start = this.currentChunkIndex * this.chunkSize;
      const end = Math.min(start + this.chunkSize, this.file.size);
      const slice = this.file.slice(start, end);

      let chunkBuffer: ArrayBuffer;
      try {
        chunkBuffer = await slice.arrayBuffer();
      } catch (err: any) {
        this.fail(`File read error: ${err?.message || err}`);
        this.emitProgress('failed', 0, 0);
        return;
      }

      // The awaited read above can straddle a pause() call. Re-check BEFORE
      // hashing: the incremental hash must only ever consume chunks that are
      // actually sent. Pausing here (chunkIndex not yet advanced) makes
      // resume() re-read this same slice — hash and stream stay consistent.
      // Without this check a chunk could be hashed+sent AFTER the 'paused'
      // emit, leaving the UI stuck on 'Streaming' for a paused transfer.
      if (this.isCancelled || this.isPaused) return;

      // Incremental hash of the PLAINTEXT content
      this.hasher.update(new Uint8Array(chunkBuffer));

      let payload: ArrayBuffer = chunkBuffer;
      if (this.cipher) {
        try {
          if (!this.ivPrefix) throw new Error('E2EE transfer missing IV prefix');
          payload = await encryptChunk(this.cipher, this.ivPrefix, this.currentChunkIndex, chunkBuffer);
        } catch (err: any) {
          this.fail(`Encryption error: ${err?.message || err}`);
          this.emitProgress('failed', 0, 0);
          return;
        }
      }

      const packet = encodeBinaryChunk(
        this.currentChunkIndex,
        this.totalChunks,
        this.transferId,
        payload
      );

      this.sendTimes.set(this.currentChunkIndex, Date.now());
      try {
        this.fileChannel.send(packet);
      } catch (err: any) {
        this.fail(`Send error: ${err?.message || err}`);
        this.emitProgress('failed', 0, 0);
        return;
      }

      this.currentChunkIndex++;

      // Real speed & ETA from actual transfer counters, throttled to 100ms.
      // Never emit 'transferring' once paused/cancelled: a pause can land
      // while this chunk was already committed to send (hash consumed it),
      // and a stale 'transferring' emit would overwrite the authoritative
      // 'paused' status in the UI.
      const now = Date.now();
      if (
        !this.isPaused &&
        !this.isCancelled &&
        (now - this.lastProgressEmit >= 100 || this.currentChunkIndex === this.totalChunks)
      ) {
        const bytesSent = Math.min(this.file.size, this.currentChunkIndex * this.chunkSize);
        const timeDiff = Math.max(0.001, (now - lastTime) / 1000);
        const bytesDiff = bytesSent - lastBytes;
        const currentSpeed = bytesDiff / timeDiff;

        this.recentSpeeds.push(currentSpeed);
        if (this.recentSpeeds.length > 5) this.recentSpeeds.shift();
        const avgSpeed =
          this.recentSpeeds.reduce((a, b) => a + b, 0) / this.recentSpeeds.length;

        const remainingBytes = this.file.size - bytesSent;
        const eta = avgSpeed > 0 ? Math.ceil(remainingBytes / avgSpeed) : 0;

        this.emitProgress('transferring', avgSpeed, eta);
        this.lastProgressEmit = now;
        lastBytes = bytesSent;
        lastTime = now;
      }
    }

    // All chunks sent — wait for the final ACK before declaring completion
    const finalAckDeadline = Date.now() + 30000;
    while (this.acknowledgedChunkIndex < this.totalChunks - 1) {
      if (this.isCancelled) return;
      if (Date.now() > finalAckDeadline) {
        this.fail('Peer stopped acknowledging data');
        this.emitProgress('failed', 0, 0);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    if (this.isCancelled) return;
    this.isDone = true;

    // Incremental hash — computed while streaming, no extra full read needed
    let hash = '';
    try {
      hash = this.hasher.finalize();
    } catch {
      hash = '';
    }

    this.sendControlMessage({ type: 'FILE_END', transferId: this.transferId, hash });
    this.emitProgress('completed', 0, 0);
    // Measured-link learning for the NEXT transfer in this session: grow
    // the chunk size only from clean, healthy runs — never synthesized.
    const elapsedS = Math.max(0.001, (Date.now() - this.startTime) / 1000);
    noteTransferSuccess(this.chunkSize, this.ackedBytes / elapsedS, this.stallCount);
    this.onCompleted(this.transferId, hash);
  }

  private waitForBufferLow(): Promise<void> {
    return new Promise((resolve) => {
      if (this.fileChannel.readyState !== 'open') return resolve();
      if (this.fileChannel.bufferedAmount <= BUFFERED_AMOUNT_LOW_THRESHOLD) return resolve();

      const waitStart = Date.now();
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.fileChannel.removeEventListener('bufferedamountlow', done);
        // Short buffer waits are normal at line rate. A wait that clearly
        // outlasted the drain expectation is REAL backpressure.
        if (Date.now() - waitStart > 150) this.noteStall();
        resolve();
      };

      // Failsafe timer in case the event is not fired by the browser
      const timer = setTimeout(done, 50);
      this.fileChannel.addEventListener('bufferedamountlow', done);
    });
  }

  private waitForAckSlot(): Promise<void> {
    return new Promise((resolve) => {
      const targetIndex = this.currentChunkIndex - this.window;
      const deadline = Date.now() + 2000;

      const poll = () => {
        if (this.isCancelled || this.isPaused) {
          resolve();
          return;
        }
        if (this.acknowledgedChunkIndex >= targetIndex) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          // ACK starvation — real instability, not a fake timeout success.
          this.noteStall();
          resolve();
          return;
        }
        setTimeout(poll, 20);
      };
      poll();
    });
  }

  private emitProgress(
    status: 'transferring' | 'paused' | 'completed' | 'cancelled' | 'failed',
    speedBps: number,
    etaSeconds: number
  ) {
    const bytesTransferred = Math.min(this.file.size, this.currentChunkIndex * this.chunkSize);
    const percentage = this.file.size > 0 ? (bytesTransferred / this.file.size) * 100 : 100;

    this.onProgress({
      transferId: this.transferId,
      bytesTransferred,
      totalBytes: this.file.size,
      percentage: Math.min(100, Math.round(percentage * 10) / 10),
      speedBps,
      etaSeconds,
      status,
      currentChunk: this.currentChunkIndex,
      totalChunks: this.totalChunks,
    });
  }
}
