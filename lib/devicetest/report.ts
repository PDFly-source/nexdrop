/**
 * v2.5.2 GUIDED DEVICE TEST report + JSON export.
 *
 * Everything in the report is either:
 *  - a value measured by the real engines / getStats() (captured by the
 *    recorder sampler), or
 *  - a deterministic computation over those values (avg = bytes/duration,
 *    p95 = percentile of recorded throughput samples), or
 *  - the owner's explicit input (device names, network).
 * Nothing is synthesized. Missing browser APIs print 'N/A'. The
 * bottleneck analysis names a layer ONLY when a measured variable
 * supports the statement; otherwise it says so.
 */

import { collapseCurve, firstChangingVariable, type FirstChange, type TimelineSeries } from '../transfer/timeline';
import type { DeviceTestMeta, DeviceTestRecord } from '../../types/devicetest';
import { deviceTestAvgBps, deviceTestDurationSeconds } from './recorder';

const MB = 1e6;
const KIB = 1024;

const fmtMBps = (bps: number | null | undefined): string =>
  bps && bps > 0 ? `${(bps / MB).toFixed(2)} MB/s` : 'N/A';
const fmtBytes = (b: number | null | undefined): string =>
  b != null && b > 0 ? (b >= MB ? `${(b / MB).toFixed(2)} MB` : `${(b / KIB).toFixed(0)} KB`) : 'N/A';
const fmtMs = (ms: number | null | undefined): string =>
  ms != null ? `${Math.round(ms)} ms` : 'N/A';
const na = (v: string | null | undefined): string => (v && v.length > 0 ? v : 'N/A');

/** Sender timeline column indices (fixed by lib/transfer/sender.ts). */
const S_IDX = { t: 0, sent: 1, acked: 2, inFlight: 3, window: 4, chunk: 5, buffered: 6, rtt: 7, minRtt: 8, bps: 9, stalls: 10, ackLatency: 11, writeMs: 12, queueDepth: 13 };
/** Receiver timeline column indices (fixed by lib/transfer/receiver.ts). */
const R_IDX = { t: 0, received: 1, queueDepth: 2, writeMs: 3, bps: 4, acks: 5, chunks: 6 };

/** Percentile of the recorded throughput samples (bytes/sec), honest
 *  computation over REAL samples only. Null when no samples exist. */
export function throughputPercentile(
  tl: TimelineSeries | null,
  p: number,
): number | null {
  if (!tl || tl.rows.length === 0) return null;
  const bps = tl.rows.map((r) => r[S_IDX.bps]).filter((v) => v > 0);
  if (bps.length === 0) return null;
  const sorted = [...bps].sort((a, b) => a - b);
  const k = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[k];
}

export interface LiveCollapseAnalysis {
  curve: ReturnType<typeof collapseCurve>;
  firstChanges: FirstChange[];
  /** Evidence statements — each backed by a measured value. */
  evidence: string[];
  /** Named ONLY when a measured variable supports it. */
  likelyLayer: string;
}

