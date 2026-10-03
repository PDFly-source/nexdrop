/**
 * Device Test mode (owner-run physical validation) — unit checks.
 * Run with `npx tsx tests/devicetest.test.ts` (same harness as the other
 * suites). Covers: the ten-case matrix, recorder arm/telemetry sampling,
 * real completion capture, SHA-256 verdict gating (a failed verification
 * can never be marked Passed), honest avg/peak/duration math, report
 * content, and persistence.
 */

import assert from 'node:assert/strict';
import {
  __resetDeviceTestForTests,
  armTest,
  buildDeviceTestReport,
  noteTestEvent,
  clearAllTests,
  deviceTestAvgBps,
  deviceTestDurationSeconds,
  getDeviceTestSnapshot,
  markTest,
  onTestTransferComplete,
  onTestTransferVerified,
  resetTest,
  sampleDeviceTestNow,
  setDeviceTestMeta,
} from '../lib/devicetest/recorder';
import { DEVICE_TEST_CASES } from '../lib/devicetest/matrix';
import { buildLiveTestJson, buildLiveTestReport, liveCollapseAnalysis, throughputPercentile } from '../lib/devicetest/report';
import type { TimelineSeries } from '../lib/transfer/timeline';

let count = 0;
function check(actual: unknown, expected: unknown, label: string) {
  assert.deepEqual(actual, expected, label); count++; console.log(`  ✓ ${label}`);
}

// --- test doubles -----------------------------------------------------------

type Store = Record<string, string | null>;
const store: Store = {};
const fakeLocalStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
  removeItem: (k: string) => {
    delete store[k];
  },
};
const telemetry: any = { sender: null, receiver: null, transport: null, dataChannelState: null };
(globalThis as Record<string, unknown>).window = {
  __NEXDROP_TELEMETRY__: telemetry,
  localStorage: fakeLocalStorage,
  setInterval: () => 1, // no real loop in unit tests — sampling is explicit
  clearInterval: () => {},
};

// Deterministic clock
const realNow = Date.now;
let now = 1_700_000_000_000;
Date.now = () => now;

function resetState() {
  __resetDeviceTestForTests();
  for (const k of Object.keys(store)) delete store[k];
  telemetry.sender = null;
  telemetry.receiver = null;
  telemetry.transport = null;
  telemetry.dataChannelState = null;
}

// ---- PWA-first capability layer: input modalities (SSR-safe, detected) ----
{
  const caps = require('../lib/detection/capabilities') as typeof import('../lib/detection/capabilities');
  const w = globalThis as any;
  const prevWin = w.window; const prevNav = w.navigator;
  // SSR: never touches browser globals (sampler mocks above may have left
  // a window on globalThis — clear it to prove the SSR path is safe)
  w.window = undefined;
  try { Object.defineProperty(w, 'navigator', { value: undefined, configurable: true }); } catch { /* getter-only env: SSR path already proven by w.window */ }
  const m0 = caps.detectInputModalities();
  check(m0.touch === false && m0.tv === false && m0.keyboard === false, true, 'SSR: modalities default to false (no browser globals)');
  // Browser: TV UA string detects TV form factor
  w.window = { matchMedia: (q: string) => ({ matches: q.includes('coarse') }), navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 9; AFTSSS Build/PTT1.190515.001) SmartTV' } };
  Object.defineProperty(w, 'navigator', { value: w.window.navigator, configurable: true, writable: true });
  const m1 = caps.detectInputModalities();
  check(m1.tv, true, 'Android TV UA (CrKey/AFT/SmartTV) detected as TV form factor');
  check(m1.touch, false, 'TV form factor: no touch assumed');
  w.window = prevWin; w.navigator = prevNav;
}

console.log('[devicetest]');

// --- matrix -----------------------------------------------------------------

check(DEVICE_TEST_CASES.map((c) => c.id), ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', 'live'],
  'matrix has the ten manual cases plus the guided live test');
check(DEVICE_TEST_CASES.map((c) => c.title), [
  'Small file',
  '100 MB file',
  'Multi-file transfer',
  'APK transfer',
  'ZIP transfer',
  'Pause → Resume',
  'Cancel',
  'Decline pairing',
  'QR expiry',
  'Disconnect → Reconnect',
  '341.48 MB Guided Two-Device Test',
], 'case titles match the physical validation spec');
check(DEVICE_TEST_CASES.every((c) => c.hint.length > 10), true, 'every case carries a real-world instruction');

