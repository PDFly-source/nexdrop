package com.nexdrop.ndt1

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * NexDrop v1.4.7 cold-start splash.
 *
 * Branding comes from assets/splash/index.html bundled in the APK (offline-safe).
 *
 * Transition contract, all triggers funnel through one atomic claim so that
 * exactly ONE MainActivity start happens per process:
 *  - onPageFinished  -> after MIN_DISPLAY_MS (animation not cut short)
 *  - fail-safe timer -> armed in onCreate BEFORE the WebView exists
 *  - setup failure   -> immediate
 * On activity recreation (rotation) after the claim, the new instance finishes
 * immediately instead of re-showing the splash or launching a second MainActivity.
 */
class SplashActivity : AppCompatActivity() {

  private val handler = Handler(Looper.getMainLooper())
  private var launched = false
  private var web: WebView? = null

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // Target 36 lays the window out edge-to-edge: the splash asset is white and
    // full-bleed, so only the icon contrast needs pinning (dark icons).
    runCatching {
      WindowCompat.setDecorFitsSystemWindows(window, false)
      val c = WindowInsetsControllerCompat(window, window.decorView)
      c.isAppearanceLightStatusBars = true
      c.isAppearanceLightNavigationBars = true
    }
    Log.i(TAG, "onCreate: pid=${android.os.Process.myPid()} transitioned=$transitioned launches=$launches")

    if (transitioned) {
      // Recreated after the hand-off: the app is already behind us.
      Log.i(TAG, "recreated after transition -> finishing without relaunch")
      finish()
      return
    }

    // Armed before the WebView exists: no setup failure can trap the user here.
    handler.postDelayed({ openApp("fail-safe-${MAX_DISPLAY_MS}ms") }, MAX_DISPLAY_MS)
    Log.i(TAG, "fail-safe armed (${MAX_DISPLAY_MS}ms)")

    try {
      val view = WebView(this).apply {
        setBackgroundColor(Color.WHITE)
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
        settings.javaScriptEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        webViewClient = object : WebViewClient() {
          override fun onPageFinished(v: WebView?, url: String?) {
            super.onPageFinished(v, url)
            Log.i(TAG, "onPageFinished: $url")
            if (!launched) handler.postDelayed({ openApp("page-finished") }, MIN_DISPLAY_MS)
          }
          override fun onReceivedError(v: WebView?, r: WebResourceRequest?, e: WebResourceError?) {
            Log.e(TAG, "onReceivedError: ${e?.errorCode} ${e?.description}")
          }
        }
      }
      web = view
      setContentView(view, ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      view.loadUrl(SPLASH_URL)
      Log.i(TAG, "splash asset requested: $SPLASH_URL")
    } catch (t: Throwable) {
      Log.e(TAG, "splash setup failed - advancing immediately", t)
      openApp("setup-failed")
    }
  }

  /** Atomically claims the single transition; returns true only for the winner. */
  private fun claimTransition(reason: String): Boolean {
    synchronized(LOCK) {
      if (transitioned) {
        Log.i(TAG, "transition REJECTED ($reason): already transitioned, launches=$launches")
        return false
      }
      transitioned = true
      launches += 1
      Log.i(TAG, "transition ACCEPTED ($reason) launches=$launches pid=${android.os.Process.myPid()}")
      return true
    }
  }

  private fun openApp(reason: String) {
    if (launched) {
      Log.i(TAG, "openApp($reason) ignored: this instance already launched")
      return
    }
    launched = true
    handler.removeCallbacksAndMessages(null)
    if (!claimTransition(reason)) {
      finish()
      return
    }
    try {
      startActivity(Intent(this, MainActivity::class.java))
      Log.i(TAG, "MainActivity start requested (finishing=$isFinishing)")
    } catch (t: Throwable) {
      Log.e(TAG, "MainActivity start failed", t)
    }
    finish()
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    val dying = web
    web = null
    if (dying != null) {
      try {
        (dying.parent as? ViewGroup)?.removeView(dying)
      } catch (t: Throwable) {
        Log.w(TAG, "detaching WebView failed", t)
      }
      Handler(Looper.getMainLooper()).post {
        try { dying.destroy() } catch (t: Throwable) { Log.w(TAG, "WebView destroy failed", t) }
      }
    }
    Log.i(TAG, "onDestroy (transitioned=$transitioned launches=$launches)")
    super.onDestroy()
  }

  private companion object {
    const val TAG = "NexDropSplash"
    const val MIN_DISPLAY_MS = 1_450L
    const val MAX_DISPLAY_MS = 4_000L
    const val SPLASH_URL = "file:///android_asset/splash/index.html"
    val LOCK = Any()

    @Volatile var transitioned = false
    @Volatile var launches = 0
  }
}
