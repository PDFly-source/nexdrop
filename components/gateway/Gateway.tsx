'use client';

/**
 * NexDrop premium 3D public gateway (front door).
 *
 * Rendered by app/page.tsx ONLY when the URL has no hash (bare "/" visit).
 * Any hash (#/home, #/transfers, #join=…) renders the real WebApp untouched.
 *
 * Visual identity from the supplied design "NexDrop — Private, Direct, Fast.html":
 * dark premium background, glassmorphism, cyan/teal + blue accents, Three.js
 * particle field with two connected devices and animated transfer packets,
 * Space Grotesk / Inter typography, scroll progress, reveal animations,
 * poster phone mock, marquee, FAQ, footer.
 *
 * This component is presentation-only: it never starts a transfer session,
 * never touches the WebRTC/NDT1 engines, and contains no fake UI. Both CTAs
 * lead to the real products (App info page / the actual WebApp at #/home).
 */

import React, { useEffect, useRef } from 'react';
import Link from 'next/link';

/*
 * Official, verified destination (no invented URLs): the real WebApp.
 * On the gateway page (same page as the WebApp) a relative "#/home" fragment
 * performs a same-document hash navigation — on production this resolves to
 * exactly https://pdfly-source.github.io/nexdrop/#/home, and the hashchange
 * listener in app/page.tsx mounts the real WebApp. It stays correct on local
 * and mirror origins too, unlike a hardcoded absolute URL.
 */
const WEBAPP_URL = '#/home';

declare global {
  interface Window {
    THREE?: unknown;
  }
}

/* --------------------------------------------------------------------- */
/* Scoped styles — every rule is namespaced under .ndgw so nothing can   */
/* leak into (or be affected by) the WebApp's Tailwind styles.           */
/* --------------------------------------------------------------------- */

const GATEWAY_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500&display=swap');

.ndgw{--bg:#070B0C;--fg:#EAF4F2;--mute:#8FA5A1;--acc:#2EF2C4;--acc2:#3B9BFF;
  --glass:rgba(255,255,255,.05);--line:rgba(255,255,255,.1);
  position:relative;min-height:100vh;overflow-x:hidden;
  background:var(--bg);color:var(--fg);
  font-family:Inter,system-ui,sans-serif;line-height:1.6;
  padding-top:env(safe-area-inset-top,0px);padding-bottom:0}
.ndgw *,.ndgw *::before,.ndgw *::after{box-sizing:border-box;margin:0}
.ndgw h1,.ndgw h2,.ndgw h3,.ndgw .logo{font-family:'Space Grotesk',Inter,system-ui,sans-serif;letter-spacing:-.02em}
.ndgw a{-webkit-tap-highlight-color:transparent}
.ndgw :focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:6px}

.ndgw .gl{position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none}
.ndgw .vig{position:fixed;inset:0;z-index:1;pointer-events:none;background:radial-gradient(ellipse at center,transparent 40%,var(--bg) 100%)}
.ndgw::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;background:radial-gradient(600px 400px at 15% 20%,rgba(46,242,196,.13),transparent 70%),radial-gradient(700px 500px at 85% 70%,rgba(59,155,255,.13),transparent 70%)}
.ndgw::after{content:"";position:fixed;inset:0;z-index:6;pointer-events:none;opacity:.07;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.ndgw .pg{position:fixed;top:0;left:0;right:0;height:2px;z-index:30;background:linear-gradient(90deg,var(--acc),var(--acc2));transform-origin:0 50%;transform:scaleX(0)}

.ndgw nav{position:fixed;top:env(safe-area-inset-top,0px);left:0;right:0;z-index:20;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 5vw;backdrop-filter:blur(14px);background:rgba(7,11,12,.45);border-bottom:1px solid var(--line)}
.ndgw .logo{font-weight:700;font-size:1.25rem;color:var(--fg);text-decoration:none;white-space:nowrap}
.ndgw .logo b{color:var(--acc);font-weight:700}
.ndgw .lk{display:flex;gap:28px}
.ndgw .lk a,.ndgw .lk button{color:var(--mute);text-decoration:none;font-size:.9rem;transition:.3s;background:none;border:0;padding:0;font-family:inherit;cursor:pointer}
.ndgw .lk a:hover,.ndgw .lk button:hover{color:var(--fg)}
.ndgw .btn{display:inline-block;padding:12px 24px;border-radius:999px;font-weight:500;text-decoration:none;font-size:.95rem;transition:.3s;border:0;cursor:pointer;font-family:inherit;text-align:center}
.ndgw .btn.p{background:linear-gradient(135deg,var(--acc),var(--acc2));color:#041013;box-shadow:0 0 30px rgba(46,242,196,.35);position:relative;overflow:hidden}
.ndgw .btn.p:hover{transform:translateY(-2px);box-shadow:0 0 50px rgba(46,242,196,.6)}
.ndgw .btn.p::after{content:"";position:absolute;top:0;left:-80%;width:50%;height:100%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.55),transparent);transform:skewX(-20deg);animation:ndgwsh 4s infinite}
@keyframes ndgwsh{0%,60%{left:-80%}100%{left:140%}}
.ndgw .btn.g{border:1px solid var(--line);color:var(--fg);background:var(--glass)}
.ndgw .btn.g:hover{border-color:var(--acc)}
.ndgw .mbtn{display:none;background:var(--glass);border:1px solid var(--line);color:var(--fg);border-radius:12px;padding:8px 14px;font-size:.85rem;cursor:pointer;font-family:inherit}
.ndgw .mnav{display:none;flex-direction:column;gap:4px;padding:12px 5vw 16px;background:rgba(7,11,12,.92);border-bottom:1px solid var(--line);backdrop-filter:blur(14px)}
.ndgw .mnav a,.ndgw .mnav button{color:var(--fg);text-decoration:none;font-size:1rem;padding:10px 4px;border:0;background:none;text-align:left;font-family:inherit;cursor:pointer}
.ndgw nav.open + .mnav{display:flex}

