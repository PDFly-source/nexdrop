package com.nexdrop.ndt1

import android.content.Context
import android.net.Uri
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.thread
import kotlin.concurrent.withLock

/**
 * NDT1 TCP sender (client side): discovers/receives the receiver's address
 * + session token out-of-band (QR / discovery beacon), connects, HELLOs,
 * OFFERs the file, then pumps DATA under the 8 MiB durable-offset window
 * with 512 KiB frames. Content URIs stream via ContentResolver — never a
 * whole-file byte[] in RAM. Sends COMPLETE with the streamed SHA-256 and
 * requires VERIFY_OK before declaring success.
 *
 * Speed pump (mission §5): the window is large and bounded (8 MiB), frames
 * are 512 KiB, socket buffers are raised to 2 MiB each way, TCP_NODELAY is
 * on (measured +17% loopback, spec table). There is NO artificial rate
 * limiter and NO per-chunk UI callback: the listener fires at most 10 Hz.
 * PAUSE from the receiver (or the local UI) stops the producer only — the
 * durable-offset window resumes exactly where it left off.
 */
class TurboSender(private val context: Context) {

  interface Listener {
    fun onProgress(durable: Long, total: Long)
    fun onComplete(sha256: String, stats: ThroughputSampler.Stats)
    fun onError(message: String)
  }

  /**
   * v1.4.2 Phase 1: REAL per-stage timings of the last send, measured
   * inside the pump (never displayed until the transfer ends). This is
   * the honest bottleneck evidence for the physical A/B matrix.
   */
  class SenderProfile {
    @Volatile var preHashMs = 0.0; internal set
    @Volatile var readMs = 0.0; internal set
    @Volatile var writeMs = 0.0; internal set
    @Volatile var windowWaits = 0; internal set
    @Volatile var windowWaitMs = 0.0; internal set
    @Volatile var frames = 0; internal set
    // v1.4.2-rc4 Phase C: REAL kernel-applied socket config + link state +
    // post-COMPLETE PING->PONG RTT. Never the configured value — what the
    // kernel actually granted, read back off the live socket.
    @Volatile var linkText = ""; internal set
    @Volatile var verifyRttMs = 0.0; internal set
    // v1.4.2-rc2 UNITS FIX: counters are MILLISECONDS; the summary divides
    // by 1000 — displayed values are true seconds (measurements untouched).
    fun textSummary(): String =
      "TX — pre-hash SHA ${"%.2f".format(preHashMs / 1000.0)}s · file read ${"%.2f".format(readMs / 1000.0)}s · " +
        "socket write ${"%.2f".format(writeMs / 1000.0)}s · window waits $windowWaits× ${"%.2f".format(windowWaitMs / 1000.0)}s (avg ${"%.0f".format(if (windowWaits > 0) windowWaitMs / windowWaits else 0.0)} ms) · $frames frames" +
        (if (linkText.isNotEmpty()) " · $linkText" else "") +
        (if (verifyRttMs > 0) " · VERIFY RTT ${"%.0f".format(verifyRttMs)} ms" else "")
  }

  @Volatile var lastProfile = SenderProfile(); private set

  private val paused = ReentrantLock()
  private val pauseGate = paused.newCondition()
  private val cancelled = AtomicBoolean(false)
  private var active = false

  val isBusy: Boolean get() = active

