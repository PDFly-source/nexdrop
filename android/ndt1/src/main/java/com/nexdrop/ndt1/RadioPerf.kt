package com.nexdrop.ndt1

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build

/**
 * v1.4.2-rc6 — TRANSFER RADIO PERF LOCK (the honest Android throughput fix).
 *
 * Finding: both transfer sides spend 90%+ of wall time blocked on the socket
 * (TX in write, RX in read) with all storage/CPU stages tiny and the
 * frame/window/socket sweep flat. That means the TCP path itself is slow.
 * The one in-app lever Android gives for that: without a Wi-Fi lock, the
 * radio runs default power save and micro-sleeps between bursts; local
 * hotspot transfers then pace at a fraction of the link's real capacity.
 * Holding WIFI_MODE_FULL_LOW_LATENCY (API 29+, else FULL_HIGH_PERF) keeps
 * the radio awake for the DURATION OF THE ACTIVE TRANSFER ONLY — acquired
 * on connection, released on every exit path, never idle-held.
 *
 * This changes NO wire bytes, NO window semantics, NO durability contract.
 */
object RadioPerf {
  private val sync = Any()
  private var lock: WifiManager.WifiLock? = null
  private var refs = 0

  fun acquire(context: Context?) {
    if (context == null) return
    synchronized(sync) {
      refs++
      if (refs > 1 || lock?.isHeld == true) return
      try {
        val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val mode =
          if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY
          else @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
        lock = wm?.createWifiLock(mode, "nexdrop-transfer")?.apply {
          setReferenceCounted(false); acquire()
        }
      } catch (_: Exception) {
        lock = null
      }
    }
  }

  fun release() {
    synchronized(sync) {
      refs = (refs - 1).coerceAtLeast(0)
      if (refs > 0) return
      try { lock?.release() } catch (_: Exception) {}
      lock = null
    }
  }
}
