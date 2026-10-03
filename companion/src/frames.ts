/**
 * NexDrop Turbo wire protocol v1 — binary framing for the native TCP path.
 *
 * Design rules (mission Phase 4):
 *  - binary encoding only; no base64, no JSON on the hot data path,
 *  - small fixed-size header so a streaming decoder never re-buffers,
 *  - every DATA frame carries an explicit offset so resume/reconnect can
 *    continue from any durable point without re-ordering assumptions,
 *  - flow control via CREDIT frames (receiver-bounded, never RAM-unbounded),
 *  - integrity: SHA-256 of the whole file, compared on both ends; the frame
 *    header carries a CRC32 of the header itself (cheap misframe detection).
 *
 * Wire format (all integers big-endian):
 *
 *   0  4  magic "NDT1"                          (u32)
 *   4  1  version = 1                           (u8)
 *   5  1  frame type                            (u8)
 *   6  2  flags                                 (u16)
 *   8  4  payload length  (max 8 MiB)           (u32)
 *  12  4  header CRC32 (bytes 0..11)            (u32)
 *  16 ..  payload (length bytes)
 *
 * DATA payload:
 *   0  4  fileId                                (u32)
 *   4  8  byte offset of this payload           (u64)
 *  12  8  total file size                       (u64)
 *  20  4  payload byte length                   (u32)
 *  24 ..  file bytes (bounded by negotiated read size)
 *
 * No JSON anywhere. Control payloads are fixed binary structs, defined
 * next to their frame types below.
 */

export const NDT_MAGIC = 0x4e445431; // "NDT1"
export const NDT_VERSION = 1;
export const NDT_HEADER_SIZE = 16;
export const NDT_MAX_PAYLOAD = 8 * 1024 * 1024;

export enum FrameType {
  HELLO = 0x01, // {nonce u32, sessionIdLen u8, sessionId, tokenLen u16, tokenProofBytes}
  AUTH_OK = 0x02, // {nonce u32} — challenge echoed after HMAC verification
  REJECT = 0x03, // {reasonCode u8}
  OFFER = 0x10, // fileMeta: {fileId u32, sizeBytes u64, nameLen u16, name utf8, shaLen u8, sha hex ascii}
  READY = 0x11, // {fileId u32, durableOffset u64} — receiver's resume point + go signal
  DATA = 0x20, // {fileId u32, offset u64, sizeBytes u64, len u32, bytes}
  CREDIT = 0x21, // {fileId u32, creditBytes u32} — receiver grants sender more window
  PAUSE = 0x30, // {fileId u32}
  RESUME = 0x31, // {fileId u32}
  CANCEL = 0x32, // {fileId u32}
  PROGRESS = 0x40, // {fileId u32, durableOffset u64} — receiver's durable position
  COMPLETE = 0x50, // {fileId u32, shaLen u8, sha hex ascii} — sender declares + hash
  VERIFY_OK = 0x51, // {fileId u32} — receiver's durable SHA matches
  VERIFY_FAIL = 0x52, // {fileId u32, shaLen u8, sha hex ascii} — receiver's durable hash
  ERROR = 0x7f, // {code u8}
  PING = 0x60, // {nonce u32}
  PONG = 0x61, // {nonce u32}
}

export interface NdtHeader {
  type: FrameType;
  flags: number;
  length: number;
}

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE) of a byte range — header integrity + broadcast checksums. */
export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Encode one frame with a pre-serialized payload. */
export function encodeFrame(type: FrameType, flags: number, payload: Uint8Array): Buffer {
  if (payload.length > NDT_MAX_PAYLOAD) {
    throw new Error(`frame payload ${payload.length} exceeds cap ${NDT_MAX_PAYLOAD}`);
  }
  const out = Buffer.allocUnsafe(NDT_HEADER_SIZE + payload.length);
  out.writeUInt32BE(NDT_MAGIC, 0);
  out.writeUInt8(NDT_VERSION, 4);
  out.writeUInt8(type, 5);
  out.writeUInt16BE(flags & 0xffff, 6);
  out.writeUInt32BE(payload.length, 8);
  out.writeUInt32BE(0, 12);
  out.writeUInt32BE(crc32(out, 0, 12), 12);
  out.set(payload, NDT_HEADER_SIZE);
  return out;
}

