/**
 * TURBO v2 WINDOW CONTROLLER (2026-10-01) — collapse root-cause regression.
 * -------------------------------------------------------------------------
 * Physical 341 MB evidence: 1.60 MB/s ramp, then collapse to ~295 KB/s with
 * the receiver still consuming ~500 KB/s. Root cause: single-sample
 * writeMs/queueDepth signals and ACK-starvation stalls shrank the byte
 * window to its 512 KiB floor, and recovery (full clean drain + 1.5 s
 * cooldown) almost never fires on a jittery cellular path — the window
 * pinned at the floor and throughput settled BELOW the receiver's rate.
 *
 * These checks pin the v2 controller behavior:
 *   1. ACK-starvation stalls HOLD the window (shrinking can only push
 *      throughput below the ACK-permitted operating point).
 *   2. SCTP buffer stalls still shrink (genuine congestion).
 *   3. writeMs > 40 ms must SUSTAIN (3 consecutive ACKs) before shrinking,
 *      and then gently (x0.9).
 *   4. queueDepth > 4 must sustain (2 consecutive ACKs) before shrinking.
 *   5. Below the window high-water, recovery needs only a HALF drain.
 *   6. A window pinned at the floor probes upward after 3 s without
 *      pressure — one early stall cannot freeze a 10 GB transfer.
 *   7. The 10 Hz timeline is bounded and decimates instead of growing.
 */
import assert from 'node:assert';
import { SenderEngine } from '../lib/transfer/sender';
import { TransferTimeline, collapseCurve } from '../lib/transfer/timeline';
import { INITIAL_WINDOW_BYTES, MAX_WINDOW_BYTES, MIN_WINDOW_BYTES } from '../types/transfer';

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`[controller] FAILED: ${label}`);
    process.exit(1);
  }
  passed++;
}

// ---- minimal fake channel/file (no network, pure controller driving) ----
class FakeChannel {
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 1 << 20;
  readyState = 'open';
  send(): boolean { return true; }
  addEventListener(): void {}
  removeEventListener(): void {}
}

function makeSender(): SenderEngine {
  const file = new File([new Uint8Array(1024 * 1024).fill(0xa5)], 'ctrl.bin', {
    type: 'application/octet-stream',
  });
  return new SenderEngine({
    transferId: 't-ctrl',
    file,
    fileChannel: new FakeChannel() as unknown as RTCDataChannel,
    maxMessageSize: 262144,
    sendControlMessage: () => true,
    onProgress: () => {},
    onCompleted: () => {},
    onError: () => {},
  });
}

function win(sender: SenderEngine): number {
  return (sender as unknown as { windowBytes: number }).windowBytes;
}
function internals(sender: SenderEngine): any {
  return sender as unknown as Record<string, any>;
}

// ---- 1. ACK-starvation stall HOLDS the window ----------------------------
{
  const s = makeSender();
  const i = internals(s);
  i.windowBytes = 8 * 1024 * 1024;
  i.windowHighWater = 8 * 1024 * 1024;
  const before = win(s);
  s.handleAck(0);
  i.noteStall('starvation');
  ok(win(s) === before, 'starvation stall holds the window (v2 fix)');
  ok(i.stallCount === 1, 'starvation stall is still recorded for diagnostics');
}

// ---- 2. SCTP buffer stall still shrinks ----------------------------------
{
  const s = makeSender();
  const i = internals(s);
  i.windowBytes = 8 * 1024 * 1024;
  s.handleAck(0);
  i.noteStall('buffer');
  ok(win(s) === Math.floor(8 * 1024 * 1024 * 0.7), 'buffer stall multiplies down (x0.7)');
  ok(win(s) >= MIN_WINDOW_BYTES, 'window never drops below the floor');
}

// ---- 3. writeMs shrink needs a 3-ACK streak, and is gentle ---------------
{
  const s = makeSender();
  const i = internals(s);
  i.windowBytes = 8 * 1024 * 1024;
  i.windowHighWater = 8 * 1024 * 1024;
  const before = win(s);
  s.handleAck(0, 60, 0); // strike 1
  ok(win(s) === before, 'one slow-write ACK does not shrink (v2 fix)');
  s.handleAck(1, 60, 0); // strike 2
  ok(win(s) === before, 'two slow-write ACKs do not shrink (v2 fix)');
  s.handleAck(2, 60, 0); // strike 3 → sustained
  ok(win(s) === Math.floor(before * 0.9), 'third consecutive slow-write ACK shrinks gently (x0.9)');
  // A clean sample resets the streak.
  const after = win(s);
  s.handleAck(3, 10, 0);
  s.handleAck(4, 10, 0);
  s.handleAck(5, 60, 0); // single strike after clean samples: no shrink
  ok(win(s) === after, 'clean sample resets the slow-write streak');
}

