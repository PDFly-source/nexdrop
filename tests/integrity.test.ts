/**
 * v2.5.3 INTEGRITY REGRESSION SUITE (LIVE-1790935144052 root cause)
 * -------------------------------------------------------------------------
 * Root cause being pinned here: the hash-scheme negotiation is a
 * timing-fallible handshake. The sender offers 's256m' and waits a bounded
 * window for the receiver's HASH_OK. On a loaded phone over a real internet
 * path, control replies can land AFTER the window (measured ACK latency
 * peaked at 360 ms on the failing run). A late reply silently downgraded
 * the sender to JS hashing while the receiver kept the merkle scheme:
 *   (a) the pump was paced by JS SHA-256 → 0.62 MB/s with a 16.78 MB window
 *       never binding and in-flight stuck at 128-512 KiB;
 *   (b) the two schemes can NEVER match → false SHA FAIL on a byte-perfect
 *       358.07 MB transfer (byte counts equal, hash reported as FAIL).
 *
 * These tests prove, end-to-end over an in-memory channel pair:
 *  1. a late-but-delivered HASH_OK (400 ms, beyond the OLD 250 ms window)
 *     keeps the native merkle pipeline on both ends (v2.5.3 window: 2500 ms)
 *  2. a DROPPED reply degrades to a declared 'sha256' sender scheme and the
 *     receiver HONESTLY re-verifies the durable file under the sender's
 *     scheme → VERIFY PASS on a byte-perfect file (no blind FAIL)
 *  3. REAL corruption still FAILs even through the re-verification path
 *  4. encrypted transfers (AES-256-GCM, 1 MiB / 10 MiB) verify end-to-end
 *  5. pause/resume mid-transfer preserves integrity (encrypted)
 *  6. out-of-order arrival + duplicate chunks: integrity audit counters are
 *     exact and the content still verifies
 */
import assert from 'node:assert/strict';
import { SenderEngine, senderTestOverrides } from '../lib/transfer/sender';
import { ReceiverEngine } from '../lib/transfer/receiver';
import { MemoryBlobWriter } from '../lib/transfer/writer';
import { IncrementalSha256 } from '../lib/crypto';
import { createChunkCipher, generateIvPrefix } from '../lib/crypto';
import { simpleStringHash } from '../lib/transfer/protocol';

let count = 0;
function check(cond: boolean, label: string, detail?: string) {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ''}`);
  count++;
  console.log(`  ✓ ${label}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Immediate in-memory DataChannel double (ordered, lossless). */
class LoopChannel {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  peer: LoopChannel | null = null;
  private lowListeners: Array<() => void> = [];
  private closeListeners: Array<() => void> = [];

  addEventListener(type: string, fn: () => void): void {
    if (type === 'bufferedamountlow') this.lowListeners.push(fn);
    if (type === 'close') this.closeListeners.push(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    if (type === 'bufferedamountlow') this.lowListeners = this.lowListeners.filter((f) => f !== fn);
    if (type === 'close') this.closeListeners = this.lowListeners.filter((f) => f !== fn);
  }
  send(data: ArrayBuffer): void {
    const payload = data.slice(0);
    setTimeout(() => {
      if (this.peer) this.peer.onmessage?.({ data: payload });
      for (const fn of [...this.lowListeners]) fn();
    }, 0);
  }
}

/** Plain SHA-256 of a full buffer (independent of the engine's hasher). */
async function plainSha256(u8: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', u8));
  return Array.from(d).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Independent merkle-chain digest (same construction as s256m, computed
 *  by hand — an end-to-end content proof, not a tautology). */
async function independentMerkle(u8: Uint8Array<ArrayBuffer>): Promise<string> {
  const BLOCK = 4 * 1024 * 1024;
  const chain: number[] = [];
  for (let o = 0; o < u8.length; o += BLOCK) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', u8.subarray(o, Math.min(o + BLOCK, u8.length))));
    for (const b of d) chain.push(b);
  }
  const fin = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(chain)));
  return Array.from(fin).map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface PairOpts {
  size: number;
  /** Enable AES-256-GCM chunk encryption on both ends. */
  encrypted?: boolean;
  /** Drop the receiver's HASH_OK entirely (scheme divergence). */
  dropHashOk?: boolean;
  /** Deliver the HASH_OK after this delay (late but not lost). */
  hashOkDelayMs?: number;
  /** Override the sender's negotiation window (test seam). */
  hashOkWaitMs?: number;
  /** Pause/resume at the Nth cumulative ACK (0 = never). */
  pauseAtAck?: number;
  /** Corrupt one byte of the durable file at the writer (real corruption). */
  corruptAtByte?: number;
}