.ndgw main{position:relative;z-index:5}
.ndgw section{display:flex;flex-direction:column;justify-content:center;padding:110px 6vw 80px;max-width:1200px;margin:auto;position:relative}
.ndgw .tag{color:var(--acc);font-size:.78rem;letter-spacing:.25em;text-transform:uppercase;margin-bottom:18px}
.ndgw h1{font-size:clamp(2.8rem,9vw,6.5rem);line-height:1.02;font-weight:700;letter-spacing:-.04em}
.ndgw h1 span,.ndgw h2 span{background:linear-gradient(120deg,var(--acc),var(--acc2));-webkit-background-clip:text;background-clip:text;color:transparent}
.ndgw h2{font-size:clamp(2rem,5.5vw,3.8rem);line-height:1.1;margin-bottom:36px;max-width:14em;letter-spacing:-.035em}
.ndgw .lead{color:var(--mute);font-size:clamp(1rem,2.2vw,1.25rem);max-width:34em;margin:24px 0 36px}
.ndgw .row{display:flex;gap:14px;flex-wrap:wrap}
.ndgw .hint{margin-top:60px;color:var(--mute);font-size:.8rem;letter-spacing:.2em;animation:ndgwb 2s infinite}
@keyframes ndgwb{50%{transform:translateY(8px);opacity:.5}}
.ndgw .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}
.ndgw .card{background:var(--glass);border:1px solid var(--line);border-radius:22px;padding:28px;backdrop-filter:blur(18px);position:relative;overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 24px 60px rgba(0,0,0,.35)}
.ndgw .card:hover{border-color:rgba(46,242,196,.5)}
.ndgw .card::before{content:"";position:absolute;inset:0;background:radial-gradient(300px circle at var(--mx,50%) var(--my,0),rgba(46,242,196,.16),transparent 60%);opacity:0;transition:.3s;pointer-events:none}
.ndgw .card:hover::before{opacity:1}
.ndgw .card .n{font-family:'Space Grotesk',sans-serif;font-size:2.4rem;color:var(--acc)}
.ndgw .card h3{font-size:1.3rem;margin:8px 0}
.ndgw .card p{color:var(--mute);font-size:.95rem}
.ndgw .stats{display:flex;gap:40px;flex-wrap:wrap;margin-top:40px}
.ndgw .stats b{display:block;font-family:'Space Grotesk',sans-serif;font-size:2.4rem;color:var(--acc)}
.ndgw .stats span{color:var(--mute);font-size:.85rem}
.ndgw .cta{text-align:center;align-items:center}

.ndgw .pill{display:inline-flex;align-items:center;gap:10px;padding:8px 16px;border:1px solid var(--line);border-radius:999px;background:var(--glass);font-size:.8rem;color:var(--mute);margin-bottom:26px;backdrop-filter:blur(10px)}
.ndgw .dot{width:8px;height:8px;border-radius:50%;background:var(--acc);box-shadow:0 0 12px var(--acc);flex:none}

