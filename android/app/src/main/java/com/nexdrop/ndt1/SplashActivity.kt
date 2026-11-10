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
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

/**
 * NexDrop v1.4.7 cold-start splash.
 *
 * The branding is the supplied artwork (symbol + wordmark + tagline) rendered by
 * assets/splash/index.html, bundled in the APK so every launch is offline-safe.
 *
 * Advance path (all independent, all idempotent):
 *  1. onPageFinished -> openApp after MIN_DISPLAY_MS (animation not cut short)
 *  2. fail-safe timer armed in onCreate BEFORE the WebView exists, so a WebView
 *     construction/asset/JS failure can never trap the user on the splash
 *  3. any throwable during setup advances immediately
 * A process-wide [transitioned] flag makes the transition idempotent across
 * activity recreation (rotation) so MainActivity is never started twice.
 */
class SplashActivity : AppCompatActivity() {

  private val handler = Handler(Looper.getMainLooper())
  private var launched = false
  private var web: WebView? = null

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Armed first: nothing below this line can prevent the user reaching the app.
    handler.postDelayed({ openApp("fail-safe-4s") }, MAX_DISPLAY_MS)
    Log.i(TAG, "onCreate: fail-safe armed (${MAX_DISPLAY_MS}ms); transitioned=$transitioned")

    if (transitioned) {
      Log.i(TAG, "recreated after transition - advancing without re-showing splash")
      openApp("already-transitioned")
      return
    }

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
          override fun onReceivedError(v: WebView?, req: android.webkit.WebResourceRequest?, err: android.webkit.WebResourceError?) {
            Log.e(TAG, "onReceivedError: ${err?.errorCode} ${err?.description}")
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

  /** Advances to MainActivity exactly once per process, whatever the trigger. */
  private fun openApp(reason: String) {
    if (launched) {
      Log.i(TAG, "openApp($reason) ignored: already launched")
      return
    }
    launched = true
    transitioned = true
    handler.removeCallbacksAndMessages(null)
    Log.i(TAG, "openApp($reason): starting MainActivity (finishing=$isFinishing)")
    try {
      startActivity(Intent(this, MainActivity::class.java))
    } catch (t: Throwable) {
      // Never leave the user on a dead splash screen.
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
      // Destroying a live WebView inside onDestroy can throw and take the process
      // down while MainActivity is starting; defer it one frame.
      Handler(Looper.getMainLooper()).post {
        try { dying.destroy() } catch (t: Throwable) { Log.w(TAG, "WebView destroy failed", t) }
      }
    }
    Log.i(TAG, "onDestroy")
    super.onDestroy()
  }

  private companion object {
    const val TAG = "NexDropSplash"
    const val MIN_DISPLAY_MS = 1_450L
    const val MAX_DISPLAY_MS = 4_000L
    const val SPLASH_URL = "file:///android_asset/splash/index.html"

    /** Process-wide: true once MainActivity has been requested. */
    @Volatile var transitioned = false
  }
}
