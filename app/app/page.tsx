

/**
 * NexDrop App — native Android product page (/app).
 *
 * Public information page only. The download CTA points at the REAL
 * official production release on GitHub (NexDrop v1.4.4, code 17).
 * Nothing on this page touches the transfer engines.
 */

import React from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';

/* Official, verified production release (v1.4.4 · code 17 · tag nexdrop-android-v0752ea2). */
const RELEASE_URL =
  'https://github.com/PDFly-source/nexdrop/releases/download/nexdrop-android-v0752ea2/NexDrop-release.apk';
const RELEASE_PAGE_URL =
  'https://github.com/PDFly-source/nexdrop/releases/tag/nexdrop-android-v0752ea2';
const WEBAPP_URL = 'https://pdfly-source.github.io/nexdrop/#/home';

export const metadata: Metadata = {
  title: 'NexDrop App — Native Android',
  description:
    'NexDrop for Android: private, direct, fast P2P transfer with the native NDT1 TCP transport, large-file streaming, queue, pause/resume, recovery and SHA-256 verification.',
};

const PAGE_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500&display=swap');
.ndap{--bg:#070B0C;--fg:#EAF4F2;--mute:#8FA5A1;--acc:#2EF2C4;--acc2:#3B9BFF;--glass:rgba(255,255,255,.05);--line:rgba(255,255,255,.1);
  min-height:100vh;background:var(--bg);color:var(--fg);font-family:Inter,system-ui,sans-serif;line-height:1.6;overflow-x:hidden;position:relative}
