/**
 * The owner-run physical validation matrix. Cases 01-10 are the ten-case
 * manual matrix. The 11th entry ('live') is the v2.5.2 GUIDED two-device
 * diagnostics test (Settings -> Advanced -> Device Test & Diagnostics):
 * pick sender/receiver role, name the devices, pair via the normal QR
 * flow, and send the real 341.48 MB test file — the recorder samples the
 * real engines the whole time.
 */
export interface DeviceTestCase {
  id: string;
  title: string;
  /** What the owner must really do through the normal app flow. */
  hint: string;
}

export const DEVICE_TEST_CASES: DeviceTestCase[] = [
  { id: '01', title: 'Small file', hint: 'Arm, then send a small file (< 1 MB) through the normal SEND flow on the other phone.' },
  { id: '02', title: '100 MB file', hint: 'Arm, then send a ~100 MB file through the normal SEND flow.' },
  { id: '03', title: 'Multi-file transfer', hint: 'Arm, queue several real files, then send them in one session.' },
  { id: '04', title: 'APK transfer', hint: 'Arm, then send a real .apk file (100–500 MB ideal).' },
  { id: '05', title: 'ZIP transfer', hint: 'Arm, then send a real .zip archive.' },
  { id: '06', title: 'Pause → Resume', hint: 'Arm, start a large transfer, pause it mid-way in the UI, resume, and let it finish.' },
  { id: '07', title: 'Cancel', hint: 'Arm, start a transfer, cancel it mid-way. No completion is expected — mark the result yourself.' },
  { id: '08', title: 'Decline pairing', hint: 'Arm on the receiving phone, scan the QR, then DECLINE the incoming request. The sender must keep its queue and show a truthful failure.' },
  { id: '09', title: 'QR expiry', hint: 'Arm, create a pairing QR on the sender and let it expire without scanning. The UI must show expiry with retry, never a fake success.' },
  { id: '10', title: 'Disconnect → Reconnect', hint: 'Arm, connect, then briefly disable Wi-Fi on one phone and re-enable it. Mark the result yourself (engine reconnect behavior).' },
  {
    id: 'live',
    title: '341.48 MB Guided Two-Device Test',
    hint: 'Guided diagnostics: pick this phone\u2019s role, name both devices, pair with the normal NexDrop QR flow, then send the real 341.48 MB file. Every recorded value is measured.',
  },
];
