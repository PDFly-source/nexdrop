/**
 * OFFICIAL NEXDROP BRANDING REGRESSION SUITE (Phase 2.1, 2026-10-16)
 * -------------------------------------------------------------------------
 * Purpose: the launcher icon and branding assets are BAKED into the APK at
 * build time. A web-asset swap can never fix a released binary, and a silent
 * reversion of a committed resource would ship the OLD icon again without
 * any test noticing. This suite fails the build when:
 *   - any Android launcher foreground is missing, has the wrong canvas size,
 *     or no longer matches the pinned official-artwork fingerprint
 *     (old-artwork detection);
 *   - the launcher foreground no longer carries the COMPLETE official
 *     artwork — the content aspect ratio must match the full master's
 *     symbol + wordmark + tagline composition (963 x 847, ratio ~0.88).
 *     A symbol-only foreground (the rejected Phase 2 N-mark, ratio ~0.63)
 *     cannot pass this check (Phase 2.1 acceptance criterion);
 *   - the content bounding box leaves the 66/108 adaptive safe circle,
 *     or drifts off-center (mask clipping / cropping detection);
 *   - the adaptive-icon background color resource is no longer the official
 *     artwork's white background;
 *   - the adaptive-icon XML / manifest icon references drift;
 *   - the in-app branding drawables (logo_mark, welcome_hero) change from
 *     the official artwork derivatives;
 *   - the PWA icon set (192/512/maskable-512/apple-touch/svg favicon) drifts
 *     from the complete official artwork;
 *   - the master artwork (public/nexdrop-logo-official.png) is not the
 *     supplied single source of truth.
 *
 * Geometry is verified against DECODED PIXELS (dependency-free PNG reader),
 * not just pinned hashes. Regenerate the pinned hashes ONLY after an
 * intentional, approved rebrand — never to silence a failure.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const sha256 = (p: string): string =>
  createHash('sha256').update(readFileSync(p)).digest('hex');

/** PNG IHDR dimensions (bytes 16..24), dependency-free. */
const pngSize = (p: string): { width: number; height: number } => {
  const b = readFileSync(p);
  assert.equal(b.length > 24, true, `${p}: truncated PNG`);
  assert.equal(b.readUInt32BE(12), 0x49484452, `${p}: missing IHDR`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

/**
 * Minimal dependency-free PNG decoder for 8-bit RGB (color type 2) or RGBA
 * (color type 6), non-interlaced. Returns rows of [R,G,B,A] samples so the
 * suite can measure the real content bounding box of a committed resource.
 */
const decodePng = (p: string): { width: number; height: number; rgba: Buffer } => {
  const b = readFileSync(p);
  assert.equal(b.readUInt32BE(12), 0x49484452, `${p}: missing IHDR`);
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const depth = b[24];
  const colorType = b[25];
  assert.equal(depth, 8, `${p}: expected 8-bit PNG`);
  assert.ok(colorType === 2 || colorType === 6, `${p}: expected RGB(A) PNG`);
  const bpp = colorType === 6 ? 4 : 3;
  // concatenate IDAT chunks
  const chunks: Buffer[] = [];
  let off = 8;
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') chunks.push(b.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  const prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const row = raw.subarray(rp, rp + stride);
    rp += stride;
    const dst = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? dst[x - bpp] : 0;
      const bb = y > 0 ? prev[x] : 0;
      const c = x >= bpp && y > 0 ? prev[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + bb) & 0xff;
      else if (filter === 3) v = (v + ((a + bb) >> 1)) & 0xff;
      else if (filter === 4) {
        const pp = a + bb - c;
        const pa = Math.abs(pp - a), pbb = Math.abs(pp - bb), pc = Math.abs(pp - c);
        v = (v + (pa <= pbb && pa <= pc ? a : pbb <= pc ? bb : c)) & 0xff;
      }
      dst[x] = v;
    }
    dst.copy(prev);
    // careful: prev must hold THIS row for the next iteration
    dst.copy(prev, 0, 0, stride);
  }
  return { width, height, rgba: out };
};

