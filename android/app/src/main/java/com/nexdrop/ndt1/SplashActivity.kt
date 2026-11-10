package com.nexdrop.ndt1

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

/**
 * NexDrop v1.4.7 cold-start splash.
 *
 * The branding is the supplied artwork (symbol + wordmark + tagline) rendered by
 * assets/splash/index.html, which scales with `contain` semantics inside a fixed
 * 228x488 stage: nothing is cropped, clipped or stretched at any phone size.
 * The window theme is white so the very first frame matches the splash instead
 * of flashing the dark app chrome.
 *
 * The splash is dismissed on the first page finish after MIN_DISPLAY_MS (so the
 * animation is not cut short on a fast device) and is hard-capped by
 * MAX_DISPLAY_MS so a WebView failure can never trap the user here.
 */
class SplashActivity : AppCompatActivity() {

  private val handler = Handler(Looper.getMainLooper())
  private var launched = false
  private lateinit var web: WebView

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    web = WebView(this).apply {
      setBackgroundColor(Color.WHITE)
      isVerticalScrollBarEnabled = false
      isHorizontalScrollBarEnabled = false
      overScrollMode = View.OVER_SCROLL_NEVER
      settings.javaScriptEnabled = true
      settings.mediaPlaybackRequiresUserGesture = false
      webViewClient = object : WebViewClient() {
        override fun onPageFinished(view: WebView?, url: String?) {
          super.onPageFinished(view, url)
          if (!launched) handler.postDelayed({ openApp() }, MIN_DISPLAY_MS)
        }
      }
    }
    setContentView(web, ViewGroup.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    web.loadUrl("file:///android_asset/splash/index.html")
    // Fail-safe: never keep the user on the splash if the page never finishes.
    handler.postDelayed({ openApp() }, MAX_DISPLAY_MS)
  }

  private fun openApp() {
    if (launched) return
    launched = true
    handler.removeCallbacksAndMessages(null)
    startActivity(Intent(this, MainActivity::class.java))
    finish()
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    web.destroy()
    super.onDestroy()
  }

  private companion object {
    const val MIN_DISPLAY_MS = 1_450L
    const val MAX_DISPLAY_MS = 4_000L
  }
}
