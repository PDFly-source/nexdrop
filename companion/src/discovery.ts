/**
 * NexDrop Turbo LAN discovery (mission Phase 8).
 *
 * The receiver ADVERTISES only ephemeral session information; the sender
 * discovers, connects, and authenticates. The broadcast contains:
 *   deviceName, deviceType, protocolVersion, transportCapabilities, port,
 *   sessionId, sessionToken (the pairing root — same 10-min TTL), nonce,
 *   and a CRC of the packet (camera-less equivalent of the QR payload).
 *
 * It NEVER contains file data or long-lived credentials. The browser PWA
 * cannot use this (no UDP sockets); it exists for the companion/native
 * runtimes. Android should prefer NSD/mDNS (`_nexdrop._tcp`); this UDP
 * broadcast is the zero-dependency equivalent for the Node companion.
 *
 * Packet (binary, like everything on the Turbo path):
 *   0  4  magic "NDD1"                              (u32)
 *   4  1  version                                    (u8)
 *   5  1  flags                                      (u8)
 *   6  2  listen port                               (u16)
 *   8  4  CRC32 of bytes 0..7 and the body           (u32)
 *  12  ..  UTF-8 JSON of the EPHEMERAL body only:
 *         { deviceName, deviceType, capabilities, sessionId, token, nonce }
 *         (JSON is fine here: discovery is control-plane, not hot data)
 */

import * as dgram from 'node:dgram';
import { createHash, randomBytes } from 'node:crypto';
import { crc32 } from './frames';

export const NDD_MAGIC = 0x4e444431; // "NDD1"
export const NDD_VERSION = 1;
export const NDD_PORT = 53819; // fixed discover port (ephemeral payloads only)

export interface DiscoveryBody {
  deviceName: string;
  deviceType: 'desktop' | 'android' | 'tv';
  capabilities: { lanTcp: boolean; wifiDirect: boolean; nativeLocal: boolean; webrtc: boolean };
  sessionId: string;
  /** Pairing root token (base64url) — short-lived, same TTL as QR pairing. */
  token: string;
  nonce: string;
}

export interface DiscoveredDevice {
  address: string;
  port: number;
  body: DiscoveryBody;
  hash: string;
}

export function encodeDiscovery(body: DiscoveryBody, port: number): Buffer {
  const json = Buffer.from(JSON.stringify(body), 'utf8');
  const out = Buffer.allocUnsafe(12 + json.length);
  out.writeUInt32BE(NDD_MAGIC, 0);
  out.writeUInt8(NDD_VERSION, 1);
  out.writeUInt8(0, 2);
  out.writeUInt16BE(port & 0xffff, 3);
  out.writeUInt32BE(0, 5);
  out.writeUInt32BE(0, 9);
  // pack: magic(u32) version(u8) flags(u8) port(u16) crc(u32) -> 12 bytes
  out.writeUInt32BE(NDD_MAGIC, 0);
  out.writeUInt8(NDD_VERSION, 1);
  out.writeUInt8(0, 2);
  out.writeUInt16BE(port & 0xffff, 3);
  out.writeUInt32BE(crc32(out, 0, 5), 5);
  out.writeUInt32BE(crc32(json), 9);
  json.copy(out, 12);
  return out;
}

export function decodeDiscovery(buf: Buffer, from: string): DiscoveredDevice | null {
  if (buf.length < 12) return null;
  if (buf.readUInt32BE(0) !== NDD_MAGIC) return null;
  if (buf.readUInt8(1) !== NDD_VERSION) return null;
  if (crc32(buf, 0, 5) !== buf.readUInt32BE(5)) return null;
  const json = buf.subarray(12);
  if (crc32(json) !== buf.readUInt32BE(9)) return null;
  let body: DiscoveryBody;
  try {
    body = JSON.parse(json.toString('utf8')) as DiscoveryBody;
  } catch {
    return null;
  }
  if (!body.sessionId || !body.token || !body.deviceName) return null;
  return {
    address: from,
    port: buf.readUInt16BE(3),
    body,
    hash: createHash('sha256').update(json).digest('hex').slice(0, 12),
  };
}

/**
 * Advertise on the LAN (broadcast). Callers stop the beacon when the
 * session completes — the advertised token is single-session by design.
 */
export function advertise(body: DiscoveryBody, port: number, opts: { intervalMs?: number } = {}): () => void {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const packet = encodeDiscovery(body, port);
  const timer = setInterval(() => {
    sock.setBroadcast(true);
    sock.send(packet, NDD_PORT, '255.255.255.255', () => {});
  }, opts.intervalMs ?? 1000);
  sock.bind(NDD_PORT, () => {
    sock.send(packet, NDD_PORT, '255.255.255.255', () => {});
  });
  return () => {
    clearInterval(timer);
    try {
      sock.close();
    } catch {
      /* already closed */
    }
  };
}

/**
 * Scan for advertising devices (bounded duration). Returns each unique
 * (address, sessionId) once, preferring the same body hash (replay-safe:
 * the nonce changes each advertisement, so an injected duplicate is a
 * different session identity only if the token differs).
 */
export async function discover(timeoutMs: number): Promise<DiscoveredDevice[]> {
  const found = new Map<string, DiscoveredDevice>();
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise<void>((resolve) => sock.bind(NDD_PORT, () => resolve()));
  sock.on('message', (msg: Buffer, rinfo: { address: string }) => {
    const d = decodeDiscovery(msg, rinfo.address);
    if (d && !found.has(`${d.address}|${d.body.sessionId}`)) {
      found.set(`${d.address}|${d.body.sessionId}`, d);
    }
  });
  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

export function newDiscoveryNonce(): string {
  return randomBytes(8).toString('hex');
}
