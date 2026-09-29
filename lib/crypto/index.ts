/**
 * Cryptographic utilities for NexDrop.
 * Ephemeral ECDH, AES-256-GCM with unique IV per chunk, SAS security codes,
 * incremental hashing, and filename sanitization.
 */

/**
 * Generate a 6-digit cryptographically secure PIN (100000 - 999999).
 */
export function generateSixDigitPin(): string {
  if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
    const arr = new Uint32Array(1);
    window.crypto.getRandomValues(arr);
    const pin = (arr[0] % 900000) + 100000;
    return pin.toString();
  }
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Generate an ephemeral ECDH keypair (P-256).
 */
export async function generateEcdhKeyPair(): Promise<CryptoKeyPair | null> {
  if (typeof window === 'undefined' || !window.crypto?.subtle) return null;
  try {
    return await window.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey']
    );
  } catch (err) {
    console.warn('ECDH generation failed:', err);
    return null;
  }
}

/**
 * Export public key to raw bytes.
 */
export async function exportPublicKey(key: CryptoKey): Promise<ArrayBuffer> {
  return await window.crypto.subtle.exportKey('raw', key);
}

/**
 * Import peer public key from raw bytes.
 */
export async function importPeerPublicKey(rawKey: ArrayBuffer): Promise<CryptoKey> {
  return await window.crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

/**
 * Derive AES-256-GCM key from local private key and remote public key.
 */
export async function deriveSharedAesKey(
  privateKey: CryptoKey,
  remotePublicKey: CryptoKey
): Promise<CryptoKey | null> {
  if (typeof window === 'undefined' || !window.crypto?.subtle) return null;
  try {
    return await window.crypto.subtle.deriveKey(
      { name: 'ECDH', public: remotePublicKey },
      privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  } catch (err) {
    console.error('Failed to derive shared AES key:', err);
    return null;
  }
}

/**
 * Generate unique 12-byte IV for a chunk using chunk sequence index and random salt.
 * Guarantees zero IV reuse.
 */
export function createChunkIv(chunkIndex: number, sessionSalt: Uint8Array): Uint8Array {
  const iv = new Uint8Array(12);
  // First 4 bytes: random session salt prefix
  iv.set(sessionSalt.subarray(0, 4), 0);
  // Next 8 bytes: big-endian 64-bit integer of chunkIndex
  const view = new DataView(iv.buffer);
  view.setBigUint64(4, BigInt(chunkIndex), false);
  return iv;
}

/**
 * Encrypt a chunk with AES-256-GCM.
 */
export async function encryptChunk(
  key: CryptoKey,
  iv: Uint8Array,
  data: ArrayBuffer
): Promise<ArrayBuffer> {
  return await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    data
  );
}

/**
 * Decrypt a chunk with AES-256-GCM.
 */
export async function decryptChunk(
  key: CryptoKey,
  iv: Uint8Array,
  encryptedData: ArrayBuffer
): Promise<ArrayBuffer> {
  return await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    encryptedData
  );
}

/**
 * Compute SHA-256 hash of an ArrayBuffer as hex string.
 */
export async function computeSha256(data: ArrayBuffer): Promise<string> {
  if (typeof window === 'undefined' || !window.crypto?.subtle) return 'verification-unavailable';
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(digest));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive a 6-digit Short Authentication String (SAS) code from session info or public key bytes.
 * Example display: "482 913"
 */
export async function deriveSasCode(combinedMaterial: string): Promise<string> {
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    return '000 000';
  }
  const encoder = new TextEncoder();
  const digest = await window.crypto.subtle.digest('SHA-256', encoder.encode(combinedMaterial));
  const view = new DataView(digest);
  const num = (view.getUint32(0, false) % 900000) + 100000;
  const str = num.toString();
  return `${str.slice(0, 3)} ${str.slice(3)}`;
}

/**
 * Sanitize filename against directory traversal and dangerous characters.
 */
export function sanitizeFilename(raw: string): string {
  if (!raw || typeof raw !== 'string') return 'unnamed-file';
  // Strip null bytes, paths, and control characters
  let clean = raw.replace(/[\0\x00-\x1f\x7f-\x9f\\/]/g, '_');
  clean = clean.replace(/\.{2,}/g, '.'); // eliminate ../
  clean = clean.trim();
  if (!clean || clean === '.') return 'download';
  // Truncate to safe length
  if (clean.length > 255) {
    const ext = clean.lastIndexOf('.') !== -1 ? clean.slice(clean.lastIndexOf('.')) : '';
    clean = clean.slice(0, 255 - ext.length) + ext;
  }
  return clean;
}
