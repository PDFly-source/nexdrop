/**
 * The owner-run physical validation matrix. Cases 01-10 are the ten-case
 * manual matrix. The 11th entry ('live') is the v2.5.2 GUIDED two-device
 * diagnostics test (Settings -> Advanced -> Device Test & Diagnostics):
 * pick sender/receiver role, name the devices, pair via the normal QR
 * flow, and send the real 341.48 MB test file — the recorder samples the
 * real engines the whole time.
 *
 * The 'physical' group is the 2026-10-03 FINAL PHYSICAL PERFORMANCE TEST
 * MODE: the exact A–E device matrix (358 MB = 341.48 MiB test file, same
 * local Wi-Fi), the 1 GB repeat of the best path, and the chunk-size
 * experiment. Each case is guided exactly like 'live' — the recorder
 * samples the real engines and every reported value is measured.
 */
export interface DeviceTestCase {
  id: string;
  title: string;
  /** What the owner must really do through the normal app flow. */
  hint: string;
  /** 'matrix' = simple checklist card · 'guided' = full recorded diagnostics. */
  group: 'matrix' | 'guided';
}

export const DEVICE_TEST_CASES: DeviceTestCase[] = [
  { id: '01', group: 'matrix', title: 'Small file', hint: 'Arm, then send a small file (< 1 MB) through the normal SEND flow on the other phone.' },
  { id: '02', group: 'matrix', title: '100 MB file', hint: 'Arm, then send a ~100 MB file through the normal SEND flow.' },
  { id: '03', group: 'matrix', title: 'Multi-file transfer', hint: 'Arm, queue several real files, then send them in one session.' },
  { id: '04', group: 'matrix', title: 'APK transfer', hint: 'Arm, then send a real .apk file (100–500 MB ideal).' },
  { id: '05', group: 'matrix', title: 'ZIP transfer', hint: 'Arm, then send a real .zip archive.' },
  { id: '06', group: 'matrix', title: 'Pause → Resume', hint: 'Arm, start a large transfer, pause it mid-way in the UI, resume, and let it finish.' },
  { id: '07', group: 'matrix', title: 'Cancel', hint: 'Arm, start a transfer, cancel it mid-way. No completion is expected — mark the result yourself.' },
  { id: '08', group: 'matrix', title: 'Decline pairing', hint: 'Arm on the receiving phone, scan the QR, then DECLINE the incoming request. The sender must keep its queue and show a truthful failure.' },
  { id: '09', group: 'matrix', title: 'QR expiry', hint: 'Arm, create a pairing QR on the sender and let it expire without scanning. The UI must show expiry with retry, never a fake success.' },
  { id: '10', group: 'matrix', title: 'Disconnect → Reconnect', hint: 'Arm, connect, then briefly disable Wi-Fi on one phone and re-enable it. Mark the result yourself (engine reconnect behavior).' },
  {
    id: 'live',
    group: 'guided',
    title: '341.48 MB Guided Two-Device Test',
    hint: 'Guided diagnostics: pick this phone\u2019s role, name both devices, pair with the normal NexDrop QR flow, then send the real 341.48 MB file. Every recorded value is measured.',
  },
  // ---- FINAL PHYSICAL PERFORMANCE TEST MODE (2026-10-03 directive) ----
  // 358 MB (decimal) = 341.48 MiB — the existing real test file.
  // Same local Wi-Fi for every scenario. Only real durable transfer speed
  // counts: whole-transfer average/sustained/peak-sustained, RTT, ACK
  // latency, bufferedAmount, in-flight, stage timing, receiver write
  // latency, queue depth, direct-vs-relay, SHA-256.
  {
    id: 'pt-a',
    group: 'guided',
    title: 'TEST A — Android → Android · 358 MB',
    hint: 'Same local Wi-Fi. Arm on BOTH phones (sender here), pair via the normal QR flow, send the real 358 MB (341.48 MiB) file. Record avg/sustained/peak-sustained, RTT, in-flight max, bufferedAmount max, ACK latency, stage timing, direct-vs-relay, SHA-256.',
  },
  {
    id: 'pt-b',
    group: 'guided',
    title: 'TEST B — Android → Windows · 358 MB',
    hint: 'Same local Wi-Fi. Arm on both devices (Android = sender), pair via QR, send the real 358 MB file. Windows receiver: confirm File System Access / OPFS path, write latency, queue depth, SHA-256 PASS.',
  },
  {
    id: 'pt-c',
    group: 'guided',
    title: 'TEST C — Windows → Android · 358 MB',
    hint: 'Same local Wi-Fi. Arm on both devices (Windows = sender). Same WebRTC engine, keyboard/mouse flow. Record the same metrics and SHA-256.',
  },
  {
    id: 'pt-d',
    group: 'guided',
    title: 'TEST D — Android → Android TV · 358 MB',
    hint: 'Same local Wi-Fi. Arm on the phone (sender) and on the TV browser (receiver) if it can open the app. TV uses QR display / keyboard fallback if the camera is unavailable. Record the same metrics and SHA-256.',
  },
  {
    id: 'pt-e',
    group: 'guided',
    title: 'TEST E — Android TV → Android · 358 MB (only if the TV browser can select/send a file)',
    hint: 'ONLY if the TV browser can actually open a file picker and select the 358 MB file. If it cannot, mark N/A — never fake this scenario. Arm on both, pair via QR, record the same metrics and SHA-256.',
  },
  {
    id: 'pt-1gb',
    group: 'guided',
    title: 'TEST F — 1 GB · fastest stable path',
    hint: 'After A–E, arm this on the fastest STABLE path and send a real 1 GB file. Record duration, average, sustained, peak-sustained, SHA-256, memory (heap peak), receiver durability, and one pause/resume mid-transfer. Do not stop at 358 MB.',
  },
  {
    id: 'pt-chunks',
    group: 'guided',
    title: 'Chunk-size experiment — 128 KiB / 256 KiB / 512 KiB / 1 MiB',
    hint: 'On the SAME device pair and SAME file, run the 358 MB transfer once per chunk size (128 KiB, 256 KiB, 512 KiB, 1 MiB) where the negotiated SCTP maxMessageSize safely allows. Reset between runs and record REAL sustained throughput for each. Keep the configuration that actually performs best on this pair — never a CI winner.',
  },
];

export const GUIDED_CASES = DEVICE_TEST_CASES.filter((c) => c.group === 'guided');

export const MANUAL_CASES = DEVICE_TEST_CASES.filter((c) => c.group === 'matrix');
