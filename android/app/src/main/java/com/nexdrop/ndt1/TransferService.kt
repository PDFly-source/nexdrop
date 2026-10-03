package com.nexdrop.ndt1

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationCompat
import java.io.File

/**
 * Foreground transfer service (Phase 19): the transfer survives screen-off
 * and background pressure. Only the permissions needed for local transfer
 * are requested (declared in the manifest, requested from the Activity at
 * invocation time — NEARBY_WIFI_DEVICES on 13+, POST_NOTIFICATIONS).
 * The notification shows the honest durable speed — never predicted, never
 * peak (Phase 17).
 */
class TransferService : Service() {

  override fun onBind(intent: Intent?) = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notif = buildNotification("NexDrop Turbo", "Waiting for sender…")
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIF_ID, notif, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIF_ID, notif)
    }
    return START_STICKY
  }

  private fun buildNotification(title: String, text: String): Notification {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL, "Turbo transfers", NotificationManager.IMPORTANCE_LOW)
      )
    }
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .build()
  }

  fun notifyProgress(name: String, durableBytes: Long, total: Long, mbps: Double) {
    val text = if (total > 0) {
      val pct = (durableBytes * 100 / total).toInt()
      "Receiving $name — $pct% — ${"%.1f".format(mbps)} MB/s"
    } else "Receiving $name…"
    getSystemService(NotificationManager::class.java).notify(
      NOTIF_ID, buildNotification("NexDrop Turbo", text))
  }

  companion object {
    private const val CHANNEL = "nexdrop_turbo"
    private const val NOTIF_ID = 42
    /** Speed display: durable bytes / elapsed — actual, never predicted (§17). */
    fun durableMbps(durableBytes: Long, elapsedMs: Long): Double =
      if (elapsedMs <= 0) 0.0 else durableBytes / 1048576.0 / (elapsedMs / 1000.0)
  }
}
