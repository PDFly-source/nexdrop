package com.nexdrop.ndt1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * v1.4.3 duplicate-name fix — regression tests for FileNaming.collisionFreeName.
 *
 * Root cause: TurboReceiver finalized every verified transfer to
 * File(downloadDir, offer.name) — receiving the same filename twice
 * SILENTLY OVERWROTE the existing file. These pin the deterministic
 * " (n)" suffix contract used at the finalize step (wire protocol,
 * chunking and SHA-256 verification untouched).
 */
class FileNamingTest {

  private fun takenSet(vararg names: String): (String) -> Boolean = {
    it in names.toSet()
  }

  @Test fun freeNameIsKeptExactly() {
    assertEquals("report.pdf",
      FileNaming.collisionFreeName("report.pdf", takenSet()))
    assertEquals("photo.jpg",
      FileNaming.collisionFreeName("photo.jpg", takenSet("other.bin")))
  }

  @Test fun collisionGetsFirstFreeSuffix() {
    assertEquals("report (1).pdf",
      FileNaming.collisionFreeName("report.pdf", takenSet("report.pdf")))
  }

  @Test fun sequentialCollisionsGetConsecutiveSlots() {
    // receiving "photo.jpg" three times into the same dir:
    // photo.jpg, photo (1).jpg, photo (2).jpg — existing files preserved
    assertEquals("photo (1).jpg",
      FileNaming.collisionFreeName("photo.jpg", takenSet("photo.jpg")))
    assertEquals("photo (2).jpg",
      FileNaming.collisionFreeName("photo.jpg", takenSet("photo.jpg", "photo (1).jpg")))
    assertEquals("photo (3).jpg",
      FileNaming.collisionFreeName("photo.jpg", takenSet("photo.jpg", "photo (1).jpg", "photo (2).jpg")))
  }

  @Test fun extensionIsAlwaysPreservedLast() {
    assertEquals("Setup-1.2 (1).apk",
      FileNaming.collisionFreeName("Setup-1.2.apk", takenSet("Setup-1.2.apk")))
  }

  @Test fun multiDotNamesKeepOnlyLastExtensionOut() {
    assertEquals("my.file (1).txt",
      FileNaming.collisionFreeName("my.file.txt", takenSet("my.file.txt")))
  }

  @Test fun noExtensionNames() {
    assertEquals("Makefile (1)",
      FileNaming.collisionFreeName("Makefile", takenSet("Makefile")))
    assertEquals("photo", FileNaming.collisionFreeName("photo", takenSet()))
  }

  @Test fun dotfilesKeepTheirLeadingDot() {
    assertEquals(".gitignore (1)",
      FileNaming.collisionFreeName(".gitignore", takenSet(".gitignore")))
  }

  @Test fun neverReturnsATakenName() {
    val taken = mutableSetOf("app.apk")
    var result = ""
    repeat(50) {
      result = FileNaming.collisionFreeName("app.apk") { it in taken }
      assertNotEquals("result must never collide with an existing file", "app.apk", result)
      taken.add(result)
    }
    assertEquals("app (50).apk", result)
  }

  @Test fun emptyNameIsPassedThrough() {
    assertEquals("", FileNaming.collisionFreeName("") { true })
  }
}
