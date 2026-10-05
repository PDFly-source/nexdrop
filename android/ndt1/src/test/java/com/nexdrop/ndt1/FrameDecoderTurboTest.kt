package com.nexdrop.ndt1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v1.4.2 turbo: FrameDecoder rewrite regression (single-copy accumulation
 * + zero-copy fast path + push(chunk, len)). The decoder is the hottest
 * code in the receive path — it must stay byte-for-byte identical to the
 * v1.4 semantics for EVERY chunking pattern TCP can produce.
 *
 *   - one frame per chunk, many frames per chunk, frames split across chunks
 *   - a header split in the middle (1-byte-at-a-time worst case)
 *   - the (chunk, len) form used by the socket loops
 *   - realistic 512 KiB DATA frame arriving in 64 KiB reads
 *   - high-water stays bounded; bad magic resets the accumulator
 */
class FrameDecoderTurboTest {

  private fun frame(type: Int, payload: ByteArray): ByteArray =
    encodeHeader(type, payload.size) + payload

  @Test
  fun `every chunking pattern decodes identically`() {
    val ctrl = frame(FrameType.PROGRESS, encodeOffset(1, 123456L))
    val data = frame(FrameType.DATA, ByteArray(512 * 1024)) // 512 KiB body
    val creditPayload = encodeOffset(1, 1L, 2) // real wire CREDIT: fileId|offset|size
    val credit = frame(FrameType.CREDIT, creditPayload)
    val stream = ctrl + data + credit
    val types = listOf(FrameType.PROGRESS, FrameType.DATA, FrameType.CREDIT)

    // reference: one shot
    FrameDecoder().push(stream).let { whole ->
      assertEquals(types, whole.map { it.first })
      assertEquals(123456L, decodeOffset(whole[0].second).second)
      assertEquals(512 * 1024, whole[1].second.size)
      assertTrue(whole[2].second.contentEquals(creditPayload))
    }

    fun feed(chunkSize: Int): List<Pair<Int, ByteArray>> {
      val d = FrameDecoder()
      val got = ArrayList<Pair<Int, ByteArray>>()
      var off = 0
      while (off < stream.size) {
        val n = minOf(chunkSize, stream.size - off)
        // exactly what the socket loops do: one reusable array per read
        val slice = stream.copyOfRange(off, off + n)
        d.push(slice, n).forEach(got::add)
        off += n
      }
      return got
    }

    for (chunkSize in intArrayOf(1, 5, 16, 17, 64 * 1024, stream.size)) {
      val got = feed(chunkSize)
      assertEquals("chunkSize=$chunkSize", types, got.map { it.first })
      assertEquals("chunkSize=$chunkSize", 123456L, decodeOffset(got[0].second).second)
      assertEquals("chunkSize=$chunkSize", 512 * 1024, got[1].second.size)
      assertTrue("chunkSize=$chunkSize", got[2].second.contentEquals(creditPayload))
    }
  }

  @Test
  fun `push with len shorter than the array parses only the prefix`() {
    val d = FrameDecoder()
    val a = frame(FrameType.HELLO, encodeNonce(42))
    val b = frame(FrameType.AUTH_OK, encodeNonce(43))
    val both = a + b
    val out = d.push(both, a.size) // only the first frame's bytes are valid
    assertEquals(1, out.size)
    assertEquals(FrameType.HELLO, out[0].first)
    assertEquals(42, decodeNonce(out[0].second))
    val rest = d.push(both.copyOfRange(a.size, both.size))
    assertEquals(1, rest.size)
    assertEquals(FrameType.AUTH_OK, rest[0].first)
    assertEquals(43, decodeNonce(rest[0].second))
  }

  @Test
  fun `high water stays bounded and bad magic resets the accumulator`() {
    val d = FrameDecoder()
    // partial HEADER (8 of 16 bytes) — decoder buffers, emits nothing
    val ping = frame(FrameType.PING, byteArrayOf(1, 2, 3, 4))
    assertTrue(d.push(ping.copyOf(8)).isEmpty())
    // remaining bytes complete PING; a second frame rides the same chunk
    val pong = frame(FrameType.PONG, byteArrayOf(9))
    val out = d.push(ping.copyOfRange(8, ping.size) + pong)
    assertEquals(2, out.size)
    assertEquals(FrameType.PING, out[0].first)
    assertEquals(FrameType.PONG, out[1].first)
    // pending accumulation is bounded: both buffered frames, nothing more
    assertTrue(d.bufferedBytesHighWater in 8..(ping.size + pong.size))

    val bad = FrameDecoder()
    try {
      bad.push(ByteArray(17) { it.toByte() })
      throw AssertionError("bad magic must throw")
    } catch (_: Ndt1Exception) {}
    // after the throw the decoder must be reset and usable
    bad.push(frame(FrameType.PONG, byteArrayOf(1))).let {
      assertEquals(1, it.size)
      assertEquals(FrameType.PONG, it[0].first)
    }
  }

  @Test
  fun `crc mismatch still rejects a tampered header`() {
    val d = FrameDecoder()
    val f = frame(FrameType.OFFER, encodeOffer(1, 100L, "f.bin", "ab"))
    f[8] = (f[8].toInt() xor 0x01).toByte() // tamper payload length
    try {
      d.push(f)
      throw AssertionError("tampered header must throw")
    } catch (e: Ndt1Exception) {
      assertTrue(e.message!!.contains("CRC") || e.message!!.contains("cap"))
    }
  }
}
