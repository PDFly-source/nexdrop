/**
 * NexDrop Receiver Engine — pipelined high-throughput ingest.
 *
 * Streams received chunks into File System Access / OPFS / memory-blob
 * writers with an ORDERED, OVERLAPPED pipeline:
 *
 *   chunk arrives ──► decrypt chunk N+1   (overlaps)
 *                        │ meanwhile: write chunk N (chained, in order)
 *                        ▼
 *                    durable write ──► batched/timed ACK ──► sender window slides
 *
 * - Writes are chained in arrival order on a single promise chain: chunks
 *   are decrypted while the PREVIOUS write is still in flight, but never
 *   written out of order (fixes a latent reorder race the old sequential
 *   per-chunk await could hit under E2EE).
 * - ACKs are sent only after the covered chunks are DURABLY WRITTEN, at an
 *   adaptive cadence: every ACK_BATCH chunks, at most ACK_MAX_DELAY_MS
 *   apart, immediately for the final chunk, immediately when the receiver
 *   queue backs up (backpressure signaling: the ACK carries the live queue
 *   depth so the sender shrinks its window).
 * - Incremental SHA-256 runs on the decrypted stream while writing.
 * - Memory stays bounded: the sender's in-flight window bounds the bytes
 *   in the pipeline; the queue depth feeds back to keep it that way.
 */

import {
  ACK_BATCH,
  ACK_MAX_DELAY_MS,
  FileEndMessage,
  FilePauseMessage,
  FileResumeMessage,
  FileStartMessage,
} from '@/types/transfer';
import { createOptimalStorageWriter, StorageWriter } from './writer';
import { decodeBinaryChunk, simpleStringHash } from './protocol';
import { base64UrlToBytes, ChunkCipher, decryptChunk, IncrementalSha256 } from '@/lib/crypto';
import { updateReceiverTelemetry } from './telemetry';

export interface ReceiverProgress {
  transferId: string;
  name: string;
  size: number;
  mime: string;
  bytesReceived: number;
  percentage: number;
  speedBps: number;
  etaSeconds: number;
  status: 'transferring' | 'paused' | 'completed' | 'cancelled' | 'failed';
  blobUrl?: string;
  hashVerified?: boolean;
  /** Locally computed SHA-256 hex of the decrypted content (Device Test
   *  evidence — present only when the receiver actually hashed the bytes). */
  hash?: string;
  writerType: 'filesystem' | 'opfs' | 'blob';
}

export interface ReceiverCallbacks {
  onProgress: (p: ReceiverProgress) => void;
  onCompleted: (info: ReceiverProgress) => void;
  onError: (transferId: string, error: string) => void;
  sendControlMessage: (msg: any) => boolean;
  /** Lazily fetch the session AES-GCM cipher (established after pairing). */
  getCipher?: () => ChunkCipher | null;
}

export class ReceiverEngine {
  private transferId = '';
  private name = '';
  private size = 0;
  private mime = '';
  private totalChunks = 0;
  private chunkSize = 64 * 1024;
  private e2eeEnabled = false;
  /** Per-transfer IV prefix (from FILE_START) — required for chunk decryption. */
  private ivPrefix: Uint8Array | null = null;

  private writer: StorageWriter | null = null;
  private hasher: IncrementalSha256 | null = null;
  private receivedChunksCount = 0;
  /** EWMA ms per chunk write (receiver write throughput, honestly measured). */
  private writeMsEwma = 0;
  private expectedTransferIdHash = 0;
  private nextExpectedChunkIndex = 0;
  private bytesReceived = 0;
  private startTime = 0;
  private lastProgressEmit = 0;
  private lastBytes = 0;
  private lastTime = 0;
  private recentSpeeds: number[] = [];
  private acksSent = 0;
  /** Last time an ACK left — drives the ACK_MAX_DELAY_MS cadence. */
  private lastAckAt = 0;
  /** Largest observed pipeline depth this transfer (diagnostics). */
  private maxQueueDepthSeen = 0;

  private isPaused = false;
  /** PAUSE that arrived before this transfer started (applied at start). */
  private pendingPauseId: string | null = null;
  private isCancelled = false;
  private isCompleted = false;
  private callbacks: ReceiverCallbacks;

