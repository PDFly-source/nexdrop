package com.nexdrop.ndt1

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.security.MessageDigest

/**
 * Durable receive writer: socket -> bounded buffer -> FileChannel -> disk.
 * Never a whole-file byte[]; RAM is bounded by one frame regardless of file
 * size (100 MB .. 10 GB+). Durable = written AND fsynced contiguous prefix;
 * a dropped connection resumes exactly at that offset (never from zero).
 */
class DurableWriter(private val partFile: File, private val sizeBytes: Long) {
  private val raf = RandomAccessFile(partFile, "rw")
  private val part = raf.channel
  private val hasher = MessageDigest.getInstance("SHA-256")
  private val hashBuf = ByteArray(1024 * 1024)
  /** Contiguous durable prefix; READY answers with exactly this. */
  var durableOffset = 0L; private set

  init {
    // Resume: re-hash the on-disk durable prefix before answering READY —
    // the receiver's hash is authoritative, the sender's is never trusted.
    var off = 0L
    val prefix = minOf(sizeBytes, part.size())
    while (off < prefix) {
      val n = part.read(ByteBuffer.wrap(hashBuf), off)
      if (n <= 0) break
      hasher.update(hashBuf, 0, n)
      off += n
    }
    durableOffset = off
  }

  /**
   * Write one DATA frame's bytes at its explicit offset. The v1 contract is
   * a single ordered TCP stream, so offset always equals durableOffset;
   * an out-of-order frame is a protocol violation we reject loudly.
   */
  // v1.4.2 Phase 1 — REAL profile counters (never in the UI hot path,
  // nanoTime per call only; read after completion). These make the
  // physical bottleneck measurable instead of guessed.
  @Volatile var fsyncCount = 0; private set
  @Volatile var fsyncTotalMs = 0.0; private set
  @Volatile var fsyncMaxMs = 0.0; private set
  @Volatile var writeTotalMs = 0.0; private set
  @Volatile var hashTotalMs = 0.0; private set

  fun write(offset: Long, bytes: ByteArray, len: Int) {
    if (offset != durableOffset) {
      throw Ndt1Exception("DATA offset desync: got $offset, durable at $durableOffset")
    }
    val t0 = System.nanoTime()
    val buf = ByteBuffer.wrap(bytes, 0, len)
    var pos = offset
    while (buf.remaining() > 0) {
      val n = part.write(buf, pos)
      if (n <= 0) throw Ndt1Exception("short write at $pos")
      pos += n
    }
    val t1 = System.nanoTime()
    hasher.update(bytes, 0, len)
    val t2 = System.nanoTime()
    writeTotalMs += (t1 - t0) / 1e6
    hashTotalMs += (t2 - t1) / 1e6
    durableOffset += len
  }

  /**
   * fsync the file, then report the new durable offset for PROGRESS.
   * v1.4.2 turbo: channel.force(true) already flushes data AND metadata
   * through the same fd — the previous raf.fd.sync() repeated the fsync,
   * doubling storage syscalls on the receive path (1366 per 341 MiB).
   * Durability contract is unchanged: durableOffset still means fsynced.
   */
  fun fsyncDurable(): Long {
    val t0 = System.nanoTime()
    part.force(true)
    val ms = (System.nanoTime() - t0) / 1e6
    fsyncCount++
    fsyncTotalMs += ms
    if (ms > fsyncMaxMs) fsyncMaxMs = ms
    return durableOffset
  }

  fun sha256Hex(): String = hasher.digest().joinToString("") { "%02x".format(it) }

  /** Finalize on VERIFY_OK: fsync, close, rename part -> final target. */
  fun finalizeTo(target: File) {
    part.force(true)
    raf.fd.sync()
    raf.close()
    if (target.exists()) target.delete()
    if (!partFile.renameTo(target)) throw Ndt1Exception("finalize rename failed")
  }

  fun close() {
    try { raf.close() } catch (_: Exception) {}
  }
}
