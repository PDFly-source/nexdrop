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
import androidx.documentfile.provider.DocumentFile
import com.nexdrop.ndt1.ui.BgView
import com.nexdrop.ndt1.ui.CheckCircleView
import com.nexdrop.ndt1.ui.D
import com.nexdrop.ndt1.ui.Fonts
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

  // ---- SEND QUEUE (PRIORITY 1): N files or a whole folder, one pairing,
  //      sequential independent NDT1 streams. Nothing is faked: each file
  //      goes through the full OFFER/accept/SHA flow on the receiver. ----
  private class QItem(val uri: Uri, val name: String, val size: Long) {
    @Volatile var state = "Ready" // Ready | Sending | Done
  }
  private val sendQueue = ArrayList<QItem>()
  private var queueIndex = -1
  private var queueBytesDone = 0L
  private var activePairing: QrPairing.Pairing? = null
  private var resumeAttempts = 0
  @Volatile private var reconnecting = false
  @Volatile private var acceptedOfferKey: String? = null

  // ---- NEARBY DEVICES (v1.4): REAL NDD1 discovery only. One beacon socket
  //      at a time: the receiver advertises a real pairable session; a
  //      sender on the Send screen advertises an identity-only beacon
  //      (no token — never claims to be pairable) while listening for
  //      receivers. No fake peers, no fake distance, no fake names. ----
  private var beaconSession: DiscoveryBeacon? = null   // receiver mode: advertise token + listen
  private var beaconIdentity: DiscoveryBeacon? = null  // send mode: identity presence + listen
  private var multicastLock: android.net.wifi.WifiManager.MulticastLock? = null
  private data class SeenPeer(val dev: DiscoveryBeacon.DiscoveredDevice, val atMs: Long)
  private val identityByIp = java.util.concurrent.ConcurrentHashMap<String, SeenPeer>()
  private var nearbySignature = ""
  private var lastTrustPromptDevid: String? = null

  private fun queueTotalBytes(): Long = sendQueue.sumOf { it.size }

  private fun addToQueue(uri: Uri, displayOverride: String?) {
    val name = displayOverride ?: pendingName(uri) ?: return
    val size = pendingSize(uri)
    if (size <= 0) { toast("Cannot read $name"); return }
    if (sendQueue.any { it.uri.toString() == uri.toString() }) { toast("$name already in queue"); return }
    sendQueue.add(QItem(uri, name, size))
  }

  /** SAF folder → real recursive file queue (streamed, bounded RAM). */
  private fun queueFolder(tree: Uri) {
    thread {
      try {
        val root = DocumentFile.fromTreeUri(this, tree) ?: return@thread
        val items = ArrayList<QItem>()
        fun walk(dir: DocumentFile, path: String) {
          dir.listFiles().forEach { d ->
            val rel = if (path.isEmpty()) d.name ?: "?" else "$path/${d.name ?: "?"}"
            if (d.isDirectory) walk(d, rel)
            else if (d.isFile && (d.name ?: "").isNotEmpty() && d.length() > 0) {
              items.add(QItem(d.uri, rel, d.length()))
            }
          }
        }
        walk(root, "")
        runOnUiThread {
          if (items.isEmpty()) { toast("No files in that folder"); return@runOnUiThread }
          items.forEach { it2 -> sendQueue.add(it2) }
          toast("Folder queued — ${items.size} files, ${SpeedFormat.bytesText(items.sumOf { it.size })}")
          if (screen == Screen.SEND) render() else { screen = Screen.SEND; render() }
        }
      } catch (e: Exception) {
        runOnUiThread { toast("Could not read folder: ${e.message}") }
      }
    }
  }

  private fun autoResumePref(): Boolean =
    getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_AUTO_RESUME, true)

  // ================= v1.4 NEARBY DEVICES + TRUSTED DEVICES =================

  /** Stable per-install identity (random UUID, local only, never leaves the LAN beacon). */
  private fun deviceIdPref(): String {
    val sp = getSharedPreferences(PREFS, MODE_PRIVATE)
    var id = sp.getString(KEY_DEVICE_ID, null)
    if (id == null) {
      id = java.util.UUID.randomUUID().toString()
      sp.edit().putString(KEY_DEVICE_ID, id).apply()
    }
    return id
  }

  fun deviceLabel(): String = Build.MODEL

  private fun autoAcceptPref(): Boolean =
    getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_AUTO_ACCEPT, false)

  private fun acquireMulticastLock() {
    if (multicastLock?.isHeld == true) return
    val wm = applicationContext.getSystemService(WIFI_SERVICE) as? android.net.wifi.WifiManager
    multicastLock = wm?.createMulticastLock("nexdrop-discovery")?.apply {
      setReferenceCounted(false); acquire()
    }
  }

  private fun releaseMulticastLock() {
    try { multicastLock?.release() } catch (_: Exception) {}
    multicastLock = null
  }

  /** Beacon packet handler — updates the real peer table from real packets. */
  private fun onBeaconPeers(peers: List<DiscoveryBeacon.DiscoveredDevice>) {
    runOnUiThread {
      val now = System.currentTimeMillis()
      peers.forEach { dev -> if (dev.deviceId != deviceIdPref()) identityByIp[dev.address] = SeenPeer(dev, now) }
      identityByIp.keys.removeAll { now - (identityByIp[it]?.atMs ?: 0) > 15_000 } // beacon is 1 Hz; stale = gone
      if (screen == Screen.SEND) {
        val sig = pairablePeers().joinToString("|") { "${it.dev.deviceName}@${it.dev.address}" }
        if (sig != nearbySignature) { nearbySignature = sig; render() }
      }
    }
  }

  /** Receivers with a REAL pairable token — identity-only peers are excluded. */
  private fun pairablePeers(): List<SeenPeer> =
    identityByIp.values
      .filter { it.dev.token.isNotEmpty() && it.dev.sessionId.isNotEmpty() && nowFresh(it) }
      .sortedBy { it.dev.deviceName.lowercase() }

  private fun nowFresh(p: SeenPeer): Boolean =
    System.currentTimeMillis() - p.atMs <= 15_000

  /** Sender-side presence beacon: identity only — honest, never pairable. */
  private fun startIdentityBeacon() {
    if (beaconIdentity != null || beaconSession != null) return // one socket (port is fixed)
    try {
      acquireMulticastLock()
      beaconIdentity = DiscoveryBeacon(deviceLabel(), "android", 0,
        SessionToken(ByteArray(0), "", ""), deviceIdPref()).also {
        it.start({ peers -> onBeaconPeers(peers) })
      }
    } catch (_: Exception) { beaconIdentity = null } // honest: QR pairing still works
  }

  private fun stopIdentityBeacon() {
    beaconIdentity?.stop(); beaconIdentity = null
    if (beaconSession == null) releaseMulticastLock()
    // NOTE: never wipe identity-only peers here — on a receiving device those
    // ARE the live sender identities (accept sheet + trusted auto-accept).
    // Staleness is handled by the 15 s prune + nowFresh() checks.
  }

  /** Receiver advertisement: real session token — this side IS pairable. */
  private fun startSessionBeacon(session: SessionToken, port: Int) {
    if (beaconSession != null) return
    try {
      acquireMulticastLock()
      beaconSession = DiscoveryBeacon(deviceLabel(), "android", port, session, deviceIdPref()).also {
        it.start({ peers -> onBeaconPeers(peers) })
      }
    } catch (_: Exception) { beaconSession = null } // QR pairing unaffected
  }

  private fun stopSessionBeacon() {
    beaconSession?.stop(); beaconSession = null
    if (beaconIdentity == null) releaseMulticastLock()
  }

  /** Pair to a REAL discovered receiver — same path as a scanned QR. */
  private fun pairFromDiscovery(p: SeenPeer) {
    if (sendQueue.isEmpty()) { toast("Choose files first — then tap the device again"); return }
    val dev = p.dev
    val pairing = QrPairing.Pairing(dev.address, dev.port, dev.sessionId, dev.token, expired = false)
    toast("Connecting to ${dev.deviceName}…")
    sendQueueStart(pairing)
  }

  // ---- Trusted devices: local, written ONLY after a SHA-256-verified transfer ----
  data class TrustedDevice(val devid: String, val name: String, val atMs: Long)

  private fun trustedDevices(): List<TrustedDevice> = try {
    val arr = org.json.JSONArray(getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_TRUSTED, "[]"))
    (0 until arr.length()).map { i ->
      val o = arr.getJSONObject(i)
      TrustedDevice(o.getString("devid"), o.optString("name"), o.optLong("atMs"))
    }
  } catch (_: Exception) { emptyList() }

  private fun isTrusted(devid: String): Boolean =
    devid.isNotEmpty() && trustedDevices().any { it.devid == devid }

  private fun trustDevice(devid: String, name: String) {
    if (devid.isEmpty()) return
    val list = trustedDevices().filter { it.devid != devid } + TrustedDevice(devid, name, System.currentTimeMillis())
    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
      .putString(KEY_TRUSTED, org.json.JSONArray(list.map { org.json.JSONObject().put("devid", it.devid).put("name", it.name).put("atMs", it.atMs) }).toString())
      .apply()
  }

  private fun untrustDevice(devid: String) {
    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
      .putString(KEY_TRUSTED, org.json.JSONArray(trustedDevices().filter { it.devid != devid }.map { org.json.JSONObject().put("devid", it.devid).put("name", it.name).put("atMs", it.atMs) }).toString())
      .apply()
  }

  /** Resolve the live sender's identity from the beacon table (real packets). */
  private fun peerIdentity(): DiscoveryBeacon.DiscoveredDevice? =
    peerIp?.let { ip -> identityByIp[ip]?.takeIf { nowFresh(it) }?.dev }
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
  private var overallView: TextView? = null
  private var pauseBtn: View? = null

  // ---- activity result contracts (unchanged engine flow) ----
  private val scanQr = registerForActivityResult(ScanContract()) { result ->
    val contentQr = result.contents
    if (contentQr.isNullOrEmpty()) return@registerForActivityResult
    val pairing = QrPairing.decode(contentQr)
      ?: run { toast("Not a NexDrop QR"); return@registerForActivityResult }
    if (pairing.expired) { toast("QR expired — ask for a new one"); return@registerForActivityResult }
    val bench = benchModeMiB
    if (bench != null) runBenchmark(pairing, bench) else sendQueueStart(pairing)
  }
  // Multiple-file picker (PRIORITY 1): every selected file enters the SEND
  // QUEUE. Content URIs stream through the engine — nothing is loaded to RAM.
  private val pickFile = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris: List<Uri>? ->
    if (uris.isNullOrEmpty()) return@registerForActivityResult
    var added = 0
    uris.forEach { uri ->
      try { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
      addToQueue(uri, null)
      added++
    }
    if (added > 0) {
      toast("$added file(s) added — ${sendQueue.size} in queue")
      if (screen == Screen.SEND) render() else { screen = Screen.SEND; render() }
    }
  }
  // Folder picker (PRIORITY 1): SAF tree — queued RECURSIVELY as individual
  // streamed files. No Android API lets a native app enumerate arbitrary
  // paths outside SAF; this is the honest maximum.
  private val pickFolder = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri: Uri? ->
    if (uri == null) return@registerForActivityResult
    try { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
    queueFolder(uri)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.statusBarColor = D.BG
    window.navigationBarColor = D.BG
    val welcomed = getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_WELCOMED, false)
    screen = if (welcomed) Screen.HOME else Screen.WELCOME
    handleShareIntent(intent)
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

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleShareIntent(intent)
  }

  /**
   * Android Share Sheet (v1.4): ACTION_SEND / ACTION_SEND_MULTIPLE uris go
   * through the SAME queue as hand-picked files — real SAF content uris,
   * real sizes, real engine flow. Text-only shares are not silently
   * converted: they are answered honestly (the in-app send-text flow is
   * on the Send screen).
   */
  private fun handleShareIntent(intent: Intent?) {
    val action = intent?.action ?: return
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
    val uris: List<Uri> = if (action == Intent.ACTION_SEND) {
      listOfNotNull(androidx.core.content.IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
    } else {
      (androidx.core.content.IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java) ?: ArrayList()).filterNotNull()
    }
    if (uris.isEmpty()) { toast("Nothing shareable in that request"); return }
    val added = ArrayList<String>()
    uris.forEach { u ->
      val name = queryName(u)
      if (name != null) { addToQueue(u, name); added.add(name) }
    }
    if (added.isEmpty()) { toast("Could not read the shared item(s)"); return }
    goRoot(Screen.SEND)
    toast(if (added.size == 1) "Added ${added[0]} to the send queue" else "Added ${added.size} files to the send queue")
  }

  override fun onDestroy() {
    ticker?.let { ui.removeCallbacks(it) }
    stopIdentityBeacon()
    stopSessionBeacon()
    releaseMulticastLock()
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
    if (screen == Screen.SEND || screen == Screen.TRANSFER) startIdentityBeacon()
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
    // Nearby presence: the sender advertises its identity (and listens for
    // receivers) while on the Send/Transfer screens, so a receiving device
    // can show a REAL sender name and honor trusted auto-accept. Nowhere else.
    if (screen != Screen.SEND && screen != Screen.TRANSFER) stopIdentityBeacon()
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

  // ================= 03 SEND FILES (QUEUE) =================
  private fun startSendFlow() {
    benchModeMiB = null
    go(Screen.SEND)
  }

  /** Per-queue-item row: icon, name+size, state pill, remove, tap = actions. */
  private fun queueRow(item: QItem, index: Int): View {
    val r = glassCard(pad = 12f).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      addView(icBox(R.drawable.ic_file))
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
      val t = col().apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f } }
      t.addView(textView(item.name, 13f, D.TEXT, 700).apply {
        maxLines = 2
        ellipsize = android.text.TextUtils.TruncateAt.END
      })
      t.addView(sm("${SpeedFormat.bytesText(item.size)}  ·  #${index + 1}"))
      addView(t)
      if (item.state != "Sending") {
        addView(ImageView(this@MainActivity).apply {
          setImageResource(R.drawable.ic_x)
          imageTintList = android.content.res.ColorStateList.valueOf(D.MUTED)
          layoutParams = LinearLayout.LayoutParams(dp(36), dp(36))
          setPadding(dp(8), dp(8), dp(8), dp(8))
          contentDescription = "Remove ${item.name}"
          setOnClickListener {
            sendQueue.removeAt(index)
            toast("Removed from queue")
            render()
          }
        })
      }
      addView(pill(item.state, tint = when (item.state) { "Done" -> D.OK; "Sending" -> D.PRIMARY; else -> D.BLUE }))
      setOnClickListener { queueItemActions(item) }
    }
    return r
  }

  /** Tap a queued file: reorder / remove — real queue management. */
  private fun queueItemActions(item: QItem) {
    val opts = ArrayList<String>()
    if (sendQueue.indexOf(item) > 0) opts.add("Move up")
    if (sendQueue.indexOf(item) < sendQueue.size - 1) opts.add("Move down")
    opts.add("Remove")
    AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog)
      .setTitle(item.name)
      .setItems(opts.toTypedArray()) { _, which ->
        val i = sendQueue.indexOf(item)
        when (val chosen = opts[which]) {
          "Move up" -> { if (i > 0) { sendQueue.removeAt(i); sendQueue.add(i - 1, item) } }
          "Move down" -> { if (i >= 0 && i < sendQueue.size - 1) { sendQueue.removeAt(i); sendQueue.add(i + 1, item) } }
          "Remove" -> { if (i >= 0) sendQueue.removeAt(i) }
        }
        render()
      }
      .setNegativeButton("Close", null)
      .show()
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
      addView(sm("Pick one, several, or a folder"))
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

    // NEARBY DEVICES (v1.4): real NDD1 discovery — receivers running on this
    // network appear here automatically. No peers = honest empty state, and
    // QR pairing always remains. No radar rings: Android exposes no honest
    // distance for arbitrary peers, so none is implied.
    content.addView(sm("NEARBY DEVICES").apply {
      setTextColor(D.MUTED); letterSpacing = 0.10f
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(16); bottomMargin = dp(6) }
    })
    val nearby = pairablePeers()
    content.addView(glassCard(pad = 12f).apply {
      if (nearby.isEmpty()) {
        if (beaconIdentity == null && beaconSession == null) {
          addView(textView("Discovery unavailable", 13f, D.TEXT, 700).apply { setPadding(0, 0, 0, dp(2)) })
          addView(sm("Another local socket holds the discovery port, or multicast is blocked. Scan the receiver's QR instead — pairing is identical."))
        } else {
          addView(textView("No NexDrop receivers found", 13f, D.TEXT, 700).apply { setPadding(0, 0, 0, dp(2)) })
          addView(sm("A device on this network shows up here when it opens the Receive screen. QR pairing always works too."))
        }
      } else {
        nearby.forEach { p ->
          val dev = p.dev
          val r = row().apply { setOnClickListener { pairFromDiscovery(p) } }
          r.addView(icBox(R.drawable.ic_dev).apply {
            background = android.graphics.drawable.GradientDrawable().apply {
              cornerRadius = dp(13).toFloat(); setColor(D.argb(31, D.PRIMARY)); setStroke(dp(1), D.argb(51, D.PRIMARY))
            }
          })
          r.addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
          val t = col().apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f } }
          t.addView(textView(if (isTrusted(dev.deviceId)) "${dev.deviceName} · trusted" else dev.deviceName, 13f, D.TEXT, 700))
          t.addView(sm("${dev.address} · ready to receive"))
          r.addView(t)
          r.addView(pill(if (isTrusted(dev.deviceId)) "TRUSTED" else "LOCAL"))
          addView(r)
          addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(1, dp(6)) })
        }
        addView(sm("Tap a device to send the ${if (sendQueue.isEmpty()) "queue" else "whole queue"} without scanning a QR.").apply {
          setPadding(0, dp(2), 0, 0)
        })
      }
    })

    // SEND QUEUE (PRIORITY 1): real totals, per-item states, add/remove/reorder
    val queued = sendQueue.toList()
    content.addView(sm(if (queued.isEmpty()) "No files selected"
      else "${queued.size} file(s) · ${SpeedFormat.bytesText(queueTotalBytes())} total").apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(16); bottomMargin = dp(6) }
    })
    queued.forEachIndexed { i, item ->
      content.addView(queueRow(item, i).apply {
        layoutParams = (layoutParams as LinearLayout.LayoutParams).apply {
          if (i > 0) topMargin = dp(6)
        }
      })
    }
    if (sendQueue.any { it.state == "Done" }) {
      content.addView(sm("${sendQueue.count { it.state == "Done" }} already sent this session").apply {
        layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(8) }
      })
    }
    if (sendQueue.isNotEmpty()) {
      content.addView(btn("CLEAR QUEUE", "text", height = 36) {
        sendQueue.clear(); queueBytesDone = 0
        toast("Queue cleared")
        render()
      }.apply { layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(36)).apply { topMargin = dp(6) } })
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
    val lt = col().apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f } }
    lt.addView(textView("LOCAL DIRECT", 12f, D.TEXT, 700, 1))
    lt.addView(sm(if (ep != null) "Native transfer available" else "No local network — see PWA fallback"))
    localRow.addView(lt)
    content.addView(localRow)

    // ADD FOLDER (SAF tree — queued recursively)
    content.addView(btn("ADD FOLDER", "outline", icon = R.drawable.ic_plus, height = 40) {
      pickFolder.launch(null)
    }.apply { layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(40)).apply { topMargin = dp(6) } })

    // fill + SEND ALL
    content.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(1, 0).apply { weight = 1f } })
    content.addView(btn(if (sendQueue.size > 1) "SEND ALL (${sendQueue.size})" else "CONTINUE", "primary") {
      if (sendQueue.isEmpty()) { toast("Select a file first"); return@btn }
      if (!hasPermission(Manifest.permission.CAMERA)) { askPermission(Manifest.permission.CAMERA, REQ_CAMERA); return@btn }
      launchScan("Scan the receiver's NexDrop QR")
    }.apply { layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(50)) })
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
    acceptedOfferKey = null
    role = Role.RECEIVE
    qrExpiresAtMs = System.currentTimeMillis() + Ndt1.AUTH_TTL_MS
    screen = Screen.RECEIVE
    render()
    showQr(QrPairing.encode(session, endpoint.ip, port, Build.MODEL))
    startSessionBeacon(session, port) // nearby senders can now find this session without the QR
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
    val lt = col().apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f } }
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
    val senderName = peerIdentity()?.deviceName
    head.addView(sm(if (senderName.isNullOrEmpty()) "from a nearby device" else "from $senderName"))
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
    shaRow.addView(textView("SHA-256 ${offer.sha256.take(16)}… · verified on completion", 12.5f, D.OK, 600))
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
    // Queue context (PRIORITY 1): "File 2 of 3 — overall 45%" — real bytes
    if (role == Role.SEND && sendQueue.size > 1) {
      val done = sendQueue.count { it.state == "Done" }
      overallView = sm("File ${done + 1} of ${sendQueue.size} — overall —").apply { setPadding(0, dp(2), 0, 0) }
      content.addView(overallView!!)
    } else overallView = null

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
    val left = col().apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f } }
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
    val right = col().apply { gravity = Gravity.END; layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT) }
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
      // Queue: only the in-flight file is cancelled; Done stays done, the
      // rest stay Ready — the user returns to the queue, not a dead end.
      if (role == Role.SEND) {
        sendQueue.getOrNull(queueIndex)?.let { if (it.state == "Sending") it.state = "Ready" }
        activePairing = null
      }
      hideTransferUi()
      TransferService.stop(this)
      toast("Transfer cancelled")
      if (role == Role.SEND && sendQueue.isNotEmpty()) { screen = Screen.SEND; render() }
      else { screen = Screen.HOME; render() }
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
    // Queue summary (PRIORITY 1): honest — only files the engine verified
    if (role == Role.SEND && sendQueue.isNotEmpty()) {
      val done = sendQueue.count { it.state == "Done" }
      if (done > 1) {
        head.addView(sm("Queue complete — $done file(s) · ${SpeedFormat.bytesText(sendQueue.filter { it.state == "Done" }.sumOf { it.size })}").apply {
          gravity = Gravity.CENTER; setPadding(0, dp(4), 0, 0)
        })
      }
    }
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
        val t = col().apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f } }
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

    // TRUSTED DEVICES (v1.4): offered only after a SHA-256-verified transfer
    // from a sender whose stable identity arrived via real beacon packets.
    if (role == Role.RECEIVE && completedSha != null) {
      val peer = peerIdentity()
      if (peer != null && peer.deviceId.isNotEmpty()) {
        if (isTrusted(peer.deviceId)) {
          content.addView(sm("Trusted: ${peer.deviceName} can be auto-accepted (Settings controls this).").apply {
            setPadding(0, dp(8), 0, 0); gravity = Gravity.CENTER
          })
        } else if (lastTrustPromptDevid != peer.deviceId) {
          content.addView(btn("TRUST ${peer.deviceName.uppercase()}", "outline", height = 42) {
            trustDevice(peer.deviceId, peer.deviceName)
            lastTrustPromptDevid = peer.deviceId
            toast("${peer.deviceName} trusted — auto-accept can be enabled in Settings")
            render()
          }.apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(42)).apply { topMargin = dp(8) }
          })
        }
      } else {
        content.addView(sm("Sender identity not seen — trust is only offered for devices discovered on this network.").apply {
          setPadding(0, dp(8), 0, 0); gravity = Gravity.CENTER; setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 10.5f)
        })
      }
    }
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

    // TRUSTED DEVICES (v1.4): real local trust store, built only from
    // SHA-256-verified transfers with beacon-known identity.
    val trusted = trustedDevices()
    content.addView(sm("TRUSTED DEVICES").apply {
      setTextColor(D.MUTED); letterSpacing = 0.10f
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(14); bottomMargin = dp(6) }
    })
    content.addView(glassCard(pad = 12f).apply {
      if (trusted.isEmpty()) {
        addView(sm("None yet — after a verified transfer, the sender can be trusted from the completion screen"))
      } else trusted.forEach { t ->
        val r = row()
        r.addView(ImageView(this@MainActivity).apply {
          setImageResource(R.drawable.ic_shield)
          imageTintList = android.content.res.ColorStateList.valueOf(D.OK)
          layoutParams = LinearLayout.LayoutParams(dp(24), dp(24))
        })
        r.addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
        val c = col().apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f } }
        c.addView(textView(t.name, 13f, D.TEXT, 700))
        c.addView(sm("trusted " + HistoryStore.dayLabel(t.atMs)))
        r.addView(c)
        r.addView(btn("Remove", "text", height = 34) { untrustDevice(t.devid); toast("Trust removed"); render() }.apply {
          layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(34))
        })
        addView(r)
        addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(1, dp(6)) })
      }
    })

    // HONEST CAPABILITIES (v1.4 matrix): what Android genuinely allows.
    content.addView(sm("CAPABILITIES").apply {
      setTextColor(D.MUTED); letterSpacing = 0.10f
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(14); bottomMargin = dp(6) }
    })
    content.addView(glassCard(pad = 12f).apply {
      srow(this, R.drawable.ic_wifi, "Nearby discovery", "Available — local UDP, no internet")
      srow(this, R.drawable.ic_swap, "Group drop", "Not supported yet — one receiver per session")
      srow(this, R.drawable.ic_dev, "NFC pairing", "Unavailable — Android Beam was removed in Android 10+")
      srow(this, R.drawable.ic_wifi, "Hotspot mode", "Unavailable — Android reserves tethering control to system apps")
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
        addView(historyRow(e) { entry -> historyActions(entry) })
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

  private fun historyRow(e: HistoryStore.Entry, onTap: ((HistoryStore.Entry) -> Unit)? = null): View {
    val r = row()
    r.addView(ImageView(this).apply {
      setImageResource(if (e.status == "Failed") R.drawable.ic_x else R.drawable.ic_check)
      imageTintList = android.content.res.ColorStateList.valueOf(if (e.status == "Failed") D.DANGER else D.OK)
      layoutParams = LinearLayout.LayoutParams(dp(20), dp(20))
    })
    onTap?.let { r.setOnClickListener { it(e) } }
    r.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(8), 1) })
    r.addView(textView(e.name, 13f, D.TEXT, 700).apply {
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f }
      maxLines = 2
      ellipsize = android.text.TextUtils.TruncateAt.END
    })
    val right = col().apply { gravity = Gravity.END; layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT) }
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
    content.addView(sub("Real transfer records — tap a row for actions."))
    val history = HistoryStore.list(this).sortedByDescending { it.atMs }
    val done = history.count { it.status != "Failed" }
    content.addView(sm(if (history.isEmpty()) "No transfers yet"
      else "$done completed · ${history.size - done} failed").apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(12); bottomMargin = dp(6) }
    })
    if (history.isEmpty()) {
      content.addView(glassCard().apply { addView(sm("Transfers you complete will appear here.")) })
    } else {
      content.addView(glassCard(pad = 12f).apply {
        history.forEachIndexed { i, e ->
          addView(historyRow(e) { entry -> historyActions(entry) })
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
      srow(this, R.drawable.ic_hist, "Automatic resume", if (autoResumePref()) "On — durable offset, 5 tries" else "Off") {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_AUTO_RESUME, !autoResumePref()).apply()
        toast(if (autoResumePref()) "Automatic resume on" else "Automatic resume off")
        render()
      }
      srow(this, R.drawable.ic_check, "Auto-accept from trusted", if (autoAcceptPref()) "On — trusted devices only" else "Off") {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_AUTO_ACCEPT, !autoAcceptPref()).apply()
        toast(if (autoAcceptPref()) "Auto-accept on — only devices you trusted after a verified transfer" else "Auto-accept off")
        render()
      }
      srow(this, R.drawable.ic_swap, "Pause / resume", "Supported")
      srow(this, R.drawable.ic_plus, "Multiple file queue", "Supported — SEND ALL")
      srow(this, R.drawable.ic_file, "Folder transfer", "Supported — SAF folder picker")
      srow(this, R.drawable.ic_check, "Preview before accept", "On — accept sheet per file")
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
        stopReceiving(); peerIp = null; localEndpoint = null; acceptedOfferKey = null
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
    stopSessionBeacon()
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
        addToQueue(Uri.fromFile(f), f.name)
        if (screen == Screen.SEND) render() else { screen = Screen.SEND; render() }
      }
      .setNegativeButton("Cancel", null)
      .show()
  }

  /** SEND flow entry used by Home/FAILED retry where a scan-first flow fits. */
  private fun startSendingLegacyScan() {
    if (!hasPermission(Manifest.permission.CAMERA)) { askPermission(Manifest.permission.CAMERA, REQ_CAMERA); return }
    launchScan("Scan the receiver's NexDrop QR")
  }

  /**
   * SEND QUEUE runner (PRIORITY 1): one pairing, N sequential independent
   * NDT1 connections. Each file re-OFFERs — the receiver consents to every
   * file. The engine is untouched: this is pure orchestration on top of
   * TurboSender.send.
   */
  private fun sendQueueStart(pairing: QrPairing.Pairing) {
    if (sendQueue.isEmpty()) { toast("Select files first"); return }
    if (sendQueue.none { it.state == "Ready" } && sendQueue.any { it.state == "Sending" }) return
    activePairing = pairing
    sendQueue.forEach { if (it.state == "Sending") it.state = "Ready" }
    queueBytesDone = sendQueue.filter { it.state == "Done" }.sumOf { it.size }
    sendNextInQueue()
  }

  private fun sendNextInQueue() {
    val pairing = activePairing ?: return
    val idx = sendQueue.indexOfFirst { it.state == "Ready" }
    if (idx < 0) { // whole queue verified-complete
      runOnUiThread {
        hideTransferUi()
        TransferService.stop(this)
        backStack.clear(); screen = Screen.RESULT; render()
      }
      return
    }
    val item = sendQueue[idx]
    item.state = "Sending"
    queueIndex = idx
    resumeAttempts = 0
    reconnecting = false
    role = Role.SEND
    currentName = item.name
    currentSize = item.size
    currentFile = null
    transferGotFirstProgress = false
    peerIp = pairing.ip
    beginTransfer()
    sendItem(item, pairing)
  }

  private fun sendItem(item: QItem, pairing: QrPairing.Pairing) {
    if (Build.VERSION.SDK_INT >= 33 && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
      askPermission(Manifest.permission.POST_NOTIFICATIONS, REQ_NOTIF)
    }
    TransferService.start(this, "Sending ${item.name}…")
    val session = SessionToken(QrPairing.tokenBytesFrom(pairing), pairing.tokenB64, pairing.sessionId)
    sender = TurboSender(this).also { s ->
      s.send(item.uri, item.name, item.size, pairing.ip, pairing.port, session, senderListener(item, pairing))
    }
  }

  private fun senderListener(item: QItem, pairing: QrPairing.Pairing) = object : TurboSender.Listener {
    override fun onProgress(durable: Long, total: Long) = this@MainActivity.onProgress(durable, total)
    override fun onComplete(sha256: String, stats: ThroughputSampler.Stats) {
      item.state = "Done"
      queueBytesDone += item.size
      peerIp = pairing.ip
      runOnUiThread {
        completedSha = sha256
        completedStats = stats
        recordHistory(item.name, stats.averageBps, stats.durationMs, sha256, verified = true)
        sendNextInQueue() // advances to the next file or shows RESULT
      }
    }
    override fun onError(message: String) = runOnUiThread { onSendError(item, pairing, message) }
  }

  /**
   * AUTO-RESUME (Phase 3): a mid-transfer drop does NOT restart from zero.
   * The receiver retains the .ndtpart and its durable offset; we reconnect
   * with the same session and resume from READY(durableOffset). Retries are
   * bounded (5, backoff 1s..8s) and stop the moment the QR session (10 min)
   * can no longer authorize us — then the honest FAILED screen. The user
   * can disable this in Settings → TRANSFER → Automatic resume.
   */
  private fun onSendError(item: QItem, pairing: QrPairing.Pairing, message: String) {
    if (transferGotFirstProgress && autoResumePref() && resumeAttempts < 5 && item.state == "Sending") {
      resumeAttempts++
      sender = null
      transferGotFirstProgress = false
      reconnecting = true
      if (screen == Screen.TRANSFER) etaView?.text = "Connection lost — reconnecting (attempt $resumeAttempts)…"
      val wait = minOf(1000L shl (resumeAttempts - 1), 8000L)
      ui.postDelayed({
        if (item.state == "Sending" && activePairing == pairing) sendItem(item, pairing)
      }, wait)
      return
    }
    transferFailed("Could not reach ${pairing.ip}:${pairing.port}\n$message")
  }

  private fun recordHistory(name: String, bps: Double?, durMs: Long?, sha: String, verified: Boolean) {
    HistoryStore.record(this, HistoryStore.Entry(
      name = name, bytes = currentSize, sent = role == Role.SEND,
      atMs = System.currentTimeMillis(), sha256 = sha, verified = verified,
      speedBps = bps ?: 0.0, durationMs = durMs ?: 0L))
  }

  private fun transferFailed(message: String) {
    // Real failed-transfer record (never for benchmarks, never for user
    // cancels — cancel has its own path). status="Failed" + reason.
    if (benchModeMiB == null && currentName != null && role != Role.NONE) {
      HistoryStore.record(this, HistoryStore.Entry(
        name = currentName!!, bytes = currentSize, sent = role == Role.SEND,
        atMs = System.currentTimeMillis(), sha256 = "", verified = false,
        speedBps = 0.0, durationMs = 0L,
        status = "Failed", reason = message.lineSequence().firstOrNull()?.take(120) ?: "failed"))
    }
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
    reconnecting = false
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
      etaView?.text = if (paused) "PAUSED — connection kept alive"
        else if (reconnecting) "Reconnecting…"
        else "ETA ${UiSpeed.etaText(total - durable, bps)}"
      // Queue overall (PRIORITY 1): real bytes across the whole queue
      if (role == Role.SEND && sendQueue.size > 1) {
        val totQ = queueTotalBytes()
        val doneQ = queueBytesDone + durable
        val opct = if (totQ > 0) (doneQ * 100 / totQ).toInt() else 0
        val pos = maxOf(sendQueue.indexOfFirst { it.state == "Sending" }, 0)
        overallView?.text = "File ${pos + 1} of ${sendQueue.size} — overall $opct%"
      }
      // Truthful foreground notification (same math as the JSON export)
      currentName?.let { TransferService.notifyProgress(this, it, durable, total, bps) }
    }
  }

  // ---- receiver callbacks (transfer continues even on other screens) ----
  override fun onOffer(offer: Offer): Boolean {
    // RESUME (Phase 3): a REPEAT OFFER of the same file+size within the SAME
    // receiver session is the sender reconnecting after a connection drop.
    // The session token already authenticated this exact sender at HELLO,
    // and the user already accepted this exact file — resume without a
    // second consent prompt. Unknown/new files ALWAYS ask.
    val key = "${offer.name}|${offer.sizeBytes}"
    if (key == acceptedOfferKey && receiver != null && localEndpoint != null) {
      runOnUiThread {
        currentName = offer.name
        currentSize = offer.sizeBytes
        transferGotFirstProgress = false
        beginTransfer()
        toast("Resuming ${offer.name} from durable offset")
      }
      return true
    }
    // TRUSTED AUTO-ACCEPT (v1.4): only when the sender's stable identity is
    // known from REAL beacon packets AND that device is in the local trust
    // store AND the user turned auto-accept on. Anything less → normal sheet.
    if (autoAcceptPref()) {
      val peer = peerIdentity()
      if (peer != null && isTrusted(peer.deviceId)) {
        acceptedOfferKey = key
        runOnUiThread {
          currentName = offer.name
          currentSize = offer.sizeBytes
          transferGotFirstProgress = false
          beginTransfer()
          toast("Auto-accepted from trusted ${peer.deviceName}")
        }
        return true
      }
    }
    val queue = ArrayBlockingQueue<Boolean>(1)
    runOnUiThread {
      currentName = offer.name
      currentSize = offer.sizeBytes
      onOfferUi(offer) { decision ->
        if (decision) acceptedOfferKey = key
        queue.offer(decision); runOnUiThread { render() }
      }
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

  /**
   * History actions (§7): detail + OPEN / SHARE / DELETE / RETRY — every
   * action gated on REAL state (file on disk, real failure record).
   */
  private fun historyActions(e: HistoryStore.Entry) {
    val f = File(File(getExternalFilesDir(null) ?: filesDir, "downloads"), e.name)
    val details = buildString {
      append(SpeedFormat.bytesText(e.bytes)).append(if (e.sent) "  ·  Sent" else "  ·  Received")
      append("  ·  ").append(HistoryStore.dayLabel(e.atMs))
      if (e.status != "Failed") {
        append("\n").append(UiSpeed.speedText(e.speedBps)).append("  ·  ")
          .append(UiSpeed.durationText(e.durationMs))
        append("\nSHA-256: ").append(if (e.verified) "VERIFIED" else "unverified")
      } else {
        append("\nStatus: FAILED")
        if (e.reason.isNotEmpty()) append("\n").append(e.reason)
      }
    }
    // NOTE: appcompat's AlertDialog silently drops the item list when a
    // message is also set (verified live: title+message rendered, items
    // didn't), so the action list is a custom view in the app's own style.
    val box = col().apply { setPadding(dp(6), dp(14), dp(6), dp(4)) }
    box.addView(textView(e.name, 17f, D.TEXT, 700, 1).apply {
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    })
    box.addView(textView(details, 12.5f, D.MUTED, 500).apply {
      setPadding(0, dp(8), 0, dp(4))
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    })
    val dlg = AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog)
      .setView(box)
      .setPositiveButton("Close", null)
      .create()
    fun act(label: String, fn: () -> Unit) {
      box.addView(TextView(this).apply {
        text = label
        setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 13.5f)
        typeface = Fonts.sora(this@MainActivity, 600)
        letterSpacing = 0.04f
        setTextColor(D.PRIMARY)
        gravity = Gravity.CENTER
        includeFontPadding = false
        isClickable = true
        background = android.graphics.drawable.GradientDrawable().apply {
          setStroke(dp(1), D.argb(64, D.PRIMARY))
          cornerRadius = dp(12).toFloat()
        }
        setOnClickListener { dlg.dismiss(); fn() }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44)).apply {
          topMargin = dp(8)
        }
      })
    }
    if (!e.sent && e.status != "Failed" && f.exists()) {
      act("Open file") { openFile(f) }
      act("Share") { shareFile(f) }
    }
    if (e.status == "Failed") {
      act(if (e.sent) "Retry — send again" else "Retry — receive again") {
        if (e.sent) { screen = Screen.SEND; render(); toast("Re-select the file(s), then scan the receiver's QR") }
        else startReceiving()
      }
    }
    act("Delete record") {
      HistoryStore.delete(this, e.atMs, e.name)
      toast("Record deleted")
      render()
    }
    dlg.show()
  }

  /** Real SHARE of a received file via FileProvider (never a copy to RAM). */
  private fun shareFile(f: File) {
    try {
      val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
      val ext = f.extension.lowercase()
      val mime = android.webkit.MimeTypeMap.getSingleton()
        .getMimeTypeFromExtension(ext) ?: "application/octet-stream"
      startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
        type = mime
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }, "Share ${f.name}"))
    } catch (_: Exception) { toast("No app can share this file type") }
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
          if (sendQueue.isNotEmpty()) launchScan("Scan the receiver's NexDrop QR") else { screen = Screen.SEND; render() }
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
    private const val KEY_AUTO_RESUME = "auto_resume"
    private const val KEY_AUTO_ACCEPT = "auto_accept"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_TRUSTED = "trusted_devices"
    private const val REQ_NOTIF = 2
    private const val REQ_CAMERA = 3
  }
}
