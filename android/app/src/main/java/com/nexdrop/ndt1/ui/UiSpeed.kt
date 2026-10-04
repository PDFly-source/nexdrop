package com.nexdrop.ndt1.ui

import java.util.Locale

/**
 * UI display formatting — the owner's explicit spec:
 *   < 1 MB/s  -> KB/s   (e.g. "850 KB/s")
 *   >= 1 MB/s -> MB/s   (e.g. "11.12 MB/s")
 *   >= 1 GB/s -> GB/s   (e.g. "1.24 GB/s")
 * Never fabricated: unknown/invalid rates render "N/A" exactly like the
 * engine's telemetry-grade SpeedFormat (which stays untouched and keeps
 * feeding the JSON export / FGS notification in binary KiB/MiB units).
 */
object UiSpeed {
  fun speedText(bps: Double?): String {
    if (bps == null || !bps.isFinite() || bps < 0) return "N/A"
    val mb = bps / 1_000_000.0
    if (mb < 1.0) return "${"%.0f".format(Locale.US, bps / 1_000.0)} KB/s"
    val gb = mb / 1000.0
    return if (gb < 1.0) "${"%.2f".format(Locale.US, mb)} MB/s" else "${"%.2f".format(Locale.US, gb)} GB/s"
  }

  /** Mockup shows "ETA 4s" — seconds/minutes/hours, no leading zero games. */
  fun etaText(remainingBytes: Long, bps: Double?): String {
    if (bps == null || !bps.isFinite() || bps <= 0 || remainingBytes <= 0) return "—"
    val s = (remainingBytes / bps).toLong()
    return when {
      s < 60 -> "${s}s"
      s < 3600 -> "${s / 60}m ${s % 60}s"
      else -> "${s / 3600}h ${s % 3600 / 60}m"
    }
  }

  /** Mockup shows durations as "31s". */
  fun durationText(ms: Long): String {
    val s = (ms / 1000.0)
    return if (s < 60) "${"%.0f".format(Locale.US, s)}s"
    else if (s < 3600) "${(s / 60).toInt()}m ${"%.0f".format(Locale.US, s % 60)}s"
    else "${(s / 3600).toInt()}h ${s % 3600 / 60 .toInt()}m"
  }
}
