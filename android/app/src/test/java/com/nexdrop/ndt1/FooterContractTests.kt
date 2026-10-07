package com.nexdrop.ndt1

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v1.5 footer polish — source-level structural contract (the JVM cannot
 * inflate Views; physical/visual checks live in the owner matrix + CI
 * screenshots). Pins the invariants that make the footer correct on all
 * five bottom-nav tabs without ever duplicating or overlaying it.
 */
class FooterContractTests {
  private val src: String by lazy {
    listOf("src/main/java/com/nexdrop/ndt1/MainActivity.kt",
      "app/src/main/java/com/nexdrop/ndt1/MainActivity.kt")
      .map { File(it) }.first { it.exists() }.readText()
  }

  @Test fun footerTextAppearsExactlyOnce() {
    // one implementation => cannot be duplicated per screen or per card
    assertEquals(1, Regex("Crafted & Developed by PKD").findAll(src).count())
    assertEquals(1, Regex("© 2026 NexDrop\\. All rights reserved\\.").findAll(src).count())
    assertEquals(1, Regex("PRIVATE • DIRECT • FAST").findAll(src).count())
  }

  @Test fun footerIsAppendedCentrallyForEveryNavScreen() {
    assertEquals(2, Regex("addPremiumFooter\\(\\)").findAll(src).count()) // 1 call site + 1 definition
    assertTrue("footer must be gated on the bottom nav", src.contains("if (pendingNav != null) addPremiumFooter()"))
    // and it must run BEFORE the content is placed in the ScrollView
    assertTrue(src.indexOf("addPremiumFooter()") < src.indexOf("val scroll = ScrollView(this).apply"))
  }

  @Test fun allFiveTabsRegisterTheirNavIndex() {
    for (i in 0..4) assertTrue("tab $i must call nav($i)", src.contains("    nav($i)\n"))
  }

  @Test fun footerIsPartOfScrollContentNeverAnOverlay() {
    val fn = src.substringAfter("private fun addPremiumFooter()").substringBefore("private fun screenTitle")
    assertTrue(fn.contains("content.addView(footer)"))
    assertTrue("no overlay/root attachment", !fn.contains("root.addView") && !fn.contains("FrameLayout"))
    assertTrue("centred children", fn.contains("Gravity.CENTER_HORIZONTAL") && fn.contains("TEXT_ALIGNMENT_CENTER"))
  }

  @Test fun footerUsesOnlyThemeTokens() {
    val fn = src.substringAfter("private fun addPremiumFooter()").substringBefore("private fun screenTitle")
    assertTrue("no hardcoded colour literals", !Regex("0x[0-9A-Fa-f]{6,8}|Color\\.parseColor|Color\\.WHITE|Color\\.BLACK").containsMatchIn(fn))
    assertTrue(fn.contains("D.PRIMARY") && fn.contains("D.MUTED"))
  }

  @Test fun homeQuickActionsOnlyTargetRealScreens() {
    val home = src.substringAfter("QUICK ACTIONS").substringBefore("nav(0)")
    val targets = Regex("Screen\\.([A-Z_]+)\\)").findAll(home).map { it.groupValues[1] }.toSet()
    assertEquals(setOf("DEVICES", "HISTORY", "DEVICE_TEST", "SETTINGS"), targets)
    assertTrue("no placeholder actions", !home.contains("Coming soon", ignoreCase = true) && !home.contains("TODO"))
  }
}
