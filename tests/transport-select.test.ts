/**
 * Transport selector tests — the AUTO decision must be deterministic and
 * HONEST: never claim Turbo when the data will move over WebRTC, never
 * claim a native transport the browser cannot use (mission Phase 19/22).
 */

import { BROWSER_CAPABILITIES, selectTransport, transportBadge } from '../lib/transport/selector';
import type { TransportCapabilities } from '../types/transport';

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${label}`);
  } else {
    failed++;
    console.log(`  \u2717 FAIL: ${label}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

const native: TransportCapabilities = { lanTcp: true, wifiDirect: true, nativeLocal: true, webrtc: true };
const browserOnly: TransportCapabilities = { lanTcp: false, wifiDirect: false, nativeLocal: false, webrtc: true };
const desktopCompanion: TransportCapabilities = { lanTcp: true, wifiDirect: false, nativeLocal: false, webrtc: true };

console.log('[transport-select] AUTO picks the fastest legitimate transport');
check(
  selectTransport({ local: native, remote: desktopCompanion, sameLocalNetwork: true, wifiDirectUsable: false, mode: 'auto' })
    .kind === 'lan-tcp',
  'both native + same LAN -> lan-tcp'
);
check(
  selectTransport({ local: native, remote: desktopCompanion, sameLocalNetwork: true, wifiDirectUsable: false, mode: 'auto' })
    .label === 'TURBO LOCAL',
  'native choice labeled TURBO LOCAL'
);
check(
  selectTransport({ local: native, remote: desktopCompanion, sameLocalNetwork: false, wifiDirectUsable: false, mode: 'auto' })
    .kind === 'webrtc',
  'no shared local network -> webrtc fallback'
);
check(
  selectTransport({ local: native, remote: desktopCompanion, sameLocalNetwork: false, wifiDirectUsable: false, mode: 'auto' })
    .label === 'WEB',
  'fallback labeled WEB (never fakes Turbo)'
);

console.log('[transport-select] Wi-Fi Direct chosen only when usable');
check(
  selectTransport({ local: native, remote: native, sameLocalNetwork: false, wifiDirectUsable: true, mode: 'auto' })
    .kind === 'wifi-direct-tcp',
  'wifi-direct when usable'
);
check(
  selectTransport({ local: native, remote: native, sameLocalNetwork: false, wifiDirectUsable: false, mode: 'auto' })
    .kind === 'webrtc',
  'no usable direct link -> webrtc'
);

console.log('[transport-select] browser PWA honesty (Phase 9: never fake it)');
check(
  selectTransport({ local: BROWSER_CAPABILITIES, remote: desktopCompanion, sameLocalNetwork: true, wifiDirectUsable: true, mode: 'auto' })
    .kind === 'webrtc',
  'browser NEVER claims lan-tcp even on the same LAN'
);
check(
  selectTransport({ local: BROWSER_CAPABILITIES, remote: desktopCompanion, sameLocalNetwork: true, wifiDirectUsable: true, mode: 'turbo' })
    .label === 'WEB',
  'TURBO mode on browser still honestly shows WEB'
);

console.log('[transport-select] standard mode is always WebRTC');
check(
  selectTransport({ local: native, remote: native, sameLocalNetwork: true, wifiDirectUsable: true, mode: 'standard' }).kind ===
    'webrtc',
  'standard -> webrtc'
);

console.log('[transport-select] badge strings');
check(transportBadge({ kind: 'lan-tcp', linkType: 'lan-tcp', label: 'TURBO LOCAL' }) === '⚡ NEXDROP TURBO LOCAL', 'turbo badge');
check(transportBadge({ kind: 'webrtc', linkType: 'browser-webrtc', label: 'WEB' }) === '🌐 NEXDROP WEBRTC', 'web badge');

console.log(`[transport-select] ${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed) process.exit(1);