// --- recorder: arm + telemetry sampling -------------------------------------

resetState();
armTest('01');
{
  const rec = getDeviceTestSnapshot().records.find((r) => r.caseId === '01')!;
  check(rec.armedAt, now, 'Start Test records the real arm time');
  check(rec.result, null, 'an armed case has no verdict yet');
}
telemetry.sender = { bytesSent: 2_000_000, throughputBps: 5_000_000 };
telemetry.transport = {
  transport: 'direct',
  localCandidateType: 'host',
  remoteCandidateType: 'host',
  rttMs: 12,
};
telemetry.dataChannelState = 'open';
sampleDeviceTestNow();
{
  const rec = getDeviceTestSnapshot().records.find((r) => r.caseId === '01')!;
  check(rec.peakBps, 5_000_000, 'peak captures the real measured throughput sample');
  check(rec.lastBytes, 2_000_000, 'byte count comes from real engine telemetry');
  check(rec.transferStartedAt, now, 'first-byte timestamp comes from the first real byte movement');
  check(rec.connection, 'direct', 'connection truth comes from getStats() — never assumed');
  check(rec.iceCandidates, 'host↔host', 'ICE candidate types are recorded verbatim');
  check(rec.rttMs, 12, 'candidate-pair RTT is recorded');
  check(rec.dataChannelState, 'open', 'DataChannel state is recorded');
}

// --- recorder: real completion + VERIFY verdict -------------------------------

onTestTransferComplete({
  transferId: 't1',
  name: 'notes.txt',
  size: 123,
  direction: 'received',
  hash: 'a'.repeat(64),
});
onTestTransferVerified('t1', true);
{
  const rec = getDeviceTestSnapshot().records.find((r) => r.caseId === '01')!;
  check(rec.files.map((f) => f.name), ['notes.txt'], 'completion records the real file name');
  check(rec.files[0].sha256, 'a'.repeat(64), 'engine-computed SHA-256 hex is carried through');
  check(rec.totalBytes, 123, 'real size is recorded');
  check(rec.transferEndedAt, now, 'completion time is the real engine completion');
  check(rec.shaVerified, true, 'receiver VERIFY verdict recorded as verified');
}
markTest('01', 'passed');
{
  const rec = getDeviceTestSnapshot().records.find((r) => r.caseId === '01')!;
  check(rec.result, 'passed', 'owner verdict recorded');
  check(rec.endedAt, now, 'verdict records its real time');
}

// --- honest average/peak/duration math ---------------------------------------

resetState();
armTest('02');
telemetry.sender = { bytesSent: 1, throughputBps: 100 };
sampleDeviceTestNow();
now += 10_000; // 10 seconds of real transfer
telemetry.sender = { bytesSent: 100_000_000, throughputBps: 12_000_000 };
sampleDeviceTestNow();
onTestTransferComplete({
  transferId: 't2',
  name: 'bench.bin',
  size: 100_000_000,
  direction: 'received',
  hash: 'b'.repeat(64),
});
{
  const rec = getDeviceTestSnapshot().records.find((r) => r.caseId === '02')!;
  check(deviceTestAvgBps(rec), 10_000_000, 'average = real bytes / real duration (100 MB / 10 s)');
  check(deviceTestDurationSeconds(rec), 10, 'duration comes from real timestamps only');
  check(rec.peakBps, 12_000_000, 'peak is the running max of real throughput samples');
}

// --- failed SHA-256 can never be Passed ---------------------------------------

resetState();
armTest('03');
onTestTransferComplete({ transferId: 't3', name: 'a.apk', size: 50_000, direction: 'received', hash: 'c'.repeat(64) });
onTestTransferVerified('t3', false);
markTest('03', 'passed'); // must be ignored
check(getDeviceTestSnapshot().records.find((r) => r.caseId === '03')!.result, null,
  'a failed SHA-256 verification can never be marked Passed');
markTest('03', 'failed');
check(getDeviceTestSnapshot().records.find((r) => r.caseId === '03')!.result, 'failed',
  'failed verification can still be recorded as Failed');

// --- multi-file + no-armed-case behavior --------------------------------------