  fun send(
    uri: Uri,
    displayName: String,
    sizeBytes: Long,
    host: String,
    port: Int,
    session: SessionToken,
    listener: Listener,
  ) {
    require(!active) { "sender busy" }
    active = true
    cancelled.set(false)
    lastProfile = SenderProfile()
    thread(name = "ndt1-sender") {
      RadioPerf.acquire(context) // rc6: keep the Wi-Fi radio awake for THIS transfer only
      try {
        Socket().use { sock ->
          sock.tcpNoDelay = true // measured +17% in the loopback A/B (spec table)
          try { sock.receiveBufferSize = Ndt1Tunables.socketBufferBytes } catch (_: Exception) {}
          try { sock.sendBufferSize = Ndt1Tunables.socketBufferBytes } catch (_: Exception) {}
          sock.connect(InetSocketAddress(host, port), 8000)
          // Phase C: the REAL socket config the kernel granted (read back,
          // never the requested value) + best-effort Wi-Fi link state.
          val ifName = try {
            java.net.NetworkInterface.getByInetAddress(sock.localAddress)?.name ?: "?"
          } catch (_: Exception) { "?" }
          lastProfile.linkText = "link — sndbuf ${sock.sendBufferSize / 1024} KiB · rcvbuf ${sock.receiveBufferSize / 1024} KiB · NODELAY ${sock.tcpNoDelay} · via $ifName · wifi ${wifiSummary()}"
          val out = sock.getOutputStream()
          val input = sock.getInputStream()
          val decoder = FrameDecoder()
          val readBuf = ByteArray(Ndt1Tunables.frameBytes)
          // rc6 FLOW FIX: ONE queue for the whole connection. The old
          // per-call ArrayDeque returned the first frame of a multi-frame
          // socket read and DISCARDED the siblings — stale PROGRESS meant a
          // smaller effective window and extra blocking reads.
          val pending = ArrayDeque<Pair<Int, ByteArray>>()
          fun nextFrameP(): Pair<Int, ByteArray>? {
            while (pending.isEmpty()) {
              val n = input.read(readBuf)
              if (n < 0) return null
              decoder.push(readBuf, n).forEach(pending::addLast)
            }
            return pending.removeFirst()
          }

          // ---- HELLO (single-use token proof, fresh nonce) ----
          val nonce = Handshake.randomNonce()
          val hello = encodeHello(session.sessionId, Handshake.helloProof(session.tokenBytes, nonce), nonce)
          out.write(encodeHeader(FrameType.HELLO, hello.size) + hello)
          val authFrame = nextFrameP()
            ?: throw Ndt1Exception("closed during auth")
          when (authFrame.first) {
            FrameType.AUTH_OK -> {
              if (decodeNonce(authFrame.second) != nonce) throw Ndt1Exception("AUTH_OK nonce mismatch")
            }
            FrameType.REJECT -> throw Ndt1Exception("rejected: reason=${authFrame.second[0]}")
            else -> throw Ndt1Exception("expected AUTH_OK, got 0x${authFrame.first.toString(16)}")
          }

          // ---- OFFER with streamed SHA-256 (protocol-mandated pre-pass,
          //      single pass, bounded RAM). The receiver's durable hash is
          //      authoritative — VERIFY_FAIL carries it back. ----
          val sha = MessageDigest.getInstance("SHA-256")
          val hashBuf = ByteArray(1024 * 1024)
          val hashT0 = System.nanoTime()
          ContentResolverStream(context, uri).use { src ->
            while (true) {
              val n = src.read(hashBuf)
              if (n < 0) break
              sha.update(hashBuf, 0, n)
            }
          }
          lastProfile.preHashMs = (System.nanoTime() - hashT0) / 1e6
          val shaHex = sha.digest().joinToString("") { "%02x".format(it) }
          val fileId = 1
          val offer = encodeOffer(fileId, sizeBytes, displayName, shaHex)
          out.write(encodeHeader(FrameType.OFFER, offer.size) + offer)

          // ---- READY: resume from the receiver's durable offset ----
          val readyFrame = nextFrameP()
            ?: throw Ndt1Exception("closed before READY")
          if (readyFrame.first != FrameType.READY) throw Ndt1Exception("expected READY")
          val startOffset = decodeOffset(readyFrame.second).second
          if (startOffset < 0 || startOffset > sizeBytes) throw Ndt1Exception("bad durable offset $startOffset")

          val sampler = ThroughputSampler()
          var lastNotify = 0L

          // ---- windowed DATA pump: sent - durable <= 8 MiB, 512 KiB frames ----
          var sent = startOffset
          var durable = startOffset
          ContentResolverStream(context, uri).use { src ->
            src.skip(startOffset)
            val frameBuf = ByteArray(Ndt1.HEADER_SIZE + 24 + Ndt1Tunables.frameBytes)
            while (sent < sizeBytes) {
              if (cancelled.get()) throw Ndt1Exception("cancelled by sender")
              paused.withLock { while (localPaused && !cancelled.get()) pauseGate.await() }
              if (cancelled.get()) throw Ndt1Exception("cancelled by sender")

              // rc6 FLOW FIX: drain EVERY already-buffered control frame
              // before deciding window space — durable stays fresh while
              // data flows, so the sender keeps the pipe fed continuously
              // instead of the old burst -> block-on-credit -> burst cycle.
              drain@ while (pending.isNotEmpty()) {
                val f = pending.removeFirst()
                when (f.first) {
                  FrameType.PROGRESS -> { val o = decodeOffset(f.second).second; if (o > durable) durable = o }
                  FrameType.CREDIT -> {} // window headroom explicit grant
                  FrameType.CANCEL -> { listener.onError("cancelled by receiver"); return@thread }
                  FrameType.PAUSE -> { readUntilResume(decoder, input, readBuf, pending) }
                  else -> {}
                }
                if (sent >= sizeBytes) break@drain
              }

              val space = Ndt1Tunables.windowBytes - (sent - durable)
              if (space <= 0) {
                // window genuinely exhausted: block for the next wire frame
                // (timed — this is the honest credit-starvation counter)
                val waitT0 = System.nanoTime()
                val f = nextFrameP() ?: throw Ndt1Exception("peer closed mid-transfer")
                lastProfile.windowWaits++
                lastProfile.windowWaitMs += (System.nanoTime() - waitT0) / 1e6
                pending.addFirst(f) // processed by the drain loop above
              } else {
                val want = minOf(Ndt1Tunables.frameBytes.toLong(), sizeBytes - sent).toInt()
                val readT0 = System.nanoTime()
                val n = src.read(readBuf, 0, want)
                if (n <= 0) throw Ndt1Exception("source stream ended early at $sent")
                // DATA frame: header + {fileId, offset, size, len, bytes}
                encodeDataFrameInto(frameBuf, fileId, sent, sizeBytes, readBuf, n)
                val writeT0 = System.nanoTime()
                out.write(frameBuf, 0, Ndt1.HEADER_SIZE + 24 + n)
                val writeT1 = System.nanoTime()
                lastProfile.readMs += (writeT0 - readT0) / 1e6
                lastProfile.writeMs += (writeT1 - writeT0) / 1e6
                lastProfile.frames++
                sent += n

                // sampler + throttled UI (max 10 Hz — never per-chunk)
                sampler.sample(sent)
                val now = System.currentTimeMillis()
                if (now - lastNotify >= 100) {
                  lastNotify = now
                  listener.onProgress(durable, sizeBytes)
                }
              }
            }
          }

          // ---- COMPLETE + VERIFY_OK handshake ----
          // Phase C RTT probe: one PING under load, sent BEFORE COMPLETE so
          // the receiver's data loop still answers it (PONG is protocol-
          // legal on the data plane). The VERIFY loop records the returned
          // PONG and treats it as an unknown frame — wire unchanged.
          val rtt0 = System.nanoTime()
          out.write(encodeHeader(FrameType.PING, 4) + byteArrayOf(0, 0, 0, 0))
          val complete = encodeComplete(fileId, shaHex)
          out.write(encodeHeader(FrameType.COMPLETE, complete.size) + complete)
          while (true) {
            val f = nextFrameP() ?: throw Ndt1Exception("closed before VERIFY")
            if (f.first == FrameType.PONG && lastProfile.verifyRttMs <= 0) {
              lastProfile.verifyRttMs = (System.nanoTime() - rtt0) / 1e6
            }
            when (f.first) {
              FrameType.VERIFY_OK -> {
                listener.onComplete(shaHex, sampler.stats(sizeBytes - startOffset))
                return@thread
              }
              FrameType.VERIFY_FAIL -> {
                val (_, recvSha) = decodeComplete(f.second)
                listener.onError("VERIFY_FAIL: receiver sha=$recvSha")
                return@thread
              }
              else -> {}
            }
          }
        }
      } catch (e: Exception) {
        listener.onError(e.message ?: "sender error")
      } finally {
        RadioPerf.release() // rc6: radio back to normal power save on every exit path
        active = false
      }
    }
  }

