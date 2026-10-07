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
import com.nexdrop.ndt1.ui.SpeedGraphView
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
class MainActivity : AppCompatActivity(), TurboReceiver.Listener, SendQueueController.Host {

  private enum class Screen { WELCOME, HOME, SEND, RECEIVE, TRANSFER, RESULT, FAILED, UNAVAILABLE, DEVICES, HISTORY, SETTINGS, DEVICE_TEST }
  private enum class Role { NONE, SEND, RECEIVE }

  // v1.5 HARDENING: transfer state is PROCESS-scoped (companion singletons).
  // An Activity recreation (theme flip, memory pressure, lifecycle) used to
  // build a SECOND SendQueueController + engine owner next to the live one —
  // the exact source of duplicate-completion, terminal-race and lifecycle
  // failures on the owner's physical tests. One process, one controller,
  // one engine; the recreated Activity rebinds and rehydrates from truth.
  private var screen: Screen
    get() = appScreen
    set(v) { appScreen = v }
  private var role: Role
    get() = appRole
    set(v) { appRole = v }

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
  private var receiver: TurboReceiver?
    get() = appReceiver
    set(v) { appReceiver = v }
  private var sender: TurboSender?
    get() = appSender
    set(v) { appSender = v }
  private var transferStartNanos = 0L
  private var paused: Boolean
    get() = appTransferPaused
    set(v) { appTransferPaused = v }
  private var pendingPairing: QrPairing.Pairing? = null
  private var benchModeMiB: Int?
    get() = appBenchModeMiB
    set(v) { appBenchModeMiB = v }
  private var localEndpoint: LocalNet.Endpoint? = null
  private var peerIp: String?
    get() = appPeerIp
    set(v) { appPeerIp = v }
  private var currentFile: File?
    get() = appCurrentFile
    set(v) { appCurrentFile = v }
  private var currentName: String?
    get() = appCurrentName
    set(v) { appCurrentName = v }
  private var currentSize: Long
    get() = appCurrentSize
    set(v) { appCurrentSize = v }
  private var completedSha: String?
    get() = appCompletedSha
    set(v) { appCompletedSha = v }
  private var completedStats: ThroughputSampler.Stats?
    get() = appCompletedStats
    set(v) { appCompletedStats = v }
  /** v1.5 Phase E: max sustained peak across the whole queue session —
   *  the RESULT screen shows session aggregates, not the last file's. */
  private var queuePeakBps: Double?
    get() = appQueuePeakBps
    set(v) { appQueuePeakBps = v }
  /** v1.5 Phase F: the received text of the last single .txt receive (bounded
   *  by TextSharePolicy; cleared at every fresh transfer — no stale leak). */
  private var incomingText: String?
    get() = appIncomingText
    set(v) { appIncomingText = v }
  /** v1.5 Phase F: History filter chip state (ALL | SENT | RECEIVED | FAILED | CANCELLED). */
  private var historyFilter: String
    get() = appHistoryFilter
    set(v) { appHistoryFilter = v }
  private var transferGotFirstProgress: Boolean
    get() = appTransferGotFirstProgress
    set(v) { appTransferGotFirstProgress = v }

  // ---- SEND QUEUE (v1.5 Phase D): the ordered queue, per-file state
  //      machine, byte-based aggregate progress, bounded retry, cancel/
  //      pause and failure isolation live in SendQueueController (pure
  //      Kotlin, fully JVM-tested). This class is only the Host: UI +
  //      engine bridge. Sequential independent NDT1 streams — one file at
  //      a time, each through the full OFFER/accept/SHA flow on the
  //      receiver. URI + metadata only, never bytes. ----
  private val queue: SendQueueController
    get() = appQueue ?: SendQueueController(this).also { appQueue = it }
  /** Read-only view for list-style call sites; mutations go through the controller. */
  private val sendQueue get() = queue.items
  /** v1.5 Phase C: bounded async previews — one low-priority worker, LRU cache, never on a transfer thread. */
  private val previews by lazy { PreviewProvider(applicationContext) }
  private var activePairing: QrPairing.Pairing?
    get() = appActivePairing
    set(v) { appActivePairing = v }
  /** Queue session wall clock (honest RESULT duration). */
  private var queueSessionStartNanos: Long
    get() = appQueueSessionStartNanos
    set(v) { appQueueSessionStartNanos = v }
  /** Drain result for the RESULT screen (counts + real session duration). */
  private var queueResult: Pair<SendQueueController.Summary, Long>?
    get() = appQueueResult
    set(v) { appQueueResult = v }
  @Volatile private var acceptedOfferKey: String? = null

  // ---- v1.5 HARDENING (physical test 6): receiver EOF watchdog.
  // The frozen NDT1 engine exits its receive loop SILENTLY when the sender
  // closes the socket mid-transfer (break@loop — no terminal callback), so
  // the UI/foreground service kept claiming an active transfer after a
  // sender-side Cancel. Protocol stays frozen; the app owns the recovery:
  // 9 s without progress while receiving and not paused ⇒ the session is
  // closed from the other end ⇒ honest ABORT, part file kept (resume-safe),
  // receiver stays listening, NO history record (it is neither a completed
  // nor a failed transfer of this device).
  private fun rxWatchdogTick() {
    if (!appRxWatchdogArmed) return
    ui.postDelayed({
      if (!appRxWatchdogArmed) return@postDelayed
      val active = role == Role.RECEIVE && currentName != null && benchModeMiB == null
      val stale = System.currentTimeMillis() - appLastRxProgressMs > 9_000
      if (active && stale && !appTransferPaused) {
        appRxWatchdogArmed = false
        hideTransferUi()
        TransferService.stop(this)
        toast("Connection closed — partial file kept, resumable if the sender reconnects")
        screen = Screen.RECEIVE; render()
      } else rxWatchdogTick() // re-arm while a receive is live
    }, 3_000)
  }

  private fun rxWatchdogArm() {
    appLastRxProgressMs = System.currentTimeMillis()
    if (appRxWatchdogArmed) return
    appRxWatchdogArmed = true
    rxWatchdogTick()
  }

  private fun rxWatchdogDisarm() { appRxWatchdogArmed = false }

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

  private fun queueTotalBytes(): Long = queue.totalBytes

  private fun addToQueue(uri: Uri, displayOverride: String?, quiet: Boolean = false): Boolean {
    val meta = FileMeta.load(this, uri)
    val name = displayOverride ?: meta?.name ?: run {
      if (!quiet) toast("Cannot read that file")
      return false
    }
    val size = meta?.size ?: -1L
    if (size <= 0) { if (!quiet) toast("Cannot read $name"); return false }
    // v1.5 Phase D: duplicate protection + honest add live in the controller.
    val res = queue.add(SendQueueController.QueueItem(
      uri.toString(), name, size,
      meta?.kind ?: FileMeta.classify(meta?.mime, name), meta?.mime, meta?.lastModified ?: -1L))
    if (res.skipped > 0) {
      if (!quiet) toast("$name already in queue")
      return false
    }
    return true
  }

