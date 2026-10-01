/**
 * Developer-only Device Test mode — OWNER-RUN physical validation.
 *
 * Records real measured values for the 10-case physical matrix on real
 * phones. Nothing here is part of the normal user journey and nothing here
 * may synthesize a value: every number comes from the real engines
 * (transfer telemetry, getStats() transport samples, engine completion
 * callbacks) or from the owner's explicit Pass/Fail verdict.
 */

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
  result: 'passed' | 'failed' | null;
  notes: string;
}

export interface DeviceTestMeta {
  deviceA: string;
  deviceB: string;
  network: string;
  extra: string;
}

export interface DeviceTestSnapshot {
  records: DeviceTestRecord[];
  meta: DeviceTestMeta;
  /** Overlay screen open state (session only, not persisted). */
  open: boolean;
}
