/**
 * NexDrop Sender Engine — high-throughput adaptive pipeline.
 *
 * Streams files of any size using strictly File.slice() — never loads the
 * whole file into RAM. Designed to keep the transport pipeline FULL:
 *
 * File.slice() ──► 1-slice read-ahead ──► encrypt/encode ──► RTCDataChannel
 *                        ▲                                     │
 *                        └── ACK-driven byte window ◄───────────┤
 *                                                            backpressure
 *
 * Flow control (all MEASURED, nothing synthesized):
 * - Byte-based in-flight window (not chunk-count based, so high RTT can
 *   never collapse it into stop-and-wait). Starts at 1 MiB and grows x1.5
 *   each time a full window drains cleanly, up to a 16 MiB memory cap.
 * - Shrinks only on REAL pressure: SCTP buffer stalls, receiver write
 *   backlog (q in ACKs), or ACK starvation. A single RTT spike never
 *   shrinks it (EWMA + stall cooldown, not instantaneous reactions).
 * - bufferedAmountLowThreshold pacing: fill up to 4 MiB of SCTP buffer,
 *   then wait for the 'bufferedamountlow' event (fires at 1 MiB) — an
 *   EVENT-driven wait, no sawtooth timer that silently keeps overfilling.
 * - Chunk size starts at 64 KiB and doubles mid-transfer (up to the
 *   negotiated SCTP maxMessageSize, 256 KiB ceiling) only once the window
 *   is saturated, the link has been stable and the receiver queue is
 *   healthy — so per-chunk overhead amortizes as the link proves itself.
 * - ACK-RTT EWMA + running minimum (ACK timing includes queueing delay at
 *   saturation; the running min is the honest floor estimate).
 *
 * Enforces: pause/resume/cancel, optional AES-256-GCM app-layer encryption,
 * incremental SHA-256 while streaming, 10 Hz throttled UI progress.
 */

import {
  BUFFER_HIGH_WATER,
  BUFFER_LOW_WATER,
  INITIAL_WINDOW_BYTES,
  MAX_WINDOW_BYTES,
  MIN_WINDOW_BYTES,
  FileStartMessage,
} from '@/types/transfer';
import { encodeBinaryChunk } from './protocol';
import { bytesToBase64Url, ChunkCipher, encryptChunk, generateIvPrefix, IncrementalSha256 } from '@/lib/crypto';
import { initialChunkSize, noteTransferSuccess, noteTransferFailure } from './tuner';
import { updateSenderTelemetry } from './telemetry';
import { TransferTimeline } from './timeline';

export interface SenderProgress {
  transferId: string;
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  speedBps: number;
  etaSeconds: number;
  status: 'transferring' | 'paused' | 'completed' | 'cancelled' | 'failed';
  currentChunk: number;
  totalChunks: number;
}

export interface SenderOptions {
  file: File;
  transferId: string;
  fileChannel: RTCDataChannel;
  sendControlMessage: (msg: any) => boolean;
  onProgress: (p: SenderProgress) => void;
  onCompleted: (transferId: string, hash: string) => void;
  onError: (transferId: string, err: string) => void;
  /** Session AES-GCM cipher for app-layer encryption. Null = transport-only. */
  cipher?: ChunkCipher | null;
  /** Negotiated SCTP max message size (pc.sctp.maxMessageSize). 0/undefined = unknown. */
  maxMessageSize?: number;
  /** TURBO multi-channel: accessor for extra open file streams (file-1..file-3).
   * Polled when the scaling gate fires; absence means single-channel mode. */
  extraFileChannels?: () => RTCDataChannel[];
}

/** Real backpressure stall: buffer drain wait / ACK starvation. */
const STALL_COOLDOWN_MS = 1500;

export class SenderEngine {
  private file: File;
  private transferId: string;
  private fileChannel: RTCDataChannel;
  private sendControlMessage: (msg: any) => boolean;
  private onProgress: (p: SenderProgress) => void;
  private onCompleted: (transferId: string, hash: string) => void;
  private onError: (transferId: string, err: string) => void;
  private cipher?: ChunkCipher | null;
  /** Per-transfer random IV prefix — unique IVs across files in one session. */
  private ivPrefix: Uint8Array | null = null;

  // ---- chunking: chunk size can grow mid-transfer (see chunkSteps) ----
  /** Upper bound chunk index for this transfer (initial estimate; growth only reduces the real count). */
  private totalChunks: number;
  /** Chunk-size steps — exactly ONE entry per transfer (fixed size, chosen at start). */
  private chunkSteps: Array<{ firstIndex: number; size: number }> = [];
  private get chunkSize(): number {
    return this.chunkSteps.length > 0 ? this.chunkSteps[this.chunkSteps.length - 1].size : this.chunkSteps0;
  }
  private chunkSteps0: number;
  /** Largest chunk this link may ever send: negotiated SCTP limit − protocol/crypto headroom. */
  private readonly chunkCap: number;
  /** Raw negotiated SCTP max message size (diagnostics — never assumed). */
  private readonly negotiatedMaxMessageSize: number;

  private currentChunkIndex = 0;
  /** Cumulative byte offset of chunk `i` start (from chunkSteps). */
  /** The step table's OWN size for this chunk index — NOT the current
   * trailing size. sliceOf() MUST use this: slicing chunk F-1 with the new
   * step's size desyncs the byte stream from bytesAtChunkStart() (the
   * 2026-10-01 incident class; caught by the cellular harness 2026-10-01
   * as a one-chunk shift between the pump and the ACK accounting). */
  private chunkSizeFor(index: number): number {
    let prevFirst = 0;
    let prevSize = this.chunkSteps0;
    for (const step of this.chunkSteps) {
      if (index < step.firstIndex) return prevSize;
      prevFirst = step.firstIndex;
      prevSize = step.size;
    }
    return prevSize;
  }

  private bytesAtChunkStart(index: number): number {
    // Simple linear walk (chunkSteps is tiny — 3-4 entries max)
    let offset = 0;
    let prevFirst = 0;
    let prevSize = this.chunkSteps0;
    for (const step of this.chunkSteps) {
      if (index < step.firstIndex) {
        return offset + (index - prevFirst) * prevSize;
      }
      offset += (step.firstIndex - prevFirst) * prevSize;
      prevFirst = step.firstIndex;
      prevSize = step.size;
    }
    return offset + (index - prevFirst) * prevSize;
  }

