package com.nexdrop.ndt1

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationCompat

/**
 * Foreground transfer service (mission §16 + v1.4 Phase 3).
 * Long transfers survive screen-off and background pressure. The
 * notification is TRUTHFUL: it renders the same durable-bytes/elapsed
 * math as the UI (SpeedFormat) — never predicted, never peak. Pause /
 * resume / cancel actions route to the live engine through engineControl
 * (registered by MainActivity for the in-flight transfer only, so a stale
 * notification can never control a dead transfer). Completion / failure
 * are only claimed after the receiver-authoritative verdict and are
 * posted on separate, auto-cancellable notifications.
 *
 * POST_NOTIFICATIONS denied (Android 13+): the foreground service still
 * runs and the transfer is unaffected — Android just hides the surface.
 */
class TransferService : Service() {

  override fun onBind(intent: Intent?) = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        return START_NOT_STICKY
      }
      // Control intents never rebuild the progress surface themselves: the
      // next real progress tick (<=1 s) re-renders the truthful state.
      ACTION_PAUSE_RESUME -> engineControl?.invoke("pause")
      ACTION_CANCEL -> engineControl?.invoke("cancel")
      else -> refresh(intent)
    }
    return START_STICKY
  }

  /** (Re)post the foreground progress notification from the given intent. */
  private fun refresh(intent: Intent?) {
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Waiting for sender…"
    val total = intent?.getLongExtra(EXTRA_TOTAL, -1L) ?: -1L
    val durable = intent?.getLongExtra(EXTRA_DURABLE, -1L) ?: -1L
    val paused = intent?.getBooleanExtra(EXTRA_PAUSED, false) ?: false
    val canControl = intent?.getBooleanExtra(EXTRA_CAN_CONTROL, false) ?: false
    val notif = buildProgressNotification(text, total, durable, paused, canControl)
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIF_ID, notif)
    }
  }

  private fun channel(): NotificationChannel =
    NotificationChannel(CHANNEL, "Transfers", NotificationManager.IMPORTANCE_LOW)

  private fun base(): NotificationCompat.Builder {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(channel())
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setOnlyAlertOnce(true)
  }

  private fun buildProgressNotification(
    text: String, total: Long, durable: Long, paused: Boolean, canControl: Boolean,
  ): Notification {
    val b = base().setContentTitle("NexDrop").setContentText(text).setOngoing(true)
    if (total > 0 && durable >= 0) b.setProgress(100, (durable * 100 / total).toInt(), false)
    if (canControl) {
      b.addAction(0, if (paused) "RESUME" else "PAUSE", servicePending(ACTION_PAUSE_RESUME, 11))
      b.addAction(0, "CANCEL", servicePending(ACTION_CANCEL, 12))
    }
    return b.build()
  }

  private fun servicePending(action: String, rc: Int): PendingIntent =
    PendingIntent.getService(this, rc, Intent(this, TransferService::class.java).setAction(action),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

  companion object {
    private const val CHANNEL = "nexdrop_transfers"
    private const val NOTIF_ID = 42
    private const val COMPLETE_ID = 43
    private const val FAILED_ID = 44
    private const val ACTION_STOP = "com.nexdrop.ndt1.STOP"
    private const val ACTION_PAUSE_RESUME = "com.nexdrop.ndt1.PAUSE_RESUME"
    private const val ACTION_CANCEL = "com.nexdrop.ndt1.CANCEL"
    private const val EXTRA_TEXT = "text"
    private const val EXTRA_TOTAL = "total"
    private const val EXTRA_DURABLE = "durable"
    private const val EXTRA_PAUSED = "paused"
    private const val EXTRA_CAN_CONTROL = "can_control"

    /** Registered by MainActivity for the LIVE transfer only; null otherwise. */
    @Volatile var engineControl: ((String) -> Unit)? = null

    fun start(context: Context, text: String) {
      send(context, Intent(context, TransferService::class.java).putExtra(EXTRA_TEXT, text))
    }

    private fun send(context: Context, i: Intent) {
      try { androidx.core.content.ContextCompat.startForegroundService(context, i) } catch (_: Exception) {}
    }

    /**
     * Truthful progress line: "72% — 8.1 MiB/s — ETA 18 s" plus the real
     * progress bar and PAUSE/RESUME + CANCEL when the engine is controllable.
     * Never claims completion (only SHA-verified completion does).
     */
    fun notifyProgress(context: Context, name: String, durableBytes: Long, total: Long, bps: Double?, paused: Boolean = false, canControl: Boolean = false) {
      val pct = if (total > 0) (durableBytes * 100 / total).toInt() else 0
      val text = "$pct%  ·  ${SpeedFormat.speedText(bps)}" +
        "  ·  ETA ${SpeedFormat.etaText(total - durableBytes, bps)}  —  $name"
      send(context, Intent(context, TransferService::class.java)
        .putExtra(EXTRA_TEXT, text)
        .putExtra(EXTRA_TOTAL, total)
        .putExtra(EXTRA_DURABLE, durableBytes)
        .putExtra(EXTRA_PAUSED, paused)
        .putExtra(EXTRA_CAN_CONTROL, canControl))
    }

    /** SHA-verified completion: separate auto-cancel notification, then the FGS stops. */
    fun complete(context: Context, summary: String) {
      stop(context)
      postEvent(context, COMPLETE_ID, "Transfer complete", summary, android.R.drawable.stat_sys_download_done, true)
    }

    /** Real failure with the engine's reason. */
    fun fail(context: Context, reason: String) {
      stop(context)
      postEvent(context, FAILED_ID, "Transfer failed", reason, android.R.drawable.stat_notify_error, false)
    }

    private fun postEvent(context: Context, id: Int, title: String, text: String, icon: Int, ok: Boolean) {
      val nm = context.getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(channel(context))
      val open = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val pi = open?.let {
        PendingIntent.getActivity(context, 20, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      }
      val n = NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(icon)
        .setContentTitle(title)
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setAutoCancel(true)
        .setContentIntent(pi)
        .build()
      try { nm.notify(id, n) } catch (_: Exception) {}
    }

    private fun channel(context: Context): NotificationChannel =
      NotificationChannel(CHANNEL, "Transfers", NotificationManager.IMPORTANCE_DEFAULT)

    /** Cleanly remove the foreground service after completion/cancel/failure. */
    fun stop(context: Context) {
      try { context.startService(Intent(context, TransferService::class.java).setAction(ACTION_STOP)) } catch (_: Exception) {}
    }
  }
}
