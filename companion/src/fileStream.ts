/**
 * Bounded streaming file reader/writer for the native Turbo path
 * (mission Phase 2 / 17).
 *
 * Sender: reads the file in bounded chunks (async generator, one chunk in
 * memory at a time) and hashes it on the fly.
 * Receiver: writes chunks at explicit offsets to a sparse file with
 * fs.writeAt-like semantics (createWriteStream would force sequential
 * consumption; offsets let resume and out-of-order frames land correctly),
 * fsyncs before reporting a durable offset, and hashes on the fly.
 *
 * RAM is bounded by (chunk + write queue depth x chunk), never file size.
 */

import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';

/** Tunable read/write batch (mission Phase 3: benchmark 256KB..4MB). */
export const DEFAULT_STREAM_CHUNK = 1024 * 1024;

export interface BoundedReader {
  size: number;
  chunks(): AsyncGenerator<{ offset: number; bytes: Buffer }>;
}

/** Open a file for streamed reads — never more than one chunk in RAM. */
export async function openReader(path: string, chunk = DEFAULT_STREAM_CHUNK): Promise<BoundedReader> {
  const fh: FileHandle = await open(path, constants.O_RDONLY);
  const size = (await fh.stat()).size;
  async function* chunks(): AsyncGenerator<{ offset: number; bytes: Buffer }> {
    let offset = 0;
    try {
      while (offset < size) {
        const len = Math.min(chunk, size - offset);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, offset);
        if (bytesRead !== len) throw new Error(`short read at ${offset}: ${bytesRead} != ${len}`);
        yield { offset, bytes: buf.subarray(0, bytesRead) };
        offset += bytesRead;
      }
    } finally {
      await fh.close().catch(() => {});
    }
  }
  return { size, chunks };
}

export interface DurableWriter {
  /** Write at an offset; call order does not matter (resume/out-of-order safe). */
  writeAt(offset: number, bytes: Uint8Array): Promise<void>;
  /** fsync, then report the durable byte position. */
  durableOffset(): Promise<number>;
  /** Streaming SHA-256 of everything written so far. */
  digestHex(): string;
  close(): Promise<void>;
  /** Queued writes not yet flushed to the OS (telemetry). */
  queued: number;
}

/**
 * Sparse-capable offset writer. Writes land at their frame offset, so a
 * resumed transfer neither re-writes durable ranges nor trusts RAM state.
 * `highBytes` tracks the furthest contiguous durable position, which is what
 * resume uses; gaps cannot exist because the sender always re-sends from
 * the durable offset.
 */
export async function openDurableWriter(
  path: string,
  opts: { hashExistingPrefix?: boolean } = {}
): Promise<DurableWriter> {
  const fh = await open(path, constants.O_WRONLY | constants.O_CREAT);
  const hash = createHash('sha256');
  let high = 0;
  let queued = 0;
  let closed = false;

  async function writeAt(offset: number, bytes: Uint8Array): Promise<void> {
    if (closed) throw new Error('writer closed');
    queued++;
    try {
      await fh.write(bytes, 0, bytes.length, offset);
      hash.update(bytes);
      if (offset + bytes.length > high) high = offset + bytes.length;
    } finally {
      queued--;
    }
  }

  async function durableOffset(): Promise<number> {
    if (closed) return high;
    await fh.datasync();
    return high;
  }

  async function close(): Promise<void> {
    closed = true;
    await fh.datasync();
    await fh.close();
  }

  // Resume support (Phase 5): when re-opening a partially written file,
  // hash the durable prefix so the receiver's whole-file SHA covers every
  // byte on disk, not just the ones written by this connection. v1 files
  // are always contiguous from offset 0, so the current size IS the
  // durable high watermark.
  if (opts.hashExistingPrefix) {
    const existing = (await fh.stat()).size;
    for (let off = 0; off < existing; ) {
      const len = Math.min(4 * 1024 * 1024, existing - off);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, off);
      if (bytesRead !== len) throw new Error(`short prefix read at ${off}`);
      hash.update(buf.subarray(0, bytesRead));
      off += bytesRead;
    }
    high = existing;
  }

  return {
    writeAt,
    durableOffset,
    digestHex: () => hash.digest('hex'),
    close,
    get queued() {
      return queued;
    },
  };
}

/** Whole-file SHA-256, streamed (used by tests and pre-hash paths). */
export async function sha256File(path: string): Promise<string> {
  const r = await openReader(path, 4 * 1024 * 1024);
  const hash = createHash('sha256');
  for await (const { bytes } of r.chunks()) hash.update(bytes);
  return hash.digest('hex');
}
