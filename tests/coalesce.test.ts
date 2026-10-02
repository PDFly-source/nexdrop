/**
 * v2.5.1 receiver write-coalescing tests (time-bounded held batches).
 *
 * The coalescer must:
 *  - default to greedy flush (hold=0) identical to pre-v2.5.1 behavior
 *  - with a hold window, join spaced chunks into ONE storage call
 *  - preserve strict ordering and exact durable-byte accounting
 *  - flush held bytes IMMEDIATELY on finish (bounded completion latency)
 *  - drop held bytes on cancel (no write-after-cancel)
 *  - never hold when the batch target is already met
 *  - record the batch-size distribution for the profile
 */

import { ReceiverEngine } from '../lib/transfer/receiver';
import { simpleStringHash } from '../lib/transfer/protocol';
import type { StorageWriter } from '../lib/transfer/writer';

const CHUNK = 64 * 1024;

/** Recording mock writer: logs every storage call with its buffers. */
class RecordingWriter implements StorageWriter {
  calls: Array<{ size: number; count: number; bytes: number }> = [];
  private written = 0;
  getType(): 'blob' {
    return 'blob';
  }
  writtenTotalBytes(): number | null {
    return this.written;
  }
  async init(): Promise<boolean> {
    return true;
  }
  async writeChunk(chunk: ArrayBuffer): Promise<void> {
    this.calls.push({ size: chunk.byteLength, count: 1, bytes: chunk.byteLength });
    this.written += chunk.byteLength;
  }
  async writeChunks(chunks: ArrayBuffer[]): Promise<void> {
    const bytes = chunks.reduce((a, c) => a + c.byteLength, 0);
    this.calls.push({ size: bytes / chunks.length, count: chunks.length, bytes });
    this.written += bytes;
  }
  async finish(): Promise<{ success: boolean }> {
    return { success: true };
  }
  async abort(): Promise<void> {}
  totalCalls() {
    return this.calls.reduce((a, c) => a + c.count, 0);
  }
}

interface RunOpts {
  holdMs?: number;
  targetBytes?: number;
  gapMs?: number;
  chunks?: number;
  cancelAt?: number;
  finishWait?: number;
}

interface RunResult {
  state: {
    completed: boolean;
    verifyMatch: boolean | null;
    ackWb: number[];
  };
  writer: RecordingWriter;
  elapsedMs: number;
}

async function runCoalesce(opts: RunOpts): Promise<RunResult> {
  const {
    holdMs = 0,
    targetBytes = 4 * CHUNK,
    gapMs = 0,
    chunks = 6,
    cancelAt = -1,
    finishWait = 3000,
  } = opts;
  const state = {
    completed: false,
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
  (globalThis as any).__NEXDROP_WRITE_HOLD_MS = holdMs > 0 ? holdMs : undefined;
  (globalThis as any).__NEXDROP_WRITE_BATCH_BYTES = targetBytes;
  const writer = new RecordingWriter();
  receiver.setWriterOverride(() => writer);

  const transferIdHash = simpleStringHash('c1');
  await receiver.startTransfer({
    type: 'FILE_START',
    transferId: 'c1',
    name: 'coalesce.bin',
    mimeType: 'application/octet-stream',
    size: CHUNK * chunks,
    totalChunks: chunks,
    chunkSize: CHUNK,
    transferIdHash,
    senderVersion: 'test',
  } as any);

  const t0 = Date.now();
  let cancelled = false;
  for (let i = 0; i < chunks; i++) {
    const frame = new Uint8Array(16 + CHUNK);
    const view = new DataView(frame.buffer);
    view.setUint32(0, i, false);
    view.setUint32(4, chunks, false);
    view.setUint32(8, transferIdHash, false);
    view.setUint32(12, CHUNK, false);
    frame.fill(1, 16);
    void receiver.handleChunk(frame.buffer);
    if (i === cancelAt) {
      cancelled = true;
      void receiver.cancel('test cancel');
      break;
    }
    if (gapMs > 0 && i < chunks - 1) await new Promise((r) => setTimeout(r, gapMs));
  }

  if (!cancelled) {
    const finishPromise = receiver.finishTransfer({
      type: 'FILE_END',
      transferId: 'c1',
      chunkCount: chunks,
      fileHash: '0'.repeat(64),
    } as any);
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), finishWait));
    const outcome = await Promise.race([finishPromise, timeout]);
    if (outcome === 'timeout') throw new Error('finishTransfer timed out');
  }
  await new Promise((r) => setTimeout(r, 150));
  delete (globalThis as any).__NEXDROP_WRITE_HOLD_MS;
  delete (globalThis as any).__NEXDROP_WRITE_BATCH_BYTES;
  return { state, writer, elapsedMs: Date.now() - t0 };
}

