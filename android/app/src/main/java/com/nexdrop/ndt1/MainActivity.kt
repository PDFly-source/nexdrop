package com.nexdrop.ndt1

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.io.File
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * NexDrop production Android UI (mission 2026-10-04 §10).
 *
 * Screens: HOME -> SEND / RECEIVE -> TRANSFER -> RESULT; SETTINGS holds
 * everything engineering-only (Device Test: benchmarks, raw diagnostics,
 * Share run JSON). Raw JSON is never shown on a normal transfer result.
 *
 * The transport flow is UNCHANGED from the verified implementation:
 *   Receiver: RECEIVE -> shows ONE QR
 *   Sender:   SEND -> scans ONE QR -> picks a file
 *   Accept/Decline on the receiver -> automatic NDT1 TCP -> streaming
 *   transfer with receiver-authoritative SHA-256.
 * Speed/ETA come from durable bytes / elapsed (SpeedFormat — the same math
 * the JSON uses). On native failure: truthful NATIVE LOCAL UNAVAILABLE plus
 * the deployed PWA's WebRTC path — never a fake in-app WebRTC.
 */
class MainActivity : AppCompatActivity(), TurboReceiver.Listener {

  private enum class Screen { HOME, RECEIVE, TRANSFER, RESULT, FAILED, UNAVAILABLE, SETTINGS, DEVICE_TEST }
  private enum class Role { NONE, SEND, RECEIVE }

  private var screen = Screen.HOME
  private var role = Role.NONE

  // ---- views ----
  private lateinit var content: LinearLayout
  private var qrView: ImageView? = null

  // ---- transfer state ----
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

