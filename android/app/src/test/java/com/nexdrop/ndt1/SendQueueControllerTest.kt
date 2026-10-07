package com.nexdrop.ndt1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v1.5 Phase D — SendQueueController unit tests. Pure JVM: the controller
 * owns the queue state machine, ordering, byte-based aggregate progress,
 * retry bounds, failure isolation, duplicate protection, cancel/pause —
 * with NO engine in the room (a recording Host fakes the bridge). The real
 * TurboSender path is covered by the existing NDT1 suite + the CI smoke's
 * live transfers; these tests pin the ORCHESTRATION layer above it.
 */

/** Recording host: captures engine/UI bridge calls; scheduled actions manual. */
private class FakeHost : SendQueueController.Host {
  val started = ArrayList<SendQueueController.QueueItem>()
  val cancels = ArrayList<Unit>()
  val pauses = ArrayList<Boolean>() // true = pause
  val changed = ArrayList<Unit>()
  val finished = ArrayList<SendQueueController.Summary>()
  val scheduled = ArrayList<Pair<Long, () -> Unit>>()
  override fun startTransfer(item: SendQueueController.QueueItem) { started.add(item) }
  override fun cancelActiveTransfer() { cancels.add(Unit) }
  override fun pauseActive(pause: Boolean) { pauses.add(pause) }
  override fun schedule(delayMs: Long, action: () -> Unit) { scheduled.add(delayMs to action) }
  override fun onQueueChanged() { changed.add(Unit) }
  override fun onQueueFinished(summary: SendQueueController.Summary) { finished.add(summary) }
  fun fireScheduled() { scheduled.removeAt(0).second() }
}

private fun item(n: Int, mb: Long = 100L, uri: String = "content://f/$n") =
  SendQueueController.QueueItem(uri, "file$n", mb * 1024 * 1024, FileKind.OTHER, null, -1L)

private class Q {
  val host = FakeHost()
  val ctrl = SendQueueController(host)
  fun add(n: Int, mb: Long = 100L) = ctrl.add(item(n, mb))
}

class SendQueueControllerTest {

  @Test fun startIsSequentialOneItemAtATime() {
    val q = Q(); q.add(1); q.add(2); q.add(3)
    q.ctrl.start()
    assertEquals(1, q.host.started.size) // only the first
    assertEquals(SendQueueController.QState.TRANSFERRING, q.ctrl.current?.state)
    // completing file 1 advances to file 2 — never parallel sends
    q.ctrl.onTransferCompleted(q.ctrl.current!!)
    assertEquals(2, q.host.started.size)
    assertNotEquals(q.host.started[0], q.host.started[1])
  }

  @Test fun onlyVerifiedCompletionReachesCompleted() {
    val q = Q(); q.add(1); q.ctrl.start()
    val it1 = q.ctrl.current!!
    q.ctrl.onTransferProgress(it1.size / 2)
    assertEquals(SendQueueController.QState.TRANSFERRING, it1.state)
    q.ctrl.onTransferCompleted(it1) // engine verdict
    assertEquals(SendQueueController.QState.COMPLETED, it1.state)
    assertEquals(it1.size, it1.transferred)
  }

  @Test fun drainProducesHonestSummary() {
    val q = Q(); q.add(1, 100); q.add(2, 200); q.add(3, 700)
    q.ctrl.start()
    q.ctrl.onTransferCompleted(q.ctrl.current!!)
    q.ctrl.onTransferCompleted(q.ctrl.current!!)
    q.ctrl.onTransferCompleted(q.ctrl.current!!)
    assertEquals(1, q.host.finished.size)
    val s = q.host.finished[0]
    assertEquals(3, s.completed); assertEquals(0, s.failed)
    assertEquals(1000L * 1024 * 1024, s.completedBytes)
  }

