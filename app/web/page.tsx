

/**
 * NexDrop WebApp — browser P2P product page (/web).
 *
 * Public information page only. The CTA opens the REAL WebApp at #/home.
 * Nothing on this page touches the transfer or WebRTC engines.
 */

import React from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';

const WEBAPP_URL = 'https://pdfly-source.github.io/nexdrop/#/home';
const APP_PAGE_URL = 'https://pdfly-source.github.io/nexdrop/app/';

export const metadata: Metadata = {
  title: 'NexDrop WebApp — Browser P2P',
  description:
    'NexDrop in your browser: no-install, browser-to-browser P2P file and text transfer over WebRTC. No accounts, no cloud file uploads, SHA-256 verified.',
};

const PAGE_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500&display=swap');
.ndwp{--bg:#070B0C;--fg:#EAF4F2;--mute:#8FA5A1;--acc:#2EF2C4;--acc2:#3B9BFF;--glass:rgba(255,255,255,.05);--line:rgba(255,255,255,.1);
  min-height:100vh;background:var(--bg);color:var(--fg);font-family:Inter,system-ui,sans-serif;line-height:1.6;overflow-x:hidden;position:relative}
.ndwp *{box-sizing:border-box;margin:0}
.ndwp::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;background:radial-gradient(600px 400px at 15% 20%,rgba(46,242,196,.13),transparent 70%),radial-gradient(700px 500px at 85% 70%,rgba(59,155,255,.13),transparent 70%)}
.ndwp h1,.ndwp h2,.ndwp h3,.ndwp .logo{font-family:'Space Grotesk',Inter,system-ui,sans-serif;letter-spacing:-.02em}
.ndwp :focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:6px}
.ndwp header{position:relative;z-index:5;border-bottom:1px solid var(--line);background:rgba(7,11,12,.6);backdrop-filter:blur(14px);padding:14px 6vw;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.ndwp .logo{font-weight:700;font-size:1.15rem;color:var(--fg);text-decoration:none;white-space:nowrap}
.ndwp .logo b{color:var(--acc)}
.ndwp header nav{display:flex;gap:20px;flex-wrap:wrap}
.ndwp header a{color:var(--mute);text-decoration:none;font-size:.9rem;transition:.3s}
.ndwp header a:hover{color:var(--fg)}
.ndwp main{position:relative;z-index:5;max-width:1000px;margin:auto;padding:70px 6vw 90px}
.ndwp .tag{color:var(--acc);font-size:.78rem;letter-spacing:.25em;text-transform:uppercase;margin-bottom:18px}
.ndwp h1{font-size:clamp(2.2rem,7vw,4.2rem);line-height:1.05;font-weight:700;letter-spacing:-.03em}
.ndwp h1 span,.ndwp h2 span{background:linear-gradient(120deg,var(--acc),var(--acc2));-webkit-background-clip:text;background-clip:text;color:transparent}
.ndwp .lead{color:var(--mute);font-size:clamp(1rem,2.2vw,1.2rem);max-width:36em;margin:22px 0 34px}
.ndwp .btn{display:inline-flex;align-items:center;justify-content:center;padding:14px 30px;border-radius:999px;font-weight:500;text-decoration:none;font-size:1rem;transition:.3s;border:0;cursor:pointer;font-family:inherit;min-height:48px}
.ndwp .btn.p{background:linear-gradient(135deg,var(--acc),var(--acc2));color:#041013;box-shadow:0 0 30px rgba(46,242,196,.35)}
.ndwp .btn.p:hover{transform:translateY(-2px);box-shadow:0 0 50px rgba(46,242,196,.6)}
.ndwp .btn.g{border:1px solid var(--line);color:var(--fg);background:var(--glass)}
.ndwp .btn.g:hover{border-color:var(--acc)}
.ndwp .row{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.ndwp .fineprint{color:var(--mute);font-size:.8rem;margin-top:14px}
.ndwp .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;margin-top:56px}
.ndwp .card{background:var(--glass);border:1px solid var(--line);border-radius:22px;padding:26px;backdrop-filter:blur(18px);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 24px 60px rgba(0,0,0,.35)}
.ndwp .card h3{font-size:1.2rem;margin-bottom:8px}
.ndwp .card p{color:var(--mute);font-size:.95rem}
.ndwp ul{list-style:none;padding:0;display:grid;gap:10px;margin:30px 0 34px;max-width:36em}
.ndwp li{color:var(--mute);display:flex;gap:10px;align-items:baseline;font-size:.98rem}
.ndwp li::before{content:"✓";color:var(--acc);font-size:.85rem}
.ndwp h2{font-size:clamp(1.6rem,4.5vw,2.6rem);line-height:1.15;margin-top:70px;letter-spacing:-.03em}
.ndwp footer{position:relative;z-index:5;text-align:center;color:var(--mute);font-size:.82rem;padding:26px 6vw 44px;border-top:1px solid var(--line)}
.ndwp footer a{color:var(--mute);margin:0 10px}
.ndwp footer a:hover{color:var(--acc)}
`;

export default function WebPage() {
  return (
    <div className="ndwp">
      <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
      <header>
        <a className="logo" href={WEBAPP_URL.replace('#/home', '')}>
          Nex<b>Drop</b>
        </a>
        <nav aria-label="WebApp page navigation">
          <Link href="/app">App</Link>
          <Link href="/security">Security</Link>
          <Link href="/about">About</Link>
        </nav>
      </header>

      <main>
        <div className="tag">Private · Direct · Fast</div>
        <h1>
          NexDrop WebApp
          <br />
          <span>Browser-to-browser P2P.</span>
        </h1>
        <p className="lead">
          No installation. Open NexDrop in a browser on two devices, scan a QR code, and
          transfer files and text directly between them over WebRTC — no accounts, no cloud
          file uploads, SHA-256 verified end to end.
        </p>

        <ul aria-label="NexDrop WebApp highlights">
          <li>No installation</li>
          <li>Works in your browser</li>
          <li>Cross-device</li>
          <li>WebRTC P2P</li>
          <li>Send &amp; Receive</li>
          <li>No cloud file upload</li>
          <li>SHA-256 verification</li>
        </ul>

        <div className="row">
          <a className="btn p" href={WEBAPP_URL}>🌐 Open WebApp</a>
        </div>
        <p className="fineprint">
          Opens the real NexDrop WebApp — the same app at {WEBAPP_URL.replace('https://', '')},
          unchanged.
        </p>

        <div className="grid">
          <div className="card">
            <h3>Nothing to install</h3>
            <p>
              The WebApp runs entirely in your browser — on phones, tablets and desktops — and
              can be installed as a PWA if you want it in your app drawer.
            </p>
          </div>
          <div className="card">
            <h3>Real WebRTC</h3>
            <p>
              Transfers use browser-to-browser WebRTC data channels. File data goes directly
              between the devices.
            </p>
          </div>
          <div className="card">
            <h3>Verified transfer</h3>
            <p>Every transfer is checked with SHA-256 so the received file is byte-identical.</p>
          </div>
          <div className="card">
            <h3>Private by default</h3>
            <p>
              No account, no cloud file storage. Your recent transfers stay in your browser.
            </p>
          </div>
        </div>

        <h2>
          On Android and want <span>maximum local performance?</span>
        </h2>
        <p className="lead">
          The native NexDrop App uses the NDT1 TCP transport, built for high-speed local
          transfer between Android devices.
        </p>
        <div className="row">
          <a className="btn g" href={APP_PAGE_URL}>📱 About the App</a>
        </div>
      </main>

      <footer>
        <Link href="/security">Security</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/about">About</Link>
        <Link href="/app">App</Link>
        <div style={{ marginTop: 12 }}>© 2026 NexDrop · Native NDT1 TCP on Android · WebRTC in the browser</div>
      </footer>
    </div>
  );
}
