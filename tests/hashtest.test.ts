/**
 * TURBO v2.4 HASH-PIPELINE CORRUPTION PROOFS (2026-10-01)
 * -------------------------------------------------------------------------
 * The v2.4 directive: parallelize the sender-side SHA-256/preparation
 * pipeline WITHOUT regressing a single correctness property. This suite
 * proves each hash engine is bit-exact before any throughput claim:
 *
 *  A. MerkleHasher ('s256m') — digest equals the hand-computed chain of
 *     native per-block digests for: empty input, exact blocks, partial
 *     blocks, multi-block streams, and 63/64-byte boundary torture sizes.
 *  B. Worker source — the dedicated-thread streaming SHA-256 produces the
 *     IDENTICAL digest to lib/crypto IncrementalSha256 for the same
 *     adversarial feeds (driven in a sandbox; the browser path is exercised
 *     by the real-Chromium two-device e2e + benchmark).
 *  C. Sender inline mode ('inline') — the exact v2.3 legacy path still
 *     hashes the plaintext stream identically end-to-end (pair transfer,
 *     classic digest verified both sides).
 */
import assert from 'node:assert/strict';
import { IncrementalSha256 } from '../lib/crypto';
import { MerkleHasher } from '../lib/transfer/merkle';
import { WORKER_SRC } from '../lib/transfer/hashPipeline';
import { SenderEngine } from '../lib/transfer/sender';
import { ReceiverEngine } from '../lib/transfer/receiver';

let count = 0;
function check(cond: boolean, label: string, detail?: string) {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ''}`);
  count++;
  console.log(`  ✓ ${label}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function manualMerkle(chunks: ArrayBuffer[], blockBytes: number): Promise<string> {
  // Reference implementation: concatenate, split into blocks, digest each
  // natively, digest the chain.
  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(new Uint8Array(c), off);
    off += c.byteLength;
  }
  const chain: number[] = [];
  // Convention (matches MerkleHasher): ZERO blocks → digest of the empty
  // chain, i.e. plain SHA-256("") — so an empty file's merkle digest equals
  // its classic SHA-256 digest.
  for (let o = 0; o < total; o += blockBytes) {
    const slice = all.subarray(o, Math.min(o + blockBytes, total));
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', slice));
    for (const b of d) chain.push(b);
  }
  const hex = await crypto.subtle.digest('SHA-256', new Uint8Array(chain));
  return Array.from(new Uint8Array(hex))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function seededBytes(n: number, seed: number): ArrayBuffer {
  const b = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    b[i] = x & 0xff;
  }
  return b.buffer;
}