  @Test fun hundredPlusItemsStayLightweightAndOrdered() {
    val q = Q()
    val res = q.ctrl.addBatch((1..150).map { item(it, 5) })
    assertEquals(150, res.added); assertEquals(0, res.skipped)
    assertEquals(150, q.ctrl.totalItems)
    assertEquals(150 * 5L * 1024 * 1024, q.ctrl.totalBytes)
    // drain through all of them: engine asked exactly 150 times, in order
    q.ctrl.start()
    repeat(150) { i ->
      assertEquals("file${i + 1}", q.ctrl.current!!.name)
      q.ctrl.onTransferCompleted(q.ctrl.current!!)
    }
    assertEquals(150, q.host.started.size)
    assertEquals(150, q.host.finished[0].completed)
  }

  @Test fun hundredPlusItemsDrainFastEnough() { // orchestration must not be the bottleneck
    val q = Q(); q.ctrl.addBatch((1..1000).map { item(it, 1) })
    val t0 = System.nanoTime()
    q.ctrl.start()
    repeat(1000) { q.ctrl.onTransferCompleted(q.ctrl.current!!) }
    val ms = (System.nanoTime() - t0) / 1_000_000
    assertTrue("1000-file orchestration took ${ms}ms", ms < 2000)
    assertEquals(1000, q.host.finished[0].completed)
  }
}

class QueueStateMachineTest {

  @Test fun happyPathQueuedTransferringCompleted() {
    val q = Q(); q.add(1); q.ctrl.start()
    val it1 = q.ctrl.current!!
    assertEquals(SendQueueController.QState.QUEUED, item(2).let { // untouched sibling stays queued
      q.ctrl.add(it); it.state })
  }

  @Test fun failurePathTransferringFailed() {
    val q = Q(); q.add(1); q.ctrl.start()
    val it1 = q.ctrl.current!!
    q.ctrl.onTransferError(it1, "connection refused", canAutoResume = false)
    assertEquals(SendQueueController.QState.FAILED, it1.state)
    assertEquals("connection refused", it1.error)
  }

  @Test fun cancelPathQueuedOrTransferringToCancelled() {
    val q = Q(); q.add(1); q.add(2); q.ctrl.start()
    val busy = q.ctrl.current!!
    q.ctrl.cancelCurrentTransfer()
    assertEquals(SendQueueController.QState.CANCELLED, busy.state)
    assertEquals(SendQueueController.QState.QUEUED, q.ctrl.items[1].state)
  }

  @Test fun retryPathFailedToQueuedToTransferring() {
    val q = Q(); q.add(1); q.ctrl.start()
    val it1 = q.ctrl.current!!
    q.ctrl.onTransferError(it1, "boom", canAutoResume = false)
    assertTrue(q.ctrl.retry(it1))
    assertEquals(SendQueueController.QState.TRANSFERRING, it1.state) // re-armed AND restarted
  }

  @Test fun noInventedStatesOnlyObservableOnes() {
    // The engine exposes onProgress/onComplete/onError only — so the
    // machine must not contain synthetic PREPARING/WAITING states.
    val names = SendQueueController.QState.entries.map { it.name }
    assertTrue(names.containsAll(listOf("QUEUED", "TRANSFERRING", "PAUSED", "RETRYING", "COMPLETED", "FAILED", "CANCELLED")))
    assertFalse(names.contains("PREPARING"))
    assertFalse(names.contains("WAITING_FOR_DEVICE"))
  }
}

class QueueProgressTest {

  @Test fun aggregateIsByteBasedNotPercentageAverage() {
    // 100 + 200 + 700 MB; file1 done, 100MB of file2 → 200MB/1GB = exactly 20%
    // (a naive percentage average would give (100% + 50% + 0%)/3 = 50%)
    val q = Q(); q.add(1, 100); q.add(2, 200); q.add(3, 700)
    q.ctrl.start()
    q.ctrl.onTransferCompleted(q.ctrl.current!!) // file1 verified
    q.ctrl.onTransferProgress(100L * 1024 * 1024) // durable bytes of file2
    assertEquals(200L * 1024 * 1024, q.ctrl.overallBytes)
    assertEquals(1000L * 1024 * 1024, q.ctrl.totalBytes)
    assertEquals(0.2, q.ctrl.overallFraction(), 1e-9)
  }