/* Hero + product cards */
.ndgw .hero{display:grid;grid-template-columns:1.15fr .85fr;gap:40px;align-items:center;min-height:88vh}
.ndgw .ph-wrap{perspective:1000px;position:relative}
.ndgw .ph-wrap::before{content:"";position:absolute;inset:-12% -8%;background:radial-gradient(closest-side,rgba(46,242,196,.28),transparent);filter:blur(30px);animation:ndgwgl 5s ease-in-out infinite;z-index:-1}
@keyframes ndgwgl{50%{opacity:.5;transform:scale(1.08)}}
.ndgw .phone{position:relative;border-radius:30px;padding:24px;background:linear-gradient(160deg,rgba(255,255,255,.12),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(24px);box-shadow:0 40px 80px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.25);transition:transform .15s;will-change:transform}
.ndgw .ph-top{display:flex;align-items:center;gap:8px;font-size:.75rem;color:var(--mute);margin-bottom:18px}
.ndgw .ph-h{font-family:'Space Grotesk',sans-serif;font-size:1.6rem;font-weight:700;margin-bottom:16px}
.ndgw .ph-btns{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.ndgw .pb{border-radius:18px;padding:16px;border:1px solid var(--line);background:rgba(255,255,255,.04);font-weight:500}
.ndgw .pb small{display:block;color:var(--mute);font-size:.7rem;font-weight:400}
.ndgw .pb.a{background:linear-gradient(135deg,var(--acc),var(--acc2));color:#041013}
.ndgw .pb.a small{color:#0a3a3a}
.ndgw .prof{display:flex;gap:6px;margin:16px 0;background:rgba(0,0,0,.3);padding:4px;border-radius:999px}
.ndgw .prof i{flex:1;text-align:center;font-style:normal;font-size:.68rem;letter-spacing:.1em;padding:7px;border-radius:999px;color:var(--mute)}
.ndgw .prof i.on{background:rgba(46,242,196,.18);color:var(--acc)}
.ndgw .bar{height:6px;border-radius:9px;background:rgba(255,255,255,.1);overflow:hidden}
.ndgw .bar u{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--acc),var(--acc2));animation:ndgwfill 4s ease-in-out infinite}
@keyframes ndgwfill{0%{width:5%}80%,100%{width:100%}}
.ndgw .fl{font-size:.75rem;color:var(--mute);margin-top:10px;display:flex;justify-content:space-between}

.ndgw .choose-h{font-family:'Space Grotesk',sans-serif;font-size:.8rem;letter-spacing:.3em;text-transform:uppercase;color:var(--mute);margin:34px 0 18px}
.ndgw .choose{display:grid;grid-template-columns:1fr 1fr;gap:24px;position:relative;z-index:2}
.ndgw .pcard{background:var(--glass);border:1px solid var(--line);border-radius:26px;padding:30px;backdrop-filter:blur(18px);position:relative;overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 24px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:14px;transition:transform .3s,box-shadow .3s,border-color .3s}
.ndgw .pcard:hover{transform:translateY(-4px);border-color:rgba(46,242,196,.5);box-shadow:0 30px 70px rgba(0,0,0,.45),0 0 60px rgba(46,242,196,.12)}
.ndgw .pcard::before{content:"";position:absolute;inset:0;background:radial-gradient(400px circle at var(--mx,50%) var(--my,0),rgba(46,242,196,.14),transparent 60%);opacity:0;transition:.3s;pointer-events:none}
.ndgw .pcard:hover::before{opacity:1}
.ndgw .pcard.primary{border-color:rgba(46,242,196,.35);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 24px 60px rgba(0,0,0,.35),0 0 44px rgba(46,242,196,.13)}
.ndgw .pcard .pbadge{position:absolute;top:18px;right:18px;font-size:.62rem;letter-spacing:.18em;text-transform:uppercase;color:var(--acc);border:1px solid rgba(46,242,196,.35);border-radius:999px;padding:5px 10px;background:rgba(46,242,196,.08)}
.ndgw .pcard .pic{font-size:2rem;line-height:1}
.ndgw .pcard h3{font-size:1.45rem;margin:0}
.ndgw .pcard .sub{color:var(--acc);font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;margin-top:-8px}
.ndgw .pcard ul{list-style:none;padding:0;display:grid;gap:9px;margin:4px 0 10px}
.ndgw .pcard li{color:var(--mute);font-size:.93rem;display:flex;gap:10px;align-items:baseline}
.ndgw .pcard li::before{content:"✓";color:var(--acc);font-size:.8rem}
.ndgw .pcard .btn{margin-top:auto;justify-self:start;min-height:48px;min-width:170px;display:inline-flex;align-items:center;justify-content:center;padding:12px 28px}
.ndgw .pcard .fineprint{color:var(--mute);font-size:.74rem}

/* Marquee */
.ndgw .marquee{position:relative;z-index:5;overflow:hidden;border-block:1px solid var(--line);background:rgba(255,255,255,.02);padding:18px 0;-webkit-mask:linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent);mask:linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent)}
.ndgw .marquee div{display:flex;gap:56px;width:max-content;animation:ndgwmq 30s linear infinite;color:var(--mute);font-size:.8rem;letter-spacing:.22em;text-transform:uppercase}
.ndgw .marquee span::before{content:"◆";color:var(--acc);margin-right:56px}
@keyframes ndgwmq{to{transform:translateX(-50%)}}

/* Flow steps */
.ndgw .flow{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:center}
.ndgw .step{background:var(--glass);border:1px solid var(--line);border-radius:18px;padding:14px 22px;backdrop-filter:blur(14px);font-family:'Space Grotesk',sans-serif;font-size:.9rem;letter-spacing:.06em;text-transform:uppercase;transition:.3s;box-shadow:inset 0 1px 0 rgba(255,255,255,.12)}
.ndgw .step:hover{border-color:rgba(46,242,196,.5);transform:translateY(-2px)}
.ndgw .step b{color:var(--acc)}
.ndgw .arrow{color:var(--acc);font-size:1.1rem;opacity:.7;flex:none}

/* Comparison table */
.ndgw .tbl{border:1px solid var(--line);border-radius:24px;overflow:hidden;background:var(--glass);backdrop-filter:blur(18px)}
.ndgw .tr{display:grid;grid-template-columns:1.3fr 1fr 1fr;padding:18px 24px;border-top:1px solid var(--line);font-size:.95rem;gap:12px}
.ndgw .tr.h{border:0;font-family:'Space Grotesk',sans-serif;font-size:.8rem;letter-spacing:.15em;text-transform:uppercase;color:var(--mute)}
.ndgw .tr span:first-child{color:var(--mute)}
.ndgw .tr span:nth-child(2){opacity:.7}
.ndgw .us{color:var(--acc)!important;opacity:1!important;font-weight:500}

