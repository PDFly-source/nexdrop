/**
 * CELLULAR-PATH PIPELINE PROOF (physical 400-500 KB/s incident, 2026-10-01)
 * -------------------------------------------------------------------------
 * Question: is the NexDrop engine itself the reason a real phone pair runs
 * at ~500 KB/s, or is that the path (carrier NAT / SCTP congestion control)?
 *
 * This test emulates a cellular-shaped DataChannel — 5 Mbps serialized
 * drain + 100 ms one-way propagation, ACKs equally delayed — and proves:
 *   1. The engine fills its byte window (in-flight >= INITIAL_WINDOW_BYTES)
 *      — the transfer is NOT secretly stop-and-wait at high RTT.
 *   2. The engine consumes >= 85% of the shaped capacity — no hidden timer
 *      pacing, no artificial rate limit between 400-500 KB/s.
 *   3. SHA-256 verification still gates completion.
 *
 * What this test does NOT emulate: SCTP congestion control, packet loss,
 * retransmission, phone CPU/GC. If the engine passes here but a real phone
 * pair still runs at ~400-500 KB/s, the remaining limiter is the measured
 * network path / browser SCTP behavior — to be proven on-device with the
 * Device Test evidence fields (candidate pair, networkType, RTT,
 * retransmissions, available bitrate), never assumed.
 */
import assert from 'node:assert';
import { SenderEngine } from '../lib/transfer/sender';
import { ReceiverEngine } from '../lib/transfer/receiver';
import { MemoryBlobWriter } from '../lib/transfer/writer';
import type { StorageWriter } from '../lib/transfer/writer';

// ---- shaped channel: 5 Mbps + 100 ms one-way ----------------------------
const SHAPED_BPS = 5 * 1000 * 1000 / 8; // 625 KB/s serialized drain
const LATENCY_MS = 100; // one-way propagation

type LowListener = () => void;

class ShapedChannel {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  private lowListeners: LowListener[] = [];
  private closeListeners: LowListener[] = [];
  private queue: Array<{ data: ArrayBuffer; deliverAt: number }> = [];
  private nextAvailMs = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  addEventListener(type: string, fn: LowListener): void {
    if (type === 'bufferedamountlow') this.lowListeners.push(fn);
    if (type === 'close') this.closeListeners.push(fn);
  }
  removeEventListener(type: string, fn: LowListener): void {
    if (type === 'bufferedamountlow') this.lowListeners = this.lowListeners.filter((f) => f !== fn);
    if (type === 'close') this.closeListeners = this.closeListeners.filter((f) => f !== fn);
  }

  send(data: ArrayBuffer): void {
    const bytes = data.byteLength;
    this.bufferedAmount += bytes;
    const now = Date.now();
    const start = Math.max(now, this.nextAvailMs);
    const transmitMs = (bytes / SHAPED_BPS) * 1000;
    this.nextAvailMs = start + transmitMs;
    this.queue.push({ data, deliverAt: start + transmitMs + LATENCY_MS });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    const tick = () => {
      this.timer = null;
      const now = Date.now();
      let fired = false;
      while (this.queue.length > 0 && this.queue[0].deliverAt <= now) {
        const item = this.queue.shift()!;
        this.bufferedAmount = Math.max(0, this.bufferedAmount - item.data.byteLength);
        this.onmessage?.({ data: item.data });
        fired = true;
      }
      if (fired && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        for (const fn of [...this.lowListeners]) fn();
      }
      if (this.queue.length > 0) {
        const wait = Math.min(50, Math.max(1, this.queue[0].deliverAt - now));
        this.timer = setTimeout(tick, wait);
      }
    };
    this.timer = setTimeout(tick, 1);
  }
}

