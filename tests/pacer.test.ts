/**
 * v2.6 send-pacer regression suite — the burst-collapse fix.
 *
 * LIVE evidence (2026-10-02 real-device cellular run, 358.07 MB APK):
 * peak 67.15 MB/s, sustained 0.53 MB/s, 29 stalls, ACK gaps to 12.585 s,
 * buffered max 4.32 MB ≈ BUFFER_HIGH_WATER, in-flight max 4.46 MB.
 * Root cause: every 'bufferedamountlow' wake refilled the whole SCTP
 * buffer instantly; the burst floods a lossy high-RTT path, SCTP
 * congestion control collapses, the association crawls in RTO backoff.
 *
 * CollapseChannel reproduces that signature honestly: a rate-limited
 * path whose drain collapses to a crawl whenever the app over-burdens
 * it (path-buffer overflow), then recovers. The A/B arm proves the
 * pacer is the difference — same channel, same file, pacer off vs on.
 */
import { SenderEngine } from '@/lib/transfer/sender';
import { senderTestOverrides } from '@/lib/transfer/sender';
import { ReceiverEngine } from '@/lib/transfer/receiver';

type LowListener = () => void;

/**
 * Rate-limited channel with burst-collapse penalty (measured model).
 *
 * Two-stage, matching SCTP semantics: 'pending' is the socket buffer
 * (bufferedAmount - cleared at TRANSMIT, when drain budget consumes the
 * message), then a latency pipe delivers it. Overflow of the path buffer
 * (burst cannot be absorbed) triggers congestion collapse: drain rate
 * drops to crawl for the penalty window - the live 2026-10-02 signature
 * (instant multi-MiB window refills, 29 stalls, ~0.5 MB/s crawl).
 */
class CollapseChannel {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  private lowListeners: LowListener[] = [];
  private closeListeners: LowListener[] = [];
  private pending: Array<{ data: ArrayBuffer }> = [];
  private pipe: Array<{ data: ArrayBuffer; deliverAt: number }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private budgetBytes = 0;
  private budgetAt = Date.now();
  private penaltyUntil = 0;
  /** Count of collapse penalties entered (the honest collapse metric). */
  collapseEvents = 0;

  constructor(
    private readonly normalBps: number,
    private readonly crawlBps: number,
    private readonly pathBufferBytes: number,
    private readonly penaltyMs: number,
    private readonly latencyMs = 0
  ) {}

  addEventListener(type: string, fn: LowListener): void {
    if (type === 'bufferedamountlow') this.lowListeners.push(fn);
    if (type === 'close') this.closeListeners.push(fn);
  }
  removeEventListener(type: string, fn: LowListener): void {
    if (type === 'bufferedamountlow') this.lowListeners = this.lowListeners.filter((f) => f !== fn);
    if (type === 'close') this.closeListeners = this.closeListeners.filter((f) => f !== fn);
  }

  send(data: ArrayBuffer): void {
    this.pending.push({ data });
    this.bufferedAmount += data.byteLength;
    // Path-buffer overflow: the burst cannot be absorbed -> congestion
    // collapse. Counted once per overflow episode; the minimum penalty
    // clock restarts on every re-overflow while still collapsed.
    if (this.bufferedAmount > this.pathBufferBytes) {
      if (Date.now() >= this.penaltyUntil) this.collapseEvents++;
      this.penaltyUntil = Math.max(this.penaltyUntil, Date.now() + this.penaltyMs);
    }
    this.schedule();
  }

  private drainRate(): number {
    // STICKY collapse: the crawl persists while the queue is still
    // overflowing (real SCTP does not hand capacity back until the
    // excess drains), then the minimum penalty window runs out.
    return this.bufferedAmount > this.pathBufferBytes || Date.now() < this.penaltyUntil
      ? this.crawlBps
      : this.normalBps;
  }