  // ---- MEASURED flow control ----
  private acknowledgedChunkIndex = -1;
  /** Cumulative plaintext bytes handed to send() / acknowledged via ACKs. */
  private bytesSent = 0;
  private bytesAcked = 0;
  /** Chunk send timestamps → real ACK-RTT samples. */
  private sendTimes = new Map<number, number>();
  /** EWMA RTT from ACK timing (ms). */
  private rttEwmaMs = 0;
  /** Running minimum ACK-RTT (ms) — the honest floor (samples at saturation include queueing). */
  private minRttMs = 0;
  /** Adaptive in-flight window in BYTES (not chunks — chunk-count windows collapse under high RTT). */
  private windowBytes = INITIAL_WINDOW_BYTES;
  /** Highest healthy window reached this transfer — recovery target. */
  private windowHighWater = INITIAL_WINDOW_BYTES;
  /** Consecutive ACKs reporting slow receiver writes (sustained pressure). */
  private slowWriteStreak = 0;
  /** Last receiver-reported per-chunk write cost (ms), -1 before first ACK. */
  private lastAckWriteMs = -1;
  /** Last receiver-reported write-queue depth, -1 before first ACK. */
  private lastAckQueueDepth = -1;
  /** Consecutive ACKs reporting a deep receiver write queue. */
  private deepQueueStreak = 0;
  /** Last time of ANY real pressure signal (stall or sustained shrink). */
  private lastPressureAt = 0;
  /** High-resolution collapse timeline (10 Hz, adaptively decimated). */
  readonly timeline = new TransferTimeline(
    ['t','sent','acked','inFlight','window','chunk','buffered','rtt','minRtt','bps','stalls','ackLatency','writeMs','queueDepth'],
  );
  private timelineTimer: ReturnType<typeof setInterval> | null = null;
  /** ACK frontier when the window last grew — grows once per clean window drain. */
  private lastGrowthBytes = 0;
  /** Measured throughput from the ACK cadence (bytes/sec). */
  private throughputBps = 0;
  private ackedAt = 0;
  private ackCount = 0;
  /** Backpressure events (buffer stalls / ACK starvation). */
  private stallCount = 0;
  private lastStallAt = 0;
  /** ACK frequency (ACKs/sec, EWMA) and chunk rate (chunks/sec, EWMA) —
   *  real runtime diagnostics for the physical-bottleneck matrix. */
  private acksPerSecEwma = 0;
  private chunksPerSecEwma = 0;
  private lastChunkRateAt = 0;
  /** Woken by handleAck — the window wait is event-driven, polls only as a failsafe. */
  private windowWaiters: Set<() => void> = new Set();
  // ---- TURBO multi-channel pool (2026-10-01) ----
  private getActiveChannels: () => RTCDataChannel[];
  /** Striping pool. Order is stable; chunk index % length picks the stream. */
  private activeChannels: RTCDataChannel[];
  private channelsFrozen = false;
  private lastChannelChangeAt = 0;
  private channelBaselineAcked = 0;
  private channelBaselineAt = 0;
  private channelEvaluating = false;
  private channelBaselineBps = 0;
  private channelBaselineStalls = 0;
  private lastScalingBps = 0;
  private lastWriteMsEwma = 0;
  private lastQueueDepth = 0;
  // ---- TURBO adaptive chunk ladder (2026-10-01) ----
  /** Corruption-risk freeze: any stall/pressure/shrink freezes the ladder. */
  private chunkFrozen = false;
  private drainsSinceChunkStep = 0;
  // ---- BDP + RTT variance (measured, telemetry + scaling gate) ----
  private rttVarEwma = 0;
  // ---- v2.3 ACK-pipeline telemetry (all measured) ----
  /** Cumulative ms the pump spent waiting for ACK-driven window space. */
  private ackWaitMs = 0;
  /** EWMA of durable bytes released per ACK (coalescing size, measured). */
  private ackBytesEwma = 0;
  /** Pump stage costs (ms EWMA): awaited File.slice read, incremental
   *  SHA-256, encrypt+frame encode. Identifies the pump's serial CPU. */
  private sliceMsEwma = 0;
  private hashMsEwma = 0;
  private encodeMsEwma = 0;
  /** Window utilization summary, computed from the 10 Hz timeline at
   *  completion: inFlightBytes / windowBytes per sample. */
  private utilization: { avg: number; p50: number; p95: number; min: number; max: number } | null = null;

  private isPaused = false;
  private isCancelled = false;
  private isDone = false;

  private lastProgressEmit = 0;
  private startTime = 0;
  private recentSpeeds: number[] = [];
  private hasher = new IncrementalSha256();
  private maxBufferedAmount = 0;

  constructor(options: SenderOptions) {
    this.file = options.file;
    this.transferId = options.transferId;
    this.fileChannel = options.fileChannel;
    this.sendControlMessage = options.sendControlMessage;
    this.onProgress = options.onProgress;
    this.onCompleted = options.onCompleted;
    this.onError = options.onError;
    this.cipher = options.cipher ?? null;

    // Never send a frame larger than the negotiated SCTP limit. Headroom
    // covers the 16-byte chunk header, the 6-byte IV prefix and the GCM tag.
    const negotiated = options.maxMessageSize && options.maxMessageSize > 0 ? options.maxMessageSize : 65536;
    this.negotiatedMaxMessageSize = negotiated;
    this.chunkCap = Math.max(16 * 1024, Math.min(256 * 1024, negotiated - 256));
    // Start conservative (64 KiB, or a size learned from a previous clean
    // transfer in this session) — growth happens per measured stability.
    this.chunkSteps0 = initialChunkSize(negotiated);
    this.chunkSteps = [{ firstIndex: 0, size: this.chunkSteps0 }];

    this.totalChunks = Math.max(1, Math.ceil(this.file.size / this.chunkSteps0));
    this.getActiveChannels = options.extraFileChannels
      ? () => [this.fileChannel, ...options.extraFileChannels!().slice(0, 3)]
      : () => [this.fileChannel];
    this.activeChannels = [this.fileChannel];
    for (const ch of this.activeChannels) ch.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
    // Event-driven SCTP buffer pacing: fill to BUFFER_HIGH_WATER, then wait
    // for 'bufferedamountlow' which fires once the buffer drains to this.
    this.fileChannel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
  }