  @Test fun completedPlusCurrentNeverDoubleCounts() {
    val q = Q(); q.add(1, 10); q.add(2, 30)
    q.ctrl.start()
    q.ctrl.onTransferCompleted(q.ctrl.current!!) // 10MB done
    q.ctrl.onTransferProgress(15L * 1024 * 1024)
    // current moved to file2 (15MB) — completedBytes counts only file1
    assertEquals(10L * 1024 * 1024, q.ctrl.completedBytes)
    assertEquals(25L * 1024 * 1024, q.ctrl.overallBytes)
  }

  @Test fun countsStayTruthful() {
    val q = Q()
    (1..4).forEach { q.add(it) }
    q.ctrl.start()
    val it1 = q.ctrl.current!!
    q.ctrl.onTransferCompleted(it1)
    q.ctrl.onTransferError(q.ctrl.current!!, "x", canAutoResume = false) // file2 fails, file3 starts
    assertEquals(1, q.ctrl.completedCount)
    assertEquals(1, q.ctrl.failedCount)
    assertEquals(2, q.ctrl.remainingCount) // file3 in flight + file4 queued
    assertEquals(1, q.ctrl.completedBytes / (1024 * 1024) / 100 * 1) // 100MB units
    assertEquals(2, q.ctrl.currentPosition - 1) // file3 is index 2 (1-based 3)
  }

  @Test fun emptyQueueProgressIsZeroNotDivideByZero() {
    val q = Q()
    assertEquals(0L, q.ctrl.totalBytes)
    assertEquals(0.0, q.ctrl.overallFraction(), 0.0)
  }
}

class QueueOrderingTest {

  @Test fun moveUpAndDownReorderQueuedItems() {
    val q = Q(); q.add(1); q.add(2); q.add(3)
    assertTrue(q.ctrl.move(q.ctrl.items[2], up = true))   // 1,3,2
    assertEquals("file3", q.ctrl.items[1].name)
    assertTrue(q.ctrl.move(q.ctrl.items[1], up = false))  // 1,2,3
    assertEquals("file3", q.ctrl.items[2].name)
  }

  @Test fun busyItemCannotBeReordered() {
    val q = Q(); q.add(1); q.add(2); q.add(3)
    q.ctrl.start()
    val busy = q.ctrl.current!!
    assertFalse(q.ctrl.move(busy, up = true))
    assertFalse(q.ctrl.move(busy, up = false))
    assertEquals("file1", q.ctrl.items[0].name)
  }

  @Test fun boundariesRefuse() {
    val q = Q(); q.add(1); q.add(2)
    assertFalse(q.ctrl.move(q.ctrl.items[0], up = true))
    assertFalse(q.ctrl.move(q.ctrl.items[1], up = false))
  }

  @Test fun noDuplicatesAfterReorder() { // order changes, membership never duplicates
    val q = Q(); (1..5).forEach { q.add(it) }
    val c = q.ctrl.items[2]
    q.ctrl.move(c, up = true); q.ctrl.move(c, up = true); q.ctrl.move(c, up = false)
    assertEquals(5, q.ctrl.items.size)
    assertEquals(5, q.ctrl.items.map { it.stableId }.toSet().size)
  }
}

class QueueRemoveTest {

  @Test fun queuedRemovesImmediately() {
    val q = Q(); q.add(1); q.add(2)
    assertTrue(q.ctrl.remove(q.ctrl.items[1]))
    assertEquals(1, q.ctrl.totalItems)
  }

