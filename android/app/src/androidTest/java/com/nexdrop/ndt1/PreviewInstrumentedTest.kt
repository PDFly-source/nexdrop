package com.nexdrop.ndt1

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfDocument
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNotNull
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * v1.5 Phase C instrumented tests — REAL Android-frame generation on the
 * emulator (runs in the CI smoke job via :app:connectedDebugAndroidTest).
 * Exercises the actual decoders: bounded ImageDecoder thumbnails, PDF page-1
 * renders, APK package-metadata extraction, audio duration, and the honest
 * TypedIcon fallback for corrupted / inaccessible inputs.
 */
@RunWith(AndroidJUnit4::class)
class PreviewInstrumentedTest {

  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
  private val prov = PreviewProvider(ctx)

  // ---- helpers ---------------------------------------------------------

  private fun tmp(name: String): File = File(ctx.cacheDir, name).apply { parentFile.mkdirs() }

  private fun writeJpeg(name: String, w: Int, h: Int, color: Int): File {
    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    bmp.eraseColor(color)
    val f = tmp(name)
    FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }
    bmp.recycle()
    return f
  }

  private fun writeBytes(name: String, bytes: ByteArray): File =
    tmp(name).apply { writeBytes(bytes) }

  private fun writePdf(name: String): File {
    val doc = PdfDocument()
    val page = doc.startPage(PdfDocument.PageInfo.Builder(300, 300, 1).create())
    val c = page.canvas
    c.drawColor(Color.WHITE)
    c.drawRGB(200, 30, 60)
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
      0x80, 0x3E, 0, 0, 2, 0, 16, 0, 0x64, 0x61, 0x74, 0x61,
    )
    val size = data.size
    header[4] = (36 + size).toByte(); header[5] = ((36 + size) shr 8).toByte()
    header[40] = (size and 0xFF).toByte(); header[41] = ((size shr 8) and 0xFF).toByte()
    val f = tmp(name)
    f.writeBytes(header + data)
    return f
  }

  private fun gen(f: File, kind: FileKind, mime: String? = null): PreviewResult =
    prov.generate(Uri.fromFile(f), f.length(), f.lastModified(), kind, mime)

  // ---- images ------------------------------------------------------------

  @Test fun validJpegProducesBoundedThumbnail() {
    val f = writeJpeg("valid.jpg", 800, 600, Color.rgb(10, 200, 120))
    val r = gen(f, FileKind.IMAGE)
    assertTrue(r is PreviewResult.ImagePreview)
    r as PreviewResult.ImagePreview
    assertTrue(r.bitmap.width in 1..512 && r.bitmap.height in 1..512)
  }

  @Test fun hugeJpegStaysBounded() {
    val f = writeJpeg("huge.jpg", 2048, 2048, Color.RED)
    val r = gen(f, FileKind.IMAGE)
    assertTrue(r is PreviewResult.ImagePreview)
    r as PreviewResult.ImagePreview
    assertTrue(maxOf(r.bitmap.width, r.bitmap.height) <= 512)
  }

  @Test fun corruptedJpegFallsBackToTypedIcon() {
    val f = writeBytes("corrupt.jpg", byteArrayOf(-1, -40, -1, -37) + ByteArray(64) { 7 })
    assertTrue(gen(f, FileKind.IMAGE) is PreviewResult.TypedIcon)
  }

  // ---- video (corrupted → TypedIcon; valid frame if a system sample exists) ----

  @Test fun invalidMp4FallsBackToTypedIcon() {
    val f = writeBytes("bad.mp4", ByteArray(256) { 0x55 })
    assertTrue(gen(f, FileKind.VIDEO) is PreviewResult.TypedIcon)
  }

  // ---- audio -------------------------------------------------------------

  @Test fun wavAudioPreviewNeverCrashesAndDurationIsRealWhenExtracted() {
    val f = writeWav("tone.wav") // 8000 Hz, 16-bit mono, ~200 ms — CORRECT RIFF header
    val r = gen(f, FileKind.AUDIO, "audio/x-wav")
    assertTrue("got $r", r is PreviewResult.AudioPreview)
    r as PreviewResult.AudioPreview
    // The audio contract: duration is REAL when MediaMetadataRetriever
    // extracts it, honestly -1 when the platform cannot. Either way it is
    // never fabricated and never crashes.
    if (r.durationMs != -1L) assertTrue("duration ${r.durationMs}", r.durationMs in 100..3000)
  }

  // ---- PDF ---------------------------------------------------------------

  @Test fun validPdfRendersFirstPage() {
    val f = writePdf("doc.pdf")
    val r = gen(f, FileKind.PDF)
    assertTrue(r is PreviewResult.PdfPreview)
    r as PreviewResult.PdfPreview
    assertTrue(r.page.width in 1..512 && r.page.height in 1..512)
  }

  @Test fun corruptedPdfFallsBackToTypedIcon() {
    val f = writeBytes("bad.pdf", "%PDF-1.4 garbage-not-a-real-pdf".toByteArray())
    assertTrue(gen(f, FileKind.PDF) is PreviewResult.TypedIcon)
  }

  // ---- APK (metadata extraction only — never install/launch/execute) ------

  @Test fun realApkYieldsPackagePreview() {
    val apk = File(InstrumentationRegistry.getInstrumentation().context.packageCodePath)
    val r = gen(apk, FileKind.APK)
    assertTrue("got $r", r is PreviewResult.ApkPreview)
    r as PreviewResult.ApkPreview
    assertNotNull(r.icon)
  }

  @Test fun invalidApkFallsBackToTypedIcon() {
    val f = writeBytes("bad.apk", ByteArray(128) { 9 })
    assertTrue(gen(f, FileKind.APK) is PreviewResult.TypedIcon)
  }

  // ---- typed fallbacks ----------------------------------------------------

  @Test fun zipUnknownAndDocAreTypedIcons() {
    val z = writeBytes("a.zip", byteArrayOf(0x50, 0x4B, 0x03, 0x04) + ByteArray(32))
    assertTrue(gen(z, FileKind.ARCHIVE, "application/zip") is PreviewResult.TypedIcon)
    val d = writeBytes("notes.txt", "hello".toByteArray())
    assertTrue(gen(d, FileKind.DOC, "text/plain") is PreviewResult.TypedIcon)
    val u = writeBytes("blob.xyz", ByteArray(16))
    assertTrue(gen(u, FileKind.OTHER) is PreviewResult.TypedIcon)
  }

  // ---- content:// + inaccessible URIs ------------------------------------

  @Test fun contentUriImageProducesPreview() {
    val bmp = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }
    val uri = android.provider.MediaStore.Images.Media.insertImage(ctx.contentResolver, bmp, "ndt_preview_test", null)
    bmp.recycle()
    assumeNotNull("MediaStore insert unavailable on this emulator", uri)
    try {
      val r = prov.generate(Uri.parse(uri), 1024, 0, FileKind.IMAGE, "image/jpeg")
      assertTrue("got $r", r is PreviewResult.ImagePreview)
    } finally {
      uri?.let { ctx.contentResolver.delete(Uri.parse(it), null, null) }
    }
  }

  @Test fun inaccessibleContentUriFallsBackWithoutCrash() {
    val uri = Uri.parse("content://media/external/images/media/999999999")
    assertTrue(prov.generate(uri, 10, 0, FileKind.IMAGE, null) is PreviewResult.TypedIcon)
  }

  // ---- async request contract + cache ------------------------------------

  @Test fun requestDeliversOnMainThreadAndCacheHitsSynchronously() {
    val f = writeJpeg("async.jpg", 320, 240, Color.GREEN)
    val latch = CountDownLatch(1)
    var fromAsync: PreviewResult? = null
    prov.request(Uri.fromFile(f), f.length(), f.lastModified(), FileKind.IMAGE, "image/jpeg") {
      fromAsync = it; latch.countDown()
    }
    assertTrue(latch.await(10, TimeUnit.SECONDS))
    assertTrue(fromAsync is PreviewResult.ImagePreview)
    assertTrue(prov.cacheEntries() >= 1)
    // second request for the same key: synchronous cache hit on the caller thread
    var syncHit = false
    prov.request(Uri.fromFile(f), f.length(), f.lastModified(), FileKind.IMAGE, "image/jpeg") { syncHit = true }
    assertTrue("cache hit did not return synchronously", syncHit)
    prov.cancelAll()
    assertEquals(0, prov.cacheEntries())
  }
}