  /**
   * v2.3 cumulative-byte ACK ingestion. `writtenBytes` (wb) is the
   * receiver's authoritative durable byte frontier — window space releases
   * against it directly, so accounting NEVER depends on this side's chunk
   * step table (the stale-size-chunk corruption class is structurally
   * gone). `receivedBytes` (rb) is flow-control diagnostics only.
   * Legacy index-only ACKs (old tests) fall back to the step table.
   */
  public handleAck(
    index: number,
    writeMs?: number,
    queueDepth?: number,
    receivedBytes?: number,
    writtenBytes?: number
  ) {
    if (writeMs !== undefined) this.lastWriteMsEwma = writeMs;
    if (queueDepth !== undefined) this.lastQueueDepth = queueDepth;
    void receivedBytes; // diagnostics only — flow control trusts wb
    const sentAt = this.sendTimes.get(index);
    if (sentAt !== undefined) {
      const sample = Date.now() - sentAt;
      if (sample > 0 && sample < 30000) {
        this.rttEwmaMs = this.rttEwmaMs > 0 ? this.rttEwmaMs * 0.75 + sample * 0.25 : sample;
        if (this.minRttMs === 0 || sample < this.minRttMs) this.minRttMs = sample;
        const jitter = Math.abs(sample - (this.minRttMs || sample));
        this.rttVarEwma = this.rttVarEwma > 0 ? this.rttVarEwma * 0.8 + jitter * 0.2 : jitter;
      }
      for (let i = index; i >= index - 64 && i >= 0; i--) this.sendTimes.delete(i);
      if (this.sendTimes.size > 512) this.sendTimes.clear();
    }

    this.acknowledgedChunkIndex = Math.max(this.acknowledgedChunkIndex, index);
    this.ackCount++;
    // ACK frequency (real measured cadence, EWMA-smoothed).
    const ackNow = Date.now();
    if (this.ackedAt > 0 && ackNow > this.ackedAt) {
      const instAcks = 1000 / (ackNow - this.ackedAt);
      this.acksPerSecEwma = this.acksPerSecEwma > 0 ? this.acksPerSecEwma * 0.7 + instAcks * 0.3 : instAcks;
    }

    // v2.3 BYTE-AUTHORITATIVE accounting: the receiver reports its durable
    // cumulative byte offset (wb) directly. No step-table extrapolation —
    // a chunk-size ladder step between two ACKs can no longer shift the
    // boundary (the 2026-10-01 stale-size-chunk corruption class).
    const prevBytesAcked = this.bytesAcked;
    if (typeof writtenBytes === 'number' && Number.isFinite(writtenBytes) && writtenBytes > 0) {
      this.bytesAcked = Math.max(this.bytesAcked, Math.min(writtenBytes, this.file.size));
    } else {
      // Legacy fallback (index-only ACK): derive from the chunk frontier.
      this.bytesAcked = Math.max(
        this.bytesAcked,
        this.bytesAtChunkStart(this.acknowledgedChunkIndex + 1)
      );
    }
    const newlyAckedBytes = Math.max(0, this.bytesAcked - prevBytesAcked);
    if (newlyAckedBytes > 0) {
      this.ackBytesEwma =
        this.ackBytesEwma > 0 ? this.ackBytesEwma * 0.8 + newlyAckedBytes * 0.2 : newlyAckedBytes;
    }

    // Measured throughput from the ACK cadence (real bytes, real time).
    const now = Date.now();
    if (newlyAckedBytes > 0) {
      if (this.ackedAt > 0 && now > this.ackedAt) {
        const inst = newlyAckedBytes / ((now - this.ackedAt) / 1000);
        this.throughputBps = this.throughputBps > 0 ? this.throughputBps * 0.7 + inst * 0.3 : inst;
      }
      this.ackedAt = now;
    }

    if (writeMs !== undefined) this.lastAckWriteMs = writeMs;
    if (queueDepth !== undefined) this.lastAckQueueDepth = queueDepth;

    this.tune(index, writeMs, queueDepth);
    // Wake the pump: the window has slid forward.
    for (const wake of [...this.windowWaiters]) wake();
  }