  /** Phase C: best-effort radio truth (v1.4.2-rc5: needs ACCESS_FINE_LOCATION
   * at runtime on 8.1+ — without it Android returns nothing truthful and we
   * report "unavailable", never a guess). Reports rate, band, RSSI, and the
   * system-declared transport of the active network. */
  private fun wifiSummary(): String = try {
    val wm = context.getSystemService(android.content.Context.WIFI_SERVICE) as android.net.wifi.WifiManager
    val wi = wm.connectionInfo
    val freq = wi.frequency
    val band = when {
      freq >= 4900 -> "5 GHz"
      freq > 0 -> "2.4 GHz"
      else -> "band n/a"
    }
    val rssi = wi.rssi
    val rate = if (wi.linkSpeed > 0) "${wi.linkSpeed} Mbps" else "rate n/a"
    val rssiTxt = if (rssi != 0 && rssi > -127) "${rssi} dBm" else "RSSI n/a"
    val transport = try {
      val cm = context.getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
      val wifiNet = cm.allNetworks.firstOrNull { n -> cm.getNetworkCapabilities(n)?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) == true }
      val caps = if (wifiNet != null) cm.getNetworkCapabilities(wifiNet) else cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
      when {
        caps == null -> "transport n/a"
        caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) -> "transport WIFI"
        caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) -> "transport CELLULAR"
        else -> "transport other"
      }
    } catch (_: Exception) { "transport n/a" }
    "$rate · $band · $rssiTxt · $transport"
  } catch (e: Exception) { "unavailable" }

  @Volatile private var localPaused = false

  /** Local producer pause — no wire frame needed; the window simply stops draining. */
  fun pause() { paused.withLock { localPaused = true } }

  fun resume() { paused.withLock { localPaused = false; pauseGate.signalAll() } }

  fun cancel() {
    paused.withLock { localPaused = false; cancelled.set(true); pauseGate.signalAll() }
  }

  private fun readUntilResume(
    decoder: FrameDecoder, input: java.io.InputStream,
    buf: ByteArray, pending: ArrayDeque<Pair<Int, ByteArray>>,
  ) {
    while (true) {
      while (pending.isEmpty()) {
        val n = input.read(buf)
        if (n < 0) throw Ndt1Exception("closed while paused")
        decoder.push(buf, n).forEach(pending::addLast)
      }
      val f = pending.removeFirst()
      if (f.first == FrameType.RESUME) return
      if (f.first == FrameType.CANCEL) throw Ndt1Exception("cancelled while paused")
    }
  }
}

