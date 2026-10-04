package com.nexdrop.ndt1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.ConnectException
import java.net.Socket
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Production regression suite (mission 2026-10-04 §5/§6/§13) around the
 * EXISTING native NDT1 implementation — the engine itself is untouched.
 *
 * Covers, over real TCP sockets with real disk I/O:
 *  - 358 MiB and 1 GiB native transfers, SHA-256 verified, byte-exact
 *  - PAUSE -> RESUME over the wire without data loss or duplication
 *  - CANCEL -> part file removed, socket closed cleanly
 *  - mid-transfer disconnect -> reconnect -> resume from the durable
 *    offset (never from zero, never duplicated bytes)
 *  - wrong-session HELLO -> REJECT, unreachable endpoint -> honest failure
 *
 * These are protocol/behavior regressions on fast local sockets. Physical
 * throughput numbers still come only from real devices (mission §20).
 */
class LargeTransferRegressionTest {

  // ---------- tiny wire helpers (big-endian, byte-identical to Frames.kt) ----------
  private fun u32(b: ByteArray, o: Int, v: Int) {
    b[o] = ((v ushr 24) and 0xff).toByte(); b[o + 1] = ((v ushr 16) and 0xff).toByte()
    b[o + 2] = ((v ushr 8) and 0xff).toByte(); b[o + 3] = (v and 0xff).toByte()
  }
  private fun u64(b: ByteArray, o: Int, v: Long) { u32(b, o, (v ushr 32).toInt()); u32(b, o + 4, (v and 0xffffffffL).toInt()) }
  private fun dataPayload(fileId: Int, offset: Long, total: Long, len: Int, src: ByteArray): ByteArray {
    val p = ByteArray(24 + len)
    u32(p, 0, fileId); u64(p, 4, offset); u64(p, 12, total); u32(p, 20, len)
    System.arraycopy(src, 0, p, 24, len)
    return p
  }
  private fun sha256(f: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    java.io.FileInputStream(f).use { i ->
      val buf = ByteArray(1024 * 1024)
      while (true) { val n = i.read(buf); if (n < 0) break; md.update(buf, 0, n) }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }

  // ---------- scripted NDT1 client ----------
  private inner class Client(private val host: String, private val port: Int, private val session: SessionToken) {
    lateinit var sock: Socket
    lateinit var out: OutputStream
    lateinit var input: InputStream
    private val decoder = FrameDecoder()
    private val pending = ArrayDeque<Pair<Int, ByteArray>>()
    private val readBuf = ByteArray(64 * 1024)
    val sawPause = AtomicBoolean(false)
    val sawResume = AtomicBoolean(false)
    val sawCancel = AtomicBoolean(false)

    fun connect() {
      sock = Socket(host, port)
      sock.tcpNoDelay = true
      sock.soTimeout = 120_000
      out = sock.getOutputStream(); input = sock.getInputStream()
    }

    @Synchronized
    fun nextFrame(): Pair<Int, ByteArray>? {
      while (pending.isEmpty()) {
        val n = try { input.read(readBuf) } catch (e: java.io.InterruptedIOException) { throw e }
        if (n < 0) return null
        decoder.push(readBuf.copyOf(n)).forEach(pending::addLast)
      }
      return pending.removeFirst()
    }

    /** Send HELLO; true = AUTH_OK, false = REJECT (payload byte = reason). */
    fun hello(): Boolean {
      val nonce = 0x5A11C0DE
      val hello = encodeHello(session.sessionId, Handshake.helloProof(session.tokenBytes, nonce), nonce)
      out.write(encodeHeader(FrameType.HELLO, hello.size) + hello)
      val (t, p) = nextFrame() ?: return false
      if (t == FrameType.REJECT) return false
      assertEquals(FrameType.AUTH_OK, t)
      assertEquals(nonce, decodeNonce(p))
      return true
    }

    /** OFFER; returns the READY durable offset (the resume point). */
    fun offer(fileId: Int, size: Long, name: String, sha: String): Long {
      val offer = encodeOffer(fileId, size, name, sha)
      out.write(encodeHeader(FrameType.OFFER, offer.size) + offer)
      val (t, p) = nextFrame()!!
      assertEquals(FrameType.READY, t)
      return decodeOffset(p).second
    }

    /**
     * ONE control-reader thread owns ALL inbound frames (PROGRESS/CREDIT,
     * PAUSE/RESUME/CANCEL, VERIFY_*) — no competing readers, no frame races.
     * Start once per connection, before pumping.
     */
    private var controlStarted = false
    @Synchronized
    fun startControlReader() {
      if (controlStarted) return
      controlStarted = true
      thread(name = "test-ctrl") {
        try {
          while (true) {
            val (t, p) = nextFrame() ?: return@thread
            when (t) {
              FrameType.PAUSE -> sawPause.set(true)
              FrameType.RESUME -> sawResume.set(true)
              FrameType.CANCEL -> sawCancel.set(true)
              FrameType.VERIFY_OK -> { verifySha = "ok"; verifyLatch.countDown() }
              FrameType.VERIFY_FAIL -> { verifyFail = true; verifySha = String(p, Charsets.US_ASCII); verifyLatch.countDown() }
            }
          }
        } catch (_: Exception) {}
      }
    }

    /**
     * Pump DATA frames from the source file starting at `from`. Honors
     * receiver wire PAUSE (stops producing, keeps the connection) and RESUME;
     * returns when the source is exhausted.
     */
    val sentBytes = java.util.concurrent.atomic.AtomicLong(0)

    fun pump(src: File, from: Long, fileId: Int, stopWhen: () -> Boolean = { false }) {
      val total = src.length()
      val buf = ByteArray(Ndt1.FRAME_BYTES)
      java.io.FileInputStream(src).use { f ->
        f.skip(from)
        var off = from
        while (off < total) {
          if (stopWhen() || sawCancel.get()) return
          while (sawPause.get() && !sawResume.get() && !sawCancel.get()) Thread.sleep(10)
          if (sawCancel.get()) return
          val len = minOf(buf.size.toLong(), total - off).toInt()
          val n = f.read(buf, 0, len)
          assertTrue("source ended early at $off", n > 0)
          out.write(encodeHeader(FrameType.DATA, 24 + n) + dataPayload(fileId, off, total, n, buf))
          off += n
          sentBytes.set(off)
        }
      }
    }

    /** COMPLETE; blocks until the receiver's VERIFY answer arrives. */
    fun complete(fileId: Int, sha: String) {
      val c = encodeComplete(fileId, sha)
      out.write(encodeHeader(FrameType.COMPLETE, c.size) + c)
      if (!verifyLatch.await(60, TimeUnit.SECONDS)) throw AssertionError("no VERIFY within 60 s")
      if (verifyFail) throw AssertionError("VERIFY_FAIL: receiver sha=$verifySha")
    }

    var verifySha: String? = null; private set
    var verifyFail = false; private set
    private val verifyLatch = CountDownLatch(1)

    fun close() { try { sock.close() } catch (_: Exception) {} }
  }

  // ---------- receiver + listener ----------
  private inner class RecordingListener : TurboReceiver.Listener {
    var accept = true
    val offerLatch = CountDownLatch(1)
    val completeLatch = CountDownLatch(1)
    @Volatile var lastDurable = 0L
    @Volatile var finalFile: File? = null
    @Volatile var finalSha: String? = null
    @Volatile var stats: ThroughputSampler.Stats? = null
    @Volatile var error: String? = null
    val progressLatch = CountDownLatch(1)

    override fun onOffer(offer: Offer): Boolean { offerLatch.countDown(); return accept }
    override fun onProgress(durable: Long, total: Long) {
      lastDurable = durable
      if (durable > 0) progressLatch.countDown()
    }
    override fun onComplete(file: File, sha256: String, stats: ThroughputSampler.Stats) {
      finalFile = file; finalSha = sha256; this.stats = stats; completeLatch.countDown()
    }
    override fun onError(message: String) { error = message }
  }

  private data class Setup(val receiver: TurboReceiver, val port: Int, val dir: File)

  private fun newReceiver(listener: RecordingListener, dirName: String): Setup {
    val session = SessionToken(ByteArray(32) { (it * 13 + 5).toByte() }, "tok", "sess-$dirName")
    val dir = Files.createTempDirectory(dirName).toFile()
    val r = TurboReceiver(session, dir, listener)
    val port = r.start(0, "127.0.0.1")
    return Setup(r, port, dir)
  }

  private fun tokenFor(dirName: String) =
    SessionToken(ByteArray(32) { (it * 13 + 5).toByte() }, "tok", "sess-$dirName")

  /** Poll with deadline — deterministic test triggers without sleep-races. */
  private fun await(what: String, timeoutMs: Long, cond: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
      if (cond()) return
      Thread.sleep(10)
    }
    throw AssertionError("timed out waiting for: $what")
  }

