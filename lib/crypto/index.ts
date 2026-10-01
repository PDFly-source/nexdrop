/**
 * Cryptographic utilities for NexDrop.
 *
 * - Ephemeral ECDH (P-256) key agreement exchanged inside the QR/paste pairing payload
 * - HKDF-SHA256 key derivation
 * - AES-256-GCM application-layer chunk encryption with unique IVs (no reuse)
 * - Incremental (streaming) SHA-256 for integrity verification of any file size
 * - Short Authentication String (SAS) derived from the ACTUAL shared secret,
 *   so it is cryptographically tied to this handshake.
 *
 * Only standard Web Crypto APIs are used. No custom algorithms, no hardcoded keys.
 */

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function stringToBytes(text: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(text);
  // Copy into a plain ArrayBuffer-backed view for strict BufferSource typing
  const out = new Uint8Array(encoded.byteLength);
  out.set(encoded);
  return out;
}

// ---------------------------------------------------------------------------
// ECDH key agreement
// ---------------------------------------------------------------------------

export async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
}

export async function exportPublicKeyRaw(key: CryptoKey): Promise<ArrayBuffer> {
  return await crypto.subtle.exportKey('raw', key);
}

export async function importPublicKeyRaw(raw: ArrayBuffer): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

/** Derive raw shared bits (32 bytes) via ECDH. */
export async function deriveSharedBits(
  privateKey: CryptoKey,
  remotePublicKey: CryptoKey
): Promise<ArrayBuffer> {
  return await crypto.subtle.deriveBits(
    { name: 'ECDH', public: remotePublicKey },
    privateKey,
    256
  );
}

// ---------------------------------------------------------------------------
// HKDF-SHA256 (implemented with Web Crypto Hkdf support)
// ---------------------------------------------------------------------------

async function hkdf(master: ArrayBuffer, info: string, lengthBytes: number): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  return await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // No salt: the ECDH shared secret already has full entropy.
      salt: new Uint8Array(new ArrayBuffer(0)),
      info: stringToBytes(info),
    },
    keyMaterial,
    lengthBytes * 8
  );
}

/** Derive the AES-256-GCM session key used for app-layer chunk encryption. */
export async function deriveSessionAesKey(
  sharedBits: ArrayBuffer
): Promise<CryptoKey> {
  const raw = await hkdf(sharedBits, 'nexdrop-e2ee-v1', 32);
  return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Derive a 6-digit Short Authentication String from the actual ECDH shared
 * secret. Both devices compute the same code; it is a real verification
 * mechanism against a manipulated pairing payload exchange.
 */
export async function deriveSasCode(sharedBits: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(await hkdf(sharedBits, 'nexdrop-sas-v1', 4));
  const view = new DataView(bytes.buffer);
  const num = view.getUint32(0) % 1000000;
  const code = num.toString().padStart(6, '0');
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

// ---------------------------------------------------------------------------
// AES-256-GCM chunk encryption
// ---------------------------------------------------------------------------

export interface ChunkCipher {
  /** Session AES-256-GCM key (non-extractable, derived from the ECDH secret). */
  key: CryptoKey;
}

export async function createChunkCipher(key: CryptoKey): Promise<ChunkCipher> {
  return { key };
}

/**
 * Per-transfer random IV prefix (6 bytes, CSPRNG). Sent in FILE_START so the
 * receiver derives identical IVs. This is what guarantees IVs are NEVER
 * reused across two different files in the same session — a plain
 * per-transfer chunk counter restarting at 0 would repeat the exact same
 * (key, IV) pairs for the second, third, ... file of a session, which is
 * catastrophic for GCM (keystream reuse + authentication-key recovery).
 */
export function generateIvPrefix(): Uint8Array {
  const prefix = new Uint8Array(6);
  crypto.getRandomValues(prefix);
  return prefix;
}

/**
 * Build a unique 12-byte GCM IV for a chunk index:
 *   6-byte per-transfer random prefix + 6-byte big-endian chunk counter.
 * Within one transfer the counter is unique per chunk; across transfers in
 * a session the random prefix makes an IV collision negligibly unlikely
 * (2^-48 per transfer pair). Cross-session reuse is irrelevant because
 * each session derives a fresh AES key.
 */
export function chunkIv(ivPrefix: Uint8Array, chunkIndex: number): Uint8Array {
  if (ivPrefix.length !== 6) throw new Error('invalid-iv-prefix');
  const counter = Math.floor(chunkIndex);
  // 6-byte big-endian counter. Chunk indexes are bounded by the uint32 wire
  // header, so plain number math is exact here (< 2^32 << 2^53).
  if (!Number.isFinite(counter) || counter < 0 || counter >= 2 ** 48) {
    throw new Error('chunk-index-overflow');
  }
  const iv = new Uint8Array(12);
  iv.set(ivPrefix, 0);
  for (let i = 0; i < 6; i++) {
    iv[6 + i] = Math.floor(counter / 2 ** ((5 - i) * 8)) & 0xff;
  }
  return iv;
}

export async function encryptChunk(
  cipher: ChunkCipher,
  ivPrefix: Uint8Array,
  chunkIndex: number,
  data: ArrayBuffer
): Promise<ArrayBuffer> {
  return await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: chunkIv(ivPrefix, chunkIndex) as unknown as BufferSource },
    cipher.key,
    data
  );
}

