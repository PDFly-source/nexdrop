/**
 * Manual WebRTC pairing payload encoding for NexDrop.
 *
 * There is NO signaling server. The SDP offer/answer is:
 *   1. trimmed to the essential lines,
 *   2. deflate-compressed (when CompressionStream is available),
 *   3. wrapped with an ECDH public key + expiry into a compact JSON envelope,
 *   4. base64url-encoded into a single "pairing code" string.
 *
 * If the code is too large for one QR code, it is split into numbered
 * multi-QR segments that the receiving device reassembles.
 */

import {
  base64UrlToBytes,
  bytesToBase64Url,
  stringToBytes,
} from '@/lib/crypto';
import { PairingError, ParsedPairingPayload } from '@/types/session';

export const PAIRING_TTL_MS = 10 * 60 * 1000; // pairing payloads expire after 10 minutes
const ENVELOPE_PREFIX = 'NDP1.'; // NexDrop Pairing v1
const SEGMENT_PREFIX = 'NDQS2.'; // NexDrop QR Segment v2 (checksummed)
const SEGMENT_PREFIX_V1 = 'NDQS.'; // NexDrop QR Segment v1 (legacy, still parseable)
// QR density budget: with EC level M, a byte-mode QR holding these payloads
// stays at version <= 15 (77 modules / side). Displayed at ~300px on a phone,
// that keeps each module >= ~3.9 CSS px so a normal phone camera resolves it.
// Bigger payloads are split instead of producing a maximum-density QR that
// cameras misread (error correction then "repairs" into plausible garbage).
const SINGLE_QR_MAX_CHARS = 580; // max chars in a single QR pairing code
const SEGMENT_DATA_CHARS = 550; // per-segment payload chars for multi-QR

/** 16-bit FNV-1a as 4 hex chars — detects camera misreads of one fragment. */
function fnv1a16(str: string): string {
  let hash = 0x811c;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x0193) & 0xffff;
  }
  return hash.toString(16).padStart(4, '0');
}
export const SEGMENT_REASSEMBLY_TIMEOUT_MS = 3 * 60 * 1000;

// ---------------------------------------------------------------------------
// SDP trimming — remove lines that are irrelevant for a DataChannel-only
// connection. This keeps QR payloads small without touching security
// material (fingerprints, ICE ufrag/pwd/candidates, setup role).
// ---------------------------------------------------------------------------

const SDP_DROP_PREFIXES = [
  'a=extmap',
  'a=rtpmap',
  'a=fmtp',
  'a=rtcp-fb',
  'a=ssrc',
  'a=msid',
  'a=rtcp-mux',
  'a=rtcp-rsize',
  'a=imageattr',
  'a=setup:', // handled below — kept
];

/** Exposed for unit tests only. */
export function __testTrimSdp(sdp: string): string {
  return trimSdp(sdp);
}

function trimSdp(sdp: string): string {
  return sdp
    .split(/\r?\n/)
    .filter((line) => {
      if (!line) return false;
      // Never drop security or transport material
      if (
        line.startsWith('a=fingerprint') ||
        line.startsWith('a=setup') ||
        line.startsWith('a=ice-') ||
        line.startsWith('a=group') ||
        line.startsWith('a=mid') ||
        line.startsWith('a=candidate') ||
        line.startsWith('a=end-of-candidates') ||
        line.startsWith('a=sctp') ||
        line.startsWith('m=') ||
        line.startsWith('v=') ||
        line.startsWith('o=') ||
        line.startsWith('s=') ||
        line.startsWith('t=') ||
        line.startsWith('b=') ||
        line.startsWith('c=')
      ) {
        return true;
      }
      return !SDP_DROP_PREFIXES.some((p) => line.startsWith(p));
    })
    .join('\r\n') + '\r\n';
  // SDP (RFC 8866) requires CRLF line terminators on EVERY line including
  // the last one — bare-LF SDP is rejected by strict parsers (Chromium
  // fails setRemoteDescription on the final unterminated line).
}