  private fun assertTelemetryHonest(stats: ThroughputSampler.Stats, expectedBytes: Long) {
    assertEquals(expectedBytes, stats.bytes)
    assertTrue("duration must be positive", stats.durationMs > 0)
    assertTrue("average must be finite positive, was ${stats.averageBps}",
      stats.averageBps != null && stats.averageBps!!.isFinite() && stats.averageBps!! > 0)
    assertTrue("sustained leaked an invalid value: ${stats.sustainedBps}",
      stats.sustainedBps == null || (stats.sustainedBps!!.isFinite() && stats.sustainedBps!! >= 0))
    assertTrue("peak leaked an invalid value: ${stats.peakSustainedBps}",
      stats.peakSustainedBps == null || (stats.peakSustainedBps!!.isFinite() && stats.peakSustainedBps!! >= 0))
  }

  // ================= the regression matrix =================

  @Test(timeout = 600_000)
  fun `358 MiB native transfer - SHA verified, byte-exact, honest telemetry`() {
    transferRegression(358L * 1024 * 1024, "regress-358.bin")
  }

  @Test(timeout = 900_000)
  fun `1 GiB native transfer - SHA verified, byte-exact, honest telemetry`() {
    transferRegression(1024L * 1024 * 1024, "regress-1gib.bin")
  }