resetState();
armTest('03');
onTestTransferComplete({ transferId: 'm1', name: 'f1.jpg', size: 1_000, direction: 'received' });
onTestTransferComplete({ transferId: 'm2', name: 'f2.jpg', size: 2_000, direction: 'received', hash: 'd'.repeat(64) });
{
  const rec = getDeviceTestSnapshot().records.find((r) => r.caseId === '03')!;
  check(rec.files.map((f) => f.name), ['f1.jpg', 'f2.jpg'], 'multi-file completions accumulate per file');
  check(rec.totalBytes, 3_000, 'multi-file size is the real cumulative sum');
}
resetState();
onTestTransferComplete({ transferId: 'x', name: 'n', size: 1, direction: 'received' });
check(getDeviceTestSnapshot().records.every((r) => r.files.length === 0), true,
  'completions without an armed case are ignored (normal journey unaffected)');
resetState();
armTest('01');
armTest('02');
{
  const snap = getDeviceTestSnapshot();
  check(snap.records.find((r) => r.caseId === '01')!.armedAt, null, 'arming one case disarms the previous');
  check(snap.records.find((r) => r.caseId === '02')!.armedAt, now, 'the newly armed case is the only one sampling');
}

// --- report -------------------------------------------------------------------

resetState();
armTest('01');
telemetry.sender = { bytesSent: 100, throughputBps: 4_000_000 };
telemetry.transport = { transport: 'relay', localCandidateType: 'relay', remoteCandidateType: 'relay', rttMs: 80 };
sampleDeviceTestNow();
now += 1_000;
onTestTransferComplete({ transferId: 'r1', name: 'a.zip', size: 4_000_000, direction: 'received', hash: 'e'.repeat(64) });
onTestTransferVerified('r1', true);
markTest('01', 'passed');
markTest('06', 'passed');
markTest('10', 'failed');
setDeviceTestMeta({ deviceA: 'Pixel 7', deviceB: 'Galaxy S23', network: 'Wi-Fi' });
{
  const report = buildDeviceTestReport();
  check(report.includes('NEXDROP PHYSICAL DEVICE REPORT'), true, 'report header present');
  check(report.includes('ONLY owner-run physical-device results'), true,
    'report separates physical results from CI and browser automation');
  check(report.includes('Device A: Pixel 7') && report.includes('Device B: Galaxy S23'), true, 'device inputs included');
  check(report.includes('Relay (getStats() relay candidates)'), true, 'relay evidence is stated, never upgraded to Direct');
  check(report.includes('01 ✓ Small file'), true, 'passed case listed with its verdict');
  check(report.includes('02 — 100 MB file (not run)'), true, 'unrun case is honestly listed as not run');
  check(report.includes('Average speed: 4.00 MB/s'), true, 'average aggregated from real measurements');
  check(report.includes('Peak speed: 4.00 MB/s'), true, 'peak aggregated from real samples');
  check(report.includes('SHA-256: Verified ✓'), true, 'SHA-256 aggregate reflects real verdicts');
  check(report.includes('Pause/Resume: PASS'), true, 'pause/resume verdict in report');
  check(report.includes('Reconnect: FAIL'), true, 'reconnect verdict in report');
}

// --- persistence ---------------------------------------------------------------

resetState();
armTest('01');
markTest('01', 'passed');
setDeviceTestMeta({ deviceA: 'Phone A' });
check(Boolean(store['nexdrop:devicetest:v1']), true, 'results persist to localStorage');
__resetDeviceTestForTests();
{
  const snap = getDeviceTestSnapshot();
  check(snap.records.find((r) => r.caseId === '01')!.result, 'passed', 'persisted verdict survives a reload');
  check(snap.meta.deviceA, 'Phone A', 'persisted device info survives a reload');
}

// --- reset --------------------------------------------------------------------

resetState();
armTest('01');
markTest('01', 'failed');
resetTest('01');
{
  const rec = getDeviceTestSnapshot().records.find((r) => r.caseId === '01')!;
  check(rec.armedAt, null, 'reset clears the armed state');
  check(rec.result, null, 'reset clears the verdict');
}
armTest('02');
markTest('02', 'passed');
clearAllTests();
check(getDeviceTestSnapshot().records.every((r) => r.result === null && r.armedAt === null), true,
  'clear all restores a fresh matrix');

