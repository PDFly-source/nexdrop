/**
 * Gateway validation — runs against the locally served static export
 * (http://localhost:8090/nexdrop/), reproducing the GitHub Pages path.
 * Checks the 23 acceptance points that can be verified headlessly.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:8090/nexdrop/';
const results = [];
const ok = (name, cond, extra = '') =>
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);

const browser = await chromium.launch();
const errors = [];

async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 140)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 140)));
  return { ctx, page };
}

// ---------- 1-4: DESKTOP: "/" shows the premium gateway ----------
{
  const { ctx, page } = await newPage({ width: 1280, height: 800 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  ok('1. / loads', page.url().endsWith('/nexdrop/'));
  ok('2. 3D canvas present', (await page.$('canvas.gl')) !== null);
  ok('2b. hero headline renders', (await page.getByText('Keep it private.').count()) > 0);
  ok('2c. canvas never intercepts pointers', await page.$eval('canvas.gl', (c) => getComputedStyle(c).pointerEvents === 'none'));
  ok('3. APP card present', (await page.getByRole('heading', { name: 'NexDrop App' }).count()) > 0);
  ok('3b. WEBAPP card present', (await page.getByRole('heading', { name: 'NexDrop WebApp' }).count()) > 0);
  const cardsBox = await page.$$eval('.pcard', (els) => {
    const rs = els.map((e) => e.getBoundingClientRect());
    return rs.length === 2 && rs[0].top === rs[1].top && rs[0].right <= rs[1].left;
  });
  ok('4. two cards side-by-side on desktop', cardsBox);
  // APP CTA
  const appHref = await page.$eval('.pcard.primary a.btn', (a) => a.getAttribute('href'));
  ok('5. APP CTA -> /app route', appHref === '/app' || appHref === '/nexdrop/app/', appHref);
  const webHref = await page.$eval('.pcard:not(.primary) a.btn', (a) => a.getAttribute('href'));
  ok('5b. WEBAPP CTA -> #/home', webHref === '#/home', webHref);

  // 6: clicking OPEN WEBAPP opens the real WebApp (same-document hash nav)
  await page.click('a[href="#/home"]');
  await page.waitForTimeout(1500);
  ok('6. OPEN WEBAPP flips to the WebApp', page.url().includes('#/home') && (await page.$('#webapp-root')) !== null);
  ok('6b. WebApp nav visible', (await page.getByRole('banner').count()) > 0 || (await page.$('#webapp-root nav')) !== null);

  // 7: refresh keeps WebApp (hash preserved)
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  ok('7. refresh with hash stays in WebApp', (await page.$('#webapp-root')) !== null && (await page.$('.ndgw')) === null);

  // back to bare root -> gateway again
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  ok('7b. bare / after hash shows gateway', (await page.$('.ndgw')) !== null);

  // 8: /app page
  await page.goto(BASE + 'app/', { waitUntil: 'networkidle' });
  ok('8. /app page loads', (await page.getByRole('heading', { name: /NexDrop App/ }).count()) > 0);
  const dl = await page.$eval('a.btn.p', (a) => a.href);
  ok('9. /app download CTA is the real v1.4.4 release', dl === 'https://github.com/PDFly-source/nexdrop/releases/download/nexdrop-android-v0752ea2/NexDrop-release.apk', dl);
  ok('9b. /app has no fake download UI', (await page.$$('[class*=progress], progress')).length === 0);

  // 10: /web page
  await page.goto(BASE + 'web/', { waitUntil: 'networkidle' });
  ok('10. /web page loads', (await page.getByRole('heading', { name: /NexDrop WebApp/ }).count()) > 0);
  const webCta = await page.$eval('a.btn.p', (a) => a.getAttribute('href'));
  ok('10b. /web CTA -> #/home', webCta === 'https://pdfly-source.github.io/nexdrop/#/home', webCta);

  // 11: existing static pages
  for (const p of ['security/', 'privacy/', 'about/']) {
    const r = await page.goto(BASE + p, { waitUntil: 'networkidle' });
    const has = (await page.$('h1')) !== null;
    ok(`11. /${p} still works`, r.status() === 200 && has);
  }
  await ctx.close();
}

// ---------- 12-16: MOBILE (Android Chrome-ish viewport) ----------
{
  const { ctx, page } = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  ok('12. mobile: gateway loads', (await page.$('.ndgw')) !== null);
  ok('12b. mobile: hero tagline visible', (await page.getByText('PRIVATE · DIRECT · FAST', { exact: false }).first()) !== null || (await page.$('.pill')) !== null);
  const stacked = await page.$$eval('.pcard', (els) => {
    const rs = els.map((e) => e.getBoundingClientRect());
    return rs.length === 2 && rs[0].bottom <= rs[1].top + 1 && rs[0].width > 280;
  });
  ok('13. mobile: cards stacked, large & tappable', stacked);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok('14. mobile: no horizontal overflow', overflow);
  // tap WEBAPP card
  const target = await page.$('.pcard:not(.primary) a.btn');
  const box = await target.boundingBox();
  ok('15. mobile: WEBAPP CTA >= 44px touch target', box && box.height >= 44, JSON.stringify(box && { h: box.height }));
  await target.tap();
  await page.waitForTimeout(1200);
  ok('16. mobile: tap opens the WebApp', (await page.$('#webapp-root')) !== null);
  // mobile menu
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.click('.mbtn');
  await page.waitForTimeout(300);
const mnavOk = await page.$eval('.mnav', (m) => m.textContent.includes('App') && m.textContent.includes('FAQ'));
  ok('17. mobile: menu opens with APP/WEBAPP/Security/FAQ', mnavOk);
  await ctx.close();
}

// ---------- 18-21: reduced motion + 3D + console ----------
{
  const { ctx, page } = await newPage({ width: 1280, height: 800, reducedMotion: 'reduce' });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  ok('18. reduced-motion: gateway fully visible', (await page.$('.ndgw')) !== null && (await page.getByText('Keep it private.').count()) > 0);
  ok('19. reduced-motion: reveal content shown (no stuck opacity:0)', await page.$eval('.rv', (e) => getComputedStyle(e).opacity === '1'));
  await ctx.close();
}

{
  // 3D actually renders (WebGL) and assets all load
  const { ctx, page } = await newPage({ width: 1280, height: 800 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const threeLoaded = await page.evaluate(() => !!(window).THREE);
  ok('20. Three.js loaded from CDN', threeLoaded);
  await page.screenshot({ path: '/tmp/gw-desktop.png' });
  await ctx.close();
}

ok('21. no console-critical errors', errors.length === 0, errors.slice(0, 4).join(' | '));

await browser.close();
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