/** Seekable content-URI stream with bounded memory (no whole-file buffering). */
class ContentResolverStream(private val context: Context, private val uri: Uri) : InputStream() {
  private val stream = context.contentResolver.openInputStream(uri)
    ?: throw Ndt1Exception("cannot open $uri")

  override fun read(): Int = stream.read()
  override fun read(b: ByteArray, off: Int, len: Int): Int = stream.read(b, off, len)
  override fun skip(n: Long): Long = stream.skip(n)
  override fun close() = stream.close()
}

/** DATA frame assembly, single copy (fileId u32 | offset u64 | size u64 | len u32 | bytes). */
internal fun encodeDataFrameInto(
  into: ByteArray, fileId: Int, offset: Long, fileSize: Long, bytes: ByteArray, len: Int,
) {
  writeU32(into, 0, Ndt1.MAGIC)
  into[4] = Ndt1.VERSION.toByte()
  into[5] = FrameType.DATA.toByte()
  writeU16(into, 6, 0)
  writeU32(into, 8, 24 + len)
  writeU32(into, 12, 0)
  writeU32(into, 12, crc32(into, 0, 12))
  writeU32(into, Ndt1.HEADER_SIZE, fileId)
  writeU64(into, Ndt1.HEADER_SIZE + 4, offset)
  writeU64(into, Ndt1.HEADER_SIZE + 12, fileSize)
  writeU32(into, Ndt1.HEADER_SIZE + 20, len)
  bytes.copyInto(into, Ndt1.HEADER_SIZE + 24, 0, len)
}