// ---- 4. queueDepth shrink needs a 2-ACK streak ---------------------------
{
  const s = makeSender();
  const i = internals(s);
  i.windowBytes = 8 * 1024 * 1024;
  i.windowHighWater = 8 * 1024 * 1024;
  const before = win(s);
  s.handleAck(0, 5, 6); // strike 1
  ok(win(s) === before, 'one deep-queue ACK does not shrink (v2 fix)');
  s.handleAck(1, 5, 6); // strike 2 → sustained
  ok(win(s) === Math.floor(before * 0.85), 'second consecutive deep-queue ACK shrinks (x0.85)');
}

// ---- 5. recovery below the high-water needs only a HALF drain ------------
{
  const s = makeSender();
  const i = internals(s);
  i.windowBytes = 1 * 1024 * 1024;
  s.handleAck(0, 5, 0); // establish ACK timing
  // Grow once to 1.5 MiB (full drain, no cooldown issue: no stall yet).
  i.bytesAcked += 1 * 1024 * 1024;
  s.handleAck(1, 5, 0);
  ok(win(s) === Math.ceil(1 * 1024 * 1024 * 1.5), 'full clean drain grows x1.5');
  ok(internals(s).windowHighWater === Math.ceil(1 * 1024 * 1024 * 1.5), 'high-water follows growth');
  // A buffer stall knocks it down; cooldown passes (fake elapsed time).
  i.noteStall('buffer');
  ok(win(s) === Math.floor(1.5 * 1024 * 1024 * 0.7), 'stall shrinks below high-water');
  i.lastStallAt -= 2000; // cooldown elapsed
  // HALF drain while below high-water is enough to start recovering.
  i.bytesAcked += Math.ceil(win(s) / 2) - 1;
  s.handleAck(2, 5, 0);
  const postStall = Math.floor(1.5 * 1024 * 1024 * 0.7);
  ok(win(s) > postStall, 'half drain below high-water recovers (x1.5 growth)');
}

// ---- 6. floor probe: a pinned floor does not stay pinned -----------------
{
  const s = makeSender();
  const i = internals(s);
  i.windowBytes = MIN_WINDOW_BYTES;
  i.windowHighWater = 4 * 1024 * 1024;
  i.lastPressureAt = Date.now() - 4000; // calm for > 3 s
  i.lastStallAt = Date.now() - 2000; // cooldown elapsed
  s.handleAck(0, 5, 0);
  ok(
    win(s) === Math.min(MAX_WINDOW_BYTES, Math.ceil(MIN_WINDOW_BYTES * 1.25)),
    'pinned floor probes upward after 3 s of calm (x1.25)',
  );
}

// ---- 7. timeline bounded + decimating -------------------------------------
{
  const tl = new TransferTimeline(['t', 'x'], 100);
  for (let k = 0; k < 250; k++) tl.push([k * 100, k]);
  ok(tl.length <= 100, 'timeline never exceeds its capacity');
  ok(tl.currentIntervalMs >= 200, 'decimation doubled the sample interval');
  const json = tl.toJSON();
  ok(json.fields.length === 2 && json.rows.length === tl.length, 'toJSON consistent');
  ok(json.rows[0][0] === 0, 'oldest sample survives decimation (early ramp retained)');

  const curve = collapseCurve({ fields: ['t','bps','rtt','w','b','i'], rows: [[0,1,2,3,4,5],[100,6,7,8,9,10],[200,11,12,13,14,15]], intervalMs: 100 }, { t: 0, bps: 1, rtt: 2, window: 3, buffered: 4, inFlight: 5 }, 2);
  ok(curve.length === 3 && curve[0].tSec === 0 && curve[curve.length - 1].tSec === 0.2, 'collapseCurve keeps first and last');
  ok(curve[0].bps === 1 && curve[curve.length - 1].bps === 11, 'collapseCurve maps fields by index');
}

// ---- 8. fast start preserved ----------------------------------------------
{
  const s = makeSender();
  ok(win(s) === INITIAL_WINDOW_BYTES, 'fast start: initial window unchanged (1 MiB)');
}

console.log(`[controller] ${passed} checks passed`);
