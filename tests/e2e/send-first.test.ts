/** Phase 21 browser integration. Primary flow uses LIVE signaling, rendered QR
 * decoding, REAL File objects, WebRTC, and receiver SHA-256 verification.
 * Only fault/expiry/race scenarios intercept signaling (explicitly labelled).
 * NEXDROP_E2E_REQUIRE_CONNECTION=0 permits sandbox SDP-only diagnostics, never
 * a substitute for the full required CI run. No simulated transfer progress. */
import { chromium, devices, type Page, type BrowserContext } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const PORT = 3999; // Same permitted local test origin as the existing two-device suite.
const requireConnection = process.env.NEXDROP_E2E_REQUIRE_CONNECTION !== '0';
const url = `http://localhost:${PORT}/nexdrop/`;
const mime: Record<string,string> = { '.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.webmanifest':'application/manifest+json','.svg':'image/svg+xml' };
let passed = 0;
function check(value: unknown, label: string) { assert.ok(value, label); passed++; console.log(`  ✓ ${label}`); }
async function decodeQr(page: Page): Promise<string> {
  await page.waitForSelector('[data-testid="send-pairing"] img').catch(async error => { console.log('[QR failure page]',await page.locator('body').innerText()); throw error; });
  await page.evaluate(fs.readFileSync('node_modules/jsqr/dist/jsQR.js','utf8'));
  const text = await page.evaluate(() => {
    const img = document.querySelector('[data-testid="send-pairing"] img') as HTMLImageElement;
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;ctx.drawImage(img,0,0);
    const pixels = ctx.getImageData(0,0,canvas.width,canvas.height);
    return (window as any).jsQR(pixels.data,pixels.width,pixels.height,{inversionAttempts:'attemptBoth'})?.data;
  });
  assert.ok(text,'real rendered QR decodes'); return text;
}
async function devicesTab(page: Page) { await page.getByRole('button',{name:'Devices',exact:true}).last().click(); }
async function scan(page: Page, code: string) {
  await page.getByRole('button',{name:/join pairing/i}).first().click();
  await page.locator('#qr-paste').fill(code);
  await page.getByRole('button',{name:'Use',exact:true}).click();
}
async function choose(page: Page, names = ['phase21.txt']) {
  await page.locator('input[type="file"]').setInputFiles(names.map((name,index) => ({name,mimeType:'text/plain',buffer:Buffer.from(`NexDrop Phase 21 real file ${index}\n`.repeat(8192))})));
}
async function main() {
  const server = http.createServer((req,res) => {
    let pathname=(req.url || '/').split('?')[0].replace(/^\/nexdrop/,'') || '/';
    if (pathname.endsWith('/')) pathname+='index.html';
    fs.readFile(path.join('out',pathname), (err,data) => {
      if(err){res.writeHead(404);res.end('not found');return;}
      res.writeHead(200,{'Content-Type':mime[path.extname(pathname)] || 'application/octet-stream','Cache-Control':'no-store'});res.end(data);
    });
  });
  await new Promise<void>(resolve=>server.listen(PORT,resolve));
  const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-features=WebRtcHideLocalIpsWithMdns']});
  const contexts: BrowserContext[]=[];
  async function fresh(mobile=true) {
    const ctx=await browser.newContext(mobile ? {...devices['Pixel 7']} : {});contexts.push(ctx);
    await ctx.addInitScript(()=> { localStorage.setItem('nexdrop_onboarded_v1','1'); });
    const page=await ctx.newPage();await page.goto(url);return page;
  }
  try {
    console.log('[send-first e2e] real Send-first flow');
    const a=await fresh(); const b=await fresh();
    let creates=0;
    a.on('request',req=>{if(req.url().includes('nexdropSignal') && req.postDataJSON()?.action==='create') creates++;});
    await a.getByRole('button',{name:/^Send Pick files/}).click();
    check(await a.getByRole('tab',{name:'Send (0)'}).getAttribute('aria-selected')==='true','Home Send opens Transfers with Send active');
    await a.waitForTimeout(500);check(creates===0,'no pairing before file selection');
    await choose(a,['phase21-a.txt','phase21-b.txt','phase21-c.txt']);
    const code=await decodeQr(a);
    check(creates===1,'three real Files create exactly one live pairing');
    check(await a.getByText('phase21-a.txt',{exact:true}).count()===1,'real filename appears in outbound queue');
    check(await a.locator('[data-testid="send-pairing"] img').count()===1,'exactly one QR in Transfers without Devices navigation');
    check(await a.getByLabel('Next QR code').count()===0,'no QR carousel');
    check(await a.getByRole('button',{name:/scan answer/i}).count()===0,'no answer QR or sender scan-back');
    await devicesTab(b);await scan(b,code);
    await b.getByRole('heading',{name:'Incoming connection',exact:true}).waitFor();
    check(await b.getByRole('button',{name:'Decline',exact:true}).isVisible(),'receiver sees Decline');
    check(await b.getByRole('button',{name:'Accept',exact:true}).isVisible(),'receiver sees Accept');
    await a.waitForTimeout(1500);
    check(await a.locator('[data-testid="send-pairing"]').getAttribute('data-state')==='waiting_for_peer','receiver has not consented: sender never sends');
    await b.getByRole('button',{name:'Accept',exact:true}).click();
    await a.locator('[data-testid="send-pairing"][data-state="connecting"]').waitFor({timeout:30000});
    check(true,'receiver Accept triggers automatic real signaling and answer exchange');
    check(await b.locator('img[alt*="QR code"]').count()===0,'receiver never renders answer QR');
    if(requireConnection) {
      await a.locator('[data-testid="send-pairing"][data-state="completed"]').waitFor({timeout:90000});
      check(creates===1,'all three files auto-send sequentially through the same connection');
      await b.getByRole('button',{name:/Transfers/}).last().click();
      await b.getByRole('tab',{name:/Receive/}).click();
      check(await b.getByText('phase21-c.txt',{exact:true}).count()>=1,'receiver gets last real queued file');
      check(await a.getByText('· Verified by receiver',{exact:true}).count()>=3,'all three sender files have real receiver SHA-256 verdicts');
      await choose(a,['phase21-already-connected.txt']);
      await a.getByText('phase21-already-connected.txt',{exact:true}).waitFor();
      await a.waitForFunction(() => document.querySelector('[data-testid="send-pairing"]')?.getAttribute('data-state') === 'completed' && document.body.innerText.split('Verified by receiver').length >= 5, undefined, {timeout:60000});
      check(creates===1,'already-connected file auto-sends without a new pairing');
      check(await a.getByText('· Verified by receiver',{exact:true}).count()>=4,'already-connected transfer is SHA-256 verified');
    } else console.log('  SKIPPED: real DataChannel, transfer, and SHA-256 assertions (sandbox SDP-only diagnostic)');
    await a.context().close();await b.context().close();

    console.log('[send-first e2e] cancellation, receiver decline, retry, and Devices regression');
    const c=await fresh();await c.getByRole('button',{name:/^Send Pick files/}).click();await choose(c);
    const old=await decodeQr(c);
    await c.getByRole('button',{name:'Cancel connection',exact:true}).click();
    await c.getByText('Connection cancelled',{exact:true}).waitFor();
    check(await c.getByText('phase21.txt',{exact:true}).count()===1,'cancel keeps queued File object');
    check(await c.locator('[data-testid="send-pairing"] img').count()===0,'cancel removes QR immediately');
    await c.getByRole('button',{name:'Try again',exact:true}).click();
    const retryCode=await decodeQr(c);check(retryCode!==old,'retry creates a new one-scan session');
    const d=await fresh();await devicesTab(d);await scan(d,retryCode);
    await d.getByRole('button',{name:'Decline',exact:true}).click();
    await c.locator('[data-testid="send-pairing"][data-state="failed"]').waitFor({timeout:30000});
    check(await c.getByText('phase21.txt',{exact:true}).count()===1,'receiver decline retains sender queue');
    await c.getByRole('button',{name:'Try again',exact:true}).click();await decodeQr(c);
    await c.getByRole('button',{name:'Cancel connection',exact:true}).click();
    await c.getByRole('button',{name:'Remove file',exact:true}).click();
    check(await c.getByRole('tab',{name:'Send (0)'}).getAttribute('aria-selected')==='true','file removal is explicit, Send remains active');
    await devicesTab(c);
    check(await c.getByRole('heading',{name:'This Device'}).isVisible(),'Devices layout/identity card remains');
    check(await c.getByRole('button',{name:/join pairing/i}).first().isVisible(),'manual Join pairing remains');
    await c.getByRole('button',{name:/create pairing/i}).first().click();
    await c.locator('img[alt*="QR code"]').waitFor({timeout:30000});
    check(true,'manual Devices Create pairing still uses live one-scan service');
    await c.context().close();await d.context().close();

    console.log('[send-first e2e] fault injection: unavailable signaling');
    const error=await fresh();await error.route('**/functions/nexdropSignal',route=>route.abort());
    await error.getByRole('button',{name:/^Send Pick files/}).click();await choose(error);
    await error.getByText("Couldn't connect",{exact:true}).waitFor();
    check(await error.getByRole('button',{name:'Try again',exact:true}).isVisible(),'real fetch failure exposes retry');
    check(await error.getByRole('button',{name:'Open Devices',exact:true}).isVisible(),'failure exposes Open Devices');
    check(await error.getByText('phase21.txt',{exact:true}).count()===1,'failure retains queue');
    await error.context().close();

    console.log('[send-first e2e] fault injection: shortened server TTL');
    const expiry=await fresh();
    await expiry.route('**/functions/nexdropSignal',async route=>{
      if(route.request().postDataJSON()?.action!=='create'){await route.continue();return;}
      const response=await route.fetch();const body=await response.json();body.expiresAt=Date.now()+2500;
      await route.fulfill({response,json:body});
    });
    await expiry.getByRole('button',{name:/^Send Pick files/}).click();await choose(expiry);await decodeQr(expiry);
    await expiry.getByText('Pairing expired',{exact:true}).waitFor({timeout:10000});
    check(await expiry.getByRole('button',{name:'Try again',exact:true}).isVisible(),'existing session TTL drives visible expiry and retry');
    check(await expiry.getByText('phase21.txt',{exact:true}).count()===1,'expiry retains queued file');
    check(await expiry.locator('[data-testid="send-pairing"] img').count()===0,'expired QR is not displayed');
    await expiry.context().close();

    console.log('[send-first e2e] fault injection: cancel while create request is pending');
    const race=await fresh();let finished=false;
    await race.route('**/functions/nexdropSignal',async route=>{
      if(route.request().postDataJSON()?.action!=='create'){await route.continue();return;}
      const response=await route.fetch();await new Promise(resolve=>setTimeout(resolve,1500));
      await route.fulfill({response});finished=true;
    });
    await race.getByRole('button',{name:/^Send Pick files/}).click();await choose(race);
    await race.getByRole('button',{name:'Cancel connection',exact:true}).click();
    await race.waitForTimeout(2500);
    check(finished,'delayed live session creation returned after cancel');
    check(await race.locator('[data-testid="send-pairing"]').getAttribute('data-state')==='cancelled','late async create never resurrects cancelled pairing');
    check(await race.locator('[data-testid="send-pairing"] img').count()===0,'no stale QR after cancellation race');
    await race.context().close();
    console.log(`[send-first e2e] ${passed} checks passed${requireConnection?' (FULL real transfer)':' (SDP-only, transfer assertions SKIPPED)'}`);
  } finally { for(const ctx of contexts) await ctx.close();await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve())); }
}
main().catch(error=>{console.error('[send-first e2e] FAILED',error);process.exitCode=1;});
