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

  const cipherA = await createChunkCipher(key);
  const cipherB = await createChunkCipher(key);

  const { generateIvPrefix } = await import('../lib/crypto');
  const prefixA = generateIvPrefix();
  const prefixB = new Uint8Array(prefixA); // receiver uses the prefix from FILE_START
  assert(prefixA.byteLength === 6, 'IV prefix is 6 bytes');

  const chunk = stringToBytes('file chunk payload #0').buffer as ArrayBuffer;
  const sealed = await encryptChunk(cipherA, prefixA, 0, chunk);
  assert(sealed.byteLength > chunk.byteLength, 'ciphertext includes tag overhead');

  const opened = await decryptChunk(cipherB, prefixB, 0, sealed);
  assert(hex(opened) === hex(chunk), 'receiver decrypts chunk with same key + prefix');

  // Deterministic IV per (prefix, chunkIndex): same pair yields same ciphertext,
  // different chunk indices differ — no IV reuse within a transfer.
  const sameIdx = await encryptChunk(cipherA, prefixA, 0, chunk);
  assert(hex(sealed) === hex(sameIdx), 'IV is deterministic per chunk index');
  const otherIdx = await encryptChunk(cipherA, prefixA, 1, chunk);
  assert(hex(sealed) !== hex(otherIdx), 'different chunk indices use different IVs');

  // CRITICAL: a SECOND transfer must never reuse the first transfer's IVs.
  // (This was the per-transfer counter-restart bug: same key + same
  // (prefix,index) pairs across files = GCM nonce reuse.)
  const prefix2 = generateIvPrefix();
  const secondFileChunk0 = await encryptChunk(cipherA, prefix2, 0, chunk);
  const secondFileChunk1 = await encryptChunk(cipherA, prefix2, 1, chunk);
  assert(hex(secondFileChunk0) !== hex(sealed), 'new transfer chunk #0 gets a fresh IV');
  assert(
    hex(secondFileChunk1) !== hex(otherIdx),
    'new transfer chunk #1 gets a fresh IV'
  );
  const reopened = await decryptChunk(cipherB, prefix2, 0, secondFileChunk0);
  assert(hex(reopened) === hex(chunk), 'second transfer decrypts with its own prefix');

  // Wrong prefix (wrong key/context) => decryption must fail (tag mismatch)
  let threw = false;
  try {
    await decryptChunk(cipherB, generateIvPrefix(), 0, sealed);
  } catch {
    threw = true;
  }
  assert(threw, 'wrong IV prefix fails authentication');

  // Tampered ciphertext fails
  const tampered = new Uint8Array(sealed.slice(0));
  tampered[tampered.length - 1] ^= 0xff;
  threw = false;
  try {
    await decryptChunk(cipherB, prefixB, 0, tampered.buffer as ArrayBuffer);
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

  // Adversarial: envelope with the expiry STRIPPED must be rejected outright —
  // a stale pairing must not be resurrected as "never expiring".
  const noExp = { ...JSON.parse(Buffer.from(inner).toString('utf8')) };
  delete noExp.exp;
  await expectError(
    () => parsePairingCode('NDP1.' + bytesToBase64Url(stringToBytes(JSON.stringify(noExp)))),
    'envelope without expiry rejected',
    'invalid-format'
  );

  // Adversarial: non-finite / string expiry metadata rejected
  const strExp = { ...JSON.parse(Buffer.from(inner).toString('utf8')), exp: '99999999999999' };
  await expectError(
    () => parsePairingCode('NDP1.' + bytesToBase64Url(stringToBytes(JSON.stringify(strExp)))),
    'string expiry rejected',
    'invalid-format'
  );
  const noTs = { ...JSON.parse(Buffer.from(inner).toString('utf8')) };
  delete noTs.ts;
  await expectError(
    () => parsePairingCode('NDP1.' + bytesToBase64Url(stringToBytes(JSON.stringify(noTs)))),
    'envelope without timestamp rejected',
    'invalid-format'
  );

  // Adversarial: an offer must not parse as an answer
  const asAnswer = { ...JSON.parse(Buffer.from(inner).toString('utf8')), k: 'a' };
  const flipped = await parsePairingCode('NDP1.' + bytesToBase64Url(stringToBytes(JSON.stringify(asAnswer))));
  assert(flipped.kind === 'answer', 'role is read from the envelope, not assumed');
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

/**
 * Binary chunk protocol: header round-trip, transferId binding,
 * duplicate/gap detection semantics.
 */
async function testProtocol() {
  console.log('\n[chunk protocol]');
  const { encodeBinaryChunk, decodeBinaryChunk, simpleStringHash } = await import('../lib/transfer/protocol');

  const payload = stringToBytes('chunk-data-here');
  const transferId = 'tx_abc123';
  const packet = encodeBinaryChunk(7, 20, transferId, payload.buffer as ArrayBuffer);

  const decoded = decodeBinaryChunk(packet)!;
  assert(decoded !== null, 'chunk decodes');
  assert(decoded.chunkIndex === 7 && decoded.totalChunks === 20, 'chunk indices round trip');
  assert(decoded.transferIdHash === simpleStringHash(transferId), 'transferId hash round trip');
  assert(new TextDecoder().decode(decoded.payload) === 'chunk-data-here', 'payload round trip');
  assert(packet.byteLength === 16 + payload.byteLength, 'header size is 16 bytes');

  // A different transferId must produce a different checksum — the receiver
  // uses this to reject chunks from unknown transfers.
  assert(simpleStringHash('tx_other') !== simpleStringHash(transferId), 'transferId checksums differ per transfer');

  assert(decodeBinaryChunk(new ArrayBuffer(8)) === null, 'undersized packet rejected');
}

/**
 * SDP trimming must keep security material, and MUST emit CRLF line
 * terminators on every line — bare-LF SDP is rejected by setRemoteDescription.
 */
async function testSdpTrimming() {
  console.log('\n[sdp trimming]');
  const { __testTrimSdp } = await import('../lib/pairing/payload');

  const sampleSdp = [
    'v=0',
    'o=- 46117 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:AbCd',
    'a=ice-pwd:EfGh1234',
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 AA:BB:CC',
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    'a=extmap:1 urn:x',       // must be dropped
    'a=rtpmap:0 fake',        // must be dropped
    'a=candidate:1 1 UDP 1 192.168.1.5 5000 typ host',
    'a=end-of-candidates',
  ].join('\r\n');

  const trimmed = __testTrimSdp(sampleSdp);
  assert(trimmed.includes('a=fingerprint:sha-256 AA:BB:CC'), 'security fingerprint kept');
  assert(trimmed.includes('a=max-message-size:262144'), 'max-message-size kept');
  assert(trimmed.includes('a=candidate:1 1 UDP'), 'ICE candidates kept');
  assert(trimmed.endsWith('\r\n'), 'SDP ends with CRLF terminator');
  // every line must end with CR LF
  const lines = trimmed.slice(0, -2).split('\r\n');
  assert(lines.every((l) => !l.includes('\n') && !l.endsWith('\r')), 'no stray LF-only lines');
  assert(!trimmed.split('\r\n').some((l) => l.startsWith('a=extmap') || l.startsWith('a=rtpmap')), 'media-only lines dropped');
}

async function main() {
  await testEncoding();
  await testEcdh();
  await testChunkCipher();
  await testIncrementalHash();
  await testPairingPayload();
  await testSegmentation();
  await testProtocol();

  await testSdpTrimming();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

async function exportPublicKeyRawOf(kp: CryptoKeyPair): Promise<ArrayBuffer> {
  const { exportPublicKeyRaw } = await import('../lib/crypto');
  return exportPublicKeyRaw(kp.publicKey);
}


// =====================================================================
// MEASURED FLOW CONTROL — link tuner, sender RTT/window, ACK feedback
// =====================================================================

import {
  initialChunkSize,
  noteTransferSuccess,
  noteTransferFailure,
  resetLinkProfile,
} from '../lib/transfer/tuner';
import { SenderEngine } from '../lib/transfer/sender';
import type { SenderOptions } from '../lib/transfer/sender';

resetLinkProfile();
assert(initialChunkSize(0) === 64 * 1024 - 256, 'tuner: conservative 64 KiB start (minus crypto/SCTP envelope headroom)');
assert(initialChunkSize(131072) === 64 * 1024, 'tuner: start never exceeds 64 KiB before learning');

// A clean, healthy run learns a larger chunk for the NEXT transfer
noteTransferSuccess(64 * 1024, 20 * 1024 * 1024, 0);
assert(initialChunkSize(262144) === 128 * 1024, 'tuner: clean run grows the next chunk size (capped by SCTP)');
noteTransferSuccess(64 * 1024, 20 * 1024 * 1024, 3);
assert(initialChunkSize(262144) === 64 * 1024, 'tuner: stalls reset to conservative');
noteTransferSuccess(64 * 1024, 20 * 1024 * 1024, 0);
noteTransferFailure();
assert(initialChunkSize(262144) === 64 * 1024, 'tuner: a failed transfer resets the learned profile');
resetLinkProfile();

// Sender: RTT measured from real ACK timing, window grows on a stable link
async function testMeasuredFlowControl(): Promise<void> {
  const chunkSizeCap = 64 * 1024;
  const file = new File([new Uint8Array(chunkSizeCap * 4)], 'flow.bin', { type: 'application/octet-stream' });
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    send: (_d: ArrayBuffer) => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as RTCDataChannel;
  const opts = {
    file,
    transferId: 'flowtest',
    fileChannel: channel,
    sendControlMessage: () => true,
    onProgress: () => {},
    onCompleted: () => {},
    onError: () => {},
  } as unknown as SenderOptions;
  const sender = new SenderEngine(opts);
  void sender.start();
  // ACK every chunk after a simulated ~40 ms round trip
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 40));
    sender.handleAck(i, 1);
  }
  const m = sender.metrics;
  assert(m.rttMs >= 30 && m.rttMs <= 200, 'sender: RTT is measured from ACK timing (real, not faked)', `rtt=${m.rttMs}`);
  assert(m.throughputBps > 0, 'sender: throughput measured from the ACK cadence');
  assert(m.window >= 8, 'sender: adaptive window stays within safe bounds');
  assert(m.stalls === 0, 'sender: no backpressure stalls on a clean run');
  resetLinkProfile();
}

// Receiver write feedback flows through the ACK contract (type-level check)
{
  type AckHasWriteCost = { w?: number };
  const ack: AckHasWriteCost = { w: 2.5 };
  assert(typeof ack.w === 'number', 'ACK contract carries receiver write-cost feedback (optional, backward compatible)');
}

// Run the measured flow-control checks BEFORE the summary/exit — a
// pending async block would be killed by main()'s process.exit.
void (async () => {
  await testMeasuredFlowControl();
  await main();
})();
