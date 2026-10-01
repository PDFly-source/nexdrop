/**
 * NexDrop Sender Engine — high-throughput adaptive pipeline.
 *
 * Streams files of any size using strictly File.slice() — never loads the
 * whole file into RAM. Designed to keep the transport pipeline FULL:
 *
 * File.slice() ──► 1-slice read-ahead ──► encrypt/encode ──► RTCDataChannel
 *                        ▲                                     │
 *                        └── ACK-driven byte window ◄───────────┤
 *                                                            backpressure
 *
 * Flow control (all MEASURED, nothing synthesized):
 * - Byte-based in-flight window (not chunk-count based, so high RTT can
 *   never collapse it into stop-and-wait). Starts at 1 MiB and grows x1.5
 *   each time a full window drains cleanly, up to a 16 MiB memory cap.
 * - Shrinks only on REAL pressure: SCTP buffer stalls, receiver write
 *   backlog (q in ACKs), or ACK starvation. A single RTT spike never
 *   shrinks it (EWMA + stall cooldown, not instantaneous reactions).
 * - bufferedAmountLowThreshold pacing: fill up to 4 MiB of SCTP buffer,
 *   then wait for the 'bufferedamountlow' event (fires at 1 MiB) — an
 *   EVENT-driven wait, no sawtooth timer that silently keeps overfilling.
 * - Chunk size starts at 64 KiB and doubles mid-transfer (up to the
 *   negotiated SCTP maxMessageSize, 256 KiB ceiling) only once the window
 *   is saturated, the link has been stable and the receiver queue is
 *   healthy — so per-chunk overhead amortizes as the link proves itself.
 * - ACK-RTT EWMA + running minimum (ACK timing includes queueing delay at
 *   saturation; the running min is the honest floor estimate).
 *
 * Enforces: pause/resume/cancel, optional AES-256-GCM app-layer encryption,
 * incremental SHA-256 while streaming, 10 Hz throttled UI progress.
 */

import {
  BUFFER_HIGH_WATER,
  BUFFER_LOW_WATER,
  INITIAL_WINDOW_BYTES,
  MAX_WINDOW_BYTES,
  MIN_WINDOW_BYTES,
  FileStartMessage,
} from '@/types/transfer';
import { encodeBinaryChunk } from './protocol';
import { bytesToBase64Url, ChunkCipher, encryptChunk, generateIvPrefix, IncrementalSha256 } from '@/lib/crypto';
import { initialChunkSize, noteTransferSuccess, noteTransferFailure } from './tuner';
import { updateSenderTelemetry } from './telemetry';

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

