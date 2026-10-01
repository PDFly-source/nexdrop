/**
 * TURBO v2.4 — bounded post-send hash pipeline (2026-10-01 directive, Phases 2/3/6).
 *
 * v2.3 serialized the pump: slice → hash → encode → send, with the JS
 * SHA-256 (9–10 ms per 128 KiB chunk, ~13.7 MB/s ceiling) on the critical
 * path of EVERY chunk. The v2.4 pipeline moves hashing OFF the send path:
 *
 *   slice → encode → send ──► push buffer to hash pipeline (post-send)
 *
 * The buffer is already consumed by encode (encodeBinaryChunk copies into a
 * fresh packet; encryption produces its own buffer), so the pipeline owns
 * it outright. Bounded memory: queued un-hashed bytes are capped
 * (HASH_QUEUE_CAP); the pump awaits the pipeline drain at the top of the
 * loop, never queuing unboundedly.
 *
 * Engines:
 *  - 'merkle'  — MerkleHasher: native crypto.subtle block digests
 *                (off-main-thread, fastest; wire algo 's256m', negotiated).
 *  - 'worker'  — classic streaming SHA-256 inside a dedicated Web Worker,
 *                transferable buffers, ZERO wire change (legacy-compatible).
 *  - 'inline'  — v2.3 behavior exactly (pre-send, main thread, no pipeline).
 *
 * Selection is measured, not assumed: each engine reports its real hash
 * cost; the benchmark A/B matrix (bench_hash_mode) compares them and the
 * production default is chosen from those measurements.
 *
 * Resume/cancel safety: the pump pushes each sent chunk exactly once
 * (send and push happen in the same loop iteration, no await between them);
 * resume re-enters at currentChunkIndex, pushing continues in order. The
 * hash frontier can only LAG the send frontier — never skip or re-consume.
 */

import { MerkleHasher } from './merkle';

export type HashMode = 'inline' | 'merkle' | 'worker';

/** Queued un-hashed bytes bound (memory). Overridable for sweeps. */
export function hashQueueCapBytes(): number {
  const mb = Number((globalThis as Record<string, unknown>).__NEXDROP_HASH_QUEUE_MB ?? 0);
  return mb > 0 ? mb * 1024 * 1024 : 8 * 1024 * 1024;
}

export interface HashPipeline {
  readonly mode: HashMode;
  /** Push the next plaintext chunk buffer (post-send; owned by the pipeline). */
  push(buf: ArrayBuffer, bytes: number): void;
  /** Un-hashed queued bytes (memory accounting). */
  lagBytes(): number;
  /** Wait until lagBytes() <= cap. */
  drainTo(cap: number): Promise<void>;
  /** Final digest — drains everything first. */
  finalize(): Promise<string>;
  /** Discard state (cancel / new transfer). */
  reset(): void;
  /** Measured hashing CPU/wall time inside the engine (ms). */
  hashCpuMs(): number;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Merkle engine (native block hashing)
// ---------------------------------------------------------------------------
export class MerkleHashPipeline implements HashPipeline {
  readonly mode = 'merkle' as const;
  private hasher = new MerkleHasher();
  private lag = 0;
  private waiters = new Set<() => void>();
  private cpuMs = 0;

  push(buf: ArrayBuffer, bytes: number): void {
    this.lag += bytes;
    const p = this.hasher.update(buf);
    void p.then(() => {
      this.cpuMs = this.hasher.hashCpuMs;
      this.lag -= bytes;
      for (const w of [...this.waiters]) {
        if (this.lag <= (w as unknown as { cap: number }).cap) w();
      }
    });
  }

  lagBytes(): number {
    return this.lag;
  }

  async drainTo(cap: number): Promise<void> {
    if (this.lag <= cap) return;
    await new Promise<void>((resolve) => {
      const w = () => {
        if (this.lag <= cap) {
          this.waiters.delete(w);
          resolve();
        }
      };
      (w as unknown as { cap: number }).cap = cap;
      this.waiters.add(w);
    });
  }

  async finalize(): Promise<string> {
    const hex = await this.hasher.finalize();
    this.lag = 0;
    this.cpuMs = this.hasher.hashCpuMs;
    return hex;
  }

  reset(): void {
    this.hasher = new MerkleHasher();
    this.lag = 0;
    this.cpuMs = 0;
    this.waiters.clear();
  }

  hashCpuMs(): number {
    return this.cpuMs;
  }

