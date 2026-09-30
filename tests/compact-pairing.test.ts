/**
 * NexDrop compact binary pairing format (NDP2) tests.
 * Run with: npx tsx tests/compact-pairing.test.ts
 *
 * Covers: pack/parse round-trip, single-QR size budget, canonical SDP
 * reconstruction fidelity, tamper/truncation rejection, expiry, and the
 * fallback-to-v1 path for payloads the binary format cannot represent.
 */

import {
  buildPairingCode,
  parsePairingCode,
  __testTrimSdp,
} from '../lib/pairing/payload';
import {
  buildCompactCode,
  COMPACT_PREFIX,
  parseCompactCode,
  extractSdpEssentials,
} from '../lib/pairing/compact';
import { bytesToBase64Url, generateEcdhKeyPair, stringToBytes } from '../lib/crypto';

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string, extra?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
}

async function expectError(fn: () => unknown, label: string, expected: string) {
  try {
    await fn();
    assert(false, label, 'did not throw');
  } catch (err: any) {
    assert(err?.message === expected, label, `got "${err?.message}"`);
  }
}

/** Representative Chromium data-channel offer SDP (post-trim shape). */
const REAL_OFFER_SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=ice-ufrag:8xCp',
  'a=ice-pwd:asd883pi84jHabc123asdfQ',
  'a=setup:actpass',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=fingerprint:sha-256 AB:CD:EF:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D',
  'a=candidate:1 1 UDP 2122252543 192.168.1.42 54321 typ host',
  'a=candidate:2 1 UDP 2122252543 fd42::a1b2:c3d4 54322 typ host',
  'a=candidate:3 1 UDP 1686052607 203.0.113.7 54323 typ srflx raddr 10.0.0.1 rport 54324',
  'a=end-of-candidates',
].join('\r\n') + '\r\n';

const REAL_ANSWER_SDP = REAL_OFFER_SDP
  .replace('a=setup:actpass', 'a=setup:active')
  .replace('a=ice-ufrag:8xCp', 'a=ice-ufrag:Jz4W')
  .replace('a=ice-pwd:asd883pi84jHabc123asdfQ', 'a=ice-pwd:PqR4tU9wXyZ2aB3cD4eF5g');

