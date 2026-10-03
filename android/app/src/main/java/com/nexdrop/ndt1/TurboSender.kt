package com.nexdrop.ndt1

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.security.MessageDigest
import kotlin.concurrent.thread

/**
 * NDT1 TCP sender (client side): discovers/receives the receiver's address
 * + session token out-of-band (QR / discovery beacon), connects, HELLOs,
 * OFFERs the file, then pumps DATA under the 8 MiB durable-offset window
 * with 512 KiB frames. Content URIs stream via ContentResolver — never a
 * whole-file byte[] in RAM. Sends COMPLETE with the streamed SHA-256 and
 * requires VERIFY_OK before declaring success.
 */
class TurboSender(private val context: Context) {

  interface Listener {
    fun onProgress(durable: Long, total: Long)
    fun onComplete(sha256: String, mbps: Double)
    fun onError(message: String)
  }

  /** NOTE: signalSource must be a seekable stream; for content URIs we use
   * ContentResolver.openInputStream + skip(). */
  fun send(
    uri: Uri,
    displayName: String,
    sizeBytes: Long,
    host: String,
    port: Int,
    session: SessionToken,
    listener: Listener,
  ) {
    thread(name = "ndt1-sender") {
      try {
        Socket().use { sock ->
          sock.tcpNoDelay = true // measured +17% in the loopback A/B (spec table)
          sock.connect(InetSocketAddress(host, port), 8000)
          val out = sock.getOutputStream() as java.io.OutputStream
          val input = sock.getInputStream()
          val decoder = FrameDecoder()
          val readBuf = ByteArray(Ndt1.FRAME_BYTES)

          // ---- HELLO (single-use token proof, fresh nonce) ----
          val nonce = Handshake.randomNonce()
          val hello = encodeHello(session.sessionId, Handshake.helloProof(session.tokenBytes, nonce), nonce)
          out.write(encodeHeader(FrameType.HELLO, hello.size) + hello)
          val authFrame = nextFrame(decoder, input, readBuf)
            ?: throw Ndt1Exception("closed during auth")
          when (authFrame.first) {
            FrameType.AUTH_OK -> {
              if (decodeNonce(authFrame.second) != nonce) throw Ndt1Exception("AUTH_OK nonce mismatch")
            }
            FrameType.REJECT -> throw Ndt1Exception("rejected: reason=${authFrame.second[0]}")
            else -> throw Ndt1Exception("expected AUTH_OK, got 0x${authFrame.first.toString(16)}")
          }

          // ---- OFFER with streamed SHA-256 (single pass, bounded RAM) ----
          val sha = MessageDigest.getInstance("SHA-256")
          val hashBuf = ByteArray(1024 * 1024)
          ContentResolverStream(context, uri).use { src ->
            while (true) {
              val n = src.read(hashBuf)
              if (n < 0) break
              sha.update(hashBuf, 0, n)
            }
          }
          val shaHex = sha.digest().joinToString("") { "%02x".format(it) }
          val fileId = 1
          val offer = encodeOffer(fileId, sizeBytes, displayName, shaHex)
          out.write(encodeHeader(FrameType.OFFER, offer.size) + offer)

          // ---- READY: resume from the receiver's durable offset ----
          val readyFrame = nextFrame(decoder, input, readBuf)
            ?: throw Ndt1Exception("closed before READY")
          if (readyFrame.first != FrameType.READY) throw Ndt1Exception("expected READY")
          val startOffset = decodeOffset(readyFrame.second).second
          if (startOffset < 0 || startOffset > sizeBytes) throw Ndt1Exception("bad durable offset $startOffset")

          val startMs = System.currentTimeMillis()

          // ---- windowed DATA pump: sent - durable <= 8 MiB, 512 KiB frames ----
          var sent = startOffset
          var durable = startOffset
          val src = ContentResolverStream(context, uri)
          src.use {
            it.skip(startOffset)
            val frameBuf = ByteArray(Ndt1.HEADER_SIZE + 24 + Ndt1.FRAME_BYTES)
            while (sent < sizeBytes) {
              val space = Ndt1.WINDOW_BYTES - (sent - durable)
              if (space <= 0) {
                // window full: wait for PROGRESS/CREDIT
                val f = nextFrame(decoder, input, readBuf) ?: throw Ndt1Exception("peer closed mid-transfer")
                when (f.first) {
                  FrameType.PROGRESS -> durable = decodeOffset(f.second).second
                  FrameType.CREDIT -> {} // window headroom explicit grant
                  FrameType.CANCEL -> { listener.onError("cancelled by receiver"); return }
                  FrameType.PAUSE -> { readUntilResume(decoder, input, readBuf) }
                  else -> {}
                }
                continue
              }
              val want = minOf(Ndt1.FRAME_BYTES, sizeBytes - sent).toInt()
              val n = it.read(readBuf, 0, want)
              if (n <= 0) throw Ndt1Exception("source stream ended early at $sent")
              // DATA frame: header + {fileId, offset, size, len, bytes}
              encodeDataFrameInto(frameBuf, fileId, sent, sizeBytes, readBuf, n)
              out.write(frameBuf, 0, Ndt1.HEADER_SIZE + 24 + n)
              sent += n
              listener.onProgress(durable, sizeBytes)
            }
          }

          // ---- COMPLETE + VERIFY_OK handshake ----
          val complete = encodeComplete(fileId, shaHex)
          out.write(encodeHeader(FrameType.COMPLETE, complete.size) + complete)
          while (true) {
            val f = nextFrame(decoder, input, readBuf) ?: throw Ndt1Exception("closed before VERIFY")
            when (f.first) {
              FrameType.VERIFY_OK -> {
                val ms = (System.currentTimeMillis() - startMs).coerceAtLeast(1)
                listener.onComplete(shaHex, (sizeBytes - startOffset) / 1048576.0 / (ms / 1000.0))
                return
              }
              FrameType.VERIFY_FAIL -> {
                val (_, recvSha) = decodeComplete(f.second)
                listener.onError("VERIFY_FAIL: receiver sha=$recvSha")
                return
              }
              else -> {}
            }
          }
        }
      } catch (e: Exception) {
        listener.onError(e.message ?: "sender error")
      }
    }
  }

  private fun readUntilResume(decoder: FrameDecoder, input: java.io.InputStream, buf: ByteArray) {
    while (true) {
      val f = nextFrame(decoder, input, buf) ?: throw Ndt1Exception("closed while paused")
      if (f.first == FrameType.RESUME) return
      if (f.first == FrameType.CANCEL) throw Ndt1Exception("cancelled while paused")
    }
  }

  private fun nextFrame(decoder: FrameDecoder, input: java.io.InputStream, buf: ByteArray): Pair<Int, ByteArray>? {
    val pending = ArrayDeque<Pair<Int, ByteArray>>()
    while (true) {
      val n = input.read(buf)
      if (n < 0) return null
      decoder.push(buf.copyOf(n)).forEach(pending::addLast)
      if (pending.isNotEmpty()) return pending.removeFirst()
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
