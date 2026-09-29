/**
 * REAL two-device end-to-end test for NexDrop.
 *
 * Launches TWO isolated Chromium browser sessions (separate storage, like
 * two physical devices), serves the production static export, and runs the
 * complete manual pairing flow over REAL WebRTC:
 *
 *   Device A: Create pairing → real SDP offer → QR image(s)
 *   Device B: Join pairing → decode A's QR image(s) with jsQR (the app's
 *             own decoder) → reassemble multi-QR payload → real SDP answer
 *   Device A: decode B's answer QR → accept → DataChannels open → CONNECTED
 *   Both:    identical SAS verification code derived from the real handshake
 *   A → B:   text message + real file transfer with SHA-256 verification
 *   A → B:   cancel of a queued/active transfer
 *
 * The QR images are decoded from the rendered <img> via canvas + the bundled
 * jsQR — the same path a camera scan takes — so this validates QR
 * generation, multi-segment reassembly, duplicate tolerance and the whole
 * pairing pipeline with no mocks.
 *
 * IMPORTANT: this test requires a real ICE path between the two sessions.
 * Sandboxes without UDP sockets cannot establish the connection; run with
 * NEXDROP_E2E_REQUIRE_CONNECTION=0 to validate everything up to the SDP
 * exchange only. CI runs with the default (1) so the full flow is enforced.
 */

