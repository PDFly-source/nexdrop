/**
 * Developer-only Device Test mode — OWNER-RUN physical validation.
 *
 * Records real measured values for the 10-case physical matrix on real
 * phones. Nothing here is part of the normal user journey and nothing here
 * may synthesize a value: every number comes from the real engines
 * (transfer telemetry, getStats() transport samples, engine completion
 * callbacks) or from the owner's explicit Pass/Fail verdict.
 */

import type { StageSummary } from '../lib/transfer/stageStats';

export interface DeviceTestFileRecord {
  transferId: string;
  name: string;
  size: number;
  /** SHA-256 hex of the file content, as computed by the real engine on
   *  THIS device (receiver: local incremental hash; sender: streamed hash). */
  sha256: string | null;
}

export interface DeviceTestRecord {
  caseId: string;
  title: string;
  /** [Start Test] pressed — real clock time. */
  armedAt: number | null;
  /** Owner verdict / reset — real clock time. */
  endedAt: number | null;
  /** Real engine completions captured while this test was armed. */
  files: DeviceTestFileRecord[];
  totalBytes: number;
  /** First sample with real byte movement (sampler). */
  transferStartedAt: number | null;
  /** Last real engine completion while armed. */
  transferEndedAt: number | null;
  /** Running max of real engine throughput samples (bytes/sec). */
  peakBps: number;
  /** Last live throughput sample (bytes/sec). */
  lastSampleBps: number;
  /** Last sampled real byte movement (sender bytesSent / receiver bytesReceived). */
  lastBytes: number;
  /** getStats() transport truth — never assumed. */
  /** getStats() transport truth — never assumed. 'local' = host<->host over a
   *  private/mDNS address (same LAN), 'internet' = srflx/prflx or public host. */
  connection: 'local' | 'internet' | 'relay' | 'unknown' | null;
  iceCandidates: string | null;
  rttMs: number | null;
  dataChannelState: string | null;
  /** Selected pair network protocol from getStats ('udp'/'tcp') — null when
   *  not exposed. Bottleneck evidence: relay/TCP paths explain slow links. */
  protocol: string | null;
  /** availableOutgoingBitrate / availableIncomingBitrate (bytes/sec) when the
   *  browser exposes them — the measured network capacity ceiling. Null =
   *  browser did not report an estimate. */
  outgoingCapacityBps: number | null;
  incomingCapacityBps: number | null;
  /** Negotiated SCTP maxMessageSize read from pc.sctp — the real chunk ceiling. */
  sctpMaxMessageSize: number | null;
  /** Last sampled engine values (real telemetry — the performance section):
   *  active chunk size, window chunks, sender bufferedAmount, stall count,
   *  and total transferred/total bytes of the sampled transfer. */
  lastChunkSizeBytes: number | null;
  lastWindowChunks: number | null;
  lastBufferedBytes: number | null;
  lastStalls: number | null;
  lastTotalBytes: number | null;
  /** Cellular-path evidence: local candidate networkType ('wifi'/'cellular'). */
  networkType: string | null;
  /** Selected candidate-pair retransmissions — real loss evidence. */
  retransmissionsSent: number | null;
  /** Max real in-flight bytes seen by the sampler (window fill proof). */
  maxInFlightBytes: number | null;
  /** Sender ACK-latency EWMA at the last sample (bulk-path RTT). */
  ackLatencyMs: number | null;
  /** Selected pair candidate addresses (mDNS .local = local network). */
  localAddress: string | null;
  remoteAddress: string | null;
  /** Receiver's real VERIFY verdict (sender devices learn it via VERIFY). */
  shaVerified: boolean | null;
  /** 10 Hz collapse curve from the sender engine (bounded, decimated). */
  senderTimeline: import('../lib/transfer/timeline').TimelineSeries | null;
  /** 10 Hz receiver pipeline curve (bounded, decimated). */
  receiverTimeline: import('../lib/transfer/timeline').TimelineSeries | null;
  /** Whole-transfer average bytes/sec at the final sample (sustained). */
  sustainedBps: number | null;
  /** Peak of the sustained metric across samples. */
  peakSustainedBps: number | null;
  /** Minimum sampled throughput while bytes were moving (collapse floor). */
  minBps: number | null;
  /** RTT average/max across real getStats samples (ms). */
  avgRttMs: number | null;
  maxRttMs: number | null;
  rttSampleSum: number;
  rttSampleCount: number;
  /** Sender ACK-latency EWMA max across samples (ms). */
  maxAckLatencyMs: number | null;
  /** Window evolution: first / max / last sampled window bytes. */
  initialWindowBytes: number | null;
  maxWindowBytes: number | null;
  finalWindowBytes: number | null;
  /** Max SCTP bufferedAmount across samples. */
  maxBufferedBytes: number | null;
  /** Receiver write EWMA last/max (ms). */
  lastWriteMsEwma: number | null;
  maxWriteMs: number | null;
  /** Receiver max queue depth across samples. */
  maxQueueDepth: number | null;
  /** Real owner-exercised flow events: pause / resume / cancel. */
  events: Array<{ at: number; kind: string }>;
  /** Last sampled sender window bytes (finalWindow convenience). */
  lastWindowBytes: number | null;
  /** v2.5.2 live diagnostics — RTCPeerConnection / ICE states (read). */
  connectionState: string | null;
  iceConnectionState: string | null;
  iceGatheringState: string | null;
  /** v2.5.2 — SCTP data-channel packet counters when exposed. */
  sctpPacketsSent: number | null;
  sctpPacketsReceived: number | null;
  /** v2.5.2 receiver storage profile at the last sample (all measured). */
  writerType: string | null;
  writeCalls: number | null;
  storageBytesWritten: number | null;
  writeBatchP50Bytes: number | null;
  writeBatchP95Bytes: number | null;
  writesPerMiB: number | null;
  writeP50Ms: number | null;
  writeP95Ms: number | null;
  /** Peak usedJSHeapSize sampled on THIS device (0 = browser hides it). */
  heapPeakBytes: number | null;
  /** ---- v2.5.3 sender pump profile (LIVE-1790935144052 root cause
   *  evidence: hash-mode downgrade throttles the pump invisibly). ---- */
  /** Negotiated hash engine of the last sampled transfer: inline|merkle|worker. */
  hashMode: string | null;
  hashCpuMs: number | null;
  hashPctOfWall: number | null;
  /** Pump serial-stage EWMA costs (ms). */
  pumpSliceMs: number | null;
  pumpHashMs: number | null;
  pumpEncodeMs: number | null;
  pumpIterMs: number | null;
  /** Unaccounted pump idle (ms EWMA / total). */
  pumpIdleMs: number | null;
  pumpIdleMsTotal: number | null;
  /** Cumulative ACK-window wait (ms). */
  ackWaitMs: number | null;
  /** Hash-lag gate: cumulative wait ms + event count (the previously
   *  INVISIBLE await that pinned the pump under a JS-hash downgrade). */
  hashLagWaitMs: number | null;
  hashLagEvents: number | null;
  /** Flow events (cumulative counts). */
  windowGrowEvents: number | null;
  windowShrinkEvents: number | null;
  bufferLowEvents: number | null;
  ackWaitEvents: number | null;
  /** v2.5.3 receiver deterministic integrity audit at the last sample. */
  integrityAudit: {
    chunksProcessed: number;
    duplicatesDropped: number;
    reorderStashed: number;
    maxReorderDepth: number;
    scheme: 'sha256' | 's256m' | null;
    senderScheme: 'sha256' | 's256m' | null;
    schemeReverified: boolean;
  } | null;
  /**
   * v2.4/v2.6 FULL per-stage pump distributions (slice/hash/encode/send/
   * bufferWait/ackWait/finalize: count/total/p50/p95/p99/max/bytes) at the
   * last live sample — the stage-by-stage answer to "where does pump time
   * go?" for physical test mode.
   */
  stagesFull: {
    slice: StageSummary;
    hash: StageSummary;
    encode: StageSummary;
    send: StageSummary;
    bufferWait: StageSummary;
    ackWait: StageSummary;
    finalize: StageSummary;
  } | null;
  /** Final window-utilization summary (inFlight/window avg/p50/p95/min/max). */
  windowUtilizationSummary: { avg: number; p50: number; p95: number; min: number; max: number } | null;
  result: 'passed' | 'failed' | null;
  notes: string;
}

export interface DeviceTestMeta {
  deviceA: string;
  deviceB: string;
  network: string;
  extra: string;
  /** v2.5.2 guided test: the role THIS phone plays in the live test. */
  role: '' | 'sender' | 'receiver';
}

export interface DeviceTestSnapshot {
  records: DeviceTestRecord[];
  meta: DeviceTestMeta;
  /** Overlay screen open state (session only, not persisted). */
  open: boolean;
}