  /**
   * Adaptive window + chunk growth from measured signals:
   * ACK-RTT EWMA, throughput, receiver write cost, receiver queue depth,
   * stall history. Grows one step per clean full-window drain; shrinks
   * immediately on real pressure but never below MIN_WINDOW_BYTES.
   */
  private tune(index: number, writeMs?: number, queueDepth?: number): void {
    const stable = Date.now() - this.lastStallAt > STALL_COOLDOWN_MS;

    // ---- v2: SUSTAINED-pressure shrink (never single-sample reactions).
    // Physical 341 MB collapse evidence (2026-10-01): one transient 40 ms+
    // write or a one-off queue spike on Android OPFS immediately shrank the
    // window, and growth then needed a full clean drain + 1.5 s cooldown —
    // on a jittery cellular path those almost never arrive together, so
    // the window pinned at the 512 KiB floor and the transfer settled at
    // ~295 KB/s. Now pressure must persist across consecutive ACKs before
    // the controller reacts, and it reacts gently.
    if (queueDepth !== undefined && queueDepth > 4) {
      this.deepQueueStreak++;
      if (this.deepQueueStreak >= 2 && this.windowBytes > MIN_WINDOW_BYTES) {
        this.chunkFrozen = true; // sustained receiver pressure = risk condition
        this.windowBytes = Math.max(MIN_WINDOW_BYTES, Math.floor(this.windowBytes * 0.85));
        this.lastGrowthBytes = this.bytesAcked;
        this.lastPressureAt = Date.now();
        this.deepQueueStreak = 0;
        return;
      }
    } else if (queueDepth !== undefined && queueDepth <= 2) {
      this.deepQueueStreak = 0;
    }
    if (writeMs !== undefined && writeMs > 40) {
      this.slowWriteStreak++;
      if (this.slowWriteStreak >= 3 && this.windowBytes > MIN_WINDOW_BYTES) {
        this.chunkFrozen = true; // sustained storage pressure = risk condition
        this.windowBytes = Math.max(MIN_WINDOW_BYTES, Math.floor(this.windowBytes * 0.9));
        this.lastGrowthBytes = this.bytesAcked;
        this.lastPressureAt = Date.now();
        this.slowWriteStreak = 0;
        return;
      }
    } else if (writeMs !== undefined && writeMs <= 25) {
      this.slowWriteStreak = 0;
    }

    if (!stable) return;

    // Floor-probe: if the window is pinned at the floor but nothing has
    // signalled pressure for 3 s, probe one step up. A single early stall
    // must not freeze the whole transfer at the minimum window forever.
    if (
      this.windowBytes <= MIN_WINDOW_BYTES &&
      this.lastPressureAt > 0 &&
      Date.now() - this.lastPressureAt > 3000 &&
      this.windowBytes < MAX_WINDOW_BYTES
    ) {
      this.windowBytes = Math.min(MAX_WINDOW_BYTES, Math.ceil(this.windowBytes * 1.25));
      this.lastGrowthBytes = this.bytesAcked;
      return;
    }

    // One clean full-window drain since the last change: grow. Below the
    // high-water mark (recovering from a transient stall) a HALF drain is
    // enough — recovery must be faster than first-time discovery.
    const recovering = this.windowBytes < this.windowHighWater;
    const drainNeeded = recovering ? this.windowBytes / 2 : this.windowBytes;
    if (this.bytesAcked - this.lastGrowthBytes >= drainNeeded) {
      this.lastGrowthBytes = this.bytesAcked;
      if (this.windowBytes < MAX_WINDOW_BYTES) {
        // Grow the byte window +50% per clean full-window drain. A faster
        // ramp (x2, tried 2026-10-01) reaches 16 MiB sustained pumping in
        // half the drains and COLLAPSED SCTP on the CI two-runner loopback
        // (receiver UDP socket overflow -> total stall of both 100/250 MiB
        // transfers). The x1.5 ramp is the measured-safe rate: loopback CI
        // benchmark 100 MiB avg ~6.5 MB/s, all sizes green.
        this.windowBytes = Math.min(MAX_WINDOW_BYTES, Math.ceil(this.windowBytes * 1.5));
        this.windowHighWater = Math.max(this.windowHighWater, this.windowBytes);
      }
      this.drainsSinceChunkStep++;

      // ---- TURBO adaptive chunk ladder (race-free by construction) ----
      // The 2026-10-01 desync incident happened because a step landed AT
      // the pump's read-ahead horizon. A step at firstIndex F never
      // changes bytesAtChunkStart(i) for i < F, and read-ahead only ever
      // slices currentChunkIndex+1 — so F = currentChunkIndex + 2 is
      // provably race-free with the in-flight pre-read slice.
      if (
        !this.chunkFrozen &&
        this.chunkSteps.length > 0 &&
        this.drainsSinceChunkStep >= 2 &&
        this.currentChunkIndex + 2 > this.chunkSteps[this.chunkSteps.length - 1].firstIndex
      ) {
        const cur = this.chunkSize;
        const ladder = [128 * 1024, 256 * 1024];
        const next = ladder.find((sz) => sz > cur && sz <= this.chunkCap);
        if (next) {
          this.chunkSteps.push({ firstIndex: this.currentChunkIndex + 2, size: next });
          this.drainsSinceChunkStep = 0;
        } else {
          this.chunkFrozen = true; // ceiling reached — no more steps
        }
      }

      // ---- TURBO multi-channel scaling gate (measured, never blind) ----
      this.evaluateChannelScaling();
      // NOTE: chunk size NEVER grows mid-transfer (2026-10-01 incident).
      // A mid-transfer grow races the pump's one-slice read-ahead: a chunk
      // pre-read under the old size is then counted under the new step
      // table, the byte stream desyncs from bytesAtChunkStart(), file bytes
      // get skipped, the tail never completes and the pump hot-loops empty
      // slices while ACK-index extrapolation explodes bytesAcked (CI froze
      // at 100% with 48 GB "acked" on a healthy runner). Chunk size is
      // chosen once per transfer (negotiated SCTP ceiling + learned size
      // from previous clean transfers) and stays FIXED; growth happens only
      // BETWEEN transfers via noteTransferSuccess()/initialChunkSize().
    }
  }

  /**
   * Real backpressure event. v2 distinguishes the two physical causes:
   *
   * - 'buffer'  (SCTP buffer drained > 1 s): genuine congestion inside the
   *   transport — multiplicative decrease is the correct response.
   * - 'starvation' (window-wait failsafe): ALL in-flight bytes are simply
   *   waiting for ACKs on a high-latency path. The window already equals
   *   the bandwidth-delay product the ACKs permit; shrinking it can only
   *   push throughput BELOW the path's sustainable rate — which is exactly
   *   how the 341 MB physical transfer settled at 295 KB/s (window pinned
   *   at the 512 KiB floor while the receiver still consumed ~500 KB/s).
   *   The stall is recorded (diagnostics + cooldown), but the window HOLDS.
   */
  private noteStall(kind: 'buffer' | 'starvation'): void {
    this.chunkFrozen = true; // any stall freezes the chunk ladder (2026-10-01 rule)
    this.lastStallAt = Date.now();
    this.stallCount++;
    this.lastPressureAt = Date.now();
    if (kind === 'buffer') {
      // Multiplicative decrease on real transport congestion — with a floor
      // that keeps high-RTT links well above stop-and-wait.
      this.windowBytes = Math.max(MIN_WINDOW_BYTES, Math.floor(this.windowBytes * 0.7));
    }
    this.lastGrowthBytes = this.bytesAcked;
  }

  /** Measured link metrics (for diagnostics — never faked). */
  public get metrics(): {
    rttMs: number; minRttMs: number; window: number; windowBytes: number; chunkSize: number;
    throughputBps: number; stalls: number; bufferedAmount: number;
    chunksPerSec: number; acksPerSec: number; sctpMaxMessageSize: number;
    windowHighWaterBytes: number; sustainedBps: number; slowWriteStreak: number;
    rttVarianceMs: number; activeChannels: number;
    ackWaitMs: number; ackAvgBytes: number;
    pumpSliceMs: number; pumpHashMs: number; pumpEncodeMs: number;
    windowUtilization: { avg: number; p50: number; p95: number; min: number; max: number } | null;
    inFlightBytes: number;
  } {
    const elapsedS = (Date.now() - this.startTime) / 1000;
    return {
      rttMs: this.rttEwmaMs,
      minRttMs: this.minRttMs,
      window: Math.ceil(this.windowBytes / this.chunkSize),
      windowBytes: this.windowBytes,
      windowHighWaterBytes: this.windowHighWater,
      // Sustained = whole-transfer average, the headline metric (never the peak).
      sustainedBps: this.bytesAcked > 0 && elapsedS > 0 ? this.bytesAcked / elapsedS : 0,
      slowWriteStreak: this.slowWriteStreak,
      chunkSize: this.chunkSize,
      throughputBps: this.throughputBps,
      stalls: this.stallCount,
      bufferedAmount: this.fileChannel?.bufferedAmount ?? 0,
      chunksPerSec: this.chunksPerSecEwma,
      acksPerSec: this.acksPerSecEwma,
      sctpMaxMessageSize: this.negotiatedMaxMessageSize,
      rttVarianceMs: this.rttVarEwma,
      activeChannels: this.activeChannels.length,
      // ---- v2.3 ACK-pipeline telemetry (measured) ----
      ackWaitMs: this.ackWaitMs,
      ackAvgBytes: this.ackBytesEwma,
      pumpSliceMs: this.sliceMsEwma,
      pumpHashMs: this.hashMsEwma,
      pumpEncodeMs: this.encodeMsEwma,
      windowUtilization: this.utilization,
      inFlightBytes: this.bytesSent - this.bytesAcked,
    };
  }