interface PairResult {
  senderHash: string;
  senderHashMode: string;
  fileEndHashAlgo: string | undefined;
  verifyMatch: boolean | null;
  receiverHash: string | undefined;
  audit: {
    chunksProcessed: number;
    duplicatesDropped: number;
    reorderStashed: number;
    scheme: string | null;
    senderScheme: string | null;
    schemeReverified: boolean;
  } | null;
}

async function runPair(opts: PairOpts): Promise<PairResult> {
  const { size, encrypted = false, dropHashOk = false, hashOkDelayMs = 0 } = opts;

  const body = new Uint8Array(size);
  for (let i = 0; i < size; i++) body[i] = (i * 131 + 17) & 0xff;
  const file = new File([body], 'integrity.bin', { type: 'application/octet-stream' });

  const chA = new LoopChannel();
  const chB = new LoopChannel();
  chA.peer = chB;
  chB.peer = chA;

  let cipher = null as null | { key: CryptoKey };
  let ivPrefix: Uint8Array | null = null;
  if (encrypted) {
    const raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    cipher = await createChunkCipher(key);
    ivPrefix = generateIvPrefix();
  }

  const writer = new MemoryBlobWriter();
  const result: PairResult = {
    senderHash: '',
    senderHashMode: '',
    fileEndHashAlgo: undefined,
    verifyMatch: null,
    receiverHash: undefined,
    audit: null,
  };
  let ackCount = 0;
  let paused = false;

  const receiver = new ReceiverEngine({
    onProgress: () => {},
    onCompleted: (p) => {
      result.receiverHash = p.hash;
    },
    onError: (_id, e) => {
      throw new Error('receiver error: ' + e);
    },
    sendControlMessage: (m: any) => {
      queueMicrotask(() => {
        if (m.type === 'HASH_OK') {
          if (dropHashOk) return; // simulates a reply lost after the window
          if (hashOkDelayMs > 0) setTimeout(() => sender.handleHashOk(m.algo), hashOkDelayMs);
          else sender.handleHashOk(m.algo);
        }
        if (m.type === 'ACK') {
          ackCount++;
          sender.handleAck(m.index, m.w, m.q, m.rb, m.wb);
          if (opts.pauseAtAck && ackCount === opts.pauseAtAck && !paused) {
            paused = true;
            sender.pause();
            setTimeout(() => sender.resume(), 150);
          }
        } else if (m.type === 'VERIFY') {
          result.verifyMatch = m.match;
        }
      });
      return true;
    },
    ...(cipher ? { getCipher: () => cipher } : {}),
  });
  /** Delegating wrapper that flips one byte of the FIRST batch written —
   *  a REAL durable-file corruption the verification must catch. */
  class CorruptingWriter {
    private first = true;
    constructor(private inner: MemoryBlobWriter, private atByte: number) {}
    getType() { return this.inner.getType(); }
    async init(f: string, m: string, e: number) { return this.inner.init(f, m, e); }
    private corruptOnce(buf: ArrayBuffer): void {
      if (this.first && buf.byteLength > 0) {
        this.first = false;
        const u8 = new Uint8Array(buf);
        u8[Math.min(this.atByte, u8.length - 1)] ^= 0xff;
      }
    }
    async writeChunk(chunk: ArrayBuffer) {
      this.corruptOnce(chunk);
      return this.inner.writeChunk(chunk);
    }
    async writeChunks(chunks: ArrayBuffer[], firstIndex: number) {
      if (chunks.length > 0) this.corruptOnce(chunks[0]);
      return this.inner.writeChunks(chunks, firstIndex);
    }
    async finish() { return this.inner.finish(); }
    async abort() { return this.inner.abort(); }
    writtenTotalBytes() { return this.inner.writtenTotalBytes(); }
    readDurableBytes() { return this.inner.readDurableBytes(); }
  }
  receiver.setWriterOverride(() =>
    opts.corruptAtByte != null ? (new CorruptingWriter(writer, opts.corruptAtByte) as unknown as MemoryBlobWriter) : writer
  );

  const sender = new SenderEngine({
    transferId: 'integrity-proof',
    file,
    fileChannel: chA as unknown as RTCDataChannel,
    maxMessageSize: 1048576,
    sendControlMessage: (m: any) => {
      queueMicrotask(() => {
        if (m.type === 'FILE_START') void receiver.startTransfer(m);
        else if (m.type === 'FILE_END') {
          result.fileEndHashAlgo = m.hashAlgo;
          void receiver.finishTransfer(m);
        }
      });
      return true;
    },
    onProgress: () => {},
    onCompleted: (_id, hash) => {
      result.senderHash = hash;
    },
    onError: (_id, e) => {
      throw new Error('sender error: ' + e);
    },
    ...(cipher && ivPrefix ? { cipher, ivPrefix } : {}),
  });

  chB.onmessage = (ev) => {
    void receiver.handleChunk(ev.data);
  };

  if (opts.hashOkWaitMs != null) senderTestOverrides.hashOkWaitMs = opts.hashOkWaitMs;
  const t0 = Date.now();
  const startPromise = sender.start();
  // start() resolves when the pump returns; wait for the true completion.
  const doneDeadline = Date.now() + 60000;
  while (result.senderHash === '' && Date.now() < doneDeadline) await sleep(20);
  void startPromise;
  const verifyDeadline = Date.now() + 30000;
  while (result.verifyMatch === null && Date.now() < verifyDeadline) await sleep(20);
  delete senderTestOverrides.hashOkWaitMs;

  result.senderHashMode = (sender as unknown as { metrics: { hashMode: string } }).metrics.hashMode;
  const audit = (receiver as unknown as {
    integrityAudit: PairResult['audit'];
  }).integrityAudit;
  result.audit = audit;
  void t0;
  return result;
}

