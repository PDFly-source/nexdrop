package com.nexdrop.ndt1

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import org.json.JSONObject

/**
 * NDD1 UDP discovery beacon — port 53819, 1 Hz, mirroring
 * companion/src/discovery.ts. Ephemeral session info ONLY: deviceName,
 * deviceType, capabilities, sessionId, token, nonce. No file contents, no
 * permanent credentials. On Android, NSD/mDNS (_nexdrop._tcp) is the
 * preferred advertisement; this UDP beacon is the zero-dependency LAN
 * path the Node companion speaks.
 *
 * Packet: magic "NDD1" u32 | version u8 | flags u8 | port u16 | CRC32 u32
 *         (over bytes 0..7 + body) | UTF-8 JSON body
 */
class DiscoveryBeacon(
  private val deviceName: String,
  private val deviceType: String, // "android" | "tv" | "desktop"
  private val port: Int,
  private val session: SessionToken,
  // v1.4 (control-plane only, never the transfer engine): stable per-install
  // identity for Trusted Devices. Identity-only beacons (empty session) omit
  // token/sessionId — they advertise PRESENCE, not a pairable endpoint.
  private val deviceId: String = "",
) {
  private var sock: DatagramSocket? = null
  private var running = false

  // v1.4.1-rc1 REAL diagnostic counters (control plane only — never the
  // transfer engine). Exposed read-only so Device Test can show honest
  // discovery state instead of guessing why trust was unavailable.
  private val sentPackets = java.util.concurrent.atomic.AtomicLong(0)
  private val receivedPackets = java.util.concurrent.atomic.AtomicLong(0)

  data class BeaconStats(
    val sentPackets: Long, val receivedPackets: Long,
    val running: Boolean, val portBound: Int,
  )

  fun stats(): BeaconStats = BeaconStats(
    sentPackets.get(), receivedPackets.get(),
    running, sock?.localPort ?: -1,
  )
  private val seen = HashMap<String, DiscoveredDevice>()

  data class DiscoveredDevice(
    val address: String, val port: Int, val deviceName: String,
    val deviceType: String, val sessionId: String, val token: String,
    val deviceId: String = "",
  )

  fun start(onPeers: (List<DiscoveredDevice>) -> Unit, advertise: Boolean = true) {
    running = true
    sock = DatagramSocket(Ndt1.DISCOVERY_PORT).also { it.broadcast = true }
    // listener thread
    Thread {
      val buf = ByteArray(2048)
      while (running) {
        try {
          val pkt = DatagramPacket(buf, buf.size)
          sock!!.receive(pkt)
          receivedPackets.incrementAndGet()
          val host = pkt.address.hostAddress ?: return@Thread
          val parsed = parseBeacon(buf.copyOf(pkt.length), host)
          if (parsed != null && parsed.sessionId != session.sessionId) {
            // identity-only beacons (no token) share the "" key with each
            // other — key by address+devid so each identity peer stays
            // distinct in the seen table.
            val key = if (parsed.token.isEmpty()) "id:${parsed.address}:${parsed.deviceId}" else parsed.sessionId
            seen[key] = parsed
            onPeers(seen.values.toList())
          }
        } catch (_: Exception) { /* best-effort */ }
      }
    }.start()
    // advertiser thread, 1 Hz (only when this side offers a real session;
    // browse-only senders still listen but advertise nothing pairable)
    if (advertise) {
      Thread {
        val packet = buildBeacon()
        while (running) {
          try {
            sentPackets.incrementAndGet()
          sock!!.send(DatagramPacket(packet, packet.size, InetAddress.getByName("255.255.255.255"), Ndt1.DISCOVERY_PORT))
          } catch (_: Exception) { /* best-effort */ }
          Thread.sleep(1000)
        }
      }.start()
    }
  }

  fun stop() {
    running = false
    sock?.close()
    sock = null
  }

  internal fun buildBeacon(): ByteArray {
    val body = JSONObject().apply {
      put("deviceName", deviceName)
      put("deviceType", deviceType)
      put("capabilities", JSONObject().apply {
        put("lanTcp", true); put("wifiDirect", false); put("nativeLocal", true); put("webrtc", false)
      })
      if (deviceId.isNotEmpty()) put("devid", deviceId)
      if (session.base64Url.isNotEmpty()) {
        put("sessionId", session.sessionId)
        put("token", session.base64Url)
      }
      put("nonce", Handshake.randomNonce().toString())
    }.toString().toByteArray(Charsets.UTF_8)
    val pkt = ByteArray(12 + body.size)
    writeU32(pkt, 0, 0x4E444431) // "NDD1"
    pkt[4] = 1 // version
    pkt[5] = 0 // flags
    writeU16(pkt, 6, port)
    body.copyInto(pkt, 12)
    writeU32(pkt, 8, crc32(pkt, 0, 12 + body.size)) // whole-packet CRC per discovery.ts
    return pkt
  }

  fun parseBeacon(pkt: ByteArray, from: String): DiscoveredDevice? {
    if (pkt.size < 13) return null
    if (readU32(pkt, 0) != 0x4E444431) return null
    if (pkt[4].toInt() != 1) return null
    val port = readU16(pkt, 6)
    if (crc32(pkt, 0, pkt.size) != readU32(pkt, 8)) return null
    val body = JSONObject(String(pkt, 12, pkt.size - 12, Charsets.UTF_8))
    return DiscoveredDevice(
      from, port, body.optString("deviceName"), body.optString("deviceType"),
      body.optString("sessionId"), body.optString("token"), body.optString("devid"),
    )
  }
}
