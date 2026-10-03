/**
 * LanTcpTransport — NexDrop Turbo native TCP transport (mission STEP 1).
 *
 * One optimized TCP stream per file (parallel streams deliberately NOT
 * implemented until a benchmark proves them — mission Phase 6). The data
 * path is binary frames (frames.ts), flow is a sliding window over the
 * RECEIVER'S DURABLE offset (self-clocking: bytes in flight <= window,
 * so receiver RAM is bounded), and every connection authenticates the
 * pairing session token (handshake.ts).
 *
 * Session flow (see docs/TURBO-PROTOCOL.md):
 *   client HELLO(proof)            server AUTH_OK(echo nonce)   [or REJECT]
 *   OFFER(file meta)               -> accept/decline callback
 *   READY(durableOffset)           (resume: sender continues here)
 *   DATA* (window-bounded)         PROGRESS(durableOffset)  ~1 MiB cadence
 *   COMPLETE(sender sha)           VERIFY_OK | VERIFY_FAIL(receiver sha)
 *
 * Resume across reconnect: the server keeps its durable writer per file
 * and re-hashes the durable prefix, so a dropped TCP connection resumes
 * from the receiver's durable offset — never from zero (mission Phase 5).
 * The receiver NEVER trusts the sender's hash: it hashes its own durable
 * bytes and reports the mismatch (Phase 14/15).
 */

import * as net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  FrameDecoder,
  FrameType,
  decodeComplete,
  decodeHello,
  decodeData,
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
} from './frames';
import { helloProof, randomNonce, verifyHelloProof } from './handshake';
import { openDurableWriter } from './fileStream';

/** Max bytes in flight (sender socket buffers + receiver write queue). */
export const FLOW_WINDOW_BYTES = 8 * 1024 * 1024;
/** Receiver sends PROGRESS at least this often (closes the window). */
export const PROGRESS_INTERVAL_BYTES = 512 * 1024;
export const PROGRESS_MAX_DELAY_MS = 200;

export interface FileMetaWire {
  fileId: number;
  name: string;
  sizeBytes: number;
  sha256: string;
}

export interface AcceptDecision {
  accept: boolean;
  targetPath: string;
}

// ---------------------------------------------------------------------------
// Shared per-connection frame pump
// ---------------------------------------------------------------------------