/** Collapse + bottleneck analysis over the recorded timelines. Pure. */
export function liveCollapseAnalysis(rec: DeviceTestRecord): LiveCollapseAnalysis {
  const curve = rec.senderTimeline
    ? collapseCurve(rec.senderTimeline, {
        t: S_IDX.t, bps: S_IDX.bps, rtt: S_IDX.rtt, window: S_IDX.window,
        buffered: S_IDX.buffered, inFlight: S_IDX.inFlight,
      })
    : [];
  const firstChanges = rec.senderTimeline
    ? firstChangingVariable(rec.senderTimeline, {
        bps: S_IDX.bps, rtt: S_IDX.rtt, window: S_IDX.window, buffered: S_IDX.buffered,
        inFlight: S_IDX.inFlight, ackLatency: S_IDX.ackLatency, writeMs: S_IDX.writeMs,
        queueDepth: S_IDX.queueDepth,
      })
    : [];

  const evidence: string[] = [];
  const candidates: Array<{ layer: string; why: string }> = [];

  if (rec.connection === 'relay') {
    candidates.push({ layer: 'transport (RELAY path)', why: 'selected candidate pair is relay — every byte crosses the TURN server' });
  }
  if (rec.outgoingCapacityBps != null && rec.outgoingCapacityBps > 0 && rec.peakBps > 0) {
    evidence.push(`availableOutgoingBitrate (browser estimate): ${fmtMBps(rec.outgoingCapacityBps)} vs peak actual ${fmtMBps(rec.peakBps)}`);
    if (rec.peakBps >= rec.outgoingCapacityBps * 0.85) {
      candidates.push({ layer: 'path capacity', why: `actual peak ${fmtMBps(rec.peakBps)} reached the browser-reported available bitrate ${fmtMBps(rec.outgoingCapacityBps)} — the link is the ceiling` });
    }
  } else {
    evidence.push('availableOutgoingBitrate: not reported by this browser');
  }
  if (rec.incomingCapacityBps != null) {
    evidence.push(`availableIncomingBitrate: ${fmtMBps(rec.incomingCapacityBps)}`);
  }
  if (rec.retransmissionsSent != null) {
    evidence.push(`STUN consent retransmissions on the selected pair: ${rec.retransmissionsSent}`);
  } else {
    evidence.push('retransmissions: not reported by this browser');
  }
  if (rec.maxQueueDepth != null && rec.maxQueueDepth >= 32 && rec.maxWriteMs != null && rec.maxWriteMs >= 25) {
    candidates.push({ layer: 'receiver storage', why: `receiver queue reached ${rec.maxQueueDepth} chunks while write cost peaked at ${fmtMs(rec.maxWriteMs)} — ingestion stalled on storage` });
  }
  if (rec.maxAckLatencyMs != null && rec.maxAckLatencyMs >= 500 && rec.maxInFlightBytes != null && rec.maxWindowBytes != null && rec.maxInFlightBytes > 0 && rec.maxInFlightBytes < rec.maxWindowBytes * 0.5) {
    candidates.push({ layer: 'sender window / ACK cadence', why: `ACK latency peaked at ${fmtMs(rec.maxAckLatencyMs)} while in-flight never exceeded ${fmtBytes(rec.maxInFlightBytes)} of a ${fmtBytes(rec.maxWindowBytes)} window — durable-ACK round-trip paced the pump` });
  }
  if (rec.maxBufferedBytes != null && rec.maxBufferedBytes > 4 * 1024 * 1024) {
    candidates.push({ layer: 'sender SCTP buffer drain', why: `DataChannel bufferedAmount peaked at ${fmtBytes(rec.maxBufferedBytes)} — the network drained slower than the pump pushed` });
  }
  // v2.5.3: the LIVE-1790935144052 signature — a JS-hash downgrade (late
  // HASH_OK) throttles the pump to the JS-hash rate while the window stays
  // wide and in-flight stays tiny. Telemetry now exposes it directly.
  if (rec.hashMode === 'worker' || rec.hashMode === 'inline') {
    const lag = rec.hashLagWaitMs ?? 0;
    const hashPct = rec.hashPctOfWall ?? 0;
    if (hashPct >= 30 || lag > 1000) {
      candidates.push({ layer: 'sender JS hashing (hash-mode downgrade)', why: `hashMode=${rec.hashMode} with hash at ${hashPct.toFixed(1)}% of wall and ${fmtMs(lag)} spent in the hash-lag gate — the pump was paced by JavaScript SHA-256, not the network (root cause of the 0.62 MB/s / SHA FAIL run)` });
    } else {
      evidence.push(`hashMode=${rec.hashMode} — sender fell back from native merkle hashing (late or missing HASH_OK reply)`);
    }
  } else if (rec.hashMode === 'merkle') {
    evidence.push(`hashMode=merkle — native hash pipeline negotiated on both ends`);
  }
  evidence.push(`RTT avg/max: ${fmtMs(rec.avgRttMs)} / ${fmtMs(rec.maxRttMs)}`);
  evidence.push(`min sampled throughput: ${fmtMBps(rec.minBps)}; peak: ${fmtMBps(rec.peakBps)}`);

  const likelyLayer =
    candidates.length > 0
      ? `${candidates[0].layer} — ${candidates[0].why}${candidates.length > 1 ? ` (also consistent: ${candidates.slice(1).map((c) => c.layer).join(', ')})` : ''}`
      : 'Undetermined — no single stage exceeded its stability band; see the collapse timeline and first-changing-variable events below.';

  return { curve, firstChanges, evidence, likelyLayer };
}

/** The Phase-6 layout report for the guided live test. Text only. */
/** Share of pump wall spent in each measured stage — for stage-timing forensics. */
function stageShareOfWall(stagesFull: DeviceTestRecord['stagesFull']): string {
  if (!stagesFull) return '  Share of wall: N/A';
  const keys = Object.keys(stagesFull) as (keyof typeof stagesFull)[];
  const wall = keys.reduce((a, k) => a + stagesFull[k].totalMs, 0);
  const shares = keys.map((k) => `${k} ${((stagesFull[k].totalMs / Math.max(1, wall)) * 100).toFixed(1)}%`).join(' · ');
  return `  Share of wall: ${shares} (measured total ${Math.round(wall)} ms)`;
}