export async function decryptChunk(
  cipher: ChunkCipher,
  ivPrefix: Uint8Array,
  chunkIndex: number,
  data: ArrayBuffer
): Promise<ArrayBuffer> {
  return await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: chunkIv(ivPrefix, chunkIndex) as unknown as BufferSource },
    cipher.key,
    data
  );
}

// ---------------------------------------------------------------------------
// Incremental SHA-256 (streaming — bounded memory for any file size)
// ---------------------------------------------------------------------------

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * Streaming SHA-256. Feed chunks of any size with update(), read the hex
 * digest with finalize(). Memory use is O(1) regardless of file size.
 */
export class IncrementalSha256 {
  private h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  /** Reusable message-schedule scratch — hoisted out of processBlock so the
   *  per-64-byte-block hot path performs ZERO allocations (one Uint32Array
   *  per block previously meant ~16k allocations/MiB hashed — measurable
   *  GC pressure on the mobile main thread at high chunk rates). */
  private w = new Uint32Array(64);
  private buffer = new Uint8Array(64);
  private bufferLength = 0;
  private bytesProcessed = 0; // total bytes (use BigInt-safe number up to 2^53)
  private finalized = false;

  update(data: Uint8Array): void {
    if (this.finalized) throw new Error('SHA-256 already finalized');

    let offset = 0;
    this.bytesProcessed += data.length;

    // Fill partial buffer first
    if (this.bufferLength > 0) {
      const need = 64 - this.bufferLength;
      const take = Math.min(need, data.length);
      this.buffer.set(data.subarray(0, take), this.bufferLength);
      this.bufferLength += take;
      offset = take;
      if (this.bufferLength === 64) {
        this.processBlock(this.buffer, 0);
        this.bufferLength = 0;
      }
    }

    // Process full 64-byte blocks directly from the input
    while (offset + 64 <= data.length) {
      this.processBlock(data, offset);
      offset += 64;
    }

    // Stash remainder
    if (offset < data.length) {
      this.buffer.set(data.subarray(offset), 0);
      this.bufferLength = data.length - offset;
    }
  }

  private processBlock(bytes: Uint8Array, offset: number): void {
    const w = this.w;
    w.fill(0);
    for (let i = 0; i < 16; i++) {
      w[i] =
        (bytes[offset + i * 4] << 24) |
        (bytes[offset + i * 4 + 1] << 16) |
        (bytes[offset + i * 4 + 2] << 8) |
        bytes[offset + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let [a, b, c, d, e, f, g, h] = this.h;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    this.h[0] = (this.h[0] + a) | 0;
    this.h[1] = (this.h[1] + b) | 0;
    this.h[2] = (this.h[2] + c) | 0;
    this.h[3] = (this.h[3] + d) | 0;
    this.h[4] = (this.h[4] + e) | 0;
    this.h[5] = (this.h[5] + f) | 0;
    this.h[6] = (this.h[6] + g) | 0;
    this.h[7] = (this.h[7] + h) | 0;
  }

  finalize(): string {
    if (this.finalized) throw new Error('SHA-256 already finalized');

    const bitLengthHi = Math.floor(this.bytesProcessed / 0x20000000); // bytes * 8 >> 32
    const bitLengthLo = (this.bytesProcessed % 0x20000000) * 8;

    // 0x80, zeros, then 8-byte big-endian bit length — sized so that
    // bufferLength + padLen + 8 lands exactly on a 64-byte block boundary.
    const padLen = (this.bufferLength < 56 ? 56 : 120) - this.bufferLength;
    const tail = new Uint8Array(padLen + 8);
    tail[0] = 0x80;
    const dv = new DataView(tail.buffer);
    dv.setUint32(padLen, bitLengthHi, false);
    dv.setUint32(padLen + 4, bitLengthLo >>> 0, false);

    this.update(tail);
    // Seal only after the padding update — update() refuses calls once sealed.
    this.finalized = true;

    if (this.bufferLength !== 0) {
      throw new Error('SHA-256 padding failed');
    }

    return Array.from(this.h)
      .map((x) => (x >>> 0).toString(16).padStart(8, '0'))
      .join('');
  }
}

/** SHA-256 of an ArrayBuffer as hex (one-shot, for small payloads). */
export async function computeSha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** SHA-256 of a string, returned base64url (for pairing ack fields). */
export async function computeSha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', stringToBytes(text));
  return bytesToBase64Url(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Generate a random ID. */
export function randomId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Sanitize a filename for safe local storage. */
export function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>\x00-\x1f]/g, '_').slice(0, 180) || 'nexdrop-file';
}