class FrameConn {
  readonly socket: net.Socket;
  readonly decoder = new FrameDecoder();
  private readonly waiters: Array<{ type: FrameType; resolve: (p: Buffer) => void; reject: (e: Error) => void }> = [];
  private readonly listeners = new Map<FrameType, ((p: Buffer) => void)[]>();
  private dead = false;
  private deadErr?: Error;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = this.decoder.push(chunk);
      } catch (err) {
        this.fail(new Error(`protocol: ${err instanceof Error ? err.message : String(err)}`));
        socket.destroy();
        return;
      }
      for (const f of frames) this.dispatch(f.type, f.payload);
    });
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new Error('connection closed')));
    // A peer that destroys its socket half-closes with FIN: 'close' never
    // fires on our side until WE also destroy. Treat 'end' as death so a
    // reconnect is never mistaken for a stray second connection.
    socket.on('end', () => this.fail(new Error('peer closed connection')));
  }

  get remoteAddress(): string {
    return `${this.socket.remoteAddress}:${this.socket.remotePort}`;
  }

  get localAddress(): string {
    return `${this.socket.localAddress}:${this.socket.localPort}`;
  }

  get closed(): boolean {
    return this.dead || this.socket.destroyed;
  }

  get bufferedBytes(): number {
    return this.socket.writableLength ?? 0;
  }

  expect(type: FrameType, timeoutMs: number): Promise<Buffer> {
    if (this.dead) return Promise.reject(this.deadErr ?? new Error('connection closed'));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.type === type);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timeout waiting for ${FrameType[type]}`));
      }, timeoutMs);
      this.waiters.push({
        type,
        resolve: (p) => {
          clearTimeout(t);
          resolve(p);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
  }

  on(type: FrameType, fn: (p: Buffer) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  send(type: FrameType, payload: Buffer, flags = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(this.deadErr ?? new Error('connection closed'));
      this.socket.write(encodeFrame(type, flags, payload), (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Socket keepalive telemetry: round-trip a PING, resolve RTT in ms. */
  async pingRtt(): Promise<number> {
    const nonce = randomNonce();
    const t0 = Date.now();
    await this.send(FrameType.PING, encodeNonce(FrameType.PING, nonce));
    const pong = await this.expect(FrameType.PONG, 5000);
    if (decodeNonce(pong) !== nonce) throw new Error('pong nonce mismatch');
    return Date.now() - t0;
  }

  close(): void {
    this.fail(new Error('closed locally'));
    this.socket.destroy();
  }

  private dispatch(type: FrameType, payload: Buffer): void {
    const wIdx = this.waiters.findIndex((w) => w.type === type);
    if (wIdx >= 0) {
      const [w] = this.waiters.splice(wIdx, 1);
      w.resolve(payload);
      return;
    }
    const list = this.listeners.get(type);
    if (list) for (const fn of [...list]) fn(payload);
  }

  private fail(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    this.deadErr = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }
}

// ---------------------------------------------------------------------------
// Speed meter — honest durable-byte accounting (Phase 15/16)
// ---------------------------------------------------------------------------

export class SpeedMeter {
  private samples: Array<{ t: number; bytes: number }> = [{ t: Date.now(), bytes: 0 }];
  readonly startedAt = Date.now();
  private peak = 0;
  readonly windowMs: number;

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  record(durableBytes: number): void {
    const t = Date.now();
    this.samples.push({ t, bytes: durableBytes });
    while (this.samples.length > 1 && t - this.samples[0].t > 5000) this.samples.shift();
    const recent = this.samples.find((s) => t - s.t <= this.windowMs);
    if (recent) {
      const bps = ((durableBytes - recent.bytes) / Math.max(1, t - recent.t)) * 1000;
      if (bps > this.peak) this.peak = bps;
    }
  }

  instant(durableBytes: number): number {
    const t = Date.now();
    const recent = this.samples.find((s) => t - s.t <= this.windowMs);
    return recent ? ((durableBytes - recent.bytes) / Math.max(1, t - recent.t)) * 1000 : 0;
  }

  get peakSpeed(): number {
    return this.peak;
  }
}

// ---------------------------------------------------------------------------
// Server (receiver)
// ---------------------------------------------------------------------------

export interface TurboProgress {
  fileId: number;
  name: string;
  sizeBytes: number;
  durableBytes: number;
  phase: 'authenticating' | 'transferring' | 'verifying' | 'completed' | 'failed' | 'rejected';
  instantSpeed: number;
  averageSpeed: number;
  peakSpeed: number;
  writeQueue: number;
  bufferedBytes: number;
  rttMs: number;
}

/**
 * Authenticated Turbo receiver. One session token; the connection may be
 * replaced (reconnect) while the durable writer survives, enabling resume.
 */
export class TurboTcpServer extends EventEmitter {
  private server?: net.Server;
  private tokenBytes?: Buffer;
  private sessionId = '';
  private conn?: FrameConn;
  private writer?: Awaited<ReturnType<typeof openDurableWriter>>;
  private meter?: SpeedMeter;
  private rttMs = -1;

  /** Accept/decline callback — the companion host renders the Accept UX. */
  acceptHandler?: (meta: FileMetaWire) => Promise<AcceptDecision>;

  /** Current file state (telemetry). */
  current: TurboProgress | null = null;

  /** Set true after a VERIFY_OK — further connections are rejected 0x04. */
  private completed = false;
  private cancelled = false;
  private verifiedResult: { sha256: string; integrity: 'pass' | 'fail' } | null = null;

  async listen(port: number, tokenBytes: Buffer, sessionId: string, host = '127.0.0.1'): Promise<number> {
    this.tokenBytes = tokenBytes;
    this.sessionId = sessionId;
    return new Promise((resolve) => {
      this.server = net.createServer((socket) => {
        socket.on('error', () => {}); // stray sockets are destroyed below
        void this.handleConn(socket).catch(() => socket.destroy());
      });
      this.server.listen(port, host, () => {
        const addr = this.server?.address();
        resolve(addr && typeof addr === 'object' ? addr.port : port);
      });
    });
  }

  get port(): number {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : 0;
  }

  cancel(): void {
    this.cancelled = true;
    void this.conn?.send(FrameType.CANCEL, encodeOffset(0, 0)).catch(() => {});
    this.conn?.close();
  }

  pause(): void {
    void this.conn?.send(FrameType.PAUSE, encodeOffset(0, 0)).catch(() => {});
  }

  resume(): void {
    void this.conn?.send(FrameType.RESUME, encodeOffset(0, 0)).catch(() => {});
  }

  close(): void {
    this.conn?.close();
    this.server?.close();
    void this.writer?.close().catch(() => {});
  }

  private emitProgress(): void {
    if (!this.current) return;
    this.current.writeQueue = this.writer?.queued ?? 0;
    this.current.bufferedBytes = this.conn?.bufferedBytes ?? 0;
    this.current.rttMs = this.rttMs;
    this.current.instantSpeed = this.meter ? this.meter.instant(this.current.durableBytes) : 0;
    this.current.averageSpeed =
      this.meter && this.current.durableBytes > 0
        ? (this.current.durableBytes / Math.max(1, Date.now() - this.meter.startedAt)) * 1000
        : 0;
    this.current.peakSpeed = this.meter?.peakSpeed ?? 0;
    this.emit('progress', { ...this.current });
  }

  private async handleConn(socket: net.Socket): Promise<void> {
    // One live connection per session; a NEW connection may replace a dead
    // one (reconnect-resume), but a live second connection is rejected.
    if (this.conn && !this.conn.closed) {
      socket.destroy();
      return;
    }
    if (this.completed) {
      socket.destroy();
      return;
    }
    const conn = new FrameConn(socket);
    this.conn = conn;

    try {
      // --- authenticated handshake ---
      const hello = decodeHello(await conn.expect(FrameType.HELLO, 15000));
      if (hello.sessionId !== this.sessionId || !verifyHelloProof(this.tokenBytes!, hello.nonce, hello.tokenProof)) {
        await conn.send(FrameType.REJECT, Buffer.from([0x01])).catch(() => {});
        conn.close();
        return;
      }
      if (this.cancelled) {
        await conn.send(FrameType.REJECT, Buffer.from([0x04])).catch(() => {});
        conn.close();
        return;
      }
      this.current = this.current ?? {
        fileId: 0,
        name: '',
        sizeBytes: 0,
        durableBytes: 0,
        phase: 'authenticating',
        instantSpeed: 0,
        averageSpeed: 0,
        peakSpeed: 0,
        writeQueue: 0,
        bufferedBytes: 0,
        rttMs: -1,
      };
      this.current.phase = 'authenticating';
      this.emitProgress();
      await conn.send(FrameType.AUTH_OK, encodeNonce(FrameType.AUTH_OK, hello.nonce));

      // --- OFFER -> accept decision -> READY(durable offset) ---
      const offer = decodeOffer(await conn.expect(FrameType.OFFER, 30000));
      const decision = await (this.acceptHandler
        ? this.acceptHandler(offer)
        : Promise.resolve({ accept: true, targetPath: `/tmp/nexdrop-turbo-${this.sessionId}-${offer.name}` }));
      if (!decision.accept) {
        await conn.send(FrameType.REJECT, Buffer.from([0x00])).catch(() => {});
        this.current.phase = 'rejected';
        this.emitProgress();
        conn.close();
        return;
      }

      // Resume: writer survives reconnections; re-hash the durable prefix.
      const resume = this.writer && this.current.fileId === offer.fileId;
      if (!resume) {
        this.writer = await openDurableWriter(decision.targetPath, { hashExistingPrefix: false });
        this.meter = new SpeedMeter();
        this.current.fileId = offer.fileId;
        this.current.name = offer.name;
        this.current.sizeBytes = offer.sizeBytes;
        this.current.durableBytes = 0;
      } else {
        // reconnected sender on an existing writer: durable prefix already
        // hashed (same process), report the current durable position.
        this.current.durableBytes = await this.writer!.durableOffset();
      }
      this.current.phase = 'transferring';
      await conn.send(FrameType.READY, encodeOffset(offer.fileId, this.current.durableBytes));
      this.emitProgress();

      // --- DATA streaming (window closes via PROGRESS; sender self-clocks) ---
      let lastProgressSent = Date.now();
      let sinceProgress = 0;
      let settle: Promise<void> = Promise.resolve();

      conn.on(FrameType.DATA, (payload) => {
        const d = decodeData(payload);
        if (this.cancelled || !this.writer) return;
        settle = settle
          .then(async () => {
            await this.writer!.writeAt(d.offset, d.bytes);
            this.current!.durableBytes = Math.max(this.current!.durableBytes, d.offset + d.bytes.length);
            sinceProgress += d.bytes.length;
            if (sinceProgress >= PROGRESS_INTERVAL_BYTES || Date.now() - lastProgressSent >= PROGRESS_MAX_DELAY_MS) {
              const durable = await this.writer!.durableOffset();
              this.current!.durableBytes = durable;
              sinceProgress = 0;
              lastProgressSent = Date.now();
              this.meter!.record(durable);
              await conn.send(FrameType.PROGRESS, encodeOffset(d.fileId, durable)).catch(() => {});
              this.emitProgress();
            }
          })
          .catch(() => {
            /* writer closed or connection torn down mid-write; the transfer
               fails via the COMPLETE/expect path — never crash the host. */
          });
      });

      conn.on(FrameType.PING, (p) => {
        void conn.send(FrameType.PONG, encodeNonce(FrameType.PONG, decodeNonce(p))).catch(() => {});
      });

      // --- sender declares completion; receiver verifies DURABLE bytes ---
      const complete = decodeComplete(await conn.expect(FrameType.COMPLETE, 300000));
      await settle; // drain queued writes
      const durable = await this.writer!.durableOffset();
      const ourHash = this.writer!.digestHex();
      this.current.durableBytes = durable;
      this.current.phase = 'verifying';
      this.emitProgress();

      const pass = durable === offer.sizeBytes && ourHash === complete.sha256;
      if (pass) {
        await conn.send(FrameType.VERIFY_OK, encodeOffset(complete.fileId, 0));
        this.completed = true;
        this.verifiedResult = { sha256: ourHash, integrity: 'pass' };
        this.current.phase = 'completed';
      } else {
        await conn.send(FrameType.VERIFY_FAIL, encodeComplete(complete.fileId, ourHash));
        this.verifiedResult = { sha256: ourHash, integrity: 'fail' };
        this.current.phase = 'failed';
      }
      this.emit('verified', { fileId: complete.fileId, sha256: ourHash, integrity: pass ? 'pass' : 'fail' });
      this.emitProgress();
      await this.writer!.close().catch(() => {});
      conn.close();
    } catch {
      // Connection dropped mid-transfer: writer + state survive for resume.
      if (this.current && this.current.phase === 'transferring') this.current.phase = 'failed';
      conn.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Client (sender)
// ---------------------------------------------------------------------------

export interface SendOutcome {
  bytesTransferred: number;
  elapsedMs: number;
  sha256: string;
  integrity: 'pass' | 'fail';
  receiverHash?: string;
}

export class TurboTcpClient {
  private socket?: net.Socket;
  private conn?: FrameConn;
  private meter = new SpeedMeter();
  rttMs = -1;
  durableAckedBytes = 0;
  sentBytes = 0;
  paused = false;
  cancelled = false;

  /** TCP_NODELAY (mission: keep only if benchmark proves useful). */
  setNoDelay(on: boolean): void {
    this.socket?.setNoDelay(on);
  }

  async connect(host: string, port: number, tokenBytes: Buffer, sessionId: string, timeoutMs = 15000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => {
        socket.setTimeout(0);
        this.socket = socket;
        resolve();
      });
      socket.once('error', reject);
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('connect timeout'));
      });
    });
    this.conn = new FrameConn(this.socket!);
    const nonce = randomNonce();
    await this.conn.send(FrameType.HELLO, encodeHello(sessionId, helloProof(tokenBytes, nonce), nonce));
    const authOk = await this.conn.expect(FrameType.AUTH_OK, 10000);
    if (decodeNonce(authOk) !== nonce) throw new Error('auth failed: nonce mismatch');
    this.meter = new SpeedMeter();
    this.durableAckedBytes = 0;
    this.sentBytes = 0;
  }

  get connected(): boolean {
    return !!this.conn && !this.conn.closed;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  cancel(): void {
    this.cancelled = true;
    void this.conn?.send(FrameType.CANCEL, encodeOffset(0, 0)).catch(() => {});
    this.conn?.close();
  }

  close(): void {
    this.conn?.close();
  }

  async pingRtt(): Promise<number> {
    if (!this.conn) return -1;
    const rtt = await this.conn.pingRtt();
    this.rttMs = rtt;
    return rtt;
  }

  getStats() {
    return {
      sentBytes: this.sentBytes,
      durableAckedBytes: this.durableAckedBytes,
      instantSpeed: this.meter.instant(this.durableAckedBytes),
      averageSpeed:
        this.durableAckedBytes > 0 ? (this.durableAckedBytes / Math.max(1, Date.now() - this.meter.startedAt)) * 1000 : 0,
      peakSpeed: this.meter.peakSpeed,
      rttMs: this.rttMs,
      bufferedBytes: this.conn?.bufferedBytes ?? 0,
    };
  }

  /**
   * Stream one file. `source` yields bounded chunks in offset order; on
   * resume (READY.offset > 0) the already-durable prefix is skipped without
   * re-sending (Phase 5: never restart a 10 GB transfer from zero).
   * In-flight bytes are bounded by FLOW_WINDOW_BYTES measured against the
   * receiver's durable offset — honest end-to-end backpressure (Phase 17).
   */
  async sendFile(
    meta: FileMetaWire,
    source: AsyncIterable<{ offset: number; bytes: Buffer }>,
    opts: { frameBytes?: number } = {}
  ): Promise<SendOutcome> {
    const conn = this.conn!;
    // Phase-3 measured optimum (358.07 MB loopback sweep): 512 KiB frames
    // sustained 276.7 MB/s vs 232.6 (1 MiB) / 207.8 (4 MiB) - bigger is worse.
    const frameBytes = Math.min(opts.frameBytes ?? 512 * 1024, 4 * 1024 * 1024);
    const started = Date.now();
    await conn.send(FrameType.OFFER, encodeOffer(meta.fileId, meta.sizeBytes, meta.name, meta.sha256));

    const ready = decodeOffset(await conn.expect(FrameType.READY, 30000));
    if (ready.fileId !== meta.fileId) throw new Error('READY for wrong file');
    let durable = ready.offset;
    this.durableAckedBytes = durable;
    let remotePaused = false;

    conn.on(FrameType.PROGRESS, (p) => {
      const { offset } = decodeOffset(p);
      durable = Math.max(durable, offset);
      this.durableAckedBytes = durable;
      this.meter.record(durable);
    });
    conn.on(FrameType.PAUSE, () => {
      remotePaused = true;
    });
    conn.on(FrameType.RESUME, () => {
      remotePaused = false;
    });
    conn.on(FrameType.PING, (p) => {
      void conn.send(FrameType.PONG, encodeNonce(FrameType.PONG, decodeNonce(p))).catch(() => {});
    });

    let sent = ready.offset;
    try {
      for await (const part of source) {
        if (this.cancelled) throw new Error('cancelled');
        if (part.offset + part.bytes.length <= sent) continue; // fully durable prefix
        let bytes = part.bytes;
        let off = part.offset;
        if (part.offset < sent) {
          const skip = sent - part.offset;
          bytes = bytes.subarray(skip);
          off = sent;
        }
        if (off !== sent) throw new Error(`non-contiguous source at ${off} != ${sent}`);

        // Pause blocks mid-part; resume continues the same part. The window
        // closes against the receiver's DURABLE offset (bounded in-flight).
        for (let pos = 0; pos < bytes.length; ) {
          while (this.paused || remotePaused) {
            if (this.cancelled) throw new Error('cancelled');
            await new Promise((r) => setTimeout(r, 50));
          }
          while (sent + pos - durable > FLOW_WINDOW_BYTES && !this.cancelled) {
            await new Promise((r) => setTimeout(r, 5));
          }
          if (this.cancelled) throw new Error('cancelled');
          const take = Math.min(frameBytes, bytes.length - pos);
          const slice = bytes.subarray(pos, pos + take);
          await new Promise<void>((resolve, reject) => {
            this.socket!.write(encodeDataFrame(meta.fileId, sent + pos, meta.sizeBytes, slice), (err) =>
              err ? reject(err) : resolve()
            );
          });
          pos += take;
        }
        sent += bytes.length;
        this.sentBytes = sent;
      }
      if (this.paused || remotePaused) {
        // loop may have exited early on pause; report honestly
        throw new Error('paused before completion');
      }
      if (sent !== meta.sizeBytes) throw new Error(`source ended at ${sent} != ${meta.sizeBytes}`);
      await conn.send(FrameType.COMPLETE, encodeComplete(meta.fileId, meta.sha256));

      const verdict = await Promise.race([
        conn.expect(FrameType.VERIFY_OK, 120000).then((p) => ({ ok: true as const, p })),
        conn.expect(FrameType.VERIFY_FAIL, 120000).then((p) => ({ ok: false as const, p })),
      ]);
      const elapsed = Date.now() - started;
      if (verdict.ok) {
        return { bytesTransferred: meta.sizeBytes, elapsedMs: elapsed, sha256: meta.sha256, integrity: 'pass' };
      }
      const { sha256: receiverHash } = decodeComplete(verdict.p);
      return { bytesTransferred: meta.sizeBytes, elapsedMs: elapsed, sha256: meta.sha256, integrity: 'fail', receiverHash };
    } finally {
      /* connection left open for the next file / teardown by close() */
    }
  }
}