  dispose(): void {
    this.waiters.clear();
  }
}

// ---------------------------------------------------------------------------
// Worker engine — classic streaming SHA-256 in a dedicated thread
// ---------------------------------------------------------------------------
/** Standalone streaming SHA-256 worker source (public-domain algorithm
 *  structure; identical digest to lib/crypto IncrementalSha256). */
export const WORKER_SRC = String.raw`
let h = new Uint32Array(8), w = new Uint32Array(64), buf = new Uint8Array(64), bl = 0, total = 0;
const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
function init() {
  h[0]=0x6a09e667; h[1]=0xbb67ae85; h[2]=0x3c6ef372; h[3]=0xa54ff53a;
  h[4]=0x510e527f; h[5]=0x9b05688c; h[6]=0x1f83d9ab; h[7]=0x5be0cd19;
  total = 0; bl = 0;
}
function block(bytes, off) {
  for (let i = 0; i < 16; i++)
    w[i] = (bytes[off+i*4] << 24) | (bytes[off+i*4+1] << 16) | (bytes[off+i*4+2] << 8) | bytes[off+i*4+3];
  for (let i = 16; i < 64; i++) {
    const s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >>> 3);
    const s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >>> 10);
    w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
  }
  let a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
  for (let i = 0; i < 64; i++) {
    const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
    const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    hh=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
  }
  h[0]=(h[0]+a)|0; h[1]=(h[1]+b)|0; h[2]=(h[2]+c)|0; h[3]=(h[3]+d)|0;
  h[4]=(h[4]+e)|0; h[5]=(h[5]+f)|0; h[6]=(h[6]+g)|0; h[7]=(h[7]+hh)|0;
}
function update(u8) {
  total += u8.length;
  let off = 0;
  if (bl > 0) {
    const take = Math.min(64 - bl, u8.length);
    buf.set(u8.subarray(0, take), bl); bl += take; off = take;
    if (bl === 64) { block(buf, 0); bl = 0; }
  }
  while (off + 64 <= u8.length) { block(u8, off); off += 64; }
  if (off < u8.length) { buf.set(u8.subarray(off), 0); bl = u8.length - off; }
}
function finalizeWorker() {
  const hi = Math.floor(total / 0x20000000), lo = (total % 0x20000000) * 8;
  const padLen = (bl < 56 ? 56 : 120) - bl;
  const tail = new Uint8Array(padLen + 8);
  tail[0] = 0x80;
  const dv = new DataView(tail.buffer);
  dv.setUint32(padLen, hi, false); dv.setUint32(padLen + 4, lo >>> 0, false);
  update(tail);
  let out = '';
  for (let i = 0; i < 8; i++) out += (h[i] >>> 0).toString(16).padStart(8, '0');
  return out;
}
init();
let workerHashMs = 0;
onmessage = (ev) => {
  const m = ev.data;
  if (m.op === 'update') {
    const t0 = Date.now();
    update(new Uint8Array(m.buf));
    workerHashMs += Date.now() - t0;
    self.postMessage({ op: 'acked', bytes: m.bytes, hashMs: workerHashMs });
  } else if (m.op === 'finalize') {
    const hex = finalizeWorker();
    self.postMessage({ op: 'digest', hex, hashMs: workerHashMs });
  } else if (m.op === 'reset') {
    init(); workerHashMs = 0;
  }
};
`;

export function workerAvailable(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof Blob !== 'undefined'
  );
}

export class WorkerHashPipeline implements HashPipeline {
  readonly mode = 'worker' as const;
  private worker: Worker | null = null;
  private queued = 0;
  private acked = 0;
  private cpuMs = 0;
  private waiters = new Set<() => void>();
  private digestHex: string | null = null;
  private digestWaiter: (() => void) | null = null;

  constructor() {
    const blob = new Blob([WORKER_SRC], { type: 'text/javascript' });
    this.worker = new Worker(URL.createObjectURL(blob));
    this.worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { op: string; bytes?: number; hashMs?: number; hex?: string };
      if (m.op === 'acked') {
        this.acked += m.bytes ?? 0;
        this.cpuMs = m.hashMs ?? this.cpuMs;
        for (const w of [...this.waiters]) {
          if (this.lag <= (w as unknown as { cap: number }).cap) w();
        }
      } else if (m.op === 'digest') {
        this.digestHex = m.hex ?? '';
        this.cpuMs = m.hashMs ?? this.cpuMs;
        this.digestWaiter?.();
      }
    };
  }

  private get lag(): number {
    return this.queued - this.acked;
  }

  push(buf: ArrayBuffer, bytes: number): void {
    this.queued += bytes;
    this.worker?.postMessage({ op: 'update', buf, bytes }, [buf]);
  }

  lagBytes(): number {
    return this.lag;
  }

  async drainTo(cap: number): Promise<void> {
    if (this.lag <= cap) return;
    await new Promise<void>((resolve) => {
      const w = () => {
        if (this.lag <= cap) {
          this.waiters.delete(w);
          resolve();
        }
      };
      (w as unknown as { cap: number }).cap = cap;
      this.waiters.add(w);
    });
  }

  finalize(): Promise<string> {
    return new Promise<string>((resolve) => {
      const waiter = () => resolve(this.digestHex ?? '');
      this.digestWaiter = waiter;
      this.worker?.postMessage({ op: 'finalize' });
    });
  }

  reset(): void {
    this.queued = 0;
    this.acked = 0;
    this.cpuMs = 0;
    this.digestHex = null;
    this.digestWaiter = null;
    this.waiters.clear();
    this.worker?.postMessage({ op: 'reset' });
  }

  hashCpuMs(): number {
    return this.cpuMs;
  }

  dispose(): void {
    this.waiters.clear();
    try {
      this.worker?.terminate();
    } catch {
      // best-effort
    }
    this.worker = null;
  }
}
