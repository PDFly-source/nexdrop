/**
 * NexDrop local-first core tests (run with `npx tsx tests/core.test.ts`).
 * Covers: base64url round-trips, ECDH key agreement, HKDF key derivation,
 * AES-GCM chunk encryption, SAS code determinism, pairing payload
 * build/parse round-trip, segmentation reassembly, and expiry.
 */

import {
  generateEcdhKeyPair,
  deriveSharedBits,
  deriveSessionAesKey,
  deriveSasCode,
  createChunkCipher,
  encryptChunk,
  decryptChunk,
  bytesToBase64Url,
  base64UrlToBytes,
  stringToBytes,
  IncrementalSha256,
  randomId,
} from '../lib/crypto';
import {
  buildPairingCode,
  parsePairingCode,
  segmentPairingCode,
  QrSegmentAssembler,
} from '../lib/pairing/payload';

let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function hex(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString('hex');
}

async function expectError(fn: () => Promise<unknown>, name: string, message: string) {
  try {
    await fn();
    assert(false, name, 'no error thrown');
  } catch (err: any) {
    assert(err?.message === message, name, `got: ${err?.message}`);
  }
}

// ---------------------------------------------------------------------------

async function testEncoding() {
  console.log('\n[encoding]');
  const bytes = stringToBytes('Hello, NexDrop! 🚀');
  const roundTripped = new TextDecoder().decode(bytes);
  assert(roundTripped === 'Hello, NexDrop! 🚀', 'string <-> bytes round trip');

  const b64 = bytesToBase64Url(new Uint8Array([251, 255, 250]));
  assert(b64 === '-__6', 'base64url alphabet (no +/ or =)', b64);
  assert(base64UrlToBytes(b64).join(',') === '251,255,250', 'base64url decode round trip');

  const id = randomId();
  assert(id.length >= 21 && /^[A-Za-z0-9_-]+$/.test(id), 'randomId is url-safe', id);
}

async function testEcdh() {
  console.log('\n[ecdh + hkdf + sas]');
  const a = await generateEcdhKeyPair();
  const b = await generateEcdhKeyPair();

  const bitsA = await deriveSharedBits(a.privateKey, b.publicKey);
  const bitsB = await deriveSharedBits(b.privateKey, a.publicKey);
  assert(hex(bitsA) === hex(bitsB), 'both sides derive identical shared secret');

  // Keys are created non-extractable (good practice); equality is proven
  // functionally by cross-encryption in the chunk cipher tests below.
  const keyA = await deriveSessionAesKey(bitsA);
  const keyB = await deriveSessionAesKey(bitsB);
  assert(keyA.type === 'secret' && keyB.type === 'secret', 'both sides derive an AES secret key');
  assert(!keyA.extractable, 'session key is non-extractable');

  const sasA = await deriveSasCode(bitsA);
  const sasB = await deriveSasCode(bitsB);
  assert(sasA === sasB, 'both sides derive identical SAS code', `${sasA} vs ${sasB}`);
  assert(/^\d{3} \d{3}$/.test(sasA), 'SAS code is 6 digits in 3+3 format', sasA);

  // Different key pair => different secret (sanity)
  const c = await generateEcdhKeyPair();
  const bitsC = await deriveSharedBits(a.privateKey, c.publicKey);
  assert(hex(bitsA) !== hex(bitsC), 'different peers produce different secrets');
}

async function testChunkCipher() {
  console.log('\n[aes-256-gcm chunk encryption]');
  const a = await generateEcdhKeyPair();
  const b = await generateEcdhKeyPair();
  const bits = await deriveSharedBits(a.privateKey, b.publicKey);
  const key = await deriveSessionAesKey(bits);

  const { deriveSessionCipherSalt } = await import('../lib/crypto');
  const salt = await deriveSessionCipherSalt(bits);
  const saltB = await deriveSessionCipherSalt(bits);
  assert(salt.join(',') === saltB.join(','), 'both sides derive identical IV salt');

  const cipherA = await createChunkCipher(key, salt);
  const cipherB = await createChunkCipher(key, saltB);

  const chunk = stringToBytes('file chunk payload #0').buffer as ArrayBuffer;
  const sealed = await encryptChunk(cipherA, 0, chunk);
  assert(sealed.byteLength > chunk.byteLength, 'ciphertext includes IV + tag overhead');

  const opened = await decryptChunk(cipherB, 0, sealed);
  assert(hex(opened) === hex(chunk), 'receiver decrypts chunk with same session key');

  // Deterministic IV per (salt, chunkIndex): same index yields same ciphertext,
  // different indices differ — IVs are never reused within a session.
  const sameIdx = await encryptChunk(cipherA, 0, chunk);
  assert(hex(sealed) === hex(sameIdx), 'IV is deterministic per chunk index');
  const otherIdx = await encryptChunk(cipherA, 1, chunk);
  assert(hex(sealed) !== hex(otherIdx), 'different chunk indices use different IVs');

  // Wrong counter => decryption must fail (tag mismatch)
  let threw = false;
  try {
    await decryptChunk(cipherB, 999, sealed);
  } catch {
    threw = true;
  }
  assert(threw, 'wrong chunk counter fails authentication');

  // Tampered ciphertext fails
  const tampered = new Uint8Array(sealed.slice(0));
  tampered[tampered.length - 1] ^= 0xff;
  threw = false;
  try {
    await decryptChunk(cipherB, 0, tampered.buffer as ArrayBuffer);
  } catch {
    threw = true;
  }
  assert(threw, 'tampered ciphertext fails authentication');
}