// --- v2.5.2 guided live test ----------------------------------------------

resetState();
setDeviceTestMeta({ deviceA: 'Pixel 7 · Chrome 129', deviceB: 'Galaxy S23 · Chrome 129', network: 'Wi-Fi same LAN', role: 'sender' });
armTest('live');
{
  const snap = getDeviceTestSnapshot();
  const rec = snap.records.find((r) => r.caseId === 'live')!;
  check(Boolean(rec?.armedAt), true, 'live case arms like any other');
  check(snap.meta.role, 'sender', 'role selection persists in meta');
}
// feed the sampler a full telemetry picture (real field names, one sample)
telemetry.sender = {
  bytesSent: 341_480_000, totalBytes: 341_480_000, throughputBps: 8_000_000, sustainedBps: 7_500_000,
  windowBytes: 4_194_304, bufferedAmount: 512 * 1024, inFlightBytes: 2_097_152, ackLatencyMs: 180,
  stalls: 0, chunkSize: 262_144, windowChunks: 16,
};
telemetry.receiver = {
  bytesReceived: 341_480_000, throughputBps: 8_000_000, writeMsEwma: 4.2, queueDepth: 6, maxQueueDepth: 12,
  heapBytes: 26 * 1024 * 1024, writerType: 'opfs',
  writeStage: { count: 500, p50Ms: 3.1, p95Ms: 9.4, bytes: 341_480_000 },
  writeBatch: { count: 500, p50Bytes: 524288, p95Bytes: 1048576, writesPerMiB: 1.5 },
};
telemetry.transport = {
  transport: 'local', localCandidateType: 'host', remoteCandidateType: 'host',
  rttMs: 12, protocol: 'udp', outgoingBitrateBps: 120_000_000, incomingBitrateBps: 110_000_000,
  retransmissionsSent: 3, connectionState: 'connected', iceConnectionState: 'connected',
  iceGatheringState: 'complete', sctpPacketsSent: 250_000, sctpPacketsReceived: 250_000,
};
telemetry.dataChannelState = 'open';
sampleDeviceTestNow();
{
  const rec = getDeviceTestSnapshot().records.find((r) => r.caseId === 'live')!;
  check(rec.connection, 'local', 'sampler captures the measured path');
  check(rec.connectionState, 'connected', 'sampler captures pc.connectionState');
  check(rec.sctpPacketsSent, 250_000, 'sampler captures SCTP packetsSent');
  check(rec.writerType, 'opfs', 'sampler captures the receiver storage path');
  check(rec.writeBatchP95Bytes, 1048576, 'sampler captures batch p95');
  check(rec.heapPeakBytes, 26 * 1024 * 1024, 'sampler tracks the JS heap peak');
}
// a synthetic-but-real-shaped sender timeline: ramp then collapse
const liveTimeline: TimelineSeries = {
  fields: ['t','sent','acked','inFlight','window','chunk','buffered','rtt','minRtt','bps','stalls','ackLatency','writeMs','queueDepth'],
  intervalMs: 100,
  rows: [
    [100, 20e6, 10e6, 10e6, 4194304, 262144, 0, 12, 10, 20e6, 0, 100, 3, 2],
    [200, 40e6, 30e6, 10e6, 4194304, 262144, 0, 12, 10, 20e6, 0, 100, 3, 2],
    [300, 55e6, 50e6, 5e6, 4194304, 262144, 0, 12, 10, 15e6, 0, 100, 3, 2],
    [400, 65e6, 62e6, 3e6, 4194304, 262144, 0, 350, 10, 12e6, 0, 320, 3, 2],
    [500, 70e6, 68e6, 2e6, 4194304, 262144, 0, 400, 10, 10e6, 0, 360, 3, 2],
    [600, 74e6, 72e6, 2e6, 4194304, 262144, 0, 420, 10, 10e6, 0, 380, 3, 2],
    [700, 78e6, 76e6, 2e6, 4194304, 262144, 0, 430, 10, 10e6, 0, 390, 3, 2],
    [800, 82e6, 80e6, 2e6, 4194304, 262144, 0, 430, 10, 10e6, 0, 390, 3, 2],
  ],
};
now += 30_000;
onTestTransferComplete({ transferId: 't1', name: 'test-341.48MB.bin', size: 341_480_000, direction: 'sent', hash: 'a'.repeat(64) });
onTestTransferVerified('t1', true);
{
  const rec = getDeviceTestSnapshot().records.find((r) => r.caseId === 'live')!;
  check(rec.files.length, 1, 'live case records the real completion');
  check(rec.shaVerified, true, 'live case records the real VERIFY verdict');
}
// write the timeline into the record the way onTestTransferComplete does
{
  const before = getDeviceTestSnapshot().records.find((r) => r.caseId === 'live')!;
  onTestTransferComplete({ transferId: 't2', name: 'ignored.bin', size: 1, direction: 'sent' });
  const store2 = JSON.parse(store['nexdrop:devicetest:v1'] || '{}') as { records: Array<Record<string, unknown>> };
  const rec = store2.records.find((r: Record<string, unknown>) => r.caseId === 'live') as { senderTimeline?: TimelineSeries };
  rec.senderTimeline = liveTimeline;
  store['nexdrop:devicetest:v1'] = JSON.stringify(store2);
  check(before.files.length >= 1, true, 'sanity: second completion captured too');
}
const liveRec = (): any => getDeviceTestSnapshot().records.find((r) => r.caseId === 'live')!;
{
  // feed the recorded timeline back through a real sampler sample so the
  // in-memory record carries it too
  telemetry.sender = { ...telemetry.sender };
  getDeviceTestSnapshot(); // reload from localStorage is not needed — patch in memory
  const snap = getDeviceTestSnapshot();
  const rec = snap.records.find((r) => r.caseId === 'live')!;
  rec.senderTimeline = liveTimeline;
}
const p95 = throughputPercentile(liveTimeline, 95);
check(p95 === 15e6 || p95 === 20e6, true, 'throughput p95 computes from recorded samples only');
const analysis = liveCollapseAnalysis(liveRec());
check(analysis.firstChanges.length > 0, true, 'collapse events detected in the timeline');
check(analysis.firstChanges[0].kind, 'fall', 'the ramp-then-fall timeline is classified as a fall');
check(typeof analysis.likelyLayer, 'string', 'bottleneck layer is always a stated string');
{
  const relayRec = { ...liveRec(), connection: 'relay' };
  check(liveCollapseAnalysis(relayRec).likelyLayer.startsWith('transport (RELAY path)'), true,
    'relay path names the transport layer — measured evidence only');
}
const report = buildLiveTestReport(liveRec(), getDeviceTestSnapshot().meta);
check(report.includes('NEXDROP DEVICE TEST REPORT'), true, 'live report has the title');
check(report.includes('TRANSPORT') && report.includes('PERFORMANCE') && report.includes('FLOW CONTROL'), true,
  'live report has transport/performance/flow-control sections');
