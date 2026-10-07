package com.nexdrop.ndt1

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * v1.5 Phase B unit tests: FileKind classification (pure logic — no
 * Android imports). MIME is authoritative; the filename extension is the
 * honest fallback for null/generic MIME (e.g. application/octet-stream
 * from Files apps). 143+1: the existing 48 ndt1 assertions stay untouched.
 */
class FileKindTest {

  // ---- MIME-authoritative classification ----

  @Test fun imageMime() {
    assertEquals(FileKind.IMAGE, FileMeta.classify("image/png", null))
    assertEquals(FileKind.IMAGE, FileMeta.classify("image/jpeg", "anything.bin"))
  }

  @Test fun videoMime() {
    assertEquals(FileKind.VIDEO, FileMeta.classify("video/mp4", "x.txt"))
  }

  @Test fun audioMime() {
    assertEquals(FileKind.AUDIO, FileMeta.classify("audio/mpeg", "x.bin"))
    assertEquals(FileKind.AUDIO, FileMeta.classify("audio/ogg", null))
  }

  @Test fun pdfAndApkMime() {
    assertEquals(FileKind.PDF, FileMeta.classify("application/pdf", "x"))
    assertEquals(FileKind.APK, FileMeta.classify("application/vnd.android.package-archive", "x"))
  }

  @Test fun archiveMime() {
    assertEquals(FileKind.ARCHIVE, FileMeta.classify("application/zip", "x"))
    assertEquals(FileKind.ARCHIVE, FileMeta.classify("application/x-rar-compressed", "x"))
    assertEquals(FileKind.ARCHIVE, FileMeta.classify("application/x-7z-compressed", "x"))
  }

  @Test fun docMime() {
    assertEquals(FileKind.DOC, FileMeta.classify("text/plain", "x"))
    assertEquals(FileKind.DOC, FileMeta.classify("text/csv", null))
    assertEquals(FileKind.DOC, FileMeta.classify("application/msword", "x"))
    assertEquals(
      FileKind.DOC,
      FileMeta.classify("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x"),
    )
  }

  @Test fun mimeCaseAndGeneric() {
    assertEquals(FileKind.IMAGE, FileMeta.classify("IMAGE/JPEG", null)) // normalized
    // generic MIME must NOT win over the extension fallback
    assertEquals(FileKind.IMAGE, FileMeta.classify("application/octet-stream", "photo.jpg"))
    assertEquals(FileKind.OTHER, FileMeta.classify("*/*", "data"))
  }

  // ---- extension fallback (null/generic MIME) ----

  @Test fun extensionFallback() {
    assertEquals(FileKind.IMAGE, FileMeta.classify(null, "pic.HEIC"))
    assertEquals(FileKind.VIDEO, FileMeta.classify(null, "clip.Mkv"))
    assertEquals(FileKind.AUDIO, FileMeta.classify(null, "song.flac"))
    assertEquals(FileKind.PDF, FileMeta.classify(null, "notes.pdf"))
    assertEquals(FileKind.APK, FileMeta.classify(null, "app.apk"))
    assertEquals(FileKind.APK, FileMeta.classify(null, "split.xapk"))
    assertEquals(FileKind.ARCHIVE, FileMeta.classify(null, "backup.rar"))
    assertEquals(FileKind.ARCHIVE, FileMeta.classify(null, "pack.7z"))
    assertEquals(FileKind.ARCHIVE, FileMeta.classify(null, "data.tar.gz"))
    assertEquals(FileKind.DOC, FileMeta.classify(null, "readme.md"))
  }

  @Test fun unknownFallsToOther() {
    assertEquals(FileKind.OTHER, FileMeta.classify(null, "blob"))
    assertEquals(FileKind.OTHER, FileMeta.classify(null, "file.xyz"))
    assertEquals(FileKind.OTHER, FileMeta.classify("application/x-custom", "data.customext"))
  }

  @Test fun noExtensionNoMime() {
    assertEquals(FileKind.OTHER, FileMeta.classify(null, "LICENSE"))
    assertEquals(FileKind.OTHER, FileMeta.classify("", ""))
  }
}
