package com.nexdrop.ndt1

import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * ANDROID_NATIVE_LOCAL endpoint selection.
 *
 * BUG HISTORY (2026-10-03, real two-phone test): the receiver advertised the
 * FIRST non-loopback IPv4 found across ALL interfaces. On real phones that is
 * usually the mobile-carrier interface (rmnet), whose address is a CGNAT
 * 100.64.0.0/10 endpoint reachable only by the carrier:
 *
 *   failed to connect to /100.71.130.214 (port 38425)
 *   from /192.0.0.4 (port 55510) after 8000ms
 *
 * 192.0.0.4 is the kernel's "no route to that network" placeholder — proof
 * the QR carried an address the peer could never reach. The native
 * transport then fell back to WebRTC.
 *
 * SELECTION RULES (requirements 2026-10-04):
 *  1. NEVER select carrier/CGNAT (100.64.0.0/10) or any non-private address.
 *     Only RFC 1918 private IPv4 qualifies:
 *       192.168.0.0/16 > 10.0.0.0/8 > 172.16.0.0/12 (tie-break preference)
 *  2. Never loopback, never link-local 169.254/16, never public.
 *  3. Interface must be a real local network interface:
 *       Wi-Fi (wlan0/swlan0 family), hotspot AP (ap/softap family),
 *       or ethernet (eth family).
 *     rmnet/ccmni (carrier), tun/tap (VPN), p2p (Wi-Fi Direct), usb, dummy
 *     are rejected outright.
 *  4. The ACTIVE Wi-Fi network's interface (ConnectivityManager
 *     LinkProperties.interfaceName) outranks everything else.
 *  5. Do NOT blindly choose the first interface — enumerate, classify,
 *     score, pick the best.
 *  6. No valid candidate => null. The caller MUST show
 *     NATIVE LOCAL UNAVAILABLE + the PWA (WebRTC) fallback — never guess an
 *     address and never claim native TCP is connected when it is not.
 */
object LocalNet {

  /** A selected, verified usable local endpoint. */
  data class Endpoint(
    val ip: String,
    val interfaceName: String,
    val networkType: String, // "wifi" | "hotspot" | "ethernet"
    val port: Int = 0,      // filled by the caller after bind
  )

  /** One enumerated (address, interface) pair — the seam for unit tests. */
  data class Candidate(val ip: String, val interfaceName: String)

  /**
   * Select the ANDROID_NATIVE_LOCAL endpoint from the live interfaces.
   *
   * @param preferredInterface interface name of the currently active Wi-Fi
   *        network (ConnectivityManager LinkProperties), when the caller can
   *        provide it. Hotspot hosts (no active Wi-Fi client network) pass null.
   * @return the endpoint to bind and advertise, or null when NO valid local
   *         route exists (=> NATIVE LOCAL UNAVAILABLE + WebRTC fallback).
   */
  fun select(preferredInterface: String? = null): Endpoint? =
    selectFrom(liveCandidates(), preferredInterface)

  /** Real enumeration of NetworkInterface (requirement #5). */
  fun liveCandidates(): List<Candidate> {
    val out = ArrayList<Candidate>()
    // java.util.Enumeration is not Kotlin-iterable — materialize via toList()
    val nets = try { NetworkInterface.getNetworkInterfaces()?.toList() } catch (_: Exception) { null } ?: return out
    for (n in nets) {
      val name = n.name ?: continue
      for (a in n.inetAddresses.toList()) {
        if (a is Inet4Address) a.hostAddress?.let { out.add(Candidate(it, name)) }
      }
    }
    return out
  }

  /**
   * Pure selection core — unit-tested, including the exact regression from
   * the two-phone test (rmnet 100.71.130.214 + wlan0 192.168.43.17).
   */
  fun selectFrom(candidates: List<Candidate>, preferredInterface: String? = null): Endpoint? =
    candidates.mapNotNull { c -> score(c, preferredInterface)?.let { it to c } }
      .maxByOrNull { it.first }
      ?.let { (_, c) ->
        Endpoint(
          ip = c.ip,
          interfaceName = c.interfaceName,
          networkType = classify(c.interfaceName)!!,
        )
      }

