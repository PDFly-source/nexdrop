package com.nexdrop.ndt1

/**
 * NDT1 wire protocol v1 — Kotlin implementation, byte-for-byte with the
 * Node reference (companion/src/frames.ts). All integers big-endian.
 *
 * Header (16 bytes):
 *   0  4  magic "NDT1"      (u32)   4  1  version = 1 (u8)
 *   5  1  frame type        (u8)    6  2  flags (u16)
 *   8  4  payload length    (u32, max 8 MiB)
 *  12  4  CRC32 of header bytes 0..11 (u32)
 *
 * DATA payload: fileId u32 | offset u64 | fileSize u64 | len u32 | bytes
 */

object FrameType {
  const val HELLO = 0x01
  const val AUTH_OK = 0x02
  const val REJECT = 0x03
  const val OFFER = 0x10
  const val READY = 0x11
  const val DATA = 0x20
  const val CREDIT = 0x21
  const val PAUSE = 0x30
  const val RESUME = 0x31
  const val CANCEL = 0x32
  const val PROGRESS = 0x40
  const val COMPLETE = 0x50
  const val VERIFY_OK = 0x51
  const val VERIFY_FAIL = 0x52
  const val ERROR = 0x7f
  const val PING = 0x60
  const val PONG = 0x61
}

/**
 * Runtime-tunable pump parameters for BENCHMARKING only (mission §5).
 * Defaults are the canonical measured spec values — never change them
 * without a real-device A/B. The wire format is NOT affected: frame size
 * only changes the DATA frame split; the window is receiver-granted.
 */
object Ndt1Tunables {
  @Volatile var frameBytes: Int = Ndt1.FRAME_BYTES        // 512 KiB
  @Volatile var windowBytes: Int = Ndt1.WINDOW_BYTES      // 8 MiB
  @Volatile var socketBufferBytes: Int = 2 * 1024 * 1024  // 2 MiB
  // v1.4.2 PERF LAB: durability batch = bytes per fsync+PROGRESS cycle.
  // Default is the measured spec (512 KiB). Larger batches keep the SAME
  // contract — durableOffset only advances past fsynced data, PROGRESS/
  // CREDIT never acknowledge beyond durable — with fewer storage round
  // trips. Wire-compatible: PROGRESS cadence is receiver-side behavior.
  @Volatile var progressCadenceBytes: Int = Ndt1.PROGRESS_CADENCE
  fun reset() {
    frameBytes = Ndt1.FRAME_BYTES
    windowBytes = Ndt1.WINDOW_BYTES
    socketBufferBytes = 2 * 1024 * 1024
    progressCadenceBytes = Ndt1.PROGRESS_CADENCE
  }
}

object Ndt1 {
  const val MAGIC = 0x4E445431          // "NDT1"
  const val VERSION = 1
  const val HEADER_SIZE = 16
  const val MAX_PAYLOAD = 8 * 1024 * 1024
  const val FRAME_BYTES = 512 * 1024    // measured optimum (spec: 1-4 MiB worse)
  const val WINDOW_BYTES = 8 * 1024 * 1024
  const val PROGRESS_CADENCE = 512 * 1024
  const val AUTH_TTL_MS = 10 * 60 * 1000
  const val DISCOVERY_PORT = 53819
}

private val CRC_TABLE = IntArray(256).also { t ->
  for (n in 0..255) {
    var c = n
    repeat(8) { c = if (c and 1 != 0) (0xedb88320.toInt() xor (c ushr 1)) else (c ushr 1) }
    t[n] = c
  }
}

fun crc32(buf: ByteArray, start: Int = 0, end: Int = buf.size): Int {
  var c = 0xffffffff.toInt()
  for (i in start until end) c = CRC_TABLE[(c xor buf[i].toInt()) and 0xff] xor (c ushr 8)
  return (c xor 0xffffffff.toInt())
}

class Ndt1Exception(message: String) : Exception(message)

data class NdtHeader(val type: Int, val flags: Int, val length: Int)

fun encodeHeader(type: Int, payloadLen: Int, flags: Int = 0): ByteArray {
  val h = ByteArray(Ndt1.HEADER_SIZE)
  writeU32(h, 0, Ndt1.MAGIC)
  h[4] = Ndt1.VERSION.toByte()
  h[5] = type.toByte()
  writeU16(h, 6, flags)
  writeU32(h, 8, payloadLen)
  writeU32(h, 12, crc32(h, 0, 12))
  return h
}

fun parseHeader(buf: ByteArray): NdtHeader = parseHeaderAt(buf, 0)

