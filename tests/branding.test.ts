/**
 * OFFICIAL NEXDROP BRANDING REGRESSION SUITE (Phase 2, 2026-10-15)
 * -------------------------------------------------------------------------
 * Purpose: the launcher icon and branding assets are BAKED into the APK at
 * build time. A web-asset swap can never fix a released binary, and a silent
 * reversion of a committed resource would ship the OLD icon again without
 * any test noticing. This suite fails the build when:
 *   - any Android launcher foreground is missing, has the wrong canvas size,
 *     or no longer matches the pinned official-artwork fingerprint
 *     (old-artwork detection);
 *   - the adaptive-icon background color resource is no longer the official
 *     artwork's white background;
 *   - the adaptive-icon XML / manifest icon references drift;
 *   - the in-app branding drawables (logo_mark, welcome_hero) change from
 *     the official artwork derivatives;
 *   - the PWA icon set (192/512/maskable-512/apple-touch/svg favicon) drifts;
 *   - the master artwork (public/nexdrop-logo-official.png) is not the
 *     supplied single source of truth.
 *
 * Geometry guarantee (validated when these files were generated, and pinned
 * here by hash): the launcher foreground content was scaled so its bounding
 * box DIAGONAL fits inside the 66/108 adaptive safe circle — no launcher
 * mask (circle, squircle, rounded square) can clip the mark.
 *
 * The launcher foreground uses the distinctive N-mark extracted from the
 * official artwork (approved launcher-specific simplification; the full
 * artwork with wordmark + PRIVATE. DIRECT. FAST. tagline ships on the web
 * and larger surfaces). Regenerate the pinned hashes ONLY after an
 * intentional, approved rebrand — never to silence a failure.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha256 = (p: string): string =>
  createHash('sha256').update(readFileSync(p)).digest('hex');

/** PNG IHDR dimensions (bytes 16..24), dependency-free. */
const pngSize = (p: string): { width: number; height: number } => {
  const b = readFileSync(p);
  assert.equal(b.length > 24, true, `${p}: truncated PNG`);
  assert.equal(b.readUInt32BE(12), 0x49484452, `${p}: missing IHDR`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

let passed = 0;
const ok = (name: string, cond: boolean) => {
  assert.equal(cond, true, `FAILED: ${name}`);
  passed++;
  console.log(`PASS  ${name}`);
};

// ---------------------------------------------------------------------------
// 1. Android adaptive launcher foregrounds (all densities)
// ---------------------------------------------------------------------------
const densities: [string, number, string][] = [
  ['mdpi', 108, 'bb47fb99fa3e41ac646537a95d318a14b751b2b4463de7834d3207dabcdede3b'],
  ['hdpi', 162, 'ca98efc87f19296156ecd7d4ca2696a682604d56481c15f69a3ab5e94697cc7c'],
  ['xhdpi', 216, '806d36e953d2999d0c0cbef2677ecb0bac0dd0cd2fd364a3c2695b1cf4753012'],
  ['xxhdpi', 324, 'c1a4fd6d15d7367e09a07d1a8ac8b0fbab5d8268799885e1e70f3af06eaa57bb'],
  ['xxxhdpi', 432, '9d3d1d1f7717b79fe2221211764789dd2e7190e7e9bf0bc25e674ebab60480f6'],
];
for (const [d, canvas, hash] of densities) {
  const p = `android/app/src/main/res/drawable-${d}/ic_launcher_foreground.png`;
  const { width, height } = pngSize(p);
  ok(`${d} foreground canvas is ${canvas}x${canvas}`, width === canvas && height === canvas);
  ok(`${d} foreground is the pinned official-artwork resource (old-icon detection)`, sha256(p) === hash);
}

// ---------------------------------------------------------------------------
// 2. Adaptive-icon wiring: XML references + background color
// ---------------------------------------------------------------------------
const adaptiveXml = readFileSync('android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml', 'utf8');
ok('adaptive icon references the foreground drawable', adaptiveXml.includes('@drawable/ic_launcher_foreground'));
ok('adaptive icon references the background color', adaptiveXml.includes('@color/ic_launcher_background'));

const colors = readFileSync('android/app/src/main/res/values/colors.xml', 'utf8');
ok(
  'launcher background color is the official artwork white (#FFFFFF)',
  /<color name="ic_launcher_background">#FFFFFF<\/color>/.test(colors)
);

const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
ok('manifest icon points at the adaptive mipmap', manifest.includes('android:icon="@mipmap/ic_launcher"'));
ok('manifest label is NexDrop', manifest.includes('android:label="NexDrop"'));

// ---------------------------------------------------------------------------
// 3. In-app branding drawables (official-artwork derivatives)
// ---------------------------------------------------------------------------
ok(
  'logo_mark.webp is the pinned official N-mark (in-app header + QR badge)',
  sha256('android/app/src/main/res/drawable-nodpi/logo_mark.webp') ===
    '5f21c03012683825e6773e78890e9b5cae0cd32866e2d12f81a993a288e76ac6'
);
ok(
  'welcome_hero.webp is the pinned full official artwork (welcome screen)',
  sha256('android/app/src/main/res/drawable-nodpi/welcome_hero.webp') ===
    '222c7135c2396929916ed9e9eba1ee7599762c627d6bf5ca0545dc8bbf2b8016'
);

// ---------------------------------------------------------------------------
// 4. PWA icon set + favicon
// ---------------------------------------------------------------------------
ok(
  'master artwork nexdrop-logo-official.png is the pinned single source of truth',
  sha256('public/nexdrop-logo-official.png') === '161879035dd679485aaf0bb630814089de7cd4399f4db76786ebe0c8849dd963'
);
const master = pngSize('public/nexdrop-logo-official.png');
ok('master artwork is the unmodified 1254x1254 official supply', master.width === 1254 && master.height === 1254);

ok('icon-192.png is 192x192 (pinned)', pngSize('public/icons/icon-192.png').width === 192 &&
  sha256('public/icons/icon-192.png') === '3fbc73385dc6495e9f77d91f89f9c703cc9e21f0d33c2d3767e9ede2e36444c0');
ok('icon-512.png is 512x512 (pinned)', pngSize('public/icons/icon-512.png').width === 512 &&
  sha256('public/icons/icon-512.png') === '3404a12b86e99eed41d853df87d3ba7ea83057428567d450acbf7932f5f41208');
ok(
  'icon-maskable-512.png is 512x512 with the safe-circle mark fit (pinned)',
  pngSize('public/icons/icon-maskable-512.png').width === 512 &&
    sha256('public/icons/icon-maskable-512.png') === '45eb53cafd9f0044c47094f86324bddf3a92fbd70a695ef04b81c90860b4ade3'
);
ok('apple-touch-icon.png is 180x180 (pinned)', pngSize('public/apple-touch-icon.png').width === 180 &&
  sha256('public/apple-touch-icon.png') === '0679eeb87efdc71f9c158a77492f27d5f1d8b55e65470fb152613a3ce48e73b3');

const favicon = readFileSync('public/icons/icon.svg', 'utf8');
ok('favicon SVG embeds the official mark raster (never a redrawn vector)', favicon.includes('data:image/png;base64,'));
ok('favicon SVG carries no external asset reference', !/xlink:href="[^d]/.test(favicon));

// ---------------------------------------------------------------------------
// 5. Package identity + versioning policy (identity preserved, version bumped)
// ---------------------------------------------------------------------------
const gradle = readFileSync('android/app/build.gradle.kts', 'utf8');
ok('applicationId preserved (com.nexdrop.ndt1)', gradle.includes('applicationId = "com.nexdrop.ndt1"'));
const vc = Number(/versionCode = (\d+)/.exec(gradle)?.[1] ?? '0');
ok('versionCode advanced past the 1.4.4 release (17)', vc >= 18);
const vn = /versionName = "([^"]+)"/.exec(gradle)?.[1];
ok('versionName present and past 1.4.4', !!vn && vn !== '1.4.4');

console.log(`\n[branding] ${passed} checks passed`);
