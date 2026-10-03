package com.nexdrop.ndt1

import org.json.JSONObject

/**
 * QR pairing payload (control plane only — never carries file data).
 * Same ephemeral single-use 10-minute token as the NDT1 session root.
 */
object QrPairing {
  fun encode(session: SessionToken, ip: String, port: Int, deviceName: String): String =
    JSONObject().apply {
      put("v", 1); put("t", "ndt1")
      put("ip", ip); put("p", port)
      put("session", session.sessionId)
      put("token", session.base64Url)
      put("exp", System.currentTimeMillis() + Ndt1.AUTH_TTL_MS)
      put("dev", deviceName)
    }.toString()

  data class Pairing(val ip: String, val port: Int, val sessionId: String, val tokenB64: String, val expired: Boolean)

  fun decode(qr: String): Pairing? = try {
    val j = JSONObject(qr)
    if (j.optInt("v") != 1 || j.optString("t") != "ndt1") null
    else Pairing(
      j.getString("ip"), j.getInt("p"), j.getString("session"), j.getString("token"),
      System.currentTimeMillis() > j.optLong("exp", 0),
    )
  } catch (e: Exception) { null }

  fun tokenBytesFrom(pairing: Pairing): ByteArray =
    android.util.Base64.decode(pairing.tokenB64, android.util.Base64.URL_SAFE)
}