  /**
   * v1.5 Phase B batch add — the picker and the Android Share Sheet share
   * this exact path. Small batches resolve inline (instant); >20 URIs
   * resolve metadata OFF the UI thread (a 100+ file share must not jank or
   * double-query), then commit in ONE UI update. URI references only.
   */
  private fun addUrisBatch(uris: List<Uri>, fromShareSheet: Boolean = false) {
    if (uris.isEmpty()) { if (fromShareSheet) toast("Nothing shareable in that request"); return }
    if (uris.size <= 20) {
      var added = 0
      uris.forEach { u ->
        try { contentResolver.takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
        if (addToQueue(u, null, quiet = true)) added++
      }
      finishBatchAdd(added, uris.size, fromShareSheet)
      return
    }
    // (>20 URIs branch below resolves metadata off-thread)
    toast("Reading ${uris.size} files…")
    thread {
      val pairs = uris.mapNotNull { u ->
        try { contentResolver.takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
        FileMeta.load(this, u)?.let { u to it }
      }
      runOnUiThread {
        val toAdd = pairs.mapNotNull { (u, m) ->
          if (m.size > 0) SendQueueController.QueueItem(u.toString(), m.name, m.size, m.kind, m.mime, m.lastModified) else null
        }
        val res = queue.addBatch(toAdd)
        finishBatchAdd(res.added, uris.size, fromShareSheet, res.skipped)
      }
    }
  }

  private fun finishBatchAdd(added: Int, total: Int, fromShareSheet: Boolean, skipped: Int = 0) {
    if (added == 0) {
      toast(if (total == 1) "Could not read that file — it may no longer be accessible"
            else "Could not read those files — they may no longer be accessible")
      return
    }
    val n = sendQueue.size
    toast(when {
      skipped > 0 -> "Added $added of $total — $skipped duplicates skipped — $n in queue"
      added < total -> "Added $added of $total — $n in queue"
      added == 1 -> "Added to the send queue — $n total"
      else -> "Added $added files — $n in queue"
    })
    if (fromShareSheet) goRoot(Screen.SEND)
    else if (screen != Screen.SEND) { screen = Screen.SEND; render() } else render()
  }

  /** Real icon per classified kind — taxonomy only, never a fake preview. */
  private fun kindIcon(kind: FileKind): Int = when (kind) {
    FileKind.IMAGE -> R.drawable.ic_img
    FileKind.VIDEO -> R.drawable.ic_vid
    FileKind.AUDIO -> R.drawable.ic_file
    FileKind.PDF, FileKind.DOC -> R.drawable.ic_doc
    FileKind.APK -> R.drawable.ic_app
    FileKind.ARCHIVE -> R.drawable.ic_more
    FileKind.OTHER -> R.drawable.ic_file
  }

  private fun kindLabel(kind: FileKind): String = when (kind) {
    FileKind.IMAGE -> "Image"; FileKind.VIDEO -> "Video"; FileKind.AUDIO -> "Audio"
    FileKind.PDF -> "PDF"; FileKind.APK -> "App"; FileKind.ARCHIVE -> "Archive"
    FileKind.DOC -> "Document"; FileKind.OTHER -> "File"
  }

  /**
   * v1.5 Phase C queue subline: size · [duration/label when real] · MIME.
   * Always real metadata — durations/labels arrive only from an actual
   * PreviewResult, never guessed.
   */
  private fun queueSub(item: SendQueueController.QueueItem, index: Int, extra: String? = null): TextView {
    val parts = ArrayList<String>()
    parts.add(SpeedFormat.bytesText(item.size))
    extra?.let { parts.add(it) }
    parts.add(item.mime ?: kindLabel(item.kind))
    parts.add("#${index + 1}")
    return sm(parts.joinToString("  ·  "))
  }

  private fun durText(ms: Long): String {
    val s = ms / 1000
    return "%d:%02d".format(s / 60, s % 60)
  }

  /**
   * Queue-row preview surface: starts as the typed kind icon (Phase B);
   * the async bounded preview swaps in a REAL thumbnail when one exists.
   * Corrupted/unreadable content keeps the honest icon — never blank,
   * never faked.
   */
  private fun previewBox(item: SendQueueController.QueueItem, index: Int, sub: TextView): android.widget.FrameLayout {
    val uriObj = Uri.parse(item.uri)
    val key = previewCacheKey(item.uri, item.size, item.lastModified)
    val frame = android.widget.FrameLayout(this).apply {
      layoutParams = LinearLayout.LayoutParams(dp(44), dp(44))
      background = GlassSurface()
      clipToOutline = true
      tag = key
      contentDescription = "Preview: ${item.name}"
    }
    frame.addView(ImageView(this).apply {
      setImageResource(kindIcon(item.kind))
      imageTintList = android.content.res.ColorStateList.valueOf(D.MUTED)
      layoutParams = android.widget.FrameLayout.LayoutParams(dp(44), dp(44), Gravity.CENTER)
      setPadding(dp(11), dp(11), dp(11), dp(11))
      scaleType = ImageView.ScaleType.FIT_CENTER
    })
    previews.request(uriObj, item.size, item.lastModified, item.kind, item.mime) { res ->
      // The row may have been rebuilt by a later render() — only the row
      // whose frame still carries this key is updated.
      if (frame.tag != key || frame.parent == null) return@request
      when (res) {
        is PreviewResult.ImagePreview -> applyThumb(frame, res.bitmap)
        is PreviewResult.PdfPreview -> applyThumb(frame, res.page)
        is PreviewResult.VideoPreview -> {
          applyThumb(frame, res.frame)
          sub.text = queueSub(item, index, durText(res.durationMs)).text
        }
        is PreviewResult.AudioPreview ->
          if (res.durationMs > 0) sub.text = queueSub(item, index, durText(res.durationMs)).text
        is PreviewResult.ApkPreview -> {
          res.icon?.let { applyThumb(frame, it) }
          if (res.label.isNotEmpty()) {
            val label = res.label + if (res.versionName.isNotEmpty()) " ${res.versionName}" else ""
            sub.text = queueSub(item, index, label).text
          }
        }
        else -> {} // TypedIcon/Unavailable: the honest typed icon already shows
      }
    }
    return frame
  }

  private fun applyThumb(frame: android.widget.FrameLayout, bmp: android.graphics.Bitmap) {
    frame.removeAllViews()
    frame.addView(ImageView(this).apply {
      setImageBitmap(bmp)
      scaleType = ImageView.ScaleType.FIT_CENTER
      layoutParams = android.widget.FrameLayout.LayoutParams(
        android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
        android.widget.FrameLayout.LayoutParams.MATCH_PARENT)
    })
  }

  /** SAF folder → real recursive file queue (streamed, bounded RAM). */
  private fun queueFolder(tree: Uri) {
    thread {
      try {
        val root = DocumentFile.fromTreeUri(this, tree) ?: return@thread
        val items = ArrayList<SendQueueController.QueueItem>()
        fun walk(dir: DocumentFile, path: String) {
          dir.listFiles().forEach { d ->
            val rel = if (path.isEmpty()) d.name ?: "?" else "$path/${d.name ?: "?"}"
            if (d.isDirectory) walk(d, rel)
            else if (d.isFile && (d.name ?: "").isNotEmpty() && d.length() > 0) {
              items.add(SendQueueController.QueueItem(d.uri.toString(), rel, d.length(), FileMeta.classify(null, d.name), null, -1L))
            }
          }
        }
        walk(root, "")
        runOnUiThread {
          if (items.isEmpty()) { toast("No files in that folder"); return@runOnUiThread }
          val res = queue.addBatch(items)
          toast("Folder queued — ${res.added} files, ${SpeedFormat.bytesText(items.sumOf { it.size })}" +
            if (res.skipped > 0) " · ${res.skipped} duplicates skipped" else "")
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

  /** Real device name shown to other devices (QR + NDD1 beacon). */
  fun deviceLabel(): String =
    getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_DEVICE_NAME, null)?.takeIf { it.isNotBlank() } ?: Build.MODEL

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
      appDiscoveryBindError = null
      beaconIdentity = DiscoveryBeacon(deviceLabel(), "android", 0,
        SessionToken(ByteArray(0), "", ""), deviceIdPref()).also {
        it.start({ peers -> onBeaconPeers(peers) })
      }
    } catch (e: Exception) {
      beaconIdentity = null
      // v1.5 HARDENING (test 18): NEVER silently swallow a discovery failure —
      // the Send screen shows the exact reason and QR pairing remains.
      appDiscoveryBindError = (e.message ?: e.javaClass.simpleName).take(120)
    }
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
    } catch (e: Exception) {
      beaconSession = null
      appDiscoveryBindError = (e.message ?: e.javaClass.simpleName).take(120) // honest: shown, not swallowed
    } // QR pairing unaffected
  }

  private fun stopSessionBeacon() {
    beaconSession?.stop(); beaconSession = null
    if (beaconIdentity == null) releaseMulticastLock()
  }

  /** Pair to a REAL discovered receiver — same path as a scanned QR. */
  private fun pairFromDiscovery(p: SeenPeer) {
    if (!queue.hasQueued()) { toast("Choose files first — then tap the device again"); return }
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

  /** v1.4 Phase 6 — appearance: system (default) / light / dark. */
  private fun themePref(): String =
    getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_THEME, "system") ?: "system"

  private fun systemIsLightNow(): Boolean {
    val m = resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK
    return m != android.content.res.Configuration.UI_MODE_NIGHT_YES
  }

  private fun themeIsLight(): Boolean = when (themePref()) {
    "light" -> true
    "dark" -> false
    else -> systemIsLightNow()
  }

  /** Apply the theme before ANY view/token read; also repaint system bars. */
  private fun applyThemeNow() {
    D.apply(themeIsLight())
    window.statusBarColor = D.BG
    window.navigationBarColor = D.BG
  }

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
  private var speedGraph: SpeedGraphView? = null
  // real-sample throttle: graph <=4 Hz, notification <=1 Hz (never competes
  // with the NDT1 transport for CPU; values stay REAL, just cadence-limited)
  private var lastGraphSampleMs = 0L
  private var lastGraphDurable = -1L
  private var lastNotifMs = 0L

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
    addUrisBatch(uris)
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
    applyThemeNow()
    val welcomed = getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_WELCOMED, false)
    screen = if (welcomed) Screen.HOME else Screen.WELCOME
    // v1.5 HARDENING: after a recreation, reattach to the ONE live transfer
    // instead of starting a second one. The controller is the authority.
    val q = appQueue
    q?.rebindHost(this)
    if (appRole != Role.NONE && (q?.current != null || appReceiver != null || appSender != null)) {
      screen = Screen.TRANSFER // same session, same numbers, no duplicate job
    } else if (q != null && (q.hasQueued() || q.isPaused)) {
      screen = Screen.SEND // a live queue survives the recreation
    }
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
    // v1.5 Phase B: shared files take the SAME batch path as picker files —
    // one metadata query per URI, off-thread for large shares. Text-only
    // shares are not silently converted to files; first-class text sharing
    // arrives in the v1.5 text phase.
    addUrisBatch(uris, fromShareSheet = true)
  }

  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    // System dark/light flipped while we're alive (uiMode is in
    // configChanges, so no recreation): re-skin only when following system.
    if (themePref() == "system") { applyThemeNow(); render() }
  }

  override fun onDestroy() {
    ticker?.let { ui.removeCallbacks(it) }
    stopIdentityBeacon()
    stopSessionBeacon()
    releaseMulticastLock()
    // v1.5 Phase C: the queue is gone — release queued preview jobs
    // (generation bump) and evict the bounded thumbnail cache. Never
    // throws: preview teardown is best-effort and engine-independent.
    runCatching { previews.cancelAll() }
    super.onDestroy()
  }

  // ================= rendering scaffold =================

  private fun render() {
    if (isFinishing || isDestroyed) return // zombie guard: only the live Activity renders
    ticker?.let { ui.removeCallbacks(it); ticker = null }
    qrView = null; ring = null; ringPct = null; ringBytes = null; speedView = null; speedUnitView = null; etaView = null; pauseBtn = null; speedGraph = null
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

  /** Per-queue-item row: preview, name+size, truthful state pill, remove, tap = actions. */
  private fun queueRow(item: SendQueueController.QueueItem, index: Int): View {
    // Truthful subline per state (§9/§15): real bytes while transferring,
    // the honest error when failed, real verification when completed.
    val stateExtra = when (item.state) {
      SendQueueController.QState.COMPLETED -> "SHA-256 VERIFIED"
      SendQueueController.QState.FAILED -> "FAILED · ${item.error?.lineSequence()?.firstOrNull()?.take(64) ?: "error"}" +
        (if (item.retryCount > 0) " · after ${item.retryCount} attempt(s)" else "")
      SendQueueController.QState.CANCELLED -> "CANCELLED"
      else -> null
    }
    val r = glassCard(pad = 12f).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      val sub = queueSub(item, index, stateExtra)
      addView(previewBox(item, index, sub))
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
      val t = col().apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f } }
      t.addView(textView(item.name, 13f, D.TEXT, 700).apply {
        maxLines = 2
        ellipsize = android.text.TextUtils.TruncateAt.END
      })
      t.addView(sub)
      addView(t)
      // v1.5 HARDENING (test 12): VISIBLE reorder affordance — not buried
      // in the tap dialog. Only QUEUED items may move; the active transfer
      // and terminal states are guarded by the controller (JVM-tested).
      if (item.state == SendQueueController.QState.QUEUED) {
        val mover = col().apply { gravity = Gravity.CENTER_VERTICAL }
        listOf(true to "Move ${item.name} up", false to "Move ${item.name} down").forEach { (up, desc) ->
          mover.addView(ImageView(this@MainActivity).apply {
            setImageResource(R.drawable.ic_down) // same glyph; 180° = up
            if (up) rotation = 180f
            imageTintList = android.content.res.ColorStateList.valueOf(D.MUTED)
            layoutParams = LinearLayout.LayoutParams(dp(34), dp(32))
            setPadding(dp(6), dp(4), dp(6), dp(4))
            contentDescription = desc
            setOnClickListener { queue.move(item, up = up); render() }
          })
        }
        addView(mover)
      }
      if (!item.isBusy) {
        addView(ImageView(this@MainActivity).apply {
          setImageResource(R.drawable.ic_x)
          imageTintList = android.content.res.ColorStateList.valueOf(D.MUTED)
          layoutParams = LinearLayout.LayoutParams(dp(36), dp(36))
          setPadding(dp(8), dp(8), dp(8), dp(8))
          contentDescription = "Remove ${item.name}"
          setOnClickListener {
            if (queue.remove(item)) toast("Removed from queue") else toast("Cancel the transfer first, then remove")
            render()
          }
        })
      }
      addView(pill(stateLabel(item.state), tint = stateTint(item.state)))
      setOnClickListener { queueItemActions(item) }
    }
    return r
  }

  private fun stateLabel(st: SendQueueController.QState): String = when (st) {
    SendQueueController.QState.QUEUED -> "Queued"
    SendQueueController.QState.TRANSFERRING -> "Sending"
    SendQueueController.QState.PAUSED -> "Paused"
    SendQueueController.QState.RETRYING -> "Retrying"
    SendQueueController.QState.COMPLETED -> "Completed"
    SendQueueController.QState.FAILED -> "Failed"
    SendQueueController.QState.CANCELLED -> "Cancelled"
  }

  private fun stateTint(st: SendQueueController.QState): Int = when (st) {
    SendQueueController.QState.COMPLETED -> D.OK
    SendQueueController.QState.FAILED -> D.DANGER
    SendQueueController.QState.TRANSFERRING, SendQueueController.QState.RETRYING -> D.PRIMARY
    SendQueueController.QState.PAUSED, SendQueueController.QState.CANCELLED -> D.MUTED
    else -> D.BLUE
  }

  /**
   * Tap a queued file: reorder / remove / retry — real queue management
   * with hardened rules (§10/§11/§12): a busy item can only be cancelled,
   * never reordered into an invalid state or silently removed; a failed
   * item gets a real manual RETRY through the same engine + SHA flow.
   */
  private fun queueItemActions(item: SendQueueController.QueueItem) {
    val opts = ArrayList<String>()
    if (!item.isBusy) {
      if (sendQueue.indexOf(item) > 0) opts.add("Move up")
      if (sendQueue.indexOf(item) < sendQueue.size - 1) opts.add("Move down")
    }
    if (item.state == SendQueueController.QState.FAILED) opts.add("Retry")
    if (!item.isBusy) opts.add("Remove")
    if (item.isBusy) opts.add("Cancel transfer")
    AlertDialog.Builder(this, dialogTheme())
      .setTitle(item.name)
      .setItems(opts.toTypedArray()) { _, which ->
        when (val chosen = opts[which]) {
          "Move up" -> queue.move(item, up = true)
          "Move down" -> queue.move(item, up = false)
          "Retry" -> if (activePairing == null) {
            queue.retry(item) // re-armed; the next scan/device tap starts it
            toast("Re-queued — scan or tap the device to send")
          } else queue.retry(item)
          "Remove" -> if (queue.remove(item)) toast("Removed from queue")
          "Cancel transfer" -> cancelTransfer()
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
      Triple(R.drawable.ic_file, "Audio", "audio/*"),
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

    // v1.5 Phase F: quick action — Text. Same queue, same one protocol:
    // the text becomes a real small .txt on the existing SendQueueController.
    content.addView(glassCard(pad = 10f).apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(8) }
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      addView(ImageView(this@MainActivity).apply {
        setImageResource(R.drawable.ic_txt)
        imageTintList = android.content.res.ColorStateList.valueOf(D.PRIMARY)
        layoutParams = LinearLayout.LayoutParams(dp(20), dp(20))
      })
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
      addView(textView("SEND TEXT", 12f, D.TEXT, 700, 1).apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f } })
      addView(pill("LOCAL"))
      setOnClickListener { sendTextFlow() }
      contentDescription = "Send text"
    })

    // SEND QUEUE (v1.5 Phase D): honest summary (§8), per-item states,
    // reorder/remove/retry rules, queue pause, CANCEL ALL, clear actions.
    val queued = sendQueue.toList()
    if (queued.isEmpty()) {
      content.addView(sm("No files selected").apply {
        layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(16); bottomMargin = dp(6) }
      })
    } else {
      content.addView(glassCard(pad = 12f).apply {
        layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(16); bottomMargin = dp(6) }
        addView(sm("${queued.size} file(s) · ${SpeedFormat.bytesText(queueTotalBytes())} total"))
        val done = queue.completedCount; val failed = queue.failedCount
        val rem = queue.remainingCount
        val line = buildString {
          append("$done completed · $rem remaining")
          if (failed > 0) append(" · $failed failed")
          queue.current?.let { append(" · now ${queue.currentPosition}/${queued.size}: ${it.name}") }
          if (queue.isPaused) append(" · PAUSED")
        }
        addView(sm(line).apply { setPadding(0, dp(3), 0, 0) })
      })
    }
    queued.forEachIndexed { i, item ->
      content.addView(queueRow(item, i).apply {
        layoutParams = (layoutParams as LinearLayout.LayoutParams).apply {
          if (i > 0) topMargin = dp(6)
        }
      })
    }
    if (queued.isNotEmpty()) {
      val qrow = row().apply {
        layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(8) }
      }
      if (queue.hasQueued() || queue.isPaused) {
        qrow.addView(btn(if (queue.isPaused) "RESUME QUEUE" else "PAUSE QUEUE", "text", height = 36, weight = 1f) {
          if (queue.isPaused) queue.resumeQueue() else queue.pauseQueue()
          render()
        }.apply {
          layoutParams = LinearLayout.LayoutParams(0, dp(36)).apply { weight = 1f }
          contentDescription = if (queue.isPaused) "Resume queue" else "Pause queue"
        })
        qrow.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(6), 1) })
      }
      if (queue.completedCount > 0 || queue.failedCount > 0 || queue.cancelledCount > 0) {
        qrow.addView(btn("CLEAR", "text", height = 36, weight = 1f) {
          val opts = ArrayList<String>()
          if (queue.completedCount > 0) opts.add("Clear sent (${queue.completedCount})")
          if (queue.failedCount + queue.cancelledCount > 0) opts.add("Clear failed (${queue.failedCount + queue.cancelledCount})")
          opts.add("Clear all (${queue.totalItems})")
          AlertDialog.Builder(this, dialogTheme())
            .setTitle("Clear queue")
            .setItems(opts.toTypedArray()) { _, which ->
              when (opts[which].substringBefore(" (")) {
                "Clear sent" -> { queue.clearCompleted(); toast("Cleared sent") }
                "Clear failed" -> { queue.clearFailed(); toast("Cleared failed") }
                else -> { queue.clearAll(); toast("Queue cleared") }
              }
              render()
            }
            .setNegativeButton("Close", null)
            .show()
        }.apply {
          layoutParams = LinearLayout.LayoutParams(0, dp(36)).apply { weight = 1f }
          contentDescription = "Clear queue"
        })
        qrow.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(6), 1) })
      }
      qrow.addView(btn("CANCEL ALL", "text", height = 36, weight = 1f, tintText = D.DANGER) {
        AlertDialog.Builder(this, dialogTheme())
          .setTitle("Cancel all transfers?")
          .setMessage("The current transfer stops and every unfinished file is marked cancelled. Completed files and history are kept.")
          .setPositiveButton("CANCEL ALL") { _, _ ->
            queue.cancelAll(); activePairing = null
            hideTransferUi(); TransferService.stop(this)
            toast("Queue cancelled"); render()
          }
          .setNegativeButton("Keep going", null)
          .show()
      }.apply {
        layoutParams = LinearLayout.LayoutParams(0, dp(36)).apply { weight = 1f }
        contentDescription = "Cancel all transfers"
      })
      content.addView(qrow)
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
    content.addView(btn(if (queue.remainingCount > 1) "SEND ALL (${queue.remainingCount})" else "CONTINUE", "primary") {
      if (!queue.hasQueued()) { toast("Select a file first"); return@btn }
      if (!hasPermission(Manifest.permission.CAMERA)) { askPermission(Manifest.permission.CAMERA, REQ_CAMERA); return@btn }
      launchScan("Scan the receiver's NexDrop QR")
    }.apply { layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(50)) })
    // Secondary path BELOW the primary action: the QR flow is the
    // guaranteed route; nearby discovery is a convenience below the fold.
    // NEARBY DEVICES (v1.4): real NDD1 discovery — receivers running on this
    // network appear here automatically. No peers = honest empty state, and
    // QR pairing always remains. No radar rings: Android exposes no honest
    // distance for arbitrary peers, so none is implied.
    val nearbyLbl = row().apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(16); bottomMargin = dp(6) }
    }
    nearbyLbl.addView(sm("NEARBY DEVICES").apply {
      setTextColor(D.MUTED); letterSpacing = 0.10f
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f; gravity = Gravity.CENTER_VERTICAL }
    })
    // v1.5 Phase F: explicit REFRESH — re-renders the real beacon table
    // (it also auto-updates from 1 Hz beacons; this never invents a scan).
    nearbyLbl.addView(btn("REFRESH", "text", height = 30) {
      render(); toast(if (pairablePeers().isEmpty()) "No receivers visible right now — QR pairing always works" else "${pairablePeers().size} receiver(s) visible")
    }.apply { layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(30)) })
    content.addView(nearbyLbl)
    val nearby = pairablePeers()
    content.addView(glassCard(pad = 12f).apply {
      if (nearby.isEmpty()) {
        if (beaconIdentity == null && beaconSession == null) {
          addView(textView("Discovery unavailable", 13f, D.TEXT, 700).apply { setPadding(0, 0, 0, dp(2)) })
          addView(sm(appDiscoveryBindError?.let { "Reason: $it" }
            ?: "Another local socket holds the discovery port, or multicast is blocked."))
          addView(sm("Scan the receiver's QR instead — pairing is identical."))
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
      // v1.5 HARDENING (test 18): real diagnostics — live interface, beacon
      // state, every device heard (identity-only included), bind reason.
      addView(sm("Diagnostics · interface: ${activeWifiInterface() ?: "none"} · beacon: " +
        (if (beaconIdentity != null || beaconSession != null) "listening" else "stopped") +
        " · heard ${identityByIp.size} device(s)" +
        (appDiscoveryBindError?.let { " · bind: $it" } ?: "")).apply {
        setTextColor(D.MUTED); setPadding(0, dp(8), 0, 0)
        setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 10.5f)
      })
    })

  }

  // ================= 04 RECEIVE + QR =================
  private fun startReceiving() {
    val endpoint = LocalNet.select(activeWifiInterface())
    if (endpoint == null) { screen = Screen.UNAVAILABLE; render(); return }
    val session = Handshake.newSessionToken()
    val dl = File(getExternalFilesDir(null) ?: filesDir, "downloads").apply { mkdirs() }
    receiver = TurboReceiver(session, dl, this, applicationContext) // rc6: radio lock context
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
    showQr(QrPairing.encode(session, endpoint.ip, port, deviceLabel()))
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
    // v1.5 Phase F: real available storage up front — never a guessed value.
    val rxDl = File(getExternalFilesDir(null) ?: filesDir, "downloads")
    val rxFree = try { android.os.StatFs(rxDl.path).availableBytes } catch (_: Exception) { -1L }
    if (rxFree >= 0) content.addView(sm("Storage available · ${SpeedFormat.bytesText(rxFree)} free").apply {
      setTextColor(D.MUTED)
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(2) }
    })

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
    AlertDialog.Builder(this, dialogTheme())
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
    // Honest storage check (Phase 8): real free bytes on the REAL save dir.
    val dlDir = File(getExternalFilesDir(null) ?: filesDir, "downloads")
    val availBytes = try { android.os.StatFs(dlDir.path).availableBytes } catch (_: Exception) { -1L }
    val short = availBytes >= 0 && availBytes < offer.sizeBytes
    if (short) sheet.addView(sm(
      "Not enough storage: needs ${SpeedFormat.bytesText(offer.sizeBytes)}, " +
      "only ${SpeedFormat.bytesText(availBytes)} free. Free up space and ask the sender to try again."
    ).apply { setTextColor(D.AMBER); setPadding(dp(18), dp(6), dp(18), 0) })
    btns.addView(btn("DECLINE", "outline") { decide(false) })
    btns.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
    btns.addView(btn("ACCEPT", "primary", weight = 1.4f) {
      if (short) { toast("Not enough storage for this file"); decide(false) }
      else decide(true)
    })
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
    // Queue context (v1.5 Phase D, §24): CURRENT file ring + separate
    // whole-queue line — real bytes, never a percentage average.
    if (role == Role.SEND && queue.totalItems > 1) {
      overallView = sm("QUEUE  ${queue.currentPosition}/${queue.totalItems} files · —").apply { setPadding(0, dp(2), 0, 0) }
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

    // LIVE SPEED GRAPH (Phase 4): real measured samples only, <=4 Hz,
    // drawn off the transfer path (postInvalidate + animation cadence).
    content.addView(glassCard(pad = 10f).apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(12) }
      addView(sm("SPEED — LIVE SAMPLES").apply {
        setTextColor(D.MUTED); letterSpacing = 0.10f
      })
      addView(SpeedGraphView(this@MainActivity).apply {
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(72))
        contentDescription = "Live transfer speed graph from real measured samples"
      }.also { speedGraph = it })
    })

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
      if (role == Role.SEND) queue.onTransferPaused(paused) // truthful per-file PAUSED
      render() // relabel PAUSE/RESUME from real state; ring refs rebind, engine untouched
    }.also { pauseBtn = it })
    controls.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
    controls.addView(btn("CANCEL", "outline", icon = R.drawable.ic_x, tintText = D.DANGER) { cancelTransfer() })
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
    // v1.5 Phase E: the headline itself is honest — "Transfer complete"
    // only when nothing failed; a mixed queue says so, immediately.
    val multi = queueResult?.let { (sum, _) -> sum.completed + sum.failed + sum.cancelled > 1 } ?: false
    val anyFail = queueResult?.let { (sum, _) -> sum.failed > 0 } ?: false
    head.addView(h2(
      when {
        multi && anyFail -> "Completed with failures"
        multi -> "Queue complete"
        else -> "Transfer complete"
      }))
    if (multi) {
      // Session totals — real counts, real bytes, never the last file's numbers.
      queueResult?.let { (summary, durMs) ->
        val split = buildString {
          append(if (summary.failed > 0) "${summary.completed} successful · ${summary.failed} failed"
                 else "${summary.completed} files transferred")
          if (summary.cancelled > 0) append(" · ${summary.cancelled} cancelled")
        }
        head.addView(sm("Queue session — $split · ${SpeedFormat.bytesText(summary.completedBytes)}").apply {
          gravity = Gravity.CENTER; setPadding(0, dp(6), 0, 0)
        })
        if (durMs > 0) head.addView(sm("Session duration ${UiSpeed.durationText(durMs)}").apply {
          gravity = Gravity.CENTER; setPadding(0, dp(2), 0, 0)
        })
      }
    } else {
      head.addView(textView(currentName ?: "file", 13f, D.TEXT, 700).apply {
        gravity = Gravity.CENTER; setPadding(0, dp(6), 0, 0)
      })
      val bytes = currentFile?.length() ?: currentSize
      head.addView(sm(if (bytes > 0) "${SpeedFormat.bytesText(bytes)} transferred" else "").apply { gravity = Gravity.CENTER })
    }
    content.addView(head)

    // v1.5 Phase F — INCOMING TEXT card: shown only when THIS result is a
    // fresh bounded .txt receive (cleared at every transfer start). Copy is
    // the only clipboard access and it is explicit, user-triggered.
    incomingText?.let { txt ->
      content.addView(glassCard(pad = 14f).apply {
        layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(12) }
        addView(textView("INCOMING TEXT", 12.5f, D.PRIMARY, 700, 1).apply { letterSpacing = 0.10f })
        addView(sm("${txt.length} characters · ${SpeedFormat.bytesText(txt.toByteArray().size.toLong())}").apply {
          setTextColor(D.MUTED); setPadding(0, dp(2), 0, dp(6))
        })
        addView(textView(TextSharePolicy.preview(txt), 12.5f, D.TEXT, 500).apply {
          setPadding(dp(12), dp(10), dp(12), dp(10))
          background = android.graphics.drawable.GradientDrawable().apply {
            cornerRadius = dp(12).toFloat(); setColor(D.SURFACE); setStroke(dp(1), D.LINE)
          }
        })
        val tr = row().apply { setPadding(0, dp(10), 0, 0) }
        tr.addView(btn("COPY", "outline", height = 40, weight = 1f) {
          try {
            val cm = getSystemService(android.content.ClipboardManager::class.java)
            cm.setPrimaryClip(android.content.ClipData.newPlainText("NexDrop", txt))
            toast("Copied to clipboard")
          } catch (_: Exception) { toast("Clipboard unavailable") }
        }.apply { layoutParams = LinearLayout.LayoutParams(0, dp(40)).apply { weight = 1f } })
        tr.addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(8), 1) })
        tr.addView(btn("SHARE", "outline", height = 40, weight = 1f) {
          try {
            startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
              type = "text/plain"; putExtra(Intent.EXTRA_TEXT, txt)
            }, "Share text"))
          } catch (_: Exception) { toast("No share target available") }
        }.apply { layoutParams = LinearLayout.LayoutParams(0, dp(40)).apply { weight = 1f } })
        tr.addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(8), 1) })
        tr.addView(btn("SEND AGAIN", "primary", height = 40, weight = 1f) { sendTextFlow(txt) }
          .apply { layoutParams = LinearLayout.LayoutParams(0, dp(40)).apply { weight = 1f } })
        addView(tr)
      })
    }

    // Average + Duration — SESSION aggregates for a queue (v1.5 Phase E),
    // per-file stats only for a single transfer. Both are real measured
    // numbers; the session average is completed bytes over wall clock.
    val sessionDurMs = queueResult?.second ?: 0L
    val sessionStats: ThroughputSampler.Stats? =
      if (multi && sessionDurMs > 0)
        ThroughputSampler.Stats(
          durationMs = sessionDurMs,
          bytes = queueResult?.first?.completedBytes ?: 0L,
          averageBps = queueResult?.first?.completedBytes?.let { it / (sessionDurMs / 1000.0) },
          sustainedBps = null, // session average is over wall clock; per-file numbers live in history
          peakSustainedBps = queuePeakBps,
        )
      else completedStats
    val stats = sessionStats
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

    // Phase 11: REAL conditions captured at transfer start — so every
    // benchmark number comes with its honest environmental context.
    if (runConditions.isNotEmpty()) {
      content.addView(sm(runConditions).apply {
        setTextColor(D.MUTED); gravity = Gravity.CENTER
        setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 10.5f)
        layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { bottomMargin = dp(2) }
      })
    }
    // v1.4.2 Phase 1: REAL engine profile — where the seconds actually went.
    val profileLine = if (role == Role.SEND) lastTxProfileText else lastRxProfileText
    if (profileLine.isNotEmpty()) {
      content.addView(sm(profileLine).apply {
        setTextColor(D.MUTED); gravity = Gravity.CENTER
        setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 10.5f)
        layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { bottomMargin = dp(4) }
      })
    }

    // PEAK (Phase 5): the engine's measured sustained peak — never a burst.
    val peakRow = row().apply { (layoutParams as LinearLayout.LayoutParams).bottomMargin = dp(8) }
    peakRow.addView(glassCard(pad = 14f).apply {
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f }
      addView(sm("Peak (sustained)"))
      addView(bigText(UiSpeed.speedText(stats?.peakSustainedBps), 18f).apply { setPadding(0, dp(3), 0, 0) })
    })
    // Real device names where discovery provided them; honest fallback.
    val peerName = peerIdentity()?.deviceName
    val route = when {
      role == Role.SEND && !peerName.isNullOrEmpty() -> "This device → $peerName"
      role == Role.RECEIVE && !peerName.isNullOrEmpty() -> "$peerName → This device"
      else -> "Android → Android"
    }
    peakRow.addView(glassCard(pad = 14f).apply {
      layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 1f; marginStart = dp(5) }
      addView(sm("Route"))
      addView(bigText(route, 13f).apply { setPadding(0, dp(5), 0, 0) })
    })
    content.addView(peakRow)

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
      val shaLine = queueResult?.let { (sum, _) ->
        if (sum.completed > 1) "${sum.completed} FILES SHA-256 VERIFIED" else "SHA-256 VERIFIED"
      } ?: "SHA-256 VERIFIED"
      addView(infoRow(R.drawable.ic_shield,
        textView(shaLine, 12.5f, D.OK, 700, 1), sm("")))
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(1, dp(8)) })
      addView(infoRow(R.drawable.ic_dev,
        textView("", 12.5f, D.TEXT, 700).apply { text = if (role == Role.SEND) "Android → Android" else "Android → Android" },
        sm("")))
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(1, dp(8)) })
      addView(infoRow(R.drawable.ic_wifi,
        textView("LOCAL DIRECT · Native NDT1 TCP", 12.5f, D.MUTED, 600), sm("")))
    })

    // v1.5 Phase D §25: some files failed — offer the honest RETRY FAILED
    queueResult?.let { (summary, _) ->
      if (summary.failed > 0) {
        content.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(1, 0).apply { weight = 1f } })
        content.addView(btn("RETRY FAILED (${summary.failed})", "primary", height = 44) {
          queue.retryFailed()            // FAILED → QUEUED (honest re-queue)
          startSendingLegacyScan()       // fresh pairing → same engine + SHA flow
        }.apply {
          layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44))
          contentDescription = "Retry failed files"
        })
      }
    }

    // buttons — Open/Done stay; Share summary + View history added (Phase 5)
    content.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(1, 0).apply { weight = 1f } })
    val btns = row()
    val f = currentFile
    if (f != null) btns.addView(btn("OPEN FILE", "outline") { openFile(f) })
    else btns.addView(btn("OPEN FILE", "outline") { toast("Nothing to open on this device") })
    btns.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
    btns.addView(btn("DONE", "primary") { goRoot(Screen.HOME) })
    content.addView(btns)
    content.addView(row().apply {
      setPadding(0, dp(8), 0, 0)
      addView(btn("SHARE SUMMARY", "outline", height = 44, weight = 1f) { shareSummary() }.apply {
        layoutParams = LinearLayout.LayoutParams(0, dp(44)).apply { weight = 1f }
      })
      addView(Space(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
      addView(btn("VIEW HISTORY", "outline", height = 44, weight = 1f) { go(Screen.HISTORY) }.apply {
        layoutParams = LinearLayout.LayoutParams(0, dp(44)).apply { weight = 1f }
      })
    })
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
      setting(R.drawable.ic_sun, "Appearance", themePref().replaceFirstChar { it.uppercase() }) { go(Screen.SETTINGS) }
      setting(R.drawable.ic_spd, "Diagnostics", "Open") { go(Screen.DEVICE_TEST) }
    })
    // v1.4 sections follow the v1.3.0 core — below the fold on small
    // screens, reachable by scroll. Core content (recent transfers +
    // settings shortcuts) stays where the smoke and the mockup expect it.
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
      srow(this, R.drawable.ic_swap, "Group drop", "Not supported — one receiver per session") {
        AlertDialog.Builder(this@MainActivity, dialogTheme()).setTitle("Group drop")
          .setMessage("Honest status: not supported. The exact architectural blocker: a group send would need one authenticated NDT1 session per receiver, driven by a SECOND orchestration layer next to the single SendQueueController — while this milestone's rules (one queue, one orchestration, no second transfer system) keep that out of scope. We will not fake it with simulated multi-device rows.")
          .setPositiveButton("Close", null).show()
      }
      srow(this, R.drawable.ic_dev, "NFC pairing", "Unavailable — Android Beam was removed in Android 10+")
      srow(this, R.drawable.ic_wifi, "Hotspot mode", "Unavailable — Android reserves tethering control to system apps")
    })

    nav(2)
  }

  private fun historyRow(e: HistoryStore.Entry, onTap: ((HistoryStore.Entry) -> Unit)? = null): View {
    val r = row()
    r.addView(ImageView(this).apply {
      setImageResource(if (e.status in listOf("Failed", "Cancelled")) R.drawable.ic_x else R.drawable.ic_check)
      imageTintList = android.content.res.ColorStateList.valueOf(
        when (e.status) { "Failed" -> D.DANGER; "Cancelled" -> D.AMBER; else -> D.OK })
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
    // v1.5 Phase F: a real resumed record says so — durable-offset truth.
    if (e.resumed) right.addView(pill("RESUMED").apply {
      gravity = Gravity.END; setPadding(0, 0, 0, dp(2))
    })
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
    val all = HistoryStore.list(this).sortedByDescending { it.atMs }
    // v1.5 Phase F: filter chips over REAL records — every category is a
    // truthful record kind; a filter with no records says so honestly.
    val chipsRow = row().apply {
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(10); bottomMargin = dp(4) }
    }
    listOf("ALL" to all.size, "SENT" to all.count { it.sent }, "RECEIVED" to all.count { !it.sent },
      "FAILED" to all.count { it.status == "Failed" }, "CANCELLED" to all.count { it.status == "Cancelled" }
    ).forEach { (label, n) ->
      chipsRow.addView(btn(if (historyFilter == label) label else "$label $n",
        if (historyFilter == label) "primary" else "outline", height = 30, weight = 1f) {
        historyFilter = label; render()
      }.apply {
        layoutParams = LinearLayout.LayoutParams(0, dp(30)).apply { weight = 1f }
        if (historyFilter != label) alpha = 0.85f
      })
      chipsRow.addView(Space(this).apply { layoutParams = LinearLayout.LayoutParams(dp(4), 1) })
    }
    content.addView(chipsRow)
    val history = HistoryStore.matching(all, historyFilter)
    val done = all.count { it.status !in listOf("Failed", "Cancelled") }
    val cancelled = all.count { it.status == "Cancelled" }
    content.addView(sm(when {
      all.isEmpty() -> "No transfers yet"
      else -> buildString {
        append("$done completed")
        val f = all.count { it.status == "Failed" }; if (f > 0) append(" · $f failed")
        if (cancelled > 0) append(" · $cancelled cancelled")
        val r = all.count { it.resumed }; if (r > 0) append(" · $r resumed")
      }
    }).apply {
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
      srow(this, R.drawable.ic_wifi, "Wi-Fi / Hotspot", "Auto — same network")
      srow(this, R.drawable.ic_file, "Save location", "App storage · downloads")
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

    section("PREFERENCES")
    content.addView(glassCard(pad = 12f).apply {
      srow(this, R.drawable.ic_sun, "Appearance", themePref().replaceFirstChar { it.uppercase() }) {
        val next = when (themePref()) { "system" -> "light"; "light" -> "dark"; else -> "system" }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_THEME, next).apply()
        applyThemeNow(); render()
        toast(when (next) {
          "system" -> "Following system dark/light"
          "light" -> "Light theme"
          else -> "Dark theme" })
      }
      srow(this, R.drawable.ic_gear, "Language", "Follows system")
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
      srow(this, R.drawable.ic_dev, "Trusted devices", if (trustedDevices().isEmpty()) "None yet" else "${trustedDevices().size} trusted") { go(Screen.DEVICES) }
      srow(this, R.drawable.ic_qr, "QR pairing expiry", "${Ndt1.AUTH_TTL_MS / 60000} minutes — single-use token")
      srow(this, R.drawable.ic_lock, "App lock", "Not in v1.4") {
        toast("App lock is planned for a later version — not implemented yet")
      }
      srow(this, R.drawable.ic_dev, "Cloud upload", "None")
      srow(this, R.drawable.ic_dev, "Accounts", "Not required")
      srow(this, R.drawable.ic_swap, "Clear session data", "Clear") {
        stopReceiving(); peerIp = null; localEndpoint = null; acceptedOfferKey = null
        toast("Session data cleared"); render()
      }
    })

    section("DEVICE")
    content.addView(glassCard(pad = 12f).apply {
      srow(this, R.drawable.ic_dev, "Device name", deviceLabel()) {
        val input = EditText(this@MainActivity).apply {
          setText(deviceLabel()); setTextColor(D.TEXT); setHintTextColor(D.MUTED)
          setPadding(dp(16), dp(12), dp(16), dp(12))
        }
        AlertDialog.Builder(this@MainActivity, android.R.style.Theme_Material_Dialog)
          .setTitle("Device name")
          .setView(input)
          .setPositiveButton("Save") { _, _ ->
            val nm = input.text.toString().trim().take(40)
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
              .putString(KEY_DEVICE_NAME, nm.ifBlank { null }).apply()
            toast("Device name updated — QR and nearby discovery now show it")
            render()
          }
          .setNegativeButton("Cancel", null).show()
      }
      srow(this, R.drawable.ic_qr, "Visibility", "Discoverable while Receive or Send is open")
      srow(this, R.drawable.ic_bell, "Discovery status",
        when { beaconSession != null -> "Advertising — receivers can find you"
               beaconIdentity != null -> "Browsing — looking for receivers"
               else -> "Idle — not discoverable" })
    })

    section("SYSTEM")
    content.addView(glassCard(pad = 12f).apply {
      srow(this, R.drawable.ic_file, "Storage", "Downloads · App storage") { /* STORAGE section below has the live numbers */ }
      srow(this, R.drawable.ic_check, "Clear cache", "App cache only — transfers untouched") {
        val before = cacheDir.walkBottomUp().filter { it.isFile }.sumOf { it.length() }
        try { cacheDir.deleteRecursively(); cacheDir.mkdirs() } catch (_: Exception) {}
        toast("Cache cleared — ${SpeedFormat.bytesText(before)}")
        render()
      }
      srow(this, R.drawable.ic_spd, "Diagnostics", "Device Test") { go(Screen.DEVICE_TEST) }
      srow(this, R.drawable.ic_swap, "Check for updates", "GitHub releases") {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/PDFly-source/nexdrop/releases"))) } catch (_: Exception) {}
      }
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
    // DISCOVERY BEACON (v1.4.1-rc1): REAL counters, read from the live
    // beacon objects — the honest answer to "why was trust unavailable?"
    content.addView(sm("DISCOVERY BEACON (REAL)").apply {
      setTextColor(D.MUTED); letterSpacing = 0.10f
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(14); bottomMargin = dp(6) }
    })
    // v1.4.2-rc5: Wi-Fi rate/band/RSSI need location permission on Android
    // 8.1+ — without it the telemetry can only say "unavailable". Explicit
    // user action (never a surprise dialog on screen render).
    if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) {
      content.addView(btn("Grant location — truthful Wi-Fi telemetry", "outline", height = 38) {
        askPermission(Manifest.permission.ACCESS_FINE_LOCATION, REQ_LOC)
      }.apply {
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(38)).apply { topMargin = dp(6) }
      })
    }
    content.addView(glassCard(pad = 12f).apply {
      val idStats = beaconIdentity?.stats()
      val sesStats = beaconSession?.stats()
      srow(this, R.drawable.ic_wifi, "Identity beacon",
        idStats?.let { "running — port ${it.portBound} — sent ${it.sentPackets}" + (if (it.lastSendError.isNotEmpty()) " — send err: ${it.lastSendError}" else "") }
          ?: "not running (runs on Send/Transfer screens — this card is Device-Test state)")
      srow(this, R.drawable.ic_wifi, "Session beacon",
        sesStats?.let { "running — port ${it.portBound} — sent ${it.sentPackets} — received ${it.receivedPackets}" + (if (it.lastSendError.isNotEmpty()) " — send err: ${it.lastSendError}" else "") }
          ?: "not running (runs while this device is Receiving)")
      srow(this, R.drawable.ic_dev, "This device ID", deviceIdPref().take(18) + "…")
      val peer = peerIdentity()
      srow(this, R.drawable.ic_dev, "Peer identity",
        if (peerIp == null) "no peer connection yet"
        else if (peer == null) "NOT SEEN from $peerIp — no fresh beacon packets"
        else "seen — ${peer.deviceName} — devid ${peer.deviceId.take(10)}… — age ${System.currentTimeMillis() - (identityByIp[peerIp!!]?.atMs ?: 0L)} ms")
      srow(this, R.drawable.ic_shield, "Trust resolution",
        if (peerIp == null) "n/a — no transfer yet"
        else when {
          peer != null && peer.deviceId.isNotEmpty() && isTrusted(peer.deviceId) -> "trusted — auto-accept eligible"
          peer != null && peer.deviceId.isNotEmpty() -> "identity known — trust can be offered"
          else -> "unavailable — beacon identity missing or stale (>15 s)"
        })
    })
    // TRANSFER PROFILE (v1.4.2 Phase 1): REAL per-stage timings of the
    // last transfers — the honest answer to "what is the bottleneck?".
    // fsync high = storage paced you; read-wait high = sender/network
    // paced you. Never a guess — measured inside the engine.
    content.addView(sm("TRANSFER PROFILE (REAL)").apply {
      setTextColor(D.MUTED); letterSpacing = 0.10f
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(14); bottomMargin = dp(6) }
    })
    content.addView(glassCard(pad = 12f).apply {
      addView(sm(lastTxProfileText.ifEmpty { "no TX transfer yet" }).apply {
        setTextColor(D.TEXT); setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 11f)
      })
      addView(sm(lastRxProfileText.ifEmpty { "no RX transfer yet" }).apply {
        setTextColor(D.TEXT); setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 11f)
        setPadding(0, dp(6), 0, 0)
      })
    })

    // PERF LAB (v1.4.2 Phase 3): live, wire-compatible A/B configuration —
    // the physical experiment matrix without rebuilding. Defaults are the
    // measured spec; every change applies to the NEXT transfer only.
    content.addView(sm("PERF LAB (REAL A/B)").apply {
      setTextColor(D.MUTED); letterSpacing = 0.10f
      layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(14); bottomMargin = dp(6) }
    })
    content.addView(glassCard(pad = 12f).apply {
      fun chips(parent: LinearLayout, label: String, opts: List<Pair<String, Long>>, current: Long, set: (Long) -> Unit) {
        parent.addView(sm(label).apply { setTextColor(D.MUTED); setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 10.5f) })
        val r = row().apply {
          layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(4); bottomMargin = dp(6) }
        }
        opts.forEach { (t, v) -> r.addView(chipView(t, v == current) { set(v); renderDeviceTest() }) }
        parent.addView(r)
      }
      chips(this, "Durability batch (fsync + PROGRESS)",
        listOf("512 KiB" to 524288L, "1 MiB" to 1048576L, "2 MiB" to 2097152L, "4 MiB" to 4194304L, "8 MiB" to 8388608L),
        Ndt1Tunables.progressCadenceBytes.toLong()) { Ndt1Tunables.progressCadenceBytes = it.toInt() }
      chips(this, "In-flight window",
        listOf("8 MiB" to 8388608L, "16 MiB" to 16777216L, "32 MiB" to 33554432L, "64 MiB" to 67108864L),
        Ndt1Tunables.windowBytes.toLong()) { Ndt1Tunables.windowBytes = it.toInt() }
      chips(this, "Socket buffers",
        listOf("2 MiB" to 2097152L, "4 MiB" to 4194304L, "8 MiB" to 8388608L),
        Ndt1Tunables.socketBufferBytes.toLong()) { Ndt1Tunables.socketBufferBytes = it.toInt() }
      chips(this, "DATA frame",
        listOf("256 KiB" to 262144L, "512 KiB" to 524288L, "1 MiB" to 1048576L, "2 MiB" to 2097152L),
        Ndt1Tunables.frameBytes.toLong()) { Ndt1Tunables.frameBytes = it.toInt() }
      addView(sm("Wire-compatible NDT1 v1 — applies to the NEXT transfer. Defaults = measured spec. " +
          "Larger durability batches keep the same contract: acknowledged data is never beyond durable data.")
        .apply { setTextColor(D.MUTED); setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 10f); setPadding(0, dp(2), 0, 0) })
      addView(btn("Reset to spec", "text", height = 32) { Ndt1Tunables.reset(); renderDeviceTest() }.apply {
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(32)).apply { topMargin = dp(8) }
      })
    })

    content.addView(btn("Back to Settings", "text", height = 36) { backOr(Screen.SETTINGS) }.apply {
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(36))
    })
  }

  /** v1.4.2 PERF LAB chip — compact selectable toggle. */
  private fun chipView(label: String, active: Boolean, onClick: () -> Unit): android.view.View {
    return android.widget.TextView(this).apply {
      text = label
      setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 10.5f)
      setTextColor(if (active) D.PRIMARY else D.MUTED)
      typeface = com.nexdrop.ndt1.ui.Fonts.sora(this@MainActivity, if (active) 700 else 500)
      letterSpacing = 0.02f
      gravity = Gravity.CENTER
      setPadding(dp(10), dp(6), dp(10), dp(6))
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
        marginEnd = dp(6)
      }
      background = android.graphics.drawable.GradientDrawable().apply {
        cornerRadius = dp(16).toFloat()
        setStroke(dp(1), if (active) D.PRIMARY else D.argb(51, D.MUTED))
        setColor(if (active) D.argb(26, D.PRIMARY) else android.graphics.Color.TRANSPARENT)
      }
      setOnClickListener { onClick() }
    }
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

  private fun sendTextFlow(prefill: String? = null) {
    val input = EditText(this).apply {
      setText(prefill ?: "")
      setHint("Type your text")
      setTextColor(D.TEXT)
      setHintTextColor(D.MUTED)
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
      setSingleLine(false)
      minLines = 3
      setPadding(dp(16), dp(12), dp(16), dp(12))
    }
    AlertDialog.Builder(this, dialogTheme())
      .setTitle("Send text")
      .setView(input)
      .setPositiveButton("Continue") { _, _ ->
        val text = input.text.toString()
        if (text.isBlank()) { toast("Nothing to send"); return@setPositiveButton }
        // v1.5 Phase F: honest bound — reject, never silently truncate.
        if (TextSharePolicy.tooLarge(text.toByteArray().size)) {
          toast("Text too large (max ${SpeedFormat.bytesText(TextSharePolicy.MAX_TEXT_BYTES.toLong())}) — send it as a file instead")
          return@setPositiveButton
        }
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
   * SEND flow entry (v1.5 Phase D): one pairing, the controller drains the
   * queue strictly sequentially — one file at a time, each through the
   * full OFFER/accept/SHA flow. MainActivity is the Host only; the engine
   * is the frozen NDT1 TurboSender path.
   */
  private fun sendQueueStart(pairing: QrPairing.Pairing) {
    if (!queue.hasQueued()) { toast("Select files first"); return }
    activePairing = pairing
    if (queue.current == null) { // a fresh session starts the honest clock
      queueSessionStartNanos = System.nanoTime()
      queuePeakBps = null
    }
    queue.start()
  }

  // ---- SendQueueController.Host: engine + UI bridge ---------------------
  // Runs on the main thread (the controller is main-thread confined; the
  // engine's listener callbacks are marshaled below before touching it).

  override fun startTransfer(item: SendQueueController.QueueItem) {
    val pairing = activePairing ?: return
    if (Build.VERSION.SDK_INT >= 33 && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
      askPermission(Manifest.permission.POST_NOTIFICATIONS, REQ_NOTIF)
    }
    // State FIRST (renderTransfer reads role/currentName), then the screen.
    role = Role.SEND
    currentName = item.name
    currentSize = item.size
    currentFile = null
    peerIp = pairing.ip
    // A fresh queue slot enters the transfer screen; a RETRYING reconnect
    // (durable-offset resume) keeps the existing screen and its honest
    // elapsed clock — exactly the v1.4 auto-resume behavior.
    transferGotFirstProgress = false // per-attempt: a drop must show progress again to resume
    if (screen != Screen.TRANSFER) beginTransfer()
    TransferService.start(this, "Sending ${item.name}…")
    val session = SessionToken(QrPairing.tokenBytesFrom(pairing), pairing.tokenB64, pairing.sessionId)
    sender = TurboSender(this).also { s ->
      s.send(Uri.parse(item.uri), item.name, item.size, pairing.ip, pairing.port, session, senderListener(item))
    }
  }

  override fun cancelActiveTransfer() { receiver?.cancel(); sender?.cancel() }

  override fun pauseActive(pause: Boolean) {
    if (pause) { receiver?.pause(); sender?.pause() } else { receiver?.resume(); sender?.resume() }
  }

  override fun schedule(delayMs: Long, action: () -> Unit) { ui.postDelayed(action, delayMs) }

  override fun onQueueChanged() {
    // State changes are rare (per file / per user action) — never per
    // progress tick. Re-render only the screens that show queue state.
    if (screen == Screen.SEND || screen == Screen.TRANSFER) render()
  }

  override fun onQueueFinished(summary: SendQueueController.Summary) {
    runOnUiThread {
      hideTransferUi()
      val durMs = if (queueSessionStartNanos > 0) (System.nanoTime() - queueSessionStartNanos) / 1_000_000 else 0L
      queueSessionStartNanos = 0L
      queueResult = summary to durMs
      completedSha = null // per-file SHAs live in history; result card shows the honest split
      activePairing = null
      backStack.clear(); screen = Screen.RESULT; render()
      val ok = summary.completed > 0 && summary.failed == 0
      TransferService.complete(this,
        if (ok) "Queue complete — ${summary.completed} file(s) · ${SpeedFormat.bytesText(summary.completedBytes)}"
        else "${summary.completed} sent · ${summary.failed} failed — see the result screen")
    }
  }

  private fun senderListener(item: SendQueueController.QueueItem) = object : TurboSender.Listener {
    override fun onProgress(durable: Long, total: Long) {
      queue.onTransferProgress(durable) // volatile write; UI ticks read it
      this@MainActivity.onProgress(durable, total)
    }
    override fun onComplete(sha256: String, stats: ThroughputSampler.Stats) {
      peerIp = activePairing?.ip
      sender?.lastProfile?.let { lastTxProfileText = it.textSummary() }
      runOnUiThread {
        // History dedup (v1.5 Phase E): a duplicate engine onComplete must
        // not write the same file into history twice, and a completion
        // racing a user CANCEL must not turn the file into COMPLETED after
        // the queue already recorded the truthful CANCELLED state. Only an
        // in-flight file may complete — same invariant as the controller.
        if (!item.isBusy) return@runOnUiThread
        completedSha = sha256
        completedStats = stats
        // The result screen's PEAK is the session maximum of real
        // sustained peaks — never just the last file's number.
        stats.peakSustainedBps?.let { pk ->
          queuePeakBps = maxOf(queuePeakBps ?: 0.0, pk)
        }
        // v1.5 Phase F: resumed is real — this file completed only after
        // one or more durable-offset reconnects (Phase D retry budget).
        recordHistory(item.name, stats.averageBps, stats.durationMs, sha256, verified = true, resumed = item.retryCount > 0)
        queue.onTransferCompleted(item) // the only path to COMPLETED → next file or RESULT
      }
    }
    override fun onError(message: String) = runOnUiThread { onSendError(item, message) }
  }

  /**
   * v1.5 Phase D failure handling — with the EXISTING resume semantics:
   * a mid-transfer drop reconnects through the controller's bounded
   * RETRYING (3 attempts, 1s/2s/4s backoff) and resumes from the receiver's
   * REAL durable offset (never zero, never fabricated). A hard failure is
   * recorded honestly (history + notification) and ISOLATED: the queue
   * proceeds to the next QUEUED file; the failure is never hidden.
   */
  private fun onSendError(item: SendQueueController.QueueItem, message: String) {
    if (activePairing == null) { // queue was cancelled mid-flight
      return
    }
    val resumable = transferGotFirstProgress && autoResumePref() &&
      item.state == SendQueueController.QState.TRANSFERRING
    if (!resumable) {
      // Honest per-file failure record — the same fields the v1.4 FAILED
      // screen wrote, kept as a real history event.
      HistoryStore.record(this, HistoryStore.Entry(
        name = item.name, bytes = item.size, sent = true,
        atMs = System.currentTimeMillis(), sha256 = "", verified = false,
        speedBps = 0.0, durationMs = 0L,
        status = "Failed", reason = message.lineSequence().firstOrNull()?.take(120) ?: "failed"))
      TransferService.fail(this, "${item.name} — ${message.lineSequence().firstOrNull()?.take(100) ?: "failed"}")
    }
    queue.onTransferError(item, message, canAutoResume = resumable)
  }

  /** ONE cancel path: on-screen button and notification action both land here. */
  private fun cancelTransfer() {
    if (role == Role.SEND) {
      // v1.5 Phase F: a cancel is a truthful history record — status
      // CANCELLED, never Done, never Failed, verification honestly false.
      // (Duplicate-complete protection is Phase E's isBusy guard: no
      // later engine callback can add a second record for this file.)
      queue.current?.let { item ->
        if (benchModeMiB == null) HistoryStore.record(this, HistoryStore.Entry(
          name = item.name, bytes = item.size, sent = true,
          atMs = System.currentTimeMillis(), sha256 = "", verified = false,
          speedBps = 0.0, durationMs = 0L,
          status = "Cancelled", reason = "Cancelled by user"))
      }
      queue.cancelCurrentTransfer() // engine stop via Host + truthful CANCELLED state
      activePairing = null // no post-cancel sender error may record a FAILED entry
      hideTransferUi()
      TransferService.stop(this)
      toast("Transfer cancelled")
      screen = if (queue.totalItems > 0) Screen.SEND else Screen.HOME
      render()
      return
    }
    receiver?.cancel(); sender?.cancel()
    // v1.5 Phase F: same truthful CANCELLED record on the receive side.
    if (benchModeMiB == null && currentName != null) HistoryStore.record(this, HistoryStore.Entry(
      name = currentName!!, bytes = currentSize, sent = false,
      atMs = System.currentTimeMillis(), sha256 = "", verified = false,
      speedBps = 0.0, durationMs = 0L,
      status = "Cancelled", reason = "Cancelled by user"))
    hideTransferUi()
    TransferService.stop(this)
    toast("Transfer cancelled")
    screen = Screen.HOME; render()
  }

  private fun recordHistory(name: String, bps: Double?, durMs: Long?, sha: String, verified: Boolean, resumed: Boolean = false) {
    HistoryStore.record(this, HistoryStore.Entry(
      name = name, bytes = currentSize, sent = role == Role.SEND,
      atMs = System.currentTimeMillis(), sha256 = sha, verified = verified,
      speedBps = bps ?: 0.0, durationMs = durMs ?: 0L, resumed = resumed))
  }

  /**
   * Receive/benchmark failure path (v1.4 semantics kept). Send-queue
   * failures no longer land here — per-file failure isolation routes
   * through onSendError + the controller, and the queue continues.
   */
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
    TransferService.fail(this, currentName?.let { "$it — ${message.lineSequence().firstOrNull()?.take(100) ?: "failed"}" }
      ?: (message.lineSequence().firstOrNull()?.take(120) ?: "failed"))
  }

  @Volatile private var failedMessage: String? = null

  private fun hideTransferUi() { sender = null; receiver = null; TransferService.engineControl = null; setTransferActive(false); rxWatchdogDisarm() }

  private fun setTransferActive(on: Boolean) {
    transferActive = on
    applyKeepAwake()
  }

  /**
   * v1.4.1-rc1 (Phase 11): REAL physical conditions at transfer start —
   * battery, charging, temperature, power saver. Read from the system,
   * never guessed; recorded once per transfer (never in the hot path).
   */
  @Volatile private var runConditions: String = ""
  // v1.4.2 Phase 1: REAL engine profile summaries from the last transfers
  // (sender/receiver pump stage timings — honest bottleneck evidence).
  @Volatile private var lastTxProfileText: String = ""
  @Volatile private var lastRxProfileText: String = ""
  private fun transferConditions(): String = try {
    val bm = registerReceiver(null, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
    val level = bm?.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val scale = bm?.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, 100) ?: 100
    val status = bm?.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1) ?: -1
    val temp = (bm?.getIntExtra(android.os.BatteryManager.EXTRA_TEMPERATURE, -1) ?: -1) / 10.0
    val charging = status == android.os.BatteryManager.BATTERY_STATUS_CHARGING ||
      status == android.os.BatteryManager.BATTERY_STATUS_FULL
    val pm = getSystemService(POWER_SERVICE) as? android.os.PowerManager
    val pct = if (level >= 0 && scale > 0) level * 100 / scale else -1
    buildString {
      if (pct >= 0) append("battery $pct%").append(if (charging) " (charging)" else "")
      if (temp > 0) append("  ·  battery temp ${temp}°C")
      append("  ·  power saver ").append(if (pm?.isPowerSaveMode == true) "ON" else "off")
    }
  } catch (_: Exception) { "conditions unavailable" }

  private fun beginTransfer() {
    setTransferActive(true)
    // v1.5 Phase E: a fresh transfer must not inherit a stale queue
    // session's result data (headline/stats split of an earlier queue).
    queueResult = null; queuePeakBps = null
    // v1.5 Phase F: stale received text never leaks into the next result.
    incomingText = null
    runConditions = transferConditions() // Phase 11: real conditions, once per transfer
    transferStartNanos = System.nanoTime()
    paused = false
    transferGotFirstProgress = false
    lastGraphSampleMs = 0; lastGraphDurable = -1; lastNotifMs = 0
    // Notification actions control the LIVE engine only (Phase 3). The same
    // semantics as the on-screen buttons: toggle pause, hard cancel.
    TransferService.engineControl = { cmd ->
      runOnUiThread {
        when (cmd) {
          "pause" -> { paused = !paused; if (paused) { receiver?.pause(); sender?.pause() } else { receiver?.resume(); sender?.resume() }
            if (role == Role.SEND) queue.onTransferPaused(paused) }
          "cancel" -> cancelTransfer()
        }
      }
    }
    backStack.clear(); screen = Screen.TRANSFER
    render()
  }

  override fun onProgress(durable: Long, total: Long) {
    runOnUiThread {
      if (role == Role.RECEIVE && benchModeMiB == null) rxWatchdogArm() // feeds appLastRxProgressMs too
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
      val cur = queue.current
      val retrying = cur?.state == SendQueueController.QState.RETRYING
      etaView?.text = if (paused) "PAUSED — connection kept alive"
        else if (retrying) "Reconnect ${minOf((cur?.retryCount ?: 0) + 1, queue.maxAutoRetries)} of ${queue.maxAutoRetries} — resuming from durable offset"
        else "ETA ${UiSpeed.etaText(total - durable, bps)}"
      // Queue overall (v1.5 Phase D §7/§24): byte-based aggregate —
      // completed bytes + real durable bytes of the in-flight file.
      if (role == Role.SEND && queue.totalItems > 1) {
        val totQ = queue.totalBytes
        val doneQ = queue.overallBytes
        val opct = if (totQ > 0) (doneQ * 100 / totQ).toInt() else 0
        overallView?.text = "QUEUE  ${queue.currentPosition}/${queue.totalItems} files  ·  ${SpeedFormat.bytesText(doneQ)} / ${SpeedFormat.bytesText(totQ)}  ·  $opct%"
      }
      // LIVE GRAPH + NOTIFICATION (Phases 3/4): real delta-bytes/delta-time
      // samples; graph <=4 Hz, notification <=1 Hz so UI never competes with
      // the NDT1 transport. Nothing synthetic — paused time shows as zero.
      val nowMs = System.currentTimeMillis()
      if (nowMs - lastGraphSampleMs >= 250) {
        if (lastGraphDurable >= 0 && lastGraphSampleMs > 0) {
          val dtS = (nowMs - lastGraphSampleMs) / 1000.0
          val sample = if (paused) 0.0 else (durable - lastGraphDurable) / dtS
          if (sample >= 0) speedGraph?.add(sample)
        }
        lastGraphSampleMs = nowMs; lastGraphDurable = durable
      }
      if (nowMs - lastNotifMs >= 1000) {
        lastNotifMs = nowMs
        currentName?.let { TransferService.notifyProgress(this, it, durable, total, bps, paused, canControl = true) }
      }
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
    receiver?.lastProfile?.let { lastRxProfileText = it.textSummary() }
    runOnUiThread {
      completedSha = sha256
      completedStats = stats
      currentFile = file
      hideTransferUi()
      recordHistory(file.name, stats.averageBps, stats.durationMs, sha256, verified = true)
      backStack.clear(); screen = Screen.RESULT
      render()
      // v1.5 Phase F INCOMING TEXT: a real bounded .txt that arrived through
      // the same authenticated NDT1 session becomes copyable text. Read off
      // the UI thread (bounded ≤256 KiB), shown only on the fresh result
      // screen — never persisted anywhere else, never auto-copied.
      if (TextSharePolicy.isShareableText(file.name, file.length())) {
        thread {
          val txt = try { file.readText() } catch (_: Exception) { null }
          runOnUiThread { if (txt != null && screen == Screen.RESULT && incomingText == null) { incomingText = txt; render() } }
        }
      }
      TransferService.complete(this,
        "${file.name}  ·  ${SpeedFormat.bytesText(file.length())}\n" +
        "${UiSpeed.speedText(stats.averageBps)}  ·  ${UiSpeed.durationText(stats.durationMs)}  ·  SHA-256 VERIFIED")
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
      if (e.status == "Cancelled") {
        append("\nStatus: CANCELLED — by user, honestly recorded")
        append("\nSHA-256: not verified (no completion)")
      } else if (e.status != "Failed") {
        append("\n").append(UiSpeed.speedText(e.speedBps)).append("  ·  ")
          .append(UiSpeed.durationText(e.durationMs))
        append("\nSHA-256: ").append(if (e.verified) "VERIFIED" else "unverified")
        if (e.resumed) append("\nResumed from durable offset after a connection drop")
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
    val dlg = AlertDialog.Builder(this, dialogTheme())
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
    if (!e.sent && e.status !in listOf("Failed", "Cancelled") && f.exists()) {
      act("Open file") { openFile(f) }
      act("Share") { shareFile(f) }
      // v1.5 Phase F: real bounded .txt records offer explicit Copy text.
      if (TextSharePolicy.isShareableText(f.name, f.length())) {
        act("Copy text") {
          try {
            val cm = getSystemService(android.content.ClipboardManager::class.java)
            cm.setPrimaryClip(android.content.ClipData.newPlainText("NexDrop", f.readText()))
            toast("Copied to clipboard")
          } catch (_: Exception) { toast("Could not read the text") }
        }
      }
    }
    // v1.5 Phase F: SEND AGAIN — a completed sent record restarts the same
    // one-queue send flow. Android may have expired the original content
    // grant, so the honest guidance is to re-pick if needed.
    if (e.sent && e.status == "Done") {
      act("Send again") {
        screen = Screen.SEND; render()
        toast("Re-pick the file if needed, then pair — one queue, same flow")
      }
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

  /** Shareable completion summary (Phase 5) — every value from THIS transfer. */
  private fun shareSummary() {
    val stats = completedStats
    val text = buildString {
      append("NexDrop — Transfer complete\n\n")
      append(currentName ?: "file").append('\n')
      append(SpeedFormat.bytesText(currentFile?.length() ?: currentSize)).append('\n')
      append("Duration: ").append(UiSpeed.durationText(stats?.durationMs ?: 0)).append('\n')
      append("Average: ").append(UiSpeed.speedText(stats?.averageBps)).append('\n')
      append("Peak (sustained): ").append(UiSpeed.speedText(stats?.peakSustainedBps)).append('\n')
      if (completedSha != null) append("SHA-256: VERIFIED\n")
      append("Transport: LOCAL DIRECT · Native NDT1 TCP\n")
      append("\nPRIVATE · DIRECT · FAST — no cloud, no accounts.")
    }
    try {
      startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"; putExtra(Intent.EXTRA_TEXT, text)
      }, "Share transfer summary"))
    } catch (_: Exception) { toast("Sharing unavailable") }
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
              sender?.lastProfile?.let { lastTxProfileText = it.textSummary() }
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
    AlertDialog.Builder(this, dialogTheme())
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

  // (v1.5 Phase B) pendingName/pendingSize/queryName/querySize removed:
  // superseded by FileMeta.load — ONE ContentResolver query per URI instead
  // of separate name+size queries. Behavior for file:// URIs is preserved
  // inside FileMeta (plain File stats).

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
          if (queue.hasQueued()) launchScan("Scan the receiver's NexDrop QR") else { screen = Screen.SEND; render() }
        }
      }
    } else toast("Permission required for this mode")
  }
  private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

  /** v1.5 HARDENING (physical test 16): dialogs followed the DARK Material
   *  theme even in Light mode — dark sheets with unreadable custom-view text.
   *  Centralized: every AlertDialog now follows the app's theme tokens. */
  private fun dialogTheme(): Int =
    if (themeIsLight()) android.R.style.Theme_Material_Light_Dialog
    else android.R.style.Theme_Material_Dialog

  companion object {
    // v1.5 HARDENING: the process-scoped transfer truth (see field comments).
    private var appScreen = Screen.HOME
    private var appRole = Role.NONE
    private var appReceiver: TurboReceiver? = null
    private var appSender: TurboSender? = null
    private var appCurrentFile: File? = null
    private var appCurrentName: String? = null
    private var appCurrentSize = 0L
    private var appCompletedSha: String? = null
    private var appCompletedStats: ThroughputSampler.Stats? = null
    private var appQueuePeakBps: Double? = null
    private var appIncomingText: String? = null
    private var appHistoryFilter = "ALL"
    private var appTransferGotFirstProgress = false
    private var appQueue: SendQueueController? = null
    private var appActivePairing: QrPairing.Pairing? = null
    private var appQueueSessionStartNanos = 0L
    private var appQueueResult: Pair<SendQueueController.Summary, Long>? = null
    private var appBenchModeMiB: Int? = null
    private var appPeerIp: String? = null
    private var appLastRxProgressMs = 0L
    private var appRxWatchdogArmed = false
    private var appTransferPaused = false
    private var appDiscoveryBindError: String? = null
    const val PWA_URL = "https://pdfly-source.github.io/nexdrop/"
    const val PWA_FALLBACK_NOTE =
      "The PWA (WebRTC path) pairs with the normal QR flow there. Resume safety: reconnecting within the 10-minute session resumes from the durable offset — never from zero."
    private const val PREFS = "nd_ui"
    private const val KEY_WELCOMED = "welcomed"
  private const val KEY_KEEP_AWAKE = "keep_awake"
    private const val KEY_AUTO_RESUME = "auto_resume"
    private const val KEY_AUTO_ACCEPT = "auto_accept"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_DEVICE_NAME = "device_name"
    private const val KEY_TRUSTED = "trusted_devices"
    private const val KEY_THEME = "theme" // "system" | "light" | "dark"
    private const val REQ_NOTIF = 2
    private const val REQ_CAMERA = 3
    private const val REQ_LOC = 4  // v1.4.2-rc5: truthful Wi-Fi link telemetry
  }
}