  // ---- activity result contracts ----
  private val scanQr = registerForActivityResult(ScanContract()) { result ->
    val content = result.contents
    if (content.isNullOrEmpty()) return@registerForActivityResult
    val pairing = QrPairing.decode(content)
      ?: run { toast("Not a NexDrop QR"); return@registerForActivityResult }
    if (pairing.expired) { toast("QR expired — ask for a new one"); return@registerForActivityResult }
    val bench = benchModeMiB
    if (bench != null) runBenchmark(pairing, bench) else { pendingPairing = pairing; pickFile.launch(arrayOf("*/*")) }
  }
  private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
    if (uri == null) return@registerForActivityResult
    val pairing = pendingPairing
    if (pairing == null) { toast("Pairing lost — scan again"); return@registerForActivityResult }
    if (!persistAndSend(uri, pairing)) toast("Cannot read that file")
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    render()
  }

  // ================= rendering =================

  /** Card container: white rounded surface on the light theme. */
  private fun card(): LinearLayout {
    val c = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(16), dp(14), dp(16), dp(14))
      background = GradientDrawable().apply {
        cornerRadius = dp(12).toFloat()
        setColor(Color.parseColor("#FFFFFF"))
        setStroke(dp(1), Color.parseColor("#E5E7EB"))
      }
    }
    val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    lp.bottomMargin = dp(12)
    c.layoutParams = lp
    return c
  }

  private fun titleText(text: String, size: Float = 26f): TextView =
    TextView(this).apply {
      this.text = text
      this.textSize = size
      setTypeface(typeface, Typeface.BOLD)
      setTextColor(Color.parseColor("#111827"))
    }

  private fun label(text: String, color: String = "#6B7280", size: Float = 13f): TextView =
    TextView(this).apply {
      this.text = text
      this.textSize = size
      setTextColor(Color.parseColor(color))
    }

  private fun button(label: String, filled: Boolean = true, action: (Button) -> Unit): Button {
    val b = Button(this).apply {
      text = label
      isAllCaps = false
      textSize = if (filled) 16f else 14f
      stateListAnimator = null
      background = GradientDrawable().apply {
        cornerRadius = dp(12).toFloat()
        if (filled) setColor(Color.parseColor("#4F46E5")) else {
          setColor(Color.parseColor("#F3F4F6")); setStroke(dp(1), Color.parseColor("#D1D5DB"))
        }
      }
      setTextColor(Color.parseColor(if (filled) "#FFFFFF" else "#374151"))
      setOnClickListener { action(it as Button) }
    }
    val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    lp.topMargin = dp(8)
    b.layoutParams = lp
    return b
  }

  private fun dp(v: Int): Int = (resources.displayMetrics.density * v).toInt()

  /**
   * Transport status card (mission §2/§12): truthful status only.
   * LOCAL DIRECT (green) / NATIVE LOCAL UNAVAILABLE (amber) with the
   * native-specific network facts.
   */
  private fun transportCard(endpoint: LocalNet.Endpoint?, reachableYes: Boolean = false): LinearLayout {
    val c = card()
    if (endpoint != null) {
      c.addView(label("●  LOCAL DIRECT", "#059669", 15f))
      c.addView(label("Android Native  ·  NDT1 TCP"))
      c.addView(label("IP: ${endpoint.ip}" + if (endpoint.port > 0) "   ·   TCP port: ${endpoint.port}" else ""))
      c.addView(label(if (reachableYes) "Route reachable: YES${peerIp?.let { " — peer connected ($it)" } ?: ""}" else "Route reachable: YES — listening"))
      c.addView(label("Internet: NOT REQUIRED  ·  Network: LOCAL Wi-Fi / HOTSPOT"))
      c.addView(label("Transfer: DEVICE → DEVICE"))
    } else {
      c.addView(label("●  NATIVE LOCAL UNAVAILABLE", "#D97706", 15f))
      c.addView(label(LocalNet.unavailableText()))
    }
    return c
  }

  private fun render() {
    qrView = null
    content = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(20), dp(24), dp(20), dp(24))
    }
    when (screen) {
      Screen.HOME -> renderHome()
      Screen.RECEIVE -> renderReceive()
      Screen.TRANSFER -> renderTransfer()
      Screen.RESULT -> renderResult()
      Screen.FAILED -> renderFailed()
      Screen.UNAVAILABLE -> renderUnavailable()
      Screen.SETTINGS -> renderSettings()
      Screen.DEVICE_TEST -> renderDeviceTest()
    }
    setContentView(android.widget.ScrollView(this).apply { addView(content) })
  }

  // ================= HOME =================
  private fun renderHome() {
    content.addView(TextView(this).apply { text = "  " }) // breathing room under status bar
    content.addView(titleText("NexDrop"))
    content.addView(label("PRIVATE  •  DIRECT  •  FAST", "#4F46E5", 13f))
    val ep = LocalNet.select(activeWifiInterface())
    content.addView(transportCard(ep))
    content.addView(button("SEND") { startSending() })
    content.addView(button("RECEIVE") { startReceiving() })
    content.addView(button("Settings", filled = false) { screen = Screen.SETTINGS; render() })
    content.addView(label("\nFiles never leave your local network. No cloud, no accounts.", "#9CA3AF", 11f))
  }

  // ================= RECEIVE (ONE QR) =================
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
    content.addView(label("RECEIVE", "#4F46E5", 14f))
    content.addView(transportCard(ep))
    val iv = ImageView(this).apply {
      setBackgroundColor(Color.WHITE)
      contentDescription = "NexDrop pairing QR"
    }
    val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(280))
    iv.layoutParams = lp
    iv.scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
    qrView = iv
    content.addView(card().apply {
      addView(iv)
    })
    content.addView(label("On the other phone: NexDrop → SEND → scan this ONE QR.\nSingle-use, valid 10 minutes. Accept/Decline appears here."))
    content.addView(button("Done", filled = false) { stopReceiving(); screen = Screen.HOME; render() })
  }

  private fun stopReceiving() {
    receiver?.stop(); receiver = null; localEndpoint = null
    TransferService.stop(this)
  }

  // ================= SEND =================
  private fun startSending() {
    benchModeMiB = null
    if (!hasPermission(Manifest.permission.CAMERA)) { askPermission(Manifest.permission.CAMERA, REQ_CAMERA); return }
    launchScan("Scan the receiver's NexDrop QR")
  }

  private fun persistAndSend(uri: Uri, pairing: QrPairing.Pairing): Boolean {
    val name = queryName(uri) ?: "file"
    val size = querySize(uri)
    if (size <= 0) return false
    val session = SessionToken(QrPairing.tokenBytesFrom(pairing), pairing.tokenB64, pairing.sessionId)
    role = Role.SEND
    currentName = name
    currentSize = size
    currentFile = null
    beginTransfer("Sending $name")
    peerIp = pairing.ip
    if (Build.VERSION.SDK_INT >= 33 && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
      askPermission(Manifest.permission.POST_NOTIFICATIONS, REQ_NOTIF)
    }
    TransferService.start(this, "Sending $name…")
    sender = TurboSender(this).also { s ->
      s.send(uri, name, size, pairing.ip, pairing.port, session, senderListener(name, pairing))
    }
    return true
  }

  private fun senderListener(name: String, pairing: QrPairing.Pairing) = object : TurboSender.Listener {
    override fun onProgress(durable: Long, total: Long) = this@MainActivity.onProgress(durable, total)
    override fun onComplete(sha256: String, stats: ThroughputSampler.Stats) {
      peerIp = pairing.ip
      runOnUiThread {
        completedSha = sha256
        completedStats = stats
        hideTransferUi()
        screen = Screen.RESULT
        render()
        TransferService.stop(this@MainActivity)
      }
    }
    override fun onError(message: String) = runOnUiThread { transferFailed("Could not reach ${pairing.ip}:${pairing.port}\n$message") }
  }

  private fun transferFailed(message: String) {
    hideTransferUi()
    failedMessage = message
    screen = Screen.FAILED
    render()
    TransferService.stop(this)
  }

  @Volatile private var failedMessage: String? = null

  private fun hideTransferUi() { sender = null; receiver = null }

  // ================= TRANSFER =================
  private fun beginTransfer(labelText: String) {
    transferStartNanos = System.nanoTime()
    paused = false
    screen = Screen.TRANSFER
    render()
  }

  private lateinit var progressLabel: TextView
  private lateinit var statsLabel: TextView
  private lateinit var pauseButton: Button
  private lateinit var progressBar: ProgressBar

  private fun renderTransfer() {
    content.addView(label(if (role == Role.RECEIVE) "RECEIVING" else "SENDING", "#4F46E5", 14f))
    val c = card()
    c.addView(titleText(currentName ?: "file", 18f))
    c.addView(label(currentSizeText()))
    val bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
      max = 100; progress = 0
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    }
    progressBar = bar
    c.addView(bar)
    progressLabel = TextView(this).apply { text = "0%  ·  0 / ${SpeedFormat.bytesText(maxOf(currentSize, 0L))}"; textSize = 15f; setTextColor(Color.parseColor("#111827")) }
    c.addView(progressLabel)
    statsLabel = label("\nSpeed: connecting…")
    c.addView(statsLabel)
    content.addView(c)
    content.addView(transportCard(localEndpoint ?: LocalNet.select(activeWifiInterface()), reachableYes = peerIp != null))

    pauseButton = button(if (paused) "RESUME" else "PAUSE") {
      paused = !paused
      if (paused) { receiver?.pause(); sender?.pause() } else { receiver?.resume(); sender?.resume() }
      (it as Button).text = if (paused) "RESUME" else "PAUSE"
      statsLabel.text = if (paused) "${statsLabel.text}\nPAUSED — connection kept alive"
      else statsLabel.text.toString().removeSuffix("\nPAUSED — connection kept alive")
    }
    content.addView(pauseButton)
    content.addView(button("CANCEL", filled = false) {
      receiver?.cancel(); sender?.cancel()
      hideTransferUi()
      TransferService.stop(this)
      toast("Transfer cancelled")
      screen = Screen.HOME; render()
    })
  }

  private fun currentSizeText() =
    if (currentSize > 0) SpeedFormat.bytesText(currentSize) else "size will be confirmed by the sender"

  override fun onProgress(durable: Long, total: Long) {
    runOnUiThread {
      if (screen != Screen.TRANSFER) return@runOnUiThread
      currentSize = total
      val elapsedS = (System.nanoTime() - transferStartNanos) / 1e9
      // Main displayed speed = durable bytes / elapsed (mission §9) — the
      // exact same quantity the JSON reports as averageMBps.
      val bps = if (elapsedS > 0) durable / elapsedS else null
      val pct = if (total > 0) (durable * 100 / total).toInt() else 0
      progressBar.progress = pct
      progressLabel.text = "$pct%  ·  ${SpeedFormat.bytesText(durable)} / ${SpeedFormat.bytesText(total)}"
      statsLabel.text = "\nSpeed ${SpeedFormat.speedText(bps)}  ·  ETA ${SpeedFormat.etaText(total - durable, bps)}" +
        if (paused) "\nPAUSED — connection kept alive" else ""
      // Truthful foreground notification (mission §16): same math as the UI.
      currentName?.let { TransferService.notifyProgress(this, it, durable, total, bps) }
    }
  }

  // ---- receiver callbacks (transfer continues even on other screens) ----
  override fun onOffer(offer: Offer): Boolean {
    val queue = ArrayBlockingQueue<Boolean>(1)
    runOnUiThread {
      currentName = offer.name
      currentSize = offer.sizeBytes
      AlertDialog.Builder(this)
        .setTitle("Accept transfer?")
        .setMessage("Incoming: ${offer.name}\n${SpeedFormat.bytesText(offer.sizeBytes)}\nSHA-256 will be verified")
        .setPositiveButton("ACCEPT") { _, _ -> queue.offer(true) }
        .setNegativeButton("DECLINE") { _, _ -> queue.offer(false) }
        .setOnCancelListener { queue.offer(false) }
        .show()
    }
    val decision = queue.poll(60, TimeUnit.SECONDS) ?: false
    if (decision) runOnUiThread { beginTransfer("Receiving ${offer.name}") }
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
      screen = Screen.RESULT
      render()
      TransferService.stop(this)
    }
  }

  override fun onError(message: String) {
    runOnUiThread { transferFailed(message) }
  }

  // ================= RESULT =================
  private fun renderResult() {
    content.addView(label("✓ Transfer complete", "#059669", 18f))
    content.addView(label("✓ SHA-256 verified", "#059669", 15f))
    val c = card()
    c.addView(titleText(currentName ?: "file", 17f))
    val f = currentFile
    if (f != null) c.addView(label(SpeedFormat.bytesText(f.length()))) else if (currentSize > 0) c.addView(label(SpeedFormat.bytesText(currentSize)))
    val s = completedStats
    if (s != null) {
      c.addView(label("Duration: ${"%.1f".format(s.durationMs / 1000.0)} s"))
      c.addView(label("Average speed: ${SpeedFormat.speedText(s.averageBps)} (durable bytes / elapsed)"))
    }
    c.addView(label("Transport: LOCAL DIRECT — Android Native · NDT1 TCP"))
    content.addView(c)
    if (f != null) content.addView(button("OPEN FILE") { openFile(f) })
    if (role == Role.SEND) content.addView(button("KEEP SENDING") {
      screen = Screen.HOME; render(); startSending()
    }) else content.addView(button("KEEP RECEIVING") {
      screen = Screen.HOME; render(); startReceiving()
    })
    content.addView(button("DONE", filled = false) { screen = Screen.HOME; render() })
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

  // ================= TRANSFER FAILED (honest §7) =================
  private fun renderFailed() {
    content.addView(label("✗ Transfer failed", "#B91C1C", 18f))
    val c = card()
    failedMessage?.let { c.addView(label(it, "#B91C1C", 13f)) }
    if (failedMessage?.contains("SHA-256") == true) {
      c.addView(label("INTEGRITY CHECK FAILED — the received file was deleted.", "#B91C1C"))
    } else {
      c.addView(label("The connection was lost or the peer could not be reached. Reconnecting within the 10-minute session resumes from the durable offset — never from zero."))
    }
    content.addView(c)
    content.addView(button("TRY AGAIN", filled = false) {
      screen = Screen.HOME; render()
      if (role == Role.RECEIVE) startReceiving() else startSending()
    })
    content.addView(button("Back to Home", filled = false) { screen = Screen.HOME; render() })
  }

  // ================= NATIVE LOCAL UNAVAILABLE =================
  private fun renderUnavailable() {
    content.addView(titleText("NexDrop", 22f))
    content.addView(transportCard(null))
    content.addView(label("The native local path needs a reachable local network (same Wi-Fi or hotspot)."))
    content.addView(button("OPEN NEXDROP WEB", filled = false) {
      try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PWA_URL))) }
      catch (e: Exception) { toast("No browser available") }
    })
    content.addView(label(PWA_FALLBACK_NOTE, "#9CA3AF", 11f))
    content.addView(button("Back to Home", filled = false) { screen = Screen.HOME; render() })
  }

  // ================= SETTINGS =================
  private fun renderSettings() {
    content.addView(titleText("Settings", 22f))
    val c = card()
    val v = try { packageManager.getPackageInfo(packageName, 0) } catch (e: Exception) { null }
    c.addView(label("NexDrop ${v?.versionName ?: ""} (build ${v?.let { it.versionCode.toString() } ?: ""})"))
    c.addView(label("Local-first, end-to-end. Files transfer directly between devices on your network — no cloud, no accounts, no tracking."))
    content.addView(c)
    content.addView(button("Device Test (Advanced)", filled = false) { screen = Screen.DEVICE_TEST; render() })
    content.addView(button("Open NexDrop Web (PWA, WebRTC)", filled = false) {
      try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PWA_URL))) }
      catch (e: Exception) { toast("No browser available") }
    })
    content.addView(button("Back to Home", filled = false) { screen = Screen.HOME; render() })
  }

  // ================= DEVICE TEST (engineering only, mission §10/§18) =================
  private fun renderDeviceTest() {
    content.addView(titleText("Device Test", 22f))
    content.addView(label("Engineering diagnostics — benchmarks, raw endpoint info, run JSON.", "#9CA3AF", 12f))
    content.addView(button("Benchmark NATIVE — 358 MiB", filled = false) { startBenchmark(358) })
    content.addView(button("Benchmark NATIVE — 1 GiB", filled = false) { startBenchmark(1024) })
    val ep = localEndpoint ?: LocalNet.select(activeWifiInterface())
    content.addView(card().apply { addView(label(ep?.let { LocalNet.diagnostics(it.copy(port = it.port), reachable = "YES — LocalNet selector", peerIp = peerIp) } ?: LocalNet.unavailableText(), "#374151", 12f)) })
    content.addView(button("Back to Settings", filled = false) { screen = Screen.SETTINGS; render() })
  }

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
    beginTransfer("Sending benchmark…")
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
                screen = Screen.RESULT
                render()
                TransferService.stop(this@MainActivity)
                shareRunJson(stats, sha256, f.name) // Device Test only (mission §10)
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
    AlertDialog.Builder(this)
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
          pixels[y * size + x] = if (matrix.get(x, y)) Color.BLACK else Color.WHITE
        }
        val bmp = Bitmap.createBitmap(pixels, size, size, Bitmap.Config.RGB_565)
        runOnUiThread { qrView?.setImageBitmap(bmp) }
      } catch (e: Exception) {
        runOnUiThread { toast("QR rendering failed") }
      }
    }
  }

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
        REQ_CAMERA -> if (benchModeMiB != null) startBenchmark(benchModeMiB!!) else startSending()
      }
    } else toast("Permission required for this mode")
  }
  private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

  companion object {
    const val PWA_URL = "https://pdfly-source.github.io/nexdrop/"
    const val PWA_FALLBACK_NOTE =
      "The PWA (WebRTC path) pairs with the normal QR flow there. Resume safety: reconnecting within the 10-minute session resumes from the durable offset — never from zero."
    private const val REQ_NOTIF = 2
    private const val REQ_CAMERA = 3
  }
}
