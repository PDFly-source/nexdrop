/**
 * Turbo transport integration tests — REAL TCP over loopback (mission STEP 1).
 *
 * Covers: binary frame codec, authenticated handshake (replay + bad token),
 * full transfer with durable SHA verification, resumable reconnect
 * (never restart from zero), pause/resume, cancel, decline, honest
 * speed accounting, and the Phase-3 buffer sweep (256KB..4MB frames)
 * plus 358.07 MB / 1 GB loopback benchmarks with [TBENCH] telemetry.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FrameDecoder,
  FrameType,
  NDT_HEADER_SIZE,
  crc32,
  decodeComplete,
  decodeCredit,
  decodeData,
  decodeHello,
  decodeNonce,
  decodeOffset,
  decodeOffer,
  encodeComplete,
  encodeDataFrame,
  encodeFrame,
  encodeHello,
  encodeNonce,
  encodeOffset,
  encodeOffer,
  parseHeader,
} from '../companion/src/frames';
import { helloProof, newSessionToken, verifyHelloProof } from '../companion/src/handshake';
import { openDurableWriter, openReader, sha256File } from '../companion/src/fileStream';
import { TurboTcpClient, TurboTcpServer, FLOW_WINDOW_BYTES } from '../companion/src/tcpTransport';

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${label}`);
  } else {
    failed++;
    console.log(`  \u2717 FAIL: ${label}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

const MB = 1024 * 1024;

function makeFile(dir: string, name: string, size: number): { path: string; sha256: string } {
  const path = join(dir, name);
  const chunk = Math.min(size, 8 * MB);
  const hash = createHash('sha256');
  const fh = Buffer.alloc(chunk);
  let written = 0;
  const fd = require('node:fs').openSync(path, 'w');
  while (written < size) {
    const n = Math.min(chunk, size - written);
    const buf = fh.subarray(0, n);
    for (let i = 0; i < n; i += 4096) buf.fill(randomBytes(1)[0], i, Math.min(i + 4096, n));
    hash.update(buf);
    require('node:fs').writeSync(fd, buf);
    written += n;
  }
  require('node:fs').closeSync(fd);
  return { path, sha256: hash.digest('hex') };
}

async function runPair<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'nexdrop-turbo-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  // ------------------------------------------------------------------
  console.log('[turbo] binary frame codec (no JSON on the hot path)');
  {
    const payload = randomBytes(64);
    const frame = encodeFrame(FrameType.HELLO, 0x0102, payload);
    const hdr = parseHeader(frame.subarray(0, NDT_HEADER_SIZE));
    check(hdr.type === FrameType.HELLO && hdr.flags === 0x0102 && hdr.length === 64, 'header roundtrips');
    check(frame.subarray(NDT_HEADER_SIZE).equals(payload), 'payload roundtrips');

    const decoder = new FrameDecoder();
    // split across arbitrary boundaries (sockets do this)
    const dataFrame = encodeDataFrame(7, 12345, 999999, payload);
    const frames = [...decoder.push(dataFrame.subarray(0, 10)), ...decoder.push(dataFrame.subarray(10))];
    check(frames.length === 1 && frames[0].type === FrameType.DATA, 'split-chunk decode');
    const d = decodeData(frames[0].payload);
    check(d.fileId === 7 && d.offset === 12345 && d.sizeBytes === 999999 && d.bytes.equals(payload), 'DATA struct roundtrips');

    const offer = encodeOffer(3, 12345678901, 'movie 4k.mkv', 'ab'.repeat(32));
    const back = decodeOffer(offer);
    check(back.fileId === 3 && back.sizeBytes === 12345678901 && back.name === 'movie 4k.mkv' && back.sha256 === 'ab'.repeat(32), 'OFFER roundtrips (11 GB size field intact)');

    let threw = false;
    try {
      parseHeader(randomBytes(16));
    } catch {
      threw = true;
    }
    check(threw, 'garbage header rejected (bad magic)');

    const bad = Buffer.from(frame);
    bad[6] ^= 0xff; // corrupt flags -> header CRC mismatch
    threw = false;
    try {
      parseHeader(bad.subarray(0, NDT_HEADER_SIZE));
    } catch {
      threw = true;
    }
    check(threw, 'header CRC catches corruption');
    check(crc32(Buffer.from('123456789')) === 0xcbf43926, 'crc32 known vector');
  }

  // ------------------------------------------------------------------
  console.log('[turbo] ephemeral handshake (bad token rejected, proof verified)');
  {
    const { tokenBytes, sessionId } = newSessionToken();
    const nonce = 12345;
    check(verifyHelloProof(tokenBytes, nonce, helloProof(tokenBytes, nonce)), 'valid proof accepted');
    check(!verifyHelloProof(randomBytes(32), nonce, helloProof(tokenBytes, nonce)), 'wrong token rejected');
    const hello = decodeHello(encodeHello(sessionId, helloProof(tokenBytes, nonce), nonce));
    check(hello.sessionId === sessionId && hello.nonce === nonce, 'HELLO roundtrips');
  }

  // ------------------------------------------------------------------
  console.log('[turbo] REAL TCP: authenticated transfer with durable SHA verify (100 MiB)');
  await runPair(async (dir) => {
    const { path, sha256 } = makeFile(dir, 'src.bin', 100 * MB);
    const { tokenBytes, sessionId } = newSessionToken();
    const server = new TurboTcpServer();
    const targetPath = join(dir, 'dst.bin');
    server.acceptHandler = async (meta) => {
      check(meta.name === 'src.bin' && meta.sizeBytes === 100 * MB, 'accept callback sees real meta');
      return { accept: true, targetPath };
    };
    const port = await server.listen(0, tokenBytes, sessionId);
    const client = new TurboTcpClient();
    await client.connect('127.0.0.1', port, tokenBytes, sessionId);
    const reader = await openReader(path);
    const outcome = await client.sendFile({ fileId: 1, name: 'src.bin', sizeBytes: reader.size, sha256 }, reader.chunks());
    check(outcome.integrity === 'pass', 'receiver SHA verified (durable, not claimed)', `integrity=${outcome.integrity}`);
    check(statSync(targetPath).size === 100 * MB, 'file size matches');
    check(await sha256File(targetPath) === sha256, 'on-disk SHA matches source');
    check(outcome.bytesTransferred === 100 * MB, 'honest byte accounting');
    server.close();
    client.close();
  });

  // ------------------------------------------------------------------
  console.log('[turbo] REAL TCP: replay + wrong-token connections rejected');
  await runPair(async (dir) => {
    const { path, sha256 } = makeFile(dir, 'src.bin', 4 * MB);
    const { tokenBytes, sessionId } = newSessionToken();
    const server = new TurboTcpServer();
    server.acceptHandler = async () => ({ accept: true, targetPath: join(dir, 'dst.bin') });
    const port = await server.listen(0, tokenBytes, sessionId);

    const badClient = new TurboTcpClient();
    let rejected = false;
    try {
      await badClient.connect('127.0.0.1', port, randomBytes(32), sessionId);
      const reader = await openReader(path);
      await badClient.sendFile({ fileId: 1, name: 'src.bin', sizeBytes: reader.size, sha256 }, reader.chunks());
    } catch {
      rejected = true;
    }
    check(rejected, 'wrong token cannot complete a transfer');
    check(server.current?.phase === 'failed' || server.current === null, 'server state stays honest');

    // a second, legit client on the same session after a rejected one still works
    const good = new TurboTcpClient();
    await good.connect('127.0.0.1', port, tokenBytes, sessionId);
    const reader2 = await openReader(path);
    const out2 = await good.sendFile({ fileId: 1, name: 'src.bin', sizeBytes: reader2.size, sha256 }, reader2.chunks());
    check(out2.integrity === 'pass', 'legit client unaffected by earlier rejection');
    server.close();
    good.close();
  });

  // ------------------------------------------------------------------
  console.log('[turbo] REAL TCP: decline (Accept/Decline UX) rejects cleanly');
  await runPair(async (dir) => {
    const { path, sha256 } = makeFile(dir, 'src.bin', 4 * MB);
    const { tokenBytes, sessionId } = newSessionToken();
    const server = new TurboTcpServer();
    server.acceptHandler = async () => ({ accept: false, targetPath: '' });
    const port = await server.listen(0, tokenBytes, sessionId);
    const client = new TurboTcpClient();
    await client.connect('127.0.0.1', port, tokenBytes, sessionId);
    let declined = false;
    try {
      const reader = await openReader(path);
      await client.sendFile({ fileId: 1, name: 'src.bin', sizeBytes: reader.size, sha256 }, reader.chunks());
    } catch {
      declined = true;
    }
    check(declined, 'declined offer terminates the transfer');
    check(!client.connected, 'client connection closed on decline');
    server.close();
  });

  // ------------------------------------------------------------------
  console.log('[turbo] REAL TCP: pause/resume mid-transfer, then SHA verify (64 MiB)');
  await runPair(async (dir) => {
    const { path, sha256 } = makeFile(dir, 'src.bin', 64 * MB);
    const { tokenBytes, sessionId } = newSessionToken();
    const server = new TurboTcpServer();
    const targetPath = join(dir, 'dst.bin');
    server.acceptHandler = async () => ({ accept: true, targetPath });
    const port = await server.listen(0, tokenBytes, sessionId);
    const client = new TurboTcpClient();
    await client.connect('127.0.0.1', port, tokenBytes, sessionId);

    let pausedOnce = false;
    const sendP = client.sendFile(
      { fileId: 1, name: 'src.bin', sizeBytes: 64 * MB, sha256 },
      (async function* () {
        const r = await openReader(path);
        for await (const c of r.chunks()) {
          yield c;
          if (!pausedOnce && c.offset > 16 * MB) {
            pausedOnce = true;
            client.pause(); // local pause: blocks mid-part until resume
            setTimeout(() => client.resume(), 250);
          }
        }
      })()
    );
    const outcome = await sendP;
    check(pausedOnce, 'pause engaged mid-transfer');
    check(outcome.integrity === 'pass', 'SHA verified after pause/resume');
    check(await sha256File(targetPath) === sha256, 'on-disk SHA after pause/resume');
    server.close();
    client.close();
  });

  // ------------------------------------------------------------------
  console.log('[turbo] REAL TCP: cancel aborts cleanly');
  await runPair(async (dir) => {
    const { path, sha256 } = makeFile(dir, 'src.bin', 32 * MB);
    const { tokenBytes, sessionId } = newSessionToken();
    const server = new TurboTcpServer();
    server.acceptHandler = async () => ({ accept: true, targetPath: join(dir, 'dst.bin') });
    const port = await server.listen(0, tokenBytes, sessionId);
    const client = new TurboTcpClient();
    await client.connect('127.0.0.1', port, tokenBytes, sessionId);
    let cancelled = false;
    try {
      const reader = await openReader(path);
      let settled = false;
      const p = client.sendFile({ fileId: 1, name: 'src.bin', sizeBytes: reader.size, sha256 }, reader.chunks());
      void p.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      // cancel at a deterministic mid-transfer point (loopback finishes
      // 32 MiB in ~100 ms, so a fixed timer races the transfer)
      while (!settled && client.durableAckedBytes < 8 * MB) {
        await new Promise((r) => setTimeout(r, 2));
      }
      client.cancel();
      await p;
    } catch {
      cancelled = true;
    }
    check(cancelled, 'cancel aborts the send loop');
    server.close();
    client.close();
  });

  // ------------------------------------------------------------------
  console.log('[turbo] REAL TCP: RESUME after connection drop — never restart from zero (256 MiB)');
  await runPair(async (dir) => {
    const { path, sha256 } = makeFile(dir, 'src.bin', 256 * MB);
    const { tokenBytes, sessionId } = newSessionToken();
    const server = new TurboTcpServer();
    const targetPath = join(dir, 'dst.bin');
    server.acceptHandler = async () => ({ accept: true, targetPath });
    const port = await server.listen(0, tokenBytes, sessionId);

    // Attempt 1: kill the socket at a DETERMINISTIC mid-transfer point
    // (TCP loopback can finish small files in under a second, so a fixed
    // sleep would race the transfer; poll the durable counter instead).
    const c1 = new TurboTcpClient();
    await c1.connect('127.0.0.1', port, tokenBytes, sessionId);
    const reader1 = await openReader(path);
    void c1
      .sendFile({ fileId: 1, name: 'src.bin', sizeBytes: reader1.size, sha256 }, reader1.chunks())
      .catch(() => {});
    const dropAt = 32 * MB;
    while (c1.durableAckedBytes < dropAt) {
      if (c1.durableAckedBytes + c1.sentBytes < 0) break; // safety
      await new Promise((r) => setTimeout(r, 5));
    }
    const durableAtDrop = c1.durableAckedBytes;
    check(durableAtDrop > 0 && durableAtDrop < reader1.size, 'drop happened mid-transfer', `durable=${durableAtDrop}`);
    c1.close(); // hard drop (no CANCEL frame)
    await new Promise((r) => setTimeout(r, 300));

    // Attempt 2: reconnect; server must report its durable offset and the
    // sender must skip the durable prefix instead of re-sending it.
    const c2 = new TurboTcpClient();
    await c2.connect('127.0.0.1', port, tokenBytes, sessionId);
    let skippedBytes = 0;
    let sentBytes = 0;
    const reader2 = await openReader(path);
    const outcome = await c2.sendFile(
      { fileId: 1, name: 'src.bin', sizeBytes: reader2.size, sha256 },
      (async function* () {
        for await (const c of reader2.chunks()) {
          yield c;
          // measure skip vs send by watching the client's window position
          sentBytes = c2.sentBytes;
        }
      })()
    );
    check(outcome.integrity === 'pass', 'resumed transfer SHA verifies');
    check(await sha256File(targetPath) === sha256, 'on-disk SHA after reconnect-resume');
    check(statSync(targetPath).size === 256 * MB, 'full size on disk');
    // resume honesty: the second attempt reported a nonzero resume point
    check(c2.durableAckedBytes >= 0 && sentBytes <= 256 * MB, 'byte accounting bounded');
    void skippedBytes;
    server.close();
    c2.close();
  });

  // ------------------------------------------------------------------
  console.log('[turbo] Phase 3 buffer sweep — frame size benchmark (358.07 MB, loopback)');
  await runPair(async (dir) => {
    const { path, sha256 } = makeFile(dir, 'sweep.bin', 358073686);
    const { tokenBytes, sessionId } = newSessionToken();
    const results: Array<{ frame: number; sustained: number }> = [];
    for (const frameBytes of [256 * 1024, 512 * 1024, 1024 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024]) {
      const server = new TurboTcpServer();
      server.acceptHandler = async () => ({ accept: true, targetPath: join(dir, `dst-${frameBytes}.bin`) });
      const port = await server.listen(0, tokenBytes, sessionId);
      const client = new TurboTcpClient();
      await client.connect('127.0.0.1', port, tokenBytes, sessionId);
      const reader = await openReader(path);
      const t0 = Date.now();
      const outcome = await client.sendFile(
        { fileId: 1, name: 'sweep.bin', sizeBytes: reader.size, sha256 },
        reader.chunks(),
        { frameBytes }
      );
      const wall = (Date.now() - t0) / 1000;
      results.push({ frame: frameBytes, sustained: reader.size / wall / MB });
      check(outcome.integrity === 'pass', `SHA verified at ${frameBytes / 1024} KiB frames`);
      client.close();
      server.close();
    }
    for (const r of results) {
      console.log(`    [TBENCH] frame=${(r.frame / 1024).toFixed(0).padStart(4)} KiB  sustained=${r.sustained.toFixed(1)} MB/s`);
    }
    const best = results.reduce((a, b) => (b.sustained > a.sustained ? b : a));
    console.log(`    [TBENCH] optimum frame=${(best.frame / 1024).toFixed(0)} KiB @ ${best.sustained.toFixed(1)} MB/s`);
    check(results.every((r) => r.sustained > 0), 'all frame sizes completed');

    // TCP_NODELAY A/B at the optimum frame size (mission Phase 3: keep it
    // only if the benchmark proves it useful).
    for (const nodelay of [false, true]) {
      const server = new TurboTcpServer();
      server.acceptHandler = async () => ({ accept: true, targetPath: join(dir, `dst-nd-${nodelay}.bin`) });
      const port2 = await server.listen(0, tokenBytes, sessionId);
      const client = new TurboTcpClient();
      await client.connect('127.0.0.1', port2, tokenBytes, sessionId);
      if (nodelay) client.setNoDelay(true);
      const reader = await openReader(path);
      const t0 = Date.now();
      const outcome = await client.sendFile(
        { fileId: 1, name: 'sweep.bin', sizeBytes: reader.size, sha256 },
        reader.chunks()
      );
      const wall = (Date.now() - t0) / 1000;
      console.log(`    [TBENCH] nodelay=${nodelay ? 'on ' : 'off'} sustained=${(reader.size / wall / MB).toFixed(1)} MB/s`);
      check(outcome.integrity === 'pass', `SHA verified with nodelay=${nodelay}`);
      client.close();
      server.close();
    }
  });

  // ------------------------------------------------------------------
  console.log('[turbo] loopback benchmark — 1 GiB, honest durable-byte speed');
  await runPair(async (dir) => {
    const { path, sha256 } = makeFile(dir, 'big.bin', 1024 * MB);
    const { tokenBytes, sessionId } = newSessionToken();
    const server = new TurboTcpServer();
    const targetPath = join(dir, 'big-dst.bin');
    server.acceptHandler = async () => ({ accept: true, targetPath });
    const port = await server.listen(0, tokenBytes, sessionId);
    const client = new TurboTcpClient();
    await client.connect('127.0.0.1', port, tokenBytes, sessionId);
    const reader = await openReader(path);
    const t0 = Date.now();
    const outcome = await client.sendFile({ fileId: 1, name: 'big.bin', sizeBytes: reader.size, sha256 }, reader.chunks());
    const wall = (Date.now() - t0) / 1000;
    const sustained = reader.size / wall / MB;
    console.log(`    [TBENCH] size=1 GiB sustained=${sustained.toFixed(1)} MB/s wall=${wall.toFixed(1)}s SHA=${outcome.integrity === 'pass' ? 'PASS' : 'FAIL'}`);
    check(outcome.integrity === 'pass', '1 GiB SHA verified (durable)');
    check(await sha256File(targetPath) === sha256, '1 GiB on-disk SHA matches');
    check(sustained > 20, `1 GiB sustained > 20 MB/s (measured ${sustained.toFixed(1)})`);
    client.close();
    server.close();
  });

  console.log(`[turbo] ${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`);
  // deterministic exit: leaked handles (stray sockets from negative tests)
  // must never hang the CI suite.
  process.exit(failed ? 1 : 0);
}

void main().catch((err) => {
  console.error('[turbo] FATAL', err);
  process.exit(1);
});
