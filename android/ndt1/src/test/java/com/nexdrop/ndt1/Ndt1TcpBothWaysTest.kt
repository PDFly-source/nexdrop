package com.nexdrop.ndt1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.Socket
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * REAL NDT1 TCP transfers over the transport, BOTH directions
 * (routing-fix requirements #13/#14 at machine level):
 *
 *   phone A = server bound to its selected local endpoint (TurboReceiver)
 *   phone B = protocol-correct sender client (NDT1 HELLO→AUTH_OK→OFFER→
 *             ACCEPT→DATA→COMPLETE→VERIFY_OK, byte-for-byte with the wire)
 *
 * A → B exercises "A hotspot host / same-router receiver": connect to the
 * BOUND endpoint, transfer, SHA-256 verify. B → A repeats with the roles
 * swapped (fresh receiver + token on the other side), proving the path is
 * symmetric. The bind address here is loopback because the CI JVM has no
 * wlan — the receiver bind/accept/wire path under test is identical; the
 * interface-selection half is covered by LocalNetTest.
 */
class Ndt1TcpBothWaysTest {

  private class RecordingListener : TurboReceiver.Listener {
    val done = CountDownLatch(1)
    @Volatile var completedFile: File? = null
    @Volatile var completedSha: String? = null
    @Volatile var completedStats: ThroughputSampler.Stats? = null
    @Volatile var peerSeen: String? = null
    @Volatile var error: String? = null
    override fun onOffer(offer: Offer): Boolean = true // ACCEPT — the ONE-QR Accept flow
    override fun onProgress(durable: Long, total: Long) {}
    override fun onComplete(file: File, sha256: String, stats: ThroughputSampler.Stats) {
      completedFile = file; completedSha = sha256; completedStats = stats; done.countDown()
    }
    override fun onError(message: String) { error = message; println("RECEIVER ERROR: \$message"); done.countDown() }
    override fun onPeerConnected(peerIp: String) { peerSeen = peerIp }
  }

  // ---- minimal unsigned writers (FrameDecoder handles the parse side) ----
  private fun u16(b: ByteArray, o: Int, v: Int) { b[o] = ((v ushr 8) and 0xff).toByte(); b[o + 1] = (v and 0xff).toByte() }
  private fun u32(b: ByteArray, o: Int, v: Int) {
    b[o] = ((v ushr 24) and 0xff).toByte(); b[o + 1] = ((v ushr 16) and 0xff).toByte()
    b[o + 2] = ((v ushr 8) and 0xff).toByte(); b[o + 3] = (v and 0xff).toByte()
  }
  private fun u64(b: ByteArray, o: Int, v: Long) { u32(b, o, (v ushr 32).toInt()); u32(b, o + 4, (v and 0xffffffffL).toInt()) }

  private fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  /** Protocol-correct NDT1 sender: mirrors TurboSender's wire behavior. */
  private fun sendFile(host: String, port: Int, session: SessionToken, bytes: ByteArray, name: String, fileId: Int, listener: RecordingListener) {
    Socket(host, port).use { sock ->
      sock.tcpNoDelay = true
      val out = sock.getOutputStream()
      val input = sock.getInputStream()
      val dec = FrameDecoder()
      val pending = ArrayDeque<Pair<Int, ByteArray>>()
      val readBuf = ByteArray(64 * 1024)

      fun nextFrame(): Pair<Int, ByteArray> {
        while (pending.isEmpty()) {
          val n = input.read(readBuf)
          assertTrue("socket closed by receiver (receiver-side error: ${listener.error ?: "none"})", n > 0)
          dec.push(readBuf.copyOf(n)).forEach(pending::addLast)
        }
        return pending.removeFirst()
      }

      // HELLO with the HMAC token proof (canonical NDT1, unchanged)
      val nonce = 0x5A11C0DE
      val hello = encodeHello(session.sessionId, Handshake.helloProof(session.tokenBytes, nonce), nonce)
      out.write(encodeHeader(FrameType.HELLO, hello.size) + hello)
      val (authType, authPayload) = nextFrame()
      assertEquals("AUTH_OK expected", FrameType.AUTH_OK, authType)
      assertEquals("AUTH_OK nonce must echo", nonce, decodeNonce(authPayload))

      // OFFER (streamed SHA-256 equivalent: pre-computed over the payload)
      val sha = sha256Hex(bytes)
      val offer = encodeOffer(fileId, bytes.size.toLong(), name, sha)
      out.write(encodeHeader(FrameType.OFFER, offer.size) + offer)
      assertEquals("READY expected after ACCEPT", FrameType.READY, nextFrame().first)

      // DATA frames at the canonical 512 KiB split
      var off = 0L
      while (off < bytes.size) {
        val len = minOf(Ndt1.FRAME_BYTES, bytes.size - off.toInt())
        val payload = ByteArray(24 + len)
        u32(payload, 0, fileId); u64(payload, 4, off); u64(payload, 12, bytes.size.toLong()); u32(payload, 20, len)
        System.arraycopy(bytes, off.toInt(), payload, 24, len)
        out.write(encodeHeader(FrameType.DATA, payload.size) + payload)
        off += len
      }

      // COMPLETE + VERIFY_OK (receiver-authoritative SHA-256).
      // Drain PROGRESS/CREDIT frames queued during the DATA pump first.
      out.write(encodeHeader(FrameType.COMPLETE, encodeComplete(fileId, sha).size) + encodeComplete(fileId, sha))
      var verifyType = -1
      while (true) {
        val (t, p) = nextFrame()
        when (t) {
          FrameType.VERIFY_OK -> { verifyType = t; break }
          FrameType.VERIFY_FAIL -> throw AssertionError("VERIFY_FAIL: ${String(p, Charsets.US_ASCII)}")
          FrameType.PROGRESS, FrameType.CREDIT -> { /* mid-transfer cadence — keep draining */ }
          else -> throw AssertionError("unexpected frame 0x${t.toString(16)} before VERIFY_OK")
        }
      }
      assertEquals("VERIFY_OK expected (SHA-256 verified)", FrameType.VERIFY_OK, verifyType)
    }
  }

  private fun newReceiver(dirName: String, listener: TurboReceiver.Listener): Pair<TurboReceiver, Int> {
    val dir = Files.createTempDirectory(dirName).toFile()
    // Direct SessionToken construction (no android.util.Base64 in JVM tests)
    val token = ByteArray(32) { (it * 7 + 1).toByte() }
    val session = SessionToken(token, "test-${dirName}", "sess-$dirName")
    val receiver = TurboReceiver(session, dir, listener)
    val port = receiver.start(0, "127.0.0.1")
    assertTrue("receiver must bind a real port", port > 0)
    return receiver to port
  }

  @Test
  fun `A to B - real TCP connect, transfer, SHA-256 verify on the bound endpoint`() {
    val listener = RecordingListener()
    val (receiverB, portB) = newReceiver("phoneB", listener)
    try {
      val payload = ByteArray(1_500_000) { (it % 251).toByte() } // > PROGRESS cadence boundary
      sendFile("127.0.0.1", portB, tokenFor("phoneB"), payload, "fromA.bin", fileId = 1, listener)

      assertTrue("B never completed", listener.done.await(30, TimeUnit.SECONDS))
      assertNullError(listener)
      val file = listener.completedFile
      assertNotNull("completed file expected", file)
      assertEquals(payload.size.toLong(), file!!.length())
      assertEquals(sha256Hex(payload), listener.completedSha)
      assertNotNull("peer connection must be reported", listener.peerSeen)
    } finally { receiverB.stop() }
  }

  @Test
  fun `B to A - reverse direction on a fresh receiver and endpoint`() {
    val listener = RecordingListener()
    val (receiverA, portA) = newReceiver("phoneA", listener)
    try {
      val payload = ByteArray(900_000) { ((it * 13) % 253).toByte() }
      sendFile("127.0.0.1", portA, tokenFor("phoneA"), payload, "fromB.bin", fileId = 7, listener)

      assertTrue("A never completed", listener.done.await(30, TimeUnit.SECONDS))
      assertNullError(listener)
      assertEquals(payload.size.toLong(), listener.completedFile!!.length())
      assertEquals(sha256Hex(payload), listener.completedSha)
    } finally { receiverA.stop() }
  }

  // ===================================================================
  // v1.4.3 maintenance (docs/KNOWN-ISSUES-1.4.2.md): a RECOVERED transfer
  // displayed 130.22 MB/s on a physical phone — numerator included the
  // pre-interruption bytes, denominator was only the resumed session's wall.
  // TEST B: the result stats must be session-scoped (sessionBytes, never
  // the full file total). TEST C: the fix must not touch integrity (durable
  // resume, SHA-256, completed byte count, final content).
  // ===================================================================
  @Test
  fun `interrupted transfer resumes and result stats count ONLY the resumed session (the 130 MB per s bug)`() {
    val mib = 1024 * 1024
    val bytes = ByteArray(4 * mib) { ((it * 31 + 7) and 0xff).toByte() }
    val sha = sha256Hex(bytes)
    val fileId = 1
    val name = "resume.bin"
    val dir = Files.createTempDirectory("resume-stats").toFile()
    val token = ByteArray(32) { (it * 7 + 1).toByte() }
    val session = SessionToken(token, "test-resume", "sess-resume")
    val listener = RecordingListener()
    val receiver = TurboReceiver(session, dir, listener)
    val port = receiver.start(0, "127.0.0.1")
    try {
      // ---- LEG 1: 3 of 4 MiB, then the connection drops (no COMPLETE) ----
      Socket("127.0.0.1", port).use { sock ->
        sock.tcpNoDelay = true
        val out = sock.getOutputStream()
        val input = sock.getInputStream()
        val dec = FrameDecoder()
        val pending = ArrayDeque<Pair<Int, ByteArray>>()
        val readBuf = ByteArray(64 * 1024)
        fun nextFrame(): Pair<Int, ByteArray> {
          while (pending.isEmpty()) {
            val n = input.read(readBuf)
            assertTrue("leg-1 socket closed early (receiver error: ${listener.error})", n > 0)
            dec.push(readBuf.copyOf(n)).forEach(pending::addLast)
          }
          return pending.removeFirst()
        }
        val nonce = 0x5A11C0DE
        val hello = encodeHello(session.sessionId, Handshake.helloProof(session.tokenBytes, nonce), nonce)
        out.write(encodeHeader(FrameType.HELLO, hello.size) + hello)
        assertEquals("AUTH_OK expected", FrameType.AUTH_OK, nextFrame().first)
        val offer = encodeOffer(fileId, bytes.size.toLong(), name, sha)
        out.write(encodeHeader(FrameType.OFFER, offer.size) + offer)
        assertEquals("READY expected after ACCEPT", FrameType.READY, nextFrame().first)
        var off = 0L
        while (off < 3L * mib) {
          val len = minOf(Ndt1.FRAME_BYTES, (3L * mib - off).toInt())
          val payload = ByteArray(24 + len)
          u32(payload, 0, fileId); u64(payload, 4, off); u64(payload, 12, bytes.size.toLong()); u32(payload, 20, len)
          System.arraycopy(bytes, off.toInt(), payload, 24, len)
          out.write(encodeHeader(FrameType.DATA, payload.size) + payload)
          off += len
        }
        out.flush()
      } // abrupt close mid-transfer — the durable-resume case, no CANCEL

      val part = File(dir, "$name.ndtpart")
      assertTrue("a dropped (not cancelled) transfer must retain the part file for resume",
        waitUntil(10_000) { part.exists() && part.length() >= 3L * mib })

      // ---- LEG 2: reconnect, resume from the READY-advertised durable offset ----
      var base = -1L
      Socket("127.0.0.1", port).use { sock ->
        sock.tcpNoDelay = true
        val out = sock.getOutputStream()
        val input = sock.getInputStream()
        val dec = FrameDecoder()
        val pending = ArrayDeque<Pair<Int, ByteArray>>()
        val readBuf = ByteArray(64 * 1024)
        fun nextFrame(): Pair<Int, ByteArray> {
          while (pending.isEmpty()) {
            val n = input.read(readBuf)
            assertTrue("leg-2 socket closed early (receiver error: ${listener.error})", n > 0)
            dec.push(readBuf.copyOf(n)).forEach(pending::addLast)
          }
          return pending.removeFirst()
        }
        val nonce = 0x5A11C0DE
        val hello = encodeHello(session.sessionId, Handshake.helloProof(session.tokenBytes, nonce), nonce)
        out.write(encodeHeader(FrameType.HELLO, hello.size) + hello)
        assertEquals("AUTH_OK expected on the resumed session", FrameType.AUTH_OK, nextFrame().first)
        val offer = encodeOffer(fileId, bytes.size.toLong(), name, sha)
        out.write(encodeHeader(FrameType.OFFER, offer.size) + offer)
        val (readyType, readyPayload) = nextFrame()
        assertEquals("READY expected after ACCEPT", FrameType.READY, readyType)
        base = decodeOffset(readyPayload).second

        // resume EXACTLY from the advertised durable offset — the desync
        // guard in DurableWriter enforces this, same as a real sender
        var off = base
        while (off < bytes.size) {
          val len = minOf(Ndt1.FRAME_BYTES, (bytes.size - off).toInt())
          val payload = ByteArray(24 + len)
          u32(payload, 0, fileId); u64(payload, 4, off); u64(payload, 12, bytes.size.toLong()); u32(payload, 20, len)
          System.arraycopy(bytes, off.toInt(), payload, 24, len)
          out.write(encodeHeader(FrameType.DATA, payload.size) + payload)
          off += len
        }
        val complete = encodeComplete(fileId, sha)
        out.write(encodeHeader(FrameType.COMPLETE, complete.size) + complete)
        while (true) {
          val (t2, p2) = nextFrame()
          when (t2) {
            FrameType.VERIFY_OK -> break
            FrameType.VERIFY_FAIL -> throw AssertionError("VERIFY_FAIL: ${String(p2, Charsets.US_ASCII)}")
            FrameType.PROGRESS, FrameType.CREDIT -> { /* mid-transfer cadence — keep draining */ }
            else -> throw AssertionError("unexpected frame 0x${t2.toString(16)} before VERIFY_OK")
          }
        }
      }

      assertTrue("receiver must advertise a durable resume offset inside the interrupted range, was $base",
        base in 1..(3L * mib))
      assertTrue("recovered transfer must complete", listener.done.await(30, TimeUnit.SECONDS))
      assertNullError(listener)
      val stats = listener.completedStats!!
      val file = listener.completedFile!!

      // TEST B — the regression: the result average must be session-scoped.
      // The old code called stats(FULL durable total): a recovered transfer
      // divided pre-interruption bytes by the resumed wall (the 130.22 case).
      val sessionBytes = bytes.size.toLong() - base
      assertEquals("result stats must count ONLY the resumed session's bytes",
        sessionBytes, stats.bytes)
      assertTrue("average must be a valid rate, was ${stats.averageBps}",
        stats.averageBps == null || (stats.averageBps!!.isFinite() && stats.averageBps!! >= 0.0))
      if (stats.durationMs > 0) {
        val implied = stats.bytes * 1000.0 / stats.durationMs
        assertTrue("average ${stats.averageBps} must match sessionBytes/sessionWall ($implied)",
          stats.averageBps != null && Math.abs(stats.averageBps!! - implied) < 0.10 * implied)
      }

      // TEST C — the display fix must not touch integrity
      assertEquals("completed byte count must be the FULL file", bytes.size.toLong(), file.length())
      assertTrue("completed file content must be identical to the original",
        file.readBytes().contentEquals(bytes))
      assertEquals("SHA-256 must verify over the full recovered file", sha, listener.completedSha)
      assertFalse("finalized transfer must not leave the part file behind", part.exists())
    } finally { receiver.stop() }
  }

  private fun waitUntil(timeoutMs: Long, cond: () -> Boolean): Boolean {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
      if (cond()) return true
      Thread.sleep(20)
    }
    return cond()
  }

  /** TurboReceiver verifies the token — the sender must present the same one. */
  private fun tokenFor(dirName: String): SessionToken {
    val token = ByteArray(32) { (it * 7 + 1).toByte() }
    return SessionToken(token, "test-$dirName", "sess-$dirName")
  }

  private fun assertNullError(l: RecordingListener) {
    assertTrue("receiver error: ${l.error}", l.error == null)
  }
}