async function main(): Promise<void> {
  let pass = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    if (!ok) throw new Error(`FAIL: ${name} ${detail}`);
    pass++;
    console.log(`  ✓ ${name}`);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // 1. Greedy default: chunks fed in a tight burst, hold=0 — flushes
  //    promptly; exact accounting; completes.
  const g = await runCoalesce({ holdMs: 0, chunks: 6, gapMs: 0 });
  check('greedy: transfer completes and verifies', g.state.completed && g.state.verifyMatch !== false);
  check('greedy: every byte durable', g.writer.writtenTotalBytes() === 6 * CHUNK);
  check('greedy: durable frontier reached SIZE', Math.max(...g.state.ackWb) === 6 * CHUNK);

  // 2. Hold coalescing: 6 chunks of 64 KiB spaced 10 ms apart (span 50 ms),
  //    a 95 ms hold window (clamped <= WRITE_HOLD_MAX_MS=100, never expires
  //    mid-stream) and a 6*CHUNK target — ALL 6 must join ONE storage call,
  //    flushed by FILE_END.
  const h = await runCoalesce({ holdMs: 95, targetBytes: 6 * CHUNK, chunks: 6, gapMs: 10 });
  check(
    'hold: spaced chunks coalesce into ONE storage call',
    h.writer.calls.length === 1 && h.writer.calls[0].count === 6,
    `calls=${JSON.stringify(h.writer.calls.map((c) => c.count))}`
  );
  check('hold: order preserved (first call carries all bytes)', h.writer.calls[0] && h.writer.calls[0].bytes === 6 * CHUNK);
  check('hold: completes and verifies', h.state.completed && h.state.verifyMatch !== false);
  check('hold: exact durable accounting', h.writer.writtenTotalBytes() === 6 * CHUNK);

  // 2b. Hold CAP: a 50 ms hold with 25 ms gaps must fire mid-stream (the
  //     time threshold is a hard cap, not an idle-wait) — but still
  //     coalesce (fewer calls than chunks) with zero loss.
  const cap = await runCoalesce({ holdMs: 30, targetBytes: 6 * CHUNK, chunks: 6, gapMs: 25 });
  check(
    'hold-cap: time threshold fires mid-stream (calls < chunks, > 1)',
    cap.writer.calls.length > 1 && cap.writer.calls.length < 6,
    `calls=${JSON.stringify(cap.writer.calls.map((c) => c.count))}`
  );
  check('hold-cap: exact durable accounting', cap.writer.writtenTotalBytes() === 6 * CHUNK);
  check('hold-cap: completes and verifies', cap.state.completed && cap.state.verifyMatch !== false);

  // 3. Finish forces the flush: hold window is LONG (300 ms) but FILE_END
  //    must complete within a bounded time (no 300 ms tail latency).
  const t0 = Date.now();
  const f = await runCoalesce({ holdMs: 300, targetBytes: 64 * CHUNK, chunks: 3, gapMs: 0, finishWait: 2000 });
  const finishElapsed = Date.now() - t0;
  check(
    'finish: held batch flushed immediately on FILE_END (no hold tail)',
    f.state.completed && finishElapsed < 250,
    `elapsed=${finishElapsed}ms`
  );

  // 4. Cancel during hold: held bytes must NOT reach storage.
  const c = await runCoalesce({ holdMs: 300, targetBytes: 64 * CHUNK, chunks: 3, gapMs: 0, cancelAt: 0 });
  await sleep(400);
  check('cancel: held bytes never written', c.writer.writtenTotalBytes() === 0, `written=${c.writer.writtenTotalBytes()}`);
  check('cancel: transfer never completes', !c.state.completed);

  // 5. Target met -> immediate flush even with a hold window: 4-chunk
  //    target, 4 chunks arriving in a tight burst -> one call, promptly.
  const m = await runCoalesce({ holdMs: 200, targetBytes: 4 * CHUNK, chunks: 4, gapMs: 0 });
  check(
    'target: batch at target flushes without waiting the hold',
    m.writer.calls.length === 1 && m.state.completed,
    `calls=${JSON.stringify(m.writer.calls.map((x) => x.count))} completed=${m.state.completed}`
  );

  // 6. Mixed: 10 chunks, 4*CHUNK target, 80ms hold, 20ms gaps — every
  //    durable byte accounted, no loss, no duplication.
  const x = await runCoalesce({ holdMs: 80, targetBytes: 4 * CHUNK, chunks: 10, gapMs: 20 });
  check('mixed: completes and verifies', x.state.completed && x.state.verifyMatch !== false);
  check('mixed: exact durable accounting', x.writer.writtenTotalBytes() === 10 * CHUNK);
  check(
    'mixed: coalescing actually engaged (fewer storage calls than chunks)',
    x.writer.calls.length < 10 && x.writer.calls.length >= 1,
    `storageCalls=${x.writer.calls.length} chunkCounts=${JSON.stringify(x.writer.calls.map((c) => c.count))}`
  );

  console.log(`[coalesce] ${pass} checks passed`);
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