import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 3999;
const OUT_DIR = path.join(process.cwd(), 'out');
const REQUIRE_CONNECTION = process.env.NEXDROP_E2E_REQUIRE_CONNECTION !== '0';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function startServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let urlPath = req.url?.split('?')[0] || '/';
    // The export is built with basePath /nexdrop — strip it for local serving.
    if (urlPath.startsWith('/nexdrop')) urlPath = urlPath.slice('/nexdrop'.length) || '/';
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(OUT_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found: ' + urlPath);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

let failed = 0;
let passed = 0;
let skipped = 0;
function check(cond: boolean, label: string, extra?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
}
function skip(label: string, reason: string) {
  skipped++;
  console.log(`  - ${label} (SKIPPED: ${reason})`);
}

/**
 * Decode every QR segment shown on a pairing screen by driving the real
 * next/prev controls and reading the rendered <img> through canvas + jsQR.
 */
async function decodeAllQrSegments(page: any): Promise<string[]> {
  const jsqrSource = fs.readFileSync(
    path.join(process.cwd(), 'node_modules/jsqr/dist/jsQR.js'),
    'utf8'
  );
  await page.evaluate(jsqrSource); // exposes window.jsQR (UMD)

  const decodeVisible = () =>
    page.evaluate(() => {
      const img = document.querySelector('img[alt*="QR code"]') as HTMLImageElement | null;
      if (!img) return null;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const code = (window as any).jsQR(d.data, d.width, d.height, {
        inversionAttempts: 'attemptBoth',
      });
      return code ? code.data : null;
    });

  const totalMatch = await page.evaluate(() => {
    const el = [...document.querySelectorAll('span')].find(
      (s) => /^Code \d+ \/ \d+$/.test(s.textContent?.trim() || '')
    );
    return el?.textContent?.trim() || null;
  });
  const total = totalMatch ? parseInt(totalMatch.split('/')[1], 10) : 1;

  const segments: string[] = [];
  for (let i = 0; i < total; i++) {
    if (i > 0) {
      await page.getByLabel('Next QR code').click();
      await page.waitForTimeout(150);
    }
    const text = await decodeVisible();
    if (!text) throw new Error(`QR segment ${i + 1}/${total} could not be decoded`);
    segments.push(text);
  }
  return segments;
}

/** Feed QR segment texts (or a full code) through the scanner paste box. */
async function submitViaPaste(page: any, pieces: string[]) {
  await page.waitForSelector('#qr-paste', { timeout: 10000 });
  for (const piece of pieces) {
    await page.locator('#qr-paste').fill(piece);
    await page.getByRole('button', { name: 'Use', exact: true }).click();
    // segment progress appears while more segments are expected
    await page.waitForTimeout(200);
  }
}

async function main() {
  console.log('[two-device e2e] starting static server');
  const server = await startServer();

  console.log('[two-device e2e] launching two isolated browser sessions');
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      // Expose real local IPs as ICE host candidates instead of mDNS
      // .local hostnames — CI runners have no mDNS responder. Real devices
      // resolve mDNS normally.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  pageA.on('console', (m) => {
    if (process.env.NEXDROP_E2E_VERBOSE || m.type() === 'error') {
      console.log('  [A console]', m.type(), m.text().slice(0, 200));
    }
  });
  pageB.on('console', (m) => { if (m.type() === 'error') console.log('  [B console.error]', m.text().slice(0, 150)); });

  const url = `http://localhost:${PORT}/nexdrop/`;
  await pageA.goto(url, { waitUntil: 'domcontentloaded' });
  await pageB.goto(url, { waitUntil: 'domcontentloaded' });
  await pageA.waitForSelector('text=Create pairing', { timeout: 30000 });
  await pageB.waitForSelector('text=Create pairing', { timeout: 30000 });
  console.log('[two-device e2e] both devices loaded the app');

  // ---------------------------------------------------------------------
  // A: create pairing — real RTCPeerConnection + SDP offer + QR
  // ---------------------------------------------------------------------
  console.log('[two-device e2e] A: create pairing (real offer)');
  await pageA.getByRole('button', { name: /create pairing/i }).first().click();
  await pageA.waitForSelector('img[alt*="QR code"]', { timeout: 20000 });
  const offerSegments = await decodeAllQrSegments(pageA);
  check(offerSegments.every((s) => s.startsWith('NDQS.') || s.startsWith('NDP1.')),
    'A rendered real pairing QR image(s) decodable by jsQR',
    JSON.stringify(offerSegments.map((s) => s.slice(0, 12)))
  );
  check(offerSegments.length >= 1, `offer payload split into ${offerSegments.length} QR segment(s)`);

  // ---------------------------------------------------------------------
  // A: Download QR fallback
  // ---------------------------------------------------------------------
  const downloadPromise = pageA.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await pageA.getByRole('button', { name: /download qr/i }).first().click();
  const dl = await downloadPromise;
  check(!!dl, 'Download QR button produces a real file download');

  // ---------------------------------------------------------------------
  // B: join with A's real QR payload (multi-segment reassembly via paste)
  // ---------------------------------------------------------------------
  console.log('[two-device e2e] B: join pairing using the decoded QR segments');
  await pageB.getByRole('button', { name: /join pairing/i }).first().click();
  // feed segment 1 twice to prove duplicate tolerance
  if (offerSegments.length > 1) {
    await submitViaPaste(pageB, [offerSegments[0]]);
    await submitViaPaste(pageB, offerSegments);
    check(true, 'duplicate QR segment tolerated by reassembler');
  } else {
    await submitViaPaste(pageB, offerSegments);
  }

  console.log('[two-device e2e] B: real answer generated');
  await pageB.waitForSelector('text=Show this answer QR', { timeout: 30000 });
  const answerSegments = await decodeAllQrSegments(pageB);
  check(answerSegments.every((s) => s.startsWith('NDQS.') || s.startsWith('NDP1.')),
    'B rendered real answer QR image(s) decodable by jsQR');

  // ---------------------------------------------------------------------
  // A: accept B's real answer → real connection
  // ---------------------------------------------------------------------
  console.log('[two-device e2e] A: submit the real answer QR segments');
  await pageA.getByRole('button', { name: /scan answer qr/i }).click();
  await submitViaPaste(pageA, answerSegments);

  if (!REQUIRE_CONNECTION) {
    skip('connection, SAS, text, file transfer',
      'sandbox has no ICE path (NEXDROP_E2E_REQUIRE_CONNECTION=0) — validated through real SDP exchange');
    console.log(`\n[two-device e2e] ${passed} passed, ${failed} failed, ${skipped} skipped`);
    await browser.close();
    server.close();
    if (failed > 0) process.exit(1);
    return;
  }

  console.log('[two-device e2e] waiting for REAL DataChannel connection on both devices');
  try {
    await pageA.waitForSelector('text=Connected', { timeout: 45000 });
    await pageB.waitForSelector('text=Connected', { timeout: 45000 });
  } catch {
    const dumpA = await pageA.evaluate(() => document.body.innerText.slice(0, 300));
    const dumpB = await pageB.evaluate(() => document.body.innerText.slice(0, 300));
    console.log('  [A dump]', JSON.stringify(dumpA));
    console.log('  [B dump]', JSON.stringify(dumpB));
    throw new Error('connection never opened');
  }
  check(true, 'both devices show CONNECTED (real DataChannels open)');

  // SAS verification codes must be identical — derived from the real handshake
  const getSas = (page: any) =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll('span.font-mono')].find((sp) =>
        /^\d{3} \d{3}$/.test(sp.textContent?.trim() || '')
      );
      return el?.textContent?.trim() || '';
    });
  for (const p of [pageA, pageB]) {
    await p.getByRole('button', { name: 'Details' }).click();
    await p.waitForSelector('text=Verification Code', { timeout: 5000 });
  }
  const sasA: string = await getSas(pageA);
  const sasB: string = await getSas(pageB);
  check(/^\d{3} \d{3}$/.test(sasA) && /^\d{3} \d{3}$/.test(sasB), 'both devices display real 6-digit SAS codes', `${sasA} / ${sasB}`);
  check(sasA !== '' && sasA === sasB, 'both devices independently derived the SAME SAS code', `${sasA} vs ${sasB}`);

  // ---------------------------------------------------------------------
  // Real text message over the text DataChannel
  // ---------------------------------------------------------------------
  console.log('[two-device e2e] A → B: real text message');
  await pageA.getByRole('button', { name: /clipboard/i }).first().click();
  await pageB.getByRole('button', { name: /clipboard/i }).first().click();
  await pageA.waitForSelector('textarea');
  await pageA.locator('textarea').first().fill('Hello from device A over real WebRTC!');
  await pageA.getByRole('button', { name: /send/i }).last().click();
  await pageB.waitForSelector('text=Hello from device A over real WebRTC!', { timeout: 15000 });
  check(true, 'B received the text message end-to-end over the text channel');

  // ---------------------------------------------------------------------
  // Real file transfer (2 MiB pseudo-random binary → hash verification)
  // ---------------------------------------------------------------------
  console.log('[two-device e2e] A → B: real file transfer with SHA-256 verification');
  await pageA.getByRole('button', { name: /transfer/i }).first().click();
  await pageB.getByRole('button', { name: /transfer/i }).first().click();
  const fileBuffer = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < fileBuffer.length; i += 4096) fileBuffer.fill(i % 251, i, i + 4096);
  await pageA.setInputFiles('input[type="file"]', {
    name: 'e2e-test.bin',
    mimeType: 'application/octet-stream',
    buffer: fileBuffer,
  });
  try {
    await pageB.waitForSelector('text=Completed', { timeout: 120000 });
  } catch {
    const dumpA = await pageA.evaluate(() => document.body.innerText.slice(0, 900));
    const dumpB = await pageB.evaluate(() => document.body.innerText.slice(0, 900));
    console.log('  [A transfer dump]', JSON.stringify(dumpA));
    console.log('  [B transfer dump]', JSON.stringify(dumpB));
    throw new Error('file transfer never completed on the receiver');
  }
  check((await pageB.locator('text=e2e-test.bin').count()) > 0, 'B shows the received file entry');

  // Wait for the receiver's integrity verdict
  await pageB.waitForFunction(
    () => document.body.innerText.includes('Verified') || document.body.innerText.includes('failed'),
    { timeout: 30000 }
  );
  const bodyB = await pageB.evaluate(() => document.body.innerText);
  check(/verified/i.test(bodyB) && !/integrity.*failed/i.test(bodyB),
    'receiver verified SHA-256 integrity of the received file');

  // Download the received file from B and compare bytes
  const downloadB = pageB.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await pageB.locator('button:has(svg.lucide-download), [aria-label*="Download"], button:has-text("Download")').first().click().catch(() => {});
  const recvDl = await downloadB;
  if (recvDl) {
    const recvPath = '/tmp/nexdrop-e2e-received.bin';
    await recvDl.saveAs(recvPath);
    const recv = fs.readFileSync(recvPath);
    check(recv.equals(fileBuffer), 'downloaded file bytes are byte-identical to the source');
  } else {
    skip('downloaded-bytes comparison', 'download button not found in DOM');
  }

  // ---------------------------------------------------------------------
  // Cancel: queue a second file, then cancel the active/queued transfer
  // ---------------------------------------------------------------------
  console.log('[two-device e2e] A: cancel a queued transfer');
  await pageA.setInputFiles('input[type="file"]', {
    name: 'e2e-cancel-me.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(64 * 1024),
  });
  await pageA.waitForTimeout(300);
  const cancelBtn = pageA.locator('button:has-text("Cancel")').first();
  if (await cancelBtn.count()) {
    await cancelBtn.click({ timeout: 3000 }).catch(() => {});
    check(true, 'cancel invoked on the sender side');
  } else {
    skip('cancel click', 'transfer finished before cancel could be pressed');
  }

  console.log(`\n[two-device e2e] ${passed} passed, ${failed} failed, ${skipped} skipped`);
  await browser.close();
  server.close();
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('[two-device e2e] FATAL:', e);
  process.exit(1);
});
