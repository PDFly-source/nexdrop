package com.nexdrop.ndt1

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * REAL transfer history (Screens 08 "Recent transfers" + the History tab).
 * Records are appended ONLY on actual engine completion events
 * (TurboReceiver.onComplete / TurboSender.onComplete) — no mock rows.
 * Stored as a private JSON file; bounded to the last 100 records.
 */
object HistoryStore {
  data class Entry(
    val name: String,
    val bytes: Long,
    val sent: Boolean, // true = sent (this device → peer)
    val atMs: Long,
    val sha256: String,
    val verified: Boolean,
    val speedBps: Double,
    val durationMs: Long,
  )

  private const val FILE = "transfer-history.json"
  private const val MAX = 100

  private fun file(context: Context): File = File(context.filesDir, FILE)

  fun list(context: Context): List<Entry> = try {
    val arr = JSONArray(file(context).readText())
    (0 until arr.length()).map { i ->
      val j = arr.getJSONObject(i)
      Entry(
        name = j.getString("name"),
        bytes = j.getLong("bytes"),
        sent = j.getBoolean("sent"),
        atMs = j.getLong("at"),
        sha256 = j.getString("sha"),
        verified = j.getBoolean("ok"),
        speedBps = j.optDouble("bps"),
        durationMs = j.optLong("dur"),
      )
    }
  } catch (_: Exception) { emptyList() }

  /** Real action from Settings: remove all stored history (disk truth). */
  fun clear(context: Context) {
    try { file(context).delete() } catch (_: Exception) {}
  }

  fun record(context: Context, e: Entry) {
    try {
      val f = file(context)
      val arr = try { JSONArray(f.readText()) } catch (_: Exception) { JSONArray() }
      arr.put(JSONObject().apply {
        put("name", e.name); put("bytes", e.bytes); put("sent", e.sent)
        put("at", e.atMs); put("sha", e.sha256); put("ok", e.verified)
        put("bps", e.speedBps); put("dur", e.durationMs)
      })
      // bound: keep the newest MAX records
      val trimmed = JSONArray()
      val start = maxOf(0, arr.length() - MAX)
      for (i in start until arr.length()) trimmed.put(arr.get(i))
      f.writeText(trimmed.toString())
    } catch (_: Exception) { /* history must never break a transfer */ }
  }

  /** "Today" / "Yesterday" / "12 Mar" — same words as the mockup. */
  fun dayLabel(atMs: Long, nowMs: Long = System.currentTimeMillis()): String {
    fun day(ms: Long) = ms / 86_400_000L // UTC day index (label only)
    return when (day(atMs)) {
      day(nowMs) -> "Today"
      day(nowMs) - 1 -> "Yesterday"
      else -> {
        val c = java.util.Calendar.getInstance().apply { timeInMillis = atMs }
        "${c.get(java.util.Calendar.DAY_OF_MONTH)} ${
          java.text.DateFormatSymbols().shortMonths[c.get(java.util.Calendar.MONTH)]}"
      }
    }
  }
}