fun parseHeaderAt(buf: ByteArray, off: Int): NdtHeader {
  if (buf.size - off < Ndt1.HEADER_SIZE) throw Ndt1Exception("short header")
  if (readU32(buf, off) != Ndt1.MAGIC) throw Ndt1Exception("bad magic (not NDT1)")
  if (buf[off + 4].toInt() != Ndt1.VERSION) throw Ndt1Exception("unsupported version ${buf[off + 4]}")
  val type = buf[off + 5].toInt() and 0xff
  val length = readU32(buf, off + 8)
  if (length > Ndt1.MAX_PAYLOAD) throw Ndt1Exception("frame length $length exceeds cap")
  if (crc32(buf, off, off + 12) != readU32(buf, off + 12)) throw Ndt1Exception("header CRC mismatch")
  return NdtHeader(type, readU16(buf, off + 6), length)
}

/**
 * Streaming frame decoder — feed arbitrary socket chunks, receive parsed
 * frames. Bounded: at most one payload buffered (<= 8 MiB + header).
 */
class FrameDecoder {
  // v1.4.2 turbo: single-copy accumulation. The v1.4 decoder CONCATENATED
  // the pending buffer with every socket chunk (buf + chunk) — O(frame²/
  // chunk) memcpy, ~9x byte amplification per DATA frame at 64 KiB reads.
  // This decoder appends each chunk once into a growable buffer, parses
  // complete frames out of it, and parses directly from the caller's
  // chunk (zero copy) whenever nothing is pending. Wire format unchanged.
  private var acc = ByteArray(64 * 1024)
  private var accLen = 0
  var bufferedBytesHighWater = 0; private set

  fun push(chunk: ByteArray): List<Pair<Int, ByteArray>> = push(chunk, chunk.size)

  /** len lets callers reuse one socket-read buffer without a per-read copy. */
  fun push(chunk: ByteArray, len: Int): List<Pair<Int, ByteArray>> {
    if (len <= 0) return emptyList()
    val out = ArrayList<Pair<Int, ByteArray>>()
    if (accLen == 0) {
      var pos = 0
      while (true) {
        val remaining = len - pos
        if (remaining < Ndt1.HEADER_SIZE) break
        val header = try { parseHeaderAt(chunk, pos) } catch (e: Ndt1Exception) {
          accLen = 0; throw e
        }
        val total = Ndt1.HEADER_SIZE + header.length
        if (remaining < total) break
        out.add(header.type to chunk.copyOfRange(pos + Ndt1.HEADER_SIZE, pos + total))
        pos += total
      }
      if (pos < len) append(chunk, pos, len)
      return out
    }
    append(chunk, 0, len)
    var consumed = 0
    while (accLen - consumed >= Ndt1.HEADER_SIZE) {
      val header = try { parseHeaderAt(acc, consumed) } catch (e: Ndt1Exception) {
        accLen = 0; throw e
      }
      val total = Ndt1.HEADER_SIZE + header.length
      if (accLen - consumed < total) break
      out.add(header.type to acc.copyOfRange(consumed + Ndt1.HEADER_SIZE, consumed + total))
      consumed += total
    }
    if (consumed > 0) {
      System.arraycopy(acc, consumed, acc, 0, accLen - consumed)
      accLen -= consumed
    }
    return out
  }

  private fun append(chunk: ByteArray, from: Int, to: Int) {
    val n = to - from
    if (acc.size - accLen < n) {
      var cap = acc.size
      while (cap - accLen < n) cap = cap shl 1
      acc = acc.copyOf(cap)
    }
    System.arraycopy(chunk, from, acc, accLen, n)
    accLen += n
    if (accLen > bufferedBytesHighWater) bufferedBytesHighWater = accLen
  }
}

// ---- payload codecs (all big-endian, mirroring frames.ts) ----

fun encodeHello(sessionId: String, tokenProof: ByteArray, nonce: Int): ByteArray {
  val id = sessionId.toByteArray(Charsets.UTF_8)
  val p = ByteArray(7 + id.size + tokenProof.size)
  writeU32(p, 0, nonce)
  p[4] = id.size.toByte()
  id.copyInto(p, 5)
  writeU16(p, 5 + id.size, tokenProof.size)
  tokenProof.copyInto(p, 7 + id.size)
  return p
}

fun decodeHello(p: ByteArray): Triple<String, ByteArray, Int> {
  val nonce = readU32(p, 0)
  val idLen = p[4].toInt() and 0xff
  val sessionId = String(p, 5, idLen, Charsets.UTF_8)
  val proofLen = readU16(p, 5 + idLen)
  val proof = p.copyOfRange(7 + idLen, 7 + idLen + proofLen)
  return Triple(sessionId, proof, nonce)
}