  // ---- ordered, overlapped write pipeline ----
  /** Chunks (and FILE_END) that arrive while the storage writer is still
   *  initializing. startTransfer() creates the writer asynchronously, and on
   *  a fast link the whole in-flight window can land before that promise
   *  resolves. Dropping those chunks would corrupt the transfer. */
  private pendingChunks: ArrayBuffer[] = [];
  private pendingFinish: FileEndMessage | null = null;
  /** Decoded-order queue feeding the single drain loop. */
  private processQueue: ArrayBuffer[] = [];
  private draining = false;
  /** Chained, strictly-ordered write pipeline. */
  private writeChain: Promise<void> = Promise.resolve();
  /** Writes chained but not yet resolved (real queue-depth feedback). */
  private writesQueued = 0;

  constructor(callbacks: ReceiverCallbacks) {
    this.callbacks = callbacks;
  }

  /** Real receiver queue depth: everything accepted but not yet durably written. */
  private queueDepth(): number {
    return this.pendingChunks.length + this.processQueue.length + this.writesQueued;
  }

  public async startTransfer(meta: FileStartMessage): Promise<void> {
    if (this.writer && !this.isCompleted && !this.isCancelled) {
      // A transfer is already active on this engine — refuse a second one.
      this.callbacks.sendControlMessage({
        type: 'CANCEL',
        transferId: meta.transferId,
        reason: 'Another transfer is already in progress',
      });
      return;
    }

    this.transferId = meta.transferId;
    if (this.pendingPauseId === meta.transferId) {
      // A PAUSE arrived before this transfer started — honor it now.
      this.pendingPauseId = null;
      this.isPaused = true;
    }
    this.name = meta.name;
    this.size = meta.size;
    this.mime = meta.mime;
    this.totalChunks = meta.totalChunks;
    this.chunkSize = meta.chunkSize || 64 * 1024;
    this.e2eeEnabled = !!meta.e2eeEnabled && !!this.callbacks.getCipher?.();
    if (this.e2eeEnabled) {
      // Fail closed: an E2EE transfer without a usable IV prefix cannot be
      // decrypted — never fall back to plaintext acceptance.
      if (!meta.ivPrefix) {
        this.callbacks.onError(meta.transferId, 'Protocol error: missing encryption IV prefix');
        void this.cancel('Protocol error: missing encryption IV prefix');
        return;
      }
      try {
        const prefixBytes = base64UrlToBytes(meta.ivPrefix);
        if (prefixBytes.byteLength !== 6) throw new Error('bad prefix length');
        this.ivPrefix = prefixBytes;
      } catch {
        this.callbacks.onError(meta.transferId, 'Protocol error: malformed encryption IV prefix');
        void this.cancel('Protocol error: malformed encryption IV prefix');
        return;
      }
    }

    this.bytesReceived = 0;
    this.receivedChunksCount = 0;
    this.expectedTransferIdHash = simpleStringHash(this.transferId);
    this.nextExpectedChunkIndex = 0;
    this.isPaused = false;
    this.isCancelled = false;
    this.isCompleted = false;
    this.lastAckAt = Date.now();
    this.acksSent = 0;
    this.writeChain = Promise.resolve();
    this.writesQueued = 0;
    this.processQueue = [];
    this.hasher = new IncrementalSha256();
    this.startTime = Date.now();
    this.lastTime = this.startTime;
    this.lastBytes = 0;
    this.recentSpeeds = [];

    try {
      this.writer = await createOptimalStorageWriter(this.name, this.mime, this.size, false);
    } catch (err: any) {
      this.pendingChunks = [];
      this.pendingFinish = null;
      this.callbacks.onError(this.transferId, `Failed to initialize file storage: ${err?.message || err}`);
      return;
    }

    // Flush anything that arrived while the writer was being created —
    // through the SAME ordered queue so nothing can bypass the pipeline.
    console.debug('[nexdrop] writer ready:', this.writer.getType(), 'pending chunks:', this.pendingChunks.length);
    if (this.pendingChunks.length > 0) {
      const queued = this.pendingChunks;
      this.pendingChunks = [];
      this.processQueue.push(...queued);
      await this.drain();
    }

    this.emitProgress('transferring', 0, 0);

    // FILE_END can arrive before the writer exists (control and file
    // channels have no cross-channel ordering) — finish now if it did.
    console.debug('[nexdrop] flush complete, pendingFinish:', !!this.pendingFinish);
    if (this.pendingFinish) {
      const endMsg = this.pendingFinish;
      this.pendingFinish = null;
      await this.finishTransfer(endMsg);
    }
  }

