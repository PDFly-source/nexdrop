/**
 * TURBO v2.4 — MerkleHasher: native off-main-thread SHA-256 pipeline (2026-10-01).
 *
 * The v2.3 profiling measured the JS IncrementalSha256 hot loop at
 * 9–10 ms per 128 KiB chunk ≈ a 13.7 MB/s ceiling, on BOTH ends — the single
 * largest measured serial cost in the pump. WebCrypto cannot hash a stream
 * incrementally (crypto.subtle.digest is whole-buffer), so this class keeps
 * the streaming interface but computes natively in fixed-size BLOCKS:
 *
 *   digest = SHA-256( blockDigest_0 ‖ blockDigest_1 ‖ … )
 *   blockDigest_i = SHA-256(block_i)   via crypto.subtle (native, off-main-thread)
 *
 * Both sender and receiver compute the SAME value over the same plaintext
 * byte order, so it is a full end-to-end SHA-256-based integrity check
 * (wire algo id: 's256m', negotiated in FILE_START / HASH_OK).
 *
 * Properties:
 *  - bounded memory: ONE block buffer at a time (+ the small digest chain)
 *  - exact byte ordering: updates are serialized through `tail`, and the
 *    synchronous prologue of update() copies bytes before any await
 *  - finalize() awaits the whole chain, then one tiny native digest
 *  - resume-safety: consumes each pushed buffer exactly once, in order
 */

const DEFAULT_BLOCK = 4 * 1024 * 1024;

function toHex(d: ArrayBuffer): string {
  const b = new Uint8Array(d);
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

export class MerkleHasher {
  private readonly blockBytes: number;
  private block: Uint8Array;
  private blockLen = 0;
  /** Flat ordered chain of block digest bytes (32 per block). */
  private digestChain: number[] = [];
  /** Serializes block digests in push order (update order). */
  private tail: Promise<void> = Promise.resolve();
  /** Measured native digest time (ms) — for the hash-%-of-wall metric. */
  hashCpuMs = 0;
  private bytesHashed = 0;
  private sealed = false;

  constructor(blockBytes = DEFAULT_BLOCK) {
    this.blockBytes = Math.max(1024, blockBytes);
    this.block = new Uint8Array(this.blockBytes);
  }

  /**
   * Push the next plaintext chunk. Synchronous prologue copies into the
   * current block BEFORE the first await, so fire-and-forget callers keep
   * exact ordering. Returns the tail promise (callers may ignore it — the
   * internal chain preserves order regardless).
   */
  update(data: ArrayBuffer): Promise<void> {
    if (this.sealed) throw new Error('MerkleHasher already finalized');
    const src = new Uint8Array(data);
    this.bytesHashed += src.byteLength;
    let off = 0;
    while (off < src.length) {
      const take = Math.min(this.blockBytes - this.blockLen, src.length - off);
      this.block.set(src.subarray(off, off + take), this.blockLen);
      this.blockLen += take;
      off += take;
      if (this.blockLen === this.blockBytes) {
        // Hand the block buffer to the digest and rotate in a fresh one —
        // the sender keeps streaming without touching the old buffer.
        const buf = this.block.buffer as ArrayBuffer;
        this.block = new Uint8Array(this.blockBytes);
        this.blockLen = 0;
        this.tail = this.tail.then(async () => {
          const t0 = Date.now();
          const d = await crypto.subtle.digest('SHA-256', buf);
          this.hashCpuMs += Date.now() - t0;
          const db = new Uint8Array(d);
          for (let i = 0; i < db.length; i++) this.digestChain.push(db[i]);
        });
      }
    }
    return this.tail;
  }

  get hashedBytes(): number {
    return this.bytesHashed;
  }

  /** Final digest (hex) — drains all pending blocks, then hashes the chain. */
  async finalize(): Promise<string> {
    await this.tail;
    if (this.blockLen > 0) {
      const partial = (this.block.buffer as ArrayBuffer).slice(0, this.blockLen);
      const t0 = Date.now();
      const d = await crypto.subtle.digest('SHA-256', partial);
      this.hashCpuMs += Date.now() - t0;
      const db = new Uint8Array(d);
      for (let i = 0; i < db.length; i++) this.digestChain.push(db[i]);
      this.blockLen = 0;
    }
    this.sealed = true;
    const chain = new Uint8Array(this.digestChain);
    const t0 = Date.now();
    const final = await crypto.subtle.digest('SHA-256', chain);
    this.hashCpuMs += Date.now() - t0;
    return toHex(final);
  }
}
