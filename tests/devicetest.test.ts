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

console.log('[devicetest]');

// --- matrix -----------------------------------------------------------------

check(DEVICE_TEST_CASES.map((c) => c.id), ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'],
  'matrix has exactly the ten required cases');
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

Date.now = realNow;
console.log(`[devicetest] ${count} checks passed`);
if (count < 40) {
  console.error('[devicetest] MISSING CHECKS — expected at least 40');
  process.exit(1);
}