.ndap *{box-sizing:border-box;margin:0}
.ndap::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;background:radial-gradient(600px 400px at 15% 20%,rgba(46,242,196,.13),transparent 70%),radial-gradient(700px 500px at 85% 70%,rgba(59,155,255,.13),transparent 70%)}
.ndap h1,.ndap h2,.ndap h3,.ndap .logo{font-family:'Space Grotesk',Inter,system-ui,sans-serif;letter-spacing:-.02em}
.ndap :focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:6px}
.ndap header{position:relative;z-index:5;border-bottom:1px solid var(--line);background:rgba(7,11,12,.6);backdrop-filter:blur(14px);padding:14px 6vw;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.ndap .logo{font-weight:700;font-size:1.15rem;color:var(--fg);text-decoration:none;white-space:nowrap}
.ndap .logo b{color:var(--acc)}
.ndap header nav{display:flex;gap:20px;flex-wrap:wrap}
.ndap header a{color:var(--mute);text-decoration:none;font-size:.9rem;transition:.3s}
.ndap header a:hover{color:var(--fg)}
.ndap main{position:relative;z-index:5;max-width:1000px;margin:auto;padding:70px 6vw 90px}
.ndap .tag{color:var(--acc);font-size:.78rem;letter-spacing:.25em;text-transform:uppercase;margin-bottom:18px}
.ndap h1{font-size:clamp(2.2rem,7vw,4.2rem);line-height:1.05;font-weight:700;letter-spacing:-.03em}
.ndap h1 span,.ndap h2 span{background:linear-gradient(120deg,var(--acc),var(--acc2));-webkit-background-clip:text;background-clip:text;color:transparent}
.ndap .lead{color:var(--mute);font-size:clamp(1rem,2.2vw,1.2rem);max-width:36em;margin:22px 0 34px}
.ndap .btn{display:inline-flex;align-items:center;justify-content:center;padding:14px 30px;border-radius:999px;font-weight:500;text-decoration:none;font-size:1rem;transition:.3s;border:0;cursor:pointer;font-family:inherit;min-height:48px}
.ndap .btn.p{background:linear-gradient(135deg,var(--acc),var(--acc2));color:#041013;box-shadow:0 0 30px rgba(46,242,196,.35)}
.ndap .btn.p:hover{transform:translateY(-2px);box-shadow:0 0 50px rgba(46,242,196,.6)}
.ndap .btn.g{border:1px solid var(--line);color:var(--fg);background:var(--glass)}
.ndap .btn.g:hover{border-color:var(--acc)}
.ndap .row{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.ndap .fineprint{color:var(--mute);font-size:.8rem;margin-top:14px}
.ndap .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;margin-top:56px}
.ndap .card{background:var(--glass);border:1px solid var(--line);border-radius:22px;padding:26px;backdrop-filter:blur(18px);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 24px 60px rgba(0,0,0,.35)}
.ndap .card h3{font-size:1.2rem;margin-bottom:8px}
.ndap .card p{color:var(--mute);font-size:.95rem}
.ndap ul{list-style:none;padding:0;display:grid;gap:10px;margin:30px 0 34px;max-width:36em}
.ndap li{color:var(--mute);display:flex;gap:10px;align-items:baseline;font-size:.98rem}
.ndap li::before{content:"✓";color:var(--acc);font-size:.85rem}
.ndap h2{font-size:clamp(1.6rem,4.5vw,2.6rem);line-height:1.15;margin-top:70px;letter-spacing:-.03em}
.ndap footer{position:relative;z-index:5;text-align:center;color:var(--mute);font-size:.82rem;padding:26px 6vw 44px;border-top:1px solid var(--line)}
.ndap footer a{color:var(--mute);margin:0 10px}
.ndap footer a:hover{color:var(--acc)}
`;

export default function AppPage() {
  return (
    <div className="ndap">
      <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
      <header>
        <a className="logo" href={WEBAPP_URL.replace('#/home', '')}>
          Nex<b>Drop</b>
        </a>
        <nav aria-label="App page navigation">
          <Link href="/web">WebApp</Link>
          <Link href="/security">Security</Link>
          <Link href="/about">About</Link>
        </nav>
      </header>

      <main>
        <div className="tag">Private · Direct · Fast</div>
        <h1>
          NexDrop App
          <br />
          <span>Native Android P2P.</span>
        </h1>
        <p className="lead">
          The full NexDrop experience as a native Android app. Transfer files and text directly
          between Android devices over the native NDT1 TCP transport — no accounts, no cloud
          file storage, SHA-256 verified end to end.
        </p>

        <ul aria-label="NexDrop App highlights">
          <li>Native NDT1 TCP transport</li>
          <li>Maximum local performance — built for high-speed local transfer</li>
          <li>Large-file streaming</li>
          <li>Advanced transfer queue</li>
          <li>Pause / Resume</li>
          <li>Recovery after interruption</li>
          <li>SHA-256 verification</li>
          <li>Local transfer history</li>
          <li>Android → Android</li>
        </ul>

        <div className="row">
          <a className="btn p" href={RELEASE_URL} download>
            📱 Download NexDrop
          </a>
          <a className="btn g" href={RELEASE_PAGE_URL}>
            Release notes &amp; checksum
          </a>
        </div>
        <p className="fineprint">
          NexDrop v1.4.4 (code 17) — signed production APK from the official GitHub release.
          Android may ask you to allow installs from this source; the APK is signed with the
          NexDrop release key and verified with APK Signature Scheme v2 + v3.
        </p>

        <div className="grid">
          <div className="card">
            <h3>Native transport</h3>
            <p>
              NDT1 is NexDrop&apos;s dedicated TCP transfer engine — built for high-speed local
              transfer on your Wi-Fi network. Performance varies with network conditions.
            </p>
          </div>
          <div className="card">
            <h3>Durable by design</h3>
            <p>
              Queue transfers, pause and resume them, and recover after an interruption — the
              transfer picks up where it left off.
            </p>
          </div>
          <div className="card">
            <h3>Verified, not trusted</h3>
            <p>
              Every transfer is verified with a streaming SHA-256 check, so what arrives is
              byte-identical to what was sent.
            </p>
          </div>
          <div className="card">
            <h3>Private by default</h3>
            <p>
              No account, no cloud file storage. Transfers go straight from device to device;
              history stays on your device.
            </p>
          </div>
        </div>

        <h2>
          Prefer <span>no install?</span>
        </h2>
        <p className="lead">
          NexDrop also runs entirely in your browser — same pairing, same verification, no
          installation.
        </p>
        <div className="row">
          <a className="btn g" href={WEBAPP_URL}>🌐 Open the WebApp</a>
          <Link className="btn g" href="/web">About the WebApp</Link>
        </div>
      </main>

      <footer>
        <Link href="/security">Security</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/about">About</Link>
        <a href={WEBAPP_URL}>WebApp</a>
        <div style={{ marginTop: 12 }}>© 2026 NexDrop · Native NDT1 TCP on Android · WebRTC in the browser</div>
      </footer>
    </div>
  );
}
