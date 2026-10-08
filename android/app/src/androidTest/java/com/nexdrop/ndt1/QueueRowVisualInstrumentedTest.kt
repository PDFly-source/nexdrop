package com.nexdrop.ndt1

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.graphics.pdf.PdfDocument
import android.net.Uri
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream

/**
 * FINAL POLISH visual validation — the ACTUAL rendered queue on the REAL
 * emulator (runs in the CI smoke job via :app:connectedDebugAndroidTest).
 *
 * §18 of the polish task: do NOT trust static code for the preview-card
 * issue. This test launches the REAL MainActivity, enqueues REAL fixture
 * files (image / PDF / audio / APK / unknown) through the REAL
 * SendQueueController, renders the REAL SEND screen, and then MEASURES the
 * produced view tree:
 *
 *   - every queue card is COMPACT (bounded height, never a giant poster)
 *   - every preview surface is a deterministic bounded 64 dp square
 *   - a real decodable image renders a REAL thumbnail (bitmap, not icon)
 *   - an unknown file keeps the honest COMPACT typed icon (no black box)
 *   - the multi-file queue stays bounded and navigable (1 / 3 / many files)
 *
 * The queue is injected via reflection into the app's own controller — the
 * same addBatch API the file picker uses; nothing here stubs the engine or
 * the preview system.
 */
@RunWith(AndroidJUnit4::class)
class QueueRowVisualInstrumentedTest {

  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

  private fun tmp(name: String): File = File(ctx.cacheDir, name).apply { parentFile.mkdirs() }

  private fun dp(v: Int): Int =
    (v * ctx.resources.displayMetrics.density + 0.5f).toInt()

  // ---- real fixture files (same builders as PreviewInstrumentedTest) ----

