/**
 * v2.5.2 Settings UI integration — automated checks.
 * Run with `npx tsx tests/devicetest-ui.test.ts` (same harness as the other
 * suites). Verifies, without a browser:
 *  - the production Settings surface (SettingsWorkspace) renders the
 *    Advanced section with the Device Test & Diagnostics entry, the exact
 *    CTA button, and the requested subtitle;
 *  - the button is wired to the ONE existing openDeviceTest overlay (no
 *    second diagnostics implementation anywhere);
 *  - all pre-existing Settings sections remain;
 *  - the ?diag=1 developer panel stays separate (dev gating untouched,
 *    no developer-only controls leak into Settings);
 *  - opening the overlay actually flips the store the DeviceTestPanel
 *    renders from.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  __resetDeviceTestForTests,
  closeDeviceTest,
  getDeviceTestSnapshot,
  openDeviceTest,
} from '../lib/devicetest/recorder';
import { DEVICE_TEST_CASES } from '../lib/devicetest/matrix';

let count = 0;
function check(actual: unknown, expected: unknown, label: string) {
  assert.deepEqual(actual, expected, label); count++; console.log(`  ✓ ${label}`);
}
function ok(actual: unknown, label: string) {
  assert.ok(actual, label); count++; console.log(`  ✓ ${label}`);
}

const read = (p: string) => readFileSync(p, 'utf8');
/** JSX wraps text across lines — compare on normalized single-space text. */
const flat = (t: string) => t.replace(/\s+/g, ' ');
const ws = read('components/settings/SettingsWorkspace.tsx');
const panel = read('components/dev/DeviceTestPanel.tsx');
const diag = read('components/transfer/DiagnosticsPanel.tsx');

console.log('[devicetest-ui]');

// --- 1. Advanced section renders on the production Settings surface -------

ok(ws.includes('id="settings-advanced"'), 'Advanced section card exists on SettingsWorkspace');
ok(ws.includes('Device Test &amp; Diagnostics'), 'Device Test & Diagnostics entry renders');
check(flat(ws).includes('Run a real two-device transfer test and inspect WebRTC path, bitrate, RTT, flow-control, receiver write performance, stalls and bottlenecks.'), true,
  'entry carries the requested subtitle');
ok(ws.includes('Open Device Test'), 'CTA button reads "Open Device Test"');
ok(/Activity/.test(ws), 'Advanced section carries a diagnostics icon');
ok(ws.includes('href: \'#settings-advanced\', label: \'Advanced\''), 'Advanced appears in the section navigation');

// --- 2. Button opens the ONE existing overlay — no second implementation ---

ok(ws.includes("import { openDeviceTest } from '@/lib/devicetest/recorder'"),
  'button is wired to the existing recorder overlay opener');
ok(ws.includes('onClick={openDeviceTest}'), 'button onClick calls openDeviceTest');
// The overlay itself is the existing panel: gated only on snap.open, reusing
// the existing recorder/report/matrix/live-readout — no parallel system.
ok(panel.includes("if (!snap.open) return null;"), 'DeviceTestPanel renders when the store opens');
ok(panel.includes("from '@/lib/devicetest/report'"), 'panel reuses the existing report builder');
ok(panel.includes("buildLiveTestJson"), 'panel reuses the existing JSON export');
ok(panel.includes('LiveReadout'), 'panel reuses the existing live telemetry readout');
check(DEVICE_TEST_CASES.some((c) => c.id === 'live'), true, 'panel uses the existing matrix (live case)');

// --- 3. All pre-existing Settings sections remain --------------------------

for (const id of [
  'settings-profile', 'settings-theme', 'settings-transfers', 'settings-storage',
  'settings-notifications', 'settings-security', 'settings-about',
]) {
  check(ws.includes(`id="${id}"`), true, `existing section ${id} remains`);
}
for (const label of ['Profile', 'Theme', 'Transfer Settings', 'Storage', 'Notifications', 'Security', 'About']) {
  check(ws.includes(`label: '${label}'`), true, `section nav chip "${label}" remains`);
}

// --- 4. ?diag=1 developer panel stays separate -----------------------------

ok(diag.includes('isDevModeEnabled'), 'developer diagnostics panel still gated on ?diag=1 mode');
check(ws.includes('isDevModeEnabled'), false, 'no developer-only controls leak into production Settings');
ok(!panel.includes('isDevModeEnabled'), 'Device Test overlay is NOT gated on developer mode (production entry)');
ok(!ws.includes('localStorage.setItem(\'nexdrop:devmode'), 'Settings does not toggle developer mode');

// --- 5. Opening the overlay actually flips the shared store ----------------

const fakeStore: Record<string, string> = {};
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (k: string) => fakeStore[k] ?? null,
    setItem: (k: string, v: string) => { fakeStore[k] = v; },
    removeItem: (k: string) => { delete fakeStore[k]; },
  },
  setInterval: () => 1,
  clearInterval: () => {},
};
__resetDeviceTestForTests();
check(getDeviceTestSnapshot().open, false, 'overlay is closed by default');
openDeviceTest();
{
  const snap = getDeviceTestSnapshot();
  check(snap.open, true, 'openDeviceTest opens the store DeviceTestPanel renders from');
  ok(snap.records.some((r) => r.caseId === 'live'), 'the opened overlay exposes the guided live test');
}
closeDeviceTest();
check(getDeviceTestSnapshot().open, false, 'closeDeviceTest closes the overlay');

console.log(`[devicetest-ui] ${count} checks passed`);
if (count < 25) {
  console.error('[devicetest-ui] MISSING CHECKS — expected at least 25');
  process.exit(1);
}
