/**
 * NexDrop REAL transfer benchmark (two-device, real WebRTC).
 *
 * Pairs two isolated browser contexts over REAL WebRTC via the hermetic
 * manual code path (signaling blocked — identical transport), then transfers real files of configurable sizes while sampling
 * the engines' live telemetry (window.__NEXDROP_TELEMETRY__) — real
 * measured values only: bytes, times, RTT, bufferedAmount, heap.
 *
 * Prints one [BENCH] JSON line per size with:
 *   timeMs, avg/peak/final MB/s, avg/peak RTT, max bufferedAmount,
 *   receiver write ms, peak heap, pause/resume result, SHA-256 verify.
 *
 * Sizes via NEXDROP_BENCH_SIZES (bytes, comma-separated).
 * Default: 100 MiB, 250 MiB — chosen so the matrix always completes inside
 * the CI job budget (see the environment note below). Larger sizes (1 GiB,
 * 5 GiB) only by explicit env opt-in on a beefier machine.
 */

import { chromium, devices } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = 3998;
const OUT_DIR = path.join(process.cwd(), 'out');
const SIZES = (process.env.NEXDROP_BENCH_SIZES || `${100 * 1024 * 1024},${250 * 1024 * 1024}`)
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

  const decodeVisible = () =>
    page.evaluate(() => {
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
  // v2.2 validation set (all measured engine values):
  sustainedBps: number;      // whole-transfer average (bytesAcked / elapsed)
  rttVarMs: number;          // EWMA of RTT variance (jitter)
  inFlight: number;          // sent - acked (real bytes on the wire)
  channels: number;          // active SCTP streams in the striping pool
  windowBytes: number;       // send window in bytes
  queueDepth: number;        // receiver write-queue depth
  retrans: number;           // selected-pair retransmissions (getStats)
  outBitrate: number;        // availableOutgoingBitrate (getStats)
  inBitrate: number;        // availableIncomingBitrate (getStats)
  transportRttMs: number;    // selected-pair STUN RTT (getStats)
  candidatePair: string;     // e.g. 'host:host (local)'
}

/**
 * Phase 19 IA: the app opens on Home; pairing controls live in the Devices
 * tab and the file input lives in the Transfers workspace. Fresh Chromium
 * contexts also show the first-launch onboarding overlay (Layer 1,
 * localStorage-gated). These helpers drive the same navigation a real user
 * would take on both the desktop (Navbar) and mobile (BottomNav) layouts.
 */
async function dismissOnboardingIfShown(page: any) {
  try {
    await page.waitForSelector('button:has-text("Get Started")', { timeout: 3000 });
    await page.getByRole('button', { name: 'Get Started' }).click();
  } catch {
    // Onboarding did not appear — nothing to dismiss.
  }
}

async function goToTab(page: any, label: string) {
  await page.locator('button:visible').filter({ hasText: label }).first().click();
}

async function goToDevicesTab(page: any) {
  await dismissOnboardingIfShown(page);
  await goToTab(page, 'Devices');
  await page.waitForSelector('text=Create pairing', { timeout: 30000 });
}

async function main() {
  console.log('[benchmark] tier C — real two-device browser benchmark (real WebRTC DataChannels)');
  console.log('[benchmark] environment: two isolated Chromium contexts on one host — a real DataChannel path over loopback host candidates, not a physical network');
  console.log('[benchmark] note: sustained high-rate loops on the 2-core CI runner can overflow the receiver UDP socket and collapse SCTP throughput to a crawl (measured ~0.4 MB/s after ~100-200 MiB cumulative). Timeouts are sized for that worst case, a 120s no-progress abort ends dead links early, and completion + SHA-256 verification are always required — throughput numbers are measured telemetry, never asserted speeds.');
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
  // HERMETIC: block the signaling service on both pages and pair via the
  // manual code path. The WebRTC DataChannel transport — the thing being
  // measured — is identical to the one-scan flow, and no external service
  // can flake the benchmark. (The regression e2e covers the signal path.)
  const blockSignaling = (page: any) =>
    page.route('**/functions/nexdropSignal*', (route: any) => route.abort());
  await blockSignaling(pageA);
  await blockSignaling(pageB);
  await pageA.goto(url, { waitUntil: 'domcontentloaded' });
  await pageB.goto(url, { waitUntil: 'domcontentloaded' });
  await goToDevicesTab(pageA);
  await goToDevicesTab(pageB);

  // --- manual pairing (real SDP offer/answer over QR paste, real WebRTC) ---
  await pageA.getByRole('button', { name: /create pairing/i }).first().click();
  await pageA.waitForSelector('text=Automatic pairing unavailable', { timeout: 30000 });
  await pageA.getByRole('button', { name: /use manual pairing code/i }).first().click();
  await pageA.waitForSelector('img[alt*="QR code"]', { timeout: 30000 });
  const offerSegments = await decodeAllQrSegments(pageA);
  await pageB.getByRole('button', { name: /join pairing/i }).first().click();
  await submitViaPaste(pageB, offerSegments);
  await pageB.waitForSelector('text=NexDrop wants to connect', { timeout: 20000 });
  await pageB.getByRole('button', { name: /accept & connect/i }).click();
  await pageB.waitForSelector('text=Return this connection code to the sender', { timeout: 30000 });
  const answerSegments = await decodeAllQrSegments(pageB);
  await pageA.getByRole('button', { name: /scan answer qr/i }).click();
  await submitViaPaste(pageA, answerSegments);
  await pageA.waitForSelector('text=Connected', { timeout: 45000 });
  await pageB.waitForSelector('text=Connected', { timeout: 45000 });
  console.log('[benchmark] connected — switching to the Transfers tab (Phase 19 IA) before uploads');
  await goToTab(pageA, 'Transfers');
  await goToTab(pageB, 'Transfers');
  await pageA.waitForSelector('input[type="file"]', { state: 'attached', timeout: 10000 });
  await pageB.waitForSelector('input[type="file"]', { state: 'attached', timeout: 10000 });
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

  // Phase 19 UI: receiver status text is invisible to innerText on the
  // mobile viewport unless the Receive tab of the Send/Receive segmented
  // control is selected; waitForNameStatus re-asserts it before every
  // receiver-side read.
  await ensureReceivePanelOpen(pageB);

  /**
   * Phase 19 UI: on mobile viewports the Transfers workspace shows one panel
   * at a time behind the Send/Receive segmented control (role="tab"), and
   * document.body.innerText EXCLUDES the hidden panel — so receiver-side
   * status text is invisible to innerText unless the Receive tab is selected.
   * Ensure it is. Idempotent: only clicks when the tab is not already
   * selected. No-op on desktop viewports, where the segmented control is
   * not rendered at all (both panels are always visible).
   */
  /** Mirror of ensureReceivePanelOpen for the sender side — the file input
   *  works from any tab, but the mobile segmented control hides the Send
   *  panel; open it so queue status text is visible to innerText waits. */
  async function ensureSendPanelOpen(page: any) {
    const tab = page.getByRole('tab', { name: /^Send \(\d+\)$/ }).first();
    if (!(await tab.count()) || !(await tab.isVisible())) return;
    if ((await tab.getAttribute('aria-selected')) !== 'true') {
      await tab.click();
      await page.waitForTimeout(300);
    }
  }

  async function ensureReceivePanelOpen(page: any) {
    const tab = page.getByRole('tab', { name: /Receive \(\d+\)/ }).first();
    // The segmented control exists in the DOM on desktop too, but is
    // display:none there (both panels are always visible) — a Playwright
    // click on it would stall on actionability, so bail when not visible.
    if (!(await tab.count()) || !(await tab.isVisible())) return;
    if ((await tab.getAttribute('aria-selected')) !== 'true') {
      await tab.click();
      await page.waitForTimeout(300);
    }
  }

  async function waitForNameStatus(page: any, name: string, status: string, timeoutMs: number) {
    await ensureReceivePanelOpen(page);
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
    page.evaluate(() => {
      const t = (window as any).__NEXDROP_TELEMETRY__;
      return {
        s: t?.sender || null,
        r: t?.receiver || null,
        // REAL getStats() transport truth (sampled by the session hook):
        // selected-pair RTT, retransmissions, available bitrates, candidate type.
        tr: t?.transport || null,
        heap: (performance as any)?.memory?.usedJSHeapSize ?? 0,
      };
    });

  const results: Array<Record<string, unknown>> = [];
  let first = true;
  let anyFailed = false;
  const consoleErrors: Record<string, string[]> = { A: [], B: [] };
  for (const [pkey, pg] of [['A', pageA], ['B', pageB]] as const) {
    pg.on('console', (msg: any) => {
      if (msg.type() === 'error') consoleErrors[pkey].push(msg.text().slice(0, 300));
      // Relay the multi-channel gate's measured A/B verdicts (engine
      // console.debug) into the CI log — real in-run measurement data.
      if (msg.type() === 'debug' && msg.text().includes('channel A/B')) {
        console.log(`[CHANNEL-AB ${pkey}] ${msg.text()}`);
      }
    });
  }
  const dumpStallState = async (label: string) => {
    try {
      const [ta, tb] = await Promise.all([readTelemetry(pageA), readTelemetry(pageB)]);
      const phase = await pageA.evaluate(() => (window as any).__NEXDROP_PHASE__ ?? null).catch(() => null);
      const bodyA = await pageA.evaluate(() => document.body.innerText.slice(0, 500));
      const bodyB = await pageB.evaluate(() => document.body.innerText.slice(0, 500));
      console.log('[STALL-STATE]', label, JSON.stringify({ phase, telemetryA: ta, telemetryB: tb }));
      console.log('[STALL-BODY-A]', label, JSON.stringify(bodyA.slice(0, 400)));
      console.log('[STALL-BODY-B]', label, JSON.stringify(bodyB.slice(0, 400)));
      console.log('[STALL-CONSOLE-ERRORS]', label, JSON.stringify({ A: consoleErrors.A.slice(-6), B: consoleErrors.B.slice(-6) }));
    } catch (e: any) {
      console.log('[STALL-STATE]', label, 'dump failed:', e?.message);
    }
  };

  // Test matrix: A→B AND B→A for every size — both devices must send and
  // receive (the two-device e2e only exercises A→B).
  const directions: Array<{ label: string; from: any; to: any }> = [
    { label: 'A>B', from: pageA, to: pageB },
    { label: 'B>A', from: pageB, to: pageA },
  ];

  for (const dir of directions) {
    for (const size of SIZES) {
    const name = `bench-${dir.label === 'A>B' ? '' : 'rev-'}${(size / 1048576).toFixed(0)}mib.bin`;
    console.log(`[benchmark] transferring ${name} (${dir.label})`);
    await ensureSendPanelOpen(dir.from);
    await uploadFile(dir.from, name, patternBuffer(size));

    const samples: Sample[] = [];
    let failed = false;
    let lastSentBytes = 0;
    let lastProgressAt = Date.now();
    // Crawl-tolerant ceiling: sustained high-rate loopback transfer on the
    // 2-core CI runner can overflow the receiver's UDP socket, collapse
    // SCTP throughput to ~0.4 MB/s (measured), and turn a nominal 60 s
    // transfer into a 10-minute one. Size the timeout for that measured
    // worst case; a 120 s no-progress abort below fails dead links early.
    const timeoutMs = Math.max(900000, Math.ceil((size / (0.35 * 1024 * 1024)) * 1000) + 120000);
    const t0 = Date.now();
    let pausedResumed = 'n/a';
    let shaVerified = false;

    try {
      let transferDone = false;
      const doneA = waitForNameStatus(dir.from, name, 'Completed', timeoutMs).finally(() => { transferDone = true; });
      const poll = (async () => {
        for (; !transferDone;) {
          await new Promise((r) => setTimeout(r, 500));
          try {
            const [ta, tb] = await Promise.all([readTelemetry(dir.from), readTelemetry(dir.to)]);
            if ((ta.s?.bytesSent ?? 0) > lastSentBytes) {
              lastSentBytes = ta.s?.bytesSent ?? 0;
              lastProgressAt = Date.now();
            }
            samples.push({
              t: Date.now() - t0,
              sentBytes: ta.s?.bytesSent ?? 0, sentBps: ta.s?.throughputBps ?? 0,
              srtt: ta.s?.srttMs ?? 0, buffered: ta.s?.bufferedAmount ?? 0,
              windowChunks: ta.s?.windowChunks ?? 0, chunkSize: ta.s?.chunkSize ?? 0,
              stalls: ta.s?.stalls ?? 0,
              recvBytes: tb.r?.bytesReceived ?? 0, recvBps: tb.r?.throughputBps ?? 0,
              writeMs: tb.r?.writeMsEwma ?? 0,
              heapA: ta.heap, heapB: tb.heap,
              sustainedBps: ta.s?.sustainedBps ?? 0,
              rttVarMs: ta.s?.rttVarianceMs ?? 0,
              inFlight: ta.s?.inFlightBytes ?? 0,
              channels: ta.s?.activeChannels ?? 1,
              windowBytes: ta.s?.windowBytes ?? 0,
              queueDepth: tb.r?.queueDepth ?? 0,
              retrans: ta.tr?.retransmissionsSent ?? -1,
              outBitrate: ta.tr?.outgoingBitrateBps ?? -1,
              inBitrate: tb.tr?.incomingBitrateBps ?? -1,
              transportRttMs: ta.tr?.rttMs ?? -1,
              candidatePair: (ta.tr?.transport || '?') + ':' + (ta.tr?.localCandidateType || '?') + '->' + (ta.tr?.remoteCandidateType || '?'),
            });
          } catch { /* page busy */ }
        }
      })();
      poll.catch(() => {});

      // Pause/resume on the FIRST size only, once ~25% done
      if (first) {
        try {
          await dir.from.waitForFunction(() => {
            const t = document.body.innerText;
            const s = t.indexOf('SENDING TO PEER');
            const q = t.indexOf('Outbound Queue');
            return s !== -1 && q !== -1 && q > s && /(\d+)%/.test(t.substring(s, q)) && parseInt((t.substring(s, q).match(/(\d+)%/) || ['0', '0'])[1], 10) >= 25;
          }, undefined, { timeout: Math.min(180000, timeoutMs), polling: 250 });
          await dir.from.getByRole('button', { name: 'Pause', exact: true }).click();
          await dir.from.waitForSelector('text=Paused', { timeout: 15000 });
          await dir.from.waitForTimeout(2000);
          await dir.from.getByRole('button', { name: 'Resume', exact: true }).click();
          pausedResumed = 'ok';
        } catch {
          pausedResumed = 'not-reached (transfer finished before pause point)';
        }
        first = false;
      }

      // Honest early abort: zero sender progress for 120s means the link is
      // dead (not merely congested — a crawl still moves forward every poll).
      const stallAbort = new Promise<never>((_, reject) => {
        const iv = setInterval(() => {
          if (transferDone) { clearInterval(iv); return; }
          if (Date.now() - lastProgressAt > 120000) {
            clearInterval(iv);
            reject(new Error('stalled: no sender progress for 120s'));
          }
        }, 5000);
      });
      try {
        await Promise.race([doneA, stallAbort]);
      } catch (e: any) {
        transferDone = true; // stop the telemetry poll loop
        doneA.catch(() => {}); // swallow the now-abandoned wait's rejection
        await dumpStallState(name);
        throw e;
      }
      await waitForNameStatus(dir.to, name, 'Completed', Math.max(60000, timeoutMs / 4));
      const doneT = Date.now() - t0;
      try {
        await waitForNameStatus(dir.to, name, 'Verified', 60000);
        shaVerified = true;
      } catch { shaVerified = false; }

      const peakBps = samples.reduce((m, x) => Math.max(m, x.sentBps), 0);
      const finalBps = samples.length ? samples[samples.length - 1].sentBps : 0;
      const rtts = samples.map((x) => x.srtt).filter((x) => x > 0);
      const avgRtt = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0;
      const peakRtt = rtts.reduce((m, x) => Math.max(m, x), 0);
      const maxBuf = samples.reduce((m, x) => Math.max(m, x.buffered), 0);
      const maxWin = samples.reduce((m, x) => Math.max(m, x.windowChunks), 0);
      const maxWinBytesTotal = samples.reduce((m, x) => Math.max(m, x.windowBytes), 0);
      const chunkMin = samples.length ? samples.reduce((m, x) => Math.min(m, x.chunkSize || Infinity), Infinity) : 0;
      const chunkMax = samples.reduce((m, x) => Math.max(m, x.chunkSize), 0);
      const recvWriteMs = samples.length ? samples[samples.length - 1].writeMs : 0;
      // v2.2 validation extras — all measured from the sample stream.
      const sustainedBps = samples.length ? samples[samples.length - 1].sustainedBps : 0;
      const rttVars = samples.map((x) => x.rttVarMs).filter((x) => x > 0);
      const avgRttVar = rttVars.length ? rttVars.reduce((a, b) => a + b, 0) / rttVars.length : 0;
      const maxInFlight = samples.reduce((m, x) => Math.max(m, x.inFlight), 0);
      const channelsSeen = [...new Set(samples.map((x) => x.channels))].sort((a, b) => a - b);
      const maxQueue = samples.reduce((m, x) => Math.max(m, x.queueDepth), 0);
      const finalRetrans = samples.length ? samples[samples.length - 1].retrans : -1;
      const maxOutBitrate = samples.reduce((m, x) => Math.max(m, x.outBitrate), 0);
      const maxInBitrate = samples.reduce((m, x) => Math.max(m, x.inBitrate), 0);
      const pairCounts: Record<string, number> = {};
      for (const x of samples) pairCounts[x.candidatePair] = (pairCounts[x.candidatePair] || 0) + 1;
      const candidatePair = Object.entries(pairCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '?';
      const maxTransportRtt = samples.reduce((m, x) => Math.max(m, x.transportRttMs), 0);
      const peakHeapA = samples.reduce((m, x) => Math.max(m, x.heapA), 0);
      const peakHeapB = samples.reduce((m, x) => Math.max(m, x.heapB), 0);
      const stalls = samples.length ? samples[samples.length - 1].stalls : 0;

      const r = {
        direction: dir.label, size, timeMs: doneT,
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
        sustainedMBps: +(sustainedBps / 1048576).toFixed(2),
        avgRttVarianceMs: +avgRttVar.toFixed(1),
        maxInFlightKB: Math.round(maxInFlight / 1024),
        maxWindowBytes: maxWinBytesTotal,
        channelsSeen,
        maxRecvQueueDepth: maxQueue,
        retransmissions: finalRetrans,
        availOutgoingMbps: +(maxOutBitrate / 1e6).toFixed(1),
        availIncomingMbps: +(maxInBitrate / 1e6).toFixed(1),
        candidatePair,
        maxTransportRttMs: +maxTransportRtt.toFixed(1),
      };
      results.push(r);
      console.log('[BENCH] ' + JSON.stringify(r));
    } catch (e) {
      anyFailed = true;
      console.log('[BENCH-FAILED] ' + name + ': ' + String(e).slice(0, 200));
    }
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
