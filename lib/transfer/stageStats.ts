/**
 * TURBO v2.4 — per-stage pump profiling (2026-10-01 directive, Phase 1).
 *
 * One StageStats per sender-pipeline stage (slice, hash, encode, send,
 * buffer-wait, ACK-wait) and the receiver's write stage. Every sample is a
 * REAL measured duration — nothing is synthesized, smoothed into existence,
 * or converted between peak/average. Records:
 *   duration samples (ring buffer, percentiles), EWMA, total, max, bytes.
 *
 * Percentiles are computed over the most recent samples (bounded ring),
 * giving an honest tail (p50/p95/p99/max) of the LIVE distribution, not the
 * lifetime distribution of a decaying EWMA.
 */

export interface StageSummary {
  count: number;
  /** EWMA of stage duration (ms) — fast-moving operating point. */
  ewmaMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Total wall time spent in this stage (ms) — for share-of-wall math. */
  totalMs: number;
  /** Bytes processed by the stage where applicable (0 = not byte-carrying). */
  bytes: number;
}

const RING = 2048;

export class StageStats {
  private ring = new Float64Array(RING);
  private n = 0;
  private next = 0;
  private ewmaMs = 0;
  private totalMs = 0;
  private maxMs = 0;
  private bytes = 0;

  record(ms: number, bytes = 0): void {
    if (ms < 0) ms = 0;
    this.ring[this.next] = ms;
    this.next = (this.next + 1) % RING;
    if (this.n < RING) this.n++;
    this.ewmaMs = this.ewmaMs > 0 ? this.ewmaMs * 0.85 + ms * 0.15 : ms;
    this.totalMs += ms;
    if (ms > this.maxMs) this.maxMs = ms;
    this.bytes += bytes;
  }

  summary(): StageSummary {
    const take = Math.min(this.n, RING);
    if (take === 0) {
      return { count: 0, ewmaMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, totalMs: 0, bytes: 0 };
    }
    // Ordered copy of the live window (RING is small; this runs only on
    // telemetry reads, never in the hot path).
    const view = new Float64Array(take);
    const start = (this.next - take + RING) % RING;
    for (let i = 0; i < take; i++) view[i] = this.ring[(start + i) % RING];
    view.sort();
    const at = (q: number): number => view[Math.min(take - 1, Math.floor(q * take))];
    return {
      count: this.n,
      ewmaMs: Math.round(this.ewmaMs * 100) / 100,
      p50Ms: Math.round(at(0.5) * 100) / 100,
      p95Ms: Math.round(at(0.95) * 100) / 100,
      p99Ms: Math.round(at(0.99) * 100) / 100,
      maxMs: Math.round(this.maxMs * 100) / 100,
      totalMs: this.totalMs,
      bytes: this.bytes,
    };
  }

  get totalMsLive(): number {
    return this.totalMs;
  }
  get bytesLive(): number {
    return this.bytes;
  }
}