/* FAQ */
.ndgw .faq{display:grid;gap:12px;max-width:820px}
.ndgw details{border:1px solid var(--line);border-radius:18px;padding:20px 24px;background:var(--glass);backdrop-filter:blur(14px);transition:.3s}
.ndgw details[open]{border-color:rgba(46,242,196,.4)}
.ndgw summary{cursor:pointer;font-family:'Space Grotesk',sans-serif;font-size:1.1rem;list-style:none;display:flex;justify-content:space-between;gap:12px}
.ndgw summary::-webkit-details-marker{display:none}
.ndgw summary::after{content:"+";color:var(--acc);font-size:1.4rem;line-height:1}
.ndgw details[open] summary::after{content:"–"}
.ndgw details p{color:var(--mute);margin-top:12px;font-size:.95rem}

.ndgw footer{position:relative;z-index:5;text-align:center;color:var(--mute);font-size:.82rem;padding:30px 6vw 50px;border-top:1px solid var(--line);background:var(--bg)}
.ndgw footer a{color:var(--mute);margin:0 10px}
.ndgw footer a:hover{color:var(--acc)}
.ndgw .fg{display:flex;flex-direction:column;align-items:center;gap:12px;max-width:1200px;margin:auto;text-align:center}
.ndgw .fg .logo{font-size:1.15rem}
.ndgw .fg .fgTag{font-size:.64rem;letter-spacing:.34em;text-transform:uppercase;color:var(--acc);opacity:.9}
.ndgw .fg .fgSig{font-size:.76rem;color:var(--mute);line-height:1.7}
.ndgw .fg .fgDv{width:56px;height:1px;background:var(--line)}
.ndgw .fg .fgNav{display:flex;flex-wrap:wrap;justify-content:center;gap:4px 0}

/* Reveal */
.ndgw .rv{opacity:0;transform:translateY(50px) scale(.97);transition:opacity 1s,transform 1s cubic-bezier(.2,.8,.2,1)}
.ndgw .rv.in{opacity:1;transform:none}
.ndgw .card.rv:nth-child(2){transition-delay:.12s}
.ndgw .card.rv:nth-child(3){transition-delay:.24s}
.ndgw .card.rv:nth-child(4){transition-delay:.36s}

@media(max-width:860px){
  .ndgw .hero{grid-template-columns:1fr;min-height:auto}
  .ndgw .ph-wrap{max-width:340px}
  .ndgw .lk{display:none}
  .ndgw .mbtn{display:inline-block}
  .ndgw nav .btn.p{display:none}
  .ndgw .choose{grid-template-columns:1fr}
  .ndgw section{padding:90px 6vw 60px}
}
@media(max-width:600px){
  .ndgw .tr{grid-template-columns:1fr 1fr 1fr;padding:14px;font-size:.8rem}
}

