package com.nexdrop.ndt1

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationCompat

/**
 * Foreground transfer service (mission §16): long transfers survive
 * screen-off and background pressure. The notification shows the same
 * durable-bytes/elapsed math as the UI and JSON (SpeedFormat) — never
 * predicted, never peak. Completion is only claimed by the UI after
 * receiver-authoritative SHA-256 verification; this service stops as
 * soon as the transfer ends (complete/cancel/failure).
 */
class TransferService : Service() {

  override fun onBind(intent: Intent?) = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Waiting for sender…"
    val notif = buildNotification(text)
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIF_ID, notif)
    }
    return START_STICKY
  }

  private fun buildNotification(text: String): Notification {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL, "Transfers", NotificationManager.IMPORTANCE_LOW)
      )
    }
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle("NexDrop")
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .build()
  }

  companion object {
    private const val CHANNEL = "nexdrop_transfers"
    private const val NOTIF_ID = 42
    private const val ACTION_STOP = "com.nexdrop.ndt1.STOP"
    private const val EXTRA_TEXT = "text"

    fun start(context: Context, text: String) {
      val i = Intent(context, TransferService::class.java).putExtra(EXTRA_TEXT, text)
      ContextCompat_compatStart(context, i)
    }

    private fun ContextCompat_compatStart(context: Context, i: Intent) {
      try { androidx.core.content.ContextCompat.startForegroundService(context, i) } catch (_: Exception) {}
    }

    /**
     * Truthful progress line (mission §16): "72% — 8.1 MiB/s — ETA 18 s"
     * — the same SpeedFormat math the UI shows. Never claims completion
     * (only SHA-verified completion does, and then we stop()).
     */
    fun notifyProgress(context: Context, name: String, durableBytes: Long, total: Long, bps: Double?) {
      val pct = if (total > 0) (durableBytes * 100 / total).toInt() else 0
      val text = "$pct%  ·  ${SpeedFormat.speedText(bps)}" +
        "  ·  ETA ${SpeedFormat.etaText(total - durableBytes, bps)}  —  $name"
      val i = Intent(context, TransferService::class.java).putExtra(EXTRA_TEXT, text)
      ContextCompat_compatStart(context, i)
    }

    /** Cleanly remove the foreground service after completion/cancel/failure. */
    fun stop(context: Context) {
      try { context.startService(Intent(context, TransferService::class.java).setAction(ACTION_STOP)) } catch (_: Exception) {}
    }
  }
}
