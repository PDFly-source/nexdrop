package com.nexdrop.ndt1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executors
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * v1.5 Phase C JVM tests: the PURE parts of the preview system — plan
 * decisions, cache keys, bounded LRU eviction, scheduler dedup and
 * cancellation, and concurrency. Android-frame generation is covered by
 * PreviewInstrumentedTest on the emulator. No Android classes are touched
 * here, so these run in the plain unit-test source set.
 */

class PreviewPlanTest {

  @Test fun kindsMapToPlans() {
    assertEquals(PreviewPlan.IMAGE, previewPlan(FileKind.IMAGE))
    assertEquals(PreviewPlan.VIDEO, previewPlan(FileKind.VIDEO))
    assertEquals(PreviewPlan.AUDIO, previewPlan(FileKind.AUDIO))
    assertEquals(PreviewPlan.PDF, previewPlan(FileKind.PDF))
    assertEquals(PreviewPlan.APK, previewPlan(FileKind.APK))
    assertEquals(PreviewPlan.ICON, previewPlan(FileKind.ARCHIVE))
    assertEquals(PreviewPlan.ICON, previewPlan(FileKind.DOC))
    assertEquals(PreviewPlan.ICON, previewPlan(FileKind.OTHER))
  }

  @Test fun cacheKeyIsStableAndSensitive() {
    val k1 = previewCacheKey("content://media/42", 1024, 1000)
    assertEquals(k1, previewCacheKey("content://media/42", 1024, 1000))
    // size or mtime change → new key (stale previews never serve)
    assertNotEquals(k1, previewCacheKey("content://media/42", 2048, 1000))
    assertNotEquals(k1, previewCacheKey("content://media/42", 1024, 2000))
    assertNotEquals(k1, previewCacheKey("file:///a.jpg", 1024, 1000))
  }
}

class PreviewCacheTest {

  @Test fun hitMissAndEviction() {
    val c = BoundedLruCache<String, String>(3)
    assertNull(c.get("a"))
    c.put("a", "1"); c.put("b", "2"); c.put("c", "3")
    assertEquals("1", c.get("a"))
    c.put("d", "4") // evicts LRU "b" ("a" was just touched)
    assertNull(c.get("b"))
    assertEquals("1", c.get("a"))
    assertEquals("3", c.get("c"))
    assertEquals("4", c.get("d"))
  }

  @Test fun evictAllAndBound() {
    val c = BoundedLruCache<String, Int>(5)
    for (i in 0 until 50) c.put("k$i", i)
    assertEquals(5, c.entries)
    c.evictAll()
    assertEquals(0, c.entries)
    assertNull(c.get("k49"))
  }

  @Test fun constructorRequiresPositiveBound() {
    var threw = false
    try { BoundedLruCache<String, Int>(0) } catch (_: IllegalArgumentException) { threw = true }
    assertTrue(threw)
  }
}

class PreviewCancellationTest {

  /** Manual runner: jobs are collected, tests decide when they "run". */
  private class Holder : (Runnable) -> Unit {
    val jobs = ArrayList<Runnable>()
    override fun invoke(r: Runnable) { jobs.add(r) }
  }

  @Test fun dedupesInFlightKey() {
    val h = Holder()
    val s = PreviewScheduler(h)
    assertTrue(s.submit("k") { })
    assertFalse(s.submit("k") { }) // dedup — no preview storm on re-render
    assertEquals(1, h.jobs.size)
  }

  @Test fun cancelPendingSkipsQueuedJobs() {
    val h = Holder()
    val s = PreviewScheduler(h)
    var ran = false
    assertTrue(s.submit("k") { ran = true })
    s.cancelAll() // row disappeared / queue cleared before the worker ran
    h.jobs.forEach { it.run() }
    assertFalse(ran) // generation guard skipped the stale job
    // the key is free again — a fresh request runs normally
    assertTrue(s.submit("k") { ran = true })
    h.jobs.last().run()
    assertTrue(ran)
  }

  @Test fun submissionErrorsNeverPropagate() {
    val h = object : (Runnable) -> Unit {
      override fun invoke(r: Runnable) { throw java.io.IOException("worker died") }
    }
    var completed = false
    try { PreviewScheduler(h).submit("k") { completed = true } } catch (e: Exception) { throw AssertionError(e) }
    // runner failure must not crash the queue; flag stays false (never claimed)
    assertFalse(completed)
  }
}

class PreviewConcurrencyTest {

  @Test fun concurrentSameKeySubmitsExactlyOnce() {
    val exec = Executors.newFixedThreadPool(8)
    val s = PreviewScheduler { r -> exec.execute(r) }
    val accepted = AtomicInteger(0)
    val latch = CountDownLatch(8)
    repeat(8) {
      exec.execute {
        if (s.submit("same") { Thread.sleep(20) }) accepted.incrementAndGet()
        latch.countDown()
      }
    }
    assertTrue(latch.await(5, TimeUnit.SECONDS))
    assertEquals(1, accepted.get()) // exactly one generation job per key
    exec.shutdown()
    assertTrue(exec.awaitTermination(5, TimeUnit.SECONDS))
    assertEquals(0, s.inFlightCount) // in-flight bookkeeping drains
  }
}