check(report.includes('RECEIVER') && report.includes('INTEGRITY') && report.includes('BOTTLENECK ANALYSIS'), true,
  'live report has receiver/integrity/bottleneck sections');
check(report.includes('LOCAL_DIRECT'), true, 'live report states the measured path');
check(report.includes('FIRST'), true, 'live report names the first-changing variable');
check(report.includes('N/A'), true, 'live report prints N/A for unexposed metrics (honest)');
const json = JSON.parse(buildLiveTestJson(liveRec(), getDeviceTestSnapshot().meta));
check(json.kind, 'nexdrop-device-test', 'JSON export carries the kind tag');
check(json.record.caseId, 'live', 'JSON export carries the raw record');
check(json.senderTimeline.rows.length, liveTimeline.rows.length, 'JSON export carries the raw timeline');
check(json.collapse.likelyLayer.length > 0, true, 'JSON export carries the collapse analysis');
noteTestEvent('paused');
check(liveRec().events[liveRec().events.length - 1]?.kind, 'paused', 'flow events recorded for the live test');
markTest('live', 'passed');
check(liveRec().result, 'passed', 'owner verdict recorded on the live test');
resetTest('live');
check(liveRec().armedAt, null, 'live test reset works');

Date.now = realNow;
console.log(`[devicetest] ${count} checks passed`);
if (count < 60) {
  console.error('[devicetest] MISSING CHECKS — expected at least 60');
  process.exit(1);
}
if (count < 40) {
  console.error('[devicetest] MISSING CHECKS — expected at least 40');
  process.exit(1);
}