  @Test fun transferringRefusesRemoveUntilCancelled() {
    val q = Q(); q.add(1); q.add(2)
    q.ctrl.start()
    val busy = q.ctrl.current!!
    assertFalse(q.ctrl.remove(busy)) // never an orphaned sender
    q.ctrl.cancelCurrentTransfer()
    assertTrue(q.ctrl.remove(busy))
    assertEquals(1, q.ctrl.totalItems)
  }

  @Test fun failedAndCancelledRemove() {
    val q = Q(); q.add(1); q.add(2)
    q.ctrl.start()
    val it1 = q.ctrl.current!!
    q.ctrl.onTransferError(it1, "nope", canAutoResume = false)
    assertTrue(q.ctrl.remove(it1))
  }

  @Test fun completedRemovesFromQueueViewOnly() {
    val q = Q(); q.add(1); q.add(2)
    q.ctrl.start()
    val it1 = q.ctrl.current!!
    q.ctrl.onTransferCompleted(it1)
    assertTrue(q.ctrl.remove(it1)) // history is HistoryStore's business
  }

  @Test fun clearCompletedFailedAll() {
    val q = Q()
    (1..5).forEach { q.add(it) }
    q.ctrl.start()
    q.ctrl.onTransferCompleted(q.ctrl.current!!)          // f1 done
    q.ctrl.onTransferError(q.ctrl.current!!, "x", false)    // f2 failed
    q.ctrl.cancelCurrentTransfer()                          // f3 cancelled; f4, f5 queued
    assertEquals(1, q.ctrl.clearCompleted())
    assertEquals(2, q.ctrl.clearFailed()) // FAILED + CANCELLED
    assertEquals(2, q.ctrl.clearAll())     // busy excluded; none busy now
    assertEquals(0, q.ctrl.totalItems)
  }
}

class QueueRetryTest {

  @Test fun resumableDropGoesRetryingThenDurableResume() {
    val q = Q(); q.add(1); q.ctrl.start()
    val it1 = q.ctrl.current!!
    q.ctrl.onTransferProgress(50L * 1024 * 1024)
    q.ctrl.onTransferError(it1, "connection lost", canAutoResume = true)
    assertEquals(SendQueueController.QState.RETRYING, it1.state)
    assertEquals(1, q.host.scheduled.size)
    assertEquals(1000L, q.host.scheduled[0].first) // 1s backoff
    q.host.fireScheduled()
    assertEquals(SendQueueController.QState.TRANSFERRING, it1.state)
    assertEquals(2, q.host.started.size) // reconnected via existing engine (durable offset)
    // durable offset is never fabricated: progress carries where it left off
    q.ctrl.onTransferProgress(60L * 1024 * 1024)
    assertEquals(60L * 1024 * 1024, q.ctrl.current!!.transferred)
  }

  @Test fun retryBudgetIsBoundedThreeTimes() {
    val q = Q(); q.add(1); q.ctrl.start()
    val it1 = q.ctrl.current!!
    repeat(3) {
      q.ctrl.onTransferError(it1, "drop", canAutoResume = true)
      assertEquals(SendQueueController.QState.RETRYING, it1.state)
      q.host.fireScheduled()
    }
    // 4th drop: budget exhausted → FAILED, honest, no endless loop
    q.ctrl.onTransferError(it1, "drop again", canAutoResume = true)
    assertEquals(SendQueueController.QState.FAILED, it1.state)
    assertEquals("drop again", it1.error)
    assertEquals(4, q.host.started.size) // 1 + 3 retries, never a 4th
  }

  @Test fun backoffGrows() {
    val q = Q(); q.add(1); q.ctrl.start()
    val it1 = q.ctrl.current!!
    val waits = ArrayList<Long>()
    repeat(3) {
      q.ctrl.onTransferError(it1, "drop", canAutoResume = true)
      waits.add(q.host.scheduled.last().first)
      q.host.fireScheduled()
    }
    assertEquals(listOf(1000L, 2000L, 4000L), waits)
  }

