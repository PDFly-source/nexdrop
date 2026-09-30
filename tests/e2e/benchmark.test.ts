/**
 * NexDrop REAL transfer benchmark (two-device, real WebRTC).
 *
 * Pairs two isolated browser contexts through the real one-scan signal
 * flow, then transfers real files of configurable sizes while sampling
 * the engines' live telemetry (window.__NEXDROP_TELEMETRY__) — real
 * measured values only: bytes, times, RTT, bufferedAmount, heap.
 *
 * Prints one [BENCH] JSON line per size with:
 *   timeMs, avg/peak/final MB/s, avg/peak RTT, max bufferedAmount,
 *   receiver write ms, peak heap, pause/resume result, SHA-256 verify.
 *
 * Sizes via NEXDROP_BENCH_SIZES (bytes, comma-separated).
 * Default: 100 MiB, 500 MiB, 1 GiB. 5 GiB only by explicit env opt-in.
 */

import { chromium, devices } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = 3998;
const OUT_DIR = path.join(process.cwd(), 'out');
const SIZES = (process.env.NEXDROP_BENCH_SIZES || `${100 * 1024 * 1024},${500 * 1024 * 1024},${1024 * 1024 * 1024}`)
  .split(',')
  .map((x) => parseInt(x.trim(), 10))
  .filter((x) => x > 0);

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function startServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let urlPath = req.url?.split('?')[0] || '/';
    if (urlPath.startsWith('/nexdrop')) urlPath = urlPath.slice('/nexdrop'.length) || '/';
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(OUT_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

async function decodeAllQrSegments(page: any): Promise<string[]> {
  const jsqrSource = fs.readFileSync(path.join(process.cwd(), 'node_modules/jsqr/dist/jsQR.js'), 'utf8');
  await page.evaluate(jsqrSource);
  const text = await page.evaluate(() => {
    const img = document.querySelector('img[alt*="QR code"]') as HTMLImageElement | null;
    if (!img) return null;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const code = (window as any).jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' });
    return code ? code.data : null;
  });
  if (!text) throw new Error('host QR could not be decoded');
  return [text];
}

async function submitViaPaste(page: any, pieces: string[]) {
  await page.waitForSelector('#qr-paste', { timeout: 10000 });
  for (const piece of pieces) {
    await page.locator('#qr-paste').fill(piece);
    await page.getByRole('button', { name: 'Use', exact: true }).click();
    await page.waitForTimeout(200);
  }
}

interface Sample {
  t: number;
  sentBytes: number;
  sentBps: number;
  srtt: number;
  buffered: number;
  windowChunks: number;
  chunkSize: number;
  stalls: number;
  recvBytes: number;
  recvBps: number;
  writeMs: number;
  heapA: number;
  heapB: number;
}

async function main() {
  console.log('[benchmark] sizes (MiB):', SIZES.map((s) => (s / 1048576).toFixed(0)).join(', '));
  const server = await startServer();

  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext({ ...devices['Pixel 7'], permissions: ['camera'] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  pageA.on('pageerror', (e) => console.log('  [A pageerror]', String(e).slice(0, 200)));
  pageB.on('pageerror', (e) => console.log('  [B pageerror]', String(e).slice(0, 200)));

  const url = `http://localhost:${PORT}/nexdrop/`;
  await pageA.goto(url, { waitUntil: 'domcontentloaded' });
  await pageB.goto(url, { waitUntil: 'domcontentloaded' });
  await pageA.waitForSelector('text=Create pairing', { timeout: 30000 });
  await pageB.waitForSelector('text=Create pairing', { timeout: 30000 });

  // --- real one-scan pairing ---
  await pageA.getByRole('button', { name: /create pairing/i }).first().click();
  await pageA.waitForSelector('img[alt*="QR code"]', { timeout: 30000 });
  const offerSegments = await decodeAllQrSegments(pageA);
  await pageB.getByRole('button', { name: /join pairing/i }).first().click();
  await submitViaPaste(pageB, offerSegments);
  await pageB.waitForSelector('text=Join request sent', { timeout: 20000 });
  await pageA.waitForSelector('text=New connection request', { timeout: 20000 });
  await pageA.getByRole('button', { name: /^Accept$/ }).click();
  await pageA.waitForSelector('text=Connected', { timeout: 60000, state: 'attached' });
  await pageB.waitForSelector('text=Connected', { timeout: 60000, state: 'attached' });
  console.log('[benchmark] connected — starting transfer matrix');

  const patternBuffer = (bytes: number) => {
    const buf = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 4096) buf.fill((i / 4096) % 251, i, Math.min(i + 4096, bytes));
    return buf;
  };

  const uploadTmpFiles: string[] = [];
  const uploadFile = async (page: any, name: string, buffer: Buffer) => {
    if (buffer.length > 40 * 1024 * 1024) {
      const tmp = path.join(os.tmpdir(), `nexdrop-bench-${name}`);
      fs.writeFileSync(tmp, buffer);
      uploadTmpFiles.push(tmp);
      await page.setInputFiles('input[type="file"]', tmp);
      return;
    }
    await page.setInputFiles('input[type="file"]', { name, mimeType: 'application/octet-stream', buffer });
  };

  const recvTab = pageB.getByRole('button', { name: /Receive \(\d+\)/ });
  if (await recvTab.count()) { await recvTab.first().click(); await pageB.waitForTimeout(300); }

  async function waitForNameStatus(page: any, name: string, status: string, timeoutMs: number) {
    await page.waitForFunction(
      ([fname, stat]: [string, string]) => {
        const esc = fname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(esc + '[\\s\\S]{0,100}' + stat).test(document.body.innerText);
      },
      [name, status],
      { timeout: timeoutMs, polling: 250 }
    );
  }

  const readTelemetry = (page: any) =>
    page.evaluate(() => ({
      s: (window as any).__NEXDROP_TELEMETRY__?.sender || null,
      r: (window as any).__NEXDROP_TELEMETRY__?.receiver || null,
      heap: (performance as any)?.memory?.usedJSHeapSize ?? 0,
    }));

  const results: Array<Record<string, unknown>> = [];
  let first = true;
  let anyFailed = false;

  for (const size of SIZES) {
    const name = `bench-${(size / 1048576).toFixed(0)}mib.bin`;
    console.log(`[benchmark] transferring ${name}`);
    await uploadFile(pageA, name, patternBuffer(size));

    const samples: Sample[] = [];
    let failed = false;
    const timeoutMs = Math.max(300000, Math.ceil((size / (2.5 * 1024 * 1024)) * 1000) + 120000);
    const t0 = Date.now();
    let pausedResumed = 'n/a';
    let shaVerified = false;

    try {
      let transferDone = false;
      const doneA = waitForNameStatus(pageA, name, 'Completed', timeoutMs).finally(() => { transferDone = true; });
      const poll = (async () => {
        for (; !transferDone;) {
          await new Promise((r) => setTimeout(r, 500));
          try {
            const [ta, tb] = await Promise.all([readTelemetry(pageA), readTelemetry(pageB)]);
            samples.push({
              t: Date.now() - t0,
              sentBytes: ta.s?.bytesSent ?? 0, sentBps: ta.s?.throughputBps ?? 0,
              srtt: ta.s?.srttMs ?? 0, buffered: ta.s?.bufferedAmount ?? 0,
              windowChunks: ta.s?.windowChunks ?? 0, chunkSize: ta.s?.chunkSize ?? 0,
              stalls: ta.s?.stalls ?? 0,
              recvBytes: tb.r?.bytesReceived ?? 0, recvBps: tb.r?.throughputBps ?? 0,
              writeMs: tb.r?.writeMsEwma ?? 0,
              heapA: ta.heap, heapB: tb.heap,
            });
          } catch { /* page busy */ }
        }
      })();
      poll.catch(() => {});

      // Pause/resume on the FIRST size only, once ~25% done
      if (first) {
        try {
          await pageA.waitForFunction(() => {
            const t = document.body.innerText;
            const s = t.indexOf('SENDING TO PEER');
            const q = t.indexOf('Outbound Queue');
            return s !== -1 && q !== -1 && q > s && /(\d+)%/.test(t.substring(s, q)) && parseInt((t.substring(s, q).match(/(\d+)%/) || ['0', '0'])[1], 10) >= 25;
          }, undefined, { timeout: Math.min(180000, timeoutMs), polling: 250 });
          await pageA.getByRole('button', { name: 'Pause', exact: true }).click();
          await pageA.waitForSelector('text=Paused', { timeout: 15000 });
          await pageA.waitForTimeout(2000);
          await pageA.getByRole('button', { name: 'Resume', exact: true }).click();
          pausedResumed = 'ok';
        } catch {
          pausedResumed = 'not-reached (transfer finished before pause point)';
        }
        first = false;
      }

      await doneA;
      await waitForNameStatus(pageB, name, 'Completed', Math.max(60000, timeoutMs / 4));
      const doneT = Date.now() - t0;
      try {
        await waitForNameStatus(pageB, name, 'Verified', 60000);
        shaVerified = true;
      } catch { shaVerified = false; }

      const peakBps = samples.reduce((m, x) => Math.max(m, x.sentBps), 0);
      const finalBps = samples.length ? samples[samples.length - 1].sentBps : 0;
      const rtts = samples.map((x) => x.srtt).filter((x) => x > 0);
      const avgRtt = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0;
      const peakRtt = rtts.reduce((m, x) => Math.max(m, x), 0);
      const maxBuf = samples.reduce((m, x) => Math.max(m, x.buffered), 0);
      const maxWin = samples.reduce((m, x) => Math.max(m, x.windowChunks), 0);
      const chunkMin = samples.length ? samples.reduce((m, x) => Math.min(m, x.chunkSize || Infinity), Infinity) : 0;
      const chunkMax = samples.reduce((m, x) => Math.max(m, x.chunkSize), 0);
      const recvWriteMs = samples.length ? samples[samples.length - 1].writeMs : 0;
      const peakHeapA = samples.reduce((m, x) => Math.max(m, x.heapA), 0);
      const peakHeapB = samples.reduce((m, x) => Math.max(m, x.heapB), 0);
      const stalls = samples.length ? samples[samples.length - 1].stalls : 0;

      const r = {
        size, timeMs: doneT,
        avgMBps: +(size / 1048576 / (doneT / 1000)).toFixed(2),
        peakMBps: +(peakBps / 1048576).toFixed(2),
        finalMBps: +(finalBps / 1048576).toFixed(2),
        avgRttMs: +avgRtt.toFixed(0), peakRttMs: +peakRtt.toFixed(0),
        maxBufferedKB: Math.round(maxBuf / 1024),
        maxWindowChunks: maxWin,
        chunkSizeMinKB: chunkMin === Infinity ? 0 : Math.round(chunkMin / 1024),
        chunkSizeMaxKB: Math.round(chunkMax / 1024),
        receiverWriteMs: +recvWriteMs.toFixed(1),
        stalls, pauseResume: pausedResumed, shaVerified,
        peakHeapMB_A: +(peakHeapA / 1048576).toFixed(0), peakHeapMB_B: +(peakHeapB / 1048576).toFixed(0),
      };
      results.push(r);
      console.log('[BENCH] ' + JSON.stringify(r));
    } catch (e) {
      anyFailed = true;
      console.log('[BENCH-FAILED] ' + name + ': ' + String(e).slice(0, 200));
    }
  }

  // Cleanup temp upload files (must stay alive during the run)
  for (const tmp of uploadTmpFiles) { try { fs.unlinkSync(tmp); } catch {} }

  console.log('[BENCH-SUMMARY] ' + JSON.stringify(results));
  await browser.close();
  server.close();
  process.exit(anyFailed ? 1 : 0);
}

main().catch((e) => {
  console.error('[benchmark] FATAL', e);
  process.exit(1);
});
