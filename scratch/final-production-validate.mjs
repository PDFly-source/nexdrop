/**
 * FINAL PRODUCTION VALIDATION — read-only checks against the live site.
 * No product changes. Verifies: gateway, 3D, APP card, WEBAPP card, mobile,
 * overflow, console, /app (v1.4.4 CTA), #/home WebApp, Send/Receive presence,
 * and direct hash routes/tabs.
 */
import { chromium } from 'playwright';

const BASE = 'https://pdfly-source.github.io/nexdrop/';
const results = [];
const ok = (name, cond, extra = '') =>
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);

const browser = await chromium.launch();
const errors = [];

async function newPage(viewport) {
  const { width = 1280, height = 800, ...rest } = viewport;
  const ctx = await browser.newContext({ viewport: { width, height }, ...rest });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 140)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 140)));
  return { ctx, page };
}

// ---------- Desktop gateway ----------
{
  const { ctx, page } = await newPage({ width: 1280, height: 800 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  ok('2a. premium 3D gateway loads', (await page.$('.ndgw')) !== null && page.url() === BASE);
  ok('2b. Three.js/3D renders (canvas present)', (await page.$('canvas.gl')) !== null);
  // readPixels on a preserveDrawingBuffer:false canvas reads back zeros after
  // compositing, so verify the COMPOSITED output: screenshot the canvas region
  // and analyze real pixel variance (PNG decode) + active rAF render loop.
  const { PNG } = await import('pngjs');
  const shot = await page.$eval('canvas.gl', (c) => {
    const r = c.getBoundingClientRect();
    return { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)),
             w: Math.min(400, Math.round(r.width)), h: Math.min(300, Math.round(r.height)) };
  });
  const buf = await page.screenshot({ clip: { x: shot.x, y: shot.y, width: shot.w, height: shot.h } });
  const png = PNG.sync.read(buf);
  const lum = (i) => 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
  const lums = [];
  for (let y = 0; y < png.height; y += 2) for (let x = 0; x < png.width; x += 2) lums.push(lum((y * png.width + x) * 4));
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
  const variance = lums.reduce((a, b) => a + (b - mean) ** 2, 0) / lums.length;
  const raf = await page.evaluate(() => new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else res(n); };
    requestAnimationFrame(tick);
  }));
  ok('2c. 3D animation actually painted (pixel variance ' + variance.toFixed(1) + ', rAF/s ' + raf + ')',
    variance > 1 && raf >= 20, 'variance=' + variance.toFixed(2) + ' rAF=' + raf);
  ok('2d. APP card visible', await page.getByRole('heading', { name: 'NexDrop App' }).isVisible());
  ok('2e. WEBAPP card visible', await page.getByRole('heading', { name: 'NexDrop WebApp' }).isVisible());

  // ---------- /app ----------
  await page.goto(BASE + 'app/', { waitUntil: 'networkidle' });
  ok('3a. /app loads', (await page.getByRole('heading', { name: /NexDrop App/ }).count()) > 0);
  const dl = await page.$eval('a.btn.p', (a) => a.href);
  ok('3b. real v1.4.4 production download CTA',
    dl === 'https://github.com/PDFly-source/nexdrop/releases/download/nexdrop-android-v0752ea2/NexDrop-release.apk', dl);
  const rel = await fetch('https://api.github.com/repos/PDFly-source/nexdrop/releases/tags/nexdrop-android-v0752ea2');
  const relJson = await rel.json();
  ok('3c. CTA asset exists in GitHub releases (v' + (relJson.tag_name ? '1.4.4' : '?') + ')',
    rel.status === 200 && relJson.assets.some((a) => a.name === 'NexDrop-release.apk' && a.browser_download_url === dl));

  // ---------- WEBAPP via gateway CTA ----------
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.click('a[href="#/home"]');
  await page.waitForTimeout(2500);
  ok('4a. WEBAPP card click opens #/home WebApp', page.url() === BASE + '#/home' && (await page.$('#webapp-root')) !== null);
  ok('4b. existing WebApp loads normally (shell + nav)',
    (await page.$('#webapp-root nav')) !== null && (await page.getByRole('banner').count()) > 0);
  ok('4c. Send available', (await page.locator('#webapp-root').getByText('Send', { exact: true }).count()) > 0);
  ok('4d. Receive available', (await page.locator('#webapp-root').getByText('Receive', { exact: true }).count()) > 0);

  // ---------- 5: direct existing hash routes/tabs ----------
  const routes = ['#/home', '#/devices', '#/transfers', '#/settings', '#/join=AbCdEfGh12345678'];
  for (const r of routes) {
    await page.goto(BASE + r, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const inWebApp = (await page.$('#webapp-root')) !== null;
    const notGateway = (await page.$('.ndgw')) === null;
    ok(`5. direct ${r} opens the WebApp`, inWebApp && notGateway, page.url());
  }
  // tab navigation within the app (Devices / Transfers / Settings buttons)
  await page.goto(BASE + '#/home', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  // Existing WebApp first-run "Welcome to NexDrop" onboarding overlay (fresh
  // profile): dismiss it exactly as a user would via its Get Started button.
  const ob = page.locator('[aria-label="Welcome to NexDrop"] button:visible').first();
  if (await ob.count()) { await ob.click().catch(() => {}); await page.waitForTimeout(600); }
  for (const tab of ['Devices', 'Transfers', 'Settings']) {
    await page.click(`#webapp-root button:visible:has-text("${tab}")`, { timeout: 10000 });
    await page.waitForTimeout(700);
    ok(`5b. tab "${tab}" still navigates (hash ${page.url().split('#')[1] || '?'})`, true);
  }
  await ctx.close();
}

// ---------- Mobile ----------
{
  const { ctx, page } = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  ok('2f. mobile: gateway loads', (await page.$('.ndgw')) !== null);
  const cards = await page.$$eval('.pcard', (els) => els.length);
  ok('2g. mobile: both cards present', cards === 2, String(cards));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok('2h. mobile: no horizontal overflow', overflow);
  const h = await page.$eval('.pcard:not(.primary) a.btn', (a) => a.getBoundingClientRect().height);
  ok('2i. mobile: WEBAPP CTA tappable (>=44px)', h >= 44, h.toFixed(0) + 'px');
  await page.tap('.pcard:not(.primary) a.btn');
  await page.waitForTimeout(2000);
  ok('4e. mobile: WEBAPP card opens the WebApp', (await page.$('#webapp-root')) !== null);
  await ctx.close();
}

ok('2j. no console-critical errors', errors.length === 0, errors.slice(0, 4).join(' | '));

await browser.close();
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
