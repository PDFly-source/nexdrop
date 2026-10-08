/**
 * FOOTER-ONLY VALIDATION — verifies the new NexDrop signature footers and
 * confirms zero functional regression (WebApp opens, Send/Receive present,
 * routes unchanged, gateway intact, CTAs work, no overflow, clean console).
 * Runs against a local static export server on :4173.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:4174/nexdrop/';
const results = [];
const ok = (name, cond, extra = '') =>
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);

const browser = await chromium.launch();
const errors = [];

async function newPage(opts) {
  const { width = 1280, height = 800, ...rest } = opts || {};
  const ctx = await browser.newContext({ viewport: { width, height }, ...rest });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 140)); });
  page.on('requestfailed', (r) => errors.push('reqfail: ' + r.url().slice(0, 120)));
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 140)));
  return { ctx, page };
}

const SIG = ['NexDrop', 'Crafted & Developed by PKD', '© 2026 NexDrop. All rights reserved.', 'Private · Direct · Fast'];
const LINKS = ['Security', 'Privacy', 'About', 'App', 'WebApp'];

async function checkFooter(page, label) {
  const foot = page.locator('footer').last();
  const text = (await foot.textContent()) || '';
  for (const t of SIG) ok(`${label}: shows "${t}"`, text.includes(t));
  for (const l of LINKS) ok(`${label}: link "${l}" present`, await foot.getByRole('link', { name: l, exact: true }).count() > 0);
  const generic = ['Local-First Utilities', 'Zero telemetry, zero tracking', 'Powered by WebRTC & Web Crypto API'];
  for (const g of generic) ok(`${label}: generic wording "${g}" removed`, !text.includes(g));
  // all footer links resolve to real internal routes or the repo
  const hrefs = await page.$$eval('footer a:last-of-type, footer a', (as) => Array.from(new Set(as.map((a) => a.getAttribute('href')))));
  ok(`${label}: links target real destinations only`, hrefs.every((h) =>
    /^(#\/home|\/(nexdrop\/)?(security|privacy|about|app)\/?|https:\/\/github\.com\/PDFly-source\/nexdrop)/.test(h)), hrefs.join(', '));
  // footer inside viewport width (no overflow), not gigantic
  const m = await foot.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, height: r.height, w: innerWidth };
  });
  ok(`${label}: no horizontal overflow`, m.left >= 0 && m.right <= m.w + 1, `right=${m.right.toFixed(0)} vw=${m.w}`);
  ok(`${label}: footer height modest (<320px)`, m.height < 320, m.height.toFixed(0) + 'px');
}

// ---------- Gateway (desktop) ----------
{
  const { ctx, page } = await newPage({});
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  ok('6. 3D Gateway opens normally', (await page.$('.ndgw')) !== null);
  await checkFooter(page, 'gateway');
  await page.click('a[href$="/app/"]');
  await page.waitForTimeout(800);
  ok('7. APP CTA works', /\/app\/\.?$/.test(page.url()), page.url());
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.click('a[href="#/home"]');
  await page.waitForTimeout(2000);
  ok('8. WEBAPP CTA works', (await page.$('#webapp-root')) !== null);
  await ctx.close();
}

// ---------- WebApp (desktop) ----------
{
  const { ctx, page } = await newPage({});
  await page.goto(BASE + '#/home', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const ob = page.locator('[aria-label="Welcome to NexDrop"] button:visible').first();
  if (await ob.count()) { await ob.click().catch(() => {}); await page.waitForTimeout(600); }
  ok('1. WebApp opens normally', (await page.$('#webapp-root')) !== null);
  ok('2. Send available', (await page.locator('#webapp-root').getByText('Send', { exact: true }).count()) > 0);
  ok('3. Receive available', (await page.locator('#webapp-root').getByText('Receive', { exact: true }).count()) > 0);
  await checkFooter(page, 'webapp');
  // footer links from inside the WebApp resolve to real pages
  for (const r of ['security', 'privacy', 'about', 'app']) {
    const resp = await page.request.get(BASE + r + '/');
    ok(`footer link /${r} resolves (HTTP ${resp.status()})`, resp.status() === 200);
  }
  // 5. hash routes unchanged
  for (const r of ['#/home', '#/devices', '#/transfers', '#/settings', '#/join=AbCdEfGh12345678']) {
    await page.goto(BASE + r, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    ok(`route ${r} unchanged`, (await page.$('#webapp-root')) !== null);
  }
  await ctx.close();
}

// ---------- Mobile ----------
for (const surface of ['gateway', 'webapp']) {
  const { ctx, page } = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(surface === 'gateway' ? BASE : BASE + '#/home', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  if (surface === 'webapp') {
    const ob = page.locator('[aria-label="Welcome to NexDrop"] button:visible').first();
    if (await ob.count()) { await ob.click().catch(() => {}); await page.waitForTimeout(500); }
  }
  await checkFooter(page, `mobile ${surface}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  ok(`mobile ${surface}: no horizontal overflow`, overflow);
  await page.screenshot({ path: `/tmp/footer-${surface}.png`, fullPage: false });
  await ctx.close();
}

ok('12. no console-critical errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