/** Content bounding box of non-background pixels (background = white). */
const contentBbox = (img: { width: number; height: number; rgba: Buffer }, bpp: 3 | 4 = 3) => {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * bpp;
      const r = img.rgba[i], g = img.rgba[i + 1], bb = img.rgba[i + 2];
      const alpha = bpp === 4 ? img.rgba[i + 3] : 255;
      const isBg = alpha < 10 || (r >= 245 && g >= 245 && bb >= 245);
      if (!isBg) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  assert.ok(maxX >= 0, 'no content found in image');
  return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
};

let passed = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  assert.equal(cond, true, `FAILED: ${name}${detail ? ` — ${detail}` : ''}`);
  passed++;
  console.log(`PASS  ${name}`);
};

// ---------------------------------------------------------------------------
// 0. Master artwork — the supplied single source of truth
// ---------------------------------------------------------------------------
const MASTER = 'public/nexdrop-logo-official.png';
const MASTER_SHA = '161879035dd679485aaf0bb630814089de7cd4399f4db76786ebe0c8849dd963';
ok('master artwork is byte-identical to the supplied official logo', sha256(MASTER) === MASTER_SHA);
{
  const m = pngSize(MASTER);
  ok('master artwork is the full 1254x1254 master', m.width === 1254 && m.height === 1254);
}

// ---------------------------------------------------------------------------
// 1. Android adaptive launcher foregrounds (all densities)
//    Phase 2.1: the foreground carries the COMPLETE artwork (symbol +
//    wordmark + tagline). Content aspect must match the master's full
//    composition; the rejected symbol-only N-mark cannot pass.
// ---------------------------------------------------------------------------
const densities: [string, number, string][] = [
  ['mdpi', 108, '54e460239efd2a5352fc0613c970abf28f881cf245adc0f2ffc856bbc65907dd'],
  ['hdpi', 162, 'f64a1254755b8c09fc7384c71ff9120e2dc3433afbf4f3fc3e6323021d26305f'],
  ['xhdpi', 216, '7a463c7953dc4915d61dffddcb66395e02935f856f60a2d29eda899659690660'],
  ['xxhdpi', 324, 'c1e10cb04d1673ca9282ed3a5ffd90007391e3acffe9130359fded14b5c604b4'],
  ['xxxhdpi', 432, 'caa7221c054d5738a104905ff7d5a5b2b7e181d6461187fb88589225eb577ba0'],
];

for (const [d, canvas, expected] of densities) {
  const p = `android/app/src/main/res/drawable-${d}/ic_launcher_foreground.png`;
  ok(`[${d}] foreground present with official-artwork fingerprint`, sha256(p) === expected);
  const size = pngSize(p);
  ok(`[${d}] foreground canvas is ${canvas}x${canvas}`, size.width === canvas && size.height === canvas);
  const img = decodePng(p);
  const bb = contentBbox(img, 3);
  // FULL composition aspect: master content is 963x847 -> h/w ~ 0.8796.
  // The rejected symbol-only foreground was 963x611 -> h/w ~ 0.634.
  const ratio = bb.h / bb.w;
  ok(
    `[${d}] foreground carries the COMPLETE artwork (aspect ${ratio.toFixed(3)} in full-composition range)`,
    ratio > 0.84 && ratio < 0.92,
    `wordmark/tagline missing? content ${bb.w}x${bb.h}`,
  );
  const safeRadius = (canvas * (66 / 108)) / 2;
  const cx = canvas / 2, cy = canvas / 2;
  const far = Math.hypot(Math.max(bb.maxX - cx, cx - bb.minX), Math.max(bb.maxY - cy, cy - bb.minY));
  ok(
    `[${d}] content corners (${far.toFixed(1)}px) inside safe circle (${safeRadius.toFixed(1)}px, +1px raster tolerance)`,
    far <= safeRadius + 1,
  );
  const offX = Math.abs((bb.minX + bb.maxX) / 2 - cx);
  const offY = Math.abs((bb.minY + bb.maxY) / 2 - cy);
  ok(`[${d}] content centered (dx ${offX.toFixed(1)}, dy ${offY.toFixed(1)})`, offX <= 2 && offY <= 2);
}

// ---------------------------------------------------------------------------
// 2. Adaptive icon wiring + background color
// ---------------------------------------------------------------------------
const adaptive = readFileSync('android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml', 'utf8');
ok('adaptive icon references the foreground drawable', adaptive.includes('@drawable/ic_launcher_foreground'));
ok('adaptive icon references the background color', adaptive.includes('@color/ic_launcher_background'));

