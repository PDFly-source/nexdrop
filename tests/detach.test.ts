/**
 * TURBO v2.4 regression — the worker-mode transferable detach bug (2026-10-01).
 *
 * The benchmark A/B sweep caught worker mode stalling with "no sender
 * progress for 120s" while the receiver had already durably ACKed 53 MB.
 * Telemetry showed bytesSent:0, bytesAcked:53MB, inFlight NEGATIVE —
 * the pump never closed its loop.
 *
 * Root cause: WorkerHashPipeline.push() posts the plaintext buffer with a
 * TRANSFERABLE (postMessage transfer list), which detaches the ArrayBuffer
 * synchronously. The pump then read chunkBuffer.byteLength AFTER push —
 * 0 for every chunk — so bytesSent never advanced and the accounting,
 * window, and completion logic all starved while real data kept flowing.
 *
 * This test reproduces the EXACT detach semantics in Node (structuredClone
 * with a transfer list — same detachment as a real Worker postMessage)
 * through the pipelineOverrides seam, and holds the sender to:
 *   1. bytesSent advances to the full file size (the regression),
 *   2. the digest is the classic SHA-256 (worker mode is wire-identical),
 *   3. the receiver verifies the content end-to-end.
 *
 * Runs in-process: sender + receiver over loopback channels, no network.
 */

import { IncrementalSha256 } from '../lib/crypto';
import { SenderEngine } from '../lib/transfer/sender';
import { ReceiverEngine } from '../lib/transfer/receiver';
import { pipelineOverrides, HashPipeline } from '../lib/transfer/hashPipeline';