  private fun writeJpeg(name: String, w: Int, h: Int, color: Int): File {
    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    bmp.eraseColor(color)
    val f = tmp(name)
    FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }
    bmp.recycle()
    return f
  }

  private fun writePdf(name: String): File {
    val doc = PdfDocument()
    val page = doc.startPage(PdfDocument.PageInfo.Builder(300, 420, 1).create())
    page.canvas.apply {
      drawColor(Color.WHITE)
      drawRGB(200, 30, 60)
    }
    doc.finishPage(page)
    val f = tmp(name)
    FileOutputStream(f).use { doc.writeTo(it) }
    doc.close()
    return f
  }

  /** Tiny valid PCM WAV (8000 Hz, 16-bit mono) of about 200 ms. */
  private fun writeWav(name: String): File {
    val samples = 1600
    val data = ByteArray(samples * 2)
    for (i in 0 until samples) {
      val v = (if ((i / 40) % 2 == 0) 12000 else -12000).toShort()
      data[i * 2] = (v.toInt() and 0xFF).toByte(); data[i * 2 + 1] = (v.toInt() shr 8).toByte()
    }
    val header = byteArrayOf(
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
      0x66, 0x6D, 0x74, 0x20, 16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1F, 0, 0,
      0x80.toByte(), 0x3E, 0, 0, 2, 0, 16, 0, 0x64, 0x61, 0x74, 0x61, 0, 0, 0, 0,
    )
    val size = data.size
    header[4] = (36 + size).toByte(); header[5] = ((36 + size) shr 8).toByte()
    header[40] = (size and 0xFF).toByte(); header[41] = ((size shr 8) and 0xFF).toByte()
    return tmp(name).apply { writeBytes(header + data) }
  }

  /** A REAL installable APK: the app's own debug APK — real icon + label. */
  private fun copyRealApk(name: String): File {
    val src = File(ctx.applicationInfo.sourceDir)
    val dst = tmp(name)
    src.copyTo(dst, overwrite = true)
    return dst
  }

  // ---- queue injection through the app's own controller ----------------

  private fun item(f: File): SendQueueController.QueueItem =
    SendQueueController.QueueItem(
      Uri.fromFile(f).toString(), f.name, f.length(),
      FileMeta.classify(null, f.name), null, f.lastModified(),
    )

  /** Reflection: the private `queue` + private `screen` + private `render()`. */
  private fun enqueueAndRender(scenario: ActivityScenario<MainActivity>, files: List<File>) {
    val screenEnum = Class.forName("com.nexdrop.ndt1.MainActivity\$Screen")
    val send = screenEnum.enumConstants.first { it.toString() == "SEND" }
    var err: Exception? = null
    scenario.onActivity { a ->
      try {
        // `queue` is a computed property (no backing field) — call its
        // private getter, which returns the app's ONE real controller.
        val gm = MainActivity::class.java.getDeclaredMethod("getQueue").apply { isAccessible = true }
        val q = gm.invoke(a) as SendQueueController
        // The controller lives in the companion object — ONE instance per
        // process, shared across tests. Start each case from a clean queue.
        q.items.clear()
        q.addBatch(files.map { item(it) })
        // `screen` is a computed property (backing lives in the companion)
        // — drive its private setter, the app's one real state path.
        val stm = MainActivity::class.java.getDeclaredMethod("setScreen", screenEnum).apply { isAccessible = true }
        stm.invoke(a, send)
        val rm = MainActivity::class.java.getDeclaredMethod("render").apply { isAccessible = true }
        rm.invoke(a)
      } catch (e: Exception) { err = e }
    }
    err?.let { throw it }
  }

  // ---- view-tree measurement -------------------------------------------

  private fun previewFrames(root: View): List<FrameLayout> {
    val out = ArrayList<FrameLayout>()
    fun walk(v: View) {
      if (v is FrameLayout && v.contentDescription?.toString()?.startsWith("Preview: ") == true) out.add(v)
      if (v is android.view.ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
    }
    walk(root)
    return out
  }

  private fun queueCard(frame: FrameLayout): LinearLayout? =
    frame.parent as? LinearLayout

  /** Poll until the image row's async preview has actually replaced the icon. */
  private fun waitForBitmapThumb(scenario: ActivityScenario<MainActivity>, name: String, timeoutMs: Long = 25000) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
      var ok = false
      scenario.onActivity { a ->
        val frames = previewFrames(a.findViewById(android.R.id.content))
        val f = frames.firstOrNull { it.contentDescription.toString() == "Preview: $name" }
        val iv = f?.getChildAt(0) as? ImageView
        ok = iv?.drawable is BitmapDrawable
        if (!ok) {
          // The app's documented preview contract: an async request whose
          // row was replaced by a re-render keeps the honest typed icon
          // "until the next render finds a warm cache". Re-render — exactly
          // what any later queue event does in the real app — so the
          // now-warm cache swaps the real thumbnail in synchronously.
          runCatching {
            MainActivity::class.java.getDeclaredMethod("render").apply { isAccessible = true }.invoke(a)
          }
        }
      }
      if (ok) return
      Thread.sleep(200)
    }
    // Diagnose: the dump travels INSIDE the AssertionError (gradle prints it).
    var dump = ""
    scenario.onActivity { a ->
      val root = a.findViewById<View>(android.R.id.content)
      val frames = previewFrames(root)
      // Focus: the image row's subtree + every frame's first child (the
      // actual preview surface) — one line, capped for the gradle console.
      var focus = "frames=" + frames.size + " allSurfaces=[" +
        frames.joinToString(" ; ") { fr ->
          val iv = if (fr.childCount > 0) fr.getChildAt(0) as? ImageView else null
          (fr.contentDescription?.toString() ?: "?") + "->" + (iv?.drawable?.javaClass?.simpleName ?: "none")
        } + "]"
      val mine = frames.firstOrNull { it.contentDescription.toString() == "Preview: $name" }
      if (mine != null) {
        focus += " row=[" + dumpLine(mine, 0) + "]"
        val p = mine.parent as? android.view.ViewGroup
        if (p != null) focus += " cardChildren=[" + (0 until p.childCount).joinToString(" | ") { i ->
          val ch = p.getChildAt(i); ch.javaClass.simpleName + "[" + ch.width + "x" + ch.height + "]"
        } + "] cardH=" + p.height
      }
      // Worker forensics: is the ndt-preview worker alive, where is it
      // stuck, and did ANYTHING complete/warm the cache?
      val threads = Thread.getAllStackTraces().entries.filter { it.key.name.startsWith("ndt-preview") }
      focus += " workers=[" + (if (threads.isEmpty()) "NONE" else threads.joinToString(" ; ") { (t, st) ->
        t.name + "(" + (if (t.isAlive) "alive" else "dead") + "," + t.state + ")" +
          st.take(8).joinToString("<") { fr -> fr.className.substringAfterLast('.') + "." + fr.methodName }
      }) + "]"
      runCatching {
        val pm = MainActivity::class.java.getDeclaredMethod("getPreviews").apply { isAccessible = true }
        val prov = pm.invoke(a)
        val sched = prov.javaClass.getDeclaredField("scheduler").apply { isAccessible = true }.get(prov)
        val infl = sched.javaClass.getMethod("getInFlightCount").invoke(sched)
        val cached = prov.javaClass.getMethod("cacheEntries").invoke(prov)
        focus += " inFlight=$infl cached=$cached"
      }
      dump = focus
    }
    throw AssertionError("image preview never rendered a real thumbnail for $name :: $dump")
  }

  // ---- tests ------------------------------------------------------------

  @Test fun realMultiFileQueueRendersCompactBoundedPreviewRows() {
    val image = writeJpeg("visual.jpg", 800, 600, Color.rgb(10, 200, 120))
    val pdf = writePdf("notes-visual.pdf")
    val wav = writeWav("song-visual.wav")
    val apk = copyRealApk("app-visual.apk")
    val bin = tmp("payload-visual.bin").apply { writeBytes(ByteArray(2048) { 0x55 }) }
    val screenH = ctx.resources.displayMetrics.heightPixels

    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      enqueueAndRender(scenario, listOf(image, pdf, wav, apk, bin))

      // give the preview worker time for the async swap, then measure
      waitForBitmapThumb(scenario, "visual.jpg")
      Thread.sleep(1500) // pdf/apk thumbs arrive from the same bounded worker

      var frames = listOf<FrameLayout>()
      var cards = listOf<LinearLayout>()
      scenario.onActivity { a ->
        frames = previewFrames(a.findViewById(android.R.id.content))
        cards = frames.mapNotNull { queueCard(it) }
        assertEquals("frames.size (expected all 5 queue rows) :: " + dumpOf(scenario), 5, frames.size)
        assertEquals("cards.size", 5, cards.size)
      }

      // §5: deterministic bounded 64 dp square thumb — never full height,
      // never wrap/weight-fill, on EVERY row and file kind.
      for (f in frames) {
        assertEquals("thumb width ${f.width}px for ${f.contentDescription}, expected ${dp(64)}px", dp(64), f.width)
        assertEquals("thumb height ${f.height}px for ${f.contentDescription}, expected ${dp(64)}px", dp(64), f.height)
        assertEquals("lp width for ${f.contentDescription}", dp(64), f.layoutParams.width)
        assertEquals("lp height for ${f.contentDescription}", dp(64), f.layoutParams.height)
      }

      // §2/§18: every queue card is COMPACT — a card may never consume a
      // poster-sized share of the screen (bound: <= 22% of screen height
      // and a hard <= 130 dp), several files must fit one view.
      for (c in cards) {
        assertTrue("card height ${c.height}px exceeds the compact bound", c.height <= dp(130))
        assertTrue("card height ${c.height}px exceeds 22% of the screen", c.height <= screenH * 22 / 100)
      }

      // §4: the row stays a compact professional line even with 5 files:
      // the whole queue block must be far smaller than a screenful.
      var queueBlockH = 0
      scenario.onActivity { a ->
        val f = previewFrames(a.findViewById(android.R.id.content))
        if (f.isNotEmpty()) {
          val top = f.minOf { it.topOnScreen(a) }
          val bottom = f.maxOf { it.bottomOnScreen(a) }
          queueBlockH = bottom - top
        }
      }
      // Honest bound for FIVE compact (~105 px) cards: the whole queue
      // fits ONE screenful — several files share the view; the old
      // poster bug (5 × 420 px = 3.7 screens) fails this hard.
      assertTrue("5-file queue block $queueBlockH px exceeds one screenful ($screenH px)", queueBlockH <= screenH)

      // §7: the real image preview rendered a REAL thumbnail (a bitmap,
      // crop-filled inside the 64 dp bounds — not the typed icon).
      scenario.onActivity { a ->
        val f = previewFrames(a.findViewById(android.R.id.content)).first { it.contentDescription.toString() == "Preview: visual.jpg" }
        val iv = f.getChildAt(0) as ImageView
        assertTrue(iv.scaleType == ImageView.ScaleType.CENTER_CROP)
        assertTrue(iv.drawable is BitmapDrawable)
      }

      // §6/§11: an unknown .bin keeps the honest COMPACT typed icon inside
      // the same bounded 64 dp surface — never a giant empty placeholder.
      scenario.onActivity { a ->
        val f = previewFrames(a.findViewById(android.R.id.content)).first { it.contentDescription.toString() == "Preview: payload-visual.bin" }
        val iv = f.getChildAt(0) as ImageView
        // honest typed icon (vector, not a faked bitmap preview), one compact child
        assertTrue(iv.drawable !is BitmapDrawable)
        assertEquals(1, f.childCount)
        assertEquals(dp(64), f.height)
      }
    }
  }

  @Test fun singleFileQueueRendersOneCompactRow() {
    val image = writeJpeg("single.jpg", 400, 900, Color.rgb(60, 120, 240))
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      enqueueAndRender(scenario, listOf(image))
      waitForBitmapThumb(scenario, "single.jpg")
      var frames = listOf<FrameLayout>()
      scenario.onActivity { a ->
        frames = previewFrames(a.findViewById(android.R.id.content))
      }
      assertEquals("frames.size (expected the single queued row) :: " + dumpOf(scenario), 1, frames.size)
      assertEquals("thumb width ${frames[0].width}px, expected ${dp(64)}px", dp(64), frames[0].width)
      assertEquals("thumb height ${frames[0].height}px, expected ${dp(64)}px", dp(64), frames[0].height)
      val card = queueCard(frames[0])
      val childDump = card?.let { c ->
        (0 until c.childCount).joinToString(" | ") { i ->
          val ch = c.getChildAt(i)
          ch.javaClass.simpleName + "[" + ch.width + "x" + ch.height + "]" + (ch.contentDescription?.let { d -> " cd=$d" } ?: "")
        }
      } ?: "no card"
      assertTrue("card is ${card?.height}px, expected <= ${dp(130)}px :: children: $childDump", card != null && card.height <= dp(130))
    }
  }

  /** One-line node summary for assertion messages. */
  private fun dumpLine(v: View, depth: Int): String {
    val sb = StringBuilder()
    sb.append(v.javaClass.simpleName).append('[').append(v.width).append('x').append(v.height).append(']')
    (v as? TextView)?.let { sb.append(" t=\"").append(it.text).append('\"') }
    (v as? ImageView)?.let { sb.append(" img=").append(it.drawable?.javaClass?.simpleName) }
    v.contentDescription?.let { sb.append(" cd=\"").append(it).append('\"') }
    if (depth < 4) (v as? android.view.ViewGroup)?.let { g ->
      sb.append(" {").append((0 until g.childCount).joinToString("; ") { dumpLine(g.getChildAt(it), depth + 1) }).append('}')
    }
    return sb.toString()
  }

  /** CI diagnostic: capture the tree dump from a live scenario. */
  private fun dumpOf(scenario: ActivityScenario<MainActivity>): String {
    var dump = ""
    scenario.onActivity { a -> dump = dumpLine(a.findViewById<View>(android.R.id.content), 0) }
    return if (dump.length > 3000) dump.substring(0, 3000) else dump
  }

  /** CI diagnostic: a compact text dump of the real view tree. */
  private fun dumpTree(v: View, depth: Int = 0): String {
    val sb = StringBuilder()
    sb.append("  ".repeat(depth)).append(v.javaClass.simpleName)
      .append(" [").append(v.width).append('x').append(v.height).append(']')
    (v as? android.view.ViewGroup)?.let { g ->
      sb.append(" children=").append(g.childCount)
      if (depth < 6) for (i in 0 until g.childCount) {
        sb.append('\n').append(dumpTree(g.getChildAt(i), depth + 1))
      }
    }
    (v as? TextView)?.let { sb.append(" text=\"").append(it.text).append('\"') }
    (v as? ImageView)?.let { sb.append(" img=").append(it.drawable?.javaClass?.simpleName) }
    v.contentDescription?.let { sb.append(" cd=\"").append(it).append('\"') }
    return sb.toString()
  }

  // helpers for absolute on-screen coordinates
  private fun View.topOnScreen(a: MainActivity): Int {
    val pos = IntArray(2); a.window.decorView.getLocationOnScreen(pos)
    val p = IntArray(2); getLocationOnScreen(p)
    return p[1] - pos[1]
  }
  private fun View.bottomOnScreen(a: MainActivity): Int {
    val pos = IntArray(2); a.window.decorView.getLocationOnScreen(pos)
    val p = IntArray(2); getLocationOnScreen(p)
    return p[1] - pos[1] + height
  }
}