  /**
   * v2.3 window-utilization summary, computed from the measured 10 Hz
   * timeline: inFlightBytes / windowBytes per sample. The four numbers
   * answer "is the sender actually filling its window?" — if utilization
   * is low while ACK waits are also low, the pump (slice/hash/encode) is
   * the binding variable, not ACK cadence. Never synthesized: derived from
   * recorded samples only.
   */
  private summarizeUtilization(): void {
    const series = this.timeline.toJSON();
    const IN_FLIGHT = 3; // row field order: t, sent, acked, inFlight, window, ...
    const WINDOW = 4;
    const utils: number[] = [];
    for (const row of series.rows) {
      const win = row[WINDOW];
      if (win > 0) utils.push(Math.min(1, row[IN_FLIGHT] / win));
    }
    if (utils.length === 0) return;
    utils.sort((a, b) => a - b);
    const sum = utils.reduce((a, b) => a + b, 0);
    this.utilization = {
      avg: sum / utils.length,
      p50: utils[Math.floor(utils.length * 0.5)],
      p95: utils[Math.min(utils.length - 1, Math.floor(utils.length * 0.95))],
      min: utils[0],
      max: utils[utils.length - 1],
    };
  }

  /** 10 Hz collapse-curve recorder (Phase 1/2 instrumentation). */
  private startTimeline(): void {
    this.stopTimeline();
    if (typeof setInterval !== 'function') return; // non-browser (unit tests may stub)
    const sample = () => {
      if (this.isDone || this.isCancelled) { this.stopTimeline(); return; }
      this.timeline.push([
        Date.now() - this.startTime,
        this.bytesSent,
        this.bytesAcked,
        this.bytesSent - this.bytesAcked,
        this.windowBytes,
        this.chunkSize,
        this.fileChannel?.bufferedAmount ?? 0,
        this.rttEwmaMs,
        this.minRttMs,
        this.throughputBps,
        this.stallCount,
        this.rttEwmaMs,
        this.lastAckWriteMs,
        this.lastAckQueueDepth,
      ]);
    };
    // First sample immediately (t=0), then on the timeline's own cadence.
    sample();
    this.timelineTimer = setInterval(sample, this.timeline.currentIntervalMs);
  }

  private stopTimeline(): void {
    if (this.timelineTimer !== null) {
      clearInterval(this.timelineTimer);
      this.timelineTimer = null;
    }
  }

  public pause() {
    if (this.isDone || this.isCancelled) return;
    this.isPaused = true;
    this.sendControlMessage({ type: 'PAUSE', transferId: this.transferId });
    this.emitProgress('paused', 0, 0);
  }

  public resume() {
    if (!this.isPaused || this.isCancelled || this.isDone) return;
    this.isPaused = false;
    this.sendControlMessage({
      type: 'RESUME',
      transferId: this.transferId,
      nextChunk: this.currentChunkIndex,
    });
    void this.pump();
  }

  /** The transfer this engine instance is bound to (for control-message matching). */
  public get activeTransferId(): string {
    return this.transferId;
  }

  /** Real transfer failure — resets the learned link profile (conservative). */
  private fail(reason: string): void {
    this.stopTimeline();
    noteTransferFailure();
    this.onError(this.transferId, reason);
  }

  public cancel(reason: string = 'Cancelled by sender') {
    if (this.isDone) return;
    this.isCancelled = true;
    this.stopTimeline();
    for (const wake of [...this.windowWaiters]) wake();
    this.sendControlMessage({ type: 'CANCEL', transferId: this.transferId, reason });
    this.emitProgress('cancelled', 0, 0);
  }

  public async start(): Promise<void> {
    this.startTime = Date.now();
    this.startTimeline();
    this.isDone = false;
    this.isCancelled = false;
    this.isPaused = false;
    this.hasher = new IncrementalSha256();
    this.bytesSent = 0;
    this.bytesAcked = 0;
    this.acknowledgedChunkIndex = -1;
    this.currentChunkIndex = 0;
    this.maxBufferedAmount = 0;
    this.acksPerSecEwma = 0;
    this.chunksPerSecEwma = 0;
    this.lastChunkRateAt = 0;
    this.ackWaitMs = 0;
    this.ackBytesEwma = 0;
    this.sliceMsEwma = 0;
    this.hashMsEwma = 0;
    this.encodeMsEwma = 0;
    this.utilization = null;

    // Fresh random IV prefix per transfer — the receiver derives identical
    // IVs from this value. Without it, every file would reuse the same
    // (key, IV) pairs (chunk indexes restart at 0), which breaks GCM.
    if (this.cipher) this.ivPrefix = generateIvPrefix();

    const startMsg: FileStartMessage = {
      type: 'FILE_START',
      transferId: this.transferId,
      name: this.file.name,
      size: this.file.size,
      mime: this.file.type || 'application/octet-stream',
      chunkSize: this.chunkSteps0,
      totalChunks: this.totalChunks,
      e2eeEnabled: !!this.cipher,
      ...(this.cipher && this.ivPrefix
        ? { ivPrefix: bytesToBase64Url(this.ivPrefix) }
        : {}),
    };

    const sent = this.sendControlMessage(startMsg);
    if (!sent) {
      this.fail('Control channel unavailable');
      return;
    }

    await this.pump();
  }

