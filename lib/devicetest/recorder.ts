/**
 * Device Test recorder — OWNER-RUN physical validation only.
 *
 * A module-level store (independent of any React lifecycle, so the owner
 * can leave the overlay and run the real flow anywhere in the app):
 *  - [Start Test] arms a case and starts a 5 Hz sampler of the REAL
 *    engine telemetry (window.__NEXDROP_TELEMETRY__): running peak of the
 *    measured throughput, first real byte movement, getStats() transport
 *    truth (direct/relay, ICE candidate types, RTT), DataChannel state.
 *  - The app's existing completion/verification callbacks (wired in
 *    app/page.tsx) report real engine completions: file name, size,
 *    engine-computed SHA-256, receiver VERIFY verdict.
 *  - The owner gives the final Pass/Fail verdict. A failed SHA-256
 *    verification can never be marked Passed.
 *
 * Nothing is synthesized. Missing values stay '—'. Results persist in
 * localStorage (local-first, per-device).
 */

import type {
  DeviceTestFileRecord,
  DeviceTestMeta,
  DeviceTestRecord,
  DeviceTestSnapshot,
} from '@/types/devicetest';
import { DEVICE_TEST_CASES } from './matrix';

const STORAGE_KEY = 'nexdrop:devicetest:v1';
const SAMPLE_MS = 200;

const DEFAULT_META: DeviceTestMeta = { deviceA: '', deviceB: '', network: '', extra: '' };

const listeners = new Set<() => void>();
let snapshot: DeviceTestSnapshot | null = null;
let sampler: ReturnType<typeof setInterval> | null = null;
let lastPersistAt = 0;

function defaultRecords(): DeviceTestRecord[] {
  return DEVICE_TEST_CASES.map((c) => ({
    caseId: c.id,
    title: c.title,
    armedAt: null,
    endedAt: null,
    files: [],
    totalBytes: 0,
    transferStartedAt: null,
    transferEndedAt: null,
    peakBps: 0,
    lastSampleBps: 0,
    lastBytes: 0,
    connection: null,
    iceCandidates: null,
    rttMs: null,
    dataChannelState: null,
    protocol: null,
    outgoingCapacityBps: null,
    incomingCapacityBps: null,
    sctpMaxMessageSize: null,
    lastChunkSizeBytes: null,
    lastWindowChunks: null,
    lastBufferedBytes: null,
    lastStalls: null,
    lastTotalBytes: null,
    networkType: null,
    retransmissionsSent: null,
    maxInFlightBytes: null,
    ackLatencyMs: null,
    localAddress: null,
    remoteAddress: null,
    shaVerified: null,
    result: null,
    notes: '',
  }));
}

function load(): DeviceTestSnapshot {
  const open = snapshot?.open ?? false;
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { records?: DeviceTestRecord[]; meta?: DeviceTestMeta };
        // Rebuild from the matrix so case definitions stay authoritative;
        // keep any persisted measured values by caseId.
        const byId = new Map((saved.records || []).map((r) => [r.caseId, r]));
        const records = defaultRecords().map((def) => ({ ...def, ...(byId.get(def.caseId) || {}) }));
        return { records, meta: { ...DEFAULT_META, ...(saved.meta || {}) }, open };
      }
    } catch {
      // corrupted storage — fall through to defaults
    }
  }
  return { records: defaultRecords(), meta: { ...DEFAULT_META }, open };
}

function persist(force = true): void {
  if (typeof window === 'undefined') return;
  // The 5 Hz sampler throttles disk writes to 1/s (state stays live in
  // memory); every explicit user action force-persists immediately.
  const now = Date.now();
  if (!force && now - lastPersistAt < 1000) return;
  lastPersistAt = now;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ records: snapshot?.records || [], meta: snapshot?.meta || DEFAULT_META })
    );
  } catch {
    // storage full/unavailable — session-only operation is fine
  }
}

function commit(next: Partial<DeviceTestSnapshot>, force = true): void {
  snapshot = { ...(snapshot || load()), ...next } as DeviceTestSnapshot;
  persist(force);
  listeners.forEach((l) => l());
}

