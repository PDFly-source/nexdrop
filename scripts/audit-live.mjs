import { chromium } from 'playwright';
import { createRequire } from 'node:module';

const axe = createRequire(import.meta.url)('axe-core');
const BASE = 'https://pdfly-source.github.io/nexdrop/';

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 });

const swReg = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? (reg.active ? 'active:' + reg.active.state : 'registering') : 'none';
});

const manifest = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  if (!link) return null;
  try { return await (await fetch(link.href)).json(); } catch { return 'fetch-failed'; }
});

await page.addScriptTag({ content: axe.source });
const axeResults = await page.evaluate(async () => {
  const r = await window.axe.run(document, {
    resultTypes: ['violations'],
    tags: { exclude: ['best-practice'] },
  });
  return {
    violations: r.violations.map(v => ({
      id: v.id, impact: v.impact, nodes: v.nodes.length,
      help: v.help || '',
      firstNode: v.nodes[0] ? v.nodes[0].target.join(',').slice(0, 80) : '',
    })),
    passes: r.passes.length,
    incomplete: r.incomplete.length,
  };
});

const frontMatter = await page.evaluate(() => {
  const m = s => document.querySelector(s) ? document.querySelector(s).getAttribute('content') : null;
  return {
    title: document.title,
    lang: document.documentElement.lang,
    viewport: m('meta[name="viewport"]'),
    description: m('meta[name="description"]'),
    theme: m('meta[name="theme-color"]'),
    appleIcon: !!document.querySelector('link[rel="apple-touch-icon"]'),
    favicon: !!document.querySelector('link[rel="icon"]'),
    httpsOK: location.protocol === 'https:',
    skipLink: !!document.querySelector('a[href="#main"],a[role="skip"],a.skip'),
    mainLandmark: !!document.querySelector('main,[role="main"]'),
    h1: document.querySelector('h1') ? document.querySelector('h1').textContent.trim().slice(0, 60) : null,
  };
});

const swContent = await (await fetch(BASE + 'sw.js')).text();
const precacheMatches = swContent.match(/["'][^"']*\.(?:html|js|css|json|svg|png|webmanifest|woff2?)["']/g) ?? [];

// icon integrity: fetch each declared manifest icon and verify it decodes
const iconChecks = [];
for (const icon of (manifest && Array.isArray(manifest.icons)) ? manifest.icons : []) {
  const url = new URL(icon.src, BASE).href;
  try {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const isPng = new DataView(buf).getUint32(0, false) === 0x89504e47;
    iconChecks.push({ src: icon.src, sizes: icon.sizes, purpose: icon.purpose || '', http: res.status, bytes: buf.byteLength, png: isPng });
  } catch (e) {
    iconChecks.push({ src: icon.src, sizes: icon.sizes, error: String(e).slice(0, 80) });
  }
}

console.log(JSON.stringify({
  swReg, manifest, frontMatter,
  swBytes: swContent.length,
  swPrecacheEntries: precacheMatches.length,
  iconChecks, axe: axeResults, consoleErrors: errors.slice(0, 5),
}, null, 1));
await browser.close();
