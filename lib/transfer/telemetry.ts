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

import type { TimelineSeries } from './timeline';

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
  /** Real bytes in flight: sent but not yet durably ACKed. */
  inFlightBytes: number;
  /** Measured send-to-ACK latency EWMA (the true bulk-path RTT). */
  ackLatencyMs: number;
  /** Largest bufferedAmount observed. */
  maxBufferedAmount: number;
  ackCount: number;
  /** Real backpressure events (long buffer drains / ACK starvation). */
  stalls: number;
  /** Chunk send rate (chunks/sec, EWMA) — measured runtime cadence. */
  chunksPerSec: number;
  /** ACK rate (ACKs/sec, EWMA) — measured runtime cadence. */
  acksPerSec: number;
  /** Negotiated SCTP maxMessageSize (pc.sctp.maxMessageSize) — read, never assumed. */
  sctpMaxMessageSize: number;
  /** Whole-transfer average bytes/sec — the SUSTAINED headline metric. */
  sustainedBps: number;
  /** EWMA of RTT sample variance (ms^2, from ACK timing) — measured jitter. */
  rttVarianceMs: number;
  /** Active SCTP file streams in the striping pool (1..4) — measured pool size. */
  activeChannels: number;
  /** Highest healthy window reached this transfer (recovery target). */
  windowHighWaterBytes: number;
  /** 10 Hz collapse timeline (bounded, adaptively decimated). */
  timeline: TimelineSeries | null;
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
  /** EWMA ms per chunk write (amortized across coalesced batches) — real receiver write cost. */
  writeMsEwma: number;
  /** Largest number of chunks coalesced into one storage write call. */
  maxWriteBatch: number;
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
  /** 10 Hz collapse timeline — receiver view (bounded, decimated). */
  timeline: TimelineSeries | null;
}

/** REAL transport stats from RTCPeerConnection.getStats() (see transportStats.ts). */
export interface TransportTelemetry {
  connected: boolean;
  transport: 'local' | 'internet' | 'relay' | 'unknown';
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  /** Selected pair candidate addresses (mDNS .local names are local-network). */
  localAddress: string | null;
  remoteAddress: string | null;
  /** local candidate networkType ('wifi'/'cellular'/...) when exposed */
  networkType: string | null;
  /** selected pair retransmissions sent — real loss evidence */
  retransmissionsSent: number | null;
  /** relay protocol when selected */
  relayProtocol: string | null;
  /** totalRoundTripTime (s) of the selected pair when exposed */
  totalRoundTripTimeS: number | null;
  /** selected pair STUN requestsSent / responsesReceived */
  requestsSent: number | null;
  responsesReceived: number | null;
  rttMs: number | null;
  bytesSent: number | null;
  bytesReceived: number | null;
  outgoingBitrateBps: number | null;
  /** availableIncomingBitrate estimate (bits/s) when the browser exposes it. */
  incomingBitrateBps: number | null;
  /** Selected pair network protocol ('udp' | 'tcp' | null) — read from candidates. */
  protocol: string | null;
  /** Negotiated SCTP maxMessageSize when readable from pc.sctp. */
  sctpMaxMessageSize: number | null;
  dtlsState: string | null;
  sctpState: string | null;
  pairState: string | null;
  timestamp: number;
}

export interface NexDropTelemetry {
  sender: Partial<SenderTelemetry> | null;
  receiver: Partial<ReceiverTelemetry> | null;
  transport: TransportTelemetry | null;
  dataChannelState: string | null;
}

declare global {
  interface Window {
    __NEXDROP_TELEMETRY__?: NexDropTelemetry;
  }
}

function root(): NexDropTelemetry {
  if (typeof window === 'undefined') return { sender: null, receiver: null, transport: null, dataChannelState: null };
  if (!window.__NEXDROP_TELEMETRY__)
    window.__NEXDROP_TELEMETRY__ = { sender: null, receiver: null, transport: null, dataChannelState: null };
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

export function updateTransportTelemetry(snapshot: TransportTelemetry): void {
  if (typeof window === 'undefined') return;
  root().transport = snapshot;
}

/** File DataChannel readyState — 'open' while the transfer path is live. */
export function updateDataChannelState(state: string | null): void {
  if (typeof window === 'undefined') return;
  root().dataChannelState = state;
}

export function clearTelemetry(): void {
  if (typeof window === 'undefined') return;
  window.__NEXDROP_TELEMETRY__ = { sender: null, receiver: null, transport: null, dataChannelState: null };
}
