package com.nexdrop.ndt1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * v1.4.3 file-handling fix — regression tests for the shared file-action
 * logic (pure Kotlin, no Android imports, same source-set contract as
 * FileKindTest).
 *
 * These pin the ROOT CAUSES of the four reported issues:
 *  1. .apk/.docx MIME resolution (MimeTypeMap alone returned octet-stream)
 *  2. APK validation by extension AND ZIP magic bytes before any install
 *  3. Safe history file resolution (persisted path, traversal refusal)
 *  4. Bounded-memory save copy with exact byte counts
 *
 * The Android-intent layer (real ACTION_VIEW launch, SAF picker, package
 * installer consent) is covered by the instrumented/device tests.
 */
class FileActionsTest {

  // ---- Issue A/C root cause: robust MIME ----

  @Test fun apkMimeIsPackageArchiveNotOctetStream() {
    // MimeTypeMap.getMimeTypeFromExtension("apk") returns null on most
    // devices — this was why OPEN FILE failed for received APKs.
    assertEquals("application/vnd.android.package-archive", FileMimes.mimeForName("Setup-1.2.apk"))
    assertEquals("application/vnd.android.package-archive", FileMimes.mimeForName("app.XAPK"))
  }

  @Test fun documentAndMediaMimesResolve() {
    assertEquals("application/pdf", FileMimes.mimeForName("report.pdf"))
    assertEquals("application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      FileMimes.mimeForName("notes.DOCX"))
    assertEquals("image/jpeg", FileMimes.mimeForName("photo.jpg"))
    assertEquals("video/mp4", FileMimes.mimeForName("clip.mp4"))
    assertEquals("audio/mpeg", FileMimes.mimeForName("song.mp3"))
    assertEquals("application/zip", FileMimes.mimeForName("bundle.zip"))
  }

  @Test fun unknownExtensionIsHonestNull() {
    assertNull(FileMimes.mimeForName("data.xyzunknown"))
    assertNull(FileMimes.mimeForName("no-extension"))
  }

  // ---- Issue C: APK validated by extension AND file metadata ----

  private val zipMagic = byteArrayOf(0x50, 0x4B, 0x03, 0x04)

  private fun tempApk(withMagic: Boolean): File {
    val f = File.createTempFile("nexdrop-test", ".apk")
    f.outputStream().use { if (withMagic) it.write(zipMagic + ByteArray(64)) else it.write(ByteArray(64)) }
    return f
  }

  @Test fun validApkPassesBothChecks() {
    val f = tempApk(withMagic = true)
    assertTrue("a real (zip) .apk must be detected", FileMimes.isApk(f.name, f))
    assertTrue(f.delete())
  }

  @Test fun renamedNonApkIsRefused() {
    // a file NAMED .apk but not a ZIP must never reach the installer
    val f = tempApk(withMagic = false)
    assertFalse("non-zip content named .apk must be refused", FileMimes.isApk(f.name, f))
    assertTrue(f.delete())
  }

  @Test fun zipWithWrongExtensionIsNotApk() {
    val f = File.createTempFile("nexdrop-test", ".zip")
    f.outputStream().use { it.write(zipMagic + ByteArray(16)) }
    assertFalse(FileMimes.isApk(f.name, f))
    assertTrue(f.delete())
  }

  @Test fun missingApkIsRefused() {
    assertFalse(FileMimes.isApk("gone.apk", File("/nonexistent/gone.apk")))
  }

  // ---- Issue B: safe, durable history file resolution ----

  private fun roots(): List<File> {
    val r = File.createTempFile("root", "").let { it.delete(); it.mkdirs(); it }
    val dl = File(r, "downloads").apply { mkdirs() }
    return listOf(dl)
  }

  @Test fun recordResolvesIntoDownloadsByName() {
    val dl = roots()[0]
    val resolved = FileMimes.safeResolve(listOf(dl), null, "photo.jpg")
    assertNotNull(resolved)
    assertEquals(File(dl, "photo.jpg"), resolved)
  }

  @Test fun persistedAbsolutePathWins() {
    val dl = roots()[0]
    val target = File(dl, "report.pdf").apply { writeText("x") }
    val resolved = FileMimes.safeResolve(listOf(dl), target.absolutePath, "other.pdf")
    assertEquals(target.absolutePath, resolved?.absolutePath)
    target.delete()
  }

  @Test fun stalePersistedPathFallsBackToDownloads() {
    val dl = roots()[0]
    val stale = File(dl, "moved.apk")
    val resolved = FileMimes.safeResolve(listOf(dl), stale.absolutePath, "moved.apk")
    assertEquals(File(dl, "moved.apk"), resolved)
  }

  @Test fun pathOutsideAppRootsIsRefused() {
    val dl = roots()[0]
    // untrusted persisted path pointing at private app data → refused
    assertNull(FileMimes.safeResolve(listOf(dl), "/data/data/com.android/files/sec", "sec"))
  }

  @Test fun traversalNamesAreRefused() {
    val dl = roots()[0]
    assertNull(FileMimes.safeResolve(listOf(dl), null, "../history.json"))
    assertNull(FileMimes.safeResolve(listOf(dl), null, "a/b/escape.pdf"))
    assertNull(FileMimes.safeResolve(listOf(dl), null, "a\\b.pdf"))
    assertNull(FileMimes.safeResolve(listOf(dl), null, ""))
  }

  // ---- Issue D: save-name suggestion + bounded streaming copy ----

  @Test fun saveNameKeepsOriginalAndSanitizes() {
    assertEquals("report final.pdf", FileMimes.suggestSaveName("report final.pdf"))
    assertEquals("bad_name_.apk", FileMimes.suggestSaveName("bad:name?.apk"))
    assertEquals("nexdrop-file", FileMimes.suggestSaveName("   "))
  }

  @Test fun copyStreamIsExactAndContentPreserving() {
    val payload = ByteArray(2 * 1024 * 1024) { (it % 251).toByte() } // 2 MiB
    val input = ByteArrayInputStream(payload)
    val output = ByteArrayOutputStream()
    val copied = FileMimes.copyStream(input, output)
    assertEquals("byte count must match exactly", payload.size.toLong(), copied)
    assertTrue("content must be identical", payload.contentEquals(output.toByteArray()))
  }

  @Test fun copyStreamSmallBufferStillExact() {
    val payload = ByteArray(70_000) { (it and 0xFF).toByte() } // > 64 KiB buffer
    val copied = FileMimes.copyStream(ByteArrayInputStream(payload), ByteArrayOutputStream(), bufferSize = 1024)
    assertEquals(payload.size.toLong(), copied)
  }

  @Test fun headBytesIsBounded() {
    val f = tempApk(withMagic = true)
    val head = FileMimes.headBytes(f, 4)
    assertEquals(4, head?.size)
    assertTrue(head!!.contentEquals(zipMagic))
    assertTrue(f.delete())
  }
}