/** Real backpressure stall: buffer drain wait / ACK starvation. */
const STALL_COOLDOWN_MS = 1500;

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

  // ---- chunking: chunk size can grow mid-transfer (see chunkSteps) ----
  /** Upper bound chunk index for this transfer (initial estimate; growth only reduces the real count). */
  private totalChunks: number;
  /** Chunk-size history — mid-transfer growth changes chunkSize for LATER indexes only. */
  private chunkSteps: Array<{ firstIndex: number; size: number }> = [];
  private get chunkSize(): number {
    return this.chunkSteps.length > 0 ? this.chunkSteps[this.chunkSteps.length - 1].size : this.chunkSteps0;
  }
  private chunkSteps0: number;
  /** Largest chunk this link may ever send: negotiated SCTP limit − protocol/crypto headroom. */
  private readonly chunkCap: number;
  /** Raw negotiated SCTP max message size (diagnostics — never assumed). */
  private readonly negotiatedMaxMessageSize: number;

  private currentChunkIndex = 0;
  /** Cumulative byte offset of chunk `i` start (from chunkSteps). */
  private bytesAtChunkStart(index: number): number {
    // Simple linear walk (chunkSteps is tiny — 3-4 entries max)
    let offset = 0;
    let prevFirst = 0;
    let prevSize = this.chunkSteps0;
    for (const step of this.chunkSteps) {
      if (index < step.firstIndex) {
        return offset + (index - prevFirst) * prevSize;
      }
      offset += (step.firstIndex - prevFirst) * prevSize;
      prevFirst = step.firstIndex;
      prevSize = step.size;
    }
    return offset + (index - prevFirst) * prevSize;
  }

  // ---- MEASURED flow control ----
  private acknowledgedChunkIndex = -1;
  /** Cumulative plaintext bytes handed to send() / acknowledged via ACKs. */
  private bytesSent = 0;
  private bytesAcked = 0;
  /** Chunk send timestamps → real ACK-RTT samples. */
  private sendTimes = new Map<number, number>();
  /** EWMA RTT from ACK timing (ms). */
  private rttEwmaMs = 0;
  /** Running minimum ACK-RTT (ms) — the honest floor (samples at saturation include queueing). */
  private minRttMs = 0;
  /** Adaptive in-flight window in BYTES (not chunks — chunk-count windows collapse under high RTT). */
  private windowBytes = INITIAL_WINDOW_BYTES;
  /** ACK frontier when the window last grew — grows once per clean window drain. */
  private lastGrowthBytes = 0;
  /** Measured throughput from the ACK cadence (bytes/sec). */
  private throughputBps = 0;
  private ackedAt = 0;
  private ackCount = 0;
  /** Backpressure events (buffer stalls / ACK starvation). */
  private stallCount = 0;
  private lastStallAt = 0;
  /** ACK frequency (ACKs/sec, EWMA) and chunk rate (chunks/sec, EWMA) —
   *  real runtime diagnostics for the physical-bottleneck matrix. */
  private acksPerSecEwma = 0;
  private chunksPerSecEwma = 0;
  private lastChunkRateAt = 0;
  /** Woken by handleAck — the window wait is event-driven, polls only as a failsafe. */
  private windowWaiters: Set<() => void> = new Set();

  private isPaused = false;
  private isCancelled = false;
  private isDone = false;

  private lastProgressEmit = 0;
  private startTime = 0;
  private recentSpeeds: number[] = [];
  private hasher = new IncrementalSha256();
  private maxBufferedAmount = 0;

  constructor(options: SenderOptions) {
    this.file = options.file;
    this.transferId = options.transferId;
    this.fileChannel = options.fileChannel;
    this.sendControlMessage = options.sendControlMessage;
    this.onProgress = options.onProgress;
    this.onCompleted = options.onCompleted;
    this.onError = options.onError;
    this.cipher = options.cipher ?? null;

    // Never send a frame larger than the negotiated SCTP limit. Headroom
    // covers the 16-byte chunk header, the 6-byte IV prefix and the GCM tag.
    const negotiated = options.maxMessageSize && options.maxMessageSize > 0 ? options.maxMessageSize : 65536;
    this.negotiatedMaxMessageSize = negotiated;
    this.chunkCap = Math.max(16 * 1024, Math.min(256 * 1024, negotiated - 256));
    // Start conservative (64 KiB, or a size learned from a previous clean
    // transfer in this session) — growth happens per measured stability.
    this.chunkSteps0 = initialChunkSize(negotiated);
    this.chunkSteps = [{ firstIndex: 0, size: this.chunkSteps0 }];

    this.totalChunks = Math.max(1, Math.ceil(this.file.size / this.chunkSteps0));
    // Event-driven SCTP buffer pacing: fill to BUFFER_HIGH_WATER, then wait
    // for 'bufferedamountlow' which fires once the buffer drains to this.
    this.fileChannel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
  }

  public handleAck(index: number, writeMs?: number, queueDepth?: number) {
    const sentAt = this.sendTimes.get(index);
    if (sentAt !== undefined) {
      const sample = Date.now() - sentAt;
      if (sample > 0 && sample < 30000) {
        this.rttEwmaMs = this.rttEwmaMs > 0 ? this.rttEwmaMs * 0.75 + sample * 0.25 : sample;
        if (this.minRttMs === 0 || sample < this.minRttMs) this.minRttMs = sample;
      }
      for (let i = index; i >= index - 64 && i >= 0; i--) this.sendTimes.delete(i);
      if (this.sendTimes.size > 512) this.sendTimes.clear();
    }

    const previouslyAckedChunk = this.acknowledgedChunkIndex;
    this.acknowledgedChunkIndex = Math.max(this.acknowledgedChunkIndex, index);
    this.ackCount++;
    // ACK frequency (real measured cadence, EWMA-smoothed).
    const ackNow = Date.now();
    if (this.ackedAt > 0 && ackNow > this.ackedAt) {
      const instAcks = 1000 / (ackNow - this.ackedAt);
      this.acksPerSecEwma = this.acksPerSecEwma > 0 ? this.acksPerSecEwma * 0.7 + instAcks * 0.3 : instAcks;
    }

    // Byte-accurate accounting even across mid-transfer chunk-size changes.
    const newlyAckedBytes =
      this.acknowledgedChunkIndex > previouslyAckedChunk
        ? this.bytesAtChunkStart(this.acknowledgedChunkIndex + 1) -
          this.bytesAtChunkStart(previouslyAckedChunk + 1)
        : 0;
    this.bytesAcked += newlyAckedBytes;

    // Measured throughput from the ACK cadence (real bytes, real time).
    const now = Date.now();
    if (newlyAckedBytes > 0) {
      if (this.ackedAt > 0 && now > this.ackedAt) {
        const inst = newlyAckedBytes / ((now - this.ackedAt) / 1000);
        this.throughputBps = this.throughputBps > 0 ? this.throughputBps * 0.7 + inst * 0.3 : inst;
      }
      this.ackedAt = now;
    }

    this.tune(index, writeMs, queueDepth);
    // Wake the pump: the window has slid forward.
    for (const wake of [...this.windowWaiters]) wake();
  }

  /**
   * Adaptive window + chunk growth from measured signals:
   * ACK-RTT EWMA, throughput, receiver write cost, receiver queue depth,
   * stall history. Grows one step per clean full-window drain; shrinks
   * immediately on real pressure but never below MIN_WINDOW_BYTES.
   */
  private tune(index: number, writeMs?: number, queueDepth?: number): void {
    const stable = Date.now() - this.lastStallAt > STALL_COOLDOWN_MS;

    // Receiver is falling behind (its write queue is backing up): shrink.
    // The receiver ACKs only after durable writes, so a growing queue on
    // its side means the sender's window exceeds its sustained write rate.
    if (queueDepth !== undefined && queueDepth > 4 && this.windowBytes > MIN_WINDOW_BYTES) {
      this.windowBytes = Math.max(MIN_WINDOW_BYTES, Math.floor(this.windowBytes * 0.8));
      this.lastGrowthBytes = this.bytesAcked;
      return;
    }
    // Receiver disk is very slow per chunk (write-bound far below the
    // network): shrink gently so its buffer stays bounded.
    if (writeMs !== undefined && writeMs > 40 && this.windowBytes > MIN_WINDOW_BYTES) {
      this.windowBytes = Math.max(MIN_WINDOW_BYTES, Math.floor(this.windowBytes * 0.85));
      this.lastGrowthBytes = this.bytesAcked;
      return;
    }

    if (!stable) return;

    // One clean full-window drain since the last change: grow.
    if (this.bytesAcked - this.lastGrowthBytes >= this.windowBytes) {
      this.lastGrowthBytes = this.bytesAcked;
      if (this.windowBytes < MAX_WINDOW_BYTES) {
        // Grow the byte window +50% per clean full-window drain. A faster
        // ramp (x2, tried 2026-10-01) reaches 16 MiB sustained pumping in
        // half the drains and COLLAPSED SCTP on the CI two-runner loopback
        // (receiver UDP socket overflow -> total stall of both 100/250 MiB
        // transfers). The x1.5 ramp is the measured-safe rate: loopback CI
        // benchmark 100 MiB avg ~6.5 MB/s, all sizes green.
        this.windowBytes = Math.min(MAX_WINDOW_BYTES, Math.ceil(this.windowBytes * 1.5));
      } else if (
        this.chunkSize < this.chunkCap &&
        (queueDepth === undefined || queueDepth <= 2) &&
        (writeMs === undefined || writeMs <= 20)
      ) {
        // Pipeline already saturated and healthy: amortize per-chunk
        // overhead by doubling the chunk size (never above the negotiated
        // SCTP limit). Applies to chunks SENT from here on.
        const next = Math.min(this.chunkCap, this.chunkSize * 2);
        if (this.currentChunkIndex > this.chunkSteps[this.chunkSteps.length - 1].firstIndex) {
          this.chunkSteps.push({ firstIndex: this.currentChunkIndex, size: next });
        }
      }
    }
  }

  /** Real backpressure: a long buffer wait or ACK starvation. */
  private noteStall(): void {
    this.lastStallAt = Date.now();
    this.stallCount++;
    // Multiplicative decrease on real pressure — with a floor that keeps
    // high-RTT links well above stop-and-wait.
    this.windowBytes = Math.max(MIN_WINDOW_BYTES, Math.floor(this.windowBytes * 0.7));
    this.lastGrowthBytes = this.bytesAcked;
  }

  /** Measured link metrics (for diagnostics — never faked). */
  public get metrics(): {
    rttMs: number; minRttMs: number; window: number; windowBytes: number; chunkSize: number;
    throughputBps: number; stalls: number; bufferedAmount: number;
    chunksPerSec: number; acksPerSec: number; sctpMaxMessageSize: number;
  } {
    return {
      rttMs: this.rttEwmaMs,
      minRttMs: this.minRttMs,
      window: Math.ceil(this.windowBytes / this.chunkSize),
      windowBytes: this.windowBytes,
      chunkSize: this.chunkSize,
      throughputBps: this.throughputBps,
      stalls: this.stallCount,
      bufferedAmount: this.fileChannel?.bufferedAmount ?? 0,
      chunksPerSec: this.chunksPerSecEwma,
      acksPerSec: this.acksPerSecEwma,
      sctpMaxMessageSize: this.negotiatedMaxMessageSize,
    };
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
    for (const wake of [...this.windowWaiters]) wake();
    this.sendControlMessage({ type: 'CANCEL', transferId: this.transferId, reason });
    this.emitProgress('cancelled', 0, 0);
  }

  public async start(): Promise<void> {
    this.startTime = Date.now();
    this.isDone = false;
    this.isCancelled = false;
    this.isPaused = false;
    this.hasher = new IncrementalSha256();
    this.bytesSent = 0;
    this.bytesAcked = 0;
    this.acknowledgedChunkIndex = -1;
    this.currentChunkIndex = 0;
    this.maxBufferedAmount = 0;
    this.acksPerSecEwma = 0;
    this.chunksPerSecEwma = 0;
    this.lastChunkRateAt = 0;

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
      chunkSize: this.chunkSteps0,
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
    let lastBytes = 0;
    let lastTime = Date.now();
    // One-slice read-ahead: the disk read of chunk N+1 overlaps the
    // encrypt/send of chunk N.
    let readAhead: Promise<ArrayBuffer> | null = null;
    let readAheadIndex = -1;

    const sliceOf = (index: number): Promise<ArrayBuffer> => {
      const start = this.bytesAtChunkStart(index);
      const end = Math.min(start + this.chunkSize, this.file.size);
      return this.file.slice(start, end).arrayBuffer();
    };

    while (this.bytesSent < this.file.size) {
      if (this.isCancelled || this.isDone) return;
      if (this.isPaused) return; // pump() is re-invoked by resume()

      // ---- ACK-driven byte window (bounded in-flight memory) ----
      if (this.bytesSent - this.bytesAcked >= this.windowBytes) {
        await this.waitForWindow();
        if (this.isCancelled || this.isPaused) return;
      }

      // ---- RTCDataChannel SCTP-buffer backpressure ----
      if (this.fileChannel.readyState !== 'open') {
        this.fail('Connection lost during transfer');
        this.emitProgress('failed', 0, 0);
        return;
      }
      if (this.fileChannel.bufferedAmount > BUFFER_HIGH_WATER) {
        await this.waitForBufferLow();
        if (this.isCancelled || this.isPaused) return;
      }

      // ---- read (with one-slice read-ahead) ----
      const index = this.currentChunkIndex;
      if (readAheadIndex !== index) readAhead = null; // stale (e.g. after pause)
      const pending = readAhead;
      readAhead = null;
      let chunkBuffer: ArrayBuffer;
      try {
        chunkBuffer = await (pending ?? sliceOf(index));
      } catch (err: any) {
        this.fail(`File read error: ${err?.message || err}`);
        this.emitProgress('failed', 0, 0);
        return;
      }

      // The awaited read above can straddle a pause() call. Re-check BEFORE
      // hashing: the incremental hash must only ever consume chunks that are
      // actually sent. Pausing here (index not yet advanced) makes resume()
      // re-read this same slice — hash and stream stay consistent.
      if (this.isCancelled || this.isPaused) return;

      // Start the next read while this chunk is encrypted + sent.
      if (this.bytesAtChunkStart(index) + chunkBuffer.byteLength < this.file.size) {
        readAhead = sliceOf(index + 1);
        readAheadIndex = index + 1;
      }

      // Incremental hash of the PLAINTEXT content
      this.hasher.update(new Uint8Array(chunkBuffer));

      let payload: ArrayBuffer = chunkBuffer;
      if (this.cipher) {
        try {
          if (!this.ivPrefix) throw new Error('E2EE transfer missing IV prefix');
          payload = await encryptChunk(this.cipher, this.ivPrefix, index, chunkBuffer);
        } catch (err: any) {
          this.fail(`Encryption error: ${err?.message || err}`);
          this.emitProgress('failed', 0, 0);
          return;
        }
      }

      const packet = encodeBinaryChunk(index, this.totalChunks, this.transferId, payload);

      this.sendTimes.set(index, Date.now());
      try {
        this.fileChannel.send(packet);
      } catch (err: any) {
        this.fail(`Send error: ${err?.message || err}`);
        this.emitProgress('failed', 0, 0);
        return;
      }

      this.currentChunkIndex = index + 1;
      this.bytesSent += chunkBuffer.byteLength;

      const bufAmt = this.fileChannel.bufferedAmount;
      if (bufAmt > this.maxBufferedAmount) this.maxBufferedAmount = bufAmt;

      // Real speed & ETA from actual transfer counters, throttled to 100ms.
      // Never emit 'transferring' once paused/cancelled: a pause can land
      // while this chunk was already committed to send (hash consumed it),
      // and a stale 'transferring' emit would overwrite the authoritative
      // 'paused' status in the UI.
      const now = Date.now();
      if (
        !this.isPaused &&
        !this.isCancelled &&
        (now - this.lastProgressEmit >= 100 || this.bytesSent >= this.file.size)
      ) {
        const timeDiff = Math.max(0.001, (now - lastTime) / 1000);
        const bytesDiff = this.bytesSent - lastBytes;
        const currentSpeed = bytesDiff / timeDiff;

        this.recentSpeeds.push(currentSpeed);
        if (this.recentSpeeds.length > 5) this.recentSpeeds.shift();
        const avgSpeed =
          this.recentSpeeds.reduce((a, b) => a + b, 0) / this.recentSpeeds.length;

        // Displayed speed is the ACK-based NETWORK truth (bytes the
        // receiver durably wrote per second) once ACK samples exist —
        // feeding the SCTP buffer faster than the link drains would
        // overstate it. The sent-based rolling average is only the
        // pre-ACK fallback.
        const displaySpeed = this.throughputBps > 0 ? this.throughputBps : avgSpeed;

        // Chunk send rate (real cadence, EWMA-smoothed).
        if (this.lastChunkRateAt > 0 && now > this.lastChunkRateAt) {
          const instChunks =
            bytesDiff / Math.max(1, this.chunkSize) / ((now - this.lastChunkRateAt) / 1000);
          this.chunksPerSecEwma =
            this.chunksPerSecEwma > 0 ? this.chunksPerSecEwma * 0.7 + instChunks * 0.3 : instChunks;
        }
        this.lastChunkRateAt = now;

        const remainingBytes = this.file.size - this.bytesSent;
        const eta = displaySpeed > 0 ? Math.ceil(remainingBytes / displaySpeed) : 0;

        this.emitProgress('transferring', displaySpeed, eta);
        this.lastProgressEmit = now;
        lastBytes = this.bytesSent;
        lastTime = now;
        updateSenderTelemetry({
          transferId: this.transferId,
          name: this.file.name,
          totalBytes: this.file.size,
          chunkSize: this.chunkSize,
          bytesSent: this.bytesSent,
          bytesAcked: this.bytesAcked,
          chunksSent: this.currentChunkIndex,
          throughputBps: this.throughputBps,
          srttMs: this.rttEwmaMs,
          minRttMs: this.minRttMs,
          inFlightBytes: this.bytesSent - this.bytesAcked,
          ackLatencyMs: this.rttEwmaMs,
          windowChunks: Math.ceil(this.windowBytes / this.chunkSize),
          windowBytes: this.windowBytes,
          bufferedAmount: this.fileChannel.bufferedAmount,
          maxBufferedAmount: this.maxBufferedAmount,
          ackCount: this.ackCount,
          stalls: this.stallCount,
          chunksPerSec: this.chunksPerSecEwma,
          acksPerSec: this.acksPerSecEwma,
          sctpMaxMessageSize: this.negotiatedMaxMessageSize,
          startedAt: this.startTime,
        });
      }
    }

    // All bytes sent — wait for the final ACK (all bytes durably received)
    // before declaring completion.
    const finalAckDeadline = Date.now() + 30000;
    while (this.bytesAcked < this.file.size) {
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
    noteTransferSuccess(this.chunkSize, this.bytesAcked / elapsedS, this.stallCount);
    this.onCompleted(this.transferId, hash);
  }

  /**
   * Event-driven wait for window space: woken by every ACK; the poll timer
   * only acts as an ACK-starvation failsafe (a real instability signal,
   * not a silent continue).
   */
  private waitForWindow(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const wake = () => {
        if (settled) return;
        if (
          this.isCancelled ||
          this.isPaused ||
          this.bytesSent - this.bytesAcked < this.windowBytes
        ) {
          settled = true;
          clearTimeout(failsafe);
          this.windowWaiters.delete(wake);
          resolve();
          return;
        }
        // Still blocked — if this was the failsafe, it is real starvation.
        if (Date.now() > deadline) {
          settled = true;
          this.windowWaiters.delete(wake);
          clearTimeout(failsafe);
          this.noteStall();
          resolve();
        }
      };
      const deadline = Date.now() + Math.max(2500, (this.rttEwmaMs || 250) * 8);
      const failsafe = setTimeout(wake, Math.max(2500, (this.rttEwmaMs || 250) * 8) + 50);
      this.windowWaiters.add(wake);
      // Already satisfied?
      wake();
    });
  }

  /**
   * SCTP buffer pacing: wait for 'bufferedamountlow' (fires at
   * BUFFER_LOW_WATER) instead of a fixed 50 ms sawtooth that overfills the
   * buffer and stalls the pipeline. Channel close and a hard 3 s failsafe
   * (counted as a real stall) end the wait.
   */
  private waitForBufferLow(): Promise<void> {
    return new Promise((resolve) => {
      if (this.fileChannel.readyState !== 'open') return resolve();
      if (this.fileChannel.bufferedAmount <= this.fileChannel.bufferedAmountLowThreshold) return resolve();

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(failsafe);
        this.fileChannel.removeEventListener('bufferedamountlow', done);
        this.fileChannel.removeEventListener('close', done);
        if (Date.now() - waitStart > 1000) this.noteStall();
        resolve();
      };

      const waitStart = Date.now();
      const failsafe = setTimeout(done, 3000);
      this.fileChannel.addEventListener('bufferedamountlow', done);
      this.fileChannel.addEventListener('close', done);
    });
  }

  private emitProgress(
    status: 'transferring' | 'paused' | 'completed' | 'cancelled' | 'failed',
    speedBps: number,
    etaSeconds: number
  ) {
    const bytesTransferred = this.isDone ? this.file.size : this.bytesSent;
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
