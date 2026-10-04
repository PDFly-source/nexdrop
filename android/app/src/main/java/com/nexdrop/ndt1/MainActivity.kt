package com.nexdrop.ndt1

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Space
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.res.ResourcesCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.nexdrop.ndt1.ui.BgView
import com.nexdrop.ndt1.ui.CheckCircleView
import com.nexdrop.ndt1.ui.D
import com.nexdrop.ndt1.ui.DashLineView
import com.nexdrop.ndt1.ui.GradientTextView
import com.nexdrop.ndt1.ui.HeroView
import com.nexdrop.ndt1.ui.PulseDotView
import com.nexdrop.ndt1.ui.RingView
import com.nexdrop.ndt1.ui.UiSpeed
import com.nexdrop.ndt1.ui.bigText
import com.nexdrop.ndt1.ui.body
import com.nexdrop.ndt1.ui.bottomNav
import com.nexdrop.ndt1.ui.btn
import com.nexdrop.ndt1.ui.col
import com.nexdrop.ndt1.ui.dp
import com.nexdrop.ndt1.ui.glassCard
import com.nexdrop.ndt1.ui.h1
import com.nexdrop.ndt1.ui.h2
import com.nexdrop.ndt1.ui.icBox
import com.nexdrop.ndt1.ui.pill
import com.nexdrop.ndt1.ui.row
import com.nexdrop.ndt1.ui.sm
import com.nexdrop.ndt1.ui.sub
import com.nexdrop.ndt1.ui.textView
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * NexDrop native UI — a 1:1 implementation of the eight screens in the
 * SINGLE SOURCE OF TRUTH ("NexDrop — Android App Mockup.html"):
 *   01 Welcome          02 Home            03 Send files
 *   04 Receive + QR     05 Incoming        06 Live transfer
 *   07 Complete         08 Your NexDrop
 * plus the bottom nav's Transfer / History / Settings tabs and the honest
 * failure/unavailable states.
 *
 * ONLY the UI layer changed. The verified NDT1 engine is untouched: QR
 * pairing, Accept/Decline, native TCP, TurboSender/TurboReceiver,
 * streaming, pause/resume, cancel, SHA-256, telemetry, PWA fallback.
 * Every name, size, byte count, percentage, speed, ETA, duration and
 * SHA status on screen comes from real engine state — no mock data.
 */
class MainActivity : AppCompatActivity(), TurboReceiver.Listener {

  private enum class Screen { WELCOME, HOME, SEND, RECEIVE, TRANSFER, RESULT, FAILED, UNAVAILABLE, DEVICES, HISTORY, SETTINGS, DEVICE_TEST }
  private enum class Role { NONE, SEND, RECEIVE }

  private var screen = Screen.HOME
  private var role = Role.NONE

  // ---- navigation stack (real Back history; tab hops + sub-screens all push) ----
  // Back NEVER cancels an active transfer; the engine callbacks (TRANSFER ->
  // RESULT/FAILED) clear the stack because the flow is finished.
  private val backStack = java.util.ArrayDeque<Screen>()

  /** Navigate forward, pushing the current screen onto the Back history. */
  private fun go(to: Screen) {
    backStack.addLast(screen)
    while (backStack.size > 32) backStack.removeFirst()
    screen = to; render()
  }

  /** Terminal/reset navigation (welcome done, transfer finished, back-to-home). */
  private fun goRoot(to: Screen) { backStack.clear(); screen = to; render() }

  /** Pop Back history; fall back to the hub (Home) when history is empty. */
  private fun goBack() {
    when (screen) {
      Screen.TRANSFER -> toast("Transfer in progress — use CANCEL to stop")
      Screen.RECEIVE -> { stopReceiving(); popOrHome() }
      else -> popOrHome()
    }
  }

  private fun popOrHome() {
    val prev = if (backStack.isEmpty()) null else backStack.removeLast()
    if (prev != null) { screen = prev; render() }
    else when (screen) {
      Screen.HOME, Screen.WELCOME -> { /* no history: system decides (exit) */ }
      else -> { screen = Screen.HOME; render() }
    }
  }

  /** Explicit "back to X" buttons: pop if history exists (real previous
   *  screen), otherwise reset to X. */
  private fun backOr(to: Screen) {
    val prev = if (backStack.isEmpty()) null else backStack.removeLast()
    if (prev != null) { screen = prev; render() } else goRoot(to)
  }

  // ---- root views ----
  private lateinit var root: FrameLayout
  private lateinit var content: LinearLayout
  private var qrView: ImageView? = null

  // ---- transfer state (engine) ----
  private var receiver: TurboReceiver? = null
  private var sender: TurboSender? = null
  private var transferStartNanos = 0L
  private var paused = false
  private var pendingPairing: QrPairing.Pairing? = null
  private var benchModeMiB: Int? = null
  private var localEndpoint: LocalNet.Endpoint? = null
  private var peerIp: String? = null
  private var currentFile: File? = null
  private var currentName: String? = null
  private var currentSize: Long = 0
  private var completedSha: String? = null
  private var completedStats: ThroughputSampler.Stats? = null
  private var transferGotFirstProgress = false

  // ---- send screen pick (real user selection) ----
  private var pendingUri: Uri? = null
  // ---- keep-screen-awake (real window flag, user preference) ----
  @Volatile private var transferActive = false

