/**
 * Bounded high-resolution transfer timeline (2026-10-01, TURBO v2).
 *
 * Purpose: answer "WHY did throughput rise and then collapse?" from REAL
 * recorded samples, not inference. The sender and receiver each push a
 * compact sample every ~100 ms during a transfer; the Device Test report
 * and diagnostics export the curve so the FIRST-changing variable at the
 * collapse moment is visible.
 *
 * Memory is strictly bounded: a ring of at most MAX_SAMPLES numeric
 * tuples. When full, every other sample is dropped and the recording
 * interval doubles (adaptive decimation) — a 2.5 GB transfer covers its
 * whole lifetime in ≤ ~200 KB of tuples while the first minutes (where
 * ramp-up and collapse happen) keep 10 Hz resolution.
 */

export const TIMELINE_MAX_SAMPLES = 2048;

/** Field order is fixed by the producer; decode via the label list. */
export interface TimelineSeries {
  /** header of the recorded fields, e.g. ['t','sent','acked',...] */
  fields: string[];
  /** rows of numbers, oldest first */
  rows: number[][];
  /** the recording interval in effect at the last sample (ms) */
  intervalMs: number;
}

export class TransferTimeline {
  private rows: number[][] = [];
  private intervalMs = 100;
  private decimated = 0;

  constructor(
    private readonly fields: string[],
    private readonly capacity = TIMELINE_MAX_SAMPLES,
  ) {}

  get currentIntervalMs(): number {
    return this.intervalMs;
  }

  /** Producer pushes one sample; `t` (ms since transfer start) must be first. */
  push(sample: number[]): void {
    if (this.rows.length >= this.capacity) {
      // Adaptive decimation: keep every other sample, halve the cadence.
      const kept: number[][] = [];
      for (let i = 0; i < this.rows.length; i += 2) kept.push(this.rows[i]);
      if (this.rows.length % 2 === 1) kept.push(this.rows[this.rows.length - 1]);
      this.rows = kept;
      this.intervalMs *= 2;
      this.decimated++;
    }
    this.rows.push(sample);
  }

  get length(): number {
    return this.rows.length;
  }

  toJSON(): TimelineSeries {
    return { fields: this.fields, rows: this.rows, intervalMs: this.intervalMs };
  }
}

/**
 * Collapse-curve extraction for reports: 1-second-resolution summary rows
 * [tSec, throughputBps, rttMs, windowBytes, bufferedAmount, inFlightBytes]
 * reduced to at most `maxRows` evenly spaced rows. Pure, no DOM.
 */
export function collapseCurve(
  tl: TimelineSeries,
  indices: { t: number; bps: number; rtt: number; window: number; buffered: number; inFlight: number },
  maxRows = 40,
): Array<{ tSec: number; bps: number; rttMs: number; windowBytes: number; buffered: number; inFlight: number }> {
  const { rows } = tl;
  if (rows.length === 0) return [];
  const out: Array<{ tSec: number; bps: number; rttMs: number; windowBytes: number; buffered: number; inFlight: number }> = [];
  const i = indices;
  const step = Math.max(1, Math.floor(rows.length / maxRows));
  for (let k = 0; k < rows.length; k += step) {
    const r = rows[k];
    out.push({
      tSec: Math.round(r[i.t] / 100) / 10,
      bps: r[i.bps],
      rttMs: r[i.rtt],
      windowBytes: r[i.window],
      buffered: r[i.buffered],
      inFlight: r[i.inFlight],
    });
  }
  // Always include the final sample.
  const last = rows[rows.length - 1];
  if (out.length === 0 || out[out.length - 1].tSec !== Math.round(last[i.t] / 100) / 10) {
    out.push({
      tSec: Math.round(last[i.t] / 100) / 10,
      bps: last[i.bps],
      rttMs: last[i.rtt],
      windowBytes: last[i.window],
      buffered: last[i.buffered],
      inFlight: last[i.inFlight],
    });
  }
  return out;
}
