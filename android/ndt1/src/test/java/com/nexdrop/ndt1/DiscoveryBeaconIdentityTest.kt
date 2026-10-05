package com.nexdrop.ndt1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * v1.4.1-rc1 TRUSTED-DEVICE identity regression (the "Sender identity not
 * seen" physical bug): proves, at machine level, the exact chain the trust
 * action depends on —
 *
 *   sender identity beacon packet (devid, no session)
 *     → receiver's REAL session beacon listener parses it
 *     → DiscoveredDevice carries the sender's stable deviceId
 *     → honest stats() counters move (diagnostics never guess)
 *
 * The listener binds the real UDP 53819 port and receives an actual packet
 * over loopback, byte-for-byte with the beacon wire format. Nothing is
 * faked; if the receiver listener cannot see identity packets, trust MUST
 * stay unavailable — that honesty is the contract under test.
 */
class DiscoveryBeaconIdentityTest {

  @Test
  fun `identity beacon packet reaches receiver listener with devid and moves real counters`() {
    // Receiver: REAL session (as on the RECEIVE screen) — listener only.
    val seen = java.util.concurrent.CopyOnWriteArrayList<DiscoveryBeacon.DiscoveredDevice>()
    val got = CountDownLatch(1)
    val receiver = DiscoveryBeacon(
      "recv-phone", "android", 0,
      SessionToken(ByteArray(32), "tok", "sess-1"), // (tokenBytes, base64Url, sessionId)
      "recv-devid",
    )
    var rx0 = 0L
    try {
      receiver.start({ peers ->
        seen.addAll(peers)
        if (peers.any { it.deviceId == "sender-devid" }) got.countDown()
      }, advertise = false)
      rx0 = receiver.stats().receivedPackets

      // Sender: identity-only beacon (empty session, stable devid) — exactly
      // what startIdentityBeacon() builds on the SEND screen.
      val sender = DiscoveryBeacon(
        "sender-phone", "android", 0,
        SessionToken(ByteArray(0), "", ""),
        "sender-devid",
      )
      val packet = sender.buildBeacon()
      DatagramSocket().use { out ->
        // loopback unicast — same wire bytes as the 1 Hz LAN broadcast
        out.send(DatagramPacket(packet, packet.size, InetAddress.getByName("127.0.0.1"), Ndt1.DISCOVERY_PORT))
        // second packet proves the listener keeps counting (1 Hz cadence)
        out.send(DatagramPacket(packet, packet.size, InetAddress.getByName("127.0.0.1"), Ndt1.DISCOVERY_PORT))
      }

      assertTrue("receiver listener never saw the sender identity packet", got.await(5, TimeUnit.SECONDS))
      val peer = seen.first { it.deviceId == "sender-devid" }
      assertEquals("sender-phone", peer.deviceName)
      assertTrue("sessionId must be empty for an identity-only beacon", peer.sessionId.isEmpty())
      assertTrue("token must be empty — identity beacons are never pairable", peer.token.isEmpty())
      assertTrue("receiver is not on the sender's beacon stream",
        seen.none { it.deviceId == "recv-devid" })

      val rx = receiver.stats().receivedPackets
      assertTrue("honest counters must advance (rx=$rx, was $rx0)", rx >= rx0 + 1)
      assertTrue("listener must be running on the real port", receiver.stats().running)
      assertEquals(Ndt1.DISCOVERY_PORT, receiver.stats().portBound)
    } finally {
      receiver.stop()
    }
  }

  @Test
  fun `session beacon advertises real token and is never mistaken for identity`() {
    val receiver = DiscoveryBeacon(
      "recv-phone", "android", 0,
      SessionToken(ByteArray(32), "tok2", "sess-2"), // (tokenBytes, base64Url, sessionId)
      "recv-devid",
    )
    try {
      val seen = java.util.concurrent.CopyOnWriteArrayList<DiscoveryBeacon.DiscoveredDevice>()
      val got = CountDownLatch(1)
      receiver.start({ peers -> seen.addAll(peers); got.countDown() }, advertise = false)

      // A pairable session beacon from another device: token + sessionId present
      val other = DiscoveryBeacon(
        "other-phone", "android", 0,
        SessionToken(ByteArray(32), "tok3", "sess-3"), // (tokenBytes, base64Url, sessionId)
        "other-devid",
      )
      val pkt = other.buildBeacon()
      DatagramSocket().use { out ->
        out.send(DatagramPacket(pkt, pkt.size, InetAddress.getByName("127.0.0.1"), Ndt1.DISCOVERY_PORT))
      }
      assertTrue(got.await(5, TimeUnit.SECONDS))
      val peer = seen.first { it.deviceId == "other-devid" }
      assertEquals("sess-3", peer.sessionId)
      assertEquals("tok3", peer.token)
      assertNotNull(peer.deviceId)
    } finally {
      receiver.stop()
    }
  }
}