async function main(): Promise<void> {
  const BLOCK = 256 * 1024;

  // ---------------- A. MerkleHasher correctness ----------------
  {
    const h = new MerkleHasher(BLOCK);
    const hex = await h.finalize();
    const ref = await manualMerkle([], BLOCK);
    check(hex === ref, 'merkle: empty stream digest is the agreed empty chain hash', `${hex} vs ${ref}`);
  }
  {
    const h = new MerkleHasher(BLOCK);
    const one = seededBytes(BLOCK, 1);
    await h.update(one);
    const hex = await h.finalize();
    const ref = await manualMerkle([one], BLOCK);
    check(hex === ref, 'merkle: exact one-block stream', `${hex.slice(0, 16)}…`);
  }
  {
    const h = new MerkleHasher(BLOCK);
    const parts = [
      seededBytes(BLOCK + 1000, 2), // spills into a second partial block
      seededBytes(777, 3), // small tail push
    ];
    for (const p of parts) await h.update(p);
    const hex = await h.finalize();
    const ref = await manualMerkle(parts, BLOCK);
    check(hex === ref, 'merkle: multi-push stream with partial final block');
  }
  {
    // Boundary torture: 63 and 64 byte tails inside one block; many small
    // fire-and-forget pushes must keep EXACT ordering (the v2.4 invariant).
    const h = new MerkleHasher(1024);
    const parts: ArrayBuffer[] = [];
    let seed = 7;
    for (let i = 0; i < 300; i++) {
      const n = 63 + (i % 2); // alternate 63/64-byte pushes
      const p = seededBytes(n, (seed = (seed * 31 + i) >>> 0));
      parts.push(p);
      void h.update(p); // fire-and-forget — ordering must still hold
    }
    await sleep(50); // let the internal chain drain
    const hex = await h.finalize();
    const ref = await manualMerkle(parts, 1024);
    check(hex === ref, 'merkle: 300 interleaved fire-and-forget pushes keep exact order');
  }
  {
    const h = new MerkleHasher(BLOCK);
    const big = seededBytes(BLOCK * 3 + 12345, 9);
    await h.update(big.slice(0, 1000)); // first push small
    await h.update(big.slice(1000)); // second push spans several blocks
    const hex = await h.finalize();
    const ref = await manualMerkle([big], BLOCK);
    check(hex === ref, 'merkle: multi-block push spanning 3+ blocks');
  }

  // ---------------- B. Worker streaming SHA-256 ----------------
  {
    // Sandbox-drive the worker source: identical protocol, no DOM.
    const posted: Array<Record<string, unknown>> = [];
    const fakeSelf = {
      postMessage: (m: Record<string, unknown>) => posted.push(m),
    };
    const run = new Function('self', WORKER_SRC);
    run(fakeSelf);
    const onmessage = (globalThis as unknown as { onmessage?: (ev: { data: unknown }) => void }).onmessage;
    check(typeof onmessage === 'function', 'worker: source installs its message handler');

    const parts: ArrayBuffer[] = [];
    let seed = 21;
    for (let i = 0; i < 200; i++) {
      const n = 1 + ((i * 37) % 5000); // adversarial sizes incl. <64 and non-multiples
      const p = seededBytes(n, (seed = (seed * 17 + 5) >>> 0));
      parts.push(p);
      onmessage!({ data: { op: 'update', buf: p, bytes: p.byteLength } });
    }
    onmessage!({ data: { op: 'finalize' } });
    const digestMsg = posted.find((m) => m.op === 'digest') as { hex?: string } | undefined;
    check(!!digestMsg?.hex, 'worker: produced a digest');
    const refHasher = new IncrementalSha256();
    for (const p of parts) refHasher.update(new Uint8Array(p));
    check(
      digestMsg?.hex === refHasher.finalize(),
      'worker: streaming digest is IDENTICAL to lib/crypto IncrementalSha256 for adversarial feeds',
      `${digestMsg?.hex?.slice(0, 16)}…`
    );
    const ackedBytes = posted.reduce((a, m) => a + (m.op === 'acked' ? (m.bytes as number) : 0), 0);
    check(ackedBytes === parts.reduce((a, p) => a + p.byteLength, 0), 'worker: acked byte accounting is exact');
  }

  // ---------------- C. Sender 'inline' mode — legacy path intact ----------------
  {
    // Minimal in-memory pair, FORCED inline: the classic digest must verify
    // end-to-end exactly as in v2.3 (old-peer fallback).
    const g = globalThis as Record<string, unknown>;
    const prev = g.__NEXDROP_HASH_MODE;
    g.__NEXDROP_HASH_MODE = 'inline';
    try {
      const SIZE = 3 * 1024 * 1024;
      const body = new Uint8Array(SIZE);
      for (let i = 0; i < SIZE; i++) body[i] = (i * 97 + 11) & 0xff;
      const ref = new IncrementalSha256();
      ref.update(body);
      const expected = ref.finalize();
      const file = new File([body], 'inline.bin', { type: 'application/octet-stream' });

      const mkCh = () => {
        const a = {
          readyState: 'open',
          bufferedAmount: 0,
          bufferedAmountLowThreshold: 0,
          peer: null as null | any,
          onmessage: null as null | ((ev: { data: ArrayBuffer }) => void),
          listeners: {} as Record<string, Array<() => void>>,
          addEventListener(_t: string, fn: () => void) {
            (a.listeners[_t] ??= []).push(fn);
          },
          removeEventListener() {},
          send(d: ArrayBuffer) {
            const payload = d.slice(0);
            setTimeout(() => {
              a.peer?.onmessage?.({ data: payload });
              (a.listeners['bufferedamountlow'] ?? []).forEach((f) => f());
            }, 0);
          },
        };
        return a;
      };
      const chA: any = mkCh();
      const chB: any = mkCh();
      chA.peer = chB;
      chB.peer = chA;

      const sendInfo: { hash?: string; err?: string } = {};
      const recvInfo: { hash?: string; verified?: boolean } = {};

      const receiver = new ReceiverEngine({
        onProgress: () => {},
        onCompleted: (p) => {
          recvInfo.hash = p.hash;
          recvInfo.verified = p.hashVerified;
        },
        onError: (_id, e) => {
          throw new Error('receiver error: ' + e);
        },
        sendControlMessage: (m: any) => {
          setTimeout(() => {
            if (m.type === 'ACK') sender.handleAck(m.index, m.w, m.q, m.rb, m.wb);
            if (m.type === 'HASH_OK') sender.handleHashOk(m.algo);
          }, 0);
          return true;
        },
      });

      const sender = new SenderEngine({
        transferId: 'inline-proof',
        file,
        fileChannel: chA as unknown as RTCDataChannel,
        maxMessageSize: 1048576,
        sendControlMessage: (m: any) => {
          setTimeout(() => {
            if (m.type === 'FILE_START') void receiver.startTransfer(m);
            else if (m.type === 'PAUSE') receiver.handlePause(m);
            else if (m.type === 'RESUME') receiver.handleResume(m);
            else if (m.type === 'FILE_END') void receiver.finishTransfer(m);
          }, 0);
          return true;
        },
        onProgress: () => {},
        onCompleted: (_id, hash) => {
          sendInfo.hash = hash;
        },
        onError: (_id, e) => {
          sendInfo.err = e;
        },
      });

      chB.onmessage = (ev: { data: ArrayBuffer }) => {
        void receiver.handleChunk(ev.data);
      };

      await sender.start();
      const deadline = Date.now() + 15000;
      while (sendInfo.hash === undefined && Date.now() < deadline) await sleep(25);
      while (recvInfo.hash === undefined && Date.now() < deadline) await sleep(25);

      check(sendInfo.err === undefined, 'inline: sender completes with no error', sendInfo.err ?? '');
      check(sendInfo.hash === expected, 'inline: sender classic digest matches the v2.3 stream hash');
      check(recvInfo.hash === expected, 'inline: receiver classic digest matches');
      check(recvInfo.verified === true, 'inline: receiver VERIFY verdict is a match');
      const m = (sender as unknown as { metrics: { hashMode: string } }).metrics;
      check(m.hashMode === 'inline', 'inline: forced mode stays inline (no negotiation)');
    } finally {
      if (prev === undefined) delete g.__NEXDROP_HASH_MODE;
      else g.__NEXDROP_HASH_MODE = prev;
    }
  }

  console.log(`[hash-test] ${count} checks passed`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('[hash-test] FAILED', e);
    process.exit(1);
  }
);
