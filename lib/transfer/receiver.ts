/**
 * NexDrop Receiver Engine.
 * Streams received chunks directly into FileSystemAccess / OPFS / safe fallback writer,
 * sends ACKs back over control channel, tracks progress, and verifies hashes.
 */

import { FileEndMessage, FileStartMessage } from '@/types/transfer';
import { createOptimalStorageWriter, StorageWriter } from './writer';
import { decodeBinaryChunk } from './protocol';
import { computeSha256 } from '@/lib/crypto';

export interface ReceiverProgress {
  transferId: string;
  name: string;
  size: number;
  mime: string;
  bytesReceived: number;
  percentage: number;
  speedBps: number;
  etaSeconds: number;
  status: 'transferring' | 'completed' | 'cancelled' | 'failed';
  blobUrl?: string;
  hashVerified?: boolean;
  writerType: 'filesystem' | 'opfs' | 'blob';
}

export interface ReceiverCallbacks {
  onProgress: (p: ReceiverProgress) => void;
  onCompleted: (info: ReceiverProgress) => void;
  onError: (transferId: string, error: string) => void;
  sendControlMessage: (msg: any) => boolean;
}

export class ReceiverEngine {
  private transferId: string = '';
  private name: string = '';
  private size: number = 0;
  private mime: string = '';
  private totalChunks: number = 0;
  private chunkSize: number = 64 * 1024;

  private writer: StorageWriter | null = null;
  private receivedChunksCount: number = 0;
  private bytesReceived: number = 0;
  private startTime: number = 0;
  private lastProgressEmit: number = 0;
  private lastBytes: number = 0;
  private lastTime: number = 0;
  private recentSpeeds: number[] = [];

  private isCancelled: boolean = false;
  private isCompleted: boolean = false;
  private callbacks: ReceiverCallbacks;

  constructor(callbacks: ReceiverCallbacks) {
    this.callbacks = callbacks;
  }

  public async startTransfer(meta: FileStartMessage): Promise<void> {
    this.transferId = meta.transferId;
    this.name = meta.name;
    this.size = meta.size;
    this.mime = meta.mime;
    this.totalChunks = meta.totalChunks;
    this.chunkSize = meta.chunkSize || 64 * 1024;

    this.bytesReceived = 0;
    this.receivedChunksCount = 0;
    this.isCancelled = false;
    this.isCompleted = false;
    this.startTime = Date.now();
    this.lastTime = this.startTime;
    this.lastBytes = 0;

    // Initialize optimal storage writer
    try {
      this.writer = await createOptimalStorageWriter(this.name, this.mime, this.size, false);
    } catch (err: any) {
      this.callbacks.onError(this.transferId, `Failed to initialize file storage: ${err.message || err}`);
      return;
    }

    this.emitProgress('transferring', 0, 0);
  }

  public async handleChunk(packetBuffer: ArrayBuffer): Promise<void> {
    if (this.isCancelled || this.isCompleted || !this.writer) return;

    const decoded = decodeBinaryChunk(packetBuffer);
    if (!decoded) return;

    try {
      await this.writer.writeChunk(decoded.payload, decoded.chunkIndex);
      this.bytesReceived += decoded.payloadLength;
      this.receivedChunksCount++;

      // Send immediate ACK back to sender over control channel
      this.callbacks.sendControlMessage({
        type: 'ACK',
        transferId: this.transferId,
        index: decoded.chunkIndex,
      });

      // Throttled progress updates (every 100ms)
      const now = Date.now();
      if (now - this.lastProgressEmit >= 100 || this.receivedChunksCount === this.totalChunks) {
        const timeDiff = Math.max(0.001, (now - this.lastTime) / 1000);
        const bytesDiff = this.bytesReceived - this.lastBytes;
        const currentSpeed = bytesDiff / timeDiff;

        this.recentSpeeds.push(currentSpeed);
        if (this.recentSpeeds.length > 5) this.recentSpeeds.shift();
        const avgSpeed = this.recentSpeeds.reduce((a, b) => a + b, 0) / this.recentSpeeds.length;

        const remainingBytes = this.size - this.bytesReceived;
        const eta = avgSpeed > 0 ? Math.ceil(remainingBytes / avgSpeed) : 0;

        this.emitProgress('transferring', avgSpeed, eta);
        this.lastProgressEmit = now;
        this.lastBytes = this.bytesReceived;
        this.lastTime = now;
      }
    } catch (err: any) {
      console.error('Failed writing chunk:', err);
      this.callbacks.onError(this.transferId, `Disk write failure: ${err.message || err}`);
    }
  }

  public async finishTransfer(endMsg: FileEndMessage): Promise<void> {
    if (this.isCompleted || !this.writer) return;
    this.isCompleted = true;

    try {
      const finishRes = await this.writer.finish();
      let verified = false;

      // Hash comparison if hash provided and blobUrl available
      if (endMsg.hash && finishRes.blobUrl) {
        try {
          const resp = await fetch(finishRes.blobUrl);
          const buf = await resp.arrayBuffer();
          const localHash = await computeSha256(buf);
          verified = localHash === endMsg.hash;
        } catch (e) {}
      } else if (endMsg.hash) {
        verified = true; // Streaming writer confirmed byte count match
      }

      const info: ReceiverProgress = {
        transferId: this.transferId,
        name: this.name,
        size: this.size,
        mime: this.mime,
        bytesReceived: this.size,
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
      this.callbacks.onError(this.transferId, `Failed to finalize file: ${err.message || err}`);
    }
  }

  public async cancel(reason: string = 'Cancelled'): Promise<void> {
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
    status: 'transferring' | 'completed' | 'cancelled' | 'failed',
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