fun encodeNonce(nonce: Int) = ByteArray(4).also { writeU32(it, 0, nonce) }
fun decodeNonce(p: ByteArray) = readU32(p, 0)

fun encodeOffer(fileId: Int, sizeBytes: Long, name: String, sha256Hex: String): ByteArray {
  val nameB = name.toByteArray(Charsets.UTF_8)
  val sha = sha256Hex.toByteArray(Charsets.US_ASCII)
  val p = ByteArray(15 + nameB.size + sha.size)
  writeU32(p, 0, fileId)
  writeU64(p, 4, sizeBytes)
  writeU16(p, 12, nameB.size)
  nameB.copyInto(p, 14)
  p[14 + nameB.size] = sha.size.toByte()
  sha.copyInto(p, 15 + nameB.size)
  return p
}

data class Offer(val fileId: Int, val sizeBytes: Long, val name: String, val sha256: String)

fun decodeOffer(p: ByteArray): Offer {
  val fileId = readU32(p, 0)
  val size = readU64(p, 4)
  val nameLen = readU16(p, 12)
  val name = String(p, 14, nameLen, Charsets.UTF_8)
  val shaLen = p[14 + nameLen].toInt() and 0xff
  val sha = String(p, 15 + nameLen, shaLen, Charsets.US_ASCII)
  return Offer(fileId, size, name, sha)
}

fun encodeOffset(fileId: Int, offset: Long, size: Int? = null): ByteArray {
  val p = if (size == null) ByteArray(12) else ByteArray(16)
  writeU32(p, 0, fileId)
  writeU64(p, 4, offset)
  if (size != null) writeU32(p, 12, size)
  return p
}

fun decodeOffset(p: ByteArray): Pair<Int, Long> = readU32(p, 0) to readU64(p, 4)
fun decodeCredit(p: ByteArray): Pair<Int, Int> = readU32(p, 0) to readU32(p, 4)

data class DataFrame(val fileId: Int, val offset: Long, val fileSize: Long, val bytes: ByteArray)

fun decodeData(p: ByteArray): DataFrame {
  val fileId = readU32(p, 0)
  val offset = readU64(p, 4)
  val size = readU64(p, 12)
  val len = readU32(p, 20)
  if (p.size < 24 + len) throw Ndt1Exception("short DATA payload")
  return DataFrame(fileId, offset, size, p.copyOfRange(24, 24 + len))
}

fun encodeComplete(fileId: Int, sha256Hex: String): ByteArray {
  val sha = sha256Hex.toByteArray(Charsets.US_ASCII)
  val p = ByteArray(5 + sha.size)
  writeU32(p, 0, fileId)
  p[4] = sha.size.toByte()
  sha.copyInto(p, 5)
  return p
}

fun decodeComplete(p: ByteArray): Pair<Int, String> {
  val fileId = readU32(p, 0)
  val len = p[4].toInt() and 0xff
  return fileId to String(p, 5, len, Charsets.US_ASCII)
}

// ---- little endianness helpers (all unsigned-safe) ----
internal fun writeU16(b: ByteArray, off: Int, v: Int) {
  b[off] = ((v ushr 8) and 0xff).toByte(); b[off + 1] = (v and 0xff).toByte()
}
internal fun writeU32(b: ByteArray, off: Int, v: Int) {
  b[off] = ((v ushr 24) and 0xff).toByte(); b[off + 1] = ((v ushr 16) and 0xff).toByte()
  b[off + 2] = ((v ushr 8) and 0xff).toByte(); b[off + 3] = (v and 0xff).toByte()
}
internal fun writeU64(b: ByteArray, off: Int, v: Long) {
  writeU32(b, off, (v ushr 32).toInt()); writeU32(b, off + 4, (v and 0xffffffffL).toInt())
}
internal fun readU16(b: ByteArray, off: Int) = ((b[off].toInt() and 0xff) shl 8) or (b[off + 1].toInt() and 0xff)
internal fun readU32(b: ByteArray, off: Int): Int =
  ((b[off].toInt() and 0xff) shl 24) or ((b[off + 1].toInt() and 0xff) shl 16) or
  ((b[off + 2].toInt() and 0xff) shl 8) or (b[off + 3].toInt() and 0xff)
internal fun readU64(b: ByteArray, off: Int): Long =
  ((readU32(b, off).toLong() and 0xffffffffL) shl 32) or (readU32(b, off + 4).toLong() and 0xffffffffL)