  // ---- scoring: null = disqualified ----

  private fun score(c: Candidate, preferred: String?): Int? {
    val type = classify(c.interfaceName) ?: return null // interface tier first
    if (!isPrivateRfc1918(c.ip)) return null             // then address range
    var s = when (type) {
      "wifi" -> 40
      "hotspot" -> 40
      "ethernet" -> 20
      else -> return null
    }
    if (c.interfaceName == preferred) s += 100 // active Wi-Fi network wins
    s += rangePreference(c.ip) // 192.168 > 10 > 172.16 (router/hotspot LANs)
    return s
  }

  /** wifi | hotspot | ethernet, or null when the interface is not a local
   *  network interface (carrier radio, VPN tunnel, p2p, usb, dummy, lo). */
  fun classify(ifName: String): String? = when {
    ifName == "lo" -> null
    ifName.contains("rmnet") || ifName.contains("ccmni") -> null // mobile carrier
    ifName.startsWith("tun") || ifName.startsWith("tap") -> null // VPN
    ifName.startsWith("p2p") -> null                             // Wi-Fi Direct
    ifName.startsWith("usb") -> null                             // USB tethering
    ifName.startsWith("dummy") -> null
    ifName.contains("softap") || ifName.startsWith("ap") -> "hotspot"
    ifName.contains("wlan") -> "wifi"                           // wlan0, swlan0, wlan1…
    ifName.startsWith("eth") -> "ethernet"                       // emulator eth0, LAN
    else -> null // unknown interface: never guess
  }

  /** RFC 1918 private IPv4 only — rejects loopback, link-local, CGNAT, public. */
  fun isPrivateRfc1918(ip: String): Boolean {
    val p = try { java.net.InetAddress.getByName(ip) } catch (_: Exception) { return false }
    if (p !is Inet4Address || p.isLoopbackAddress || p.isLinkLocalAddress) return false
    val b = p.address // network order
    fun u(i: Int) = b[i].toInt() and 0xff
    // CGNAT 100.64.0.0/10: 100.64-100.127 — never a local LAN address.
    if (u(0) == 100 && u(1) in 64..127) return false
    return when {
      u(0) == 192 && u(1) == 168 -> true // 192.168/16 (router + hotspot LANs)
      u(0) == 10 -> true                // 10/8
      u(0) == 172 && u(1) in 16..31 -> true // 172.16/12
      else -> false
    }
  }

  private fun rangePreference(ip: String): Int {
    val b = try { java.net.InetAddress.getByName(ip).address } catch (_: Exception) { return 0 }
    fun u(i: Int) = b[i].toInt() and 0xff
    return when {
      u(0) == 192 && u(1) == 168 -> 4
      u(0) == 10 -> 2
      u(0) == 172 -> 1
      else -> 0
    }
  }

  // ---- diagnostics (requirement #12: always show the chosen route) ----

  fun diagnostics(ep: Endpoint, reachable: String, peerIp: String? = null): String = buildString {
    appendLine("Transport: ANDROID_NATIVE_LOCAL")
    appendLine("Local IP: ${ep.ip}")
    if (peerIp != null) appendLine("Peer IP: $peerIp")
    appendLine("Interface: ${ep.interfaceName}")
    appendLine("Network type: ${ep.networkType}")
    appendLine("TCP port: ${ep.port}")
    append("Route reachable: $reachable")
  }

  /** Requirement #10: honest unavailable screen + what to do + WebRTC path. */
  fun unavailableText(): String = buildString {
    appendLine("NATIVE LOCAL UNAVAILABLE")
    appendLine()
    appendLine("No usable local network was found on this device. Native NDT1 TCP works only when BOTH devices share the same network:")
    appendLine("• both phones on the same Wi-Fi router, or")
    appendLine("• one phone's hotspot with the other connected to it.")
    appendLine()
    appendLine("Carrier/mobile-data addresses (100.64.0.0/10 CGNAT) and public addresses are never used — they are unreachable between phones.")
    appendLine()
    append("Fix: join both devices to the same Wi-Fi/hotspot, then tap Receive again.\nAlternative: use the NexDrop PWA below (WebRTC — works over the internet).")
  }
}
