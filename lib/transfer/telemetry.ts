/**
 * Real transfer telemetry — development/diagnostics ONLY.
 *
 * Engines write measured values (never synthesized) into a single
 * window-scoped object. The dev diagnostics panel (opt-in via
 * localStorage 'nexdrop:diagnostics' or ?diag=1) and the Playwright
 * benchmark read it. Writing is throttled and cheap: a handful of field
 * assignments, no React state, no allocation churn beyond one small
 * snapshot object per update.
 */

export interface SenderTelemetry {
  role: 'sender';
  transferId: string;
  name: string;
  totalBytes: number;
  chunkSize: number;
  bytesSent: number;
  bytesAcked: number;
  chunksSent: number;
  /** EWMA of the ACK-cadence throughput (bytes/sec), measured. */
  throughputBps: number;
  /** EWMA RTT from ACK timing (ms), measured. */
  srttMs: number;
  /** Running minimum ACK-RTT sample (ms) — the honest floor estimate. */
  minRttMs: number;
  windowChunks: number;
  windowBytes: number;
  /** DataChannel bufferedAmount at the last update. */
  bufferedAmount: number;
  /** Largest bufferedAmount observed. */
  maxBufferedAmount: number;
  ackCount: number;
  /** Real backpressure events (long buffer drains / ACK starvation). */
  stalls: number;
  startedAt: number;
  updatedAt: number;
}

export interface ReceiverTelemetry {
  role: 'receiver';
  transferId: string;
  name: string;
  totalBytes: number;
  chunkSize: number;
  bytesReceived: number;
  chunksReceived: number;
  /** EWMA ms per chunk write — real receiver write cost. */
  writeMsEwma: number;
  /** Chunks decrypted but not yet durably written. */
  queueDepth: number;
  maxQueueDepth: number;
  acksSent: number;
  throughputBps: number;
  writerType: string;
  /** usedJSHeapSize if the browser exposes performance.memory, else 0. */
  heapBytes: number;
  startedAt: number;
  updatedAt: number;
}

export interface NexDropTelemetry {
  sender: Partial<SenderTelemetry> | null;
  receiver: Partial<ReceiverTelemetry> | null;
}

declare global {
  interface Window {
    __NEXDROP_TELEMETRY__?: NexDropTelemetry;
  }
}

function root(): NexDropTelemetry {
  if (typeof window === 'undefined') return { sender: null, receiver: null };
  if (!window.__NEXDROP_TELEMETRY__) window.__NEXDROP_TELEMETRY__ = { sender: null, receiver: null };
  return window.__NEXDROP_TELEMETRY__;
}

export function updateSenderTelemetry(snapshot: Partial<SenderTelemetry>): void {
  if (typeof window === 'undefined') return;
  root().sender = { role: 'sender', ...(root().sender || {}), ...snapshot, updatedAt: Date.now() };
}

export function updateReceiverTelemetry(snapshot: Partial<ReceiverTelemetry>): void {
  if (typeof window === 'undefined') return;
  root().receiver = { role: 'receiver', ...(root().receiver || {}), ...snapshot, updatedAt: Date.now() };
}

export function clearTelemetry(): void {
  if (typeof window === 'undefined') return;
  window.__NEXDROP_TELEMETRY__ = { sender: null, receiver: null };
}