  private fun keepAwakePref(): Boolean =
    getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_KEEP_AWAKE, true)

  private fun applyKeepAwake() {
    if (transferActive && keepAwakePref()) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }
  private var qrExpiresAtMs: Long = 0
  private val ui = Handler(Looper.getMainLooper())
  private var ticker: Runnable? = null

  // ---- live-screen refs ----
  private var ring: RingView? = null
  private var ringPct: TextView? = null
  private var ringBytes: TextView? = null
  private var speedView: GradientTextView? = null
  private var speedUnitView: TextView? = null
  private var etaView: TextView? = null
  private var pauseBtn: View? = null

  // ---- activity result contracts (unchanged engine flow) ----
  private val scanQr = registerForActivityResult(ScanContract()) { result ->
    val contentQr = result.contents
    if (contentQr.isNullOrEmpty()) return@registerForActivityResult
    val pairing = QrPairing.decode(contentQr)
      ?: run { toast("Not a NexDrop QR"); return@registerForActivityResult }
    if (pairing.expired) { toast("QR expired — ask for a new one"); return@registerForActivityResult }
    val bench = benchModeMiB
    if (bench != null) runBenchmark(pairing, bench) else {
      val uri = pendingUri ?: run { toast("Pick a file first"); return@registerForActivityResult }
      sendPickedFile(uri, pairing)
    }
  }
  private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
    if (uri == null) return@registerForActivityResult
    try {
      contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
    } catch (_: Exception) { /* one-shot send doesn't need persistence */ }
    onFilePicked(uri)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.statusBarColor = D.BG
    window.navigationBarColor = D.BG
    val welcomed = getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_WELCOMED, false)
    screen = if (welcomed) Screen.HOME else Screen.WELCOME
    // Mockup navigation: BACK returns to Home from any sub-screen (Android
    // convention for a hub activity); it never loses an active transfer.
    // System Back follows the SAME stack as the on-screen back affordance:
    // history pop first, Home as the hub fallback, exit only from Home.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (backStack.isEmpty() && (screen == Screen.HOME || screen == Screen.WELCOME)) {
          isEnabled = false
          onBackPressedDispatcher.onBackPressed()
          isEnabled = true
        } else goBack()
      }
    })
    render()
  }

  override fun onDestroy() {
    ticker?.let { ui.removeCallbacks(it) }
    super.onDestroy()
  }

  // ================= rendering scaffold =================

  private fun render() {
    ticker?.let { ui.removeCallbacks(it); ticker = null }
    qrView = null; ring = null; ringPct = null; ringBytes = null; speedView = null; speedUnitView = null; etaView = null; pauseBtn = null
    pendingNav = null
    root = FrameLayout(this)
    root.addView(BgView(this), FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    content = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      val h = dp(10); val v = dp(16)
      setPadding(v, h, v, h)
    }
    when (screen) {
      Screen.WELCOME -> renderWelcome()
      Screen.HOME -> renderHome()
      Screen.SEND -> renderSend()
      Screen.RECEIVE -> renderReceive()
      Screen.TRANSFER -> renderTransfer()
      Screen.RESULT -> renderResult()
      Screen.FAILED -> renderFailed()
      Screen.UNAVAILABLE -> renderUnavailable()
      Screen.DEVICES -> renderYourNexDrop()
      Screen.HISTORY -> renderHistory()
      Screen.SETTINGS -> renderSettings()
      Screen.DEVICE_TEST -> renderDeviceTest()
    }
    val scroll = ScrollView(this).apply {
      isVerticalScrollBarEnabled = false
      addView(content, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
    val host: View = pendingNav?.let { active ->
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        addView(bottomNav(active) { tab ->
          go(when (tab) {
            0 -> Screen.HOME
            1 -> Screen.SEND
            2 -> Screen.DEVICES
            3 -> Screen.HISTORY
            else -> Screen.SETTINGS
          })
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
      }
    } ?: scroll
    root.addView(host, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    setContentView(root)
  }

  private fun screenTitle(text: String) {
    content.addView(h2(text).apply {
      val mt = dp(8); layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = mt }
    })
  }

  /** Top-left Back affordance: [ <- ] Title — 44dp touch target, follows the
   *  real Back stack (identical to system Back; never cancels a transfer). */
  private fun backHeader(title: String) {
    val r = row().apply {
      gravity = Gravity.CENTER_VERTICAL
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(6); bottomMargin = dp(4) }
    }
    val back = LinearLayout(this).apply {
      gravity = Gravity.CENTER
      layoutParams = LinearLayout.LayoutParams(dp(44), dp(44))
      setOnClickListener { goBack() }
      background = android.graphics.drawable.GradientDrawable().apply {
        cornerRadius = dp(14).toFloat()
        setColor(D.argb(26, D.PRIMARY))
        setStroke(dp(1), D.argb(64, D.PRIMARY))
      }
      addView(ImageView(this@MainActivity).apply {
        setImageResource(R.drawable.ic_back)
        imageTintList = android.content.res.ColorStateList.valueOf(D.TEXT)
        layoutParams = LinearLayout.LayoutParams(dp(20), dp(20))
        contentDescription = "Back"
      })
    }
    r.addView(back)
    r.addView(h2(title).apply {
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f }
      setPadding(dp(12), 0, 0, 0)
    })
    content.addView(r)
  }

  /** Which bottom-nav tab is active on this screen (null = no nav bar). */
  private var pendingNav: Int? = null
  private fun nav(active: Int) { pendingNav = active }

  // ================= 01 WELCOME =================
  private fun renderWelcome() {
    // Mockup Welcome screen stacks TWO marks: the small device-relay SVG
    // (unchanged — HeroView is a 1:1 port of that inline <svg>), then the
    // brand's actual glyph+wordmark+tagline art full-width underneath it
    // (<img src="${FULL}">in the mockup) — not a redrawn icon.
    content.addView(HeroView(this).apply {
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(90))
    })
    content.addView(android.widget.ImageView(this).apply {
      setImageResource(R.drawable.welcome_hero)
      adjustViewBounds = true
      scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
        topMargin = -dp(2)
      }
      contentDescription = "NexDrop — Private, Direct, Fast"
    })
    val title = col().apply { gravity = Gravity.CENTER_HORIZONTAL }
    listOf("Your files.", "Your devices.", "Directly.").forEach { line ->
      title.addView(h1(line, 27f).apply {
        gravity = Gravity.CENTER_HORIZONTAL
        setPadding(0, 0, 0, dp(1))
      })
    }
    content.addView(title)
    content.addView(sub("Transfer files directly between nearby devices without uploading them to the cloud.").apply {
      gravity = Gravity.CENTER
      setPadding(dp(8), dp(5), dp(8), 0)
    })
    content.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(1, 0).apply { weight = 1f } })
    content.addView(btn("GET STARTED", "primary", height = 50) {
      getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_WELCOMED, true).apply()
      goRoot(Screen.HOME)
    }.apply {
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(50))
    })
    content.addView(btn("Explore NexDrop", "text", height = 36) { openPwa() }.apply {
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(36))
    })
  }

  // ================= 02 HOME =================
  private fun renderHome() {
    val top = row()
    // Mockup Home header uses LOGO(24) -> the actual brand glyph image, not
    // a redrawn vector mark.
    top.addView(android.widget.ImageView(this).apply {
      setImageResource(R.drawable.logo_mark)
      adjustViewBounds = true
      scaleType = android.widget.ImageView.ScaleType.FIT_START
      layoutParams = LinearLayout.LayoutParams(dp(48), dp(24))
    })
    top.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(0, 1).apply { weight = 1f } })
    top.addView(statusPill(LocalNet.select(activeWifiInterface()) != null))
    content.addView(top.apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply {
        topMargin = dp(6); bottomMargin = dp(14)
      }
    })
    content.addView(h1("PRIVATE.").apply { layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { height = LinearLayout.LayoutParams.WRAP_CONTENT } })
    content.addView(h1("DIRECT."))
    content.addView(GradientTextView(this).apply {
      text = "FAST."
      setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 27f)
      typeface = com.nexdrop.ndt1.ui.Fonts.sora(this@MainActivity, 700)
      letterSpacing = -0.03f
      includeFontPadding = false
    })
    content.addView(sub("Move files directly between your devices.").apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { bottomMargin = dp(14) }
    })

    // SEND FILES / RECEIVE cards
    val cards = row().apply { gravity = Gravity.FILL }
    cards.addView(glassCard(glow = true, strokeColor = D.argb(77, D.PRIMARY), pad = 14f).apply {
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f; marginEnd = dp(5) }
      addView(icBox(R.drawable.ic_send, filledPrimary = true))
      val sp = Space(this@MainActivity); sp.layoutParams = LinearLayout.LayoutParams(1, 0).apply { weight = 1f }
      addView(sp)
      addView(textView("SEND FILES", 13f, D.TEXT, 700, 1))
      addView(sm("Choose files and send directly."))
      setOnClickListener { startSendFlow() }
    })
    cards.addView(glassCard(pad = 14f).apply {
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f; marginStart = dp(5) }
      addView(icBox(R.drawable.ic_down, tint = D.BLUE))
      val sp = Space(this@MainActivity); sp.layoutParams = LinearLayout.LayoutParams(1, 0).apply { weight = 1f }
      addView(sp)
      addView(textView("RECEIVE", 13f, D.TEXT, 700, 1))
      addView(sm("Receive from a nearby device."))
      setOnClickListener { startReceiving() }
    })
    content.addView(cards)

    // SEND TEXT / RECEIVE TEXT row
    val textRow = row().apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(10) }
    }
    textRow.addView(glassCard(pad = 10f).apply {
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f; marginEnd = dp(5) }
      orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
      addView(ImageView(this@MainActivity).apply {
        setImageResource(R.drawable.ic_txt)
        imageTintList = android.content.res.ColorStateList.valueOf(D.PRIMARY)
        layoutParams = LinearLayout.LayoutParams(dp(20), dp(20))
      })
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(8), 1) })
      addView(textView("SEND TEXT", 12f, D.TEXT, 700, 1))
      setOnClickListener { sendTextFlow() }
    })
    textRow.addView(glassCard(pad = 10f).apply {
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f; marginStart = dp(5) }
      orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
      addView(ImageView(this@MainActivity).apply {
        setImageResource(R.drawable.ic_down)
        imageTintList = android.content.res.ColorStateList.valueOf(D.PRIMARY)
        layoutParams = LinearLayout.LayoutParams(dp(20), dp(20))
      })
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(8), 1) })
      addView(textView("RECEIVE TEXT", 12f, D.TEXT, 700, 1))
      setOnClickListener { startReceiving() }
    })
    content.addView(textRow)

    // LOCAL DIRECT status card (real state)
    val ep = LocalNet.select(activeWifiInterface())
    val status = glassCard(pad = 14f).apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(10) }
      orientation = LinearLayout.HORIZONTAL
      addView(icBox(R.drawable.ic_wifi))
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
      val t = col().apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f } }
      t.addView(textView("LOCAL DIRECT", 13f, D.TEXT, 700, 1))
      t.addView(sm(if (ep != null) "Native Android · NDT1 TCP" else LocalNet.unavailableText()))
      addView(t)
      if (ep != null) {
        addView(PulseDotView(this@MainActivity).apply {
          layoutParams = LinearLayout.LayoutParams(dp(7), dp(7))
        })
        addView(sm("Ready").apply { setTextColor(D.OK); setPadding(dp(6), 0, 0, 0) })
      } else {
        addView(pill("NATIVE LOCAL UNAVAILABLE", tint = D.AMBER))
        setOnClickListener { go(Screen.UNAVAILABLE) }
      }
    }
    content.addView(status)
    nav(0)
  }

  /** "Local ready" pill with the pulsing dot inside. */
  private fun statusPill(ready: Boolean): View {
    return LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      background = android.graphics.drawable.GradientDrawable().apply {
        cornerRadius = dp(99).toFloat()
        setColor(D.argb(26, if (ready) D.PRIMARY else D.AMBER))
        setStroke(dp(1), D.argb(64, if (ready) D.PRIMARY else D.AMBER))
      }
      val h = dp(5); val v = dp(11)
      setPadding(v, h, v, h)
      addView(PulseDotView(context, if (ready) D.OK else D.AMBER).apply {
        layoutParams = LinearLayout.LayoutParams(dp(7), dp(7))
      })
      addView(Space(context).apply { layoutParams = LinearLayout.LayoutParams(dp(6), 1) })
      addView(textView(if (ready) "Local ready" else "No local net", 11.5f,
        if (ready) D.PRIMARY else D.AMBER, 700, 1, 0.02f))
    }
  }

  // ================= 03 SEND FILES =================
  private fun startSendFlow() {
    benchModeMiB = null
    go(Screen.SEND)
  }

  private fun onFilePicked(uri: Uri) {
    val name = queryName(uri) ?: "file"
    val size = querySize(uri)
    if (size <= 0) { toast("Cannot read that file"); return }
    pendingUri = uri
    currentName = name
    currentSize = size
    if (screen == Screen.SEND) render() else { screen = Screen.SEND; render() }
  }

  private fun renderSend() {
    backHeader("Send files")
    content.addView(sub("Choose what you want to transfer."))

    // dashed drop zone
    content.addView(glassCard(dashed = true, pad = 22f, radius = 22f).apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply {
        topMargin = dp(14); bottomMargin = dp(10)
      }
      gravity = Gravity.CENTER_HORIZONTAL
      val cir = LinearLayout(this@MainActivity).apply {
        gravity = Gravity.CENTER
        layoutParams = LinearLayout.LayoutParams(dp(48), dp(48))
        background = android.graphics.drawable.GradientDrawable().apply {
          shape = android.graphics.drawable.GradientDrawable.OVAL
          setColor(D.argb(31, D.PRIMARY))
        }
        addView(ImageView(this@MainActivity).apply {
          setImageResource(R.drawable.ic_plus)
          imageTintList = android.content.res.ColorStateList.valueOf(D.PRIMARY)
          layoutParams = LinearLayout.LayoutParams(dp(24), dp(24))
        })
      }
      addView(cir)
      addView(textView("Select files", 14f, D.TEXT, 700, 1).apply { setPadding(0, dp(8), 0, 0) })
      addView(sm("Browse your device"))
      setOnClickListener { pickFile.launch(arrayOf("*/*")) }
    })

    // category chips
    val chips = row().apply {
      gravity = Gravity.CENTER
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(6) }
    }
    listOf(
      Triple(R.drawable.ic_img, "Images", "image/*"),
      Triple(R.drawable.ic_vid, "Videos", "video/*"),
      Triple(R.drawable.ic_doc, "Docs", "application/*"),
      Triple(R.drawable.ic_app, "Apps", "application/vnd.android.package-archive"),
      Triple(R.drawable.ic_more, "Other", "*/*"),
    ).forEach { (icon, label, mime) ->
      val chip = col().apply {
        gravity = Gravity.CENTER_HORIZONTAL
        setOnClickListener { pickFile.launch(arrayOf(mime)) }
      }
      chip.addView(icBox(icon, size = 42))
      chip.addView(sm(label).apply {
        setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 10.5f)
        setPadding(0, dp(5), 0, 0)
      })
      chips.addView(chip.apply {
        layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f }
      })
    }
    content.addView(chips)

    // real selection state
    val sel = pendingUri
    content.addView(sm(if (sel != null) "1 file selected" else "No file selected").apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(16); bottomMargin = dp(6) }
    })
    if (sel != null) {
      content.addView(fileCard(currentName ?: "file", SpeedFormat.bytesText(currentSize), "Ready"))
    }

    // LOCAL DIRECT row (real)
    val ep = LocalNet.select(activeWifiInterface())
    val localRow = row().apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(12); bottomMargin = dp(10) }
    }
    localRow.addView(PulseDotView(this, if (ep != null) D.OK else D.AMBER).apply {
      layoutParams = LinearLayout.LayoutParams(dp(7), dp(7))
    })
    localRow.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
    val lt = col()
    lt.addView(textView("LOCAL DIRECT", 12f, D.TEXT, 700, 1))
    lt.addView(sm(if (ep != null) "Native transfer available" else "No local network — see PWA fallback"))
    localRow.addView(lt)
    content.addView(localRow)

    // fill + CONTINUE
    content.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(1, 0).apply { weight = 1f } })
    content.addView(btn("CONTINUE", "primary") {
      val uri = pendingUri
      if (uri == null) { toast("Select a file first"); return@btn }
      if (!hasPermission(Manifest.permission.CAMERA)) { askPermission(Manifest.permission.CAMERA, REQ_CAMERA); return@btn }
      launchScan("Scan the receiver's NexDrop QR")
    }.apply { layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(50)) })
  }

  private fun fileCard(name: String, size: String, statusLabel: String): View {
    return glassCard(pad = 14f).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      addView(icBox(R.drawable.ic_file))
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
      val t = col().apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f } }
      t.addView(textView(name, 13f, D.TEXT, 700).apply {
        layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { bottomMargin = dp(2) }
        maxLines = 2
        ellipsize = android.text.TextUtils.TruncateAt.END
      })
      t.addView(sm(size))
      addView(t)
      addView(pill(statusLabel, tint = if (statusLabel == "Ready") D.OK else D.PRIMARY))
    }
  }

  // ================= 04 RECEIVE + QR =================
  private fun startReceiving() {
    val endpoint = LocalNet.select(activeWifiInterface())
    if (endpoint == null) { screen = Screen.UNAVAILABLE; render(); return }
    val session = Handshake.newSessionToken()
    val dl = File(getExternalFilesDir(null) ?: filesDir, "downloads").apply { mkdirs() }
    receiver = TurboReceiver(session, dl, this)
    val port = try { receiver!!.start(0, endpoint.ip) } catch (e: Exception) {
      screen = Screen.UNAVAILABLE; render(); return
    }
    localEndpoint = endpoint.copy(port = port)
    peerIp = null
    role = Role.RECEIVE
    qrExpiresAtMs = System.currentTimeMillis() + Ndt1.AUTH_TTL_MS
    screen = Screen.RECEIVE
    render()
    showQr(QrPairing.encode(session, endpoint.ip, port, Build.MODEL))
    if (Build.VERSION.SDK_INT >= 33 && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
      askPermission(Manifest.permission.POST_NOTIFICATIONS, REQ_NOTIF)
    }
    TransferService.start(this, "Waiting for sender…")
  }

  private fun renderReceive() {
    val ep = localEndpoint ?: run { screen = Screen.UNAVAILABLE; render(); return }
    screenTitle("Receive")
    content.addView(sub("Let another device scan this QR."))

    // QR presentation: .card.g > .qrw (white, radius 18, padding 12, teal glow)
    content.addView(glassCard(glow = true, strokeColor = D.argb(77, D.PRIMARY), pad = 16f).apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(14); bottomMargin = dp(10) }
      // white QR plate with the teal glow ring
      val plate = FrameLayout(this@MainActivity).apply {
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        setPadding(dp(5), dp(5), dp(5), dp(5))
        background = android.graphics.drawable.GradientDrawable().apply {
          cornerRadius = dp(23).toFloat()
          setColor(D.argb(56, D.PRIMARY)) // 0 0 0 5px rgba(24,214,197,.22)
          setStroke(dp(5), D.argb(0, D.PRIMARY))
        }
        elevation = dp(8).toFloat()
        if (Build.VERSION.SDK_INT >= 28) {
          outlineAmbientShadowColor = D.argb(89, D.PRIMARY) // 0 0 46px rgba(24,214,197,.35)
          outlineSpotShadowColor = D.argb(89, D.PRIMARY)
        }
      }
      val white = FrameLayout(this@MainActivity).apply {
        layoutParams = FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        background = android.graphics.drawable.GradientDrawable().apply {
          cornerRadius = dp(18).toFloat()
          setColor(Color.WHITE)
        }
        setPadding(dp(12), dp(12), dp(12), dp(12))
        val iv = ImageView(this@MainActivity).apply {
          setBackgroundColor(Color.WHITE)
          contentDescription = "NexDrop pairing QR"
          scaleType = ImageView.ScaleType.FIT_CENTER
          layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(220))
        }
        qrView = iv
        addView(iv)
        // center logo badge: 44px dark rounded box, 3px white border
        val badge = FrameLayout(this@MainActivity).apply {
          val size = dp(44)
          layoutParams = FrameLayout.LayoutParams(size, size, Gravity.CENTER)
          background = android.graphics.drawable.GradientDrawable().apply {
            cornerRadius = dp(12).toFloat()
            setColor(D.BG)
            setStroke(dp(3), Color.WHITE)
          }
          clipToOutline = true
          // Mockup QR center badge uses LOGO(18) -> same brand glyph image.
          addView(android.widget.ImageView(this@MainActivity).apply {
            setImageResource(R.drawable.logo_mark)
            adjustViewBounds = true
            scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
            layoutParams = FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER)
          })
        }
        addView(badge)
      }
      plate.addView(white)
      addView(plate)
    })

    // LOCAL DIRECT row
    val localRow = row().apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(12) }
    }
    localRow.addView(icBox(R.drawable.ic_wifi))
    localRow.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
    val lt = col()
    lt.addView(textView("LOCAL DIRECT", 13f, D.TEXT, 700, 1))
    lt.addView(sm("Native Android · Wi-Fi / Hotspot"))
    localRow.addView(lt)
    content.addView(localRow)

    // waiting row with REAL expiry
    val waitRow = row().apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(10) }
    }
    waitRow.addView(PulseDotView(this).apply { layoutParams = LinearLayout.LayoutParams(dp(7), dp(7)) })
    waitRow.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(6), 1) })
    val waitLabel = textView("Waiting for device", 12.5f, D.OK, 600)
    waitRow.addView(waitLabel)
    waitRow.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(0, 1).apply { weight = 1f } })
    val expLabel = sm("Expires —")
    waitRow.addView(expLabel)
    content.addView(waitRow)

    val t: Runnable = object : Runnable {
      override fun run() {
        val left = qrExpiresAtMs - System.currentTimeMillis()
        if (left <= 0) {
          waitLabel.text = "Pairing expired"
          waitLabel.setTextColor(D.AMBER)
          expLabel.text = "Refresh QR"
        } else {
          val fmt = SimpleDateFormat("HH:mm", Locale.getDefault())
          expLabel.text = "Expires ${fmt.format(Date(qrExpiresAtMs))} (${left / 60000}:${"%02d".format((left % 60000) / 1000)})"
          ui.postDelayed(this, 1000)
        }
      }
    }
    ticker = t
    ui.post(t)

    // fill + buttons
    content.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(1, 0).apply { weight = 1f } })
    val btns = row()
    btns.addView(btn("REFRESH QR", "outline", icon = R.drawable.ic_swap) {
      stopReceiving(); startReceiving()
    })
    btns.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
    btns.addView(btn("Details", "text", height = 50, weight = 0.6f) { showReceiveDetails() })
    content.addView(btns)
  }

  private fun showReceiveDetails() {
    val ep = localEndpoint ?: return
    val text = LocalNet.diagnostics(ep, reachable = "YES — LocalNet selector", peerIp = peerIp) +
      "\nInternet: NOT REQUIRED — your files never leave this network"
    val box = col().apply { setPadding(dp(16), dp(16), dp(16), dp(16)) }
    box.addView(body("LOCAL DIRECT — pairing details"))
    box.addView(sm(text).apply { setPadding(0, dp(8), 0, 0) })
    AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog)
      .setView(box)
      .setPositiveButton("Close", null)
      .show()
  }

  // ================= 05 INCOMING (bottom sheet) =================
  private fun onOfferUi(offer: Offer, decide: (Boolean) -> Unit) {
    val dim = View(this).apply { setBackgroundColor((0x8C000000L).toInt()) } // rgba(0,0,0,.55)
    val sheet = col().apply {
      val m = dp(0)
      setPadding(dp(18), dp(12), dp(18), dp(6))
      background = android.graphics.drawable.GradientDrawable().apply {
        cornerRadii = floatArrayOf(dp(28).toFloat(), dp(28).toFloat(), dp(28).toFloat(), dp(28).toFloat(), 0f, 0f, 0f, 0f)
        setColor(D.SURFACE)
      }
      elevation = dp(12).toFloat()
      clipToOutline = true
    }
    val handle = View(this).apply {
      layoutParams = LinearLayout.LayoutParams(dp(36), dp(4))
      setBackgroundColor(0xFF3A4454.toInt())
      (layoutParams as LinearLayout.LayoutParams).gravity = Gravity.CENTER_HORIZONTAL
    }
    sheet.addView(handle)
    val head = col().apply {
      gravity = Gravity.CENTER_HORIZONTAL
      setPadding(0, dp(12), 0, 0)
    }
    head.addView(icBox(R.drawable.ic_shield, size = 50).apply {
      (layoutParams as LinearLayout.LayoutParams).gravity = Gravity.CENTER_HORIZONTAL
      background = android.graphics.drawable.GradientDrawable().apply {
        cornerRadius = dp(16).toFloat(); setColor(D.argb(31, D.PRIMARY))
        setStroke(dp(1), D.argb(51, D.PRIMARY))
      }
    })
    head.addView(h2("Incoming transfer").apply {
      gravity = Gravity.CENTER; setPadding(0, dp(8), 0, 0)
    })
    head.addView(sm("from Nearby Android device"))
    sheet.addView(head)

    sheet.addView(glassCard(pad = 14f).apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(12) }
      background = GlassSurface()
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      addView(icBox(R.drawable.ic_file).apply {
        background = android.graphics.drawable.GradientDrawable().apply {
          cornerRadius = dp(13).toFloat(); setColor(D.SURFACE)
          setStroke(dp(1), D.LINE)
        }
      })
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
      val t = col().apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f } }
      t.addView(textView(offer.name, 13f, D.TEXT, 700).apply {
        maxLines = 2
        ellipsize = android.text.TextUtils.TruncateAt.END
      })
      t.addView(bigText(SpeedFormat.bytesText(offer.sizeBytes), 22f).apply {
        setPadding(0, dp(3), 0, 0)
      })
      addView(t)
    })

    val shaRow = row().apply { setPadding(0, dp(12), 0, 0) }
    shaRow.addView(ImageView(this).apply {
      setImageResource(R.drawable.ic_shield)
      imageTintList = android.content.res.ColorStateList.valueOf(D.MUTED)
      layoutParams = LinearLayout.LayoutParams(dp(20), dp(20))
    })
    shaRow.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(6), 1) })
    shaRow.addView(textView("SHA-256 verification enabled", 12.5f, D.OK, 600))
    sheet.addView(shaRow)

    val transportRow = row()
    transportRow.addView(ImageView(this).apply {
      setImageResource(R.drawable.ic_wifi)
      imageTintList = android.content.res.ColorStateList.valueOf(D.MUTED)
      layoutParams = LinearLayout.LayoutParams(dp(20), dp(20))
    })
    transportRow.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
    transportRow.addView(sm("Transport"))
    transportRow.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(0, 1).apply { weight = 1f } })
    transportRow.addView(pill("LOCAL DIRECT"))
    sheet.addView(transportRow)

    val btns = row().apply { setPadding(0, dp(12), 0, dp(6)) }
    btns.addView(btn("DECLINE", "outline") { decide(false) })
    btns.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
    btns.addView(btn("ACCEPT", "primary", weight = 1.4f) { decide(true) })
    sheet.addView(btns)

    // Sheet bottom-anchored INSIDE a ScrollView: when a long filename / large
    // font scale makes the sheet taller than the screen, it scrolls instead of
    // clipping the offer details off the top. Accept/Decline stay reachable.
    val sheetScroll = ScrollView(this).apply {
      isVerticalScrollBarEnabled = false
      addView(sheet, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
    root.addView(dim, FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    root.addView(sheetScroll, FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
  }

  private fun GlassSurface(): android.graphics.drawable.GradientDrawable =
    android.graphics.drawable.GradientDrawable().apply {
      cornerRadius = dp(22).toFloat()
      setColor(D.ELEVATED)
      setStroke(dp(1), D.LINE)
    }

  // ================= 06 LIVE TRANSFER =================
  private fun renderTransfer() {
    val headRow = row().apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(6) }
    }
    headRow.addView(h2(if (role == Role.RECEIVE) "Receiving…" else "Sending…").apply {
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f }
    })
    headRow.addView(LinearLayout(this).apply {
      gravity = Gravity.CENTER_VERTICAL
      background = android.graphics.drawable.GradientDrawable().apply {
        cornerRadius = dp(99).toFloat(); setColor(D.argb(26, D.PRIMARY)); setStroke(dp(1), D.argb(64, D.PRIMARY))
      }
      val h = dp(5); val v = dp(11)
      setPadding(v, h, v, h)
      addView(PulseDotView(context).apply { layoutParams = LinearLayout.LayoutParams(dp(7), dp(7)) })
      addView(Space(context).apply { layoutParams = LinearLayout.LayoutParams(dp(6), 1) })
      addView(textView("Direct", 11.5f, D.PRIMARY, 700, 1))
    })
    content.addView(headRow)
    content.addView(sm(currentName ?: "file").apply { setPadding(0, dp(4), 0, 0) })

    // ring + center stats
    val ringWrap = FrameLayout(this).apply {
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(160))
      val r = RingView(context).apply {
        layoutParams = FrameLayout.LayoutParams(dp(150), dp(150), Gravity.CENTER)
      }
      ring = r
      addView(r)
      val center = col().apply {
        gravity = Gravity.CENTER
        layoutParams = FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER)
      }
      ringPct = bigText("0%", 34f).apply { gravity = Gravity.CENTER }
      center.addView(ringPct)
      ringBytes = sm("0 MiB\nof 0 MiB").apply { gravity = Gravity.CENTER }
      center.addView(ringBytes)
      addView(center)
    }
    content.addView(ringWrap)

    // big gradient speed + ETA
    val speedRow = row().apply { gravity = Gravity.CENTER }
    speedRow.addView(GradientTextView(this).apply {
      text = "0"
      setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 40f)
      typeface = com.nexdrop.ndt1.ui.Fonts.sora(this@MainActivity, 700)
      letterSpacing = -0.04f
      includeFontPadding = false
    }.also { speedView = it })
    speedRow.addView(textView(" MB/s", 16f, D.TEXT, 700, 1).apply {
      setPadding(dp(2), 0, 0, dp(4))
    }.also { speedUnitView = it })
    val speedCol = col().apply { gravity = Gravity.CENTER_HORIZONTAL }
    speedCol.addView(speedRow)
    etaView = sm("ETA —").apply { gravity = Gravity.CENTER; setPadding(0, dp(4), 0, 0) }
    speedCol.addView(etaView)
    content.addView(speedCol)

    // device-to-device dashed link
    content.addView(glassCard(pad = 10f).apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply {
        topMargin = dp(12); bottomMargin = dp(8)
      }
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(14), dp(10), dp(14), dp(10))
      addView(ImageView(this@MainActivity).apply {
        setImageResource(R.drawable.ic_dev)
        imageTintList = android.content.res.ColorStateList.valueOf(D.PRIMARY)
        layoutParams = LinearLayout.LayoutParams(dp(20), dp(20))
      })
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(8), 1) })
      addView(DashLineView(this@MainActivity, D.argb(153, D.PRIMARY)).apply {
        layoutParams = LinearLayout.LayoutParams(0, dp(2)).apply { weight = 1f }
      })
      addView(PulseDotView(this@MainActivity, D.PRIMARY).apply {
        layoutParams = LinearLayout.LayoutParams(dp(7), dp(7))
      })
      addView(DashLineView(this@MainActivity, D.argb(102, D.BLUE)).apply {
        layoutParams = LinearLayout.LayoutParams(0, dp(2)).apply { weight = 1f }
      })
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(8), 1) })
      addView(ImageView(this@MainActivity).apply {
        setImageResource(R.drawable.ic_dev)
        imageTintList = android.content.res.ColorStateList.valueOf(D.BLUE)
        layoutParams = LinearLayout.LayoutParams(dp(20), dp(20))
      })
    })

    // LOCAL DIRECT + SHA-256 row
    val infoRow = row().apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(4) }
    }
    val left = col()
    left.addView(textView("LOCAL DIRECT", 12.5f, D.TEXT, 700, 1))
    left.addView(sm("Native NDT1 TCP"))
    infoRow.addView(left)
    infoRow.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(0, 1).apply { weight = 1f } })
    infoRow.addView(ImageView(this).apply {
      setImageResource(R.drawable.ic_shield)
      imageTintList = android.content.res.ColorStateList.valueOf(D.MUTED)
      layoutParams = LinearLayout.LayoutParams(dp(20), dp(20))
    })
    infoRow.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(6), 1) })
    val right = col()
    right.addView(textView("SHA-256", 12f, D.TEXT, 700))
    right.addView(sm("Verifying"))
    infoRow.addView(right)
    content.addView(infoRow)

    // fill + PAUSE / CANCEL
    content.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(1, 0).apply { weight = 1f } })
    val controls = row().apply { (layoutParams as LinearLayout.LayoutParams).bottomMargin = dp(8) }
    controls.addView(btn(if (paused) "RESUME" else "PAUSE", "outline", icon = R.drawable.ic_pause) {
      paused = !paused
      if (paused) { receiver?.pause(); sender?.pause() } else { receiver?.resume(); sender?.resume() }
      render() // relabel PAUSE/RESUME from real state; ring refs rebind, engine untouched
    }.also { pauseBtn = it })
    controls.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
    controls.addView(btn("CANCEL", "outline", icon = R.drawable.ic_x, tintText = D.DANGER) {
      receiver?.cancel(); sender?.cancel()
      hideTransferUi()
      TransferService.stop(this)
      toast("Transfer cancelled")
      screen = Screen.HOME; render()
    })
    content.addView(controls)
  }

  // ================= 07 COMPLETE =================
  private fun renderResult() {
    content.addView(CheckCircleView(this).apply {
      layoutParams = LinearLayout.LayoutParams(dp(84), dp(84)).apply {
        gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(12); bottomMargin = dp(14)
      }
    })
    val head = col().apply { gravity = Gravity.CENTER_HORIZONTAL }
    head.addView(h2("Transfer complete"))
    head.addView(textView(currentName ?: "file", 13f, D.TEXT, 700).apply {
      gravity = Gravity.CENTER; setPadding(0, dp(6), 0, 0)
    })
    val bytes = currentFile?.length() ?: currentSize
    head.addView(sm(if (bytes > 0) "${SpeedFormat.bytesText(bytes)} transferred" else "").apply { gravity = Gravity.CENTER })
    content.addView(head)

    // Average + Duration (real stats)
    val stats = completedStats
    val statRow = row().apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply {
        topMargin = dp(14); bottomMargin = dp(8)
      }
    }
    statRow.addView(glassCard(pad = 14f).apply {
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f; marginEnd = dp(5) }
      addView(sm("Average"))
      addView(bigText(UiSpeed.speedText(stats?.averageBps), 20f).apply { setPadding(0, dp(3), 0, 0) })
    })
    statRow.addView(glassCard(pad = 14f).apply {
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f; marginStart = dp(5) }
      addView(sm("Duration"))
      addView(bigText(UiSpeed.durationText(stats?.durationMs ?: 0), 20f).apply { setPadding(0, dp(3), 0, 0) })
    })
    content.addView(statRow)

    // verified card — real transport + verification facts
    content.addView(glassCard(pad = 12f).apply {
      fun infoRow(icon: Int, main: TextView, subView: TextView): View {
        val r = row()
        r.addView(ImageView(this@MainActivity).apply {
          setImageResource(icon)
          imageTintList = android.content.res.ColorStateList.valueOf(if (icon == R.drawable.ic_shield) D.OK else D.MUTED)
          layoutParams = LinearLayout.LayoutParams(dp(20), dp(20))
        })
        r.addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(6), 1) })
        val t = col()
        t.addView(main)
        t.addView(subView)
        r.addView(t)
        return r
      }
      addView(infoRow(R.drawable.ic_shield,
        textView("SHA-256 VERIFIED", 12.5f, D.OK, 700, 1), sm("")))
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(1, dp(8)) })
      addView(infoRow(R.drawable.ic_dev,
        textView("", 12.5f, D.TEXT, 700).apply { text = if (role == Role.SEND) "Android → Android" else "Android → Android" },
        sm("")))
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(1, dp(8)) })
      addView(infoRow(R.drawable.ic_wifi,
        textView("LOCAL DIRECT · Native NDT1 TCP", 12.5f, D.MUTED, 600), sm("")))
    })

    // buttons
    content.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(1, 0).apply { weight = 1f } })
    val btns = row()
    val f = currentFile
    if (f != null) btns.addView(btn("OPEN FILE", "outline") { openFile(f) })
    else btns.addView(btn("OPEN FILE", "outline") { toast("Nothing to open on this device") })
    btns.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
    btns.addView(btn("DONE", "primary") { goRoot(Screen.HOME) })
    content.addView(btns)
    content.addView(btn(if (role == Role.SEND) "KEEP SENDING" else "KEEP RECEIVING", "text", height = 36) {
      screen = if (role == Role.SEND) Screen.SEND else { startReceiving(); return@btn }
      render()
    }.apply {
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(36))
      setPadding(0, dp(2), 0, dp(2))
    })
  }

  // ================= 08 YOUR NEXDROP =================
  private fun renderYourNexDrop() {
    content.addView(h2("Your NexDrop").apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(8); bottomMargin = dp(10) }
    })
    val connected = peerIp != null
    content.addView(glassCard(glow = true, strokeColor = D.argb(77, D.PRIMARY)).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      addView(icBox(R.drawable.ic_dev))
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
      val t = col().apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f } }
      t.addView(textView("Nearby device", 13f, D.TEXT, 700))
      t.addView(sm( if (connected) "Connected" else "Not connected").apply {
        setTextColor(if (connected) D.OK else D.MUTED)
      })
      addView(t)
      addView(pill("LOCAL DIRECT"))
    })

    // Recent transfers — REAL history, newest first
    val history = HistoryStore.list(this).sortedByDescending { it.atMs }
    content.addView(sm("Recent transfers").apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(14); bottomMargin = dp(6) }
    })
    content.addView(glassCard(pad = 12f).apply {
      if (history.isEmpty()) {
        addView(sm("No transfers yet"))
      } else history.take(3).forEachIndexed { i, e ->
        addView(historyRow(e))
        if (i < 2 && i < history.size - 1) addView(
          Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(1, dp(6)) })
      }
    })

    // Settings list (real states / real actions)
    content.addView(sm("Settings").apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(14); bottomMargin = dp(6) }
    })
    content.addView(glassCard(pad = 12f).apply {
      val localOk = LocalNet.select(activeWifiInterface()) != null
      fun setting(icon: Int, label: String, value: String, action: (() -> Unit)? = null) {
        val r = row().apply { setPadding(0, dp(2), 0, dp(2)) }
        r.addView(ImageView(this@MainActivity).apply {
          setImageResource(icon)
          imageTintList = android.content.res.ColorStateList.valueOf(D.PRIMARY)
          layoutParams = LinearLayout.LayoutParams(dp(20), dp(20))
        })
        r.addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(6), 1) })
        r.addView(textView(label, 12.5f, D.TEXT, 500).apply {
          layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f }
        })
        r.addView(sm(value))
        action?.let { a -> r.setOnClickListener { a() } }
        addView(r)
        addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(1, dp(7)) })
      }
      setting(R.drawable.ic_wifi, "Native Local", if (localOk) "On" else "Unavailable") { if (localOk) go(Screen.DEVICES) else go(Screen.UNAVAILABLE) }
      setting(R.drawable.ic_swap, "PWA fallback", "Auto") { openPwa() }
      setting(R.drawable.ic_shield, "SHA-256 verification", "On")
      setting(R.drawable.ic_bell, "Notifications", if (Build.VERSION.SDK_INT >= 33 && hasPermission(Manifest.permission.POST_NOTIFICATIONS)) "On" else "Tap to allow") {
        if (Build.VERSION.SDK_INT >= 33) askPermission(Manifest.permission.POST_NOTIFICATIONS, REQ_NOTIF)
      }
      setting(R.drawable.ic_sun, "Appearance", "Dark")
      setting(R.drawable.ic_spd, "Diagnostics", "Open") { go(Screen.DEVICE_TEST) }
    })
    nav(2)
  }

  private fun historyRow(e: HistoryStore.Entry): View {
    val r = row()
    r.addView(ImageView(this).apply {
      setImageResource(R.drawable.ic_check)
      imageTintList = android.content.res.ColorStateList.valueOf(D.OK)
      layoutParams = LinearLayout.LayoutParams(dp(20), dp(20))
    })
    r.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(8), 1) })
    r.addView(textView(e.name, 13f, D.TEXT, 700).apply {
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f }
      maxLines = 2
      ellipsize = android.text.TextUtils.TruncateAt.END
    })
    val right = col().apply { gravity = Gravity.END }
    right.addView(textView(SpeedFormat.bytesText(e.bytes), 12f, D.TEXT, 600).apply { gravity = Gravity.END })
    right.addView(sm(HistoryStore.dayLabel(e.atMs)).apply {
      gravity = Gravity.END; setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 10.5f)
    })
    r.addView(right)
    return r
  }

  // ================= HISTORY (tab) =================
  private fun renderHistory() {
    screenTitle("History")
    content.addView(sub("Completed transfers on this device."))
    val history = HistoryStore.list(this).sortedByDescending { it.atMs }
    content.addView(sm(if (history.isEmpty()) "No transfers yet" else "${history.size} transfers").apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(12); bottomMargin = dp(6) }
    })
    if (history.isEmpty()) {
      content.addView(glassCard().apply { addView(sm("Transfers you complete will appear here.")) })
    } else {
      content.addView(glassCard(pad = 12f).apply {
        history.forEachIndexed { i, e ->
          addView(historyRow(e))
          if (i < history.size - 1) addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(1, dp(7)) })
        }
      })
    }
    nav(3)
  }

  /** Settings row INSIDE a glass card: icon + label + live value (+ optional action). */
  private fun srow(card: LinearLayout, icon: Int, label: String, value: String, action: (() -> Unit)? = null) {
    val r = row().apply { setPadding(0, dp(2), 0, dp(2)) }
    r.addView(ImageView(this).apply {
      setImageResource(icon)
      imageTintList = android.content.res.ColorStateList.valueOf(D.PRIMARY)
      layoutParams = LinearLayout.LayoutParams(dp(20), dp(20))
    })
    r.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(8), 1) })
    r.addView(textView(label, 12.5f, D.TEXT, 500).apply {
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f }
    })
    r.addView(sm(value).apply { gravity = Gravity.END })
    action?.let { a -> r.setOnClickListener { a() } }
    card.addView(r)
    card.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(1, dp(7)) })
  }

  // ================= SETTINGS (tab, engineering behind Device Test) =================
  private fun renderSettings() {
    screenTitle("Settings")
    val localOk = LocalNet.select(activeWifiInterface()) != null
    val notifOn = Build.VERSION.SDK_INT < 33 || hasPermission(Manifest.permission.POST_NOTIFICATIONS)

    fun section(label: String) {
      content.addView(sm(label).apply {
        setTextColor(D.MUTED)
        letterSpacing = 0.10f
        layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(14); bottomMargin = dp(6) }
      })
    }

    section("CONNECTION")
    content.addView(glassCard(pad = 12f).apply {
      srow(this, R.drawable.ic_wifi, "Native Local", if (localOk) "On" else "Unavailable") { if (localOk) go(Screen.DEVICES) else go(Screen.UNAVAILABLE) }
      srow(this, R.drawable.ic_swap, "PWA fallback", "Auto") { openPwa() }
      srow(this, R.drawable.ic_swap, "Preferred transport", "Auto — NDT1 → PWA")
      srow(this, R.drawable.ic_dev, "Connection status", if (peerIp != null) "Connected" else "Not connected")
    })

    section("TRANSFER")
    content.addView(glassCard(pad = 12f).apply {
      srow(this, R.drawable.ic_shield, "SHA-256 verification", "On — streamed + verified")
      srow(this, R.drawable.ic_hist, "Automatic resume", "On — durable offset, 10-min session")
      srow(this, R.drawable.ic_swap, "Pause / resume", "Supported")
      srow(this, R.drawable.ic_sun, "Keep screen awake", if (keepAwakePref()) "On" else "Off") {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_KEEP_AWAKE, !keepAwakePref()).apply()
        applyKeepAwake(); render()
      }
      srow(this, R.drawable.ic_bell, "Transfer notifications", if (notifOn) "On" else "Tap to allow") {
        if (Build.VERSION.SDK_INT >= 33) askPermission(Manifest.permission.POST_NOTIFICATIONS, REQ_NOTIF)
      }
    })

    section("STORAGE")
    val dl = File(getExternalFilesDir(null) ?: filesDir, "downloads").apply { mkdirs() }
    val stat = try { android.os.StatFs(dl.path) } catch (_: Exception) { null }
    val received = dl.listFiles { f -> f.isFile && !f.name.endsWith(".ndtpart") } ?: emptyArray()
    val partFiles = dl.listFiles { f -> f.isFile && f.name.endsWith(".ndtpart") } ?: emptyArray()
    content.addView(glassCard(pad = 12f).apply {
      srow(this, R.drawable.ic_file, "Receive location", "App storage · downloads")
      srow(this, R.drawable.ic_spd, "Storage available",
        stat?.let { SpeedFormat.bytesText(it.availableBytes) } ?: "Unknown")
      srow(this, R.drawable.ic_file, "Received files",
        if (received.isEmpty()) "None yet" else "${received.size} · " + SpeedFormat.bytesText(received.sumOf { it.length() }))
      srow(this, R.drawable.ic_check, "Temporary transfer data", if (partFiles.isEmpty()) "None" else SpeedFormat.bytesText(partFiles.sumOf { it.length() })) {
        val n = partFiles.size; val bytes = partFiles.sumOf { it.length() }
        partFiles.forEach { it.delete() }
        toast(if (n > 0) "Cleared $n partial file(s), ${SpeedFormat.bytesText(bytes)}" else "Nothing to clear")
        render()
      }
      srow(this, R.drawable.ic_hist, "Clear transfer history", "Clear") {
        HistoryStore.clear(this@MainActivity)
        toast("History cleared"); render()
      }
    })
    content.addView(sm(dl.absolutePath).apply {
      setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 9.5f)
      setPadding(dp(4), dp(4), dp(4), 0)
    })

    section("PRIVACY & SECURITY")
    content.addView(glassCard(pad = 12f).apply {
      srow(this, R.drawable.ic_shield, "Direct device-to-device", "On — local network only")
      srow(this, R.drawable.ic_shield, "SHA-256 verification", "On")
      srow(this, R.drawable.ic_dev, "Cloud upload", "None")
      srow(this, R.drawable.ic_dev, "Accounts", "Not required")
      srow(this, R.drawable.ic_swap, "Clear session data", "Clear") {
        stopReceiving(); peerIp = null; localEndpoint = null
        toast("Session data cleared"); render()
      }
    })

    section("APPEARANCE")
    content.addView(glassCard(pad = 12f).apply {
      srow(this, R.drawable.ic_sun, "Theme", "Dark — NexDrop premium")
    })

    section("DIAGNOSTICS")
    content.addView(glassCard(pad = 12f).apply {
      srow(this, R.drawable.ic_spd, "Device Test (Advanced)", "Open") { go(Screen.DEVICE_TEST) }
    })

    section("ABOUT")
    val v = try { packageManager.getPackageInfo(packageName, 0) } catch (e: Exception) { null }
    content.addView(glassCard(pad = 12f).apply {
      srow(this, R.drawable.ic_check, "NexDrop version", v?.versionName ?: "")
      srow(this, R.drawable.ic_check, "Build", v?.let { it.versionCode.toString() } ?: "")
      srow(this, R.drawable.ic_swap, "NDT1 protocol", "v" + Ndt1.VERSION + " — native TCP")
      srow(this, R.drawable.ic_dev, "Project", "GitHub") {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/PDFly-source/nexdrop"))) } catch (_: Exception) {}
      }
      srow(this, R.drawable.ic_shield, "Privacy", "Open") {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PWA_URL + "privacy"))) } catch (_: Exception) {}
      }
      addView(sm(PWA_FALLBACK_NOTE).apply { setPadding(0, dp(2), 0, 0) })
    })
    nav(4)
  }

  // ================= DEVICE TEST (engineering only, unchanged logic) =================
  private fun renderDeviceTest() {
    screenTitle("Device Test")
    content.addView(sm("Engineering diagnostics — benchmarks, raw endpoint info, run JSON.").apply {
      setTextColor(D.MUTED)
    })
    content.addView(btn("Benchmark NATIVE — 358 MiB", "outline", height = 46) { startBenchmark(358) }.apply {
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(46)).apply { topMargin = dp(10) }
    })
    content.addView(btn("Benchmark NATIVE — 1 GiB", "outline", height = 46) { startBenchmark(1024) }.apply {
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(46)).apply { topMargin = dp(10) }
    })
    val ep = localEndpoint ?: LocalNet.select(activeWifiInterface())
    content.addView(glassCard().apply {
      addView(sm(ep?.let { LocalNet.diagnostics(it, reachable = "YES — LocalNet selector", peerIp = peerIp) } ?: LocalNet.unavailableText()).apply {
        setTextColor(D.TEXT); setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12f)
      })
    })
    content.addView(btn("Back to Settings", "text", height = 36) { backOr(Screen.SETTINGS) }.apply {
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(36))
    })
  }

  // ================= FAILED (honest) =================
  private fun renderFailed() {
    screenTitle("Transfer failed")
    content.addView(glassCard().apply {
      failedMessage?.let { addView(textView(it, 13f, D.DANGER, 600).apply { setTextColor(D.DANGER) }) }
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(1, dp(8)) })
      if (failedMessage?.contains("SHA-256") == true) {
        addView(sm("INTEGRITY CHECK FAILED — the received file was deleted.").apply { setTextColor(D.DANGER) })
      } else {
        addView(sm("The connection was lost or the peer could not be reached. Reconnecting within the 10-minute session resumes from the durable offset — never from zero."))
      }
    })
    content.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(1, 0).apply { weight = 1f } })
    content.addView(btn("TRY AGAIN", "primary") {
      screen = Screen.HOME; render()
      if (role == Role.RECEIVE) startReceiving() else startSendingLegacyScan()
    }.apply { layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(50)) })
    content.addView(btn("Back to Home", "text", height = 36) { goRoot(Screen.HOME) }.apply {
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(36))
    })
  }

  // ================= NATIVE LOCAL UNAVAILABLE (honest) =================
  private fun renderUnavailable() {
    screenTitle("NexDrop")
    content.addView(glassCard().apply {
      addView(textView("●  NATIVE LOCAL UNAVAILABLE", 15f, D.AMBER, 700, 1))
      addView(sm(LocalNet.unavailableText()).apply { setPadding(0, dp(6), 0, 0) })
      addView(sm("The native local path needs a reachable local network (same Wi-Fi or hotspot).").apply {
        setTextColor(D.MUTED); setPadding(0, dp(6), 0, 0)
      })
    })
    content.addView(btn("OPEN NEXDROP WEB", "primary") { openPwa() }.apply {
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(50)).apply { topMargin = dp(10) }
    })
    content.addView(sm(PWA_FALLBACK_NOTE).apply { setPadding(dp(4), dp(10), dp(4), 0) })
    content.addView(btn("Back to Home", "text", height = 36) { goRoot(Screen.HOME) }.apply {
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(36))
    })
  }

  // ================= engine wiring (unchanged NDT1 flow) =================

  private fun stopReceiving() {
    receiver?.stop(); receiver = null; localEndpoint = null
    TransferService.stop(this)
  }

  private fun sendTextFlow() {
    val input = EditText(this).apply {
      setHint("Type your text")
      setTextColor(D.TEXT)
      setHintTextColor(D.MUTED)
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
      setSingleLine(false)
      minLines = 3
      setPadding(dp(16), dp(12), dp(16), dp(12))
    }
    AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog)
      .setTitle("Send text")
      .setView(input)
      .setPositiveButton("Continue") { _, _ ->
        val text = input.text.toString()
        if (text.isBlank()) { toast("Nothing to send"); return@setPositiveButton }
        val f = File(cacheDir, "nexdrop-text-${System.currentTimeMillis()}.txt")
        f.writeText(text)
        onFilePicked(Uri.fromFile(f))
      }
      .setNegativeButton("Cancel", null)
      .show()
  }

  /** SEND flow entry used by Home/FAILED retry where a scan-first flow fits. */
  private fun startSendingLegacyScan() {
    if (!hasPermission(Manifest.permission.CAMERA)) { askPermission(Manifest.permission.CAMERA, REQ_CAMERA); return }
    launchScan("Scan the receiver's NexDrop QR")
  }

  private fun sendPickedFile(uri: Uri, pairing: QrPairing.Pairing) {
    val name = pendingName(uri) ?: "file"
    val size = pendingSize(uri)
    if (size <= 0) { toast("Cannot read that file"); return }
    val session = SessionToken(QrPairing.tokenBytesFrom(pairing), pairing.tokenB64, pairing.sessionId)
    role = Role.SEND
    currentName = name
    currentSize = size
    currentFile = null
    transferGotFirstProgress = false
    beginTransfer()
    peerIp = pairing.ip
    if (Build.VERSION.SDK_INT >= 33 && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
      askPermission(Manifest.permission.POST_NOTIFICATIONS, REQ_NOTIF)
    }
    TransferService.start(this, "Sending $name…")
    sender = TurboSender(this).also { s ->
      s.send(uri, name, size, pairing.ip, pairing.port, session, senderListener(name, pairing))
    }
  }

  private fun senderListener(name: String, pairing: QrPairing.Pairing) = object : TurboSender.Listener {
    override fun onProgress(durable: Long, total: Long) = this@MainActivity.onProgress(durable, total)
    override fun onComplete(sha256: String, stats: ThroughputSampler.Stats) {
      peerIp = pairing.ip
      runOnUiThread {
        completedSha = sha256
        completedStats = stats
        hideTransferUi()
        recordHistory(name, stats.averageBps, stats.durationMs, sha256, verified = true)
        backStack.clear(); screen = Screen.RESULT
        render()
        TransferService.stop(this@MainActivity)
      }
    }
    override fun onError(message: String) = runOnUiThread { transferFailed("Could not reach ${pairing.ip}:${pairing.port}\n$message") }
  }

  private fun recordHistory(name: String, bps: Double?, durMs: Long?, sha: String, verified: Boolean) {
    HistoryStore.record(this, HistoryStore.Entry(
      name = name, bytes = currentSize, sent = role == Role.SEND,
      atMs = System.currentTimeMillis(), sha256 = sha, verified = verified,
      speedBps = bps ?: 0.0, durationMs = durMs ?: 0L))
  }

  private fun transferFailed(message: String) {
    hideTransferUi()
    failedMessage = message
    backStack.clear(); screen = Screen.FAILED
    render()
    TransferService.stop(this)
  }

  @Volatile private var failedMessage: String? = null

  private fun hideTransferUi() { sender = null; receiver = null; setTransferActive(false) }

  private fun setTransferActive(on: Boolean) {
    transferActive = on
    applyKeepAwake()
  }

  private fun beginTransfer() {
    setTransferActive(true)
    transferStartNanos = System.nanoTime()
    paused = false
    transferGotFirstProgress = false
    backStack.clear(); screen = Screen.TRANSFER
    render()
  }

  override fun onProgress(durable: Long, total: Long) {
    runOnUiThread {
      if (screen != Screen.TRANSFER) return@runOnUiThread
      currentSize = total
      val elapsedS = (System.nanoTime() - transferStartNanos) / 1e9
      val bps = if (elapsedS > 0) durable / elapsedS else null
      val pct = if (total > 0) (durable * 100 / total).toInt() else 0
      ring?.progress = pct / 100f
      ringPct?.text = "$pct%"
      ringBytes?.text = "${SpeedFormat.bytesText(durable)}\nof ${SpeedFormat.bytesText(total)}"
      transferGotFirstProgress = true
      val sp = UiSpeed.speedText(if (paused) null else bps)
      val numeric = !sp.startsWith("N/A")
      speedView?.text = if (numeric) sp.substringBefore(" ") else "N/A"
      speedUnitView?.visibility = if (numeric) View.VISIBLE else View.GONE
      etaView?.text = if (paused) "PAUSED — connection kept alive" else "ETA ${UiSpeed.etaText(total - durable, bps)}"
      // Truthful foreground notification (same math as the JSON export)
      currentName?.let { TransferService.notifyProgress(this, it, durable, total, bps) }
    }
  }

  // ---- receiver callbacks (transfer continues even on other screens) ----
  override fun onOffer(offer: Offer): Boolean {
    val queue = ArrayBlockingQueue<Boolean>(1)
    runOnUiThread {
      currentName = offer.name
      currentSize = offer.sizeBytes
      onOfferUi(offer) { decision -> queue.offer(decision); runOnUiThread { render() } }
    }
    val decision = queue.poll(60, TimeUnit.SECONDS) ?: false
    if (decision) runOnUiThread { transferGotFirstProgress = false; beginTransfer() }
    else runOnUiThread { if (screen == Screen.RECEIVE) render() } // auto-decline: sheet down
    return decision
  }

  override fun onPeerConnected(peer: String) {
    runOnUiThread { peerIp = peer }
  }

  override fun onComplete(file: File, sha256: String, stats: ThroughputSampler.Stats) {
    runOnUiThread {
      completedSha = sha256
      completedStats = stats
      currentFile = file
      hideTransferUi()
      recordHistory(file.name, stats.averageBps, stats.durationMs, sha256, verified = true)
      backStack.clear(); screen = Screen.RESULT
      render()
      TransferService.stop(this)
    }
  }

  override fun onError(message: String) {
    runOnUiThread { transferFailed(message) }
  }

  private fun openFile(f: File) {
    try {
      val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
      val ext = f.extension.lowercase()
      val mime = android.webkit.MimeTypeMap.getSingleton()
        .getMimeTypeFromExtension(ext) ?: "application/octet-stream"
      startActivity(Intent.createChooser(Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, mime)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }, "Open ${f.name}"))
    } catch (e: Exception) {
      toast("No app can open this file type")
    }
  }

  // ================= benchmark (Device Test, unchanged logic) =================
  private fun startBenchmark(mib: Int) {
    benchModeMiB = mib
    if (!hasPermission(Manifest.permission.CAMERA)) { askPermission(Manifest.permission.CAMERA, REQ_CAMERA); return }
    launchScan("Scan the receiver's NexDrop QR (benchmark $mib MiB)")
  }

  private fun runBenchmark(pairing: QrPairing.Pairing, mib: Int) {
    val f = File(cacheDir, "nexdrop-bench-$mib.bin")
    role = Role.SEND
    currentName = "benchmark-$mib MiB"
    currentSize = mib.toLong() * 1024 * 1024
    beginTransfer()
    thread(name = "ndt1-bench") {
      try {
        BenchFile.generate(cacheDir, f.name, mib.toLong() * 1024 * 1024)
        val session = SessionToken(QrPairing.tokenBytesFrom(pairing), pairing.tokenB64, pairing.sessionId)
        peerIp = pairing.ip
        sender = TurboSender(this)
        sender?.send(
          Uri.fromFile(f), f.name, f.length(), pairing.ip, pairing.port, session,
          object : TurboSender.Listener {
            override fun onProgress(durable: Long, total: Long) = this@MainActivity.onProgress(durable, total)
            override fun onComplete(sha256: String, stats: ThroughputSampler.Stats) {
              runOnUiThread {
                hideTransferUi()
                completedSha = sha256
                completedStats = stats
                currentName = f.name
                backStack.clear(); screen = Screen.RESULT
                render()
                TransferService.stop(this@MainActivity)
                shareRunJson(stats, sha256, f.name) // Device Test only
              }
              f.delete()
            }
            override fun onError(message: String) { f.delete(); runOnUiThread { transferFailed(message) } }
          },
        )
      } catch (e: Exception) {
        runOnUiThread { transferFailed(e.message ?: "benchmark error") }
      }
    }
  }

  private fun shareRunJson(stats: ThroughputSampler.Stats, sha256: String, name: String) {
    val json = stats.toJson("ndt1-native-local", sha256) {
      put("file", name)
      put("benchmark", true)
      put("device", Build.MODEL)
    }
    AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog)
      .setTitle("Share run JSON?")
      .setMessage(json.take(400))
      .setPositiveButton("Share") { _, _ ->
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
          type = "application/json"
          putExtra(Intent.EXTRA_TEXT, json)
        }, "NexDrop run JSON"))
      }
      .setNegativeButton("Keep on device", null)
      .show()
  }

  // ================= helpers =================
  private fun launchScan(prompt: String) {
    scanQr.launch(ScanOptions().apply {
      setDesiredBarcodeFormats(ScanOptions.QR_CODE)
      setPrompt(prompt)
      setBeepEnabled(false)
    })
  }

  private fun showQr(text: String) {
    thread(name = "ndt1-qr") {
      try {
        val size = 720
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
        val pixels = IntArray(size * size)
        for (y in 0 until size) for (x in 0 until size) {
          // mockup QR: dark modules #0b1220 on white
          pixels[y * size + x] = if (matrix.get(x, y)) D.QR_DARK else Color.WHITE
        }
        val bmp = Bitmap.createBitmap(pixels, size, size, Bitmap.Config.RGB_565)
        runOnUiThread { qrView?.setImageBitmap(bmp) }
      } catch (e: Exception) {
        runOnUiThread { toast("QR rendering failed") }
      }
    }
  }

  private fun pendingName(uri: Uri): String? =
    if (uri.scheme == "file") File(uri.path!!).name else queryName(uri)

  private fun pendingSize(uri: Uri): Long =
    if (uri.scheme == "file") File(uri.path!!).length() else querySize(uri)

  private fun queryName(uri: Uri): String? {
    contentResolver.query(uri, null, null, null, null)?.use { c ->
      val idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
      if (idx >= 0 && c.moveToFirst()) return c.getString(idx)
    }
    return uri.lastPathSegment
  }

  private fun querySize(uri: Uri): Long {
    contentResolver.query(uri, null, null, null, null)?.use { c ->
      val idx = c.getColumnIndex(android.provider.OpenableColumns.SIZE)
      if (idx >= 0 && c.moveToFirst() && !c.isNull(idx)) return c.getLong(idx)
    }
    return -1
  }

  private fun openPwa() {
    try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PWA_URL))) }
    catch (e: Exception) { toast("No browser available") }
  }

  /** Active Wi-Fi network interface name (hotspot host reports null). */
  private fun activeWifiInterface(): String? = try {
    val cm = getSystemService(android.net.ConnectivityManager::class.java)
    (listOfNotNull(cm.activeNetwork) + cm.allNetworks.toList())
      .firstNotNullOfOrNull { net ->
        val caps = cm.getNetworkCapabilities(net) ?: return@firstNotNullOfOrNull null
        val lp = cm.getLinkProperties(net) ?: return@firstNotNullOfOrNull null
        if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)) lp.interfaceName else null
      }
  } catch (_: Exception) { null }

  private fun hasPermission(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED
  private fun askPermission(p: String, code: Int) { ActivityCompat.requestPermissions(this, arrayOf(p), code) }
  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
      when (requestCode) {
        REQ_CAMERA -> if (benchModeMiB != null) startBenchmark(benchModeMiB!!) else {
          if (pendingUri != null) launchScan("Scan the receiver's NexDrop QR") else { screen = Screen.SEND; render() }
        }
      }
    } else toast("Permission required for this mode")
  }
  private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

  companion object {
    const val PWA_URL = "https://pdfly-source.github.io/nexdrop/"
    const val PWA_FALLBACK_NOTE =
      "The PWA (WebRTC path) pairs with the normal QR flow there. Resume safety: reconnecting within the 10-minute session resumes from the durable offset — never from zero."
    private const val PREFS = "nd_ui"
    private const val KEY_WELCOMED = "welcomed"
  private const val KEY_KEEP_AWAKE = "keep_awake"
    private const val REQ_NOTIF = 2
    private const val REQ_CAMERA = 3
  }
}
