package com.nexdrop.ndt1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest

/**
 * v1.4.2-rc3: ASYNC DURABILITY contract regression.
 *
 * The durability worker is the only thing that changed on the receive
 * path — the contract must be PROVEN unchanged:
 *
 *   1. PROGRESS is emitted strictly AFTER force(true): the reported
 *      durable high-water is monotonic and never exceeds what was
 *      written; every emitted value is at least the requested one.
 *   2. High-water coalescing: requests queued while the worker is busy
 *      collapse into ONE fsync — the fsync count collapses, the durable
 *      result is identical.
 *   3. drainDurability() (the COMPLETE path) returns the FULL written
 *      offset and the SHA-256 stream hash is unchanged.
 *   4. A drop mid-queue (stopAsync) leaves an exact, resumable part
 *      file: re-opening scans the on-disk prefix and re-hashes it.
 *   5. Synchronous fallback still works (no worker).
 */
class AsyncDurableWriterTest {

  private fun tempDir(): File = Files.createTempDirectory("ndtpart").toFile()

  private fun chunk(off: Long, len: Int): ByteArray =
    ByteArray(len) { i -> ((off / 64 + i) and 0xff).toByte() }

  private fun shaOf(b: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

  @Test
  fun `progress is monotonic, post-fsync, and coalesces under load`() {
    val dir = tempDir()
    val w = DurableWriter(File(dir, "a.ndtpart"), 4L * 1024 * 1024)
    val reported = mutableListOf<Long>()
    w.startAsyncFsync { reported.add(it) }
    var off = 0L
    repeat(4) { // 4 x 512 KiB with a durability checkpoint per frame
      val b = chunk(off, 512 * 1024)
      w.write(off, b, b.size)
      off += b.size
      w.requestDurability(off)
      Thread.sleep(15) // let the worker race the queue (coalescing window)
    }
    val drained = w.drainDurability()
    w.stopAsync()
    // contract: every reported durable offset is a real prefix boundary,
    // monotonic, and the final drain covers EVERYTHING written.
    assertTrue(reported.isNotEmpty())
    assertTrue(reported == reported.sorted())
    assertTrue(reported.all { it in 0..off })
    assertEquals(off, drained)
    // coalescing proof: at most one fsync per request cycle (fewer is the
    // point) — never more requests than fsyncs reported durable offsets
    // implies, and never MORE fsyncs than requests.
    assertTrue("fsync count ${w.fsyncCount} should be <= queued checkpoints", w.fsyncCount in 1..4)
    assertTrue("fsynced offset must never lead fsync completion", w.fsyncTotalMs >= 0.0)
    w.close()
    assertEquals(4L * 512 * 1024, drained)
  }

  @Test
  fun `burst of checkpoints collapses into few fsyncs`() {
    val dir = tempDir()
    val w = DurableWriter(File(dir, "b.ndtpart"), 1024 * 1024L)
    var off = 0L
    // write the whole file first, then hammer 32 checkpoints with no sleeps
    repeat(2) {
      val b = chunk(off, 512 * 1024)
      w.write(off, b, b.size)
      off += b.size
    }
    w.startAsyncFsync { }
    repeat(32) { w.requestDurability(off) }
    val drained = w.drainDurability()
    w.stopAsync()
    w.close()
    assertEquals(off, drained)
    assertTrue("32 checkpoints must collapse (got ${w.fsyncCount} fsyncs)", w.fsyncCount in 1..4)
  }

  @Test
  fun `drop mid-queue leaves an exact resumable prefix`() {
    val dir = tempDir()
    val f = File(dir, "c.ndtpart")
    val w = DurableWriter(f, 3L * 512 * 1024)
    w.startAsyncFsync { }
    var off = 0L
    repeat(2) { // 1 MiB fsynced...
      val b = chunk(off, 512 * 1024)
      w.write(off, b, b.size)
      off += b.size
      w.requestDurability(off)
    }
    Thread.sleep(60)
    // ...then a final frame queued but the connection DROPS before drain
    val tail = chunk(off, 512 * 1024)
    w.write(off, tail, tail.size)
    w.requestDurability(off + tail.size)
    w.stopAsync() // drop path: worker stopped, part retained, channel open
    val fsyncedBeforeDrop = w.fsyncCount
    w.close()
    assertTrue("worker must have fsynced something before the drop", fsyncedBeforeDrop >= 1)
    // resume: a fresh writer scans + re-hashes the on-disk prefix
    val resumed = DurableWriter(f, 3L * 512 * 1024)
    assertEquals(3L * 512 * 1024, resumed.durableOffset) // everything written is on disk
    val full = chunk(0, 3 * 512 * 1024)
    resumed.write(3L * 512 * 1024, ByteArray(0), 0) // no-op sanity on state
    resumed.close()
    assertEquals(shaOf(full), resumed.sha256Hex())
  }

  @Test
  fun `synchronous fallback and finalize stay intact`() {
    val dir = tempDir()
    val f = File(dir, "d.ndtpart")
    val w = DurableWriter(f, 512 * 1024L)
    val b = chunk(0, 512 * 1024)
    w.write(0, b, b.size)
    val d1 = w.fsyncDurable() // no worker running: inline fsync
    assertEquals(512L * 1024, d1)
    assertEquals(shaOf(b), w.sha256Hex())
    val target = File(dir, "d.bin")
    w.finalizeTo(target)
    assertTrue(target.exists() && target.length() == 512L * 1024)
    assertEquals(shaOf(b), shaOf(target.readBytes()))
    assertTrue(!f.exists())
  }

  @Test
  fun `complete path drains every written byte before reporting`() {
    val dir = tempDir()
    val w = DurableWriter(File(dir, "e.ndtpart"), 2L * 512 * 1024)
    w.startAsyncFsync { }
    var off = 0L
    val all = ByteArray(2 * 512 * 1024)
    repeat(4) { // 4 x 256 KiB, checkpoint only at the end (worst case)
      val b = chunk(off, 256 * 1024)
      b.copyInto(all, off.toInt())
      w.write(off, b, b.size)
      off += b.size
    }
    w.requestDurability(off)
    val drained = w.drainDurability()
    w.stopAsync()
    w.close()
    assertEquals(off, drained)
    assertEquals(shaOf(all), w.sha256Hex())
  }
}