async function main() {
  console.log('\n[compact pairing — pack/parse round-trip]');

  // Real ECDH keypair — its exported public key travels in the code and the
  // parsed copy must still perform a genuine key agreement afterwards.
  const kp = await generateEcdhKeyPair();
  const pkRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  assert(pkRaw.byteLength === 65 && pkRaw[0] === 0x04, 'exported public key is a 65-byte uncompressed point');

  const offerCode = buildCompactCode({
    kind: 'offer',
    sdp: REAL_OFFER_SDP,
    publicKey: pkRaw,
    device: 'NexDrop · Android',
  });
  assert(!!offerCode, 'offer packs into compact form');
  console.log(`    offer code length: ${offerCode?.length} chars`);
  assert(!!offerCode && offerCode.startsWith(COMPACT_PREFIX), 'code carries the NDP2 prefix');
  assert(!!offerCode && offerCode.length <= 580, 'OFFER FITS ONE QR (<= 580 chars)', String(offerCode?.length));

  const parsed = parseCompactCode(offerCode!);
  assert(parsed.kind === 'offer', 'kind round-trips');
  assert(parsed.device === 'NexDrop · Android', 'device label round-trips');
  assert(parsed.expiresAt > Date.now(), 'expiry is in the future');
  assert(
    parsed.sdp.includes('a=ice-ufrag:8xCp') &&
      parsed.sdp.includes('a=ice-pwd:asd883pi84jHabc123asdfQ'),
    'ice credentials survive reconstruction'
  );
  assert(
    parsed.sdp.includes('a=fingerprint:sha-256 AB:CD:EF:01'),
    'DTLS fingerprint survives reconstruction'
  );
  assert(parsed.sdp.includes('a=setup:actpass'), 'setup role survives reconstruction');
  assert(
    parsed.sdp.includes('192.168.1.42 54321 typ host') &&
      parsed.sdp.includes('typ srflx raddr 10.0.0.1 rport 54324'),
    'candidates survive reconstruction'
  );
  assert(
    parsed.sdp.includes('m=application 9 UDP/DTLS/SCTP webrtc-datachannel'),
    'datachannel m-line reconstructed'
  );
  assert(parsed.sdp.endsWith('\r\n'), 'canonical SDP ends with CRLF');
  assert(parsed.sdp.split('\r\n').slice(0, -1).every((l) => l.length > 0), 'no empty SDP lines');

  // ECDH key: the parsed public key must be usable for a real key agreement
  const subtle = crypto.subtle;
  const importedPk = await subtle.importKey(
    'raw',
    parsed.peerPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
  const shared = await subtle.deriveBits(
    { name: 'ECDH', public: importedPk },
    kp.privateKey,
    256
  );
  assert(shared.byteLength === 32, 'parsed public key performs real ECDH');

  console.log('\n[compact pairing — answer with ack]');

  const ackB64 = bytesToBase64Url(new Uint8Array(32).fill(0xab));
  const answerCode = buildCompactCode({
    kind: 'answer',
    sdp: REAL_ANSWER_SDP,
    publicKey: pkRaw,
    ackOfOffer: ackB64,
  });
  assert(!!answerCode, 'answer packs into compact form');
  console.log(`    answer code length: ${answerCode?.length} chars`);
  assert(!!answerCode && answerCode.length <= 580, 'ANSWER FITS ONE QR (<= 580 chars)', String(answerCode?.length));
  const parsedAnswer = parseCompactCode(answerCode!);
  assert(parsedAnswer.kind === 'answer', 'answer kind round-trips');
  assert(parsedAnswer.ackOfOffer === ackB64.slice(0, 20), 'offer ack round-trips as its 120-bit prefix');
  assert(!!parsedAnswer.ackOfOffer && ackB64.startsWith(parsedAnswer.ackOfOffer), 'host accepts prefix ack via startsWith');
  assert(answerCode!.length < 330, 'slim answer stays well under the single-QR budget', String(answerCode!.length));
  assert(parsedAnswer.sdp.includes('a=setup:active'), 'answer setup role round-trips');

  console.log('\n[compact pairing — integration with buildPairingCode]');

  const fullOfferCode = await buildPairingCode({
    kind: 'offer',
    sdp: REAL_OFFER_SDP,
    publicKey: pkRaw.buffer.slice(0, 65) as ArrayBuffer,
    device: 'NexDrop · Android',
  });
  assert(fullOfferCode.startsWith(COMPACT_PREFIX), 'buildPairingCode prefers the compact format');
  const fullParsed = await parsePairingCode(fullOfferCode);
  assert(fullParsed.kind === 'offer', 'full pipeline parses offer');
  assert(fullParsed.device === 'NexDrop · Android', 'device label via full pipeline');

  console.log('\n[compact pairing — adversarial]');

  await expectError(() => parseCompactCode('NDP2.' + '!!!not-base64!!!'), 'garbage base64 rejected', 'invalid-format');
  await expectError(() => parseCompactCode('NDP2.' + bytesToBase64Url(new Uint8Array(10))), 'truncated payload rejected', 'invalid-format');

  // Single flipped byte in the header (kind byte)
  {
    const b64 = offerCode!.slice(COMPACT_PREFIX.length);
    const bytes = new Uint8Array(65 + 10);
    bytes[0] = 2; bytes[1] = 9; // invalid kind
    const junk = 'NDP2.' + bytesToBase64Url(bytes);
    await expectError(() => parseCompactCode(junk), 'invalid kind byte rejected', 'invalid-format');
  }

  // Trailing junk after a valid payload
  {
    
    const codeBytes = atobUrl(offerCode!.slice(COMPACT_PREFIX.length));
    const withJunk = new Uint8Array(codeBytes.length + 1);
    withJunk.set(codeBytes);
    withJunk[codeBytes.length] = 0xff;
    await expectError(
      () => parseCompactCode('NDP2.' + bytesToBase64Url(withJunk)),
      'trailing bytes rejected',
      'invalid-format'
    );
  }

  // Expiry tampering: rebuild with a past expiry is not possible via API, so
  // craft a payload whose exp < ts and an expired one by shifting bytes.
  {
    const codeBytes = atobUrl(offerCode!.slice(COMPACT_PREFIX.length));
    // exp is bytes 6..10 (u32 LE) — set far past
    codeBytes[6] = 0; codeBytes[7] = 0; codeBytes[8] = 0x40; codeBytes[9] = 0; // ~2^22s ≈ 1970+49 days
    await expectError(
      () => parseCompactCode('NDP2.' + bytesToBase64Url(codeBytes)),
      'expired compact payload rejected',
      'expired'
    );
  }

  // IPv6 + non-printable IP rejection
  {
    const ess = extractSdpEssentials(REAL_OFFER_SDP.replace('192.168.1.42', 'fd42::a1b2:c3d4'));
    assert(!!ess && ess.candidates.length === 3, 'IPv6 candidates pack fine');
  }

  // TCP candidate forces fallback to v1
  {
    const tcpSdp = REAL_OFFER_SDP.replace(
      'a=candidate:1 1 UDP 2122252543 192.168.1.42 54321 typ host',
      'a=candidate:4 1 TCP 1518280447 192.168.1.42 9 typ host tcptype active'
    );
    assert(buildCompactCode({ kind: 'offer', sdp: tcpSdp, publicKey: pkRaw }) === null, 'TCP candidate blocks compact (falls back to v1)');
    assert(extractSdpEssentials(tcpSdp) === null, 'extractor refuses TCP candidates');
    const v1Code = await buildPairingCode({ kind: 'offer', sdp: tcpSdp, publicKey: pkRaw.buffer.slice(0, 65) as ArrayBuffer });
    assert(!v1Code.startsWith(COMPACT_PREFIX), 'fallback code is v1 JSON format');
    const v1Parsed = await parsePairingCode(v1Code);
    assert(v1Parsed.sdp.includes('tcptype active'), 'v1 fallback preserves TCP candidate');
  }

  // Fingerprint sanity: bad hex blocks compact
  {
    const badSdp = REAL_OFFER_SDP.replace('AB:CD:EF', 'ZZ:CD:EF');
    assert(extractSdpEssentials(badSdp) === null, 'non-hex fingerprint refused');
  }

  // Public key must be a valid uncompressed point header
  {
    const badPk = new Uint8Array(65); badPk[0] = 0x02;
    assert(buildCompactCode({ kind: 'offer', sdp: REAL_OFFER_SDP, publicKey: badPk }) === null, 'non-04 pubkey blocks compact');
  }

  console.log(`\n[compact pairing] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

/** base64url → bytes for tests */
function atobUrl(b64: string): Uint8Array {
  const b = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