// ---------------------------------------------------------------------------
// Compression (deflate-raw via CompressionStream, with graceful fallback)
// ---------------------------------------------------------------------------

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes as unknown as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream('deflate-raw'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes as unknown as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Envelope: { v, k, pk, d, c, ts, exp, ack }
//   k: 'o' | 'a' (offer/answer)
//   pk: base64url raw ECDH public key
//   d: base64url payload bytes (trimmed SDP, optionally compressed)
//   c: 1 when deflate-raw compressed, 0 when plain
//   ack: answers only — base64url SHA-256 of the offer code (binds the
//        answer to the exact offer the host generated)
// ---------------------------------------------------------------------------

interface Envelope {
  v: number;
  k: 'o' | 'a';
  pk: string;
  d: string;
  c: 0 | 1;
  ts: number;
  exp: number;
  ack?: string;
}

export interface BuildPayloadInput {
  kind: 'offer' | 'answer';
  sdp: string;
  /** Local ECDH public key, raw bytes. */
  publicKey: ArrayBuffer;
  /** SHA-256 (base64url) of the offer code — answers only. */
  ackOfOffer?: string;
}

/** Build the compact one-line pairing code. */
export async function buildPairingCode(input: BuildPayloadInput): Promise<string> {
  const trimmed = trimSdp(input.sdp);
  const rawBytes = stringToBytes(trimmed);
  const deflated = await deflateRaw(rawBytes);

  let dataBytes: Uint8Array = rawBytes;
  let compressed: 0 | 1 = 0;
  if (deflated && deflated.length < rawBytes.length) {
    dataBytes = deflated;
    compressed = 1;
  }

  const envelope: Envelope = {
    v: 1,
    k: input.kind === 'offer' ? 'o' : 'a',
    pk: bytesToBase64Url(new Uint8Array(input.publicKey)),
    d: bytesToBase64Url(dataBytes),
    c: compressed,
    ts: Date.now(),
    exp: Date.now() + PAIRING_TTL_MS,
    ...(input.ackOfOffer ? { ack: input.ackOfOffer } : {}),
  };

  const json = JSON.stringify(envelope);
  return ENVELOPE_PREFIX + bytesToBase64Url(stringToBytes(json));
}

/** Parse a pairing code. Throws PairingError on any problem. */
export async function parsePairingCode(code: string): Promise<ParsedPairingPayload> {
  const trimmed = code.trim();
  if (!trimmed.startsWith(ENVELOPE_PREFIX)) {
    throw new Error('invalid-format');
  }

  let envelope: Envelope;
  try {
    const jsonBytes = base64UrlToBytes(trimmed.slice(ENVELOPE_PREFIX.length));
    envelope = JSON.parse(new TextDecoder().decode(jsonBytes));
  } catch {
    throw new Error('invalid-format');
  }

  if (!envelope || envelope.v !== 1 || (envelope.k !== 'o' && envelope.k !== 'a')) {
    throw new Error('invalid-format');
  }
  if (typeof envelope.d !== 'string' || typeof envelope.pk !== 'string') {
    throw new Error('invalid-format');
  }

  const now = Date.now();
  // Allow 2 min clock skew between devices
  if (envelope.exp && envelope.exp + 2 * 60 * 1000 < now) {
    throw new Error('expired');
  }

  let dataBytes: Uint8Array;
  try {
    dataBytes = base64UrlToBytes(envelope.d);
  } catch {
    throw new Error('invalid-format');
  }

  if (envelope.c === 1) {
    const inflated = await inflateRaw(dataBytes);
    if (!inflated) throw new Error('invalid-format');
    dataBytes = inflated;
  }

  let publicKey: ArrayBuffer;
  try {
    const pkBytes = base64UrlToBytes(envelope.pk);
    publicKey = pkBytes.buffer.slice(
      pkBytes.byteOffset,
      pkBytes.byteOffset + pkBytes.byteLength
    ) as ArrayBuffer;
  } catch {
    throw new Error('invalid-format');
  }

  if (publicKey.byteLength !== 65) {
    throw new Error('invalid-format');
  }

  return {
    kind: envelope.k === 'o' ? 'offer' : 'answer',
    sdp: new TextDecoder().decode(dataBytes),
    peerPublicKey: publicKey,
    createdAt: envelope.ts,
    expiresAt: envelope.exp,
    ackOfOffer: envelope.ack,
  };
}

const VALID_PAIRING_ERRORS: PairingError[] = [
  'invalid-format',
  'corrupt-segment',
  'expired',
  'not-offer',
  'not-answer',
  'wrong-session',
  'incomplete',
  'timeout',
  'unsupported-browser',
];

/** True when the thrown error is a known pairing failure. */
export function toPairingError(err: unknown): PairingError | null {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return (VALID_PAIRING_ERRORS as string[]).includes(message) ? (message as PairingError) : null;
}

// ---------------------------------------------------------------------------
// Multi-QR segmentation
// ---------------------------------------------------------------------------

export interface QrSegment {
  index: number; // 1-based
  total: number;
  /** The full text of this QR code. */
  text: string;
}

/** Split a pairing code into QR segments if it is too large for one QR. */
export function segmentPairingCode(code: string, sessionId: string): QrSegment[] {
  const total = Math.max(1, Math.ceil(code.length / SEGMENT_DATA_CHARS));
  if (code.length <= SINGLE_QR_MAX_CHARS) {
    return [{ index: 1, total: 1, text: code }];
  }

  const segments: QrSegment[] = [];
  for (let i = 0; i < total; i++) {
    const data = code.slice(i * SEGMENT_DATA_CHARS, (i + 1) * SEGMENT_DATA_CHARS);
    segments.push({
      index: i + 1,
      total,
      // NDQS2.{session}.{index}.{total}.{checksum}.{data} — the per-fragment
      // checksum lets the scanner reject a misread fragment instantly instead
      // of assembling garbage and failing much later at parse time. v1 (NDQS.)
      // fragments from older builds are still accepted by the assembler.
      text: `${SEGMENT_PREFIX}${sessionId}.${i + 1}.${total}.${fnv1a16(data)}.${data}`,
    });
  }
  return segments;
}

/**
 * Reassembly accumulator for multi-QR scanning.
 * Feed every scanned string; returns the complete pairing code once all
 * segments have arrived, or null while still incomplete.
 */
export class QrSegmentAssembler {
  private sessionId: string | null = null;
  private total = 0;
  private parts = new Map<number, string>();
  private startedAt = Date.now();

  /** Returns: { code } when complete; { progress } while collecting; { error } on mismatch/timeout. */
  feed(scanned: string): { code?: string; error?: PairingError; received: number; total: number } {
    if (Date.now() - this.startedAt > SEGMENT_REASSEMBLY_TIMEOUT_MS) {
      return { error: 'timeout', received: this.parts.size, total: this.total };
    }

    if (scanned.startsWith(ENVELOPE_PREFIX)) {
      // A complete single-QR code scanned directly
      return { code: scanned, received: 1, total: 1 };
    }

    const isV2 = scanned.startsWith(SEGMENT_PREFIX);
    const isV1 = !isV2 && scanned.startsWith(SEGMENT_PREFIX_V1);
    if (!isV2 && !isV1) {
      return { error: 'invalid-format', received: this.parts.size, total: this.total };
    }

    const prefix = isV2 ? SEGMENT_PREFIX : SEGMENT_PREFIX_V1;
    const parts = scanned.slice(prefix.length).split('.');
    // v1: {session}.{index}.{total}.{data}   (integrity enforced at parse time)
    // v2: {session}.{index}.{total}.{checksum}.{data}
    const minParts = isV2 ? 5 : 4;
    if (parts.length < minParts) {
      return { error: 'invalid-format', received: this.parts.size, total: this.total };
    }
    const sessionId = parts[0];
    const index = parseInt(parts[1], 10);
    const total = parseInt(parts[2], 10);
    const data = isV2 ? parts.slice(4).join('.') : parts.slice(3).join('.');
    if (isV2 && fnv1a16(data) !== parts[3]) {
      return { error: 'corrupt-segment', received: this.parts.size, total: this.total };
    }

    if (!Number.isFinite(index) || !Number.isFinite(total) || index < 1 || total < 1 || index > total) {
      return { error: 'invalid-format', received: this.parts.size, total: this.total };
    }
    if (this.sessionId === null) {
      this.sessionId = sessionId;
      this.total = total;
    } else if (this.sessionId !== sessionId || this.total !== total) {
      return { error: 'wrong-session', received: this.parts.size, total: this.total };
    }

    this.parts.set(index, data);

    if (this.parts.size === this.total) {
      let full = '';
      for (let i = 1; i <= this.total; i++) {
        full += this.parts.get(i) ?? '';
      }
      const total = this.total;
      this.reset();
      return { code: full, received: total, total };
    }

    return { received: this.parts.size, total: this.total };
  }

  reset(): void {
    this.sessionId = null;
    this.total = 0;
    this.parts.clear();
    this.startedAt = Date.now();
  }
}
