package com.nexdrop.ndt1

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import org.json.JSONObject

/**
 * Honest throughput statistics for native NDT1 runs (mission §10/§12).
 * All speeds derive from durable bytes over measured elapsed time:
 *  - average          = bytes / wall time
 *  - sustained        = best 5 s window average at the END state
 *  - peakSustained    = max 5 s sliding-window average during the run
 * Instant burst peaks are never reported as a headline. The sampler is
 * called from the transfer loop only (never the UI thread) and does no I/O.
 */
class ThroughputSampler(private val startedAtMs: Long) {
  private var lastSampleMs = startedAtMs
  private var lastBytes = 0L
  private var peakWindowBps = 0.0
  private val windowMs = 5000L
  private var windowStartMs = startedAtMs
  private var windowStartBytes = 0L

  /** Record the durable-byte frontier; call at most ~20 Hz. */
  fun sample(durableBytes: Long) {
    val now = System.currentTimeMillis()
    if (now - lastSampleMs < 50) return
    lastSampleMs = now
    if (now - windowStartMs >= windowMs) {
      val bps = (durableBytes - windowStartBytes) * 1000.0 / (now - windowStartMs).coerceAtLeast(1)
      if (bps > peakWindowBps) peakWindowBps = bps
      windowStartMs = now
      windowStartBytes = durableBytes
    }
    lastBytes = durableBytes
  }

  fun stats(totalBytes: Long): Stats {
    val elapsed = (System.currentTimeMillis() - startedAtMs).coerceAtLeast(1)
    val avg = totalBytes * 1000.0 / elapsed
    val sustained = if (elapsed >= windowMs) {
      (totalBytes - windowStartBytes) * 1000.0 / (System.currentTimeMillis() - windowStartMs).coerceAtLeast(1)
    } else avg
    return Stats(
      durationMs = elapsed,
      bytes = totalBytes,
      averageBps = avg,
      sustainedBps = sustained,
      peakSustainedBps = if (peakWindowBps > 0) peakWindowBps else avg,
    )
  }

  data class Stats(
    val durationMs: Long,
    val bytes: Long,
    val averageBps: Double,
    val sustainedBps: Double,
    val peakSustainedBps: Double,
  ) {
    fun toJson(transport: String, sha256: String, extra: JSONObject.() -> Unit = {}): String =
      JSONObject().apply {
        put("transport", transport)          // truthful: ndt1-native-local
        put("bytes", bytes)
        put("durationMs", durationMs)
        put("averageBps", averageBps)
        put("sustainedBps", sustainedBps)
        put("peakSustainedBps", peakSustainedBps)
        put("averageMBps", averageBps / 1048576.0)
        put("sustainedMBps", sustainedBps / 1048576.0)
        put("peakSustainedMBps", peakSustainedBps / 1048576.0)
        put("sha256", sha256)
        put("retransmissions", JSONObject.NULL) // TCP hides them — honest N/A
        extra()
      }.toString()
  }
}

/**
 * Deterministic benchmark file generator (mission §12): bounded memory
 * (1 MiB buffer), FileChannel writes, no whole-file RAM array. The pattern
 * is a fixed 32-bit LCG so every run hashes identically — real bytes, real
 * SHA-256, reproducible across runs and devices.
 */
object BenchFile {
  fun generate(dir: File, name: String, sizeBytes: Long): File {
    val f = File(dir, name)
    RandomAccessFile(f, "rw").use { raf ->
      raf.setLength(0)
      val buf = ByteArray(1024 * 1024)
      var seed = 0x12345678L
      var written = 0L
      val chan = raf.channel
      while (written < sizeBytes) {
        var i = 0
        while (i < buf.size) {
          seed = seed * 6364136223846793005L + 1442695040888963407L
          val v = seed ushr 24
          buf[i] = (v and 0xff).toByte(); buf[i + 1] = ((v ushr 8) and 0xff).toByte()
          buf[i + 2] = ((v ushr 16) and 0xff).toByte(); buf[i + 3] = ((v ushr 24) and 0xff).toByte()
          i += 4
        }
        val n = minOf(buf.size.toLong(), sizeBytes - written).toInt()
        chan.write(ByteBuffer.wrap(buf, 0, n), written)
        written += n
      }
      chan.force(true)
      raf.fd.sync()
    }
    return f
  }
}
