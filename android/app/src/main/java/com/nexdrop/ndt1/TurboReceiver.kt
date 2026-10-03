package com.nexdrop.ndt1

import java.io.File
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.nio.ByteBuffer
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
    fun onComplete(file: File, sha256: String, mbps: Double)
    fun onError(message: String)
  }

  private var server: ServerSocket? = null
  private val stopped = AtomicBoolean(false)

  fun start(port: Int = 0): Int {
    val ss = ServerSocket(port)
    server = ss
    thread(name = "ndt1-receiver") {
      while (!stopped.get()) {
        val sock = try { ss.accept() } catch (e: Exception) { break }
        sock.tcpNoDelay = true
        handleConnection(sock)
      }
    }
    return ss.localPort
  }

  fun stop() {
    stopped.set(true)
    server?.close()
  }

  private fun handleConnection(sock: java.net.Socket) {
    try {
      sock.use { s ->
        val out = s.getOutputStream()
        val input = s.getInputStream()
        val decoder = FrameDecoder()
        val buf = ByteArray(Ndt1.FRAME_BYTES + Ndt1.HEADER_SIZE + 24)

        // ---- HELLO (single-use token, 10-min TTL, replay-bound nonce) ----
        var frame = readFrame(decoder, input, buf) ?: return
        if (frame.first != FrameType.HELLO) return sendReject(out, RejectReason.BAD_TOKEN)
        val (sessionId, proof, nonce) = decodeHello(frame.second)
        if (sessionId != session.sessionId) return sendReject(out, RejectReason.UNKNOWN_SESSION)
        if (!Handshake.verifyHelloProof(session.tokenBytes, nonce, proof)) return sendReject(out, RejectReason.BAD_TOKEN)
        out.write(encodeHeader(FrameType.AUTH_OK, 4) + encodeNonce(nonce))

        // ---- OFFER -> accept/decline -> READY(resume point) ----
        frame = readFrame(decoder, input, buf) ?: return
        if (frame.first != FrameType.OFFER) return
        val offer = decodeOffer(frame.second)
        val accepted = listener.onOffer(offer)
        if (!accepted) {
          out.write(encodeHeader(FrameType.REJECT, 1) + byteArrayOf(RejectReason.BAD_TOKEN.toByte()))
          return
        }
        val partFile = File(downloadDir, offer.name + ".ndtpart")
        val writer = DurableWriter(partFile, offer.sizeBytes)
        val startMs = System.currentTimeMillis()
        out.write(encodeHeader(FrameType.READY, 12) + encodeOffset(offer.fileId, writer.durableOffset))

        // ---- DATA* with PROGRESS at 512 KiB + CREDIT to keep the window open ----
        var sinceProgress = 0L
        var verified = false
        loop@ while (true) {
          frame = readFrame(decoder, input, buf) ?: break
          when (frame.first) {
            FrameType.DATA -> {
              val d = decodeData(frame.second)
              if (d.fileId != offer.fileId) continue@loop
              writer.write(d.offset, d.bytes, d.bytes.size)
              sinceProgress += d.bytes.size
              if (sinceProgress >= Ndt1.PROGRESS_CADENCE) {
                sinceProgress = 0
                val durable = writer.fsyncDurable()
                out.write(encodeHeader(FrameType.PROGRESS, 12) + encodeOffset(offer.fileId, durable))
                // CREDIT: full window headroom — RAM stays bounded at 8 MiB.
                out.write(encodeHeader(FrameType.CREDIT, 16) + encodeOffset(offer.fileId, Ndt1.WINDOW_BYTES, Ndt1.WINDOW_BYTES))
                listener.onProgress(durable, offer.sizeBytes)
              }
            }
            FrameType.PAUSE -> { /* receiver honors: sender stops producing; drain continues */ }
            FrameType.RESUME -> {}
            FrameType.CANCEL -> { writer.close(); partFile.delete(); return }
            FrameType.COMPLETE -> {
              val durable = writer.fsyncDurable()
              out.write(encodeHeader(FrameType.PROGRESS, 12) + encodeOffset(offer.fileId, durable))
              listener.onProgress(durable, offer.sizeBytes)
              val (_, senderSha) = decodeComplete(frame.second)
              val receiverSha = writer.sha256Hex()
              val target = File(downloadDir, offer.name)
              if (receiverSha == senderSha) {
                writer.finalizeTo(target)
                out.write(encodeHeader(FrameType.VERIFY_OK, 4) + encodeOffset(offer.fileId, 0).copyOf(4)) // fileId u32
                val ms = (System.currentTimeMillis() - startMs).coerceAtLeast(1)
                listener.onComplete(target, receiverSha, offer.sizeBytes / 1048576.0 / (ms / 1000.0))
                verified = true
              } else {
                out.write(encodeHeader(FrameType.VERIFY_FAIL, 37) +
                  encodeComplete(offer.fileId, receiverSha))
                listener.onError("SHA-256 mismatch: sender=$senderSha receiver=$receiverSha")
                writer.close()
                partFile.delete()
              }
              break@loop
            }
            FrameType.PING -> out.write(encodeHeader(FrameType.PONG, 4) + frame.second)
            else -> { /* unknown control on the data plane: ignore */ }
          }
        }
        void verified
      }
    } catch (e: Exception) {
      listener.onError(e.message ?: "receiver error")
    }
  }

  private val pendingFrames = ArrayDeque<Pair<Int, ByteArray>>()

  /** Next frame from the pending queue, reading more socket bytes if empty. */
  private fun readFrame(decoder: FrameDecoder, input: java.io.InputStream, buf: ByteArray): Pair<Int, ByteArray>? {
    while (pendingFrames.isEmpty()) {
      val n = input.read(buf)
      if (n < 0) return null
      decoder.push(buf.copyOf(n)).forEach(pendingFrames::addLast)
    }
    return pendingFrames.removeFirst()
  }

  private fun sendReject(out: java.io.OutputStream, reason: Int) {
    out.write(encodeHeader(FrameType.REJECT, 1) + byteArrayOf(reason.toByte()))
  }
}
