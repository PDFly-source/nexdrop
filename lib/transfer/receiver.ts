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
import { decodeBinaryChunk } from './protocol';
import { ChunkCipher, decryptChunk, IncrementalSha256 } from '@/lib/crypto';

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

  private writer: StorageWriter | null = null;
  private hasher: IncrementalSha256 | null = null;
  private receivedChunksCount = 0;
  private bytesReceived = 0;
  private startTime = 0;
  private lastProgressEmit = 0;
  private lastBytes = 0;
  private lastTime = 0;
  private recentSpeeds: number[] = [];

  private isPaused = false;
  private isCancelled = false;
  private isCompleted = false;
  private callbacks: ReceiverCallbacks;

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
    this.name = meta.name;
    this.size = meta.size;
    this.mime = meta.mime;
    this.totalChunks = meta.totalChunks;
    this.chunkSize = meta.chunkSize || 64 * 1024;
    this.e2eeEnabled = !!meta.e2eeEnabled && !!this.callbacks.getCipher?.();

    this.bytesReceived = 0;
    this.receivedChunksCount = 0;
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
      this.callbacks.onError(this.transferId, `Failed to initialize file storage: ${err?.message || err}`);
      return;
    }

    this.emitProgress('transferring', 0, 0);
  }

  public async handleChunk(packetBuffer: ArrayBuffer): Promise<void> {
    if (this.isCancelled || this.isCompleted || !this.writer || this.isPaused) return;

    const decoded = decodeBinaryChunk(packetBuffer);
    if (!decoded) return;

    try {
      // Decrypt to plaintext before writing / hashing
      let payload: ArrayBuffer = decoded.payload;
      const cipher = this.callbacks.getCipher?.();
      if (this.e2eeEnabled && cipher) {
        payload = await decryptChunk(cipher, decoded.chunkIndex, decoded.payload);
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

  public handlePause(msg: FilePauseMessage): void {
    if (msg.transferId !== this.transferId) return;
    this.isPaused = true;
    this.emitProgress('paused', 0, 0);
  }

  public handleResume(msg: FileResumeMessage): void {
    if (msg.transferId !== this.transferId || !this.isPaused) return;
    this.isPaused = false;
    this.lastTime = Date.now();
    this.lastBytes = this.bytesReceived;
    this.emitProgress('transferring', 0, 0);
  }

  public async finishTransfer(endMsg: FileEndMessage): Promise<void> {
    if (this.isCompleted || !this.writer) return;
    this.isCompleted = true;

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
    } catch (err: any) {
      this.callbacks.onError(this.transferId, `Failed to finalize file: ${err?.message || err}`);
    }
  }

  public async cancel(reason: string = 'Cancelled'): Promise<void> {
    if (this.isCompleted) return;
    this.isCancelled = true;
    if (this.writer) {
      await this.writer.abort();
    }
    this.callbacks.sendControlMessage({
      type: 'CANCEL',
      transferId: this.transferId,
      reason,
    });
    this.emitProgress('cancelled', 0, 0);
  }

  private emitProgress(
    status: 'transferring' | 'paused' | 'completed' | 'cancelled' | 'failed',
    speedBps: number,
    etaSeconds: number
  ) {
    const percentage = this.size > 0 ? (this.bytesReceived / this.size) * 100 : 100;
    this.callbacks.onProgress({
      transferId: this.transferId,
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
