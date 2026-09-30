/**
 * QR pairing regression tests (run with `npx tsx tests/core.test.ts`).
 *
 * Root-cause regression for the real-device bug where the camera saw the
 * pairing QR but the app rejected it with "That is not a NexDrop pairing QR
 * code.": the QR was rendered INVERTED (near-white modules on near-black)
 * while the live camera scanner decoded with jsQR `dontInvert`, which cannot
 * read an inverted QR at all. These tests lock in:
 *
 *   1. canonical QR polarity/quiet-zone/EC options (shared everywhere),
 *   2. jsQR round-trip of what we render — using the scanner's decode path,
 *   3. QR density bounds (module count) so camera reliability is enforced,
 *   4. per-fragment checksums, duplicates, reordering, wrong sessions,
 *      legacy v1 fragments, and multi-QR reassembly into a parseable code.
 */

import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  buildPairingCode,
  parsePairingCode,
  segmentPairingCode,
  QrSegmentAssembler,
} from '@/lib/pairing/payload';
import {
  QR_RENDER_OPTIONS,
  QR_DARK,
  QR_LIGHT,
  QR_MARGIN_MODULES,
  qrModuleSizeFor,
} from '@/lib/pairing/qrOptions';
import { generateEcdhKeyPair } from '@/lib/crypto';

let passed = 0;
let failed = 0;
function check(ok: boolean, label: string, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  }
}

/** Render a payload exactly like the app does (canonical options) and decode
 *  it exactly like the production camera path does (jsQR). */