  private fun transferRegression(size: Long, name: String) {
    val l = RecordingListener()
    val (receiver, port, dir) = newReceiver(l, name)
    val src = BenchFile.generate(dir, name, size)
    val sha = sha256(src)
    val c = Client("127.0.0.1", port, tokenFor(name))
    c.connect()
    assertTrue("AUTH_OK expected", c.hello())
    assertEquals("fresh receiver must start at 0", 0L, c.offer(1, size, name, sha))
    c.startControlReader()
    c.pump(src, 0, 1)
    c.complete(1, sha)
    assertTrue("VERIFY_OK latch", l.completeLatch.await(30, TimeUnit.SECONDS))
    val out = l.finalFile!!
    assertEquals(size, out.length())
    assertEquals(sha, l.finalSha)
    assertEquals(sha, sha256(out)) // receiver-authoritative: re-hash on disk
    assertTelemetryHonest(l.stats!!, size)
    receiver.stop(); c.close()
  }

  @Test(timeout = 120_000)
  fun `pause then resume over the wire - no loss, no duplication, SHA intact`() {
    val l = RecordingListener()
    val (receiver, port, dir) = newReceiver(l, "pause")
    val size = 32L * 1024 * 1024
    val src = BenchFile.generate(dir, "pause.bin", size)
    val sha = sha256(src)
    val c = Client("127.0.0.1", port, tokenFor("pause"))
    c.connect(); assertTrue(c.hello()); assertEquals(0L, c.offer(1, size, "pause.bin", sha))
    c.startControlReader()
    val pump = thread(name = "test-pump") { c.pump(src, 0, 1) }
    // Wait until data is flowing, then pause MID-TRANSFER from the receiver.
    await("1 MiB pumped", 30_000) { c.sentBytes.get() >= 1024 * 1024 }
    receiver.pause()
    await("wire PAUSE must reach the sender", 30_000) { c.sawPause.get() }
    receiver.resume()
    await("wire RESUME must reach the sender", 30_000) { c.sawResume.get() }
    pump.join(60_000)
    assertFalse("pump must finish after resume", pump.isAlive)
    c.complete(1, sha)
    assertTrue(l.completeLatch.await(30, TimeUnit.SECONDS))
    assertEquals(sha, l.finalSha)
    assertEquals(size, l.finalFile!!.length())
    receiver.stop(); c.close()
  }

