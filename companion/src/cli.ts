/**
 * NexDrop desktop companion CLI (mission Phase 9) — the native Turbo runtime
 * for Windows/Linux/macOS desktops (Node >= 20).
 *
 *   receive  — advertise on the LAN + accept one authenticated transfer
 *   send     — discover a receiver (or explicit host) + stream one file
 *
 * Data goes file -> socket -> file with bounded memory; SHA-256 is verified
 * durably by the receiver. Speed printed is durable bytes / wall time.
 * The PWA cannot reach these sockets (browser security model); this runtime
 * is for companion-to-companion and (future) Android-native-to-companion.
 */

import { argv, exit, stdin } from 'node:process';
import { basename, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as readline from 'node:readline/promises';
import { newSessionToken } from './handshake';
import { TurboTcpClient, TurboTcpServer } from './tcpTransport';
import { openReader, sha256File } from './fileStream';
import { advertise, discover, newDiscoveryNonce, type DiscoveryBody } from './discovery';

const MB = 1024 * 1024;

function usage(): never {
  console.log(`nexdrop-turbo companion

  npx tsx companion/src/cli.ts receive  --dir ~/Downloads [--name "My laptop"] [--yes]
  npx tsx companion/src/cli.ts send     <file> [--host 192.168.1.20 --session <id> --token <t>] [--port <p>]
                                        (no --host: discovers an advertising receiver on the LAN)`);
  exit(1);
}

function arg(flag: string, def?: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : def;
}

async function cmdReceive(): Promise<void> {
  const dir = resolve(arg('--dir') ?? '.');
  const deviceName = arg('--name') ?? `nexdrop-${randomBytes(2).toString('hex')}`;
  const autoYes = argv.includes('--yes');
  const { token, tokenBytes, sessionId } = newSessionToken();
  const server = new TurboTcpServer();
  server.acceptHandler = async (meta) => {
    console.log(`Incoming: ${meta.name} (${(meta.sizeBytes / MB).toFixed(1)} MB) from session ${sessionId}`);
    let accept = true;
    if (!autoYes) {
      const rl = readline.createInterface({ input: stdin, output: process.stdout });
      const answer = (await rl.question('Accept? [y/N] ')).trim().toLowerCase();
      rl.close();
      accept = answer === 'y' || answer === 'yes';
    }
    console.log(accept ? 'Accepted.' : 'Declined.');
    return { accept, targetPath: resolve(dir, meta.name) };
  };
  server.on('progress', (p: { durableBytes: number; sizeBytes: number; instantSpeed: number }) => {
    if (p.sizeBytes > 0) {
      process.stdout.write(`\rreceiving ${(p.durableBytes / MB).toFixed(1)} / ${(p.sizeBytes / MB).toFixed(1)} MB  ${(p.instantSpeed / MB).toFixed(1)} MB/s   `);
    }
  });
  server.on('verified', (r: { sha256: string; integrity: string }) => {
    console.log(`\nSHA-256 ${r.integrity === 'pass' ? 'VERIFIED' : 'FAILED'}: ${r.sha256}`);
    exit(r.integrity === 'pass' ? 0 : 2);
  });
  const port = await server.listen(0, tokenBytes, sessionId);
  const body: DiscoveryBody = {
    deviceName,
    deviceType: 'desktop',
    capabilities: { lanTcp: true, wifiDirect: false, nativeLocal: false, webrtc: true },
    sessionId,
    token,
    nonce: newDiscoveryNonce(),
  };
  const stopBeacon = advertise(body, port);
  console.log(`NexDrop Turbo receiver ready (session ${sessionId}, port ${port})`);
  console.log(`Saving to ${dir}. Ctrl+C to stop.`);
  const stop = () => {
    stopBeacon();
    server.close();
    exit(130);
  };
  process.on('SIGINT', stop);
}

async function cmdSend(file: string): Promise<void> {
  const path = resolve(file);
  const size = (await openReader(path)).size;
  console.log(`Hashing ${basename(path)} (${(size / MB).toFixed(1)} MB)...`);
  const sha256 = await sha256File(path);
  const token = arg('--token');
  const sessionId = arg('--session');
  let host = arg('--host');
  let port = arg('--port') ? Number(arg('--port')) : 0;

  // Credential root: explicit flags (out-of-band) or the receiver's
  // discovery broadcast (same-LAN, single-use, 10-minute TTL by design).
  let devToken: string | undefined;
  let devSession: string | undefined;
  if (!host) {
    console.log('Discovering NexDrop receivers on the LAN (3s)...');
    const found = await discover(3000);
    if (found.length === 0) {
      console.log('No NexDrop receiver found. Use --host/--port or start one with the receive command.');
      exit(1);
    }
    const dev = found[0];
    host = dev.address;
    port = dev.port;
    devToken = dev.body.token;
    devSession = dev.body.sessionId;
    console.log(`Found "${dev.body.deviceName}" at ${host}:${port}`);
  }
  if (!port) {
    console.log('Missing --port for explicit host');
    exit(1);
  }
  const useToken = token ?? devToken;
  const useSession = sessionId ?? devSession;
  if (!useToken || !useSession) {
    console.log('Missing --token/--session (needed for explicit hosts)');
    exit(1);
  }
  const tokenBytes = Buffer.from(useToken, 'base64url');
  const client = new TurboTcpClient();
  await client.connect(host, port, tokenBytes, useSession);
  console.log(`Connected to ${host}:${port} — streaming...`);
  const reader = await openReader(path);
  const outcome = await client.sendFile({ fileId: 1, name: basename(path), sizeBytes: size, sha256 }, reader.chunks());
  const avg = size / (outcome.elapsedMs / 1000) / MB;
  console.log(
    `Done in ${(outcome.elapsedMs / 1000).toFixed(1)}s — average ${avg.toFixed(1)} MB/s — integrity ${outcome.integrity.toUpperCase()}`
  );
  exit(outcome.integrity === 'pass' ? 0 : 2);
}

async function main(): Promise<void> {
  const cmd = argv[2];
  if (cmd === 'receive') return cmdReceive();
  if (cmd === 'send') {
    const file = argv[3];
    if (!file) return usage();
    return cmdSend(file);
  }
  usage();
}

void main().catch((err) => {
  console.error('nexdrop-turbo error:', err instanceof Error ? err.message : err);
  exit(1);
});