function decodeLikeCamera(text: string, attempt: 'dontInvert' | 'attemptBoth') {
  const qr = QRCode.create(text, {
    errorCorrectionLevel: QR_RENDER_OPTIONS.errorCorrectionLevel as QRCode.QRCodeErrorCorrectionLevel,
  });
  const size = qr.modules.size;
  const dim = size + QR_MARGIN_MODULES * 2;
  const px = new Uint8ClampedArray(dim * dim * 4);
  const hexToRgb = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const darkRgb = hexToRgb(QR_DARK);
  const lightRgb = hexToRgb(QR_LIGHT);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const inQr = x >= QR_MARGIN_MODULES && y >= QR_MARGIN_MODULES &&
        x < QR_MARGIN_MODULES + size && y < QR_MARGIN_MODULES + size;
      const isDark = inQr && qr.modules.get(x - QR_MARGIN_MODULES, y - QR_MARGIN_MODULES);
      const [r, g, b] = isDark ? darkRgb : lightRgb;
      const i = (y * dim + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  const res = jsQR(px, dim, dim, { inversionAttempts: attempt });
  return { modules: size, text: res ? res.data : null };
}

/** A representative trimmed DataChannel SDP (loopback-style, realistic size). */
const SAMPLE_SDP = [
  'v=0',
  'o=- 4611736073754141325 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=ice-ufrag:9UXB',
  'a=ice-pwd:SomeIcePasswordValueThatIsLongEnoughToBeRealistic',
  'a=fingerprint:sha-256 12:34:56:78:9A:BC:DE:F0:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:01:23:45:67:89:AB:CD:EF',
  'a=setup:actpass',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:1 1 UDP 2122260223 192.168.1.42 54321 typ host',
  'a=candidate:2 1 UDP 2122187007 84a1c2de-1234-5678-9abc-def012345678.local 54322 typ host',
  'a=end-of-candidates',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
].join('\r\n') + '\r\n';

async function main() {
  console.log('[qr-pairing tests] canonical QR options');
  {
    const lum = (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    check(lum(QR_DARK) < lum(QR_LIGHT), 'QR modules are dark-on-light (standard polarity)',
      `dark=${QR_DARK} light=${QR_LIGHT}`);
    check(QR_MARGIN_MODULES >= 4, 'quiet zone >= 4 modules (spec minimum)');
    check(QR_RENDER_OPTIONS.errorCorrectionLevel === 'M', 'error correction level M (balanced)');
    check(QR_DARK === '#070A0D' && QR_LIGHT === '#FFFFFF', 'high contrast near-black on white');
  }

  console.log('[qr-pairing tests] camera decode round-trip (jsQR, production path)');
  const keyPair = await generateEcdhKeyPair();
  const offerCode = await buildPairingCode({
    kind: 'offer',
    sdp: SAMPLE_SDP,
    publicKey: await crypto.subtle.exportKey('raw', keyPair.publicKey),
  });
  {
    const r = decodeLikeCamera(offerCode, 'dontInvert');
    check(r.text === offerCode, 'rendered single QR decodes EXACTLY with dontInvert (the old failure)',
      `decoded=${r.text ? 'len ' + r.text.length : 'nothing'}`);
    const rBoth = decodeLikeCamera(offerCode, 'attemptBoth');
    check(rBoth.text === offerCode, 'rendered single QR decodes with attemptBoth (scanner setting)');
    const inverted = decodeLikeCamera(offerCode, 'attemptBoth'); // sanity: same settings as production tick
    check(!!inverted.text, 'production tick settings decode the production QR');
  }

  console.log('[qr-pairing tests] QR density budget');
  {
    // Worst-case payload lengths we ever render
    const single = qrModuleSizeFor(580);
    const seg = qrModuleSizeFor(25 + 550); // NDQS2 header + max data
    check(single <= 77, `single-QR max size stays <= 77 modules (got ${single})`);
    check(seg <= 81, `segment max size stays small enough for cameras (got ${seg})`);
  }

  console.log('[qr-pairing tests] multi-QR segmentation + reassembly');
  const bigSdp = SAMPLE_SDP.replace(
    'a=end-of-candidates',
    Array.from({ length: 8 }, (_, i) =>
      `a=candidate:${i + 3} 1 UDP 212226022${i} 192.168.1.${50 + i} 5400${i} typ host`
    ).join('\r\n')
  );
  const ack = 'c3dIYWJ'; // base64url stub — ack only binds answers
  const answerCode = await buildPairingCode({
    kind: 'answer',
    sdp: bigSdp,
    publicKey: await crypto.subtle.exportKey('raw', keyPair.publicKey),
    ackOfOffer: ack,
  });
  const sessionId = 'A1B2C3D4';
  {
    check(answerCode.length > 580, 'large realistic answer code exceeds the single-QR budget');
    const segs = segmentPairingCode(answerCode, sessionId);
    check(segs.length > 1, `large code is split into multiple QRs (${segs.length})`);
    check(segs.every((s) => s.text.startsWith('NDQS2.')), 'segments use the checksummed NDQS2 format');
    check(segs.every((s, i) => s.index === i + 1 && s.total === segs.length), 'segments are numbered i/total');

    // Every segment must be camera-decodable with production settings
    let allDecode = true;
    for (const s of segs) {
      const r = decodeLikeCamera(s.text, 'attemptBoth');
      if (r.text !== s.text) allDecode = false;
    }
    check(allDecode, 'every multi-QR segment decodes exactly like the production scanner');

    // Out-of-order + duplicate feed still reassembles
    const asm = new QrSegmentAssembler();
    const last = segs[segs.length - 1];
    let out = asm.feed(last.text);
    check(out.received === 1 && !out.error, 'out-of-order fragment accepted');
    out = asm.feed(last.text); // duplicate
    check(out.received === 1 && !out.error, 'duplicate fragment ignored (no error, no double count)');
    // Feed the remaining fragments in reverse order (never the one we already
    // have) until the assembly completes.
    let reassembled: string | null = null;
    for (const s of segs.slice(0, -1).reverse()) {
      const r = asm.feed(s.text);
      if (r.code) reassembled = r.code;
    }
    check(reassembled === answerCode, 'complete reassembly reproduces the exact pairing code');

    // The reassembled code must parse to the same SDP
    const parsed = await parsePairingCode(reassembled!);
    check(parsed.kind === 'answer' && parsed.sdp === bigSdp, 'reassembled code parses to the original SDP');
    check(parsed.ackOfOffer === ack, 'answer ack binding survives segmentation');
  }

  console.log('[qr-pairing tests] fragment corruption + wrong-session rejection');
  {
    const segs = segmentPairingCode(answerCode, sessionId);
    const asm = new QrSegmentAssembler();
    asm.feed(segs[0].text);
    // Corrupt one character of fragment 2's data
    const line = segs[1].text;
    const parts = line.slice('NDQS2.'.length).split('.');
    const data = parts.slice(4).join('.');
    const corrupted = 'NDQS2.' + parts[0] + '.' + parts[1] + '.' + parts[2] + '.' + parts[3] + '.' +
      (data.startsWith('A') ? 'B' : 'A') + data.slice(1);
    const r = asm.feed(corrupted);
    check(r.error === 'corrupt-segment', 'misread fragment is rejected instantly via checksum', JSON.stringify(r));
    check(r.received === 1, 'collected fragments are kept after a misread (no silent reset)');
    // Correct fragment still completes afterwards
    const done = asm.feed(segs[1].text);
    check(!done.error && done.received === 2, 'clean re-scan of the fragment continues the assembly');

    // Wrong-session fragment
    const otherSession = segmentPairingCode(answerCode, 'DEADBEEF');
    const asm2 = new QrSegmentAssembler();
    asm2.feed(segs[0].text);
    const r2 = asm2.feed(otherSession[1].text);
    check(r2.error === 'wrong-session', 'fragment from a different pairing session is rejected');
  }

  console.log('[qr-pairing tests] legacy v1 fragments still accepted');
  {
    const segs = segmentPairingCode(answerCode, sessionId);
    // Build a v1 (pre-checksum) fragment from segment 1's data
    const parts = segs[0].text.slice('NDQS2.'.length).split('.');
    const v1 = 'NDQS.' + parts[0] + '.' + parts[1] + '.' + parts[2] + '.' + parts.slice(4).join('.');
    const asm = new QrSegmentAssembler();
    const r = asm.feed(v1);
    check(!r.error && r.received === 1, 'legacy NDQS. fragment parsed without checksum');
  }

  console.log('[qr-pairing tests] invalid QR rejection');
  {
    const asm = new QrSegmentAssembler();
    check(asm.feed('https://example.com').error === 'invalid-format', 'random URL rejected as invalid-format');
    check(asm.feed('NDQS2.abc.x.y.z').error === 'invalid-format', 'malformed segment metadata rejected');
    check(asm.feed('NDP2.somethingnew').code === 'NDP2.somethingnew', 'complete NDP2 compact code accepted directly by the scanner');
    check(asm.feed('NDP3.somethingnew').error === 'invalid-format', 'unknown envelope version rejected');
  }

  console.log(`[qr-pairing tests] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