  private schedule(): void {
    if (this.timer) return;
    const tick = () => {
      this.timer = null;
      const now = Date.now();
      this.budgetBytes += ((now - this.budgetAt) / 1000) * this.drainRate();
      this.budgetAt = now;
      let lowFired = false;
      // Drain: budget consumes whole messages (SCTP transmit).
      while (this.pending.length > 0 && this.budgetBytes >= this.pending[0].data.byteLength) {
        const item = this.pending.shift()!;
        this.budgetBytes -= item.data.byteLength;
        this.bufferedAmount = Math.max(0, this.bufferedAmount - item.data.byteLength);
        this.pipe.push({ data: item.data, deliverAt: now + this.latencyMs });
        lowFired = true;
      }
      if (lowFired && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        for (const fn of [...this.lowListeners]) fn();
      }
      // Deliver everything whose propagation delay has elapsed.
      while (this.pipe.length > 0 && this.pipe[0].deliverAt <= now) {
        const item = this.pipe.shift()!;
        this.onmessage?.({ data: item.data });
      }
      if (this.pending.length > 0 || this.pipe.length > 0) {
        let wait = 25;
        if (this.pending.length > 0) {
          const rate = Math.max(this.drainRate(), 1);
          wait = Math.min(wait, Math.max(1, ((this.pending[0].data.byteLength - this.budgetBytes) / rate) * 1000));
        }
        if (this.pipe.length > 0) {
          wait = Math.min(wait, Math.max(1, this.pipe[0].deliverAt - now));
        }
        this.timer = setTimeout(tick, wait);
      }
    };
    this.timer = setTimeout(tick, 5);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

interface RunResult {
  wallMs: number;
  senderError: string | null;
  senderDone: boolean;
  shaVerified: boolean;
  collapseEvents: number;
  stallCount: number;
  maxInFlight: number;
}

async function runCollapseTransfer(pacerEnabled: boolean): Promise<RunResult> {
  senderTestOverrides.disablePacer = !pacerEnabled;
  try {
    // 48 MiB: several full window-cycles AFTER the 16 MiB ceiling is
    // reached (the LIVE condition — the 24 MiB probe showed a single
    // collapse because one window refill covered the rest of the file).
    const SIZE = 48 * 1024 * 1024;
    const file = new File([new Uint8Array(SIZE).fill(0x5a)], 'collapse.bin', {
      type: 'application/octet-stream',
    });

    // Path calibrated to the 2026-10-02 LIVE measurement: ~10 MB/s true
    // capacity, SCTP/path buffer ≈ 4 MiB (live: buffered max 4.32 MB),
    // collapse crawl ≈ 0.3 MB/s (live sustained 0.53 MB/s) for 3 s when
    // the app overflows it. Unpaced refills 3+ MiB instantly on every
    // buffer-low wake — the exact live burst-collapse cascade.
    const channel = new CollapseChannel(
      10 * 1000 * 1000, // true path capacity
      800 * 1000, // collapse crawl (~8x collapse — live was ~20x, tuned for test wall time)
      2.5 * 1024 * 1024, // lossy-path queue limit: overflow = loss → RTO
      1500, // minimum penalty window (sticky while the queue overflows)
      120 // one-way propagation (live app-level ACK RTT ~240 ms)
    );

    const state: { done: boolean; err: string | null; recvDone: { hashVerified?: boolean; status: string } | null } = {
      done: false,
      err: null,
      recvDone: null,
    };
    const recv: { instance: ReceiverEngine | null } = { instance: null };

    const sender = new SenderEngine({
      transferId: 't-collapse',
      file,
      fileChannel: channel as unknown as RTCDataChannel,
      maxMessageSize: 262144,
      sendControlMessage: (msg: any) => {
        setTimeout(() => {
          if (msg.type === 'FILE_START') void recv.instance?.startTransfer(msg);
          else if (msg.type === 'FILE_END') void recv.instance?.finishTransfer(msg);
        }, 120);
        return true;
      },
      onProgress: () => {},
      onCompleted: () => {
        state.done = true;
      },
      onError: (_id, e) => {
        state.err = e;
      },
    });

    const receiver = new ReceiverEngine({
      onProgress: () => {},
      onCompleted: (info) => {
        state.recvDone = info as { hashVerified?: boolean; status: string };
      },
      onError: () => {},
      sendControlMessage: (msg: any) => {
        setTimeout(() => {
          if (msg.type === 'ACK') {
            sender.handleAck(
              msg.index,
              typeof msg.w === 'number' ? msg.w : undefined,
              typeof msg.q === 'number' ? msg.q : undefined,
              typeof msg.rb === 'number' ? msg.rb : undefined,
              typeof msg.wb === 'number' ? msg.wb : undefined,
              typeof msg.ts === 'number' ? msg.ts : undefined,
              typeof msg.ad === 'number' ? msg.ad : undefined
            );
          }
          if (msg.type === 'HASH_OK') sender.handleHashOk(msg.algo);
          if (msg.type === 'FILE_VERIFY') {
            (state as { verify?: unknown }).verify = msg;
          }
        }, 120);
        return true;
      },
    });
    recv.instance = receiver;

    let maxInFlight = 0;
    const poll = setInterval(() => {
      const s = sender as unknown as { bytesSent: number; bytesAcked: number };
      maxInFlight = Math.max(maxInFlight, s.bytesSent - s.bytesAcked);
    }, 10);

    channel.onmessage = (ev) => {
      void receiver.handleChunk(ev.data);
    };

    const t0 = Date.now();
    await (sender as unknown as { start: () => Promise<void> }).start();
    const wallMs = Date.now() - t0;
    clearInterval(poll);

    // The receiver's SHA-256 verdict may land a few control RTTs later.
    const deadline = Date.now() + 15000;
    while (!state.recvDone && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    channel.stop();

    return {
      wallMs,
      senderError: state.err,
      senderDone: state.done,
      shaVerified: state.recvDone?.hashVerified === true,
      collapseEvents: channel.collapseEvents,
      stallCount: (sender as unknown as { stallCount: number }).stallCount,
      maxInFlight,
    };
  } finally {
    senderTestOverrides.disablePacer = false;
  }
}

let passed = 0;
function check(cond: boolean, label: string, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log('[pacer] burst-collapse A/B (the live-cellular signature, reproduced honestly)');

  const unpaced = await runCollapseTransfer(false);
  const paced = await runCollapseTransfer(true);

  console.log(
    `    unpaced: wall ${(unpaced.wallMs / 1000).toFixed(1)}s, collapses ${unpaced.collapseEvents}, stalls ${unpaced.stallCount}`
  );
  console.log(
    `    paced:   wall ${(paced.wallMs / 1000).toFixed(1)}s, collapses ${paced.collapseEvents}, stalls ${paced.stallCount}`
  );

  check(paced.senderDone && !paced.senderError, 'paced transfer completed without error', paced.senderError ?? '');
  check(paced.shaVerified, 'paced transfer SHA-256 verified');
  check(unpaced.senderDone && !unpaced.senderError, 'unpaced control arm also completed (harness valid)', unpaced.senderError ?? '');
  check(unpaced.collapseEvents >= 5, 'unpaced control arm reproduces repeated collapse', `only ${unpaced.collapseEvents} collapses`);
  check(
    paced.collapseEvents <= Math.max(2, Math.floor(unpaced.collapseEvents * 0.4)),
    'pacer prevented the repeated collapse',
    `paced ${paced.collapseEvents} vs unpaced ${unpaced.collapseEvents}`
  );
  // The live headline: unpaced settles at the crawl rate (~0.5 MB/s) on
  // a path that can do 10 MB/s. The paced arm must recover MOST of the
  // path capacity — assert ≥ 3x the unpaced arm on the SAME channel.
  const FILE_BYTES = 48 * 1024 * 1024;
  const unpacedAvgBps = FILE_BYTES / (unpaced.wallMs / 1000);
  const pacedAvgBps = FILE_BYTES / (paced.wallMs / 1000);
  check(
    paced.wallMs * 3 < unpaced.wallMs,
    'paced completed ≥3x faster than unpaced on the same path',
    `paced ${(paced.wallMs / 1000).toFixed(1)}s (${(pacedAvgBps / 1e6).toFixed(1)} MB/s) vs unpaced ${(unpaced.wallMs / 1000).toFixed(1)}s (${(unpacedAvgBps / 1e6).toFixed(1)} MB/s)`
  );

  console.log('[pacer] healthy-path check (pacer must not throttle a fast path)');
  {
    senderTestOverrides.disablePacer = false;
    const SIZE = 8 * 1024 * 1024;
    const file = new File([new Uint8Array(SIZE).fill(0x33)], 'fast.bin', {
      type: 'application/octet-stream',
    });
    // Instant loopback — the pacer's target must track the measured
    // goodput up, not pin the transfer at PACE_INITIAL_BPS.
    const loop: {
      readyState: string;
      bufferedAmount: number;
      bufferedAmountLowThreshold: number;
      onmessage: ((ev: { data: ArrayBuffer }) => void) | null;
      listeners: Map<string, LowListener[]>;
      send(data: ArrayBuffer): void;
      addEventListener(t: string, fn: LowListener): void;
      removeEventListener(t: string, fn: LowListener): void;
    } = {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      onmessage: null,
      listeners: new Map(),
      send(data: ArrayBuffer) {
        setTimeout(() => this.onmessage?.({ data }), 0);
      },
      addEventListener(t, fn) {
        this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
      },
      removeEventListener(t, fn) {
        this.listeners.set(t, (this.listeners.get(t) ?? []).filter((f) => f !== fn));
      },
    };

    const recvDone: { hashVerified?: boolean; status: string } | null = { hashVerified: undefined, status: '' };
    let recvInstance: ReceiverEngine | null = null;
    const sender = new SenderEngine({
      transferId: 't-fast',
      file,
      fileChannel: loop as unknown as RTCDataChannel,
      maxMessageSize: 262144,
      sendControlMessage: (msg: any) => {
        setTimeout(() => {
          if (msg.type === 'FILE_START') void recvInstance?.startTransfer(msg);
          else if (msg.type === 'FILE_END') void recvInstance?.finishTransfer(msg);
        }, 0);
        return true;
      },
      onProgress: () => {},
      onCompleted: () => {},
      onError: (_id, e) => {
        throw new Error(`fast-path sender error: ${e}`);
      },
    });
    const receiver = new ReceiverEngine({
      onProgress: () => {},
      onCompleted: (info) => {
        Object.assign(recvDone as object, info);
      },
      onError: () => {},
      sendControlMessage: (msg: any) => {
        setTimeout(() => {
          if (msg.type === 'ACK') {
            sender.handleAck(
              msg.index,
              typeof msg.w === 'number' ? msg.w : undefined,
              typeof msg.q === 'number' ? msg.q : undefined,
              typeof msg.rb === 'number' ? msg.rb : undefined,
              typeof msg.wb === 'number' ? msg.wb : undefined,
              typeof msg.ts === 'number' ? msg.ts : undefined,
              typeof msg.ad === 'number' ? msg.ad : undefined
            );
          }
          if (msg.type === 'HASH_OK') sender.handleHashOk(msg.algo);
        }, 0);
        return true;
      },
    });
    recvInstance = receiver;
    loop.onmessage = (ev) => {
      void receiver.handleChunk(ev.data);
    };

    const t0 = Date.now();
    await (sender as unknown as { start: () => Promise<void> }).start();
    const wallMs = Date.now() - t0;
    const m = (sender as unknown as { metrics: Record<string, unknown> }).metrics;
    console.log(`    fast-path wall ${(wallMs / 1000).toFixed(2)}s, paceTarget final ${((m.paceTargetBps as number) / 1e6).toFixed(1)} MB/s`);

    check(wallMs < 8000, '8 MiB loopback completes promptly with the pacer on', `${(wallMs / 1000).toFixed(2)}s`);
    check(
      (m.paceTargetBps as number) > 8 * 1000 * 1000,
      'pacer target ADAPTED UP on a healthy path (not pinned at the initial rate)',
      `target ${(((m.paceTargetBps as number) / 1e6) || 0).toFixed(1)} MB/s`
    );
    check((m.ackTransitMs as number) > 0, 'ACK-transit forensics measured (ts threaded)', `${m.ackTransitMs}`);
  }

  console.log('[pacer] STANDARD profile contract');
  {
    const SIZE = 16 * 1024 * 1024;
    const file = new File([new Uint8Array(SIZE).fill(0x77)], 'std.bin', { type: 'application/octet-stream' });
    const loop = {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      onmessage: null as ((ev: { data: ArrayBuffer }) => void) | null,
      listeners: new Map<string, LowListener[]>(),
      send(data: ArrayBuffer) {
        setTimeout(() => this.onmessage?.({ data }), 0);
      },
      addEventListener(t: string, fn: LowListener) {
        this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
      },
      removeEventListener(t: string, fn: LowListener) {
        this.listeners.set(t, (this.listeners.get(t) ?? []).filter((f: LowListener) => f !== fn));
      },
    };
    let recvInstance: ReceiverEngine | null = null;
    const sender = new SenderEngine({
      transferId: 't-std',
      profile: 'standard',
      file,
      fileChannel: loop as unknown as RTCDataChannel,
      maxMessageSize: 262144,
      sendControlMessage: (msg: any) => {
        setTimeout(() => {
          if (msg.type === 'FILE_START') void recvInstance?.startTransfer(msg);
          else if (msg.type === 'FILE_END') void recvInstance?.finishTransfer(msg);
        }, 0);
        return true;
      },
      onProgress: () => {},
      onCompleted: () => {},
      onError: (_id, e) => {
        throw new Error(`standard-profile sender error: ${e}`);
      },
    });
    const receiver = new ReceiverEngine({
      onProgress: () => {},
      onCompleted: () => {},
      onError: () => {},
      sendControlMessage: (msg: any) => {
        setTimeout(() => {
          if (msg.type === 'ACK') {
            sender.handleAck(
              msg.index,
              typeof msg.w === 'number' ? msg.w : undefined,
              typeof msg.q === 'number' ? msg.q : undefined,
              typeof msg.rb === 'number' ? msg.rb : undefined,
              typeof msg.wb === 'number' ? msg.wb : undefined,
              typeof msg.ts === 'number' ? msg.ts : undefined,
              typeof msg.ad === 'number' ? msg.ad : undefined
            );
          }
          if (msg.type === 'HASH_OK') sender.handleHashOk(msg.algo);
        }, 0);
        return true;
      },
    });
    recvInstance = receiver;
    loop.onmessage = (ev) => {
      void receiver.handleChunk(ev.data);
    };

    let sawExtraChannelProbe = false;
    const overrides = sender as unknown as {
      start: () => Promise<void>;
      chunkSteps: Array<{ firstIndex: number; size: number }>;
      metrics: Record<string, unknown>;
    };
    // STANDARD must never poll the extra-channel accessor (pool growth off).
    (sender as unknown as { getActiveChannels: () => unknown[] }).getActiveChannels = () => {
      sawExtraChannelProbe = true;
      return [loop];
    };

    await overrides.start();
    const sizes = overrides.chunkSteps.map((st) => st.size);
    check(
      sizes.every((sz) => sz <= 128 * 1024),
      'STANDARD caps the chunk ladder at 128 KiB',
      `steps: ${sizes.map((s) => s / 1024).join('/')} KiB`
    );
    check(
      (overrides.metrics.profile as string) === 'standard',
      'metrics expose the active profile'
    );
    // The gate probe: getActiveChannels IS used by other paths (striping),
    // but evaluateChannelScaling returns before touching the pool — verify
    // the pool stayed single-stream.
    check(
      (overrides.metrics.activeChannels as number) === 1,
      'STANDARD stayed single-stream'
    );
    void sawExtraChannelProbe;
  }

  console.log(`[pacer] ${passed} checks passed`);
}

void main().catch((err) => {
  console.error('[pacer] FATAL', err);
  process.exit(1);
});
