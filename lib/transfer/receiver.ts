/**
 * NexDrop Receiver Engine.
 * Streams received chunks into File System Access / OPFS / memory-blob
 * writers, ACKs each chunk over the control channel, decrypts when E2EE is
 * active, computes an INCREMENTAL SHA-256 while writing, and honestly
 * verifies it against the sender's hash at FILE_END.
 */

import {
  FileEndMessage,
  FilePauseMessage,
  FileResumeMessage,
  FileStartMessage,
} from '@/types/transfer';
import { createOptimalStorageWriter, StorageWriter } from './writer';
import { decodeBinaryChunk, simpleStringHash } from './protocol';
import { base64UrlToBytes, ChunkCipher, decryptChunk, IncrementalSha256 } from '@/lib/crypto';

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
  private expectedTransferIdHash = 0;
  private nextExpectedChunkIndex = 0;
  private bytesReceived = 0;
  private startTime = 0;
  private lastProgressEmit = 0;
  private lastBytes = 0;
  private lastTime = 0;
  private recentSpeeds: number[] = [];

  private isPaused = false;
  /** PAUSE that arrived before this transfer started (applied at start). */
  private pendingPauseId: string | null = null;
  private isCancelled = false;
  private isCompleted = false;
  private callbacks: ReceiverCallbacks;

  // Chunks (and FILE_END) that arrive while the storage writer is still
  // initializing. startTransfer() creates the writer asynchronously (OPFS /
  // file handles), and on a fast link the whole file can land before that
  // promise resolves. Dropping those chunks would silently corrupt the
  // transfer, so they are buffered and flushed in arrival order once the
  // writer exists.
  private pendingChunks: ArrayBuffer[] = [];
  private pendingFinish: FileEndMessage | null = null;

  constructor(callbacks: ReceiverCallbacks) {
    this.callbacks = callbacks;
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

    // Flush anything that arrived while the writer was being created.
    console.debug('[nexdrop] writer ready:', this.writer.getType(), 'pending chunks:', this.pendingChunks.length);
    if (this.pendingChunks.length > 0) {
      const queued = this.pendingChunks;
      this.pendingChunks = [];
      for (const chunk of queued) {
        if (this.isCancelled || this.isCompleted) return;
        await this.processChunk(chunk);
      }
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
    // which paces itself on our per-chunk ACKs).
    if (!this.writer) {
      if (!this.transferId) return; // no active transfer
      this.pendingChunks.push(packetBuffer);
      if (this.pendingChunks.length === 1 || this.pendingChunks.length % 16 === 0) {
        console.debug('[nexdrop] receiver buffering chunk before writer ready:', this.pendingChunks.length);
      }
      return;
    }

    await this.processChunk(packetBuffer);
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

    // Duplicate chunk (e.g. a re-scanned/re-delivered frame): ACK and ignore.
    if (decoded.chunkIndex < this.nextExpectedChunkIndex) {
      this.callbacks.sendControlMessage({
        type: 'ACK',
        transferId: this.transferId,
        index: decoded.chunkIndex,
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

    try {
      // Decrypt to plaintext before writing / hashing
      let payload: ArrayBuffer = decoded.payload;
      const cipher = this.callbacks.getCipher?.();
      if (this.e2eeEnabled && cipher) {
        if (!this.ivPrefix) throw new Error('E2EE transfer missing IV prefix');
        payload = await decryptChunk(cipher, this.ivPrefix, decoded.chunkIndex, decoded.payload);
      }

      await this.writer.writeChunk(payload, decoded.chunkIndex);

      this.hasher?.update(new Uint8Array(payload));
      this.bytesReceived += payload.byteLength;
      this.receivedChunksCount++;

      this.callbacks.sendControlMessage({
        type: 'ACK',
        transferId: this.transferId,
        index: decoded.chunkIndex,
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

        this.emitProgress('transferring', avgSpeed, eta);
        this.lastProgressEmit = now;
        this.lastBytes = this.bytesReceived;
        this.lastTime = now;
      }
    } catch (err: any) {
      console.error('Failed processing chunk:', err);
      this.callbacks.onError(this.transferId, `Failed writing received data: ${err?.message || err}`);
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
      if (endMsg.hash && this.hasher) {
        try {
          const localHash = this.hasher.finalize();
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
    if (this.isCompleted) return;
    if (!this.transferId) return; // nothing active — never emit or notify
    this.isCancelled = true;
    const id = this.transferId;
    this.transferId = '';
    if (this.writer) {
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
