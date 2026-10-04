package com.nexdrop.ndt1

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * QR pairing regression (mission 2026-10-04 §3/§13): the ONE-QR payload must
 * round-trip, reject tampering, and expire honestly. Control plane only.
 */
class QrPairingTest {

  private fun session() = SessionToken(ByteArray(32) { (it * 31 + 7).toByte() },
    java.util.Base64.getUrlEncoder().withoutPadding()
      .encodeToString(ByteArray(32) { (it * 31 + 7).toByte() }), "sess-qr-test")

  @Test
  fun `encode - decode roundtrip keeps the minimum ephemeral payload`() {
    val qr = QrPairing.encode(session(), "192.168.43.1", 53819, "Pixel Test")
    val p = QrPairing.decode(qr)
    assertNotNull(p)
    assertEquals("192.168.43.1", p!!.ip)
    assertEquals(53819, p.port)
    assertEquals("sess-qr-test", p.sessionId)
    assertFalse("fresh QR must not be expired", p.expired)
    assertArrayEquals(session().tokenBytes, QrPairing.tokenBytesFrom(p))
    // Minimum ephemeral connection info only — no file paths, no extras.
    assertTrue("QR payload leaked extra keys", !qr.contains("path") && !qr.contains("uri"))
  }

  @Test
  fun `expired QR is reported expired`() {
    // Encode, then force the stored expiry into the past.
    val qr = QrPairing.encode(session(), "192.168.43.1", 53819, "Pixel Test")
    val expiredQr = qr.replace(
      Regex("\"exp\":\\d+"), "\"exp\":${System.currentTimeMillis() - 60_000}")
    val p = QrPairing.decode(expiredQr)
    assertNotNull("decode must still succeed — expiry is carried, not hidden", p)
    assertTrue("QR past TTL must be expired", p!!.expired)
  }

  @Test
  fun `tampered QR is rejected`() {
    val good = QrPairing.encode(session(), "10.0.0.5", 9999, "dev")
    assertNull("garbage must decode to null", QrPairing.decode("hello world"))
    assertNull("empty must decode to null", QrPairing.decode(""))
    assertNull("wrong version rejected", QrPairing.decode(good.replace("\"v\":1", "\"v\":2")))
    assertNull("wrong type rejected", QrPairing.decode(good.replace("\"ndt1\"", "\"ndt2\"")))
    assertNull("broken JSON rejected", QrPairing.decode(good.dropLast(3)))
  }

  @Test
  fun `token roundtrip through QR survives base64url`() {
    val s = session()
    val p = QrPairing.decode(QrPairing.encode(s, "172.16.0.1", 1234, "d"))!!
    assertArrayEquals(s.tokenBytes, QrPairing.tokenBytesFrom(p))
    assertEquals(s.base64Url, p.tokenB64)
  }
}
