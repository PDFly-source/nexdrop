package com.nexdrop.ndt1

import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import android.util.Base64

/**
 * Ephemeral session authentication — mirrors companion/src/handshake.ts.
 * The token is minted during pairing (QR / signaling), lives only for the
 * 10-minute session TTL, and is never stored persistently.
 */
object Handshake {
  private val rng = SecureRandom()

  fun newSessionToken(): SessionToken {
    val tokenBytes = ByteArray(32).also(rng::nextBytes)
    val sessionId = ByteArray(4).also(rng::nextBytes).joinToString("") { "%02x".format(it) }
    return SessionToken(tokenBytes, Base64.encodeToString(tokenBytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP), sessionId)
  }

  /** Client proof for HELLO: HMAC-SHA256(token, nonce_be4 || "ndt1-hello") */
  fun helloProof(tokenBytes: ByteArray, nonce: Int): ByteArray {
    val nonceB = ByteArray(4)
    writeU32(nonceB, 0, nonce)
    return hmac(tokenBytes, nonceB + "ndt1-hello".toByteArray(Charsets.US_ASCII))
  }

  fun verifyHelloProof(tokenBytes: ByteArray, nonce: Int, proof: ByteArray): Boolean {
    if (proof.size != 32) return false
    val expect = helloProof(tokenBytes, nonce)
    return constantTimeEquals(expect, proof)
  }

  private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
    Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }.doFinal(data)

  private fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean {
    var r = a.size xor b.size
    for (i in a.indices) r = r or (a[i].toInt() xor b.getOrElse(i) { 0 }.toInt())
    return r == 0
  }

  fun randomNonce(): Int {
    val b = ByteArray(4).also(rng::nextBytes)
    return readU32(b, 0)
  }
}

data class SessionToken(val tokenBytes: ByteArray, val base64Url: String, val sessionId: String)

object RejectReason {
  const val BAD_TOKEN = 0x01
  const val UNKNOWN_SESSION = 0x02
  const val SESSION_EXPIRED = 0x03
  const val SESSION_COMPLETED = 0x04
  const val BAD_VERSION = 0x05
}
