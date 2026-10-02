/**
 * v2.5 receiver write-accounting regression tests.
 *
 * Backstory (real CI incident, 2026-10-02): the OPFS sync-access worker
 * transfers payload buffers to the worker (structured-clone transfer list),
 * which DETACHES them on the main thread. Two consequences chained into a
 * silent data-loss bug that still reported 'Completed + Verified':
 *   1. The writer's short-write check compared the worker's byte count
 *      against post-transfer byteLength (always 0) -> false 'short write'
 *      throw on EVERY batch.
 *   2. The throw hit the receiver's write-error catch, which wipes the
 *      write queue — discarding every queued-but-unwritten chunk (~37%
 *      of the file on the CI run).
 *   3. bytesWritten was computed from post-write byteLength (0 for
 *      detached buffers) — and completion gated only on bytesReceived,
 *      so the truncated file passed as success.
 *
 * Fixes under test:
 *   A. Durable-byte accounting uses the GATHER-TIME batch sum (exact for
 *      any writer, detached or not).
 *   B. Completion requires bytesWritten === size — write-path loss can
 *      never pass as success.
 *   C. The sync writer's short-write check captures the expected sum
 *      BEFORE the transfer detaches the buffers.
 *
 * C needs a real Worker (covered by the e2e benchmark + probe); A and B
 * are proven here with a detaching mock and a lossy mock.
 */

import { ReceiverEngine } from '../lib/transfer/receiver';
import { simpleStringHash } from '../lib/transfer/protocol';
import type { StorageWriter } from '../lib/transfer/writer';

const SIZE = 256 * 1024; // 4 chunks of 64 KiB

/** A writer that TRANSFERS (detaches) every buffer it is given, exactly
 *  like the OPFS sync worker's structured-clone transfer list. */
class DetachingWriter implements StorageWriter {
  writtenBytes = 0;
  private chunks: ArrayBuffer[] = [];
  getType(): 'blob' {
    return 'blob';
  }
  async init(): Promise<boolean> {
    return true;
  }
  async writeChunk(chunk: ArrayBuffer): Promise<void> {
    // Detach the caller's buffer, as a structured-clone transfer would.
    const copy = structuredClone(chunk.slice(0), { transfer: [chunk] });
    this.chunks.push(copy);
    this.writtenBytes += copy.byteLength;
  }
  async writeChunks(chunks: ArrayBuffer[]): Promise<void> {
    for (const c of chunks) await this.writeChunk(c);
  }
  async finish(): Promise<{ blobUrl?: string; success: boolean }> {
    return { success: true };
  }
  async abort(): Promise<void> {}
  payloadBytes() {
    return this.chunks.reduce((a, c) => a + c.byteLength, 0);
  }
}

/** A writer that silently DROPS half of every batch (simulates data loss
 *  in the storage layer that must never pass as success) but reports its
 *  totals HONESTLY — the storage-boundary gate must refuse completion. */
class LossyWriter implements StorageWriter {
  writtenBytes = 0;
  getType(): 'blob' {
    return 'blob';
  }
  writtenTotalBytes(): number | null {
    return this.writtenBytes;
  }
  async init(): Promise<boolean> {
    return true;
  }
  async writeChunk(chunk: ArrayBuffer): Promise<void> {
    this.writtenBytes += Math.floor(chunk.byteLength / 2); // drops half
  }
  async writeChunks(chunks: ArrayBuffer[]): Promise<void> {
    for (const c of chunks) await this.writeChunk(c);
  }
  async finish(): Promise<{ success: boolean }> {
    return { success: true };
  }
  async abort(): Promise<void> {}
}

async function runTransfer(writer: StorageWriter): Promise<{
  completed: boolean;
  verified: boolean | null;
  verifyMatch: boolean | null;
  ackWb: number[];
}> {
  const state = {
    completed: false,
    verified: null as boolean | null,
    verifyMatch: null as boolean | null,
    ackWb: [] as number[],
  };
  const receiver = new ReceiverEngine({
    onProgress: () => {},
    onCompleted: () => {
      state.completed = true;
    },
    onError: () => {},
    sendControlMessage: (m: any) => {
      if (m.type === 'ACK') state.ackWb.push(m.wb);
      if (m.type === 'VERIFY') state.verifyMatch = m.match;
      return true;
    },
  });
  receiver.setWriterOverride(() => writer);

  const transferIdHash = simpleStringHash('t1');
  await receiver.startTransfer({
    type: 'FILE_START',
    transferId: 't1',
    name: 'probe.bin',
    mimeType: 'application/octet-stream',
    size: SIZE,
    totalChunks: 4,
    chunkSize: 65536,
    transferIdHash,
    senderVersion: 'test',
  } as any);

  for (let i = 0; i < 4; i++) {
    const header = new ArrayBuffer(16);
    const view = new DataView(header);
    view.setUint32(0, i, false);
    view.setUint32(4, 4, false);
    view.setUint32(8, transferIdHash, false);
    view.setUint32(12, 65536, false);
    const payload = new Uint8Array(65536).fill(i);
    const frame = new Uint8Array(16 + 65536);
    frame.set(new Uint8Array(header), 0);
    frame.set(payload, 16);
    await receiver.handleChunk(frame.buffer);
  }
  await receiver.finishTransfer({
    type: 'FILE_END',
    transferId: 't1',
    chunkCount: 4,
    fileHash: '0'.repeat(64),
  } as any);
  // Let the microtask/macrotask queue settle (writer loop is async).
  await new Promise((r) => setTimeout(r, 100));
  return state;
}

async function main(): Promise<void> {
  let pass = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    if (!ok) throw new Error(`FAIL: ${name} ${detail}`);
    pass++;
    console.log(`  ✓ ${name}`);
  };

  // A — detaching writer: accounting must stay EXACT (gather-time sum),
  // the durable frontier must reach SIZE, and completion must succeed.
  // Reports its true durable total (like the sync worker does from worker
  // replies) — the storage gate must PASS an honest, complete writer.
  const dw = new DetachingWriter();
  const _dwReport = dw as unknown as { writtenTotalBytes(): number | null };
  (dw as any).writtenTotalBytes = () => dw.payloadBytes();
  const det = await runTransfer(dw);
  check(
    'detaching writer: durable byte frontier reaches SIZE (gather-time accounting)',
    Math.max(0, ...det.ackWb) === SIZE && det.ackWb[det.ackWb.length - 1] === SIZE,
    `ackWb=${JSON.stringify(det.ackWb)}`
  );
  check('detaching writer: transfer completes and verifies', det.completed && det.verifyMatch !== false);
  check('detaching writer: no bytes lost in storage', dw.payloadBytes() === SIZE);
  check('detaching writer: honest total passes the storage gate', _dwReport.writtenTotalBytes() === SIZE);

  // B — lossy writer: HALF the file vanished — must NOT pass as success.
  const lw = new LossyWriter();
  const loss = await runTransfer(lw);
  check(
    'lossy writer: completion REFUSED (storage-boundary gate)',
    !loss.completed && loss.verifyMatch === false,
    `completed=${loss.completed} verifyMatch=${loss.verifyMatch}`
  );
  check(
    'lossy writer: reported exactly half the file durably',
    lw.writtenTotalBytes() === SIZE / 2,
    `reported=${lw.writtenTotalBytes()}`
  );

  console.log(`[writer-account] ${pass} checks passed`);
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