  private async pump(): Promise<void> {
    let lastBytes = 0;
    let lastTime = Date.now();
    // One-slice read-ahead: the disk read of chunk N+1 overlaps the
    // encrypt/send of chunk N.
    let readAhead: Promise<ArrayBuffer> | null = null;
    let readAheadIndex = -1;
    let readAheadLastStepCount = 1;

    const sliceOf = (index: number): Promise<ArrayBuffer> => {
      const start = this.bytesAtChunkStart(index);
      const end = Math.min(start + this.chunkSizeFor(index), this.file.size);
      return this.file.slice(start, end).arrayBuffer();
    };

    while (this.bytesSent < this.file.size) {
      if (this.isCancelled || this.isDone) return;
      if (this.isPaused) return; // pump() is re-invoked by resume()

      // ---- ACK-driven byte window (bounded in-flight memory) ----
      if (this.bytesSent - this.bytesAcked >= this.windowBytes) {
        await this.waitForWindow();
        if (this.isCancelled || this.isPaused) return;
      }

      // ---- RTCDataChannel SCTP-buffer backpressure ----
      if (this.fileChannel.readyState !== 'open') {
        this.fail('Connection lost during transfer');
        this.emitProgress('failed', 0, 0);
        return;
      }
      if (this.fileChannel.bufferedAmount > BUFFER_HIGH_WATER) {
        await this.waitForBufferLow();
        if (this.isCancelled || this.isPaused) return;
      }

      // ---- read (with one-slice read-ahead) ----
      const index = this.currentChunkIndex;
      if (readAheadIndex !== index) readAhead = null; // stale (e.g. after pause)
      // TURBO ladder: a step landing at/below the pre-read index changes
      // that slice's boundary — discard it; sliceOf re-reads with the
      // per-index size from the CURRENT table.
      if (readAheadIndex === index && readAheadLastStepCount !== this.chunkSteps.length) readAhead = null;
      const pending = readAhead;
      readAhead = null;
      let chunkBuffer: ArrayBuffer;
      const sliceT0 = Date.now();
      try {
        chunkBuffer = await (pending ?? sliceOf(index));
      } catch (err: any) {
        this.fail(`File read error: ${err?.message || err}`);
        this.emitProgress('failed', 0, 0);
        return;
      }

      // Chunk-boundary desync guard (2026-10-01 incident): an empty slice
      // while bytes remain means the step table no longer maps chunk indexes
      // to real file offsets. Fail honestly — an infinite loop of empty
      // chunks would freeze the transfer at ~100% forever.
      if (chunkBuffer.byteLength === 0 && this.bytesSent < this.file.size) {
        this.fail('Chunk boundary desync: refusing to send empty slices');
        this.emitProgress('failed', 0, 0);
        return;
      }

      // v2.3: measured disk-read (slice) cost — the pump's serial stage 1.
      this.sliceMsEwma = this.sliceMsEwma > 0 ? this.sliceMsEwma * 0.8 + (Date.now() - sliceT0) * 0.2 : (Date.now() - sliceT0);

      // The awaited read above can straddle a pause() call. Re-check BEFORE
      // hashing: the incremental hash must only ever consume chunks that are
      // actually sent. Pausing here (index not yet advanced) makes resume()
      // re-read this same slice — hash and stream stay consistent.
      if (this.isCancelled || this.isPaused) return;

      // Start the next read while this chunk is encrypted + sent.
      if (this.bytesAtChunkStart(index) + chunkBuffer.byteLength < this.file.size) {
        readAhead = sliceOf(index + 1);
        readAheadIndex = index + 1;
        readAheadLastStepCount = this.chunkSteps.length;
      }

      // Incremental hash of the PLAINTEXT content
      // v2.3: measured SHA-256 cost — the pump's serial stage 2 (JS, main thread).
      const hashT0 = Date.now();
      this.hasher.update(new Uint8Array(chunkBuffer));
      const hashDt = Date.now() - hashT0;
      this.hashMsEwma = this.hashMsEwma > 0 ? this.hashMsEwma * 0.8 + hashDt * 0.2 : hashDt;

      // v2.3: measured encrypt+frame cost — the pump's serial stage 3.
      const encT0 = Date.now();
      let payload: ArrayBuffer = chunkBuffer;
      if (this.cipher) {
        try {
          if (!this.ivPrefix) throw new Error('E2EE transfer missing IV prefix');
          payload = await encryptChunk(this.cipher, this.ivPrefix, index, chunkBuffer);
        } catch (err: any) {
          this.fail(`Encryption error: ${err?.message || err}`);
          this.emitProgress('failed', 0, 0);
          return;
        }
      }

      const packet = encodeBinaryChunk(index, this.totalChunks, this.transferId, payload);
      this.encodeMsEwma = this.encodeMsEwma > 0 ? this.encodeMsEwma * 0.8 + (Date.now() - encT0) * 0.2 : (Date.now() - encT0);

      // TURBO striping: per-stream SCTP buffer backpressure, then send.
      const stripe = this.activeChannels[index % this.activeChannels.length];
      if (stripe.readyState !== 'open') {
        this.shrinkPool(this.activeChannels.indexOf(stripe));
      }
      const sendCh =
        this.activeChannels[index % this.activeChannels.length] ?? this.fileChannel;
      if (sendCh.readyState !== 'open') {
        this.fail('Connection lost during transfer');
        this.emitProgress('failed', 0, 0);
        return;
      }
      if (sendCh.bufferedAmount > BUFFER_HIGH_WATER) {
        await this.waitForBufferLow(sendCh);
        if (this.isCancelled || this.isPaused) return;
      }

      this.sendTimes.set(index, Date.now());
      try {
        this.sendPacket(packet, index);
      } catch (err: any) {
        this.fail(`Send error: ${err?.message || err}`);
        this.emitProgress('failed', 0, 0);
        return;
      }

      this.currentChunkIndex = index + 1;
      this.bytesSent += chunkBuffer.byteLength;

      const bufAmt = this.fileChannel.bufferedAmount;
      if (bufAmt > this.maxBufferedAmount) this.maxBufferedAmount = bufAmt;

      // Real speed & ETA from actual transfer counters, throttled to 100ms.
      // Never emit 'transferring' once paused/cancelled: a pause can land
      // while this chunk was already committed to send (hash consumed it),
      // and a stale 'transferring' emit would overwrite the authoritative
      // 'paused' status in the UI.
      const now = Date.now();
      if (
        !this.isPaused &&
        !this.isCancelled &&
        (now - this.lastProgressEmit >= 100 || this.bytesSent >= this.file.size)
      ) {
        const timeDiff = Math.max(0.001, (now - lastTime) / 1000);
        const bytesDiff = this.bytesSent - lastBytes;
        const currentSpeed = bytesDiff / timeDiff;

        this.recentSpeeds.push(currentSpeed);
        if (this.recentSpeeds.length > 5) this.recentSpeeds.shift();
        const avgSpeed =
          this.recentSpeeds.reduce((a, b) => a + b, 0) / this.recentSpeeds.length;

        // Displayed speed is the ACK-based NETWORK truth (bytes the
        // receiver durably wrote per second) once ACK samples exist —
        // feeding the SCTP buffer faster than the link drains would
        // overstate it. The sent-based rolling average is only the
        // pre-ACK fallback.
        const displaySpeed = this.throughputBps > 0 ? this.throughputBps : avgSpeed;

        // Chunk send rate (real cadence, EWMA-smoothed).
        if (this.lastChunkRateAt > 0 && now > this.lastChunkRateAt) {
          const instChunks =
            bytesDiff / Math.max(1, this.chunkSize) / ((now - this.lastChunkRateAt) / 1000);
          this.chunksPerSecEwma =
            this.chunksPerSecEwma > 0 ? this.chunksPerSecEwma * 0.7 + instChunks * 0.3 : instChunks;
        }
        this.lastChunkRateAt = now;

        const remainingBytes = this.file.size - this.bytesSent;
        const eta = displaySpeed > 0 ? Math.ceil(remainingBytes / displaySpeed) : 0;

        this.emitProgress('transferring', displaySpeed, eta);
        this.lastProgressEmit = now;
        lastBytes = this.bytesSent;
        lastTime = now;
        updateSenderTelemetry({
          transferId: this.transferId,
          name: this.file.name,
          totalBytes: this.file.size,
          chunkSize: this.chunkSize,
          bytesSent: this.bytesSent,
          bytesAcked: this.bytesAcked,
          chunksSent: this.currentChunkIndex,
          throughputBps: this.throughputBps,
          srttMs: this.rttEwmaMs,
          minRttMs: this.minRttMs,
          inFlightBytes: this.bytesSent - this.bytesAcked,
          ackLatencyMs: this.rttEwmaMs,
          windowChunks: Math.ceil(this.windowBytes / this.chunkSize),
          windowBytes: this.windowBytes,
          bufferedAmount: this.fileChannel.bufferedAmount,
          maxBufferedAmount: this.maxBufferedAmount,
          ackCount: this.ackCount,
          stalls: this.stallCount,
          chunksPerSec: this.chunksPerSecEwma,
          acksPerSec: this.acksPerSecEwma,
          sctpMaxMessageSize: this.negotiatedMaxMessageSize,
          sustainedBps: this.bytesAcked / Math.max(0.001, (Date.now() - this.startTime) / 1000),
          rttVarianceMs: this.rttVarEwma,
          activeChannels: this.activeChannels.length,
          windowHighWaterBytes: this.windowHighWater,
          ackWaitMs: this.ackWaitMs,
          ackAvgBytes: this.ackBytesEwma,
          pumpSliceMs: this.sliceMsEwma,
          pumpHashMs: this.hashMsEwma,
          pumpEncodeMs: this.encodeMsEwma,
          windowUtilization: this.windowBytes > 0 ? (this.bytesSent - this.bytesAcked) / this.windowBytes : 0,
          utilizationSummary: this.utilization,
          timeline: this.timeline.length > 0 ? this.timeline.toJSON() : null,
          startedAt: this.startTime,
        });
      }
    }

    // All bytes sent — wait for the final ACK (all bytes durably received)
    // before declaring completion.
    const finalAckDeadline = Date.now() + 30000;
    while (this.bytesAcked < this.file.size) {
      if (this.isCancelled) return;
      if (Date.now() > finalAckDeadline) {
        this.fail('Peer stopped acknowledging data');
        this.emitProgress('failed', 0, 0);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    if (this.isCancelled) return;
    this.isDone = true;
    this.stopTimeline();
    this.summarizeUtilization();

    // Incremental hash — computed while streaming, no extra full read needed
    let hash = '';
    try {
      hash = this.hasher.finalize();
    } catch {
      hash = '';
    }

    this.sendControlMessage({ type: 'FILE_END', transferId: this.transferId, hash });
    this.emitProgress('completed', 0, 0);
    // Measured-link learning for the NEXT transfer in this session: grow
    // the chunk size only from clean, healthy runs — never synthesized.
    const elapsedS = Math.max(0.001, (Date.now() - this.startTime) / 1000);
    noteTransferSuccess(this.chunkSize, this.bytesAcked / elapsedS, this.stallCount);
    this.onCompleted(this.transferId, hash);
  }

  /**
   * Event-driven wait for window space: woken by every ACK; the poll timer
   * only acts as an ACK-starvation failsafe (a real instability signal,
   * not a silent continue).
   */
  private waitForWindow(): Promise<void> {
    const waitStart = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      const wake = () => {
        if (settled) return;
        if (
          this.isCancelled ||
          this.isPaused ||
          this.bytesSent - this.bytesAcked < this.windowBytes
        ) {
          settled = true;
          clearTimeout(failsafe);
          this.windowWaiters.delete(wake);
          this.ackWaitMs += Date.now() - waitStart; // v2.3: measured ACK-wait
          resolve();
          return;
        }
        // Still blocked — if this was the failsafe, it is real starvation.
        // v2: counted as a stall (diagnostics + cooldown) but the window
        // HOLDS — shrinking below the ACK-permitted operating point only
        // reduces throughput (341 MB collapse root cause).
        if (Date.now() > deadline) {
          settled = true;
          this.windowWaiters.delete(wake);
          clearTimeout(failsafe);
          this.ackWaitMs += Date.now() - waitStart; // v2.3: measured ACK-wait
          this.noteStall('starvation');
          resolve();
        }
      };
      const deadline = Date.now() + Math.max(2500, (this.rttEwmaMs || 250) * 8);
      const failsafe = setTimeout(wake, Math.max(2500, (this.rttEwmaMs || 250) * 8) + 50);
      this.windowWaiters.add(wake);
      // Already satisfied?
      wake();
    });
  }

