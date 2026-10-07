package com.nexdrop.ndt1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import com.nexdrop.ndt1.ui.D
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v1.5 FINAL HARDENING tests — the root causes found in the owner's
 * two-device physical validation:
 *
 *  (a) transfer state was ACTIVITY-scoped: a recreated Activity built a
 *      SECOND SendQueueController next to the live one (duplicate jobs,
 *      unreliable terminal protection, lost queues). The controller is
 *      now process-scoped with a rebindable host — these tests pin it.
 *  (b) theme tokens must genuinely switch (light ≠ dark, contrast-grade).
 *
 * The receiver EOF watchdog is timing-based UI recovery and stays with the
 * instrumented/physical matrix; engine behavior is unchanged (:ndt1 frozen).
 */
class HardeningTests {

  private class FakeHost : SendQueueController.Host {
    val started = ArrayList<SendQueueController.QueueItem>()
    val cancels = ArrayList<Unit>()
    val pauses = ArrayList<Boolean>()
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

  // ---- process-scoped controller survives an Activity recreation ---------

  @Test fun rebindHostKeepsTheSingleControllerState() {
    val oldHost = FakeHost()
    val ctrl = SendQueueController(oldHost)
    ctrl.add(item(1)); ctrl.add(item(2))
    ctrl.start()
    assertEquals(SendQueueController.QState.TRANSFERRING, ctrl.current?.state)

    // Activity recreation: a NEW host rebinds — same controller, same live
    // transfer, NO second queue, NO second startTransfer call.
    val newHost = FakeHost()
    ctrl.rebindHost(newHost)
    ctrl.onTransferProgress(50L * 1024 * 1024)
    ctrl.onTransferCompleted(ctrl.current!!)
    assertEquals("the rebinding must not re-run the transfer",
      1, oldHost.started.size)
    assertEquals("state survived the recreation",
      SendQueueController.QState.COMPLETED, ctrl.items[0].state)
    assertEquals("file 2 started exactly once after file 1 completed",
      1, newHost.started.size)
    assertEquals(SendQueueController.QState.TRANSFERRING, ctrl.current?.state)
  }

  @Test fun rebindDoesNotWeakenTerminalStateGuards() {
    val ctrl = SendQueueController(FakeHost())
    ctrl.add(item(1)); ctrl.start()
    val it1 = ctrl.current!!
    ctrl.rebindHost(FakeHost())
    ctrl.onTransferCompleted(it1) // terminal: COMPLETED
    ctrl.onTransferError(it1, "late straggler error", canAutoResume = false)
    assertNotEquals("a late error can never rewrite a COMPLETED item",
      SendQueueController.QState.FAILED, it1.state)
    assertEquals(SendQueueController.QState.COMPLETED, it1.state)
  }

  @Test fun cancelledItemsNeverAutoRestartAfterRebind() {
    val host = FakeHost()
    val ctrl = SendQueueController(host)
    ctrl.add(item(1)); ctrl.add(item(2))
    ctrl.start()
    val it1 = ctrl.current!!
    val host2 = FakeHost()
    ctrl.rebindHost(host2)
    ctrl.onTransferError(it1, "reset", canAutoResume = true) // drop: resumable → bounded retry
    host2.fireScheduled() // retry #1 → RETRYING (timer fires on the REBOUND host)
    ctrl.cancelCurrentTransfer() // user cancels the retry
    assertEquals(SendQueueController.QState.CANCELLED, it1.state)
    assertEquals("cancel leaves the queue idle (truthful Phase D semantics)",
      null, ctrl.current)
    assertEquals("file2 stays QUEUED, never auto-started after the cancel",
      SendQueueController.QState.QUEUED, ctrl.items[1].state)
    assertTrue("the cancelled item never re-enters the active queue",
      ctrl.items.none { it.name == "file1" && it.state == SendQueueController.QState.TRANSFERRING })
    // and a later explicit start() picks the next file, not the cancelled one
    ctrl.start()
    assertEquals("file2", ctrl.current?.name)
  }

  // ---- light theme tokens --------------------------------------------------

  @Test fun lightThemeReallySwitchesTokensWithContrast() {
    D.apply(false)
    val darkBg = D.BG; val darkText = D.TEXT
    D.apply(true)
    assertNotEquals("background must actually change in light mode", darkBg, D.BG)
    assertNotEquals("primary text must actually change in light mode", darkText, D.TEXT)
    val bg = D.BG.toInt()
    val tx = D.TEXT.toInt()
    assertTrue("light background is a light surface",
      (bg shr 16 and 0xFF) > 0xE0)
    assertTrue("light primary text is dark on the light background",
      (tx shr 16 and 0xFF) < 0x40)
    D.apply(false) // restore for the rest of the suite
  }

  @Test fun qrModuleColorIsThemeInvariant() {
    D.apply(true)
    val lightQr = D.QR_DARK.toInt()
    D.apply(false)
    assertEquals("QR modules stay dark-on-white in BOTH themes — scannable",
      lightQr, D.QR_DARK.toInt())
  }
}
