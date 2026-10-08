package com.nexdrop.ndt1

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FINAL CONNECTION UX CLARITY PATCH — source-pinned contract. (The JVM cannot
 * inflate views; visual/theme/font-scale/footer checks live in CI smoke +
 * the owner physical matrix, per the PermissionReadinessTests convention.)
 *
 * Pinned rules:
 *  - the old confusing "Listening unavailable — QR pairing still works" row is GONE
 *  - Receive readiness names the REAL network type from the selected endpoint
 *  - discovery-down state explains what still works (QR) without ever implying
 *    the QR creates a network connection, and points at the same-Wi-Fi/hotspot fix
 *  - the endpoint-unavailable screen says LOCAL CONNECTION UNAVAILABLE with
 *    same-Wi-Fi/hotspot guidance, an honest mobile-data statement, and real actions
 *  - wording never claims "Internet is required", never says "Mobile data cannot work",
 *    and never promises cellular-to-cellular transfer
 *  - the ONE-QR receive flow is untouched
 */
class ConnectionClarityTests {
  private fun file(path: String): File {
    val cands = listOf("src/main/$path", "app/src/main/$path")
    return cands.map { File(it) }.first { it.exists() }
  }
  private val src: String by lazy { file("java/com/nexdrop/ndt1/MainActivity.kt").readText() }
  private fun fn(name: String) = src.substringAfter("private fun $name").substringBefore("\n  private fun ")

  // ---- §3/§5: the confusing wording is gone ----

  @Test fun confusingListeningRowIsGone() {
    assertFalse("the confusing row must not ship",
      src.contains("Listening unavailable — QR pairing still works"))
  }

  // ---- §4/§12: readiness names the real runtime network type ----

  @Test fun receiveChecklistNamesTheRealNetworkType() {
    val fn = fn("renderReceive")
    assertTrue("network row must derive from the selected endpoint", fn.contains("ep.networkType"))
    for (t in listOf("Wi-Fi connected", "Hotspot active", "Ethernet connected"))
      assertTrue("runtime network type naming: $t", fn.contains(t))
    assertTrue("claim stays scoped to this phone (no unprovable peer claim)",
      fn.contains("on this phone"))
    assertTrue("honest peer-side expectation, not a fake check",
      fn.contains("The sender joins the same Wi-Fi / hotspot"))
  }

  // ---- §5/§9: discovery-down keeps QR honest, never sells QR as a connection ----

  @Test fun discoveryDownStillExplainsQrHonestly() {
    val fn = fn("renderReceive")
    assertTrue("says QR pairing still works", fn.contains("QR pairing still works — the sender scans this QR"))
    assertTrue("the native path is unchanged by discovery loss", fn.contains("same native direct path"))
    assertTrue("same-Wi-Fi/hotspot fix present", fn.contains("one phone's hotspot with the other connected"))
    assertFalse("QR is never sold as creating the network connection",
      fn.contains("QR creates a network connection"))
    assertTrue("a real action is offered", fn.contains("CHECK CONNECTION"))
  }

  // ---- §5/§8: endpoint-unavailable screen is clear and honest ----

  @Test fun unavailableScreenIsClearAndHonest() {
    val fn = fn("renderUnavailable")
    assertTrue(fn.contains("LOCAL CONNECTION UNAVAILABLE"))
    assertTrue("same Wi-Fi guidance", fn.contains("same Wi-Fi"))
    assertTrue("hotspot guidance", fn.contains("hotspot"))
    assertTrue("internet not required on a shared local network",
      fn.contains("Internet is not required"))
    assertTrue("QR cannot replace reachability", fn.contains("QR pairing cannot create the network connection"))
    assertTrue("honest mobile-data statement (Example C is not a supported native path)",
      fn.contains("own mobile data are not connected to each other"))
    assertTrue("real actions only", fn.contains("CHECK CONNECTION") && fn.contains("OPEN NEXDROP WEB"))
    assertFalse("never claims internet is required", fn.contains("Internet is required"))
  }

  // ---- §8: banned wording must not appear anywhere ----

  @Test fun noBannedMobileDataWordingAnywhere() {
    assertFalse(src.contains("Internet is required"))
    assertFalse(src.contains("Mobile data cannot work"))
    assertFalse("no cellular-to-cellular transfer promise", src.contains("mobile data transfer"))
  }

  // ---- §6: send-side offline guidance ----

  @Test fun sendScreenOfflineGuidancePresent() {
    val fn = fn("renderSend")
    assertTrue("offline guidance exists", fn.contains("connect first, then send"))
    assertTrue("both connection options", fn.contains("one phone's hotspot with the other connected"))
  }

  // ---- §9/§14: the ONE-QR receive flow and refresh stay untouched ----

  @Test fun qrFlowUntouched() {
    val fn = fn("renderReceive")
    assertTrue("QR plate still rendered", fn.contains("qrView = iv"))
    assertTrue("QR refresh still offered", src.contains("REFRESH QR"))
    assertTrue("Accept/Decline sheet unchanged", src.contains("Incoming transfer"))
  }
}