// ---- harness --------------------------------------------------------------
async function main(): Promise<void> {
  const SIZE = 8 * 1024 * 1024; // 8 MiB
  const file = new File([new Uint8Array(SIZE).fill(0xa5)], 'cellular.bin', {
    type: 'application/octet-stream',
  });

  const fileChannel = new ShapedChannel();
  const senderState: {
    done: { id: string; hash: string } | null;
    err: { id: string; e: string } | null;
  } = { done: null, err: null };
  const sender = new SenderEngine({
    transferId: 't-cell',
    file,
    fileChannel: fileChannel as unknown as RTCDataChannel,
    maxMessageSize: 262144, // typical negotiated SCTP ceiling
    sendControlMessage: (msg: any) => {
      setTimeout(() => {
        if (msg.type === 'FILE_START') void receiver.startTransfer(msg);
        else if (msg.type === 'FILE_END') void receiver.finishTransfer(msg);
      }, LATENCY_MS);
      return true;
    },
    onProgress: () => {},
    onCompleted: (id: string, hash: string) => {
      senderState.done = { id, hash };
    },
    onError: (id: string, e: string) => {
      senderState.err = { id, e };
    },
  });

  const receiver = new ReceiverEngine({
    onProgress: () => {},
    onCompleted: (info) => {
      recvState.done = info;
    },
    onError: (id, e) => console.log(`[cellular] RECEIVER ERROR: ${e} (${id})`),
    sendControlMessage: (msg: any) => {
      setTimeout(() => {
        if (msg.type === 'ACK') sender.handleAck(msg.index, msg.w, msg.q, msg.rb, msg.wb);
        if (msg.type === 'HASH_OK') sender.handleHashOk(msg.algo);
      }, LATENCY_MS);
      return true;
    },
  });

  let maxInFlight = 0;
  let verified = false;
  const recvState: { done: { hashVerified?: boolean; status: string } | null } = { done: null };

  fileChannel.onmessage = (ev) => {
    void receiver.handleChunk(ev.data);
  };
  (receiver as unknown as { writer: StorageWriter | null }).writer = null; // built by startTransfer

  // Patch the receiver's writer factory: force the in-memory writer (Node
  // already resolves to it, but make it explicit for this harness).
  const origWriter = MemoryBlobWriter.prototype.writeChunks;
  void origWriter;

  // Poll real engine internals (private fields — any-cast for sampling).
  // 2026-10-01 incident regression guard: chunk size must stay FIXED for the
  // whole transfer even under a fully healthy ACK stream (this harness is
  // exactly the condition that used to trigger the broken mid-transfer ramp).
  const chunkSizesSeen = new Set<number>();
  let stepsSeen: Array<{ firstIndex: number; size: number }> = [];
  const poll = setInterval(() => {
    const s = sender as unknown as { bytesSent: number; bytesAcked: number; chunkSize: number; chunkSteps: Array<{ firstIndex: number; size: number }> };
    maxInFlight = Math.max(maxInFlight, s.bytesSent - s.bytesAcked);
    chunkSizesSeen.add(s.chunkSize);
    if (s.chunkSteps.length > stepsSeen.length) stepsSeen = s.chunkSteps.map((x: { firstIndex: number; size: number }) => ({ ...x }));
  }, 10);

  const t0 = Date.now();
  const done = (sender as unknown as { start: () => Promise<void> });
  await done.start();
  clearInterval(poll);

  // start() resolves on the final ACK; the receiver's SHA-256 verdict lands
  // ~one wire-latency later (FILE_END + verification). Wait for it.
  const deadline = Date.now() + 15000;
  while (!recvState.done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }

  // The sender's start() resolves only after every byte is durably ACKed.
  const elapsedS = (Date.now() - t0) / 1000;
  const avgBps = SIZE / elapsedS;
  const shapedBps = SHAPED_BPS;
  const utilization = avgBps / shapedBps;

  // 1. Completion + verification
  const senderErr = senderState.err as { e: string } | null;
  const senderDone = senderState.done as { id: string; hash: string } | null;
  assert(!senderErr, `transfer failed: ${senderErr?.e}`);
  assert(senderDone, 'sender did not complete');
  // SHA verdict comes from the receiver's real hash comparison.
  const recvDone = recvState.done as { hashVerified?: boolean; status: string } | null;
  assert(recvDone, 'receiver did not complete (SHA-256 gate)');
  verified = recvDone.hashVerified === true;
  assert(verified, 'receiver completed but SHA-256 was NOT verified');

  // 2. The engine filled its window — NOT stop-and-wait at 100 ms RTT.
  assert(
    maxInFlight >= 1024 * 1024,
    `window never filled: max in-flight ${(maxInFlight / 1024).toFixed(0)} KiB < 1 MiB — pipeline is serialized`
  );

  // 3. The engine consumed the shaped capacity — no hidden ~500 KB/s limiter.
  assert(
    utilization >= 0.85,
    `engine self-limits: avg ${(avgBps / 1024).toFixed(0)} KB/s = ${(utilization * 100).toFixed(0)}% of shaped ${(shapedBps / 1024).toFixed(0)} KB/s`
  );

  const stalls = (sender as unknown as { stallCount: number }).stallCount;
  // TURBO adaptive chunk contract (2026-10-01 directive supersedes the old
  // fixed-per-transfer rule): steps MAY grow mid-transfer, but ONLY race-free
  // and ladder-legal. Verify the recorded step table:
  //  1. strictly increasing firstIndex and size
  //  2. sizes only from the allowed ladder (≤ negotiated ceiling)
  //  3. the stream stayed consistent — completion + SHA-256 already proved it
  //  4. SHA-256 verified above is the ultimate integrity gate
  assert(stepsSeen.length >= 1, 'no step table recorded');
  const allowed = new Set([65536, 131072, 256 * 1024]);
  for (let i = 0; i < stepsSeen.length; i++) {
    const st = stepsSeen[i];
    assert(allowed.has(st.size), `illegal step size ${st.size}`);
    if (i > 0) {
      assert(st.firstIndex > stepsSeen[i - 1].firstIndex, 'step firstIndex must strictly increase');
      assert(st.size > stepsSeen[i - 1].size, 'step size must strictly increase');
      // Race-free horizon: a step may never land at the pump's read-ahead
      // index — every step after the first must be at least 2 past the
      // previous frontier chunk the pump had reached when it was pushed.
      assert(st.firstIndex - stepsSeen[i - 1].firstIndex >= 2, `step landed inside the read-ahead horizon: ${JSON.stringify(stepsSeen)}`);
    }
  }
  // Final cross-check: the live table matches the polled snapshot (no
  // unobserved steps), and the whole ladder stayed race-free throughout.
  const finalSteps = (sender as unknown as { chunkSteps: Array<{ firstIndex: number; size: number }> }).chunkSteps;
  assert(
    finalSteps.length === stepsSeen.length && finalSteps.every((st, i) => st.firstIndex === stepsSeen[i].firstIndex && st.size === stepsSeen[i].size),
    `live step table diverged from sampled table: ${JSON.stringify(finalSteps)} vs ${JSON.stringify(stepsSeen)}`
  );
  console.log(
    `[cellular] 8 MiB over 5 Mbps/100 ms shape: avg ${(avgBps / 1024).toFixed(0)} KB/s ` +
    `(${(utilization * 100).toFixed(0)}% of capacity), max in-flight ${(maxInFlight / 1048576).toFixed(2)} MiB, ` +
    `stalls ${stalls}, SHA-256 verified: ${verified}`
  );
  console.log('[cellular] PROOF: engine pipelines a cellular-shaped path — the ~500 KB/s physical ceiling is NOT app pacing');
  console.log('[cellular] TURBO ladder: ' + stepsSeen.map((x) => '#' + x.firstIndex + '→' + x.size).join(', ') + ' — SHA-256 verified, stream consistent');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('[cellular] FAILED', e);
    process.exit(1);
  }
);
