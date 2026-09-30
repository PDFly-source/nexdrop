/**
 * Compact binary pairing format (NDP2) for NexDrop.
 *
 * The v1 (NDP1) format wraps the whole trimmed SDP text in a JSON envelope;
 * even deflate-compressed that lands around 550-700 base64url chars, which
 * exceeds the single-QR scan-reliability budget and forces the multi-fragment
 * carousel. The reason: SDP text carries per-line syntax (field names,
 * colons, CRLFs, hex colons in fingerprints) that wastes most of its bytes.
 *
 * v2 packs ONLY the fields a DataChannel-only session actually needs and
 * reconstructs a canonical SDP from them on the receiving side:
 *   - ice ufrag/pwd, DTLS fingerprint + setup role, sctp port, candidates
 *   - the ECDH public key, timestamps, and (answers) the offer ack.
 * Both endpoints run THIS code, so reconstruction is self-consistent — no
 * cross-browser SDP variance is involved. A typical payload is ~230 bytes
 * → ~310 base64url chars → ONE QR at version <= 13, scannable by phones.
 *
 * SAFETY NET: anything the packer cannot represent faithfully (TCP
 * candidates, non-sha256 fingerprints, > 8 candidates, oversized labels)
 * makes buildPairingCode fall back to the v1 JSON path with automatic
 * multi-QR segmentation — never a silently wrong connection.
 */

import { base64UrlToBytes, bytesToBase64Url } from '@/lib/crypto';
import { PairingError, ParsedPairingPayload } from '@/types/session';

export const COMPACT_PREFIX = 'NDP2.'; // NexDrop Pairing v2 (binary compact)

// -----------------------------------------------------------------------
// Wire format (all integers LITTLE-ENDIAN)
//
// [0]      version (2)
// [1]      kind: 0 = offer, 1 = answer
// [2..6]   ts   u32, unix seconds
// [6..10]  exp  u32, unix seconds
// [10]     flags: bit0 hasAck, bit1 hasDeviceLabel
// [11..76] 65-byte uncompressed P-256 ECDH public key
// [if hasAck]    32 bytes raw SHA-256 of the offer code (answers only)
// [if hasLabel]  u8 len + len bytes UTF-8 device label (<= 48)
// u8        ufragLen + bytes
// u8        pwdLen + bytes
// 32 bytes  DTLS fingerprint (binary)
// u8        setupRole: 0 actpass, 1 active, 2 passive
// u16       sctpPort
// u32       maxMessageSize (0 = absent from the source SDP)
// u8        candidateCount (<= 8)
//   per candidate:
//     u8  type: 0 host, 1 srflx, 2 relay
//     u8  ipLen + ascii bytes
//     u16 port
//     [srflx/relay] u8 raddrLen + ascii, u16 rport
// -----------------------------------------------------------------------

const MAX_CANDIDATES = 8;
const MAX_LABEL_BYTES = 48;
const MAX_UFRAG = 128;
const MAX_PWD = 128;

export interface CompactPackInput {
  kind: 'offer' | 'answer';
  sdp: string;
  /** 65-byte uncompressed ECDH P-256 public key. */
  publicKey: Uint8Array;
  /** base64url SHA-256 of the offer code — answers only. */
  ackOfOffer?: string;
  /** Short human-readable label of the sending device. */
  device?: string;
}

