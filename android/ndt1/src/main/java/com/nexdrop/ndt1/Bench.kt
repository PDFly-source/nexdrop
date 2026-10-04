package com.nexdrop.ndt1

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import org.json.JSONObject

/**
 * Honest throughput statistics for native NDT1 runs (mission 2026-10-04 §8/§9).
 *
 * ROOT CAUSE of the negative sustainedMBps (-465.79 MiB/s) seen in the real
 * 1 GiB run: the previous sampler measured elapsed time with
 * System.currentTimeMillis() — the WALL clock. During a ~92 s transfer the
 * phone's clock stepped BACKWARD (carrier/NTP time sync), so
 * `now - windowStart` went negative: a positive byte delta divided by a
 * negative duration produced the mathematically-impossible negative speed.
 *
 * FIX (telemetry only — the transfer engine is untouched):
 *  - All timing is System.nanoTime(): monotonic, immune to clock steps.
 *  - Every rate is validated before being reported: reject negative,
 *    NaN, Infinity, zero/negative elapsed, negative sample deltas.
 *  - AVERAGE  = total durable bytes / total elapsed        (headline)
 *  - SUSTAINED = trailing-window rate, only when that window spans >= 1 s
 *    (never a sub-second tail burst); otherwise it falls back to AVERAGE.
 *  - PEAK     = best COMPLETED >= 5 s window during the run (never an
 *    instant burst). Instant bursts are never reported as a headline.
 *  - If a value cannot be computed honestly it is null and serializes as
 *    JSON null (rendered "N/A") — never a fabricated number.
 *
 * The time source is injectable for unit tests, including the pathological
 * backward-clock case that produced the original bug.
 */
class ThroughputSampler(private val timeSource: () -> Long = { System.nanoTime() }) {
  private val startedAtNs = timeSource()
  private val windowNs = 5_000_000_000L        // 5 s measurement window
  private val minSustainedNs = 1_000_000_000L  // trailing window must span >= 1 s

  private var windowStartNs = startedAtNs
  private var windowStartBytes = 0L
  private var peakWindowBps: Double? = null   // best COMPLETED window
  private var lastSampleBytes = 0L

  /** Record the durable-byte frontier; called from the transfer loop only. */
  fun sample(durableBytes: Long) {
    val t = timeSource()
    val bytes = maxOf(durableBytes, lastSampleBytes) // monotonic frontier guard
    if (t - windowStartNs >= windowNs) {
      val dtNs = t - windowStartNs
      val delta = bytes - windowStartBytes
      if (dtNs > 0 && delta >= 0) {              // reject invalid windows outright
        val bps = sanitize(delta * 1e9 / dtNs)
        if (bps != null && (peakWindowBps == null || bps > peakWindowBps!!)) peakWindowBps = bps
      }
      windowStartNs = t
      windowStartBytes = bytes
    }
    lastSampleBytes = bytes
  }

  fun stats(totalBytes: Long): Stats {
    val t = timeSource()
    val elapsedNs = t - startedAtNs
    val avg = if (elapsedNs > 0) sanitize(totalBytes * 1e9 / elapsedNs) else null
    val trailingNs = t - windowStartNs
    val trailingDelta = totalBytes - windowStartBytes
    val sustained =
      if (trailingNs >= minSustainedNs && trailingNs > 0 && trailingDelta >= 0)
        sanitize(trailingDelta * 1e9 / trailingNs)
      else avg // insufficient trailing samples — honest fallback, never a tail burst
    return Stats(
      durationMs = if (elapsedNs > 0) elapsedNs / 1_000_000 else 0,
      bytes = totalBytes,
      averageBps = avg,
      sustainedBps = sustained,
      peakSustainedBps = peakWindowBps ?: avg,
    )
  }

  /** Reject NaN, Infinity, negative — anything not a valid positive rate. */
  private fun sanitize(v: Double?): Double? =
    if (v == null || !v.isFinite() || v < 0) null else v

  /**
   * All rates are nullable: null means "cannot be computed honestly" and
   * serializes as JSON null (the UI renders "N/A").
   */
  data class Stats(
    val durationMs: Long,
    val bytes: Long,
    val averageBps: Double?,
    val sustainedBps: Double?,
    val peakSustainedBps: Double?,
  ) {
    fun toJson(transport: String, sha256: String, extra: JSONObject.() -> Unit = {}): String =
      JSONObject().apply {
        put("transport", transport)          // truthful: ndt1-native-local
        put("bytes", bytes)
        put("durationMs", durationMs)
        put("averageBps", averageBps ?: JSONObject.NULL)
        put("sustainedBps", sustainedBps ?: JSONObject.NULL)
        put("peakSustainedBps", peakSustainedBps ?: JSONObject.NULL)
        // Unit contract (mission §8): all *MBps fields are MiB-based
        // (1 MiB = 1048576 bytes), matching the UI exactly.
        put("speedUnit", "MiB/s")
        put("averageMBps", averageBps?.let { it / 1048576.0 } ?: JSONObject.NULL)
        put("sustainedMBps", sustainedBps?.let { it / 1048576.0 } ?: JSONObject.NULL)
        put("peakSustainedMBps", peakSustainedBps?.let { it / 1048576.0 } ?: JSONObject.NULL)
        put("sha256", sha256)
        put("retransmissions", JSONObject.NULL) // TCP hides them — honest N/A
        put("direction", "android->android")   // truthful: this benchmark is always phone-to-phone
        put("memoryPeakBytes", Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory()) // bounded working set evidence
        put("errors", emptyList<Any>())         // populated by the caller on failure paths
        extra()
      }.toString()
  }
}

/**
 * Shared speed/size formatting (mission §9): the UI, the notification and the
 * JSON all use the SAME KiB/MiB/GiB (binary) units — 1 MiB = 1048576 bytes.
 *  < 1 MiB/s  ->  "850 KiB/s"
 *  < 1 GiB/s  ->  "11.12 MiB/s"
 *  >= 1 GiB/s ->  "1.24 GiB/s"
 * Invalid/unknown rates render as "N/A", never a fabricated number.
 */
object SpeedFormat {
  fun speedText(bps: Double?): String {
    if (bps == null || !bps.isFinite() || bps < 0) return "N/A"
    val mib = bps / 1048576.0
    if (mib < 1.0) return "${"%.0f".format(bps / 1024.0)} KiB/s"
    val gib = mib / 1024.0
    return if (gib < 1.0) "${"%.2f".format(mib)} MiB/s" else "${"%.2f".format(gib)} GiB/s"
  }

  /** ETA from the ACTUAL durable throughput — never predicted, never peak. */
  fun etaText(remainingBytes: Long, bps: Double?): String {
    if (bps == null || !bps.isFinite() || bps <= 0 || remainingBytes <= 0) return "—"
    val s = remainingBytes / bps
    return when {
      s < 60 -> "${"%.0f".format(s)} s"
      s < 3600 -> "${"%.0f".format(s / 60)} min"
      else -> "${"%.1f".format(s / 3600)} h"
    }
  }

  fun bytesText(bytes: Long): String {
    val mib = bytes / 1048576.0
    return if (mib >= 1024.0) "${"%.2f".format(mib / 1024.0)} GiB" else "${"%.1f".format(mib)} MiB"
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