  @Test fun manualRetryReArmsFailedFile() {
    val q = Q(); q.add(1); q.add(2)
    q.ctrl.start()
    val it1 = q.ctrl.current!!
    q.ctrl.onTransferError(it1, "fatal", canAutoResume = false)
    assertEquals(SendQueueController.QState.FAILED, it1.state)
    assertTrue(q.ctrl.retry(it1))
    assertEquals(SendQueueController.QState.QUEUED, it1.state)
    // file2 was already in flight from isolation — retry waits in line
    assertFalse(q.ctrl.retry(item(99))) // not FAILED → refused
  }

  @Test fun retryFailedReArmsAllFailures() {
    val q = Q()
    (1..3).forEach { q.add(it) }
    q.ctrl.start()
    q.ctrl.onTransferError(q.ctrl.current!!, "a", false)   // f1 fails, f2 starts
    q.ctrl.onTransferCompleted(q.ctrl.current!!)           // f2 done, f3 starts
    q.ctrl.onTransferError(q.ctrl.current!!, "b", false)    // f3 fails → drain
    assertEquals(2, q.ctrl.retryFailed())
    assertEquals(SendQueueController.QState.TRANSFERRING, q.ctrl.items[0].state)
  }
}

class QueueFailureIsolationTest {

  @Test fun oneFailureDoesNotCorruptTheQueue() {
    val q = Q()
    (1..3).forEach { q.add(it) }
    q.ctrl.start()
    val it1 = q.ctrl.current!!
    q.ctrl.onTransferCompleted(it1)                        // f1 done
    q.ctrl.onTransferError(q.ctrl.current!!, "interrupted", canAutoResume = false) // f2 fails
    // f3 proceeds automatically; f2 stays FAILED — never completed, never hidden
    assertEquals(SendQueueController.QState.FAILED, q.ctrl.items[1].state)
    assertEquals(3, q.host.started.size) // f1, f2, f3 — isolation continues
    q.ctrl.onTransferCompleted(q.ctrl.current!!)
    val s = q.host.finished[0]
    assertEquals(2, s.completed); assertEquals(1, s.failed)
  }

  @Test fun finishedQueueIsNotSilentAboutFailures() {
    val q = Q(); q.add(1); q.add(2)
    q.ctrl.start()
    q.ctrl.onTransferCompleted(q.ctrl.current!!)
    q.ctrl.onTransferError(q.ctrl.current!!, "x", false)
    val s = q.host.finished[0]
    assertTrue("summary must show the failure", s.failed > 0)
    assertNotEquals(s.completed, 2)
  }

}

class QueueDuplicateTest {

  @Test fun sameUriTwiceIsRefusedWithHonestCount() {
    val q = Q()
    assertEquals(SendQueueController.AddResult(1, 0), q.ctrl.add(item(1)))
    assertEquals(SendQueueController.AddResult(0, 1), q.ctrl.add(item(1))) // same URI
    assertEquals(1, q.ctrl.totalItems)
  }

  @Test fun batchReportsAddedOfTotal() { // "Added 8 of 10 — 2 duplicates skipped"
    val q = Q()
    val batch = (1..10).map { item(it) } + listOf(item(1), item(2)) // 12 entries, 2 dups
    val res = q.ctrl.addBatch(batch)
    assertEquals(10, res.added); assertEquals(2, res.skipped)
    assertEquals(10, q.ctrl.totalItems) // never claims 12
  }

  @Test fun sameContentDifferentUriIsNotADuplicate() {
    val q = Q()
    q.ctrl.add(item(1, uri = "content://pick/1"))
    assertEquals(1, q.ctrl.add(item(1, uri = "content://pick/other")).added)
  }
}

class QueueCancelTest {