class ByteWriter {
  private buf: number[] = [];
  u8(v: number) {
    this.buf.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    this.buf.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v: number) {
    this.buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  bytes(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.buf.push(b[i] & 0xff);
    return this;
  }
  ascii(s: string) {
    return this.bytes(s.split('').map((c) => c.charCodeAt(0) & 0xff));
  }
  utf8(s: string) {
    return this.bytes(new TextEncoder().encode(s));
  }
  build(): Uint8Array {
    return new Uint8Array(this.buf);
  }
}

interface ParsedCandidate {
  type: 'host' | 'srflx' | 'relay';
  ip: string;
  port: number;
  raddr?: string;
  rport?: number;
}

interface SdpEssentials {
  ufrag: string;
  pwd: string;
  fingerprintHex: string; // colon-separated hex, sha-256
  setup: 'actpass' | 'active' | 'passive';
  sctpPort: number;
  maxMessageSize?: number;
  candidates: ParsedCandidate[];
}

/** Extract only the fields we re-encode. Returns null when anything the
 *  compact format cannot faithfully represent is present. */
export function extractSdpEssentials(sdp: string): SdpEssentials | null {
  let ufrag = '';
  let pwd = '';
  let fingerprintHex: string | null = null;
  let setup: SdpEssentials['setup'] | null = null;
  let sctpPort = 5000;
  let maxMessageSize: number | undefined;
  const candidates: ParsedCandidate[] = [];

  for (const rawLine of sdp.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('a=ice-ufrag:')) {
      ufrag = ufrag || line.slice('a=ice-ufrag:'.length);
    } else if (line.startsWith('a=ice-pwd:')) {
      pwd = pwd || line.slice('a=ice-pwd:'.length);
    } else if (line.startsWith('a=fingerprint:')) {
      const [algo, ...rest] = line.slice('a=fingerprint:'.length).trim().split(/\s+/);
      if (algo && algo.toLowerCase() !== 'sha-256') return null; // cannot represent other algos faithfully
      fingerprintHex = rest.join(' ').toUpperCase();
    } else if (line.startsWith('a=setup:')) {
      const role = line.slice('a=setup:'.length).trim();
      if (role !== 'actpass' && role !== 'active' && role !== 'passive') return null;
      setup = role;
    } else if (line.startsWith('a=sctp-port:')) {
      const p = parseInt(line.slice('a=sctp-port:'.length), 10);
      if (Number.isFinite(p) && p > 0) sctpPort = p;
    } else if (line.startsWith('a=max-message-size:')) {
      const m = parseInt(line.slice('a=max-message-size:'.length), 10);
      if (Number.isFinite(m) && m >= 0) maxMessageSize = m;
    } else if (line.startsWith('a=candidate:')) {
      const parts = line.slice('a=candidate:'.length).split(/\s+/);
      // candidate:<foundation> <component-id> <transport> <priority> <address> <port> typ <type> ...
      if (parts.length < 8) return null;
      const transport = parts[2].toLowerCase();
      if (transport !== 'udp') return null; // TCP candidates need tcptype — bail to v1
      const ip = parts[4];
      const port = parseInt(parts[5], 10);
      if (parts[6] !== 'typ') return null;
      const type = parts[7];
      if (type !== 'host' && type !== 'srflx' && type !== 'relay') return null;
      let raddr: string | undefined;
      let rport: number | undefined;
      for (let i = 8; i + 1 < parts.length; i += 2) {
        if (parts[i] === 'raddr') raddr = parts[i + 1];
        else if (parts[i] === 'rport') rport = parseInt(parts[i + 1], 10);
      }
      if ((type === 'srflx' || type === 'relay') && (!raddr || !Number.isFinite(rport))) return null;
      if (!Number.isFinite(port) || port <= 0) return null;
      if (candidates.length < MAX_CANDIDATES) candidates.push({ type, ip, port, raddr, rport });
    }
  }

  if (!ufrag || !pwd || !fingerprintHex || !setup) return null;
  if (ufrag.length > MAX_UFRAG || pwd.length > MAX_PWD) return null;
  if (candidates.length === 0) return null;
  const hex = fingerprintHex.replace(/:/g, '');
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;

