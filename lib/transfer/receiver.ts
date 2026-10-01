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
 * - ACKs are sent only after the covered bytes are DURABLY WRITTEN, as
 *   CUMULATIVE-BYTE acknowledgements (v2.3): rb = bytes received/processed,
 *   wb = bytes durably written. The sender releases window space against
 *   wb — byte offsets are authoritative, the chunk index is diagnostics
 *   only. Cadence: >= ACK_BYTE_TARGET bytes OR ACK_MAX_DELAY_MS since the
 *   last ACK, whichever first; IMMEDIATELY for the final batch, on any
 *   boundary event (pause/resume/cancel/error), and when the receiver
 *   queue backs up (the ACK carries the live queue depth so the sender
 *   can shrink its window).
 * - Incremental SHA-256 runs on the decrypted stream while writing.
 * - Memory stays bounded: the sender's in-flight window bounds the bytes
 *   in the pipeline; the queue depth feeds back to keep it that way.
 */

import {
  ACK_BYTE_TARGET,
  ACK_BYTE_TARGET_MAX,
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
import { TransferTimeline } from './timeline';

/** Coalesced storage-write batch target (bytes). Bounded memory: at most
 *  ~this many queued plaintext bytes join one storage call. Larger batches
 *  amortize the per-call storage latency; a single queued chunk still
 *  writes immediately so slow links keep their prompt ACK cadence. */
const WRITE_BATCH_TARGET_BYTES = 1024 * 1024; // 1 MiB

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
  // ---- TURBO multi-channel reorder buffer (2026-10-01) ----
  // Parallel file streams interleave arrival, so out-of-order chunks are
  // EXPECTED. Bounded stash keyed by chunk index; drained contiguously.
  // In-flight bytes are capped by the sender's 16 MiB window, so the cap
  // below can never be hit on a healthy link — overflow fails honestly.
  private reorderMap = new Map<number, ArrayBuffer>();
  private reorderBytes = 0;
  private maxReorderDepth = 0;
  private static readonly REORDER_MAX_ENTRIES = 512;
  private static readonly REORDER_MAX_BYTES = 32 * 1024 * 1024;
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
  /** Cumulative plaintext bytes DURABLY WRITTEN — the authoritative ACK
   *  frontier (v2.3). Monotonic across the whole transfer. */
  private bytesWritten = 0;
  /** bytesWritten value carried by the last ACK (coalescing watermark). */
  private lastAckedWrittenBytes = 0;
  /** True when a boundary event demands an immediate checkpoint ACK
   *  (pause/resume/cancel/error) on the next durable batch. */
  private ackBoundaryPending = false;
  /** Benchmark-sweep override for the coalescing floor (0 = production
   *  default). Set via globalThis before a transfer starts; never used to
   *  fake values — only to MEASURE which floor is optimal on CI. */
  private ackByteTargetOverride = 0;
  /** Largest observed pipeline depth this transfer (diagnostics). */
  private maxQueueDepthSeen = 0;

  private isPaused = false;
  /** PAUSE that arrived before this transfer started (applied at start). */
  private pendingPauseId: string | null = null;
  private isCancelled = false;
  private isCompleted = false;
  private callbacks: ReceiverCallbacks;

  // ---- ordered, overlapped write pipeline (coalesced storage writes) ----
  /** Chunks (and FILE_END) that arrive while the storage writer is still
   *  initializing. startTransfer() creates the writer asynchronously, and on
   *  a fast link the whole in-flight window can land before that promise
   *  resolves. Dropping those chunks would corrupt the transfer. */
  private pendingChunks: ArrayBuffer[] = [];
  private pendingFinish: FileEndMessage | null = null;
  /** Decoded-order queue feeding the single drain loop. */
  private processQueue: ArrayBuffer[] = [];
  private draining = false;
  /** Decoded, in-order chunks waiting for a durable storage write. */
  private writeQueue: Array<{ payload: ArrayBuffer; index: number }> = [];
  /** 10 Hz collapse-curve recorder (receiver view of the pipeline). */
  readonly timeline = new TransferTimeline(
    ['t','received','queueDepth','writeMs','bps','acks','chunks'],
  );
  private timelineTimer: ReturnType<typeof setInterval> | null = null;
  /** The single coalescing writer loop is running. */
  private writing = false;
  /** Chunks accepted but not yet durably written (real queue-depth feedback). */
  private writesQueued = 0;
  /** Largest number of chunks coalesced into one storage call (diagnostics). */
  private maxWriteBatch = 0;

  constructor(callbacks: ReceiverCallbacks) {
    this.callbacks = callbacks;
  }

  /** Real receiver queue depth: everything accepted but not yet durably
   *  written (writer-queue chunks are counted by the writesQueued counter). */
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
    this.bytesWritten = 0;
    this.lastAckedWrittenBytes = 0;
    this.ackBoundaryPending = false;
    // Benchmark-sweep hook (measurement only): CI may override the ACK
    // coalescing floor via globalThis to find the optimal value. Bounded by
    // ACK_BYTE_TARGET_MAX; 0/absent = production default.
    const tune = (globalThis as { __NEXDROP_ACK_TUNE_BYTES?: number }).__NEXDROP_ACK_TUNE_BYTES;
    this.ackByteTargetOverride =
      typeof tune === 'number' && tune > 0 ? Math.min(tune, ACK_BYTE_TARGET_MAX) : 0;
    this.writeQueue = [];
    this.writing = false;
    this.writesQueued = 0;
    this.maxWriteBatch = 0;
    this.processQueue = [];
    this.hasher = new IncrementalSha256();
    this.startTime = Date.now();
    this.startTimeline();
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

    // Duplicate chunk (e.g. a re-delivered frame): re-ACK the CURRENT
    // durable byte frontier (cumulative bytes, monotonic — a duplicate
    // never rolls the frontier backwards) and ignore the payload.
    if (decoded.chunkIndex < this.nextExpectedChunkIndex) {
      this.callbacks.sendControlMessage({
        type: 'ACK',
        transferId: this.transferId,
        index: this.receivedChunksCount - 1,
        rb: this.bytesReceived,
        wb: this.bytesWritten,
        w: Math.round(this.writeMsEwma * 10) / 10,
        q: this.queueDepth(),
      });
      return;
    }

    // TURBO (2026-10-01): with parallel file streams, out-of-order arrival
    // is normal — stash and wait for the frontier. Overflow beyond the
    // in-flight cap means the sender misbehaved; fail honestly rather than
    // silently corrupting the stream.
    if (decoded.chunkIndex > this.nextExpectedChunkIndex) {
      if (
        this.reorderMap.size >= ReceiverEngine.REORDER_MAX_ENTRIES ||
        this.reorderBytes + packetBuffer.byteLength > ReceiverEngine.REORDER_MAX_BYTES
      ) {
        this.callbacks.onError(
          this.transferId,
          `Reorder buffer overflow (expected #${this.nextExpectedChunkIndex}, got #${decoded.chunkIndex})`
        );
        void this.cancel('Protocol error: reorder buffer overflow');
        return;
      }
      this.reorderMap.set(decoded.chunkIndex, packetBuffer);
      this.reorderBytes += packetBuffer.byteLength;
      this.maxReorderDepth = Math.max(this.maxReorderDepth, this.reorderMap.size);
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

    // Enqueue for the single ordered writer loop — never blocking the
    // decrypt of the next chunk. The ACK for these bytes fires only after
    // the durable write completes (see writerLoop).
    const chunkIndex = decoded.chunkIndex;
    this.writesQueued++;
    this.writeQueue.push({ payload, index: chunkIndex });
    void this.writerLoop();

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
        timeline: this.timeline.length > 0 ? this.timeline.toJSON() : null,
        startedAt: this.startTime,
      });
    }

    // TURBO: contiguous reorder drain — process any buffered chunks that
    // the frontier just unlocked. Strictly sequential, same pipeline.
    while (this.reorderMap.size > 0 && this.reorderMap.has(this.nextExpectedChunkIndex)) {
      const buf = this.reorderMap.get(this.nextExpectedChunkIndex)!;
      this.reorderMap.delete(this.nextExpectedChunkIndex);
      this.reorderBytes -= buf.byteLength;
      const d = decodeBinaryChunk(buf);
      if (!d) {
        this.callbacks.onError(this.transferId, 'Received a malformed buffered data chunk');
        void this.cancel('Protocol error: malformed buffered chunk');
        return;
      }
      await this.processChunk(buf);
    }
  }

  /** 10 Hz collapse-curve recorder (Phase 1/2 instrumentation). */
  private startTimeline(): void {
    this.stopTimeline();
    if (typeof setInterval !== 'function') return;
    const sample = () => {
      if (this.isCompleted || this.isCancelled) { this.stopTimeline(); return; }
      this.timeline.push([
        Date.now() - this.startTime,
        this.bytesReceived,
        this.queueDepth(),
        this.writeMsEwma,
        this.bytesReceived / Math.max(0.001, (Date.now() - this.startTime) / 1000),
        this.acksSent,
        this.receivedChunksCount,
      ]);
    };
    sample();
    this.timelineTimer = setInterval(sample, this.timeline.currentIntervalMs);
  }

  private stopTimeline(): void {
    if (this.timelineTimer !== null) {
      clearInterval(this.timelineTimer);
      this.timelineTimer = null;
    }
  }

  /**
   * Single ordered, COALESCING writer loop.
   *
   * Measured evidence (CI two-device benchmark): per-chunk storage calls
   * cost ~4-9 ms of async latency EACH — not raw disk bandwidth — and that
   * call overhead was the real receiver-side throughput ceiling (64-128 KiB
   * chunks / 8.7 ms ≈ 7-15 MB/s). Consecutive queued chunks are therefore
   * coalesced into ONE storage call (bounded at WRITE_BATCH_TARGET_BYTES),
   * which amortizes the per-call latency across the whole batch. When the
   * queue holds a single chunk it is written immediately, so slow links
   * keep the same prompt ACK cadence as before.
   */
  private async writerLoop(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.writeQueue.length > 0) {
        if (this.isCancelled || this.isCompleted || !this.writer) {
          this.writeQueue = [];
          return;
        }

        // Gather consecutive chunks into one bounded batch.
        const batch = [this.writeQueue.shift()!];
        let batchBytes = batch[0].payload.byteLength;
        while (
          this.writeQueue.length > 0 &&
          batchBytes < WRITE_BATCH_TARGET_BYTES &&
          this.writeQueue[0].index === batch[batch.length - 1].index + 1
        ) {
          const next = this.writeQueue.shift()!;
          batchBytes += next.payload.byteLength;
          batch.push(next);
        }
        if (batch.length > this.maxWriteBatch) this.maxWriteBatch = batch.length;
        const lastIndex = batch[batch.length - 1].index;

        const wStart = Date.now();
        try {
          if (batch.length === 1) {
            await this.writer.writeChunk(batch[0].payload, batch[0].index);
          } else {
            await this.writer.writeChunks(
              batch.map((b) => b.payload),
              batch[0].index
            );
          }
        } catch (err: any) {
          // The whole batch is abandoned — the stream cannot continue past
          // a hole. Report the honest failure. Boundary rule: the durable
          // frontier reached BEFORE this failing batch goes out with it.
          this.writeQueue = [];
          this.writesQueued = 0;
          if (this.isCancelled || this.isCompleted) return;
          this.sendCheckpointAck();
          console.error('Failed writing received data:', err);
          this.callbacks.onError(
            this.transferId,
            `Failed writing received data: ${err?.message || err}`
          );
          return;
        }
        // Per-chunk write cost, amortized across the batch.
        const wSample = (Date.now() - wStart) / batch.length;
        this.writeMsEwma = this.writeMsEwma > 0 ? this.writeMsEwma * 0.8 + wSample * 0.2 : wSample;
        this.writesQueued = Math.max(0, this.writesQueued - batch.length);

        // Cumulative-byte frontier advance (v2.3): the durable frontier is
        // BYTES, not chunk index — byte offsets stay authoritative across
        // chunk-size ladder steps and coalescing, so the stale-size-chunk
        // accounting class cannot recur.
        let writtenBytes = 0;
        for (const b of batch) writtenBytes += b.payload.byteLength;
        this.bytesWritten += writtenBytes;

        // v2.3 cumulative-byte ACK policy, evaluated per durable batch:
        // coalesce until >= ACK_BYTE_TARGET new durable bytes (or the
        // ACK_MAX_DELAY_MS ceiling), then ONE control frame carrying the
        // cumulative rb/wb byte offsets. IMMEDIATE, un-coalesced ACKs on:
        // final batch, any boundary event (pause/resume/cancel/error —
        // the checkpoint rule), or our own queue backing up (tell the
        // sender NOW so it can react while the bytes are still safe).
        const queueNow = this.queueDepth();
        if (queueNow > this.maxQueueDepthSeen) this.maxQueueDepthSeen = queueNow;
        const timerDue = Date.now() - this.lastAckAt >= ACK_MAX_DELAY_MS;
        const target = this.ackByteTargetOverride > 0 ? this.ackByteTargetOverride : ACK_BYTE_TARGET;
        const byteTargetDue = this.bytesWritten - this.lastAckedWrittenBytes >= target;
        // Completion is decided by BYTES: once every byte of the file has
        // been processed AND this batch flushed the write queue, this batch
        // IS the final batch — always ACK it immediately.
        const allBytesArrived = this.bytesReceived >= this.size;
        const isFinalBatch = allBytesArrived && this.writesQueued === 0 && this.writeQueue.length === 0;
        const boundaryDue = this.ackBoundaryPending;
        if (isFinalBatch || boundaryDue || timerDue || byteTargetDue || queueNow > 8) {
          this.lastAckAt = Date.now();
          this.lastAckedWrittenBytes = this.bytesWritten;
          this.ackBoundaryPending = false;
          this.acksSent++;
          this.callbacks.sendControlMessage({
            type: 'ACK',
            transferId: this.transferId,
            index: lastIndex,
            rb: this.bytesReceived,
            wb: this.bytesWritten,
            w: Math.round(this.writeMsEwma * 10) / 10,
            q: queueNow,
          });
        }
      }
    } finally {
      this.writing = false;
    }
  }

  /** Wait until the pipeline is fully drained (bounded; used by finishTransfer). */
  private async awaitSettled(timeoutMs = 60000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isCancelled || this.isCompleted) return;
      if (
        !this.draining &&
        this.processQueue.length === 0 &&
        this.writeQueue.length === 0 &&
        !this.writing
      ) {
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** The transfer this engine is currently handling ('' when idle). */
  public get activeTransferId(): string {
    return this.transferId;
  }

  /**
   * Immediate checkpoint ACK (v2.3 boundary rule): pause/resume/cancel and
   * writer errors NEVER wait for the coalescing timer — the sender gets the
   * durable byte frontier the instant it is known. Safe by construction:
   * bytesWritten only advances after a durable write, so the frontier in
   * this ACK is committed storage, never a projection.
   */
  private sendCheckpointAck(): void {
    if (!this.transferId) return;
    this.lastAckAt = Date.now();
    this.lastAckedWrittenBytes = this.bytesWritten;
    this.ackBoundaryPending = false;
    this.acksSent++;
    this.callbacks.sendControlMessage({
      type: 'ACK',
      transferId: this.transferId,
      index: this.receivedChunksCount - 1,
      rb: this.bytesReceived,
      wb: this.bytesWritten,
      w: Math.round(this.writeMsEwma * 10) / 10,
      q: this.queueDepth(),
    });
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
    // Checkpoint rule: report the durable byte frontier NOW so the sender
    // knows exactly which bytes are safely stored before it freezes.
    this.sendCheckpointAck();
    this.emitProgress('paused', 0, 0);
  }

  public handleResume(msg: FileResumeMessage): void {
    if (msg.transferId === this.pendingPauseId) this.pendingPauseId = null;
    if (msg.transferId !== this.transferId || !this.isPaused) return;
    // Checkpoint rule on resume: the sender's resume re-sends from its own
    // frontier; duplicates here are deduped by nextExpectedChunkIndex — the
    // ACK tells it the durable state it is resuming against.
    this.sendCheckpointAck();
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
    this.stopTimeline();

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
          this.writeQueue = [];
          this.writesQueued = 0;
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
    // Boundary rule: report the durable frontier reached before the abort
    // (post-abort bytes are discarded; the pre-abort frontier is truth).
    this.sendCheckpointAck();
    this.stopTimeline();
    const id = this.transferId;
    this.transferId = '';
    if (this.writer) {
      // Drop queued writes — the abort below invalidates them; the writer
      // loop itself checks isCancelled and abandons its batch.
      this.writeQueue = [];
      this.writesQueued = 0;
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
