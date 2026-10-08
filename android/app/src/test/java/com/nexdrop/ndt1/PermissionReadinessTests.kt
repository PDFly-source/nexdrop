package com.nexdrop.ndt1

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v1.5 FINAL READINESS HARDENING — permission minimality + first-time-user
 * clarity, pinned at source/manifest level (the JVM cannot inflate views;
 * visual + physical checks live in the owner matrix + CI smoke).
 *
 * Contract per mission: minimum permissions, honest asks with in-app
 * explanation BEFORE the system dialog, per-denial recovery that never
 * breaks the app, truthful readiness checklists, QR fallback always clear.
 */
class PermissionReadinessTests {
  private fun file(path: String): File {
    val cands = listOf("src/main/$path", "app/src/main/$path")
    return cands.map { File(it) }.first { it.exists() }
  }
  private val manifest: String by lazy { file("AndroidManifest.xml").readText() }
  private val src: String by lazy { file("java/com/nexdrop/ndt1/MainActivity.kt").readText() }
  private fun fn(name: String) = src.substringAfter("private fun $name").substringBefore("\n  private fun ")

  // ---- A/B: minimum permission set, each justified ----

  @Test fun manifestUsesExactlyTheJustifiedPermissionSet() {
    val perms = Regex("android.permission\\.([A-Z_]+)").findAll(manifest).map { it.groupValues[1] }.toSet()
    assertEquals(setOf(
      "INTERNET",                       // local TCP sockets (no data leaves the device)
      "ACCESS_NETWORK_STATE",           // endpoint selection
      "ACCESS_WIFI_STATE",              // link telemetry (normal)
      "CHANGE_WIFI_MULTICAST_STATE",    // discovery multicast lock (normal)
      "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", // Device Test telemetry only (runtime)
      "FOREGROUND_SERVICE", "FOREGROUND_SERVICE_DATA_SYNC", // background transfers
      "POST_NOTIFICATIONS",             // optional, 13+ (runtime)
      "CAMERA"                          // QR scanning only (runtime)
    ), perms)
  }

  @Test fun noPermissionAddedJustBecauseOtherAppsUseIt() {
    for (banned in listOf("NEARBY_WIFI_DEVICES", "BLUETOOTH", "BLUETOOTH_CONNECT",
        "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "MANAGE_EXTERNAL_STORAGE",
        "RECORD_AUDIO", "READ_CONTACTS", "ACCESS_BACKGROUND_LOCATION"))
      assertFalse("manifest must not request $banned", manifest.contains("android.permission.$banned"))
  }

  // ---- B: camera only for QR, one central explained ask ----

  @Test fun cameraRequestedOnlyThroughOneCentralPath() {
    assertEquals("exactly one system ask, inside askCameraForScan",
      1, Regex("askPermission\\(Manifest\\.permission\\.CAMERA").findAll(src).count())
    assertTrue("3+ user flows reuse the central ask",
      Regex("askCameraForScan \\{").findAll(src).count() >= 3)
  }

  @Test fun cameraExplainedBeforeTheSystemDialog() {
    val fn = fn("askCameraForScan")
    val msg = fn.indexOf("needed only to scan the NexDrop pairing QR")
    val ask = fn.indexOf("askPermission(Manifest.permission.CAMERA")
    assertTrue("in-app explanation must exist", msg >= 0)
    assertTrue("explanation must come BEFORE the system dialog", msg < ask)
  }

  @Test fun cameraDenialHasRecoveryNotALoop() {
    val fn = fn("cameraDeniedRecovery")
    assertTrue(fn.contains("Allow in Settings"))
    assertTrue(fn.contains("Use another connection method"))
    assertTrue("must say what still works", fn.contains("NexDrop keeps working"))
    assertFalse("never traps the user", fn.contains("requestPermissions"))
  }

  // ---- B: notifications optional and explained ----