/** Encode a DATA frame (fixed struct + file bytes, single copy into `into`). */
export function encodeDataFrame(
  fileId: number,
  offset: number,
  fileSize: number,
  bytes: Uint8Array,
  into?: Buffer
): Buffer {
  const len = bytes.length;
  if (len + 24 > NDT_MAX_PAYLOAD) throw new Error('data frame too large');
  const out =
    into && into.length >= NDT_HEADER_SIZE + 24 + len ? into.subarray(0, NDT_HEADER_SIZE + 24 + len) : Buffer.allocUnsafe(NDT_HEADER_SIZE + 24 + len);
  out.writeUInt32BE(NDT_MAGIC, 0);
  out.writeUInt8(NDT_VERSION, 4);
  out.writeUInt8(FrameType.DATA, 5);
  out.writeUInt16BE(0, 6);
  out.writeUInt32BE(24 + len, 8);
  out.writeUInt32BE(0, 12);
  out.writeUInt32BE(crc32(out, 0, 12), 12);
  out.writeUInt32BE(fileId, NDT_HEADER_SIZE);
  out.writeBigUInt64BE(BigInt(offset), NDT_HEADER_SIZE + 4);
  out.writeBigUInt64BE(BigInt(fileSize), NDT_HEADER_SIZE + 12);
  out.writeUInt32BE(len, NDT_HEADER_SIZE + 20);
  Buffer.from(bytes.buffer, bytes.byteOffset, len).copy(out, NDT_HEADER_SIZE + 24);
  return out;
}

/** Parse a 16-byte header (does not touch the payload). Throws on any mismatch. */
export function parseHeader(buf: Uint8Array): NdtHeader {
  if (buf.length < NDT_HEADER_SIZE) throw new Error('short header');
  const b = Buffer.from(buf.buffer, buf.byteOffset, NDT_HEADER_SIZE);
  if (b.readUInt32BE(0) !== NDT_MAGIC) throw new Error('bad magic (not NDT1)');
  if (b.readUInt8(4) !== NDT_VERSION) throw new Error(`unsupported version ${b.readUInt8(4)}`);
  const type = b.readUInt8(5);
  if (!(type in FrameTypeName)) throw new Error(`unknown frame type 0x${type.toString(16)}`);
  const length = b.readUInt32BE(8);
  if (length > NDT_MAX_PAYLOAD) throw new Error(`frame length ${length} exceeds cap`);
  if (crc32(b, 0, 12) !== b.readUInt32BE(12)) throw new Error('header CRC mismatch');
  return { type, flags: b.readUInt16BE(6), length };
}

const FrameTypeName: Record<number, string> = {
  [FrameType.HELLO]: 'HELLO',
  [FrameType.AUTH_OK]: 'AUTH_OK',
  [FrameType.REJECT]: 'REJECT',
  [FrameType.OFFER]: 'OFFER',
  [FrameType.READY]: 'READY',
  [FrameType.PROGRESS]: 'PROGRESS',
  [FrameType.DATA]: 'DATA',
  [FrameType.CREDIT]: 'CREDIT',
  [FrameType.PAUSE]: 'PAUSE',
  [FrameType.RESUME]: 'RESUME',
  [FrameType.CANCEL]: 'CANCEL',
  [FrameType.COMPLETE]: 'COMPLETE',
  [FrameType.VERIFY_OK]: 'VERIFY_OK',
  [FrameType.VERIFY_FAIL]: 'VERIFY_FAIL',
  [FrameType.ERROR]: 'ERROR',
  [FrameType.PING]: 'PING',
  [FrameType.PONG]: 'PONG',
};

/**
 * Streaming frame decoder — feed arbitrary socket chunks, get parsed frames.
 * Bounded: at most one frame payload buffered at a time (<= 8 MiB + header),
 * enforced by the protocol's length cap.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  /** High-water mark of buffered bytes (telemetry for unbounded-buffer bugs). */
  bufferedBytesHighWater = 0;

  push(chunk: Uint8Array): Array<{ type: FrameType; flags: number; payload: Buffer }> {
    const out: Array<{ type: FrameType; flags: number; payload: Buffer }> = [];
    this.buf = this.buf.length === 0 ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length) : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < NDT_HEADER_SIZE) break;
      let header: NdtHeader;
      try {
        header = parseHeader(this.buf.subarray(0, NDT_HEADER_SIZE));
      } catch (err) {
        this.buf = Buffer.alloc(0);
        throw err;
      }
      if (this.buf.length < NDT_HEADER_SIZE + header.length) break;
      const payload = this.buf.subarray(NDT_HEADER_SIZE, NDT_HEADER_SIZE + header.length);
      out.push({ type: header.type, flags: header.flags, payload: Buffer.from(payload) });
      this.buf = this.buf.subarray(NDT_HEADER_SIZE + header.length);
    }
    if (this.buf.length > this.bufferedBytesHighWater) this.bufferedBytesHighWater = this.buf.length;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Control-frame payload codecs (fixed binary structs — no JSON).
