package com.nexdrop.ndt1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * Telemetry regression (mission 2026-10-04 §8): the real 1 GiB run reported
 * sustainedMBps = -465.79 — mathematically impossible. These tests pin the
 * fix: monotonic timing, validated windows, N/A instead of fabricated
 * numbers. The transfer engine is not involved — sampler only.
 */
class TelemetrySamplerTest {

  /** Deterministic controllable clock (ms -> ns via TimeUnit). */
  private class FakeClock(var ms: Long) {
    fun advanceMs(dt: Long) { ms += dt }
    val source: () -> Long = { TimeUnit.MILLISECONDS.toNanos(ms) }
  }

  private fun assertValidRate(v: Double?, label: String) {
    assertTrue("$label must be null-or-finite-nonnegative but was $v",
      v == null || (v.isFinite() && v >= 0.0))
  }

  @Test
  fun `1 GiB over 92 s - average stays positive and consistent`() {
    val clock = FakeClock(0)
    val sampler = ThroughputSampler(clock.source)
    val gib = 1024L * 1024 * 1024
    // 92 samples, 1 per second, uniform 1 GiB total
    for (i in 1..92) {
      clock.advanceMs(1000)
      sampler.sample(gib * i / 92)
    }
    val s = sampler.stats(gib)
    assertEquals(gib, s.bytes)
    assertEquals(92_000L, s.durationMs)
    assertValidRate(s.averageBps, "average")
    assertValidRate(s.sustainedBps, "sustained")
    assertValidRate(s.peakSustainedBps, "peak")
    // 1 GiB / 92 s ≈ 11.12 MiB/s — positive, same order of magnitude
    assertTrue("average ${s.averageBps} not ~11 MiB/s",
      s.averageBps != null && s.averageBps!! > 10.0 * 1048576 && s.averageBps!! < 13.0 * 1048576)
    // JSON must agree with the fields and stay valid numbers
    val json = s.toJson("ndt1-native-local", "00")
    assertTrue("json missing speedUnit", json.contains("MiB/s"))
    assertTrue("json leaked a negative rate", !Regex("\"\\w*MBps\":-").containsMatchIn(json))
  }

  @Test
  fun `wall clock steps BACKWARD mid-run - never a negative rate (the -465_79 bug)`() {
    val clock = FakeClock(0)
    val sampler = ThroughputSampler(clock.source)
    // 30 s of healthy transfer
    for (i in 1..30) {
      clock.advanceMs(1000)
      sampler.sample(100L * 1024 * 1024 * i / 30)
    }
    // NTP/carrier time sync steps the wall clock BACK 6 s — the exact
    // condition that produced sustainedMBps = -465.79 with currentTimeMillis.
    clock.advanceMs(-6000)
    sampler.sample(100L * 1024 * 1024)
    clock.advanceMs(1000)
    val s = sampler.stats(100L * 1024 * 1024)
    assertValidRate(s.sustainedBps, "sustained after backward step")
    assertValidRate(s.averageBps, "average after backward step")
    assertValidRate(s.peakSustainedBps, "peak after backward step")
    assertTrue("sustained went negative", s.sustainedBps == null || s.sustainedBps!! >= 0)
  }

  @Test
  fun `zero elapsed - honest N_A not a divide-by-zero`() {
    val clock = FakeClock(1000)
    val sampler = ThroughputSampler(clock.source) // no time passes, no samples
    val s = sampler.stats(1024L * 1024)
    assertEquals(0L, s.durationMs)
    assertNull("average with zero elapsed must be N/A", s.averageBps)
    assertNull("sustained with zero elapsed must be N/A", s.sustainedBps)
    val json = s.toJson("ndt1-native-local", "00")
    assertTrue("json must serialize N/A as null", json.contains("\"averageBps\":null"))
  }

  // v1.4.3 maintenance pins (docs/KNOWN-ISSUES-1.4.2.md): the result-screen
  // average must be sessionBytes/sessionWall — TEST A (normal scope, the
  // formula every non-recovered transfer uses, unchanged) and TEST E (no
  // divide-by-zero/NaN/Infinity on degenerate sessions).
  @Test
  fun `normal transfer 100 MiB over 10 s - average is exactly 10 MiB per s (TEST A)`() {
    val clock = FakeClock(0)
    val sampler = ThroughputSampler(clock.source)
    val mib = 1024L * 1024
    for (i in 1..10) {
      clock.advanceMs(1000)
      sampler.sample(mib * 10 * i) // 10 MiB per second, uniform
    }
    val s = sampler.stats(mib * 100)
    assertEquals(mib * 100, s.bytes)
    assertEquals(10_000L, s.durationMs)
    assertTrue("average ${s.averageBps} must be ~10 MiB/s",
      s.averageBps != null && Math.abs(s.averageBps!! - 10.0 * 1048576) < 0.01 * 1048576)
  }