  @Test(timeout = 120_000)
  fun `cancel - part file removed, no residue`() {
    val l = RecordingListener()
    val (receiver, port, dir) = newReceiver(l, "cancel")
    val size = 32L * 1024 * 1024
    val src = BenchFile.generate(dir, "cancel.bin", size)
    val sha = sha256(src)
    val c = Client("127.0.0.1", port, tokenFor("cancel"))
    c.connect(); assertTrue(c.hello()); assertEquals(0L, c.offer(1, size, "cancel.bin", sha))
    c.startControlReader()
    val pump = thread { c.pump(src, 0, 1) { if (c.sentBytes.get() >= 4L * 1024 * 1024) { receiver.cancel(); true } else false } }
    pump.join(60_000)
    assertFalse("pump must stop on cancel", pump.isAlive)
    await("wire CANCEL must reach the sender", 30_000) { c.sawCancel.get() }
    // Mission §5 policy: a USER cancel removes the part file once the
    // connection ends (a connection drop alone retains it for resume).
    c.close() // sender honors CANCEL and closes -> receiver sees EOF
    val part = File(dir, "cancel.bin.ndtpart")
    await("part file must be deleted after user cancel", 15_000) { !part.exists() }
    assertNull("no completion after cancel", l.finalFile)
    receiver.stop()
  }

  @Test(timeout = 120_000)
  fun `disconnect then reconnect - resumes from the durable offset, never from zero`() {
    val l = RecordingListener()
    val (receiver, port, dir) = newReceiver(l, "resume")
    val size = 4L * 1024 * 1024
    val src = BenchFile.generate(dir, "resume.bin", size)
    val sha = sha256(src)
    val token = tokenFor("resume")

    // First leg: transfer HALF, then drop the connection mid-flight.
    val c1 = Client("127.0.0.1", port, token)
    c1.connect(); assertTrue(c1.hello()); assertEquals(0L, c1.offer(1, size, "resume.bin", sha))
    c1.startControlReader()
    c1.pump(src, 0, 1) { if (l.lastDurable >= size / 2) true else false }
    c1.close() // abrupt disconnect — no COMPLETE

    // Second leg: same session token, same offer — READY must carry the
    // durable offset (never zero), and the resumed transfer must verify.
    Thread.sleep(200) // let the receiver thread observe the EOF
    val c2 = Client("127.0.0.1", port, token)
    c2.connect(); assertTrue(c2.hello())
    val resumeOffset = c2.offer(1, size, "resume.bin", sha)
    assertTrue("resume offset must be > 0 (got $resumeOffset)", resumeOffset > 0)
    assertTrue("resume offset must be <= size", resumeOffset <= size)
    c2.startControlReader()
    c2.pump(src, resumeOffset, 1)
    c2.complete(1, sha)
    assertTrue(l.completeLatch.await(30, TimeUnit.SECONDS))
    assertEquals(sha, l.finalSha)
    assertEquals(size, l.finalFile!!.length())
    assertEquals(sha, sha256(l.finalFile!!)) // no duplicated/missing bytes
    receiver.stop(); c2.close()
  }

  @Test(timeout = 30_000)
  fun `wrong-session HELLO is rejected`() {
    val l = RecordingListener()
    val setup = newReceiver(l, "reject")
    val port = setup.port
    val badToken = tokenFor("reject").let { SessionToken(it.tokenBytes, it.base64Url, "sess-OTHER") }
    val c = Client("127.0.0.1", port, badToken)
    c.connect()
    assertFalse("wrong session must be REJECTed", c.hello())
    setup.receiver.stop(); c.close()
  }

  @Test(timeout = 30_000)
  fun `unreachable endpoint fails honestly`() {
    // Bind then immediately stop — the port is guaranteed closed.
    val l = RecordingListener()
    val setup = newReceiver(l, "dead")
    val port = setup.port
    setup.receiver.stop()
    Thread.sleep(200)
    try {
      Client("127.0.0.1", port, tokenFor("dead")).connect()
      throw AssertionError("connect to a dead endpoint must fail")
    } catch (expected: ConnectException) { /* honest failure path */ }
  }

}