  return { ufrag, pwd, fingerprintHex, setup, sctpPort, maxMessageSize, candidates };
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function bytesToHexColon(b: number[]): string {
  return b.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

/** Pack into the compact binary code. Returns the full "NDP2.<base64url>" string,
 *  or null when a faithful compact encoding is not possible. */
export function buildCompactCode(input: CompactPackInput): string | null {
  const essentials = extractSdpEssentials(input.sdp);
  if (!essentials) return null;
  if (!input.publicKey || input.publicKey.byteLength !== 65 || input.publicKey[0] !== 0x04) return null;

  // The offer ack only needs to BIND the answer to this exact offer. 15 bytes
  // = 120 bits = exactly 20 base64url chars, so the packed ack is a clean
  // STRING PREFIX of the full 43-char hash — the host verifies it with a
  // plain startsWith and still gets a ~120-bit binding.
  const ackFull = input.ackOfOffer ? base64UrlToBytes(input.ackOfOffer) : null;
  if (ackFull && ackFull.byteLength !== 32) return null;
  const ack = ackFull ? ackFull.slice(0, 15) : null;

  const labelBytes = input.device ? new TextEncoder().encode(input.device) : null;
  if (labelBytes && labelBytes.byteLength > MAX_LABEL_BYTES) return null;

  const hasAck = !!ack;
  const hasLabel = !!labelBytes;
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.floor((Date.now() + 10 * 60 * 1000) / 1000);

  const w = new ByteWriter();
  w.u8(2);
  w.u8(input.kind === 'answer' ? 1 : 0);
  w.u32(now);
  w.u32(exp);
  w.u8((hasAck ? 0x01 : 0) | (hasLabel ? 0x02 : 0));
  w.bytes(input.publicKey);
  if (hasAck) w.bytes(ack!);
  if (hasLabel) {
    w.u8(labelBytes!.byteLength);
    w.bytes(labelBytes!);
  }
  w.u8(essentials.ufrag.length).ascii(essentials.ufrag);
  w.u8(essentials.pwd.length).ascii(essentials.pwd);
  w.bytes(hexToBytes(essentials.fingerprintHex.replace(/:/g, '')));
  w.u8(essentials.setup === 'actpass' ? 0 : essentials.setup === 'active' ? 1 : 2);
  w.u16(essentials.sctpPort);
  // Preserve the offer's SCTP max-message-size — dropping it would silently
  // re-negotiate a 64 KiB ceiling and break 64 KiB framed file chunks.
  w.u32(essentials.maxMessageSize ?? 0);
  w.u8(essentials.candidates.length);
  for (const c of essentials.candidates) {
    w.u8(c.type === 'host' ? 0 : c.type === 'srflx' ? 1 : 2);
    w.u8(c.ip.length).ascii(c.ip);
    w.u16(c.port);
    if (c.type !== 'host') {
      w.u8((c.raddr ?? '').length).ascii(c.raddr ?? '');
      w.u16(c.rport ?? 0);
    }
  }

  const bytes = w.build();
  if (bytes.byteLength > 480) return null; // would exceed one-QR budget after base64url
  return COMPACT_PREFIX + bytesToBase64Url(bytes);
}

class ByteReader {
  private pos = 0;
  constructor(private b: Uint8Array) {}
  remaining() {
    return this.b.byteLength - this.pos;
  }
  u8(): number {
    if (this.remaining() < 1) throw new Error('invalid-format');
    return this.b[this.pos++];
  }
  u16(): number {
    if (this.remaining() < 2) throw new Error('invalid-format');
    const v = this.b[this.pos] | (this.b[this.pos + 1] << 8);
    this.pos += 2;
    return v;
  }
  u32(): number {
    if (this.remaining() < 4) throw new Error('invalid-format');
    const v =
      (this.b[this.pos] | (this.b[this.pos + 1] << 8) | (this.b[this.pos + 2] << 16) | (this.b[this.pos + 3] << 24)) >>> 0;
    this.pos += 4;
    return v;
  }
  bytes(n: number): Uint8Array {
    if (this.remaining() < n) throw new Error('invalid-format');
    const out = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  ascii(n: number): string {
    const b = this.bytes(n);
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = b[i];
      if (c < 0x21 || c > 0x7e) throw new Error('invalid-format'); // printable, no spaces/control
      s += String.fromCharCode(c);
    }
    return s;
  }
}

/** Parse an NDP2 code. Throws PairingError on any problem. */
export function parseCompactCode(code: string): ParsedPairingPayload {
  if (!code.startsWith(COMPACT_PREFIX)) throw new Error('invalid-format');
  let b: Uint8Array;
  try {
    b = base64UrlToBytes(code.slice(COMPACT_PREFIX.length));
  } catch {
    throw new Error('invalid-format');
  }

  const r = new ByteReader(b);
  const version = r.u8();
  if (version !== 2) throw new Error('invalid-format');
  const kindByte = r.u8();
  if (kindByte !== 0 && kindByte !== 1) throw new Error('invalid-format');
  const kind: 'offer' | 'answer' = kindByte === 0 ? 'offer' : 'answer';
  const ts = r.u32();
  const exp = r.u32();
  const flags = r.u8();

  const publicKey = r.bytes(65);
  if (publicKey[0] !== 0x04) throw new Error('invalid-format');

  let ackOfOffer: string | undefined;
  if (flags & 0x01) {
    ackOfOffer = bytesToBase64Url(r.bytes(15));
  }
  let device: string | undefined;
  if (flags & 0x02) {
    const len = r.u8();
    if (len === 0 || len > MAX_LABEL_BYTES) throw new Error('invalid-format');
    device = new TextDecoder().decode(r.bytes(len));
  }

  const ufragLen = r.u8();
  if (ufragLen === 0 || ufragLen > MAX_UFRAG) throw new Error('invalid-format');
  const ufrag = r.ascii(ufragLen);
  const pwdLen = r.u8();
  if (pwdLen === 0 || pwdLen > MAX_PWD) throw new Error('invalid-format');
  const pwd = r.ascii(pwdLen);
  const fingerprint = r.bytes(32);
  const setupByte = r.u8();
  if (setupByte > 2) throw new Error('invalid-format');
  const setup = setupByte === 0 ? 'actpass' : setupByte === 1 ? 'active' : 'passive';
  const sctpPort = r.u16();
  if (sctpPort === 0) throw new Error('invalid-format');
  const maxMessageSize = r.u32();
  const candCount = r.u8();
  if (candCount === 0 || candCount > MAX_CANDIDATES) throw new Error('invalid-format');

  const candidates: string[] = [];
  for (let i = 0; i < candCount; i++) {
    const typeByte = r.u8();
    if (typeByte > 2) throw new Error('invalid-format');
    const ipLen = r.u8();
    if (ipLen === 0 || ipLen > 45) throw new Error('invalid-format');
    const ip = r.ascii(ipLen);
    const port = r.u16();
    if (port === 0) throw new Error('invalid-format');
    let raddr = '';
    let rport = 0;
    if (typeByte !== 0) {
      const raddrLen = r.u8();
      if (raddrLen === 0 || raddrLen > 45) throw new Error('invalid-format');
      raddr = r.ascii(raddrLen);
      rport = r.u16();
      if (rport === 0) throw new Error('invalid-format');
    }
    const type = typeByte === 0 ? 'host' : typeByte === 1 ? 'srflx' : 'relay';
    // Priority: convention values (host > srflx > relay), as in Chrome's own gathers.
    const prio = type === 'host' ? 2130706431 : type === 'srflx' ? 1694498815 : 16777215;
    const foundation = type === 'host' ? '1' : type === 'srflx' ? '2' : '3';
    candidates.push(
      type === 'host'
        ? `a=candidate:${foundation} 1 UDP ${prio} ${ip} ${port} typ host`
        : `a=candidate:${foundation} 1 UDP ${prio} ${ip} ${port} typ ${type} raddr ${raddr} rport ${rport}`
    );
  }
  if (r.remaining() !== 0) throw new Error('invalid-format'); // trailing junk = reject

  // Freshness (mandatory metadata — same rule as v1)
  const nowMs = Date.now();
  if (exp * 1000 + 2 * 60 * 1000 < nowMs) throw new Error('expired');
  if (exp < ts) throw new Error('invalid-format');

  const sdp = buildCanonicalSdp({
    kind,
    ufrag,
    pwd,
    fingerprintHex: bytesToHexColon(Array.from(fingerprint)),
    setup,
    sctpPort,
    maxMessageSize,
    candidates,
  });

  const pkCopy = new ArrayBuffer(publicKey.byteLength);
  new Uint8Array(pkCopy).set(publicKey);
  return {
    kind,
    sdp,
    peerPublicKey: pkCopy,
    createdAt: ts * 1000,
    expiresAt: exp * 1000,
    ackOfOffer,
    device,
  };
}

function buildCanonicalSdp(e: {
  kind: 'offer' | 'answer';
  ufrag: string;
  pwd: string;
  fingerprintHex: string;
  setup: 'actpass' | 'active' | 'passive';
  sctpPort: number;
  /** 0 = the source SDP had no a=max-message-size attribute. */
  maxMessageSize: number;
  candidates: string[];
}): string {
  // Session id: derived from the fingerprint (any large number is valid —
  // browsers do not match o= lines across peers).
  const sid =
    e.ufrag.length >= 4
      ? e.ufrag.charCodeAt(0) * 100000 + e.ufrag.charCodeAt(1) * 1000 + e.ufrag.charCodeAt(2) * 10 + e.ufrag.charCodeAt(3)
      : 4611731400430051;
  const lines = [
    'v=0',
    `o=- ${sid} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${e.ufrag}`,
    `a=ice-pwd:${e.pwd}`,
    `a=fingerprint:sha-256 ${e.fingerprintHex}`,
    `a=setup:${e.setup}`,
    'a=mid:0',
    `a=sctp-port:${e.sctpPort}`,
    ...(e.maxMessageSize > 0 ? [`a=max-message-size:${e.maxMessageSize}`] : []),
    ...e.candidates,
    'a=end-of-candidates',
  ];
  // SDP (RFC 8866) requires CRLF on every line, including the last.
  return lines.join('\r\n') + '\r\n';
}