  @Test
  fun `zero elapsed or zero session bytes - no divide-by-zero, NaN or Infinity (TEST E)`() {
    val clock = FakeClock(0)
    val sampler = ThroughputSampler(clock.source)
    // zero elapsed AND zero bytes (an instant session)
    val s0 = sampler.stats(0L)
    assertNull("zero elapsed must serialize as N/A, never a fabricated rate", s0.averageBps)
    // 1 ms elapsed, zero bytes transferred
    clock.advanceMs(1)
    val s1 = sampler.stats(0L)
    assertTrue("zero bytes over 1 ms must be 0 or N/A, was ${s1.averageBps}",
      s1.averageBps == null || s1.averageBps!! == 0.0)
    assertValidRate(s1.averageBps, "average")
    assertValidRate(s1.sustainedBps, "sustained")
    assertValidRate(s1.peakSustainedBps, "peak")
    assertEquals(0L, s1.bytes)
  }

  @Test
  fun `insufficient trailing samples - sustained falls back to average, never a tail burst`() {
    val clock = FakeClock(0)
    val sampler = ThroughputSampler(clock.source)
    for (i in 1..20) { clock.advanceMs(500); sampler.sample(50L * 1024 * 1024 * i / 20) }
    // End the run 0.2 s into a fresh window: the trailing window is a burst
    // tail — sustained must NOT be measured off it (>= 1 s rule).
    clock.advanceMs(200)
    val total = 50L * 1024 * 1024
    val s = sampler.stats(total)
    assertValidRate(s.sustainedBps, "sustained")
    assertEquals(s.averageBps, s.sustainedBps) // fallback to average, not tail
  }

  @Test
  fun `peak is a completed 5 s window - never an instant burst`() {
    val clock = FakeClock(0)
    val sampler = ThroughputSampler(clock.source)
    // steady 1 s windows at 2 MiB/s, then ONE fast second (burst), then steady
    for (i in 1..5) { clock.advanceMs(1000); sampler.sample(2L * 1024 * 1024 * i) }
    clock.advanceMs(1000)
    sampler.sample(10L * 1024 * 1024)              // 8 MiB in one second — a burst
    for (i in 1..5) { clock.advanceMs(1000); sampler.sample(10L * 1024 * 1024 + 2L * 1024 * 1024 * i) }
    val s = sampler.stats(20L * 1024 * 1024)
    assertValidRate(s.peakSustainedBps, "peak")
    // The burst lands INSIDE a 5 s window with slower seconds: the completed
    // window containing it averages (8+8+2+2+2)/5 = 4.4 MiB/s — not 8.
    assertTrue("peak ${s.peakSustainedBps} leaked the instant burst",
      s.peakSustainedBps != null && s.peakSustainedBps!! < 5.0 * 1024 * 1024)
  }

  @Test
  fun `bench file is deterministic and hashes identically across generations`() {
    val dir = java.nio.file.Files.createTempDirectory("sampler-bench").toFile()
    val a = BenchFile.generate(dir, "a.bin", 3L * 1024 * 1024)
    val b = BenchFile.generate(dir, "b.bin", 3L * 1024 * 1024)
    val md = java.security.MessageDigest.getInstance("SHA-256")
    assertEquals(md.digest(a.readBytes()).joinToString("") { "%02x".format(it) },
      md.digest(b.readBytes()).joinToString("") { "%02x".format(it) })
    assertEquals(3L * 1024 * 1024, a.length())
    a.delete(); b.delete()
  }

  @Test
  fun `speed display formatting follows the unit contract`() {
    assertEquals("850 KiB/s", SpeedFormat.speedText(850.0 * 1024))
    assertEquals("11.12 MiB/s", SpeedFormat.speedText(11.12 * 1048576))
    assertEquals("1.24 GiB/s", SpeedFormat.speedText(1.24 * 1024 * 1048576))
    assertEquals("N/A", SpeedFormat.speedText(null))
    assertEquals("N/A", SpeedFormat.speedText(Double.NaN))
    assertEquals("N/A", SpeedFormat.speedText(-1.0))
    assertEquals("N/A", SpeedFormat.speedText(Double.POSITIVE_INFINITY))
    assertEquals("—", SpeedFormat.etaText(1024, null))
    assertEquals("—", SpeedFormat.etaText(1024, -5.0))
    assertEquals("1.00 GiB", SpeedFormat.bytesText(1024L * 1048576))
    assertEquals("358.0 MiB", SpeedFormat.bytesText(358L * 1048576))
    assertEquals("0 KiB/s", SpeedFormat.speedText(0.0))
  }
}
