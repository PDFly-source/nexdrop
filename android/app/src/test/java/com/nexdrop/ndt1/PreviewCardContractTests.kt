package com.nexdrop.ndt1

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FINAL POLISH (preview cards + transfer init) — source-pinned contract.
 * (JVM cannot inflate views; real rendered measurements live in
 * QueueRowVisualInstrumentedTest on the CI emulator, per the established
 * PermissionReadinessTests/ConnectionClarityTests convention.)
 *
 * Pinned rules (§2–§13 of the polish task):
 *  - the preview surface is a DETERMINISTIC bounded 64 dp square — never
 *    full-screen, never fillMaxHeight/fillMaxSize, never a weight-fill
 *  - real previews crop INSIDE the bounded thumb (CENTER_CROP — no dark
 *    letterbox bands, no black/empty card)
 *  - the honest typed fallback stays COMPACT inside the same bounds
 *  - the queue row stays a compact horizontal card (wrap-content, no fixed
 *    poster height)
 *  - the transfer ring NEVER initializes to "0 MiB of 0 MiB" when the real
 *    size is known: it starts at 0 of the REAL total with "Preparing…"
 *  - live progress values survive a re-render (PAUSE relabel) via
 *    ringDurable/ringTotal — no visual reset to 0%
 *  - the connection-clarity patch stays untouched (regression guard)
 */
class PreviewCardContractTests {
  private fun file(path: String): File {
    val cands = listOf("src/main/$path", "app/src/main/$path")
    return cands.map { File(it) }.first { it.exists() }
  }
  private val src: String by lazy { file("java/com/nexdrop/ndt1/MainActivity.kt").readText() }
  private fun fn(name: String) = src.substringAfter("private fun $name").substringBefore("\n  private fun ")

  // ---- §5: deterministic bounded thumbnail dimensions ----

  @Test fun previewSurfaceIsAFixed64dpSquare() {
    val fn = fn("previewBox")
    assertTrue("preview frame is a fixed 64 dp square",
      fn.contains("LinearLayout.LayoutParams(dp(64), dp(64))"))
    assertFalse("preview never fills row height", fn.contains("fillMaxHeight"))
    assertFalse("preview never fills the screen", fn.contains("fillMaxSize"))
    assertFalse("preview height never wraps content",
      fn.contains("WRAP_CONTENT") && fn.contains("dp(64)"))
  }

  @Test fun typedFallbackIconStaysProportionalInsideTheThumb() {
    val fn = fn("previewBox")
    // the fallback glyph is padding-fit INSIDE the 64 dp bounds — no
    // tiny lost icon, no oversized icon overflowing the thumb
    assertTrue(fn.contains("setPadding(dp(18), dp(18), dp(18), dp(18))"))
  }

  // ---- §5/§7: real previews crop inside the bounded thumb ----

  @Test fun realThumbnailsCropInsideTheBoundedThumb() {
    val fn = fn("applyThumb")
    assertTrue("real previews use CENTER_CROP inside the 64 dp frame",
      fn.contains("ImageView.ScaleType.CENTER_CROP"))
    assertFalse("letterboxing (FIT_CENTER in a dark square) must not return to real thumbs",
      fn.contains("FIT_CENTER"))
    assertTrue("the bitmap fills the bounded frame only",
      fn.contains("MATCH_PARENT"))
  }

  // ---- §12: the queue row stays a compact card ----

  @Test fun queueRowStaysCompactHorizontalCard() {
    val fn = fn("queueRow")
    assertTrue("queue row is horizontal", fn.contains("LinearLayout.HORIZONTAL"))
    assertFalse("no fixed poster height in the row",
      Regex("dp\\((1[4-9][0-9]|[2-9][0-9][0-9])\\)").containsMatchIn(fn))
    assertFalse("no fillMaxHeight in the row", fn.contains("fillMaxHeight"))
  }

  // ---- §13: honest transfer initialization ----

  @Test fun transferRingNeverShowsZeroOfZeroWhenSizeIsKnown() {
    val fn = fn("renderTransfer")
    assertFalse("the honest init must not fall back to a hardcoded total",
      fn.contains("\"0 MiB\\nof 0 MiB\""))
    assertTrue("ring initializes from the KNOWN size (or live values)",
      fn.contains("if (live) ringTotal else currentSize"))
    assertTrue("byte text uses the real total",
      fn.contains("bytesText(t0)"))
    assertTrue("pre-transfer state is labeled Preparing, honestly",
      fn.contains("Preparing…"))
  }

  @Test fun etaNeverFabricatesBeforeFirstRealSample() {
    val fn = fn("renderTransfer")
    assertFalse("no fake ETA line before the first sample",
      fn.contains("\"ETA —\""))
    assertTrue("pre-sample state says Preparing…",
      fn.contains("else -> \"Preparing…\""))
  }

  @Test fun liveProgressSurvivesReRender() {
    // onProgress records the live (durable,total); renderTransfer restores them
    assertTrue(src.contains("ringDurable = durable; ringTotal = total"))
    assertTrue(src.contains("if (live) ringDurable else 0L"))
    // beginTransfer clears the snapshot per file/attempt
    assertTrue(src.contains("ringDurable = 0; ringTotal = 0"))
  }

  // ---- §14: connection-clarity regression guard (stays intact) ----

  @Test fun connectionClarityPatchIsUntouched() {
    assertFalse("the confusing listening row must not return",
      src.contains("Listening unavailable — QR pairing still works"))
    assertFalse("never claims Internet is required for a shared local network",
      src.contains("Internet is required"))
    assertFalse("never promises cellular-to-cellular transfer",
      src.contains("mobile data to each other"))
    assertFalse("never sells QR as creating the network connection",
      src.contains("QR creates a network connection"))
    assertTrue("the endpoint-unavailable screen keeps its title",
      src.contains("LOCAL CONNECTION UNAVAILABLE"))
    assertTrue("the supported-path guidance stays",
      src.contains("same Wi-Fi, or one phone's hotspot with the other connected"))
  }

  // ---- §6/§10: previews never fake, fallbacks stay honest ----

  @Test fun previewPipelineNeverFakesAThumbnail() {
    val pp = file("java/com/nexdrop/ndt1/PreviewProvider.kt").readText()
    // corrupted/inaccessible content keeps the honest typed icon — the
    // queue surface must never substitute a blank/black placeholder
    assertTrue(pp.contains("PreviewResult.TypedIcon // corrupted / inaccessible / revoked — honest fallback, never a crash"))
    assertFalse("no black placeholder bitmap is manufactured",
      pp.contains("createBitmap(width, height) //") && pp.contains("BLACK"))
  }

  @Test fun previewPlanCoversEveryKindWithAHonestPath() {
    val pp = file("java/com/nexdrop/ndt1/PreviewProvider.kt").readText()
    for (k in listOf("IMAGE", "VIDEO", "AUDIO", "PDF", "APK", "ICON"))
      assertTrue("plan covers $k", pp.contains("PreviewPlan.$k"))
    // bounded: a 10 GB file yields metadata + a <=512 px preview, never more
    assertTrue(pp.contains("MAX_DIM") || pp.contains("512"))
  }
}