async function main(): Promise<void> {
  console.log('[integrity] v2.5.3 hash-scheme negotiation + encrypted E2E');

  // ---- 1. The LIVE-1790935144052 race: HASH_OK lands at 400 ms —
  //         beyond the OLD 250 ms window, inside the v2.5.3 2500 ms one.
  //         The sender must KEEP native merkle (no silent JS downgrade).
  {
    const r = await runPair({ size: 1 * 1024 * 1024, hashOkDelayMs: 400 });
    check(r.senderHashMode === 'merkle', 'late HASH_OK (400ms) keeps native merkle — no silent downgrade', `mode=${r.senderHashMode}`);
    check(r.fileEndHashAlgo === 's256m', 'FILE_END declares the negotiated scheme s256m', r.fileEndHashAlgo);
    check(r.verifyMatch === true, 'late-reply transfer verifies PASS');
  }

  // ---- 2. Dropped HASH_OK (sender saw no reply): sender degrades to a
  //         DECLARED 'sha256' scheme; the receiver's streaming merkle hash
  //         cannot match by construction — the v2.5.3 re-verification must
  //         hash the DURABLE file under the sender's scheme and PASS.
  {
    const size = 256 * 1024;
    const r = await runPair({ size, dropHashOk: true, hashOkWaitMs: 80 });
    check(r.senderHashMode === 'inline', 'dropped HASH_OK degrades sender to JS hashing (declared, not silent)', `mode=${r.senderHashMode}`);
    check(r.fileEndHashAlgo === 'sha256', 'FILE_END declares sha256 after downgrade', r.fileEndHashAlgo);
    check(r.verifyMatch === true, 'scheme divergence resolves to PASS via durable-file re-verification (the LIVE-1790935144052 scenario)');
    check(r.audit?.schemeReverified === true, 'integrity audit records the re-verification');
    check(r.audit?.scheme === 's256m' && r.audit.senderScheme === 'sha256', 'audit shows the diverged schemes', JSON.stringify(r.audit));
    // The sender's declared sha256 must equal the true file content.
    const body = new Uint8Array(size);
    for (let i = 0; i < size; i++) body[i] = (i * 131 + 17) & 0xff;
    check(r.senderHash === await plainSha256(body), 'downgraded sender digest is the true plain SHA-256 of the content');
  }

  // ---- 3. REAL corruption must still FAIL — the re-verification path is
  //         a stronger check (hash of durable bytes), never a PASS rubber stamp.
  {
    const r = await runPair({ size: 256 * 1024, dropHashOk: true, hashOkWaitMs: 80, corruptAtByte: 1000 });
    check(r.verifyMatch === false, 'a corrupted durable byte FAILS verification even on the re-verify path');
  }

  // ---- 4. Encrypted end-to-end (AES-256-GCM) integrity, merkle negotiated.
  {
    const size = 1 * 1024 * 1024;
    const r = await runPair({ size, encrypted: true });
    check(r.senderHashMode === 'merkle', 'encrypted transfer negotiates merkle');
    check(r.verifyMatch === true, '1 MiB encrypted transfer SHA-256 = PASS');
    const body = new Uint8Array(size);
    for (let i = 0; i < size; i++) body[i] = (i * 131 + 17) & 0xff;
    check(r.senderHash === (await independentMerkle(body)), 'encrypted 1 MiB: sender digest is the true content digest');
    check(r.senderHash === r.receiverHash, 'encrypted 1 MiB: sender and receiver digests are identical');
  }
  {
    const size = 10 * 1024 * 1024;
    const r = await runPair({ size, encrypted: true });
    check(r.verifyMatch === true, '10 MiB encrypted transfer SHA-256 = PASS');
    check(r.senderHash === r.receiverHash, 'encrypted 10 MiB: both digests identical (multi-block merkle chain)');
  }

  // ---- 5. Pause/resume mid-transfer (encrypted) preserves integrity.
  {
    const r = await runPair({ size: 8 * 1024 * 1024, encrypted: true, pauseAtAck: 2 });
    check(r.verifyMatch === true, 'pause/resume mid-transfer: SHA-256 = PASS (encrypted)');
  }

  // ---- 6. Out-of-order + duplicate delivery: the audit counters are exact
  //         and the content still verifies (direct receiver feed).
  {
    const CHUNK = 64 * 1024;
    const N = 8;
    const size = CHUNK * N;
    const body = new Uint8Array(size);
    for (let i = 0; i < size; i++) body[i] = (i * 7 + 3) & 0xff;
    const transferIdHash = simpleStringHash('ooo');
    let verifyMatch: boolean | null = null;
    interface AuditShape {
      chunksProcessed: number;
      duplicatesDropped: number;
      reorderStashed: number;
      maxReorderDepth: number;
      scheme: string | null;
      senderScheme: string | null;
      schemeReverified: boolean;
    }
    const receiver = new ReceiverEngine({
      onProgress: () => {},
      onCompleted: () => {},
      onError: (_id, e) => {
        throw new Error('receiver error: ' + e);
      },
      sendControlMessage: (m: any) => {
        if (m.type === 'VERIFY') verifyMatch = m.match;
        return true;
      },
    });
    const writer = new MemoryBlobWriter();
    receiver.setWriterOverride(() => writer);
    await receiver.startTransfer({
      type: 'FILE_START',
      transferId: 'ooo',
      name: 'ooo.bin',
      mimeType: 'application/octet-stream',
      size,
      totalChunks: N,
      chunkSize: CHUNK,
      hashAlgo: 's256m',
      transferIdHash,
      senderVersion: 'test',
    } as any);
    // Scrambled order: 3,1,5,0,2,4,7,6 + duplicates of processed chunks.
    const order = [3, 1, 5, 0, 2, 4, 7, 6];
    const feed = (idx: number) => {
      const frame = new Uint8Array(16 + CHUNK);
      const view = new DataView(frame.buffer);
      view.setUint32(0, idx, false);
      view.setUint32(4, N, false);
      view.setUint32(8, transferIdHash, false);
      view.setUint32(12, CHUNK, false);
      frame.set(body.subarray(idx * CHUNK, (idx + 1) * CHUNK), 16);
      void receiver.handleChunk(frame.buffer);
    };
    order.forEach(feed);
    await sleep(30);
    // After all 8 chunks are processed the frontier is 8 — these are
    // duplicate drops (already-processed indices).
    feed(1);
    feed(3);
    await sleep(30);
    const expectedMerkle = await independentMerkle(body);
    void receiver.finishTransfer({
      type: 'FILE_END',
      transferId: 'ooo',
      hash: expectedMerkle,
      hashAlgo: 's256m',
    } as any);
    const deadline = Date.now() + 10000;
    while (verifyMatch === null && Date.now() < deadline) await sleep(20);
    const audit = (receiver as unknown as { integrityAudit: AuditShape }).integrityAudit;
    check(verifyMatch === true, 'out-of-order + duplicates: content verifies PASS');
    check(audit?.chunksProcessed === N, 'audit: exactly N chunks processed', String(audit?.chunksProcessed));
    check(audit?.duplicatesDropped === 2, 'audit: 2 duplicates dropped', String(audit?.duplicatesDropped));
    check((audit?.reorderStashed ?? 0) >= 4, 'audit: reorder stash counted the scrambled arrivals', String(audit?.reorderStashed));
    check(writer.writtenTotalBytes() === size, 'audit: durable bytes exactly equal file size', String(writer.writtenTotalBytes()));
  }

  console.log(`[integrity] ${count} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