  public async handleChunk(packetBuffer: ArrayBuffer): Promise<void> {
    if (this.isCancelled || this.isCompleted) return;

    // Writer still initializing: buffer the chunk — never drop in-flight
    // data (dropping it would corrupt the transfer and stall the sender,
    // which paces itself on our ACKs).
    if (!this.writer) {
      if (!this.transferId) return; // no active transfer
      this.pendingChunks.push(packetBuffer);
      return;
    }

    this.processQueue.push(packetBuffer);
    await this.drain();
  }

  /** Single drain loop: decrypts chunk N+1 while write N is in flight. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.processQueue.length > 0) {
        if (this.isCancelled || this.isCompleted) {
          this.processQueue = [];
          return;
        }
        const buf = this.processQueue.shift()!;
        await this.processChunk(buf);
      }
    } finally {
      this.draining = false;
    }
  }

  private async processChunk(packetBuffer: ArrayBuffer): Promise<void> {
    if (this.isCancelled || this.isCompleted || !this.writer) return;

    const decoded = decodeBinaryChunk(packetBuffer);
    if (!decoded) {
      this.callbacks.onError(this.transferId, 'Received a malformed data chunk');
      return;
    }

    // Chunk belongs to a different/unknown transfer — reject it.
    if (decoded.transferIdHash !== this.expectedTransferIdHash) {
      this.callbacks.onError(this.transferId, 'Received data for an unknown transfer');
      void this.cancel('Protocol error: unknown transfer');
      return;
    }

    // Duplicate chunk (e.g. a re-delivered frame): ACK and ignore.
    if (decoded.chunkIndex < this.nextExpectedChunkIndex) {
      this.callbacks.sendControlMessage({
        type: 'ACK',
        transferId: this.transferId,
        index: decoded.chunkIndex,
        w: Math.round(this.writeMsEwma * 10) / 10,
        q: this.queueDepth(),
      });
      return;
    }

    // The file channel is ordered+reliable, so a gap means real data loss.
    if (decoded.chunkIndex !== this.nextExpectedChunkIndex) {
      this.callbacks.onError(
        this.transferId,
        `Missing chunk data (expected #${this.nextExpectedChunkIndex}, got #${decoded.chunkIndex})`
      );
      void this.cancel('Protocol error: chunk gap detected');
      return;
    }
    this.nextExpectedChunkIndex = decoded.chunkIndex + 1;

    // NOTE: chunks are still processed while paused. PAUSE/RESUME travel on
    // the control channel, which has NO cross-channel ordering with the file
    // channel — chunks already in flight can legitimately arrive after the
    // PAUSE message, and dropping them would silently corrupt the file.
    // Pause only stops the sender's pump; the receiver accepts whatever was
    // already in flight so the stream stays gap-free.

    let payload: ArrayBuffer;
    try {
      // Decrypt to plaintext before writing / hashing (this await overlaps
      // the PREVIOUS chunk's in-flight write).
      const cipher = this.callbacks.getCipher?.();
      if (this.e2eeEnabled && cipher) {
        if (!this.ivPrefix) throw new Error('E2EE transfer missing IV prefix');
        payload = await decryptChunk(cipher, this.ivPrefix, decoded.chunkIndex, decoded.payload);
      } else {
        payload = decoded.payload;
      }
    } catch (err: any) {
      this.callbacks.onError(this.transferId, `Failed decrypting received data: ${err?.message || err}`);
      return;
    }

    this.hasher?.update(new Uint8Array(payload));
    this.bytesReceived += payload.byteLength;
    this.receivedChunksCount++;

    // Chain the write — strictly in arrival order, never blocking the
    // decrypt of the next chunk. The ACK for this chunk fires after the
    // write is durable, at an adaptive cadence.
    const chunkIndex = decoded.chunkIndex;
    const toWrite = payload;
    const isFinalChunk = chunkIndex === this.totalChunks - 1;
    const isBatchBoundary = (chunkIndex + 1) % ACK_BATCH === 0;
    this.writesQueued++;
    this.writeChain = this.writeChain.then(async () => {
      if (this.isCancelled || this.isCompleted || !this.writer) return;
      const wStart = Date.now();
      await this.writer!.writeChunk(toWrite, chunkIndex);
      const wSample = Date.now() - wStart;
      this.writeMsEwma = this.writeMsEwma > 0 ? this.writeMsEwma * 0.8 + wSample * 0.2 : wSample;
      this.writesQueued--;
      this.writesQueued = Math.max(0, this.writesQueued);

      // Adaptive ACK policy: batch boundary OR the timer expired OR final
      // chunk OR our own queue is backing up (tell the sender NOW so it
      // shrinks the window) — one small control frame per batch.
      const queueNow = this.queueDepth();
      if (queueNow > this.maxQueueDepthSeen) this.maxQueueDepthSeen = queueNow;
      const timerDue = Date.now() - this.lastAckAt >= ACK_MAX_DELAY_MS;
      if (isFinalChunk || isBatchBoundary || timerDue || queueNow > 8) {
        this.lastAckAt = Date.now();
        this.acksSent++;
        this.callbacks.sendControlMessage({
          type: 'ACK',
          transferId: this.transferId,
          index: chunkIndex,
          w: Math.round(this.writeMsEwma * 10) / 10,
          q: queueNow,
        });
      }
    }).catch((err: any) => {
      this.writesQueued = Math.max(0, this.writesQueued - 1);
      if (this.isCancelled || this.isCompleted) return;
      console.error('Failed writing received data:', err);
      this.callbacks.onError(this.transferId, `Failed writing received data: ${err?.message || err}`);
    });

    // Real speed & ETA from actual counters, throttled to 100ms
    const now = Date.now();
    if (now - this.lastProgressEmit >= 100 || this.receivedChunksCount === this.totalChunks) {
      const timeDiff = Math.max(0.001, (now - this.lastTime) / 1000);
      const bytesDiff = this.bytesReceived - this.lastBytes;
      const currentSpeed = bytesDiff / timeDiff;

      this.recentSpeeds.push(currentSpeed);
      if (this.recentSpeeds.length > 5) this.recentSpeeds.shift();
      const avgSpeed =
        this.recentSpeeds.reduce((a, b) => a + b, 0) / this.recentSpeeds.length;

      const remainingBytes = Math.max(0, this.size - this.bytesReceived);
      const eta = avgSpeed > 0 ? Math.ceil(remainingBytes / avgSpeed) : 0;

      if (!this.isPaused && !this.isCancelled) {
        this.emitProgress('transferring', avgSpeed, eta);
      }
      this.lastProgressEmit = now;
      this.lastBytes = this.bytesReceived;
      this.lastTime = now;
      updateReceiverTelemetry({
        transferId: this.transferId,
        name: this.name,
        totalBytes: this.size,
        chunkSize: this.chunkSize,
        bytesReceived: this.bytesReceived,
        chunksReceived: this.receivedChunksCount,
        writeMsEwma: this.writeMsEwma,
        queueDepth: this.queueDepth(),
        maxQueueDepth: this.maxQueueDepthSeen,
        acksSent: this.acksSent,
        throughputBps: avgSpeed,
        writerType: this.writer.getType(),
        heapBytes: (performance as any)?.memory?.usedJSHeapSize ?? 0,
        startedAt: this.startTime,
      });
    }
  }

  /** Wait until the pipeline is fully drained (bounded; used by finishTransfer). */
  private async awaitSettled(timeoutMs = 60000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isCancelled || this.isCompleted) return;
      if (!this.draining && this.processQueue.length === 0 && this.writesQueued === 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** The transfer this engine is currently handling ('' when idle). */
  public get activeTransferId(): string {
    return this.transferId;
  }

  public handlePause(msg: FilePauseMessage): void {
    if (msg.transferId !== this.transferId) {
      // PAUSE for a transfer that has not started yet (the META/START is
      // still in flight): remember it and apply when startTransfer lands,
      // otherwise the pause is silently lost and the receiver keeps
      // accepting data the sender believes is paused.
      if (!this.transferId) this.pendingPauseId = msg.transferId;
      return;
    }
    this.isPaused = true;
    this.emitProgress('paused', 0, 0);
  }

  public handleResume(msg: FileResumeMessage): void {
    if (msg.transferId === this.pendingPauseId) this.pendingPauseId = null;
    if (msg.transferId !== this.transferId || !this.isPaused) return;
    this.isPaused = false;
    this.lastTime = Date.now();
    this.lastBytes = this.bytesReceived;
    this.emitProgress('transferring', 0, 0);
  }

  public async finishTransfer(endMsg: FileEndMessage): Promise<void> {
    if (this.isCompleted || this.isCancelled) return;

    // FILE_END raced ahead of the writer init (or of buffered chunks):
    // stash it and finish once startTransfer() has flushed everything.
    if (!this.writer || (this.pendingChunks.length > 0 && endMsg.transferId === this.transferId)) {
      if (!this.transferId) return;
      this.pendingFinish = endMsg;
      return;
    }

    // Cross-channel ordering is NOT guaranteed: let the ordered write
    // pipeline finish everything already accepted before judging completeness.
    await this.awaitSettled();
    if (this.isCancelled || this.isCompleted) return;

    this.isCompleted = true;

    // Byte-count honesty check: FILE_END only counts as complete when the
    // number of plaintext bytes actually written equals the size announced
    // in FILE_START. A truncated stream must never be reported as complete.
    const byteCountOk = this.bytesReceived === this.size;
    if (!byteCountOk) {
      this.callbacks.sendControlMessage({
        type: 'VERIFY',
        transferId: this.transferId,
        match: false,
      });
      const id = this.transferId;
      const size = this.size;
      const received = this.bytesReceived;
      this.transferId = '';
      this.ivPrefix = null;
      if (this.writer) {
        try {
          this.writeChain = this.writeChain.catch(() => undefined);
          await this.writer.abort();
        } catch {
          // best-effort cleanup
        }
        this.writer = null;
      }
      this.emitProgress('failed', 0, 0, id);
      this.callbacks.onError(id, `Transfer truncated: received ${received} of ${size} bytes`);
      return;
    }

    try {
      const finishRes = await this.writer.finish();

      // Honest integrity verification: compare the sender's hash with the
      // hash we computed incrementally from the decrypted stream.
      let verified: boolean | undefined = undefined;
      let localHash: string | undefined = undefined;
      if (endMsg.hash && this.hasher) {
        try {
          localHash = this.hasher.finalize();
          verified = localHash === endMsg.hash;
          this.hasher = null;
        } catch {
          verified = false;
        }
        // Tell the sender the verification outcome
        this.callbacks.sendControlMessage({
          type: 'VERIFY',
          transferId: this.transferId,
          match: !!verified,
        });
      }

      const info: ReceiverProgress = {
        transferId: this.transferId,
        name: this.name,
        size: this.bytesReceived,
        mime: this.mime,
        bytesReceived: this.bytesReceived,
        percentage: 100,
        speedBps: 0,
        etaSeconds: 0,
        status: 'completed',
        blobUrl: finishRes.blobUrl,
        hashVerified: verified,
        hash: localHash,
        writerType: this.writer.getType(),
      };

      this.callbacks.onCompleted(info);
      // Completed: forget this transfer so late/stray chunks or control
      // messages can never act on (or be attributed to) a finished transfer.
      this.transferId = '';
      this.writer = null;
      this.ivPrefix = null;
    } catch (err: any) {
      this.callbacks.onError(this.transferId, `Failed to finalize file: ${err?.message || err}`);
    }
  }

  public async cancel(reason: string = 'Cancelled'): Promise<void> {
    this.pendingChunks = [];
    this.pendingFinish = null;
    this.pendingPauseId = null;
    this.ivPrefix = null;
    this.processQueue = [];
    if (this.isCompleted) return;
    if (!this.transferId) return; // nothing active — never emit or notify
    this.isCancelled = true;
    const id = this.transferId;
    this.transferId = '';
    if (this.writer) {
      // Swallow in-flight pipeline writes — the abort below invalidates them.
      this.writeChain = this.writeChain.catch(() => undefined);
      await this.writer.abort();
      this.writer = null;
    }
    this.callbacks.sendControlMessage({
      type: 'CANCEL',
      transferId: id,
      reason,
    });
    this.emitProgress('cancelled', 0, 0, id);
  }

  private emitProgress(
    status: 'transferring' | 'paused' | 'completed' | 'cancelled' | 'failed',
    speedBps: number,
    etaSeconds: number,
    forceId?: string
  ) {
    const percentage = this.size > 0 ? (this.bytesReceived / this.size) * 100 : 100;
    this.callbacks.onProgress({
      transferId: forceId ?? this.transferId,
      name: this.name,
      size: this.size,
      mime: this.mime,
      bytesReceived: this.bytesReceived,
      percentage: Math.min(100, Math.round(percentage * 10) / 10),
      speedBps,
      etaSeconds,
      status,
      writerType: this.writer?.getType() || 'blob',
    });
  }
}