export function subscribeDeviceTest(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function getDeviceTestSnapshot(): DeviceTestSnapshot {
  if (snapshot === null) snapshot = load();
  return snapshot;
}

export function getServerDeviceTestSnapshot(): DeviceTestSnapshot {
  return { records: defaultRecords(), meta: { ...DEFAULT_META }, open: false };
}

export function openDeviceTest(): void {
  commit({ open: true });
}

export function closeDeviceTest(): void {
  commit({ open: false });
}

function findRecord(caseId: string): DeviceTestRecord | undefined {
  return getDeviceTestSnapshot().records.find((r) => r.caseId === caseId);
}

/** The record currently armed (only one case may be armed at a time). */
function armedRecord(): DeviceTestRecord | undefined {
  return getDeviceTestSnapshot().records.find((r) => r.armedAt !== null && r.endedAt === null);
}

function updateRecord(caseId: string, patch: Partial<DeviceTestRecord>, force = true): void {
  const records = getDeviceTestSnapshot().records.map((r) => (r.caseId === caseId ? { ...r, ...patch } : r));
  commit({ records }, force);
}

export function armTest(caseId: string): void {
  const def = DEVICE_TEST_CASES.find((c) => c.id === caseId);
  if (!def) return;
  const now = Date.now();
  const records = getDeviceTestSnapshot().records.map((r) =>
    r.caseId === caseId
      ? {
          ...defaultRecords().find((d) => d.caseId === caseId)!,
          caseId: r.caseId,
          title: def.title,
          armedAt: now,
          notes: r.notes, // keep the owner's notes across re-arms
        }
      : r.endedAt === null && r.armedAt !== null
        ? { ...r, armedAt: null } // arming another case disarms this one
        : r
  );
  commit({ records });
  startSampler();
}

export function markTest(caseId: string, result: 'passed' | 'failed'): void {
  const rec = findRecord(caseId);
  if (!rec) return;
  // A failed SHA-256 verification can never be marked Passed.
  if (result === 'passed' && rec.shaVerified === false) return;
  updateRecord(caseId, { result, endedAt: Date.now() });
}

export function setTestNotes(caseId: string, notes: string): void {
  updateRecord(caseId, { notes });
}

export function setDeviceTestMeta(patch: Partial<DeviceTestMeta>): void {
  commit({ meta: { ...getDeviceTestSnapshot().meta, ...patch } });
}

export function resetTest(caseId: string): void {
  const def = DEVICE_TEST_CASES.find((c) => c.id === caseId);
  if (!def) return;
  updateRecord(caseId, { ...defaultRecords().find((d) => d.caseId === caseId)! });
}

export function clearAllTests(): void {
  commit({ records: defaultRecords() });
}

/** Real engine completion — called from the app's existing callback. */
export function onTestTransferComplete(info: {
  transferId?: string;
  name: string;
  size: number;
  direction: 'sent' | 'received';
  hash?: string;
}): void {
  const rec = armedRecord();
  if (!rec) return; // no armed case — the normal journey is unaffected
  const entry: DeviceTestFileRecord = {
    transferId: info.transferId || '',
    name: info.name,
    size: info.size,
    sha256: info.hash || null,
  };
  const files = [...rec.files, entry];
  const startedAt =
    rec.transferStartedAt ?? rec.armedAt; // honest fallback: arm time
  const totalBytes = rec.totalBytes + info.size;
  updateRecord(rec.caseId, {
    files,
    totalBytes,
    transferEndedAt: Date.now(),
    transferStartedAt: startedAt,
  });
}

/** Receiver's real VERIFY verdict — wired from the app's existing callback. */
export function onTestTransferVerified(transferId: string, match: boolean): void {
  const rec = armedRecord();
  if (!rec) return;
  const files = rec.files.map((f) => (f.transferId === transferId ? { ...f, sha256: f.sha256 } : f));
  const anyMatch = rec.files.some((f) => f.transferId === transferId) ? match : null;
  const shaVerified =
    anyMatch === null ? rec.shaVerified : match && (rec.shaVerified ?? true);
  updateRecord(rec.caseId, { files, shaVerified });
}

function startSampler(): void {
  if (sampler !== null || typeof window === 'undefined') return;
  sampler = setInterval(sampleDeviceTestNow, SAMPLE_MS);
}

/** One real telemetry sample. Exported for tests. */
export function sampleDeviceTestNow(): void {
  if (typeof window === 'undefined') return;
  const rec = armedRecord();
  if (!rec) {
    if (sampler !== null) {
      clearInterval(sampler);
      sampler = null;
    }
    return;
  }
  const t = window.__NEXDROP_TELEMETRY__;
  if (!t) return;
  const sender = t.sender;
  const receiver = t.receiver;
  const bytes = sender?.bytesSent ?? receiver?.bytesReceived ?? 0;
  const bps = sender?.throughputBps ?? receiver?.throughputBps ?? 0;
  const transport = t.transport;
  const ice = transport?.localCandidateType && transport?.remoteCandidateType
    ? `${transport.localCandidateType}↔${transport.remoteCandidateType}`
    : null;
  const patch: Partial<DeviceTestRecord> = {
    peakBps: Math.max(rec.peakBps, bps || 0),
    lastSampleBps: bps || 0,
    lastBytes: Math.max(rec.lastBytes, bytes),
    transferStartedAt: rec.transferStartedAt ?? (bytes > 0 ? Date.now() : null),
    connection: transport?.transport ?? rec.connection,
    iceCandidates: ice ?? rec.iceCandidates,
    rttMs: transport?.rttMs ?? rec.rttMs,
    dataChannelState: t.dataChannelState ?? rec.dataChannelState,
    protocol: transport?.protocol ?? rec.protocol,
    outgoingCapacityBps:
      transport?.outgoingBitrateBps != null ? transport.outgoingBitrateBps / 8 : rec.outgoingCapacityBps,
    incomingCapacityBps:
      transport?.incomingBitrateBps != null ? transport.incomingBitrateBps / 8 : rec.incomingCapacityBps,
    sctpMaxMessageSize: transport?.sctpMaxMessageSize ?? rec.sctpMaxMessageSize,
    lastChunkSizeBytes: sender?.chunkSize ?? rec.lastChunkSizeBytes,
    lastWindowChunks: sender?.windowChunks ?? rec.lastWindowChunks,
    lastBufferedBytes: sender?.bufferedAmount ?? rec.lastBufferedBytes,
    lastStalls: sender?.stalls ?? rec.lastStalls,
    lastTotalBytes: sender?.totalBytes ?? rec.lastTotalBytes,
    networkType: transport?.networkType ?? rec.networkType,
    retransmissionsSent: transport?.retransmissionsSent ?? rec.retransmissionsSent,
    maxInFlightBytes:
      sender?.inFlightBytes != null
        ? Math.max(rec.maxInFlightBytes ?? 0, sender.inFlightBytes)
        : rec.maxInFlightBytes,
    ackLatencyMs: sender?.ackLatencyMs ?? rec.ackLatencyMs,
    localAddress: transport?.localAddress ?? rec.localAddress,
    remoteAddress: transport?.remoteAddress ?? rec.remoteAddress,
  };
  updateRecord(rec.caseId, patch, false);
}

/** Average throughput derived only from real measurements: bytes / duration. */
export function deviceTestAvgBps(r: DeviceTestRecord): number | null {
  if (!r.totalBytes || !r.transferStartedAt || !r.transferEndedAt) return null;
  const seconds = (r.transferEndedAt - r.transferStartedAt) / 1000;
  if (seconds <= 0) return null;
  return r.totalBytes / seconds;
}

export function deviceTestDurationSeconds(r: DeviceTestRecord): number | null {
  const start = r.transferStartedAt ?? r.armedAt;
  const end = r.transferEndedAt ?? r.endedAt;
  if (!start || !end) return null;
  const s = (end - start) / 1000;
  return s >= 0 ? s : null;
}


/** Honest aggregation for the report — computed only from real recorded values. */
export function buildDeviceTestReport(): string {
  const snap = getDeviceTestSnapshot();
  const { records, meta } = snap;
  const MB = 1e6;

  const fmtMBps = (bps: number | null | undefined): string =>
    bps && bps > 0 ? `${(bps / MB).toFixed(2)} MB/s` : '—';
  const fmtBytes = (b: number): string =>
    b > 0 ? (b >= MB ? `${(b / MB).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`) : '—';
  const verdict = (r: DeviceTestRecord): string =>
    r.result === 'passed' ? '✓' : r.result === 'failed' ? '✗' : '—';

  const transferTests = records.filter((r) => deviceTestAvgBps(r) !== null);
  const avgOfAvgs =
    transferTests.length > 0
      ? transferTests.reduce((sum, r) => sum + (deviceTestAvgBps(r) || 0), 0) / transferTests.length
      : null;
  const maxPeak = records.reduce((m, r) => Math.max(m, r.peakBps), 0);

  const shaLines = records.filter((r) => r.files.length > 0);
  const shaAggregate = shaLines.some((r) => r.shaVerified === false)
    ? 'FAILED — at least one completed file failed verification'
    : shaLines.some((r) => r.shaVerified === true)
      ? 'Verified ✓ (engine SHA-256 on every completed file)'
      : '— (no completed transfer recorded a verification verdict)';

  const measured = records.find((r) => r.connection && r.files.length > 0);
  const measuredConn = measured?.connection;
  const connLabel =
    measuredConn === 'local' ? 'Local Direct (getStats() host↔host over a private/mDNS address — same LAN)'
    : measuredConn === 'internet' ? 'Internet Direct (getStats() srflx/prflx NAT traversal, or public host address)'
    : measuredConn === 'relay' ? 'Relay (getStats() relay candidates)'
    : 'Unknown (no measured transport evidence)';
  // Measured bottleneck evidence: protocol + network capacity ceiling.
  const fmtCapacity = (bps: number | null | undefined): string =>
    bps && bps > 0 ? fmtMBps(bps) : 'not reported by browser';
  // PERFORMANCE section — every value is the last real engine/getStats
  // sample captured while the test ran. Nothing is synthesized.
  const fmtKiB = (b: number | null | undefined): string =>
    b && b > 0 ? `${Math.round(b / 1024)} KiB` : 'not sampled';
  const fmtMB = (b: number | null | undefined): string =>
    b != null && b > 0 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : 'not sampled';
  const measuredAvg = measured ? deviceTestAvgBps(measured) : null;
  const anySha = records.some((r) => r.shaVerified === true);
  const anyShaFail = records.some((r) => r.shaVerified === false);
  const shaState = anyShaFail
    ? 'FAILED (at least one transfer failed verification)'
    : anySha
      ? 'VERIFIED (all completed transfers verified)'
      : 'not recorded (no completed transfer yet)';
  const transferred = measured ? measured.lastBytes : 0;
  const transferredTotal = measured?.lastTotalBytes ?? measured?.totalBytes ?? 0;
  const evidenceLines = [
    'PERFORMANCE (last measured samples):',
    `Transport: ${measuredConn === 'local' ? 'LOCAL DIRECT' : measuredConn === 'internet' ? 'INTERNET DIRECT' : measuredConn === 'relay' ? 'RELAY' : 'Unknown'}`,
    `Protocol: WebRTC DataChannel (${measured?.protocol ? measured.protocol.toUpperCase() : 'protocol not reported'})`,
    `ICE: ${measured?.iceCandidates ?? 'not reported'}`,
    `RTT: ${measured?.rttMs != null ? `${measured.rttMs} ms` : 'not reported'}`,
    `Buffered: ${fmtMB(measured?.lastBufferedBytes)}`,
    `Chunk: ${fmtKiB(measured?.lastChunkSizeBytes)}`,
    `Window: ${measured?.lastWindowChunks != null ? `${measured.lastWindowChunks} chunks` : 'not sampled'}`,
    `Actual: ${measuredAvg != null ? fmtMBps(measuredAvg) : 'not measured'}`,
    `Peak: ${measured && measured.peakBps > 0 ? fmtMBps(measured.peakBps) : 'not measured'}`,
    `Transferred: ${fmtBytes(transferred)} / ${fmtBytes(transferredTotal)}`,
    `Stalls: ${measured?.lastStalls != null ? String(measured.lastStalls) : 'not sampled'}`,
    `Path network: ${measured?.networkType ?? 'not exposed by browser (candidate networkType)'} — 5G/Wi-Fi status icons are NOT WebRTC path evidence`,
    `Candidate addresses: ${measured?.localAddress ?? '—'} → ${measured?.remoteAddress ?? '—'} (mDNS .local = same LAN)`,
    `Retransmissions: ${measured?.retransmissionsSent != null ? String(measured.retransmissionsSent) : 'not exposed'} (candidate-pair loss evidence)`,
    `In-flight peak: ${measured?.maxInFlightBytes != null && measured.maxInFlightBytes > 0 ? `${(measured.maxInFlightBytes / 1048576).toFixed(2)} MiB (window-fill proof)` : 'not sampled'}`,
    `ACK latency: ${measured?.ackLatencyMs != null && measured.ackLatencyMs > 0 ? `${Math.round(measured.ackLatencyMs)} ms (send→durable-ACK EWMA)` : 'not sampled'}`,
    `Network capacity out/in: ${fmtCapacity(measured?.outgoingCapacityBps)} / ${fmtCapacity(measured?.incomingCapacityBps)}`,
    `SCTP max message size: ${measured?.sctpMaxMessageSize ? `${measured.sctpMaxMessageSize} bytes (read from pc.sctp)` : 'not readable'}`,
    `SHA-256: ${shaState}`,
  ];

  const caseLines = records.map((r) => {
    const avg = deviceTestAvgBps(r);
    const dur = deviceTestDurationSeconds(r);
    const details: string[] = [];
    if (r.files.length > 0) {
      details.push(`${fmtBytes(r.totalBytes)} total`);
      if (dur !== null) details.push(`${dur.toFixed(2)} s`);
      if (avg !== null) details.push(`avg ${fmtMBps(avg)}`);
      if (r.peakBps > 0) details.push(`peak ${fmtMBps(r.peakBps)}`);
      details.push(r.shaVerified === false ? 'SHA-256 FAILED' : r.shaVerified === true ? 'SHA-256 ✓' : 'SHA-256 not recorded');
    }
    return `${r.caseId} ${verdict(r)} ${r.title}${details.length ? ' — ' + details.join(', ') : r.result ? '' : ' (not run)'}`;
  });

  const lines = [
    'NEXDROP PHYSICAL DEVICE REPORT',
    `Generated: ${new Date().toString()}`,
    '',
    'This report records ONLY owner-run physical-device results.',
    'CI verification (build, real-ICE e2e, benchmark) and browser automation',
    'are reported separately by CI and are not merged into this file.',
    '',
    `Device A: ${meta.deviceA || '— (not entered)'}`,
    `Device B: ${meta.deviceB || '— (not entered)'}`,
    `Network: ${meta.network || '— (not entered)'}`,
    `Connection: ${connLabel}`,
    ...evidenceLines,
    '',
    'Tests:',
    ...caseLines,
    '',
    `Average speed: ${fmtMBps(avgOfAvgs)}`,
    `Peak speed: ${maxPeak > 0 ? fmtMBps(maxPeak) : '—'}`,
    `SHA-256: ${shaAggregate}`,
    `Pause/Resume: ${verdict(records[5]) === '—' ? '—' : verdict(records[5]) === '✓' ? 'PASS' : 'FAIL'}`,
    `Reconnect: ${verdict(records[9]) === '—' ? '—' : verdict(records[9]) === '✓' ? 'PASS' : 'FAIL'}`,
  ];
  if (meta.extra) lines.push('', `Notes: ${meta.extra}`);
  return lines.join('\n');
}

/** Test-only: reset module state and stop the sampler. */
export function __resetDeviceTestForTests(): void {
  if (sampler !== null && typeof window !== 'undefined') {
    clearInterval(sampler);
  }
  sampler = null;
  snapshot = null;
}

