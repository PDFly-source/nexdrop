/**
 * NDPS1 — ONE-scan automatic pairing payload (NexDrop Pairing, Signaling v1).
 *
 * The QR carries ONLY:
 *   - app identifier + protocol version
 *   - short-lived session id (display only)
 *   - single-use join token (auth for the signaling service)
 *   - signaling endpoint URL
 *
 * The QR NEVER carries:
 *   - SDP, ICE candidates, ECDH keys (those travel via the ephemeral
 *     signaling service, not the QR)
 *   - private keys, file contents, long-lived credentials
 *
 * Everything else about the connection (offer, answer, keys) is exchanged
 * automatically through the signaling service, so the user scans exactly
 * ONE code and never sees an answer QR.
 */

import { bytesToBase64Url, base64UrlToBytes } from '@/lib/crypto';

export const SIGNAL_PREFIX = 'NDPS1.';
export const SIGNAL_APP_ID = 'nexdrop';

export interface SignalQrPayload {
  /** App identifier. */
  a: string;
  /** Protocol version. */
  v: number;
  /** Session id (short, for display). */
  s: string;
  /** Single-use join token for the signaling service. */
  t: string;
  /** Signaling endpoint URL. */
  e: string;
}

/** Build the compact one-scan QR text. */
export function buildSignalQr(input: SignalQrPayload): string {
  const json = JSON.stringify({ a: input.a, v: input.v, s: input.s, t: input.t, e: input.e });
  const bytes = new TextEncoder().encode(json);
  return SIGNAL_PREFIX + bytesToBase64Url(bytes);
}

export function isSignalQr(code: string): boolean {
  return typeof code === 'string' && code.trim().startsWith(SIGNAL_PREFIX);
}

/** Parse and validate a scanned NDPS1 payload. Throws on any invalid input. */
export function parseSignalQr(code: string): SignalQrPayload {
  const trimmed = (code || '').trim();
  if (!trimmed.startsWith(SIGNAL_PREFIX)) {
    throw new Error('not-a-signal-code');
  }
  let json: string;
  try {
    json = new TextDecoder().decode(base64UrlToBytes(trimmed.slice(SIGNAL_PREFIX.length)));
  } catch {
    throw new Error('invalid-encoding');
  }
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('invalid-json');
  }
  if (parsed?.a !== SIGNAL_APP_ID) throw new Error('wrong-app');
  if (!Number.isInteger(parsed?.v) || parsed.v !== 1) throw new Error('unsupported-version');
  if (typeof parsed?.s !== 'string' || parsed.s.length < 8 || parsed.s.length > 64) {
    throw new Error('invalid-session');
  }
  if (typeof parsed?.t !== 'string' || parsed.t.length < 16 || parsed.t.length > 128) {
    throw new Error('invalid-token');
  }
  if (typeof parsed?.e !== 'string' || !/^https:\/\/[a-z0-9.-]+\/[a-z0-9\/.-]*$/i.test(parsed.e)) {
    throw new Error('invalid-endpoint');
  }
  return { a: parsed.a, v: parsed.v, s: parsed.s, t: parsed.t, e: parsed.e };
}