  @Test fun notificationsOptionalExplainedAndRecoverable() {
    val ask = fn("askNotifications")
    assertTrue(ask.contains("Transfers work without them"))       // pre-permission honesty
    assertTrue(ask.contains("SDK_INT < 33"))                       // 13+ only
    assertTrue("denial never blocks a transfer",
      src.contains("Notifications are off. Transfers still work"))
  }

  // ---- B: location only for real Device Test telemetry ----

  @Test fun locationOnlyRequestedForDeviceTestTelemetry() {
    assertEquals("one explicit grant button, in Device Test",
      1, Regex("askPermission\\(Manifest\\.permission\\.ACCESS_FINE_LOCATION").findAll(src).count())
    assertTrue(src.contains("Grant location — truthful Wi-Fi telemetry"))
    assertTrue("denial is non-fatal", src.contains("Wi-Fi link telemetry stays unavailable. Transfers are unaffected."))
  }

  // ---- C/D/F: truthful readiness checklists ----

  @Test fun sendScreenHasTruthfulReadyToSendChecklist() {
    assertTrue(src.contains("READY TO SEND"))
    for (row in listOf("Wi-Fi / local network:", "Native NDT1 transfer:", "File access:", "Notifications:", "Receiver required"))
      assertTrue("send checklist must cover: $row", src.contains(row))
    assertTrue("needs-action row has an action", src.contains("OPEN WI-FI SETTINGS"))
    assertTrue("readiness follows real runtime state", src.contains("LocalNet.select(activeWifiInterface())"))
  }

  @Test fun receiveScreenHasTruthfulReadyToReceiveChecklist() {
    assertTrue(src.contains("READY TO RECEIVE"))
    assertTrue(src.contains("Keep this Receive screen open while the sender connects"))
    assertTrue(src.contains("NexDrop is listening for senders"))
    assertTrue("real storage from StatFs", src.contains("StatFs(rxDl.path).availableBytes"))
  }

  // ---- E/G: connect help sheet, honest hotspot limits ----

  @Test fun howToConnectSheetIsHonest() {
    val fn = fn("showHowToConnectSheet")
    for (t in listOf("HOW TO TRANSFER", "OPTION 1 — SAME WI-FI", "OPTION 2 — HOTSPOT",
        "Hotspot & tethering", "NexDrop cannot switch it on for you",
        "Internet is not required", "SHA-256", "No cloud upload. No account."))
      assertTrue("help sheet must say: $t", fn.contains(t))
    assertTrue("client-isolation note with QR fallback",
      fn.contains("use QR pairing; it always works"))
  }

  // ---- H/I: nearby empty state + friendly diagnostics ----

  @Test fun nearbyEmptyStateHonestWithQrFallback() {
    assertTrue(src.contains("Nearby discovery did not find a receiver"))
    assertTrue(src.contains("Searching for NexDrop receivers…"))
    assertTrue(src.contains("SCAN QR INSTEAD"))
    assertTrue(src.contains("The receiver has the NexDrop Receive screen open"))
    assertFalse("technical diagnostics line must live in Device Test only",
      src.contains("Diagnostics · interface:"))
  }

  // ---- M: Group Drop stays honest ----

  @Test fun groupDropRemainsHonestUnsupported() {
    assertTrue(src.contains("Not supported — one receiver per session"))
    assertTrue(src.contains("Group Drop is not available yet."))
    assertFalse("no fake multi-receiver rows", src.contains("ADD RECEIVER"))
  }

  // ---- L: footer polish contracts ----

  @Test fun footerDarkContrastAndTransferBottomSpacing() {
    val fn = fn("addPremiumFooter")
    assertTrue("copyright must be ≥ ~78% muted (dark readability)",
      fn.contains("D.argb(200, D.MUTED)"))
    assertTrue("generous bottom spacing for every tab incl. Transfer",
      fn.contains("dp(28)"))
    assertTrue("never an overlay", fn.contains("content.addView(footer)"))
  }
}
