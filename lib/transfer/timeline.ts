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

/**
 * FIRST-CHANGING VARIABLE analysis (2026-10-01, TURBO v2.1).
 *
 * Scans the recorded 10 Hz timeline for significant throughput FALLS and
 * RISES and, for each, names the pipeline variable that moved FIRST —
 * before the throughput change — using each variable's own recent
 * stability band. This turns "why did it collapse?" from inference into
 * a measured fact on the physical-device run.
 */
export interface FirstChange {
  kind: 'fall' | 'rise';
  tSec: number;
  fromBps: number;
  toBps: number;
  variable: string;
  from: number;
  to: number;
}

export function firstChangingVariable(
  tl: TimelineSeries,
  idx: Record<string, number>,
): FirstChange[] {
  const rows = tl.rows;
  const out: FirstChange[] = [];
  if (rows.length < 4) return out;
  const WARMUP = 2; // skip the first samples (engine spin-up noise)

  const at = (k: number): { t: number; bps: number; vars: Record<string, number> } => {
    const r = rows[k];
    const vars: Record<string, number> = {};
    for (const [name, i] of Object.entries(idx)) vars[name] = r[i];
    return { t: r[0], bps: r[idx.bps], vars };
  };

  // Local extremum tracking over a short window (~2 s of samples).
  const win = Math.max(3, Math.min(20, Math.round(2000 / Math.max(1, tl.intervalMs))));

  let lastEventT = -Infinity;
  for (let k = WARMUP; k < rows.length; k++) {
    const cur = at(k);
    const back = at(Math.max(0, k - win));
    const back2 = at(Math.max(0, k - win * 2));
    const ref = back.bps;
    if (ref <= 0) continue;

    const isFall = cur.bps < ref * 0.6 && back2.bps >= ref * 0.6;
    const isRise = cur.bps > ref * 1.67 && back2.bps <= ref * 1.67;
    if (!isFall && !isRise) continue;
    // One event per ~3 s of timeline.
    if (cur.t - lastEventT < 3000) continue;
    lastEventT = cur.t;

    // Which variable moved FIRST in the ~1.5 s window ENDING at the
    // throughput change? Scan backwards from k: the variable whose value
    // first left its stability band (±30%) relative to the band value at
    // the start of the window is the "first-changing" one.
    const horizon = Math.max(2, Math.round(1500 / Math.max(1, tl.intervalMs)));
    const start = Math.max(WARMUP, k - horizon);
    let first: { variable: string; from: number; to: number } | null = null;
    for (let j = k; j >= start && !first; j--) {
      const v = at(j).vars;
      const v0 = at(start).vars;
      for (const name of Object.keys(idx)) {
        if (name === 'bps') continue;
        const a = v0[name];
        const b = v[name];
        if (!isFinite(a) || a <= 0 || !isFinite(b)) continue;
        if (Math.abs(b - a) > a * 0.3) {
          first = { variable: name, from: a, to: b };
          break;
        }
      }
    }

    out.push({
      kind: isFall ? 'fall' : 'rise',
      tSec: Math.round(cur.t / 100) / 10,
      fromBps: back.bps,
      toBps: cur.bps,
      variable: first?.variable ?? 'none-detected',
      from: first?.from ?? 0,
      to: first?.to ?? 0,
    });
  }
  return out;
}