  @Test fun cancelCurrentKeepsQueueAlive() {
    val q = Q(); (1..3).forEach { q.add(it) }
    q.ctrl.start()
    q.ctrl.cancelCurrentTransfer()
    assertEquals(1, q.host.cancels.size)
    assertEquals(SendQueueController.QState.CANCELLED, q.ctrl.items[0].state)
    assertEquals(SendQueueController.QState.QUEUED, q.ctrl.items[1].state)
    assertEquals(1, q.ctrl.cancelledCount); assertEquals(2, q.ctrl.remainingCount)
  }

  @Test fun cancelAllMarksUnfinishedCancelledAndKeepsHistory() {
    val q = Q(); (1..3).forEach { q.add(it) }
    q.ctrl.start()
    q.ctrl.onTransferCompleted(q.ctrl.current!!) // f1 verified-complete
    q.ctrl.cancelAll()
    assertEquals(SendQueueController.QState.COMPLETED, q.ctrl.items[0].state) // never touched
    assertEquals(SendQueueController.QState.CANCELLED, q.ctrl.items[1].state)
    assertEquals(SendQueueController.QState.CANCELLED, q.ctrl.items[2].state)
  }

  @Test fun cancelStopsPendingRetry() {
    val q = Q(); q.add(1); q.ctrl.start()
    val it1 = q.ctrl.current!!
    q.ctrl.onTransferError(it1, "drop", canAutoResume = true)
    q.ctrl.cancelCurrentTransfer()
    assertEquals(SendQueueController.QState.CANCELLED, it1.state)
    q.host.fireScheduled() // stale retry must be a no-op
    assertEquals(SendQueueController.QState.CANCELLED, it1.state)
    assertEquals(1, q.host.started.size)
  }
}

class QueuePauseResumeTest {

  @Test fun pausePausesEngineAndHoldsNextFile() {
    val q = Q(); (1..2).forEach { q.add(it) }
    q.ctrl.start()
    q.ctrl.pauseQueue()
    assertEquals(listOf(true), q.host.pauses)
    assertEquals(SendQueueController.QState.PAUSED, q.ctrl.current?.state)
    q.ctrl.onTransferCompleted(q.ctrl.current!!) // f1 completes while paused
    assertEquals(1, q.host.started.size) // f2 does NOT start
    assertTrue(q.ctrl.isPaused)
    q.ctrl.resumeQueue()
    assertEquals(2, q.host.started.size) // drain continues
  }

  @Test fun resumeUnpausesEngine() {
    val q = Q(); q.add(1); q.ctrl.start()
    q.ctrl.pauseQueue()
    q.ctrl.resumeQueue()
    assertEquals(listOf(true, false), q.host.pauses)
    assertEquals(SendQueueController.QState.TRANSFERRING, q.ctrl.current?.state)
  }

  @Test fun queuePauseWhileRetryingDefersAndResumeFiresIt() {
    val q = Q(); q.add(1); q.ctrl.start()
    val it1 = q.ctrl.current!!
    q.ctrl.onTransferError(it1, "drop", canAutoResume = true) // RETRYING armed
    q.ctrl.pauseQueue() // pause arrives during the backoff window
    q.host.fireScheduled() // retry fires but must defer (no polling)
    assertEquals(SendQueueController.QState.RETRYING, it1.state)
    assertEquals(1, q.host.started.size)
    q.ctrl.resumeQueue() // → reconnect now via existing durable-resume engine
    assertEquals(SendQueueController.QState.TRANSFERRING, it1.state)
    assertEquals(2, q.host.started.size)
  }

  @Test fun resumeBetweenFilesContinuesDrain() {
    val q = Q(); (1..2).forEach { q.add(it) }
    q.ctrl.start()
    q.ctrl.pauseQueue()
    q.ctrl.onTransferCompleted(q.ctrl.current!!) // drain halts between files
    q.ctrl.resumeQueue()
    assertEquals(2, q.host.started.size)
  }
}
