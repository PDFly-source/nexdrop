/**
 * AUTO transport selection (mission Phase 19).
 *
 * The user never has to understand transport technology: given both
 * endpoints' capabilities and the connection context, pick the fastest
 * LEGITIMATE transport. The label is honest — the UI may only claim
 * Turbo when the data actually moves over a native transport.
 *
 * The PWA runs in a browser, so its own capabilities always resolve to
 * WebRTC (browsers cannot open raw TCP/mDNS sockets — mission Phase 9:
 * never fake it). The native selector arms run in the companion / Android
 * native runtime where those capabilities exist.
 */

import type { TransportCapabilities, TransportKind, TransportLinkType } from '@/types/transport';

export type TransportLabel = 'TURBO LOCAL' | 'WEB';

export interface TransportChoice {
  kind: TransportKind;
  linkType: TransportLinkType;
  /** UI badge: '⚡ NEXDROP TURBO LOCAL' only when the data path is native. */
  label: TransportLabel;
}

export interface SelectionContext {
  /** This device's real capabilities (never assumed). */
  local: TransportCapabilities;
  /** Peer capabilities learned during session bootstrap. */
  remote: TransportCapabilities;
  /** True when both endpoints share a LAN / hotspot / Wi-Fi Direct link. */
  sameLocalNetwork: boolean;
  /** Wi-Fi Direct usable now (not connected elsewhere, user opted in). */
  wifiDirectUsable: boolean;
  /** Mode: 'auto' picks by evidence; 'turbo' prefers native, 'standard' WebRTC. */
  mode: 'auto' | 'turbo' | 'standard';
}

/**
 * Priority (mission Phase 19):
 *   both native LAN TCP + same local network -> lan-tcp
 *   both Wi-Fi Direct + usable             -> wifi-direct-tcp
 *   native local sockets (hotspot)         -> native-local
 *   otherwise                               -> webrtc (never faked)
 */
export function selectTransport(ctx: SelectionContext): TransportChoice {
  if (ctx.mode === 'standard') {
    return { kind: 'webrtc', linkType: 'browser-webrtc', label: 'WEB' };
  }
  if (ctx.local.lanTcp && ctx.remote.lanTcp && ctx.sameLocalNetwork) {
    return { kind: 'lan-tcp', linkType: 'lan-tcp', label: 'TURBO LOCAL' };
  }
  if (ctx.local.wifiDirect && ctx.remote.wifiDirect && ctx.wifiDirectUsable) {
    return { kind: 'wifi-direct-tcp', linkType: 'wifi-direct-tcp', label: 'TURBO LOCAL' };
  }
  if (ctx.local.nativeLocal && ctx.remote.nativeLocal && ctx.sameLocalNetwork) {
    return { kind: 'native-local', linkType: 'hotspot-tcp', label: 'TURBO LOCAL' };
  }
  return { kind: 'webrtc', linkType: 'browser-webrtc', label: 'WEB' };
}

/** Browser truth: a PWA can never claim native transports. */
export const BROWSER_CAPABILITIES: TransportCapabilities = {
  lanTcp: false,
  wifiDirect: false,
  nativeLocal: false,
  webrtc: true,
};

/** The label the UI shows while a transfer is live (honest by construction). */
export function transportBadge(choice: TransportChoice): string {
  return choice.label === 'TURBO LOCAL' ? '⚡ NEXDROP TURBO LOCAL' : '🌐 NEXDROP WEBRTC';
}
