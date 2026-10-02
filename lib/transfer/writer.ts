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
  /**
   * Batched in-order write: one storage call for several consecutive chunks.
   * Default implementation is sequential writeChunk calls; disk-backed
   * writers override it with a single coalesced write because per-call
   * async overhead (measured ~4-9 ms per call on mobile/CI) — not raw disk
   * bandwidth — was the real receiver-side throughput ceiling.
   * Implementations MUST write all payloads in array order.
   */
  writeChunks(chunks: ArrayBuffer[], firstIndex: number): Promise<void>;
  finish(): Promise<{ blobUrl?: string; success: boolean; writtenTotalBytes?: number }>;
  abort(): Promise<void>;
  getType(): 'filesystem' | 'opfs' | 'opfs-sync' | 'blob';
  /**
   * TRUE number of durable bytes the writer placed on disk, for the
   * receiver's completion gate. Implementations that cannot know
   * return null. The receiver compares this against the announced size
   * before reporting success — a storage layer that under-writes must
   * never pass as a completed transfer (v2.5 honesty contract).
   */
  writtenTotalBytes?(): number | null;
}

/**
 * Direct disk streaming writer via File System Access API.
 */
export class FileSystemAccessWriter implements StorageWriter {
  private fileHandle: any = null;
  private writable: any = null;
  private written = 0;
  writtenTotalBytes(): number | null {
    return this.written;
  }

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
      this.written += chunk.byteLength;
    }
  }

  /** One coalesced write for consecutive chunks (no per-chunk copy: the
   *  Blob references the buffers; the stream serializes them in order). */
  async writeChunks(chunks: ArrayBuffer[], _firstIndex: number): Promise<void> {
    if (!this.writable || chunks.length === 0) return;
    if (chunks.length === 1) {
      await this.writable.write(chunks[0]);
      this.written += chunks[0].byteLength;
      return;
    }
    await this.writable.write(new Blob(chunks));
    for (const c of chunks) this.written += c.byteLength;
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
  private written = 0;
  writtenTotalBytes(): number | null {
    return this.written;
  }

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
      this.written += chunk.byteLength;
    }
  }

  /** One coalesced write for consecutive chunks (same rationale as the
   *  File System Access writer: per-call latency dominates on mobile). */
  async writeChunks(chunks: ArrayBuffer[], _firstIndex: number): Promise<void> {
    if (!this.writable || chunks.length === 0) return;
    if (chunks.length === 1) {
      await this.writable.write(chunks[0]);
      this.written += chunks[0].byteLength;
      return;
    }
    await this.writable.write(new Blob(chunks));
    for (const c of chunks) this.written += c.byteLength;
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
 * v2.5 OPFS synchronous-access writer: a DEDICATED Worker holding a
 * FileSystemSyncAccessHandle. Measured evidence (341.48 MB CI profile):
 * the async createWritable().write() path costs ~5-6 ms PER CALL
 * (45-58% of receiver wall at ~162 KiB batches) — per-call commit
 * latency, not bandwidth. The sync access handle (Chromium, dedicated
 * workers only) removes that per-call latency. Writes are strictly
 * sequential through the worker's FIFO message queue — byte order is
 * preserved by construction, one write in flight at a time.
 *
 * Capability detection is real: if the worker, OPFS, or
 * createSyncAccessHandle is unavailable, init() fails and the factory
 * falls back to the async OPFS writer. Support is NOT assumed identical
 * to the async OPFS path (sync handles are worker-only and Chromium-only).
 */
export class OpfsSyncWorkerWriter implements StorageWriter {
  private worker: Worker | null = null;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private nextId = 1;
  private opfsName = '';
  private closed = false;
  /** TRUE durable bytes reported back by the worker per batch — the
   *  completion gate's ground truth (v2.5 honesty contract). */
  private written = 0;
  writtenTotalBytes(): number | null {
    return this.written;
  }

  getType(): 'opfs-sync' {
    return 'opfs-sync';
  }

  private request(payload: Record<string, unknown>, transfer?: ArrayBuffer[]): Promise<any> {
    if (!this.worker) return Promise.reject(new Error('worker not started'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        // Buffers ride in the message AND the transfer list: the worker
        // receives them zero-copy (transferred), not cloned.
        this.worker!.postMessage({ ...payload, id }, transfer ?? []);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async init(filename: string, _mimeType: string, _expectedSize: number): Promise<boolean> {
    if (typeof Worker === 'undefined' || typeof navigator === 'undefined') return false;
    if (!('storage' in navigator) || typeof navigator.storage.getDirectory !== 'function') return false;
    const cleanName = sanitizeFilename(filename);
    this.opfsName = `nexdrop_${Date.now()}_${cleanName}`;
    let url = '';
    try {
      const blob = new Blob([OPFS_SYNC_WORKER_SRC], { type: 'application/javascript' });
      url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      // Route worker replies; an unexpected worker death surfaces as a
      // rejection on every pending request (the writer loop reports it).
      worker.onmessage = (e: MessageEvent) => {
        const { id, ok, error, written } = e.data || {};
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (ok) p.resolve(written ?? 0);
        else p.reject(new Error(error || 'OPFS sync worker error'));
      };
      worker.onerror = (e) => {
        const err = new Error(`OPFS sync worker failed: ${e.message || 'unknown'}`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      };
      this.worker = worker;
      await this.request({ cmd: 'init', filename: this.opfsName }, []);
      return true;
    } catch (err) {
      console.warn('OPFS sync-access writer unavailable, falling back:', err);
      try { this.worker?.terminate(); } catch {}
      this.worker = null;
      this.pending.clear();
      if (url) URL.revokeObjectURL(url);
      return false;
    }
  }

  async writeChunk(chunk: ArrayBuffer): Promise<void> {
    await this.writeChunks([chunk], 0);
  }

  /** One round-trip per BATCH (bounded): the worker appends each buffer in
   *  order at its tracked position and returns the byte count written.
   *
   *  The expected sum is captured BEFORE postMessage: the buffers ride in
   *  the TRANSFER list, so structured-clone detaches them on this thread —
   *  reading byteLength afterwards yields 0 (this exact false 'short write'
   *  threw per batch in CI, wiped the receiver's write queue, and silently
   *  truncated the file while the transfer still reported success). */
  async writeChunks(chunks: ArrayBuffer[], _firstIndex: number): Promise<void> {
    if (this.closed || !this.worker) return;
    if (chunks.length === 0) return;
    const buffers = chunks.filter((c) => c.byteLength > 0);
    if (buffers.length === 0) return;
    const expected = buffers.reduce((a, c) => a + c.byteLength, 0);
    const written = await this.request({ cmd: 'write', buffers }, buffers);
    if (typeof written !== 'number' || written !== expected) {
      throw new Error(`OPFS sync short write: ${written} of ${expected} bytes`);
    }
    this.written += written;
  }

  async finish(): Promise<{ blobUrl?: string; success: boolean }> {
    if (!this.worker) return { success: false };
    try {
      await this.request({ cmd: 'finish' }, []);
    } catch (e) {
      console.warn('OPFS sync finish warning:', e);
    }
    this.closed = true;
    try { this.worker.terminate(); } catch {}
    this.worker = null;
    // Read the finished file back on the MAIN thread for the blob URL —
    // the sync handle is closed, so the exclusive lock is released.
    try {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(this.opfsName, { create: false });
      const file = await handle.getFile();
      const blobUrl = URL.createObjectURL(file);
      return { blobUrl, success: true };
    } catch (err) {
      console.warn('OPFS sync re-open for blob URL failed:', err);
      return { success: false };
    }
  }

  async abort(): Promise<void> {
    this.closed = true;
    if (this.worker) {
      try { await this.request({ cmd: 'abort' }, []); } catch {}
      try { this.worker.terminate(); } catch {}
      this.worker = null;
    }
    this.pending.clear();
  }
}

/** Worker source: createSyncAccessHandle exists ONLY inside dedicated
 *  workers; the probe failure replies 'no-sync' and init() falls back. */
const OPFS_SYNC_WORKER_SRC = `
self.onmessage = async (e) => {
  const { id, cmd, filename } = e.data || {};
  const reply = (msg) => self.postMessage(Object.assign({ id }, msg));
  try {
    if (cmd === 'init') {
      if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) {
        return reply({ ok: false, error: 'no-opfs' });
      }
      const root = await navigator.storage.getDirectory();
      self.handle = await root.getFileHandle(filename, { create: true });
      if (typeof self.handle.createSyncAccessHandle !== 'function') {
        return reply({ ok: false, error: 'no-sync-handle' });
      }
      self.sync = await self.handle.createSyncAccessHandle();
      self.pos = 0;
      reply({ ok: true });
    } else if (cmd === 'write') {
      if (!self.sync) return reply({ ok: false, error: 'not-open' });
      const buffers = e.data.buffers || [];
      let written = 0;
      for (let i = 0; i < buffers.length; i++) {
        const view = new Uint8Array(buffers[i]);
        const n = self.sync.write(view, { at: self.pos });
        self.pos += n;
        written += n;
      }
      reply({ ok: true, written });
    } else if (cmd === 'finish') {
      if (self.sync) { self.sync.flush(); self.sync.close(); self.sync = null; }
      reply({ ok: true });
    } else if (cmd === 'abort') {
      if (self.sync) { try { self.sync.close(); } catch ({} ) {} self.sync = null; }
      reply({ ok: true });
    } else {
      reply({ ok: false, error: 'unknown-cmd' });
    }
  } catch (err) {
    reply({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};
`;

/**
 * Memory Blob Fallback Writer with safe bounds.
 */
export class MemoryBlobWriter implements StorageWriter {
  private chunks: ArrayBuffer[] = [];
  private totalBytes: number = 0;
  private filename: string = '';
  private mimeType: string = '';
  private maxAllowedBytes: number = 1.5 * 1024 * 1024 * 1024; // 1.5 GiB guard against out-of-memory crashes

  getType(): 'blob' {
    return 'blob';
  }

  writtenTotalBytes(): number | null {
    return this.totalBytes;
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
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > this.maxAllowedBytes) {
      throw new Error(
        'File too large for this browser (no disk/OPFS storage available and the in-memory fallback limit was reached). Use a browser with File System Access API or OPFS support for large files.'
      );
    }
    this.chunks.push(chunk);
  }

  /** Memory fallback keeps per-chunk references (no coalescing benefit). */
  async writeChunks(chunks: ArrayBuffer[], _firstIndex: number): Promise<void> {
    for (const c of chunks) await this.writeChunk(c);
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
  // Measurement seam (benchmark A/B only): 'opfs-sync' forces the worker
  // path with NO async fallback (failures surface honestly); 'opfs-async'
  // skips the worker path entirely; absent/anything else = auto.
  const forced = (globalThis as { __NEXDROP_FORCE_WRITER?: string }).__NEXDROP_FORCE_WRITER || 'auto';

  if (preferDirectDiskPicker && typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    const fsWriter = new FileSystemAccessWriter();
    const ok = await fsWriter.init(filename, mimeType, expectedSize);
    if (ok) return fsWriter;
  }

  // v2.5: OPFS sync-access worker first (removes the measured ~5-6 ms
  // per-call async commit latency), then the async OPFS writer, then
  // the bounded memory fallback. Capability detection at every step.
  if (forced !== 'opfs-async') {
    const syncWriter = new OpfsSyncWorkerWriter();
    const syncOk = await syncWriter.init(filename, mimeType, expectedSize);
    if (syncOk) return syncWriter;
    if (forced === 'opfs-sync') throw new Error('forced opfs-sync writer unavailable');
  }

  const opfsWriter = new OpfsStorageWriter();
  const opfsOk = await opfsWriter.init(filename, mimeType, expectedSize);
  if (opfsOk) return opfsWriter;

  // Fallback to memory blob writer
  const memWriter = new MemoryBlobWriter();
  await memWriter.init(filename, mimeType, expectedSize);
  return memWriter;
}
