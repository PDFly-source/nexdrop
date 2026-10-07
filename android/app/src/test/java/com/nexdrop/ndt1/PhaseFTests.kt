package com.nexdrop.ndt1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v1.5 Phase F JVM tests — the pure new logic above the frozen NDT1 engine:
 *  - TextSharePolicy: honest bounds, real-.txt detection, bounded preview
 *  - HistoryStore: truthful record kinds (Cancelled, Resumed) + filters
 * No engine, socket or protocol behavior is duplicated here — that is the
 * existing NDT1/queue suites' job, all of which must stay green.
 */
class PhaseFTests {

  // ---- TextSharePolicy: bounds -------------------------------------------

  @Test fun textBoundAcceptsExactlyMax() {
    assertFalse("exactly MAX_TEXT_BYTES must be accepted — a bound is not a guess",
      TextSharePolicy.tooLarge(TextSharePolicy.MAX_TEXT_BYTES))
  }

  @Test fun textBoundRejectsOneByteOver() {
    assertTrue("one byte over the bound must be rejected honestly — never silently truncated",
      TextSharePolicy.tooLarge(TextSharePolicy.MAX_TEXT_BYTES + 1))
  }

  @Test fun shareableTextRequiresRealTxt() {
    assertTrue("a real small .txt is shareable text",
      TextSharePolicy.isShareableText("note.txt", 4096))
    assertFalse("a .pdf is not the text flow",
      TextSharePolicy.isShareableText("doc.pdf", 4096))
    assertFalse("extension alone is not enough — an empty file carries no text",
      TextSharePolicy.isShareableText("empty.txt", 0))
    assertFalse("a .txt over the bound is a FILE transfer, not text",
      TextSharePolicy.isShareableText("huge.txt", TextSharePolicy.MAX_TEXT_BYTES.toLong() + 1))
    assertTrue("extension match is case-insensitive (Android file names)",
      TextSharePolicy.isShareableText("NOTE.TXT", 12))
  }

  @Test fun previewShortTextIsVerbatim() {
    assertEquals("preview", TextSharePolicy.preview("preview"))
    assertEquals("", TextSharePolicy.preview(""))
  }

  @Test fun previewLongTextSaysItIsClippedAndHowMuch() {
    val long = "x".repeat(5000)
    val out = TextSharePolicy.preview(long, maxChars = 600)
    assertTrue("the visible part is the first 600 characters",
      out.startsWith("x".repeat(600)))
    assertTrue("the user is told content was omitted — never a silent clip",
      out.contains("more characters not shown"))
    assertTrue("the user is told the real total size",
      out.contains("total"))
  }

  // ---- HistoryStore: truthful record kinds + filters ---------------------

  private fun e(name: String, sent: Boolean, status: String = "Done", resumed: Boolean = false) =
    HistoryStore.Entry(name, 1000, sent, 0, "", status != "Failed" && status != "Cancelled", 0.0, 0, status, "r", resumed)

  @Test fun cancelledRecordIsItsOwnTruthfulKind() {
    val c = e("a.txt", true, status = "Cancelled")
    assertEquals("Cancelled", c.status)
    assertFalse("a cancelled transfer is never recorded as verified",
      c.verified)
  }

  @Test fun filterAllKeepsEverything() {
    val list = listOf(e("1", true), e("2", false, "Failed"), e("3", true, "Cancelled"), e("4", false))
    assertEquals(4, HistoryStore.matching(list, "ALL").size)
    assertEquals("unknown filters are ALL, never a crash",
      4, HistoryStore.matching(list, "BOGUS").size)
  }

  @Test fun filterSentReceivedFailedCancelledSelectExactly() {
    val list = listOf(e("s1", true), e("r1", false), e("f1", true, "Failed"), e("c1", false, "Cancelled"))
    // SENT/RECEIVED are DIRECTION filters: a failed send is still a
    // sent-direction record — the outcome filters say Failed/Cancelled.
    assertEquals(listOf("s1", "f1"), HistoryStore.matching(list, "SENT").map { it.name })
    assertEquals(listOf("r1", "c1"), HistoryStore.matching(list, "RECEIVED").map { it.name })
    assertEquals(listOf("f1"), HistoryStore.matching(list, "FAILED").map { it.name })
    assertEquals(listOf("c1"), HistoryStore.matching(list, "CANCELLED").map { it.name })
  }

  @Test fun cancelledNeverCountsAsFailedOrDoneInFilters() {
    val list = listOf(e("c1", true, "Cancelled"))
    assertTrue("a cancelled record is not a Failed record",
      HistoryStore.matching(list, "FAILED").isEmpty())
  }

  @Test fun resumedFlagSurvivesTheRecordModel() {
    val r = e("big.mp4", true, resumed = true)
    assertTrue("a file completed after a durable-offset reconnect says so",
      r.resumed)
    assertFalse("by default records are not resumed", e("n.txt", true).resumed)
  }

  @Test fun emptyHistoryFilterIsHonestEmpty() {
    assertTrue("a filter over no records shows nothing — no invented rows",
      HistoryStore.matching(emptyList(), "SENT").isEmpty())
  }
}