const colors = readFileSync('android/app/src/main/res/values/colors.xml', 'utf8');
ok(
  'launcher background is the artwork white (#FFFFFF)',
  /ic_launcher_background[^<]*#FFFFFF/.test(colors),
);

const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
ok('manifest icon is @mipmap/ic_launcher', manifest.includes('android:icon="@mipmap/ic_launcher"'));
ok('manifest label is NexDrop', manifest.includes('android:label="NexDrop"'));

// ---------------------------------------------------------------------------
// 3. In-app branding drawables (official artwork derivatives)
// ---------------------------------------------------------------------------
ok(
  'in-app header mark is the official N-mark derivative',
  sha256('android/app/src/main/res/drawable-nodpi/logo_mark.webp') ===
    '5f21c03012683825e6773e78890e9b5cae0cd32866e2d12f81a993a288e76ac6',
);
ok(
  'welcome hero carries the complete official artwork',
  sha256('android/app/src/main/res/drawable-nodpi/welcome_hero.webp') ===
    '222c7135c2396929916ed9e9eba1ee7599762c627d6bf5ca0545dc8bbf2b8016',
);

// ---------------------------------------------------------------------------
// 4. PWA icon set — complete artwork everywhere
// ---------------------------------------------------------------------------
ok('PWA icon-192 is the complete artwork', sha256('public/icons/icon-192.png') ===
  '071f8c181be48c335c1eb984bfc457f9a8104a0fcbfdd5411515ce3e28a45fae');
ok('PWA icon-512 is the complete artwork', sha256('public/icons/icon-512.png') ===
  'a1dee09c9cd656bf7d3532dc8fd7bfd0c9bca0f8a24c68ce1de3cdbb891624f0');
ok('apple-touch-icon is the complete artwork', sha256('public/apple-touch-icon.png') ===
  '19800a65b0db4dde542e745973c7859bd580eb72ad29d8aba5d14084fc44872c');
{
  const p = 'public/icons/icon-maskable-512.png';
  ok('maskable-512 fingerprint', sha256(p) ===
    '8812534362006d9cafb4a76ae89387d926c3c02320630512a886f5ebb6d2a40e');
  const size = pngSize(p);
  ok('maskable-512 canvas', size.width === 512 && size.height === 512);
  const img = decodePng(p);
  const bb = contentBbox(img, 3);
  const ratio = bb.h / bb.w;
  ok(`maskable carries the COMPLETE artwork (aspect ${ratio.toFixed(3)})`, ratio > 0.84 && ratio < 0.92);
  const safeRadius = (512 * (66 / 108)) / 2;
  const far = Math.hypot(Math.max(bb.maxX - 256, 256 - bb.minX), Math.max(bb.maxY - 256, 256 - bb.minY));
  ok(`maskable content corners (${far.toFixed(1)}px) inside safe circle (${safeRadius.toFixed(1)}px, +1px raster tolerance)`, far <= safeRadius + 1);
}
{
  const svg = readFileSync('public/icons/icon.svg', 'utf8');
  ok('favicon embeds the official artwork raster (no redrawn vector)',
    svg.includes('data:image/png;base64,') && !/\.\/|https?:\/\/[^"']+\.png/.test(svg));
  ok('favicon fingerprint', sha256('public/icons/icon.svg') ===
    'a28201cb6b100bcb71463098516845bdcdc7c7ebf2b74d07f4a216f4d8bc9fa2');
}

// ---------------------------------------------------------------------------
// 5. Package identity + version policy
// ---------------------------------------------------------------------------
const gradle = readFileSync('android/app/build.gradle.kts', 'utf8');
ok('applicationId unchanged (com.nexdrop.ndt1)', gradle.includes('applicationId = "com.nexdrop.ndt1"'));
const vc = /versionCode = (\d+)/.exec(gradle);
ok('versionCode >= 19 (1.4.6 release line)', vc !== null && parseInt(vc[1], 10) >= 19);
const vn = /versionName = "([^"]+)"/.exec(gradle);
ok('versionName present and past 1.4.5', vn !== null && vn[1] > '1.4.5');

console.log(`\n[branding] ${passed} checks passed`);