/* Reduced motion: keep everything usable, drop aggressive animation */
@media (prefers-reduced-motion: reduce){
  .ndgw *{animation:none!important;transition:none!important}
  .ndgw .rv{opacity:1;transform:none}
  .ndgw .hint{animation:none}
}
`;

/* --------------------------------------------------------------------- */
/* Three.js scene — faithful adaptation of the design's 3D background.   */
/* Fully disposable on unmount; degrades on mobile and prefers-reduced-  */
/* motion; canvas never intercepts pointer events.                       */
/* --------------------------------------------------------------------- */

function initThreeScene(canvas: HTMLCanvasElement): () => void {
  const W = window as unknown as { THREE?: any };
  if (!W.THREE) return () => {};

  const THREE = W.THREE;
  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobile = window.innerWidth < 700;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2));
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x070b0c, 0.045);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  camera.position.z = 9;

  const onResize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  onResize();
  window.addEventListener('resize', onResize);

  const ACC = 0x2ef2c4;
  const ACC2 = 0x3b9bff;

  // Particle field — reduced count on mobile
  const N = mobile ? 700 : 1800;
  const pa = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pa[i * 3] = (Math.random() - 0.5) * 60;
    pa[i * 3 + 1] = (Math.random() - 0.5) * 60;
    pa[i * 3 + 2] = (Math.random() - 0.5) * 90 - 20;
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pa, 3));
  const stars = new THREE.Points(
    pg,
    new THREE.PointsMaterial({
      color: ACC,
      size: 0.09,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  scene.add(stars);

  // Two connected devices
  const makeDevice = (col: number) => {
    const g = new THREE.Group();
    g.add(
      new THREE.Mesh(
        new THREE.IcosahedronGeometry(1.3, 1),
        new THREE.MeshBasicMaterial({ color: col, wireframe: true, transparent: true, opacity: 0.7 })
      )
    );
    g.add(
      new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.8, 0),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35 })
      )
    );
    const r = new THREE.Mesh(
      new THREE.TorusGeometry(1.9, 0.015, 8, 100),
      new THREE.MeshBasicMaterial({ color: col })
    );
    r.rotation.x = 1.2;
    g.add(r);
    g.userData.r = r;
    return g;
  };
  const A = makeDevice(ACC);
  const B = makeDevice(ACC2);
  scene.add(A, B);

  const link = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 })
  );
  scene.add(link);

  // Animated transfer packets (illustrative marketing visual only)
  const packets: any[] = [];
  for (let k = 0; k < 12; k++) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 8, 8),
      new THREE.MeshBasicMaterial({ color: k % 2 ? ACC : 0xffffff })
    );
    m.userData.t = k / 12;
    scene.add(m);
    packets.push(m);
  }

  const core = new THREE.Group();
  for (let j = 0; j < 3; j++) {
    const t = new THREE.Mesh(
      new THREE.TorusGeometry(1 + j * 0.45, 0.012, 8, 80),
      new THREE.MeshBasicMaterial({ color: ACC, transparent: true, opacity: 0.5 })
    );
    t.rotation.set(j, j * 0.8, 0);
    core.add(t);
  }
  core.scale.setScalar(0.001);
  scene.add(core);

  let tp = 0;
  let sp = 0;
  let mx = 0;
  let my = 0;
  const clock = reduced ? ({ getElapsedTime: () => 0 } as any) : new THREE.Clock();

  const onScroll = () => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    tp = h > 0 ? window.scrollY / h : 0;
    const bar = document.getElementById('ndgw-pg');
    if (bar) bar.style.transform = `scaleX(${tp})`;
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  const onPointer = (e: PointerEvent) => {
    mx = e.clientX / window.innerWidth - 0.5;
    my = e.clientY / window.innerHeight - 0.5;
  };
  if (!reduced) window.addEventListener('pointermove', onPointer, { passive: true });

  const ease = (x: number) => {
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    return x * x * (3 - 2 * x);
  };

  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const t = clock.getElapsedTime();
    sp += (tp - sp) * 0.06;
    const conn = ease((sp - 0.1) / 0.5);
    const sec = ease((sp - 0.62) / 0.2);
    const dx = (window.innerWidth < 700 ? 2.4 : 4.2) * (1 - conn * 0.62) + 0.4;
    const y = sp * 1.5;
    A.position.set(-dx, Math.sin(t * 0.8) * 0.25 + y, 0);
    B.position.set(dx, Math.cos(t * 0.8) * 0.25 + y, 0);
    A.rotation.y = t * 0.4 + sp * 6;
    B.rotation.y = -t * 0.4 - sp * 6;
    A.rotation.x = B.rotation.x = t * 0.2;
    A.userData.r.rotation.z = t * 0.6;
    B.userData.r.rotation.z = -t * 0.6;
    link.geometry.setFromPoints([A.position, B.position]);
    (link.material as any).opacity = 0.1 + conn * 0.5;
    packets.forEach((m) => {
      const u = (m.userData.t + t * 0.18 * (1 + conn)) % 1;
      m.position.lerpVectors(A.position, B.position, u);
      m.position.y += Math.sin(u * Math.PI) * 0.6 * (1 - conn * 0.7);
      m.visible = conn > 0.05;
      m.scale.setScalar(0.6 + conn);
    });
    core.position.set(0, y, 0);
    core.scale.setScalar(0.001 + sec * (1.2 + conn));
    core.children.forEach((r: any, i: number) => {
      r.rotation.x += 0.004 * (i + 1);
      r.rotation.y += 0.006;
    });
    stars.rotation.y = t * 0.01 + sp * 1.2;
    stars.position.z = sp * 14;
    camera.position.z = 9 - sp * 2.5;
    camera.position.y = y;
    camera.position.x += (mx * 2 - camera.position.x) * 0.04;
    camera.lookAt(0, y - my * 0.8, 0);
    renderer.render(scene, camera);
  };

  if (reduced) {
    // Static single frame — content stays fully visible and usable.
    renderer.render(scene, camera);
  } else {
    loop();
  }

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('pointermove', onPointer);
    scene.traverse((obj: any) => {
      if (obj.geometry) obj.geometry.dispose?.();
      if (obj.material) obj.material.dispose?.();
    });
    renderer.dispose();
  };
}

/* --------------------------------------------------------------------- */
/* Component                                                             */
/* --------------------------------------------------------------------- */

export default function Gateway() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const navRef = useRef<HTMLElement>(null);

  /* Scroll to a section without ever touching the URL hash (the hash
     namespace belongs to the WebApp router — #/home etc. must stay the
     only way to enter the app). */
  const scrollTo = (id: string) => {
    navRef.current?.classList.remove('open');
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    // Reveal-on-scroll
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) e.target.classList.add('in');
        });
      },
      { threshold: 0.15 }
    );
    root.querySelectorAll('.rv').forEach((el) => io.observe(el));

    // Card / product-card pointer glow
    const glowHandlers: Array<[HTMLElement, (e: PointerEvent) => void]> = [];
    root.querySelectorAll<HTMLElement>('.card, .pcard').forEach((c) => {
      const onMove = (e: PointerEvent) => {
        const b = c.getBoundingClientRect();
        c.style.setProperty('--mx', e.clientX - b.left + 'px');
        c.style.setProperty('--my', e.clientY - b.top + 'px');
      };
      c.addEventListener('pointermove', onMove, { passive: true });
      glowHandlers.push([c, onMove]);
    });

    // Phone tilt (desktop pointer only, skipped for reduced motion)
    const tiltEl = root.querySelector<HTMLElement>('#ndgw-tilt');
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let tiltHandler: ((e: PointerEvent) => void) | null = null;
    if (tiltEl && !reduced) {
      tiltHandler = (e: PointerEvent) => {
        const x = e.clientX / window.innerWidth - 0.5;
        const y = e.clientY / window.innerHeight - 0.5;
        tiltEl.style.transform = `rotateY(${x * -16}deg) rotateX(${y * 12}deg)`;
      };
      window.addEventListener('pointermove', tiltHandler, { passive: true });
    }

    // Three.js background — load from CDN (same dependency as the design).
    let disposeScene: (() => void) | null = null;
    let cancelled = false;
    const startScene = () => {
      if (cancelled || !canvasRef.current) return;
      disposeScene = initThreeScene(canvasRef.current);
    };
    if ((window as any).THREE) {
      startScene();
    } else {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
      s.async = true;
      s.onload = startScene;
      document.head.appendChild(s);
    }

    return () => {
      cancelled = true;
      io.disconnect();
      glowHandlers.forEach(([c, h]) => c.removeEventListener('pointermove', h));
      if (tiltHandler) window.removeEventListener('pointermove', tiltHandler);
      disposeScene?.();
    };
  }, []);

  return (
    <div className="ndgw" ref={rootRef}>
      <style dangerouslySetInnerHTML={{ __html: GATEWAY_CSS }} />
      <div className="pg" id="ndgw-pg" aria-hidden="true" />
      <canvas className="gl" ref={canvasRef} aria-hidden="true" />
      <div className="vig" aria-hidden="true" />

      {/* ---------------------------------------------------------------- */}
      {/* Navigation                                                       */}
      {/* ---------------------------------------------------------------- */}
      <nav ref={navRef}>
        <a className="logo" href="#ndgw-hero" onClick={(e) => { e.preventDefault(); scrollTo('ndgw-hero'); }} aria-label="NexDrop home">
          Nex<b>Drop</b>
        </a>
        <div className="lk">
          <button type="button" onClick={() => scrollTo('ndgw-how')}>How it works</button>
          <button type="button" onClick={() => scrollTo('ndgw-choose')}>App</button>
          <button type="button" onClick={() => scrollTo('ndgw-choose')}>WebApp</button>
          <Link href="/security">Security</Link>
          <button type="button" onClick={() => scrollTo('ndgw-faq')}>FAQ</button>
        </div>
        <button className="btn p" type="button" onClick={() => scrollTo('ndgw-choose')}>
          Open NexDrop
        </button>
        <button
          className="mbtn"
          type="button"
          aria-expanded={false}
          aria-label="Open menu"
          onClick={() => navRef.current?.classList.toggle('open')}
        >
          Menu
        </button>
      </nav>
      <div className="mnav">
        <button type="button" onClick={() => scrollTo('ndgw-choose')}>App</button>
        <button type="button" onClick={() => scrollTo('ndgw-choose')}>WebApp</button>
        <Link href="/security">Security</Link>
        <button type="button" onClick={() => scrollTo('ndgw-faq')}>FAQ</button>
      </div>

      <main>
        {/* -------------------------------------------------------------- */}
        {/* Hero                                                           */}
        {/* -------------------------------------------------------------- */}
        <section className="hero" id="ndgw-hero">
          <div>
            <div className="pill rv">
              <span className="dot" aria-hidden="true" />
              Private · Direct · Fast — choose your experience
            </div>
            <h1 className="rv">
              Send directly.
              <br />
              <span>Keep it private.</span>
            </h1>
            <p className="lead rv">
              Transfer files and text directly between your devices. No accounts, no cloud file
              storage — device-to-device transfer, verified end to end.
            </p>

            <div className="choose-h rv" id="ndgw-choose">
              HOW DO YOU WANT TO USE NEXDROP?
            </div>

            {/* ---------------- Two product cards ---------------- */}
            <div className="choose rv">
              <div className="pcard primary">
                <span className="pbadge">Maximum local performance</span>
                <div className="pic" aria-hidden="true">📱</div>
                <h3>NexDrop App</h3>
                <p className="sub">Native Android experience</p>
                <ul>
                  <li>Native Android</li>
                  <li>Native NDT1 TCP transport</li>
                  <li>Large-file transfer</li>
                  <li>Advanced queue</li>
                  <li>Resume &amp; recovery</li>
                  <li>SHA-256 verification</li>
                </ul>
                <Link className="btn p" href="/app">
                  Open App
                </Link>
                <p className="fineprint">
                  Built for high-speed local transfer between Android devices.
                </p>
              </div>

              <div className="pcard">
                <div className="pic" aria-hidden="true">🌐</div>
                <h3>NexDrop WebApp</h3>
                <p className="sub">Browser-to-browser P2P</p>
                <ul>
                  <li>No installation</li>
                  <li>Works in your browser</li>
                  <li>Cross-device</li>
                  <li>WebRTC P2P</li>
                  <li>Send &amp; Receive</li>
                  <li>No cloud file upload</li>
                </ul>
                <a className="btn g" href={WEBAPP_URL}>
                  Open WebApp
                </a>
                <p className="fineprint">
                  Opens the real NexDrop WebApp — the same app at #/home, unchanged.
                </p>
              </div>
            </div>

            <p className="hint rv" aria-hidden="true">SCROLL ↓</p>
          </div>

          {/* Poster phone — illustrative product visual, not a live transfer */}
          <div className="ph-wrap rv" aria-hidden="true">
            <div className="phone" id="ndgw-tilt">
              <div className="ph-top"><span className="dot" />Ready · Private · Direct</div>
              <div className="ph-h">Send directly.</div>
              <div className="ph-btns">
                <div className="pb a">↑ Send<small>Photos, videos, files</small></div>
                <div className="pb">↓ Receive<small>From another device</small></div>
              </div>
              <div className="prof"><i>STANDARD</i><i className="on">AUTO</i><i>TURBO</i></div>
              <div className="bar"><u /></div>
              <div className="fl"><span>report.pdf</span><span>Direct · P2P</span></div>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* Marquee                                                        */}
        {/* -------------------------------------------------------------- */}
        <div className="marquee" aria-hidden="true">
          <div>
            <span>Native NDT1 TCP</span><span>WebRTC</span><span>QR pairing</span><span>SHA-256 verified</span><span>No accounts</span><span>No cloud uploads</span><span>Local-first</span><span>Send &amp; Receive</span>
            <span>Native NDT1 TCP</span><span>WebRTC</span><span>QR pairing</span><span>SHA-256 verified</span><span>No accounts</span><span>No cloud uploads</span><span>Local-first</span><span>Send &amp; Receive</span>
          </div>
        </div>

        {/* -------------------------------------------------------------- */}
        {/* How it works                                                   */}
        {/* -------------------------------------------------------------- */}
        <section id="ndgw-how">
          <div className="tag rv">How it works</div>
          <h2 className="rv">
            Three steps. <span>Direct</span> in between.
          </h2>
          <div className="grid">
            <div className="card rv">
              <div className="n">01</div>
              <h3>Connect</h3>
              <p>Pair two devices in seconds with a QR code. No sign-up needed.</p>
            </div>
            <div className="card rv">
              <div className="n">02</div>
              <h3>Choose</h3>
              <p>Pick files, photos, videos, text or clipboard content.</p>
            </div>
            <div className="card rv">
              <div className="n">03</div>
              <h3>Drop</h3>
              <p>
                Data transfers directly between the connected devices — over NexDrop&apos;s native
                Android transport (NDT1 TCP) or the browser&apos;s WebRTC path, depending on the
                experience you choose.
              </p>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* Product flow                                                    */}
        {/* -------------------------------------------------------------- */}
        <section id="ndgw-flow">
          <div className="tag rv">The flow</div>
          <h2 className="rv">
            One simple path, <span>both products.</span>
          </h2>
          <p className="lead rv">
            Whether you pick the App or the WebApp, the journey is the same.
          </p>
          <div className="flow rv" role="list" aria-label="NexDrop product flow">
            <span className="step" role="list-item"><b>SELECT</b> EXPERIENCE</span>
            <span className="arrow" aria-hidden="true">→</span>
            <span className="step" role="list-item">APP <b>/</b> WEBAPP</span>
            <span className="arrow" aria-hidden="true">→</span>
            <span className="step" role="list-item"><b>SEND</b> / RECEIVE</span>
            <span className="arrow" aria-hidden="true">→</span>
            <span className="step" role="list-item">PAIR</span>
            <span className="arrow" aria-hidden="true">→</span>
            <span className="step" role="list-item">TRANSFER</span>
            <span className="arrow" aria-hidden="true">→</span>
            <span className="step" role="list-item">SHA-256 <b>VERIFY</b></span>
            <span className="arrow" aria-hidden="true">→</span>
            <span className="step" role="list-item"><b>COMPLETE</b></span>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* Features                                                       */}
        {/* -------------------------------------------------------------- */}
        <section id="ndgw-feat">
          <div className="tag rv">Features</div>
          <h2 className="rv">
            Built for speed. <span>Designed for trust.</span>
          </h2>
          <div className="grid">
            <div className="card rv">
              <h3>Transfer profiles</h3>
              <p>Standard, Auto or Turbo — tune every transfer to your network.</p>
            </div>
            <div className="card rv">
              <h3>Share anything</h3>
              <p>Files, photos, videos, text and clipboard in one place.</p>
            </div>
            <div className="card rv">
              <h3>Local history</h3>
              <p>Recent transfers are stored only on your own device.</p>
            </div>
            <div className="card rv">
              <h3>Two ways to connect</h3>
              <p>
                A native Android app for maximum local performance, and a no-install browser
                experience for anything else.
              </p>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* Security                                                       */}
        {/* -------------------------------------------------------------- */}
        <section id="ndgw-sec">
          <div className="tag rv">Security</div>
          <h2 className="rv">
            Your data never <span>touches a cloud.</span>
          </h2>
          <p className="lead rv">
            No account required. No cloud file storage. Transfers go directly between your
            devices — over the native NDT1 TCP transport in the Android App, or WebRTC in the
            browser WebApp — and every transfer is SHA-256 verified. Transfer history stays
            local where supported.
          </p>
          <div className="stats rv">
            <div><b>0</b><span>Cloud file uploads</span></div>
            <div><b>0</b><span>Accounts</span></div>
            <div><b>0</b><span>Trackers</span></div>
            <div><b>P2P</b><span>Direct</span></div>
          </div>
          <div className="row rv" style={{ marginTop: '32px' }}>
            <Link className="btn g" href="/security">Read the security architecture</Link>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* App vs WebApp comparison                                       */}
        {/* -------------------------------------------------------------- */}
        <section id="ndgw-cmp">
          <div className="tag rv">Comparison</div>
          <h2 className="rv">
            App <span>or</span> WebApp.
          </h2>
          <div className="tbl rv" role="table" aria-label="NexDrop App versus WebApp">
            <div className="tr h" role="row"><span role="columnheader">&nbsp;</span><span role="columnheader">📱 App</span><span role="columnheader">🌐 WebApp</span></div>
            <div className="tr" role="row"><span role="cell">Platform</span><span role="cell">Native Android</span><span role="cell">Browser</span></div>
            <div className="tr" role="row"><span role="cell">Install</span><span role="cell">Yes</span><span role="cell">No</span></div>
            <div className="tr" role="row"><span role="cell">Transport</span><span role="cell">NDT1 TCP</span><span role="cell">WebRTC</span></div>
            <div className="tr" role="row"><span role="cell">Local Android speed</span><span className="us" role="cell">Maximum</span><span role="cell">Browser-dependent</span></div>
            <div className="tr" role="row"><span role="cell">Large files</span><span className="us" role="cell">✓</span><span className="us" role="cell">✓</span></div>
            <div className="tr" role="row"><span role="cell">Send / Receive</span><span className="us" role="cell">✓</span><span className="us" role="cell">✓</span></div>
            <div className="tr" role="row"><span role="cell">QR pairing</span><span className="us" role="cell">✓</span><span className="us" role="cell">✓</span></div>
            <div className="tr" role="row"><span role="cell">SHA-256 verification</span><span className="us" role="cell">✓</span><span className="us" role="cell">✓</span></div>
            <div className="tr" role="row"><span role="cell">Cloud upload</span><span role="cell">No</span><span role="cell">No</span></div>
            <div className="tr" role="row"><span role="cell">Account</span><span role="cell">No</span><span role="cell">No</span></div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* FAQ                                                            */}
        {/* -------------------------------------------------------------- */}
        <section id="ndgw-faq">
          <div className="tag rv">FAQ</div>
          <h2 className="rv">
            Questions, <span>answered.</span>
          </h2>
          <div className="faq rv">
            <details>
              <summary>What&apos;s the difference between the App and the WebApp?</summary>
              <p>
                The App is a native Android application using NexDrop&apos;s NDT1 TCP transport
                for maximum local performance between Android devices. The WebApp runs in your
                browser over WebRTC and needs no installation. Both pair with a QR code and both
                verify transfers with SHA-256.
              </p>
            </details>
            <details>
              <summary>Do I need an account?</summary>
              <p>No. Neither the App nor the WebApp needs a sign-up — open it on two devices and connect.</p>
            </details>
            <details>
              <summary>Are my files uploaded anywhere?</summary>
              <p>
                No. Transfers go directly from device to device. There is no cloud file storage
                and no account.
              </p>
            </details>
            <details>
              <summary>Where is my transfer history kept?</summary>
              <p>Recent transfers are stored only on your own device.</p>
            </details>
            <details>
              <summary>What can I send?</summary>
              <p>Files, photos, videos, text and clipboard content.</p>
            </details>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* CTA                                                            */}
        {/* -------------------------------------------------------------- */}
        <section className="cta">
          <div className="tag rv">Ready when you are</div>
          <h2 className="rv">
            Choose your <span>experience.</span>
          </h2>
          <div className="row rv" style={{ justifyContent: 'center' }}>
            <Link className="btn p" href="/app">📱 Get the App</Link>
            <a className="btn g" href={WEBAPP_URL}>🌐 Open WebApp</a>
          </div>
          <p className="lead rv" style={{ textAlign: 'center' }}>
            Private · Direct · Fast — the way sharing should be.
          </p>
        </section>
      </main>

      <footer>
        {/* Official NexDrop brand signature — same identity as the Android
            App and the WebApp footer. Presentation only. */}
        <div className="fg">
          <div className="logo">Nex<b>Drop</b></div>
          <div className="fgTag">Private · Direct · Fast</div>
          <div className="fgSig">
            Crafted &amp; Developed by PKD
            <br />© 2026 NexDrop. All rights reserved.
          </div>
          <div className="fgDv" />
          <nav className="fgNav">
            <Link href="/security">Security</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/about">About</Link>
            <Link href="/app">App</Link>
            <a href={WEBAPP_URL}>WebApp</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
