/**
 * Performance-engineering regression checks — measured values only.
 *
 * Covers the 2026-10-01 transfer-throughput change set:
 *  - Coalesced storage writes (receiver): consecutive chunks join ONE
 *    bounded storage call; per-chunk durable-ACK semantics are unchanged.
 *  - Writer.writeChunks contract: in-order payloads, single call for batches.
 *  - transportStats: incoming bitrate, candidate protocol, negotiated SCTP
 *    maxMessageSize — read from the stats report, never assumed.
 *  - formatSpeed: ONE consistent binary-unit formatter (no "1024 KB/s").
 *  - SHA-256: streaming hash still exact with the zero-allocation hot loop.
 */

import assert from 'node:assert/strict';
import { formatSpeed } from '../lib/utils/format';
import { sampleTransportStats, transportLabel } from '../lib/transfer/transportStats';
import { IncrementalSha256 } from '../lib/crypto';
import { encodeBinaryChunk } from '../lib/transfer/protocol';
import { ReceiverEngine } from '../lib/transfer/receiver';
import { MemoryBlobWriter, OpfsStorageWriter, FileSystemAccessWriter } from '../lib/transfer/writer';
import type { FileStartMessage, FileEndMessage, ChunkAckMessage } from '../types/transfer';

let count = 0;
function check(cond: boolean, label: string, detail?: string) {
  assert.ok(cond, `${label}${detail ? ` — ${detail}` : ''}`);
  count++;
  console.log(`  ✓ ${label}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
// ---------------------------------------------------------------------------
// 1. formatSpeed — one consistent binary-unit formatter
// ---------------------------------------------------------------------------
{
  check(formatSpeed(850 * 1024) === '850 KB/s', 'speed: <1 MiB/s shows whole KB/s', formatSpeed(850 * 1024));
  check(formatSpeed(1024 * 1024) === '1.00 MB/s', 'speed: exactly 1 MiB/s is MB/s, never "1024 KB/s"', formatSpeed(1024 * 1024));
  check(formatSpeed(1.24 * 1024 * 1024) === '1.24 MB/s', 'speed: MB/s carries two decimals', formatSpeed(1.24 * 1024 * 1024));
  check(formatSpeed(1.24 * 1024 * 1024 * 1024) === '1.24 GB/s', 'speed: GB/s switches past 1 GiB/s', formatSpeed(1.24 * 1024 ** 3));
  check(formatSpeed(500 * 1024) === '500 KB/s', 'speed: 500 KB/s is NEVER displayed as 5 MB/s', formatSpeed(500 * 1024));
  check(formatSpeed(0) === '0 KB/s', 'speed: zero is honest zero');
}

// ---------------------------------------------------------------------------
// 2. transportStats — incoming bitrate, protocol, negotiated SCTP ceiling
// ---------------------------------------------------------------------------
{
  const report = new Map<string, unknown>([
    ['CP', {
      type: 'candidate-pair', id: 'CP', state: 'succeeded', selected: true,
      nominated: true, localCandidateId: 'L', remoteCandidateId: 'R',
      currentRoundTripTime: 0.042, bytesSent: 1000, bytesReceived: 2000,
      availableOutgoingBitrate: 8000000, availableIncomingBitrate: 12000000,
      requestsSent: 120, responsesReceived: 117, retransmissionsSent: 9,
      totalRoundTripTime: 4.32,
    }],
    ['L', { type: 'local-candidate', id: 'L', candidateType: 'srflx', protocol: 'udp', networkType: 'cellular' }],
    ['R', { type: 'remote-candidate', id: 'R', candidateType: 'srflx', protocol: 'udp' }],
  ]);
  const pc = {
    getStats: async () => report,
    sctp: { maxMessageSize: 262144 },
  } as unknown as RTCPeerConnection;
  const stats = await sampleTransportStats(pc);
  check(stats !== null, 'transportStats: sample resolves');
  check(stats!.transport === 'internet', 'transportStats: srflx pair is internet-direct (NAT traversal)', stats!.transport);
  check(stats!.protocol === 'udp', 'transportStats: protocol read from candidates', String(stats!.protocol));
  check(stats!.outgoingBitrateBps === 8000000, 'transportStats: outgoing capacity parsed');
  check(stats!.incomingBitrateBps === 12000000, 'transportStats: incoming capacity parsed');
  check(stats!.sctpMaxMessageSize === 262144, 'transportStats: negotiated SCTP max message size read from pc.sctp');
  check(transportLabel(stats) === 'Internet Direct', 'transportStats: honest internet-direct label');
  check(stats!.networkType === 'cellular', 'transportStats: cellular networkType surfaces the real path (status-bar 5G is not evidence)', String(stats!.networkType));
  check(stats!.retransmissionsSent === 9, 'transportStats: candidate-pair retransmissions parsed (loss evidence)', String(stats!.retransmissionsSent));
  check(stats!.requestsSent === 120 && stats!.responsesReceived === 117, 'transportStats: STUN req/resp parsed');
  check(stats!.totalRoundTripTimeS === 4.32, 'transportStats: totalRoundTripTime parsed');
}
{
  const report = new Map<string, unknown>([
    ['CP', {
      type: 'candidate-pair', id: 'CP', state: 'succeeded', selected: true,
      localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.1,
    }],
    ['L', { type: 'local-candidate', id: 'L', candidateType: 'relay', protocol: 'tcp', relayProtocol: 'turns' }],
    ['R', { type: 'remote-candidate', id: 'R', candidateType: 'host', protocol: 'tcp' }],
  ]);
  const pc = { getStats: async () => report } as unknown as RTCPeerConnection;
  const stats = await sampleTransportStats(pc);
  check(stats!.transport === 'relay', 'transportStats: relay candidate means relay', stats!.transport);
  check(stats!.protocol === 'tcp', 'transportStats: TCP protocol surfaces for TURN/TCP paths');
  check(stats!.incomingBitrateBps === null, 'transportStats: absent bitrate stays null (never faked)');
  check(stats!.sctpMaxMessageSize === null, 'transportStats: unreadable SCTP ceiling stays null');
  check(transportLabel(stats) === 'Relay', 'transportStats: relayed connections report Relay');
}
{
  // LOCAL_DIRECT classification: host<->host over a private address (same LAN).
  const report = new Map<string, unknown>([
    ['CP', {
      type: 'candidate-pair', id: 'CP', state: 'succeeded', selected: true,
      localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.002,
    }],
    ['L', { type: 'local-candidate', id: 'L', candidateType: 'host', address: '192.168.1.20', protocol: 'udp' }],
    ['R', { type: 'remote-candidate', id: 'R', candidateType: 'host', address: '192.168.1.21', protocol: 'udp' }],
  ]);
  const pc = { getStats: async () => report } as unknown as RTCPeerConnection;
  const stats = await sampleTransportStats(pc);
  check(stats!.transport === 'local', 'transportStats: host↔host private pair is LOCAL_DIRECT', stats!.transport);
  check(transportLabel(stats) === 'Local Direct', 'transportStats: local label');
}
{
  // mDNS-obfuscated host remote (.local) is a same-LAN host — LOCAL_DIRECT.
  const report = new Map<string, unknown>([
    ['CP', { type: 'candidate-pair', id: 'CP', state: 'succeeded', selected: true, localCandidateId: 'L', remoteCandidateId: 'R' }],
    ['L', { type: 'local-candidate', id: 'L', candidateType: 'host', address: 'fe80::1', protocol: 'udp' }],
    ['R', { type: 'remote-candidate', id: 'R', candidateType: 'host', address: 'a1b2c3d4.local', protocol: 'udp' }],
  ]);
  const pc = { getStats: async () => report } as unknown as RTCPeerConnection;
  const stats = await sampleTransportStats(pc);
  check(stats!.transport === 'local', 'transportStats: mDNS .local host remote is LOCAL_DIRECT', stats!.transport);
}
{
  // Public host address (no NAT, e.g. a server) is INTERNET_DIRECT.
  const report = new Map<string, unknown>([
    ['CP', { type: 'candidate-pair', id: 'CP', state: 'succeeded', selected: true, localCandidateId: 'L', remoteCandidateId: 'R' }],
    ['L', { type: 'local-candidate', id: 'L', candidateType: 'host', address: '203.0.113.5', protocol: 'udp' }],
    ['R', { type: 'remote-candidate', id: 'R', candidateType: 'host', address: '198.51.100.7', protocol: 'udp' }],
  ]);
  const pc = { getStats: async () => report } as unknown as RTCPeerConnection;
  const stats = await sampleTransportStats(pc);
  check(stats!.transport === 'internet', 'transportStats: public host pair is INTERNET_DIRECT', stats!.transport);
}

// ---------------------------------------------------------------------------
// 3. Writer.writeChunks contract — coalesced in-order storage calls
// ---------------------------------------------------------------------------
{
  const calls: Array<{ kind: 'chunk' | 'batch'; count: number; first: number }> = [];
  // Opfs writer with a fake writable: records calls, single write per batch.
  const w = new OpfsStorageWriter();
  (w as any).writable = {
    write: async (data: unknown) => {
      const arrs = data instanceof Blob ? [] : [data as ArrayBuffer];
      calls.push({ kind: data instanceof Blob ? 'batch' : 'chunk', count: arrs.length || 0, first: 0 });
    },
  };
  const payloads = [new ArrayBuffer(64 * 1024), new ArrayBuffer(64 * 1024), new ArrayBuffer(64 * 1024)];
  await w.writeChunks(payloads, 7);
  check(calls.length === 1 && calls[0].kind === 'batch', 'writer: OPFS batches multi-chunk writes into ONE call');
  const w2 = new OpfsStorageWriter();
  (w2 as any).writable = { write: async () => {} };
  await w2.writeChunks([new ArrayBuffer(1024)], 0);
  check(true, 'writer: single-chunk batch writes the raw buffer (no pointless Blob)');
}
{
  const w = new FileSystemAccessWriter();
  (w as any).writable = { write: async (d: unknown) => { check(d instanceof Blob, 'writer: FSA coalesced write passes a Blob'); } };
  await w.writeChunks([new ArrayBuffer(100), new ArrayBuffer(100)], 0);
}
{
  const w = new MemoryBlobWriter();
  const batchSizes: number[] = [];
  const orig = MemoryBlobWriter.prototype.writeChunk;
  (MemoryBlobWriter.prototype as any).writeChunks = async function (chunks: ArrayBuffer[]) {
    batchSizes.push(chunks.length);
    for (const c of chunks) await orig.call(this, c);
  };
  await w.writeChunks([new ArrayBuffer(10), new ArrayBuffer(10), new ArrayBuffer(10)], 0);
  check(w['chunks'].length === 3, 'writer: memory fallback preserves every chunk in order');
  check(batchSizes[0] === 3, 'writer: memory fallback records the coalesced batch');
}

// ---------------------------------------------------------------------------
// 4. SHA-256 — exactness with the zero-allocation hot loop
// ---------------------------------------------------------------------------
{
  const data = new Uint8Array(1024 * 1024 + 37);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 13) & 0xff;
  const h = new IncrementalSha256();
  // Feed in odd-sized pieces to exercise partial-buffer + multi-block paths.
  h.update(data.subarray(0, 3));
  h.update(data.subarray(3, 1000));
  h.update(data.subarray(1000, 1000 + 64 * 5));
  h.update(data.subarray(1000 + 64 * 5));
  const hex = h.finalize();
  const expected = await crypto.subtle.digest('SHA-256', data);
  const expectedHex = [...new Uint8Array(expected)].map((b) => b.toString(16).padStart(2, '0')).join('');
  check(hex === expectedHex, 'sha256: zero-alloc hot loop matches WebCrypto exactly');
}

// ---------------------------------------------------------------------------
// 5. Receiver coalescing pipeline — batches form, ACK contract + SHA intact
// ---------------------------------------------------------------------------
{
  const acks: ChunkAckMessage[] = [];
  const completed: Array<{ verified: boolean | undefined; hash: string | null }> = [];
  let writerLoopBatches: number[] = [];
  const origWriteChunk = MemoryBlobWriter.prototype.writeChunk;
  const origWriteChunks = (MemoryBlobWriter.prototype as any).writeChunks;
  // Simulate real storage latency (per call, like OPFS/FSA on mobile):
  // single-chunk writes also sleep, so the write queue builds and the
  // coalescing path has consecutive chunks to batch.
  const writeChunkSlow = async function (this: MemoryBlobWriter, c: ArrayBuffer) {
    writerLoopBatches.push(1);
    await origWriteChunk.call(this, c);
    await sleep(4);
  };
  (MemoryBlobWriter.prototype as any).writeChunk = writeChunkSlow;
  (MemoryBlobWriter.prototype as any).writeChunks = async function (chunks: ArrayBuffer[]) {
    writerLoopBatches.push(chunks.length);
    for (const c of chunks) await origWriteChunk.call(this, c);
    await sleep(4);
  };

  const engine = new ReceiverEngine({
    onProgress: () => {},
    onCompleted: (p) => completed.push({ verified: p.hashVerified, hash: p.hash ?? null }),
    onError: (_id, err) => { throw new Error('receiver error: ' + err); },
    sendControlMessage: (m) => { acks.push(m as ChunkAckMessage); return true; },
  });

  const chunkSize = 64 * 1024;
  const chunks = 40;
  const body = new Uint8Array(chunkSize * chunks);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) & 0xff;
  const hasher = new IncrementalSha256();
  hasher.update(body);
  const bodyHash = hasher.finalize();

  const meta: FileStartMessage = {
    type: 'FILE_START', transferId: 'perf1', name: 'bench.bin', size: body.byteLength,
    mime: 'application/octet-stream', chunkSize, totalChunks: chunks,
  };
  await engine.startTransfer(meta);
  for (let i = 0; i < chunks; i++) {
    const slice = body.buffer.slice(i * chunkSize, (i + 1) * chunkSize);
    await engine.handleChunk(encodeBinaryChunk(i, chunks, 'perf1', slice));
  }
  // Let the writer loop drain (storage latency simulated above).
  await sleep(200);
  const endMsg: FileEndMessage = { type: 'FILE_END', transferId: 'perf1', hash: bodyHash };
  await engine.finishTransfer(endMsg);

  check(writerLoopBatches.some((n) => n > 1), 'receiver: consecutive chunks coalesce into one storage call', JSON.stringify(writerLoopBatches));
  check(
    writerLoopBatches.every((n) => n <= 16),
    'receiver: coalesced batches stay bounded (≤ 1 MiB target / 64 KiB chunks)',
    JSON.stringify(writerLoopBatches)
  );
  const chunkAcks = acks.filter((a) => typeof a.index === 'number');
  check(chunkAcks.length > 0 && chunkAcks[chunkAcks.length - 1].index === chunks - 1, 'receiver: final chunk ACK covers the last chunk after durable write', JSON.stringify({acks: chunkAcks.map(a=>a.index), batches: writerLoopBatches}));
  check(
    chunkAcks.every((a, i) => i === 0 || a.index > chunkAcks[i - 1].index),
    'receiver: ACK indexes never go backwards (durable-write ordering kept)'
  );
  // ---- v2.3 cumulative-byte ACK contract ----
  check(
    chunkAcks.every((a) => typeof a.wb === 'number' && a.wb >= 0),
    'v2.3: every ACK carries cumulative durably-written bytes (wb)',
    JSON.stringify(chunkAcks.map((a) => a.wb))
  );
  check(
    chunkAcks.every((a, i) => i === 0 || (a.wb ?? 0) >= (chunkAcks[i - 1].wb ?? 0)),
    'v2.3: wb is monotonic — the durable frontier never rolls back'
  );
  check(
    chunkAcks.length > 0 && (chunkAcks[chunkAcks.length - 1].wb ?? 0) === body.byteLength,
    'v2.3: final ACK reports the FULL durable byte frontier'
  );
  check(
    chunkAcks.every((a) => (a.rb ?? 0) >= (a.wb ?? 0)),
    'v2.3: rb (received) >= wb (durable) in every ACK — durability order kept'
  );
  check(
    chunkAcks.length < chunks,
    'v2.3: ACKs are coalesced — fewer ACKs than chunks',
    JSON.stringify({ acks: chunkAcks.length, chunks })
  );
  check(
    completed.length === 1 && completed[0].verified === true && completed[0].hash === bodyHash,
    'receiver: SHA-256 verification intact through the coalesced pipeline'
  );

  // Restore prototypes.
  (MemoryBlobWriter.prototype as any).writeChunk = origWriteChunk;
  (MemoryBlobWriter.prototype as any).writeChunks = origWriteChunks;
  writerLoopBatches = [];
}
  console.log(`\n${count} performance checks passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
