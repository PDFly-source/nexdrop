package com.nexdrop.ndt1

import java.io.File
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * NDT1 TCP receiver (server side): listens, authenticates the sender via
 * the single-use 10-minute session token, OFFERs arrive through the
 * [Listener] accept/decline callback, then streams DATA to the durable
 * writer with PROGRESS at 512 KiB cadence, CREDIT to keep the sender's
 * window open, and VERIFY_OK / VERIFY_FAIL on COMPLETE.
 *
 * Speed path (mission §5/§13): socket buffers raised to 2 MiB each way,
 * TCP_NODELAY on, fsync coalesced to the PROGRESS cadence (never per tiny
 * frame), SHA-256 incremental in the same pass as writes (no re-read), and
 * the UI listener fires at most 10 Hz. Pause/Resume/Cancel from the UI are
 * wire control frames the sender already honors.
 *
 * Interoperable with companion/src/tcpTransport.ts and TurboSender.
 */
class TurboReceiver(
  private val session: SessionToken,
  private val downloadDir: File,
  private val listener: Listener,
) {
  interface Listener {
    /** Must return quickly — decision UI runs on the caller's side. */
    fun onOffer(offer: Offer): Boolean
    fun onProgress(durable: Long, total: Long)
    fun onComplete(file: File, sha256: String, stats: ThroughputSampler.Stats)
    fun onError(message: String)
  }

  private var server: ServerSocket? = null
  private val stopped = AtomicBoolean(false)

  /** Current connection's control writer (wire PAUSE/RESUME/CANCEL). */
  @Volatile private var controlOut: java.io.OutputStream? = null
  @Volatile private var controlFileId: Int = 0

  fun start(port: Int = 0): Int {
    val ss = ServerSocket(port)
    try { ss.receiveBufferSize = Ndt1Tunables.socketBufferBytes } catch (_: Exception) {}
    server = ss
    thread(name = "ndt1-receiver") {
      while (!stopped.get()) {
        val sock = try { ss.accept() } catch (e: Exception) { break }
        sock.tcpNoDelay = true
        try { sock.receiveBufferSize = Ndt1Tunables.socketBufferBytes } catch (_: Exception) {}
        try { sock.sendBufferSize = Ndt1Tunables.socketBufferBytes } catch (_: Exception) {}
        handleConnection(sock)
      }
    }
    return ss.localPort
  }

  fun stop() {
    stopped.set(true)
    server?.close()
  }

  // ---- UI controls (mission §16: pause/resume/cancel over the wire) ----
  fun pause() { writeControl(FrameType.PAUSE) }
  fun resume() { writeControl(FrameType.RESUME) }
  fun cancel() { writeControl(FrameType.CANCEL) }

  private fun writeControl(type: Int) {
    val out = controlOut ?: return
    val fileId = controlFileId
    try {
      synchronized(out) {
        out.write(encodeHeader(type, 12) + encodeOffset(fileId, 0))
        out.flush()
      }
    } catch (_: Exception) {}
  }

  private fun handleConnection(sock: Socket) {
    try {
      sock.use { s ->
        val out = s.getOutputStream()
        controlOut = out
        val input = s.getInputStream()
        val decoder = FrameDecoder()
        val buf = ByteArray(Ndt1Tunables.frameBytes + Ndt1.HEADER_SIZE + 24)
        val pendingFrames = ArrayDeque<Pair<Int, ByteArray>>()

        fun readFrame(): Pair<Int, ByteArray>? {
          while (pendingFrames.isEmpty()) {
            val n = input.read(buf)
            if (n < 0) return null
            decoder.push(buf.copyOf(n)).forEach(pendingFrames::addLast)
          }
          return pendingFrames.removeFirst()
        }

        // ---- HELLO (single-use token, 10-min TTL, replay-bound nonce) ----
        var frame = readFrame() ?: return
        if (frame.first != FrameType.HELLO) return sendReject(out, RejectReason.BAD_TOKEN)
        val (sessionId, proof, nonce) = decodeHello(frame.second)
        if (sessionId != session.sessionId) return sendReject(out, RejectReason.UNKNOWN_SESSION)
        if (!Handshake.verifyHelloProof(session.tokenBytes, nonce, proof)) return sendReject(out, RejectReason.BAD_TOKEN)
        synchronized(out) { out.write(encodeHeader(FrameType.AUTH_OK, 4) + encodeNonce(nonce)) }

        // ---- OFFER -> accept/decline -> READY(resume point) ----
        frame = readFrame() ?: return
        if (frame.first != FrameType.OFFER) return
        val offer = decodeOffer(frame.second)
        controlFileId = offer.fileId
        val accepted = listener.onOffer(offer)
        if (!accepted) {
          // Canonical NDT1 has no separate decline reason — the wire byte
          // is REJECT 0x01 (bad-token), byte-identical to companion v1.
          synchronized(out) { out.write(encodeHeader(FrameType.REJECT, 1) + byteArrayOf(RejectReason.BAD_TOKEN.toByte())) }
          return
        }
        val partFile = File(downloadDir, offer.name + ".ndtpart")
        val writer = DurableWriter(partFile, offer.sizeBytes)
        val sampler = ThroughputSampler(System.currentTimeMillis())
        var lastNotify = 0L
        synchronized(out) { out.write(encodeHeader(FrameType.READY, 12) + encodeOffset(offer.fileId, writer.durableOffset)) }

        // ---- DATA* with PROGRESS at 512 KiB + CREDIT to keep the window open ----
        var sinceProgress = 0L
        loop@ while (true) {
          frame = readFrame() ?: break
          when (frame.first) {
            FrameType.DATA -> {
              val d = decodeData(frame.second)
              if (d.fileId != offer.fileId) continue@loop
              writer.write(d.offset, d.bytes, d.bytes.size)
              sinceProgress += d.bytes.size
              if (sinceProgress >= Ndt1.PROGRESS_CADENCE) {
                sinceProgress = 0
                val durable = writer.fsyncDurable()
                synchronized(out) {
                  out.write(encodeHeader(FrameType.PROGRESS, 12) + encodeOffset(offer.fileId, durable))
                  // CREDIT: full window headroom — RAM stays bounded at 8 MiB.
                  out.write(encodeHeader(FrameType.CREDIT, 16) + encodeOffset(offer.fileId, Ndt1Tunables.windowBytes, Ndt1Tunables.windowBytes))
                }
                sampler.sample(durable)
                val now = System.currentTimeMillis()
                if (now - lastNotify >= 100) { // max 10 Hz — never per-chunk
                  lastNotify = now
                  listener.onProgress(durable, offer.sizeBytes)
                }
              }
            }
            FrameType.PAUSE -> { /* receiver honors: sender stops producing; drain continues */ }
            FrameType.RESUME -> {}
            FrameType.CANCEL -> { writer.close(); partFile.delete(); return }
            FrameType.COMPLETE -> {
              val durable = writer.fsyncDurable()
              listener.onProgress(durable, offer.sizeBytes)
              val (_, senderSha) = decodeComplete(frame.second)
              val receiverSha = writer.sha256Hex()
              val target = File(downloadDir, offer.name)
              if (receiverSha == senderSha) {
                writer.finalizeTo(target)
                synchronized(out) { out.write(encodeHeader(FrameType.VERIFY_OK, 4) + encodeOffset(offer.fileId, 0).copyOf(4)) }
                listener.onComplete(target, receiverSha, sampler.stats(durable))
              } else {
                synchronized(out) {
                  out.write(encodeHeader(FrameType.VERIFY_FAIL, 37) + encodeComplete(offer.fileId, receiverSha))
                }
                listener.onError("SHA-256 mismatch: sender=$senderSha receiver=$receiverSha")
                writer.close()
                partFile.delete()
              }
              break@loop
            }
            FrameType.PING -> synchronized(out) { out.write(encodeHeader(FrameType.PONG, 4) + frame.second) }
            else -> { /* unknown control on the data plane: ignore */ }
          }
        }
      }
    } catch (e: Exception) {
      listener.onError(e.message ?: "receiver error")
    } finally {
      controlOut = null
    }
  }

  private fun sendReject(out: java.io.OutputStream, reason: Int) {
    try { synchronized(out) { out.write(encodeHeader(FrameType.REJECT, 1) + byteArrayOf(reason.toByte())) } } catch (_: Exception) {}
  }
}
