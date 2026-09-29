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
    if (process.env.NEXDROP_E2E_VERBOSE || m.type() === 'error' || m.text().includes('[nexdrop]')) {
      console.log('  [A console]', m.type(), m.text().slice(0, 200));
    }
  });
  pageB.on('console', (m) => {
    if (process.env.NEXDROP_E2E_VERBOSE || m.type() === 'error' || m.text().includes('[nexdrop]')) {
      console.log('  [B console]', m.type(), m.text().slice(0, 200));
    }
  });
  pageA.on('pageerror', (e) => console.log('  [A pageerror]', String(e).slice(0, 300)));
  pageB.on('pageerror', (e) => console.log('  [B pageerror]', String(e).slice(0, 300)));

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
  check(offerSegments.every((s) => s.startsWith('NDQS2.') || s.startsWith('NDQS.') || s.startsWith('NDP1.')),
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
  check(answerSegments.every((s) => s.startsWith('NDQS2.') || s.startsWith('NDQS.') || s.startsWith('NDP1.')),
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

  console.log('[two-device e2e] B → A: real text message (reverse direction)');
  await pageB.locator('textarea').first().fill('Hello from device B over real WebRTC!');
  await pageB.getByRole('button', { name: /send/i }).last().click();
  await pageA.waitForSelector('text=Hello from device B over real WebRTC!', { timeout: 15000 });
  check(true, 'A received the reverse-direction text message over the text channel');

  // ---------------------------------------------------------------------
  // File transfer SIZE MATRIX (1 KB -> 100 MB), SHA-256 verified per file
  // ---------------------------------------------------------------------
  console.log('[two-device e2e] A → B: file transfer size matrix with SHA-256 verification');
  await pageA.getByRole('button', { name: /transfer/i }).first().click();
  await pageB.getByRole('button', { name: /transfer/i }).first().click();
  await pageA.waitForSelector('input[type="file"]', { state: 'attached', timeout: 10000 });
  await pageB.waitForSelector('input[type="file"]', { state: 'attached', timeout: 10000 });
  const patternBuffer = (bytes: number) => {
    const buf = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 4096) buf.fill((i / 4096) % 251, i, Math.min(i + 4096, bytes));
    return buf;
  };

  /** Wait until `name` followed by `status` appears in the page body text. */
  async function waitForNameStatus(page: any, name: string, status: string, timeoutMs: number) {
    await page.waitForFunction(
      ([fname, stat]: [string, string]) => {
        const esc = fname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(esc + '[\\s\\S]{0,600}' + stat).test(document.body.innerText);
      },
      [name, status],
      { timeout: timeoutMs, polling: 250 }
    );
  }

  /** Current sender-side progress % for `name`, or -1 when not visible. */
  async function senderProgress(page: any, name: string): Promise<number> {
    return await page.evaluate((fname: string) => {
      const esc = fname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = document.body.innerText.match(new RegExp(esc + '[\\s\\S]{0,400}?(\\d+)%'));
      return m ? parseInt(m[1], 10) : -1;
    }, name);
  }

  async function dumpFailure(label: string) {
    try {
      const dumpA = await pageA.evaluate(() => document.body.innerText.slice(0, 900));
      console.log('  [A dump @ ' + label + ']', JSON.stringify(dumpA));
      const dumpB = await pageB.evaluate(() => document.body.innerText.slice(0, 900));
      console.log('  [B dump @ ' + label + ']', JSON.stringify(dumpB));
    } catch {
      console.log('  [dump @ ' + label + '] unavailable (page closed)');
    }
  }

  const matrix: Array<[string, number, number]> = [
    ['e2e-size-1kb.bin', 1 * 1024, 45000],
    ['e2e-size-100kb.bin', 100 * 1024, 45000],
    ['e2e-size-1mb.bin', 1024 * 1024, 60000],
    ['e2e-size-2mb.bin', 2 * 1024 * 1024, 60000],
    ['e2e-size-10mb.bin', 10 * 1024 * 1024, 120000],
    ['e2e-size-100mb.bin', 100 * 1024 * 1024, 420000],
  ];

  const buffer10mb = patternBuffer(10 * 1024 * 1024);
  for (const [name, size, timeoutMs] of matrix) {
    const buf = size === 10 * 1024 * 1024 ? buffer10mb : patternBuffer(size);
    await pageA.setInputFiles('input[type="file"]', { name, mimeType: 'application/octet-stream', buffer: buf });
    try {
      await waitForNameStatus(pageA, name, 'Completed', timeoutMs);
      await waitForNameStatus(pageB, name, 'Completed', timeoutMs);
      await waitForNameStatus(pageB, name, 'Verified', 30000);
      check(true, `${name} (${size} bytes): sent, received, SHA-256 verified end-to-end`);
    } catch {
      await dumpFailure(name);
      check(false, `${name} (${size} bytes) did not complete + verify within ${timeoutMs}ms`);
    }
  }

  // Byte-identity proof on the 10 MiB file: save it on B, compare to source
  const saved = await pageB.evaluate(() => {
    const ps = [...document.querySelectorAll('p')].filter(
      (p) => p.textContent?.trim() === 'e2e-size-10mb.bin'
    );
    for (const p of ps) {
      let el = p.parentElement;
      while (el) {
        const btn = el.querySelector?.('button[title="Save to local device"]');
        if (btn) { (btn as HTMLElement).click(); return true; }
        el = el.parentElement;
      }
    }
    return false;
  });
  if (saved) {
    const recvDl = await pageB.waitForEvent('download', { timeout: 20000 });
    const recvPath = '/tmp/nexdrop-e2e-received-10mb.bin';
    await recvDl.saveAs(recvPath);
    const recv = fs.readFileSync(recvPath);
    check(recv.equals(buffer10mb), '10 MiB received file is byte-identical to the source');
  } else {
    skip('byte-identity download', 'Save button not found for the 10 MiB item');
  }

  // ---------------------------------------------------------------------
  // Pause / Resume on a live 250 MiB transfer
  // ---------------------------------------------------------------------
  console.log('[two-device e2e] A → B: pause + resume of a live 250 MiB transfer');
  const bigBuffer = patternBuffer(250 * 1024 * 1024);
  await pageA.setInputFiles('input[type="file"]', {
    name: 'e2e-pause-resume.bin', mimeType: 'application/octet-stream', buffer: bigBuffer,
  });
  try {
    await pageA.waitForFunction(
      () => {
        const t = document.body.innerText;
        return t.includes('e2e-pause-resume.bin') && /\d+%/.test(t);
      },
      { timeout: 60000, polling: 200 }
    );
    await pageA.getByRole('button', { name: 'Pause', exact: true }).click();
    await pageA.waitForSelector('text=Paused', { timeout: 15000 });
    const pct1 = await senderProgress(pageA, 'e2e-pause-resume.bin');
    await pageA.waitForTimeout(2000);
    const pct2 = await senderProgress(pageA, 'e2e-pause-resume.bin');
    check(pct2 - pct1 <= 2, `pause freezes the live transfer (${pct1}% → ${pct2}%)`);
    await pageA.getByRole('button', { name: 'Resume', exact: true }).click();
    await waitForNameStatus(pageA, 'e2e-pause-resume.bin', 'Completed', 420000);
    await waitForNameStatus(pageB, 'e2e-pause-resume.bin', 'Completed', 60000);
    await waitForNameStatus(pageB, 'e2e-pause-resume.bin', 'Verified', 30000);
    check(true, 'resume completes the 250 MiB transfer with SHA-256 verified');
  } catch {
    await dumpFailure('pause-resume');
    check(false, 'pause/resume of a live 250 MiB transfer failed');
  }

  // ---------------------------------------------------------------------
  // Cancel a LIVE transfer mid-stream (the old test could only cancel a
  // queued item because loopback transfers finished instantly)
  // ---------------------------------------------------------------------
  console.log('[two-device e2e] A → B: cancel a live mid-stream transfer');
  try {
    await pageA.setInputFiles('input[type="file"]', {
      name: 'e2e-cancel-live.bin', mimeType: 'application/octet-stream', buffer: bigBuffer,
    });
    await pageA.waitForFunction(
      () => {
        const t = document.body.innerText;
        return t.includes('e2e-cancel-live.bin') && /\d+%/.test(t);
      },
      { timeout: 60000, polling: 200 }
    );
    await pageA.getByRole('button', { name: 'Cancel', exact: true }).click();
    await waitForNameStatus(pageA, 'e2e-cancel-live.bin', 'Cancelled', 15000);
    check(true, 'sender: live transfer cancelled immediately on request');
    await waitForNameStatus(pageB, 'e2e-cancel-live.bin', 'Cancelled', 15000);
    check(true, 'receiver: informed of the cancellation (no silent stall)');
    await pageA.waitForTimeout(3000);
    const bText = await pageB.evaluate(() => document.body.innerText);
    const fake = bText.match(/e2e-cancel-live\.bin[\s\S]{0,600}?Completed/);
    check(!fake, 'no fake completion after cancellation');

    // Sender must be fully reusable right after a cancel
    await pageA.setInputFiles('input[type="file"]', {
      name: 'e2e-after-cancel.bin', mimeType: 'application/octet-stream', buffer: patternBuffer(100 * 1024),
    });
    await waitForNameStatus(pageB, 'e2e-after-cancel.bin', 'Completed', 45000);
    check(true, 'sender resources cleaned up: next transfer works immediately');
  } catch {
    await dumpFailure('cancel-live');
    check(false, 'live cancel sequence failed');
  }

  // ---------------------------------------------------------------------
  // Disconnect DURING a live transfer: real failure detection, no fake
  // completion, resources released
  // ---------------------------------------------------------------------
  console.log('[two-device e2e] peer disconnect during a live transfer');
  try {
    await pageA.setInputFiles('input[type="file"]', {
      name: 'e2e-disconnect.bin', mimeType: 'application/octet-stream', buffer: bigBuffer,
    });
    await pageA.waitForFunction(
      () => {
        const t = document.body.innerText;
        return t.includes('e2e-disconnect.bin') && /\d+%/.test(t);
      },
      { timeout: 60000, polling: 200 }
    );
    console.log('[two-device e2e] closing device B mid-transfer');
    await ctxB.close();
    await waitForNameStatus(pageA, 'e2e-disconnect.bin', 'Failed', 90000);
    check(true, 'sender detects the dead peer and marks the transfer Failed');
    const aText = await pageA.evaluate(() => document.body.innerText);
    const fake = aText.match(/e2e-disconnect\.bin[\s\S]{0,600}?Completed/);
    check(!fake, 'no fake completion after peer disconnect');
  } catch {
    await dumpFailure('disconnect');
    check(false, 'disconnect-during-transfer was not detected on the sender');
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