export function buildLiveTestReport(rec: DeviceTestRecord, meta: DeviceTestMeta): string {
  const avg = deviceTestAvgBps(rec);
  const duration = deviceTestDurationSeconds(rec);
  const p95 = throughputPercentile(rec.senderTimeline, 95);
  const p50 = throughputPercentile(rec.senderTimeline, 50);
  const analysis = liveCollapseAnalysis(rec);
  const role = meta.role || '— (not selected)';
  const shaState =
    rec.shaVerified === false ? 'FAIL' : rec.shaVerified === true ? 'PASS' : 'not recorded';
  const pathLabel =
    rec.connection === 'local' ? 'LOCAL_DIRECT'
    : rec.connection === 'internet' ? 'INTERNET_DIRECT'
    : rec.connection === 'relay' ? 'RELAY'
    : 'not measured yet';

  const lines: string[] = [
    'NEXDROP DEVICE TEST REPORT',
    `Test ID: ${rec.caseId.toUpperCase()}-${rec.transferStartedAt ?? rec.armedAt ?? Date.now()}`,
    `Date/time: ${new Date(rec.transferStartedAt ?? rec.armedAt ?? Date.now()).toISOString()}`,
    `This device role: ${role}`,
    `Device A (sender): ${na(meta.deviceA)}`,
    `Device B (receiver): ${na(meta.deviceB)}`,
    `Network: ${na(meta.network)}`,
    `File size: ${fmtBytes(rec.totalBytes)}${rec.files.length > 0 ? ` (${rec.files.map((f) => f.name).join(', ')})` : ' (no completed transfer recorded)'}`,
    `Duration: ${duration != null ? `${duration.toFixed(2)} s` : 'N/A'}`,
    '',
    'TRANSPORT',
    `Path classification: ${pathLabel}`,
    `Candidate pair: ${na(rec.iceCandidates)}${rec.localAddress ? ` (${rec.localAddress} → ${rec.remoteAddress})` : ''}`,
    `Protocol: ${na(rec.protocol ? rec.protocol.toUpperCase() : null)}`,
    `WebRTC connection state: ${na(rec.connectionState)}`,
    `ICE connection state: ${na(rec.iceConnectionState)}`,
    `ICE gathering state: ${na(rec.iceGatheringState)}`,
    `DataChannel state: ${na(rec.dataChannelState)}`,
    `RTT (avg/max): ${fmtMs(rec.avgRttMs)} / ${fmtMs(rec.maxRttMs)}`,
    `Available outbound: ${fmtMBps(rec.outgoingCapacityBps)}`,
    `Available inbound: ${fmtMBps(rec.incomingCapacityBps)}`,
    `SCTP packets sent/received: ${rec.sctpPacketsSent != null ? String(rec.sctpPacketsSent) : 'N/A'} / ${rec.sctpPacketsReceived != null ? String(rec.sctpPacketsReceived) : 'N/A'}`,
    `Retransmissions: ${rec.retransmissionsSent != null ? String(rec.retransmissionsSent) : 'N/A'}`,
    '',
    'PERFORMANCE',
    `Average throughput: ${fmtMBps(avg)}`,
    `Sustained throughput (whole-transfer): ${fmtMBps(rec.sustainedBps)}`,
    `Peak-sustained throughput: ${fmtMBps(rec.peakSustainedBps)}`,
    `Peak throughput (instant, not a success metric): ${fmtMBps(rec.peakBps)}`,
    `Minimum sampled throughput: ${fmtMBps(rec.minBps)}`,
    `P50 throughput: ${fmtMBps(p50)}`,
    `P95 throughput: ${fmtMBps(p95)}`,
    '',
    'FLOW CONTROL',
    `Initial window: ${fmtBytes(rec.initialWindowBytes)}`,
    `Maximum window: ${fmtBytes(rec.maxWindowBytes)}`,
    `Final window: ${fmtBytes(rec.finalWindowBytes)}`,
    `Chunk size: ${fmtBytes(rec.lastChunkSizeBytes)}`,
    `Buffered amount (max): ${fmtBytes(rec.maxBufferedBytes)}`,
    `In-flight (max): ${fmtBytes(rec.maxInFlightBytes)}`,
    `ACK latency (last/max): ${fmtMs(rec.ackLatencyMs)} / ${fmtMs(rec.maxAckLatencyMs)}`,
    `Stalls: ${rec.lastStalls != null ? String(rec.lastStalls) : 'N/A'}`,
    `Flow events: ${
      rec.events.length > 0
        ? rec.events.map((e) => `${e.kind}@+${(((e.at - (rec.transferStartedAt ?? e.at)) / 1000)).toFixed(1)}s`).join(', ')
        : 'none recorded'
    }`,
    '',
    'PUMP (v2.5.3 sender profile)',
    `Hash mode: ${na(rec.hashMode)}${rec.hashCpuMs != null ? ` (hash CPU ${rec.hashCpuMs.toFixed(0)} ms, ${(rec.hashPctOfWall ?? 0).toFixed(1)}% of wall)` : ''}`,
    `Stage EWMA — slice/hash/encode: ${
      rec.pumpSliceMs != null || rec.pumpHashMs != null || rec.pumpEncodeMs != null
        ? `${rec.pumpSliceMs != null ? rec.pumpSliceMs.toFixed(1) : 'N/A'} / ${rec.pumpHashMs != null ? rec.pumpHashMs.toFixed(1) : 'N/A'} / ${rec.pumpEncodeMs != null ? rec.pumpEncodeMs.toFixed(1) : 'N/A'} ms`
        : 'N/A (v2.5.3+ sender required)'
    }`,
    `Iteration wall / idle EWMA: ${rec.pumpIterMs != null ? `${rec.pumpIterMs.toFixed(1)} / ${rec.pumpIdleMs != null ? rec.pumpIdleMs.toFixed(1) : 'N/A'} ms` : 'N/A'}${rec.pumpIdleMsTotal != null ? ` (idle total ${rec.pumpIdleMsTotal.toFixed(0)} ms)` : ''}`,
    `Waits — ACK-window: ${rec.ackWaitMs != null ? `${rec.ackWaitMs.toFixed(0)} ms over ${rec.ackWaitEvents ?? '?'} waits` : 'N/A'}; hash-lag gate: ${rec.hashLagWaitMs != null ? `${rec.hashLagWaitMs.toFixed(0)} ms over ${rec.hashLagEvents ?? '?'} waits` : 'N/A'}`,
    `Flow events — window grow/shrink: ${rec.windowGrowEvents ?? 'N/A'} / ${rec.windowShrinkEvents ?? 'N/A'}; buffer-low waits: ${rec.bufferLowEvents ?? 'N/A'}`,
    '',
    'STAGE TIMING (measured per pump stage — where does pump time go?)',
    ...(rec.stagesFull
      ? (Object.keys(rec.stagesFull) as (keyof typeof rec.stagesFull)[]).map((k) => {
          const st = rec.stagesFull![k];
          return `  ${k.padEnd(10)} p50 ${String(st.p50Ms).padStart(7)} ms · p95 ${String(st.p95Ms).padStart(7)} ms · max ${String(st.maxMs).padStart(7)} ms · total ${String(st.totalMs).padStart(9)} ms (${st.count} samples, ${fmtBytes(st.bytes)})`;
        })
      : ['  N/A (v2.4+ sender required)']),
    stageShareOfWall(rec.stagesFull),
    `Window utilization (inFlight/window): ${
      rec.windowUtilizationSummary
        ? `avg ${(rec.windowUtilizationSummary.avg * 100).toFixed(1)}% · p50 ${(rec.windowUtilizationSummary.p50 * 100).toFixed(1)}% · p95 ${(rec.windowUtilizationSummary.p95 * 100).toFixed(1)}% · min ${(rec.windowUtilizationSummary.min * 100).toFixed(1)}% · max ${(rec.windowUtilizationSummary.max * 100).toFixed(1)}%`
        : 'N/A (present once the transfer completes)'
    }`,
    '',
    'RECEIVER',
    `Storage path: ${na(rec.writerType)}`,
    `Write latency EWMA (last/max): ${rec.lastWriteMsEwma != null ? `${rec.lastWriteMsEwma.toFixed(1)} ms` : 'N/A'} / ${fmtMs(rec.maxWriteMs)}`,
    `Write p50/p95: ${fmtMs(rec.writeP50Ms)} / ${fmtMs(rec.writeP95Ms)}`,
    `Write batch p50/p95: ${fmtBytes(rec.writeBatchP50Bytes)} / ${fmtBytes(rec.writeBatchP95Bytes)}`,
    `Writes per MiB: ${rec.writesPerMiB != null ? rec.writesPerMiB.toFixed(2) : 'N/A'}`,
    `Queue depth (max): ${rec.maxQueueDepth != null ? String(rec.maxQueueDepth) : 'N/A'}`,
    `Storage calls: ${rec.writeCalls != null ? String(rec.writeCalls) : 'N/A'}`,
    `Storage bytes written (durably): ${fmtBytes(rec.storageBytesWritten)}`,
    '',
    'MEMORY',
    `JS heap peak (this device): ${rec.heapPeakBytes && rec.heapPeakBytes > 0 ? fmtBytes(rec.heapPeakBytes) : 'N/A (browser does not expose performance.memory)'}`,
    '',
    'INTEGRITY',
    `Expected bytes: ${fmtBytes(rec.lastTotalBytes)}`,
    `Received/sent bytes (last sample): ${fmtBytes(rec.lastBytes)}`,
    `SHA-256: ${shaState}${rec.files.length > 0 && rec.files[0].sha256 ? ` (${rec.files[0].sha256.slice(0, 16)}…)` : ''}`,
    `Hash scheme — receiver/sender: ${
      rec.integrityAudit
        ? `${rec.integrityAudit.scheme ?? 'N/A'} / ${rec.integrityAudit.senderScheme ?? 'N/A (pre-v2.5.3 sender)'}${rec.integrityAudit.schemeReverified ? ' — schemes diverged; durable file re-verified under the sender\'s scheme' : ''}`
        : 'N/A (v2.5.3+ receiver required)'
    }`,
    `Chunk audit — processed/duplicates-dropped/reorder-stashed: ${
      rec.integrityAudit
        ? `${rec.integrityAudit.chunksProcessed} / ${rec.integrityAudit.duplicatesDropped} / ${rec.integrityAudit.reorderStashed} (max reorder depth ${rec.integrityAudit.maxReorderDepth})`
        : 'N/A (v2.5.3+ receiver required)'
    }`,
    '',
    'BOTTLENECK ANALYSIS',
    analysis.firstChanges.length === 0
      ? 'FIRST CHANGING VARIABLE: none detected (or no timeline recorded)'
      : `FIRST CHANGING VARIABLE: ${analysis.firstChanges[0].variable} (at t=${analysis.firstChanges[0].tSec.toFixed(1)}s)`,
    ...(analysis.firstChanges.length > 0 ? ['  all significant fall/rise events:'] : []),
    ...analysis.firstChanges.map(
      (c) =>
        `  t=${c.tSec.toFixed(1)}s ${c.kind.toUpperCase()} ${fmtMBps(c.fromBps)} → ${fmtMBps(c.toBps)} first: ${c.variable}${c.variable !== 'none-detected' ? ` (${fmtBytes(c.from)} → ${fmtBytes(c.to)})` : ''}`,
    ),
    'Evidence:',
    ...analysis.evidence.map((e) => `  - ${e}`),
    `LIKELY BOTTLENECK: ${analysis.likelyLayer}`,
    '',
    'COLLAPSE TIMELINE (t, throughput, rtt, window, buffered, in-flight):',
    ...(analysis.curve.length === 0
      ? ['  not recorded (needs a completed transfer in this session)']
      : analysis.curve.map(
          (c) =>
            `  t=${c.tSec.toFixed(1)}s ${fmtMBps(c.bps).padStart(10)} rtt=${Math.round(c.rttMs)}ms win=${fmtBytes(c.windowBytes)} buf=${fmtBytes(c.buffered)} infl=${fmtBytes(c.inFlight)}`,
        )),
  ];
  if (meta.extra) lines.push('', `Notes: ${meta.extra}`);
  lines.push(
    '',
    'Every value above is measured (engine telemetry, getStats(), real timestamps) or',
    'computed from those measurements. N/A = the browser/device does not expose it.',
    'Nothing is synthesized. Diagnostics stay on this device.',
  );
  return lines.join('\n');
}

/** Raw-telemetry JSON export (local, private — nothing is uploaded). */
export function buildLiveTestJson(rec: DeviceTestRecord, meta: DeviceTestMeta): string {
  const analysis = liveCollapseAnalysis(rec);
  return JSON.stringify(
    {
      kind: 'nexdrop-device-test',
      version: 2,
      generatedAt: new Date().toISOString(),
      meta,
      record: rec,
      collapse: {
        firstChanges: analysis.firstChanges,
        curve: analysis.curve,
        likelyLayer: analysis.likelyLayer,
      },
      senderTimeline: rec.senderTimeline,
      receiverTimeline: rec.receiverTimeline,
      timelineFieldOrder: {
        sender: ['t','sent','acked','inFlight','window','chunk','buffered','rtt','minRtt','bps','stalls','ackLatency','writeMs','queueDepth'],
        receiver: ['t','received','queueDepth','writeMs','bps','acks','chunks'],
      },
    },
    null,
    2,
  );
}