function assert(cond: any, msg: string, extra?: string): void {
  if (!cond) {
    console.error(`[detach-regression] FAILED: ${msg}${extra ? ' — ' + extra : ''}`);
    process.exit(1);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Loopback channel pair (same shape the ack-pipeline suite uses). */
class LoopChannel {
  peer: LoopChannel | null = null;
  bufferedAmount = 0;
  readyState = 'open';
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  private lowListeners: Array<() => void> = [];
  send(data: ArrayBuffer): boolean {
    const payload = data.slice(0);
    setTimeout(() => {
      if (this.peer) this.peer.onmessage?.({ data: payload });
      for (const fn of [...this.lowListeners]) fn();
    }, 0);
    return true;
  }
  addEventListener(kind: 'bufferedamountlow', fn: () => void) {
    if (kind === 'bufferedamountlow') this.lowListeners.push(fn);
  }
}

/** Mock engine with EXACT worker semantics: push detaches the buffer via a
 *  transfer, hashing happens after the detach (as inside the worker). */
class DetachingMockPipeline implements HashPipeline {
  readonly mode = 'worker' as const;
  private hasher = new IncrementalSha256();
  private lag = 0;
  private waiters = new Set<() => void>();
  detachedCount = 0;

  push(buf: ArrayBuffer, bytes: number): void {
    this.lag += bytes;
    // The worker owns the buffer: postMessage([buf]) detaches it HERE.
    const owned = structuredClone(buf, { transfer: [buf] });
    if (buf.byteLength === 0) this.detachedCount++;
    // Detached immediately — same observable state a real Worker leaves.
    setTimeout(() => {
      this.hasher.update(new Uint8Array(owned));
      this.lag -= bytes;
      for (const w of [...this.waiters]) {
        if (this.lag <= (w as unknown as { cap: number }).cap) w();
      }
    }, 0);
  }
  lagBytes(): number {
    return this.lag;
  }
  async drainTo(cap: number): Promise<void> {
    if (this.lag <= cap) return;
    await new Promise<void>((resolve) => {
      const w = () => {
        if (this.lag <= cap) {
          this.waiters.delete(w);
          resolve();
        }
      };
      (w as unknown as { cap: number }).cap = cap;
      this.waiters.add(w);
    });
  }
  finalize(): Promise<string> {
    return Promise.resolve(this.hasher.finalize());
  }
  reset(): void {
    this.hasher = new IncrementalSha256();
    this.lag = 0;
    this.waiters.clear();
  }
  hashCpuMs(): number {
    return 0;
  }
  dispose(): void {
    this.waiters.clear();
  }
}

async function main(): Promise<void> {
  // Force the worker engine: 'auto' would negotiate native merkle.
  (globalThis as Record<string, unknown>).__NEXDROP_HASH_MODE = 'worker';
  const SIZE = 2 * 1024 * 1024; // 2 MiB — enough for ladder + queue-cap paths
  const body = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) body[i] = (i * 73 + 11) & 0xff;
  const expectedHasher = new IncrementalSha256();
  expectedHasher.update(body);
  const expectedHash = expectedHasher.finalize();
  const file = new File([body], 'detach-regression.bin', { type: 'application/octet-stream' });

  const engineRef: { mock?: DetachingMockPipeline } = {};
  pipelineOverrides.worker = () => {
    engineRef.mock = new DetachingMockPipeline();
    return engineRef.mock;
  };

  const chA = new LoopChannel();
  const chB = new LoopChannel();
  chA.peer = chB;
  chB.peer = chA;

  const recvInfo: { hash?: string; verified?: boolean; completed?: boolean } = {};
  const sendInfo: { hash?: string; err?: string; completed?: boolean } = {};

  const receiver = new ReceiverEngine({
    onProgress: () => {},
    onCompleted: (p) => {
      recvInfo.hash = p.hash;
      recvInfo.verified = p.hashVerified;
      recvInfo.completed = true;
    },
    onError: (_id, e) => {
      throw new Error('receiver error: ' + e);
    },
    sendControlMessage: (m: any) => {
      queueMicrotask(() => {
        if (m.type === 'HASH_OK') sender.handleHashOk(m.algo);
        else if (m.type === 'ACK') sender.handleAck(m.index, m.w, m.q, m.rb, m.wb);
      });
      return true;
    },
  });

  const sender = new SenderEngine({
    transferId: 'detach-proof',
    file,
    fileChannel: chA as unknown as RTCDataChannel,
    maxMessageSize: 1048576,
    sendControlMessage: (m: any) => {
      queueMicrotask(() => {
        if (m.type === 'FILE_START') void receiver.startTransfer(m);
        else if (m.type === 'PAUSE') receiver.handlePause(m);
        else if (m.type === 'RESUME') receiver.handleResume(m);
        else if (m.type === 'FILE_END') void receiver.finishTransfer(m);
      });
      return true;
    },
    onProgress: () => {},
    onCompleted: (_id, hash) => {
      sendInfo.hash = hash;
      sendInfo.completed = true;
    },
    onError: (_id, e) => {
      sendInfo.err = e;
    },
  });

  chB.onmessage = (ev) => {
    void receiver.handleChunk(ev.data);
  };

  const deadline = Date.now() + 30000;
  await sender.start();
  while (!sendInfo.completed && Date.now() < deadline) await sleep(25);
  while (!recvInfo.completed && Date.now() < deadline) await sleep(25);

  // ---- 1. The regression: bytesSent must have advanced past every detach ----
  const s = sender as unknown as { bytesSent: number; bytesAcked: number; metrics: { hashMode: string; hashCpuMs: number } };
  assert(sendInfo.err === undefined, 'sender completes with no error', sendInfo.err ?? '');
  assert(s.bytesSent === SIZE, 'bytesSent == file size (detach did not zero the accounting)', String(s.bytesSent));
  assert(s.bytesAcked === SIZE, 'bytesAcked == file size', String(s.bytesAcked));
  assert(s.metrics.hashMode === 'worker', 'worker engine selected via seam', s.metrics.hashMode);
  const detachedOnPush = engineRef.mock?.detachedCount ?? -1;
  assert(detachedOnPush === Math.ceil(SIZE / (64 * 1024)), 'push detached every chunk buffer (real transferable semantics)', String(detachedOnPush));

  // ---- 2. Digest correctness through the detaching engine ----
  assert(sendInfo.hash === expectedHash, 'sender digest is the classic SHA-256 (wire-identical)');
  assert(recvInfo.hash === expectedHash, 'receiver digest matches');
  assert(recvInfo.verified === true, 'receiver VERIFY verdict is a match');

  console.log(
    `[detach-regression] 2 MiB worker-detach test: bytesSent ${s.bytesSent}/${SIZE}, ` +
    `${detachedOnPush} detached pushes, classic SHA-256 verified both sides`
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('[detach-regression] FAILED', e);
    process.exit(1);
  }
);