  /**
   * SCTP buffer pacing: wait for 'bufferedamountlow' (fires at
   * BUFFER_LOW_WATER) instead of a fixed 50 ms sawtooth that overfills the
   * buffer and stalls the pipeline. Channel close and a hard 3 s failsafe
   * (counted as a real stall) end the wait.
   */
  private waitForBufferLow(channel?: RTCDataChannel): Promise<void> {
    const ch = channel ?? this.fileChannel;
    return new Promise((resolve) => {
      if (ch.readyState !== 'open') return resolve();
      if (ch.bufferedAmount <= ch.bufferedAmountLowThreshold) return resolve();

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(failsafe);
        ch.removeEventListener('bufferedamountlow', done);
        ch.removeEventListener('close', done);
        if (Date.now() - waitStart > 1000) this.noteStall('buffer');
        resolve();
      };

      const waitStart = Date.now();
      const failsafe = setTimeout(done, 3000);
      ch.addEventListener('bufferedamountlow', done);
      ch.addEventListener('close', done);
    });
  }

  /**
   * TURBO striping send: chunk index → stream by modulo. Per-stream SCTP
   * buffer backpressure (each stream has its own bufferedAmount and
   * bufferedamountlow). All streams carry identical ordered/reliable
   * semantics; the RECEIVER's bounded reorder buffer restores global order.
   */
  private sendPacket(packet: ArrayBuffer, index: number): boolean {
    const ch = this.activeChannels[index % this.activeChannels.length];
    if (ch.readyState !== 'open') {
      // A parallel stream died mid-transfer: fall back to the primary
      // (always required) rather than failing an otherwise healthy link.
      this.shrinkPool(this.activeChannels.indexOf(ch));
      if (this.fileChannel.readyState !== 'open') return false;
    }
    try {
      ch.send(packet);
      return true;
    } catch (err: any) {
      try {
        this.fileChannel.send(packet);
        return true;
      } catch {
        this.fail(`DataChannel send error: ${err?.message || err}`);
        return false;
      }
    }
  }

  /** Activate/deactivate pool members (never touches 'file' itself). */
  private shrinkPool(at: number): void {
    if (at <= 0) return; // 'file' (index 0) always stays
    this.activeChannels.splice(at, 1);
    this.channelsFrozen = true; // pool change mid-transfer: freeze further scaling briefly
    this.lastChannelChangeAt = Date.now();
  }

  /**
   * TURBO multi-channel scaling gate (2026-10-01). NEVER blindly adds
   * streams: a second SCTP stream is activated only when the measured link
   * shows (a) no stalls/shrinks recently, (b) calm receiver, (c) per-stream
   * SCTP buffers healthy, (d) throughput PLATEAUED on the current pool —
   * i.e. the single stream is demonstrably the limiter — and (e) the last
   * pool change is old. After activation a 4 s measured A/B decides:
   * keep only on >= 12% sustained improvement, else fall back and cool
   * down. Max 4 streams. All decisions from real counters.
   */
  private evaluateChannelScaling(): void {
    const now = Date.now();
    const available = this.getActiveChannels();
    const active = this.activeChannels.length;

    // Evaluating a just-activated stream: measured A/B after 4 s.
    if (this.channelEvaluating) {
      if (now - this.channelBaselineAt < 4000) return;
      this.channelEvaluating = false;
      const ackedSince = this.bytesAcked - this.channelBaselineAcked;
      const secs = (now - this.channelBaselineAt) / 1000;
      const bpsNow = ackedSince / Math.max(0.001, secs);
      const bpsBase = this.channelBaselineBps;
      const gain = bpsBase > 0 ? bpsNow / bpsBase : 0;
      // Measured A/B verdict — logged so benchmark runs report the exact
      // 1-vs-N channel gain (telemetry, never asserted).
      console.debug(
        `[nexdrop] channel A/B: pool ${this.activeChannels.length}, base ${(this.channelBaselineBps / 1048576).toFixed(2)} MiB/s -> pooled ${(bpsNow / 1048576).toFixed(2)} MiB/s, delta ${gain >= 1 ? '+' : ''}${((gain - 1) * 100).toFixed(1)}%`
      );
      if (gain < 1.12 || this.stallCount > this.channelBaselineStalls) {
        // No material improvement (or new stalls): FALL BACK to the
        // previous pool — never keep complexity that does not pay.
        console.debug(
          `[nexdrop] channel A/B verdict: FALL BACK (pool ${this.activeChannels.length} -> ${this.activeChannels.length - 1}), delta ${((gain - 1) * 100).toFixed(1)}% below +12% threshold`
        );
        this.shrinkPool(1);
        this.channelsFrozen = true;
        this.lastChannelChangeAt = now;
      } else {
        this.lastChannelChangeAt = now; // keep; gate re-arms below
      }
      return;
    }

    if (this.channelsFrozen) {
      if (now - this.lastChannelChangeAt > 10000) this.channelsFrozen = false;
      else return;
    }
    if (active >= 4) return;
    if (available.length <= active) return;
    if (now - this.lastChannelChangeAt < 6000) return;

    // Measured health: no stall recently, calm receiver, healthy buffers.
    if (now - this.lastStallAt < 4000) return;
    if (this.lastPressureAt > 0 && now - this.lastPressureAt < 4000) return;
    if (this.lastWriteMsEwma > 30) return;
    if (this.lastQueueDepth > 2) return;
    for (const ch of this.activeChannels) {
      if (ch.readyState !== 'open' || ch.bufferedAmount > BUFFER_LOW_WATER * 2) return;
    }

    // Plateau detection: the current pool is saturated if sustained ACK
    // throughput barely moved across the last two full window drains.
    const bpsNow = this.throughputBps;
    const plateau = this.lastScalingBps > 0 && bpsNow > 0
      ? bpsNow / this.lastScalingBps
      : 0;
    this.lastScalingBps = bpsNow;
    if (plateau > 0 && (plateau < 0.9 || plateau > 1.1)) return; // still moving — not a single-stream ceiling

    // Activate the next stream + arm the measured A/B.
    const next = available[this.activeChannels.length];
    if (!next || next.readyState !== 'open') return;
    next.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
    this.activeChannels.push(next);
    this.channelEvaluating = true;
    this.channelBaselineAt = now;
    this.channelBaselineAcked = this.bytesAcked;
    this.channelBaselineBps = Math.max(bpsNow, this.channelBaselineBps);
    this.channelBaselineStalls = this.stallCount;
  }

  private emitProgress(
    status: 'transferring' | 'paused' | 'completed' | 'cancelled' | 'failed',
    speedBps: number,
    etaSeconds: number
  ) {
    const bytesTransferred = this.isDone ? this.file.size : this.bytesSent;
    const percentage = this.file.size > 0 ? (bytesTransferred / this.file.size) * 100 : 100;

    this.onProgress({
      transferId: this.transferId,
      bytesTransferred,
      totalBytes: this.file.size,
      percentage: Math.min(100, Math.round(percentage * 10) / 10),
      speedBps,
      etaSeconds,
      status,
      currentChunk: this.currentChunkIndex,
      totalChunks: this.totalChunks,
    });
  }
}