// ---------------------------------------------------------------------------

export function encodeHello(sessionId: string, tokenProof: Uint8Array, nonce: number): Buffer {
  const id = Buffer.from(sessionId, 'utf8');
  if (id.length > 255) throw new Error('sessionId too long');
  if (tokenProof.length > 65535) throw new Error('token proof too long');
  const p = Buffer.allocUnsafe(7 + id.length + tokenProof.length);
  p.writeUInt32BE(nonce, 0);
  p.writeUInt8(id.length, 4);
  id.copy(p, 5);
  p.writeUInt16BE(tokenProof.length, 5 + id.length);
  Buffer.from(tokenProof).copy(p, 7 + id.length);
  return p;
}

export function decodeHello(p: Buffer): { sessionId: string; tokenProof: Buffer; nonce: number } {
  const nonce = p.readUInt32BE(0);
  const idLen = p.readUInt8(4);
  const sessionId = p.toString('utf8', 5, 5 + idLen);
  const proofLen = p.readUInt16BE(5 + idLen);
  const tokenProof = p.subarray(7 + idLen, 7 + idLen + proofLen);
  return { sessionId, tokenProof, nonce };
}

export function encodeNonce(type: FrameType, nonce: number): Buffer {
  const p = Buffer.alloc(4);
  p.writeUInt32BE(nonce, 0);
  return p;
}

export function decodeNonce(p: Buffer): number {
  return p.readUInt32BE(0);
}

export function encodeOffer(
  fileId: number,
  sizeBytes: number,
  name: string,
  sha256Hex: string
): Buffer {
  const nameB = Buffer.from(name, 'utf8');
  if (nameB.length > 65535) throw new Error('file name too long');
  const sha = Buffer.from(sha256Hex, 'ascii');
  if (sha.length > 255) throw new Error('bad sha length');
  const p = Buffer.allocUnsafe(15 + nameB.length + sha.length);
  p.writeUInt32BE(fileId, 0);
  p.writeBigUInt64BE(BigInt(sizeBytes), 4);
  p.writeUInt16BE(nameB.length, 12);
  nameB.copy(p, 14);
  p.writeUInt8(sha.length, 14 + nameB.length);
  sha.copy(p, 15 + nameB.length);
  return p;
}

export function decodeOffer(p: Buffer): { fileId: number; sizeBytes: number; name: string; sha256: string } {
  const fileId = p.readUInt32BE(0);
  const sizeBytes = Number(p.readBigUInt64BE(4));
  const nameLen = p.readUInt16BE(12);
  const name = p.toString('utf8', 14, 14 + nameLen);
  const shaLen = p.readUInt8(14 + nameLen);
  const sha256 = p.toString('ascii', 15 + nameLen, 15 + nameLen + shaLen);
  return { fileId, sizeBytes, name, sha256 };
}

export function encodeOffset(fileId: number, offset: number, size?: number): Buffer {
  const p = size === undefined ? Buffer.alloc(12) : Buffer.alloc(16);
  p.writeUInt32BE(fileId, 0);
  p.writeBigUInt64BE(BigInt(offset), 4);
  if (size !== undefined) p.writeUInt32BE(size, 12);
  return p;
}

export function decodeOffset(p: Buffer): { fileId: number; offset: number } {
  return { fileId: p.readUInt32BE(0), offset: Number(p.readBigUInt64BE(4)) };
}

export function decodeCredit(p: Buffer): { fileId: number; creditBytes: number } {
  return { fileId: p.readUInt32BE(0), creditBytes: p.readUInt32BE(4) };
}

export function decodeData(p: Buffer): { fileId: number; offset: number; sizeBytes: number; bytes: Buffer } {
  const fileId = p.readUInt32BE(0);
  const offset = Number(p.readBigUInt64BE(4));
  const sizeBytes = Number(p.readBigUInt64BE(12));
  const len = p.readUInt32BE(20);
  if (p.length < 24 + len) throw new Error('short DATA payload');
  return { fileId, offset, sizeBytes, bytes: p.subarray(24, 24 + len) };
}

export function encodeComplete(fileId: number, sha256Hex: string): Buffer {
  const sha = Buffer.from(sha256Hex, 'ascii');
  const p = Buffer.allocUnsafe(5 + sha.length);
  p.writeUInt32BE(fileId, 0);
  p.writeUInt8(sha.length, 4);
  sha.copy(p, 5);
  return p;
}

export function decodeComplete(p: Buffer): { fileId: number; sha256: string } {
  const fileId = p.readUInt32BE(0);
  const len = p.readUInt8(4);
  return { fileId, sha256: p.toString('ascii', 5, 5 + len) };
}
