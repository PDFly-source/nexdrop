package com.nexdrop.ndt1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * ANDROID_NATIVE_LOCAL endpoint-selection rules (routing fix 2026-10-04).
 *
 * Regression source — REAL two-phone test failure:
 *   failed to connect to /100.71.130.214 (port 38425) from /192.0.0.4 after 8000ms
 * The receiver advertised the mobile-carrier CGNAT interface address because
 * the old picker took the FIRST non-loopback IPv4 on ANY interface.
 */
class LocalNetTest {

  private fun sel(vararg c: LocalNet.Candidate, preferred: String? = null) =
    LocalNet.selectFrom(c.toList(), preferred)

  // ---- THE regression: carrier CGNAT must never be advertised ----

  @Test
  fun `regression - CGNAT rmnet is ignored, wlan0 LAN address is selected`() {
    val e = sel(
      LocalNet.Candidate("100.71.130.214", "rmnet_data0"),
      LocalNet.Candidate("192.168.43.17", "wlan0"),
    )
    assertNotNull(e)
    assertEquals("192.168.43.17", e!!.ip)
    assertEquals("wlan0", e.interfaceName)
    assertEquals("wifi", e.networkType)
  }

  @Test
  fun `mobile data only - CGNAT alone means UNAVAILABLE, never a guess`() {
    assertNull(sel(LocalNet.Candidate("100.71.130.214", "rmnet_data0")))
  }

  @Test
  fun `CGNAT bounds and the kernel no-route placeholder are rejected`() {
    assertNull(sel(LocalNet.Candidate("100.64.0.1", "rmnet0")))   // CGNAT lower edge
    assertNull(sel(LocalNet.Candidate("100.127.255.254", "rmnet0"))) // CGNAT upper edge
    assertNull(sel(LocalNet.Candidate("192.0.0.4", "wlan0")))      // kernel placeholder from the error
  }

  // ---- hotspot host (requirement #13: A hosts hotspot) ----

  @Test
  fun `hotspot AP interface address is selected for the hotspot host`() {
    val e = sel(LocalNet.Candidate("192.168.43.1", "ap0"))
    assertEquals("192.168.43.1", e!!.ip)
    assertEquals("hotspot", e.networkType)
  }

  @Test
  fun `swlan softap interface counts as wifi`() {
    assertEquals("wifi", sel(LocalNet.Candidate("192.168.44.3", "swlan0"))!!.networkType)
  }

  // ---- same Wi-Fi router (requirement #14) ----

  @Test
  fun `two phones on the same router - wifi interface wins over ethernet`() {
    val e = sel(
      LocalNet.Candidate("10.0.2.15", "eth0"),
      LocalNet.Candidate("192.168.1.23", "wlan0"),
    )
    assertEquals("192.168.1.23", e!!.ip)
    assertEquals("wifi", e.networkType)
  }

  @Test
  fun `active Wi-Fi network hint outranks interface heuristics`() {
    val e = sel(
      LocalNet.Candidate("192.168.1.23", "wlan0"),
      LocalNet.Candidate("10.0.0.5", "eth0"),
      preferred = "eth0",
    )
    assertEquals("eth0", e!!.interfaceName)
  }

  // ---- RFC 1918 only ----

  @Test
  fun `RFC 1918 ranges accepted`() {
    assertEquals("10.0.2.15", sel(LocalNet.Candidate("10.0.2.15", "eth0"))!!.ip) // CI emulator
    assertEquals("172.20.1.5", sel(LocalNet.Candidate("172.20.1.5", "wlan0"))!!.ip)
    assertEquals("192.168.0.2", sel(LocalNet.Candidate("192.168.0.2", "wlan0"))!!.ip)
  }

  @Test
  fun `non-local addresses rejected`() {
    assertNull(sel(LocalNet.Candidate("8.8.8.8", "wlan0")))       // public
    assertNull(sel(LocalNet.Candidate("169.254.7.7", "wlan0")))   // link-local
    assertNull(sel(LocalNet.Candidate("172.32.1.1", "wlan0")))    // outside 172.16/12
    assertNull(sel(LocalNet.Candidate("172.15.255.1", "wlan0")))  // below range
    assertNull(sel(LocalNet.Candidate("100.101.1.2", "wlan0")))   // CGNAT mid
  }

  @Test
  fun `VPN tunnels and Wi-Fi Direct never selected`() {
    assertNull(sel(LocalNet.Candidate("10.8.0.2", "tun0")))
    assertNull(sel(LocalNet.Candidate("10.9.0.3", "tap0")))
    assertNull(sel(LocalNet.Candidate("192.168.49.9", "p2p-wlan0-1")))
  }

  @Test
  fun `loopback is never advertised`() {
    assertNull(sel(LocalNet.Candidate("127.0.0.1", "lo")))
  }

  @Test
  fun `unknown interfaces are never guessed`() {
    assertNull(sel(LocalNet.Candidate("192.168.1.5", "radio0")))
    assertNull(sel(LocalNet.Candidate("192.168.1.5", "dummy0")))
    assertNull(sel(LocalNet.Candidate("192.168.1.5", "usb0")))
  }

  // ---- diagnostics text (requirement #12) ----

  @Test
  fun `diagnostics carry the six required fields`() {
    val text = LocalNet.diagnostics(
      LocalNet.Endpoint("192.168.43.1", "ap0", "hotspot", 38425),
      reachable = "YES — server bound and listening",
      peerIp = "192.168.43.17",
    )
    listOf(
      "Transport: ANDROID_NATIVE_LOCAL",
      "Local IP: 192.168.43.1",
      "Peer IP: 192.168.43.17",
      "Interface: ap0",
      "Network type: hotspot",
      "TCP port: 38425",
      "Route reachable: YES",
    ).forEach { assert(text.contains(it)) { "missing: $it in\n$text" } }
  }

  @Test
  fun `unavailable text explains the shared Wi-Fi hotspot requirement`() {
    val text = LocalNet.unavailableText()
    assert(text.contains("NATIVE LOCAL UNAVAILABLE"))
    assert(text.contains("same Wi-Fi"))
    assert(text.contains("hotspot"))
    assert(text.contains("100.64.0.0/10"))
  }
}