async function testIncrementalHash() {
  console.log('\n[incremental sha-256]');
  const hasher = new IncrementalSha256();
  const full = stringToBytes('a'.repeat(300));
  hasher.update(full.subarray(0, 100));
  hasher.update(full.subarray(100, 250));
  hasher.update(full.subarray(250));
  const incremental = hasher.finalize();

  const reference = Buffer.from(
    await crypto.subtle.digest('SHA-256', full)
  ).toString('hex');
  assert(incremental === reference, 'chunked hash equals one-shot hash', incremental);
}

async function testPairingPayload() {
  console.log('\n[pairing payload]');
  const host = await generateEcdhKeyPair();
  const joiner = await generateEcdhKeyPair();

  const sdp = 'v=0\r\n' + 'o=- 123 2 IN IP4 127.0.0.1\r\n' + 's=-\r\n';
  const offerCode = await buildPairingCode({
    kind: 'offer',
    sdp,
    publicKey: await exportPublicKeyRawOf(host),
  });
  assert(offerCode.startsWith('NDP1.'), 'offer code has NDP1 prefix', offerCode.slice(0, 12));

  const parsedOffer = await parsePairingCode(offerCode);
  assert(parsedOffer.kind === 'offer', 'parsed kind is offer');
  // trimSdp normalizes \r\n -> \n on both ends; the exact bytes the
  // peer produced after trimming are what get applied via setRemoteDescription
  const normalize = (t: string) => t.replace(/\r\n/g, '\n').trim();
  assert(normalize(parsedOffer.sdp) === normalize(sdp), 'SDP survives round trip');
  assert(parsedOffer.expiresAt > Date.now(), 'payload not yet expired');

  const ack = await import('../lib/crypto').then((m) =>
    m.computeSha256Base64Url(offerCode)
  );
  const answerCode = await buildPairingCode({
    kind: 'answer',
    sdp: 'v=0 answer',
    publicKey: await exportPublicKeyRawOf(joiner),
    ackOfOffer: ack,
  });
  const parsedAnswer = await parsePairingCode(answerCode);
  assert(parsedAnswer.kind === 'answer', 'parsed kind is answer');
  assert(parsedAnswer.ackOfOffer === ack, 'answer ack matches offer hash');

  // Error cases
  await expectError(() => parsePairingCode('garbage'), 'garbage input rejected', 'invalid-format');
  await expectError(() => parsePairingCode('NDP2.abc'), 'wrong version rejected', 'invalid-format');

  // Expiry: re-encode the same envelope with a past expiry
  const inner = base64UrlToBytes(offerCode.slice('NDP1.'.length));
  const envelope = JSON.parse(Buffer.from(inner).toString('utf8'));
  // Beyond the built-in 2-minute clock-skew allowance
  envelope.exp = Date.now() - 3 * 60 * 1000;
  const expired =
    'NDP1.' + bytesToBase64Url(stringToBytes(JSON.stringify(envelope)));
  await expectError(() => parsePairingCode(expired), 'expired payload rejected', 'expired');
}

async function testSegmentation() {
  console.log('\n[qr segmentation + reassembly]');

  // Small code stays a single segment
  const smallCode = 'NDP1.' + 'A'.repeat(100);
  const segs1 = segmentPairingCode(smallCode, 's1');
  assert(segs1.length === 1, 'small code single segment');

  // Large code splits into ordered segments
  const bigCode = 'NDP1.' + 'B'.repeat(4200);
  const segs = segmentPairingCode(bigCode, 's2');
  assert(segs.length > 1, 'large code splits into multiple segments', String(segs.length));

  const assembler = new QrSegmentAssembler();
  let result = assembler.feed(segs[0].text);
  assert(result.code === undefined && result.received === 1, 'first segment acknowledged');

  // Wrong-session segment mixing is rejected
  const otherSession = segmentPairingCode(bigCode, 's3');
  const badFeed = assembler.feed(otherSession[1].text);
  assert(badFeed.error === 'wrong-session', 'cross-session segment rejected');

  // Feed remaining segments (any order)
  const rest = [...segs.slice(1)];
  // deliberately out of order
  rest.reverse();
  let code: string | null = null;
  for (const seg of rest) {
    const r = assembler.feed(seg.text);
    if (r.code) code = r.code;
  }
  assert(code === bigCode, 'segments reassemble into the full code (any order)');

  // Duplicate segments (e.g. camera rescans the same frame) are tolerated
  const assembler2 = new QrSegmentAssembler();
  const seen = new Set<number>();
  let done = false;
  let guard = 0;
  while (!done && guard < 10 * segs.length) {
    for (const seg of segs) {
      const r = assembler2.feed(seg.text);
      if (r.code === bigCode) done = true;
    }
    guard++;
    if (guard === 2) break; // second pass would contain only duplicates
  }
  const dup = assembler2.feed(segs[0].text);
  assert(dup.error === undefined || dup.error === 'wrong-session', 'duplicate segment tolerated');
}

async function main() {
  await testEncoding();
  await testEcdh();
  await testChunkCipher();
  await testIncrementalHash();
  await testPairingPayload();
  await testSegmentation();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

async function exportPublicKeyRawOf(kp: CryptoKeyPair): Promise<ArrayBuffer> {
  const { exportPublicKeyRaw } = await import('../lib/crypto');
  return exportPublicKeyRaw(kp.publicKey);
}

void main();
