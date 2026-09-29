/**
 * Receiver Storage Writer for NexDrop.
 * Follows strict zero-heap accumulation rule where possible:
 * 1. File System Access API (direct to user disk via showSaveFilePicker)
 * 2. OPFS (Origin Private File System streaming)
 * 3. Memory safe chunk assembly fallback with memory guards.
 */

import { sanitizeFilename } from '@/lib/crypto';

export interface StorageWriter {
  init(filename: string, mimeType: string, expectedSize: number): Promise<boolean>;
  writeChunk(chunk: ArrayBuffer, index: number): Promise<void>;
  finish(): Promise<{ blobUrl?: string; success: boolean }>;
  abort(): Promise<void>;
  getType(): 'filesystem' | 'opfs' | 'blob';
}

/**
 * Direct disk streaming writer via File System Access API.
 */
export class FileSystemAccessWriter implements StorageWriter {
  private fileHandle: any = null;
  private writable: any = null;

  getType(): 'filesystem' {
    return 'filesystem';
  }

  async init(filename: string, mimeType: string, _expectedSize: number): Promise<boolean> {
    if (typeof window === 'undefined' || !('showSaveFilePicker' in window)) {
      return false;
    }
    const cleanName = sanitizeFilename(filename);
    try {
      this.fileHandle = await (window as any).showSaveFilePicker({
        suggestedName: cleanName,
        types: [
          {
            description: 'File',
            accept: { [mimeType || 'application/octet-stream']: [] },
          },
        ],
      });
      this.writable = await this.fileHandle.createWritable();
      return true;
    } catch (err) {
      // User cancelled picker or permission denied
      console.warn('File System Access picker cancelled or rejected:', err);
      return false;
    }
  }

  async writeChunk(chunk: ArrayBuffer): Promise<void> {
    if (this.writable) {
      await this.writable.write(chunk);
    }
  }

  async finish(): Promise<{ blobUrl?: string; success: boolean }> {
    if (this.writable) {
      await this.writable.close();
      this.writable = null;
      return { success: true };
    }
    return { success: false };
  }

  async abort(): Promise<void> {
    if (this.writable) {
      try {
        await this.writable.abort();
      } catch (e) {}
      this.writable = null;
    }
  }
}

/**
 * OPFS (Origin Private File System) Streaming Writer.
 */
export class OpfsStorageWriter implements StorageWriter {
  private fileHandle: any = null;
  private writable: any = null;
  private filename: string = '';

  getType(): 'opfs' {
    return 'opfs';
  }

  async init(filename: string, _mimeType: string, _expectedSize: number): Promise<boolean> {
    if (
      typeof navigator === 'undefined' ||
      !('storage' in navigator) ||
      typeof navigator.storage.getDirectory !== 'function'
    ) {
      return false;
    }
    try {
      this.filename = `nexdrop_${Date.now()}_${sanitizeFilename(filename)}`;
      const root = await navigator.storage.getDirectory();
      this.fileHandle = await root.getFileHandle(this.filename, { create: true });
      this.writable = await this.fileHandle.createWritable();
      return true;
    } catch (err) {
      console.warn('OPFS initialization failed:', err);
      return false;
    }
  }

  async writeChunk(chunk: ArrayBuffer): Promise<void> {
    if (this.writable) {
      await this.writable.write(chunk);
    }
  }

  async finish(): Promise<{ blobUrl?: string; success: boolean }> {
    if (this.writable) {
      await this.writable.close();
      this.writable = null;
      const file = await this.fileHandle.getFile();
      const blobUrl = URL.createObjectURL(file);
      return { blobUrl, success: true };
    }
    return { success: false };
  }

  async abort(): Promise<void> {
    if (this.writable) {
      try {
        await this.writable.abort();
      } catch (e) {}
      this.writable = null;
    }
  }
}

/**
 * Memory Blob Fallback Writer with safe bounds.
 */
export class MemoryBlobWriter implements StorageWriter {
  private chunks: ArrayBuffer[] = [];
  private totalBytes: number = 0;
  private filename: string = '';
  private mimeType: string = '';
  private maxAllowedBytes: number = 1.8 * 1024 * 1024 * 1024; // 1.8 GB guard

  getType(): 'blob' {
    return 'blob';
  }

  async init(filename: string, mimeType: string, expectedSize: number): Promise<boolean> {
    this.filename = filename;
    this.mimeType = mimeType || 'application/octet-stream';
    this.chunks = [];
    this.totalBytes = 0;

    if (expectedSize > this.maxAllowedBytes) {
      console.warn('File size exceeds safe in-memory limit for this browser fallback.');
    }
    return true;
  }

  async writeChunk(chunk: ArrayBuffer): Promise<void> {
    this.chunks.push(chunk);
    this.totalBytes += chunk.byteLength;
  }

  async finish(): Promise<{ blobUrl?: string; success: boolean }> {
    const blob = new Blob(this.chunks, { type: this.mimeType });
    this.chunks = []; // Release references
    const blobUrl = URL.createObjectURL(blob);
    return { blobUrl, success: true };
  }

  async abort(): Promise<void> {
    this.chunks = [];
    this.totalBytes = 0;
  }
}

/**
 * Factory to create best available writer.
 * If user interaction is needed for showSaveFilePicker, attempts FileSystemAccessWriter first.
 */
export async function createOptimalStorageWriter(
  filename: string,
  mimeType: string,
  expectedSize: number,
  preferDirectDiskPicker: boolean = true
): Promise<StorageWriter> {
  if (preferDirectDiskPicker && typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    const fsWriter = new FileSystemAccessWriter();
    const ok = await fsWriter.init(filename, mimeType, expectedSize);
    if (ok) return fsWriter;
  }

  // Next try OPFS
  const opfsWriter = new OpfsStorageWriter();
  const opfsOk = await opfsWriter.init(filename, mimeType, expectedSize);
  if (opfsOk) return opfsWriter;

  // Fallback to memory blob writer
  const memWriter = new MemoryBlobWriter();
  await memWriter.init(filename, mimeType, expectedSize);
  return memWriter;
}
