package com.nexdrop.ndt1

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.io.File
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * NexDrop Turbo (Android native local speed path, mission 2026-10-03).
 *
 * ONE QR — unchanged user flow:
 *   Phone A (Receive) → shows ONE QR
 *   Phone B (Send)     → scans it, Accept/Decline on the receiver
 *   Accept             → automatic NDT1 TCP connection → transfer.
 *
 * The PWA keeps WebRTC everywhere; this app is the Android↔Android native
 * local acceleration layer (a pure PWA cannot open TCP / Wi-Fi Direct
 * sockets — browser sandbox — so native local requires this companion).
 * Transport badge is truthful: NATIVE LOCAL (NDT1 TCP) only while NDT1
 * carries bytes; on native failure the UI offers the deployed PWA's
 * WebRTC path — never a fake in-app WebRTC.
 */
class MainActivity : AppCompatActivity(), TurboReceiver.Listener {
  private lateinit var status: TextView
  private lateinit var detail: TextView
  private lateinit var qrView: ImageView
  private lateinit var controls: LinearLayout
  private var receiver: TurboReceiver? = null
  private var sender: TurboSender? = null
  private var transferStart = 0L
  private var lastProgressMs = 0L

  private var pendingPairing: QrPairing.Pairing? = null
  private var benchModeMiB: Int? = null

  // ---- activity result contracts ----
  private val scanQr = registerForActivityResult(ScanContract()) { result ->
    val content = result.contents
    if (content.isNullOrEmpty()) return@registerForActivityResult
    val pairing = QrPairing.decode(content)
      ?: run { toast("Not a NexDrop Turbo QR"); return@registerForActivityResult }
    if (pairing.expired) { toast("QR expired — ask the sender for a new one"); return@registerForActivityResult }
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
    val pad = (resources.displayMetrics.density * 16).toInt()
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad)
    }
    status = TextView(this).apply { text = "NexDrop Turbo — native local speed path"; textSize = 16f }
    detail = TextView(this).apply {
      text = "Transport: NATIVE LOCAL (NDT1 TCP)\nAndroid ↔ Android acceleration. All other pairs use the NexDrop PWA (WebRTC):\n$PWA_URL"
      textSize = 12f; setPadding(0, pad, 0, pad)
    }
    qrView = ImageView(this).apply { visibility = View.GONE; setBackgroundColor(Color.WHITE) }
    controls = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    layout.addView(status)
    layout.addView(detail)
    layout.addView(qrView)
    fun btn(label: String, action: () -> Unit): Button =
      Button(this).apply { text = label; setOnClickListener { action() } }
    layout.addView(btn("Receive — show ONE QR") { startReceiving() })
    layout.addView(btn("Send — scan ONE QR") { startSending() })
    layout.addView(btn("Benchmark NATIVE 358 MB") { startBenchmark(342) })   // 358 MB decimal ≈ 341.48 MiB
    layout.addView(btn("Benchmark NATIVE 1 GB") { startBenchmark(1024) })
    layout.addView(controls)
    setContentView(android.widget.ScrollView(this).apply { addView(layout) })
  }

  // ================= RECEIVE =================
  private fun startReceiving() {
    if (!hasPermission(Manifest.permission.NEARBY_WIFI_DEVICES)) { askPermission(Manifest.permission.NEARBY_WIFI_DEVICES, REQ_NEARBY); return }
    val session = Handshake.newSessionToken()
    val dl = File(getExternalFilesDir(null) ?: filesDir, "downloads").apply { mkdirs() }
    receiver = TurboReceiver(session, dl, this)
    val port = receiver!!.start(0)
    val qrText = QrPairing.encode(session, localIp(), port, Build.MODEL)
    showQr(qrText)
    status.text = "Receiving — QR ready (single-use, 10 min)"
    detail.text = "On the other phone: NexDrop Turbo → Send → scan this ONE QR.\nTransport: NATIVE LOCAL (NDT1 TCP)"
    if (Build.VERSION.SDK_INT >= 33 && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
      askPermission(Manifest.permission.POST_NOTIFICATIONS, REQ_NOTIF)
    }
    ContextCompat.startForegroundService(this, Intent(this, TransferService::class.java))
  }

  /** Synchronous Accept/Decline decision from the receiver thread (mission §8). */
  override fun onOffer(offer: Offer): Boolean {
    val queue = ArrayBlockingQueue<Boolean>(1)
    runOnUiThread {
      AlertDialog.Builder(this)
        .setTitle("Accept transfer?")
        .setMessage("Incoming: ${offer.name}\n${"%.1f".format(offer.sizeBytes / 1048576.0)} MiB\nSHA-256 will be verified")
        .setPositiveButton("ACCEPT") { _, _ -> queue.offer(true) }
        .setNegativeButton("DECLINE") { _, _ -> queue.offer(false) }
        .setOnCancelListener { queue.offer(false) }
        .show()
    }
    // Bounded wait on the user's decision; timeout declines honestly.
    val decision = queue.poll(60, TimeUnit.SECONDS) ?: false
    if (decision) runOnUiThread { beginTransferUi("Receiving…") } // onOffer runs on the receiver thread
    return decision
  }

  override fun onProgress(durable: Long, total: Long) {
    runOnUiThread { renderProgress(durable, total) }
  }

  private fun renderProgress(durable: Long, total: Long) {
    val now = System.currentTimeMillis()
    if (now - lastProgressMs < 250 && durable < total) return
    lastProgressMs = now
    val elapsedS = ((now - transferStart).coerceAtLeast(1)) / 1000.0
    val pct = if (total > 0) durable * 100 / total else 0
    val avgMBps = durable / 1048576.0 / elapsedS
    val eta = if (avgMBps > 0.01) "${"%.0f".format((total - durable) / 1048576.0 / avgMBps)} s" else "—"
    detail.text = "durable ${durable / 1048576} / ${total / 1048576} MiB\n" +
      "average ${"%.2f".format(avgMBps)} MB/s (durable bytes / elapsed — never peak burst)\n" +
      "ETA $eta\nTransport: NATIVE LOCAL (NDT1 TCP)"
  }

  override fun onComplete(file: File, sha256: String, stats: ThroughputSampler.Stats) {
    runOnUiThread {
      hideTransferControls()
      status.text = "COMPLETE — SHA-256 VERIFIED"
      detail.text = renderStats(stats, sha256, "File: ${file.name}")
      shareJson(stats, sha256, file.name, benchmark = false)
    }
  }

  override fun onError(message: String) {
    runOnUiThread {
      hideTransferControls()
      status.text = "Native Local unavailable"
      detail.text = "$message\n\nFalling back: open the NexDrop PWA (WebRTC path) and pair with the normal QR flow there.\n" +
        "Resume safety: reconnecting within the 10-min session resumes from the durable offset (never restarts from zero)."
      offerPwaFallback()
    }
  }

  // ================= SEND =================
  private fun startSending() {
    benchModeMiB = null
    if (!hasPermission(Manifest.permission.CAMERA)) { askPermission(Manifest.permission.CAMERA, REQ_CAMERA); return }
    launchScan("Scan the receiver's NexDrop ONE QR")
  }

  private fun persistAndSend(uri: Uri, pairing: QrPairing.Pairing): Boolean {
    val name = queryName(uri) ?: "file"
    val size = querySize(uri)
    if (size <= 0) return false
    val session = SessionToken(QrPairing.tokenBytesFrom(pairing), pairing.tokenB64, pairing.sessionId)
    beginTransferUi("Sending…")
    sender = TurboSender(this).also { s ->
      s.send(uri, name, size, pairing.ip, pairing.port, session, senderListener(name))
    }
    return true
  }

  private fun senderListener(name: String) = object : TurboSender.Listener {
    override fun onProgress(durable: Long, total: Long) = this@MainActivity.onProgress(durable, total)
    override fun onComplete(sha256: String, stats: ThroughputSampler.Stats) {
      runOnUiThread {
        hideTransferControls()
        status.text = "COMPLETE — SHA-256 VERIFIED (receiver-authoritative)"
        detail.text = renderStats(stats, sha256)
        shareJson(stats, sha256, name, benchmark = false)
      }
    }
    override fun onError(message: String) = this@MainActivity.onError(message)
  }

  // ================= BENCHMARK (mission §12/§20) =================
  private fun startBenchmark(mib: Int) {
    benchModeMiB = mib
    if (!hasPermission(Manifest.permission.CAMERA)) { askPermission(Manifest.permission.CAMERA, REQ_CAMERA); return }
    launchScan("Scan the receiver's NexDrop ONE QR (benchmark $mib MiB)")
  }

  private fun runBenchmark(pairing: QrPairing.Pairing, mib: Int) {
    val f = File(cacheDir, "nexdrop-bench-$mib.bin")
    status.text = "Generating $mib MiB benchmark file…"
    detail.text = "Deterministic pattern — bounded 1 MiB buffer, FileChannel writes"
    thread(name = "ndt1-bench") {
      try {
        BenchFile.generate(cacheDir, f.name, mib.toLong() * 1024 * 1024)
        val session = SessionToken(QrPairing.tokenBytesFrom(pairing), pairing.tokenB64, pairing.sessionId)
        runOnUiThread { beginTransferUi("Sending benchmark…") }
        // Keep the reference so the on-screen Pause/Resume/Cancel actually
        // control the benchmark sender too (not just normal transfers).
        sender = TurboSender(this)
        sender?.send(
          Uri.fromFile(f), f.name, f.length(), pairing.ip, pairing.port, session,
          object : TurboSender.Listener {
            override fun onProgress(durable: Long, total: Long) = this@MainActivity.onProgress(durable, total)
            override fun onComplete(sha256: String, stats: ThroughputSampler.Stats) {
              runOnUiThread {
                hideTransferControls()
                status.text = "NATIVE BENCHMARK COMPLETE ($mib MiB)"
                detail.text = renderStats(stats, sha256,
                  "Compare on the SAME pair: PWA guided WEBRTC-358MB case (Settings → Device Test in the web app).")
                shareJson(stats, sha256, f.name, benchmark = true)
              }
              f.delete()
            }
            override fun onError(message: String) { f.delete(); this@MainActivity.onError(message) }
          },
        )
      } catch (e: Exception) {
        runOnUiThread { onError(e.message ?: "benchmark error") }
      }
    }
  }

  // ================= helpers =================
  private fun renderStats(stats: ThroughputSampler.Stats, sha256: String, extra: String = ""): String =
    "average ${"%.2f".format(stats.averageBps / 1048576.0)} MB/s · " +
      "sustained ${"%.2f".format(stats.sustainedBps / 1048576.0)} MB/s · " +
      "peak-sustained ${"%.2f".format(stats.peakSustainedBps / 1048576.0)} MB/s\n" +
      "duration ${"%.1f".format(stats.durationMs / 1000.0)} s · bytes ${stats.bytes}\n" +
      "SHA-256: $sha256\nTransport: NATIVE LOCAL (NDT1 TCP)\n" +
      "retransmissions: N/A (TCP internal — honest)\n" + extra

  private fun beginTransferUi(label: String) {
    transferStart = System.currentTimeMillis()
    lastProgressMs = 0
    status.text = label
    showTransferControls()
  }

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
        runOnUiThread { qrView.setImageBitmap(bmp); qrView.visibility = View.VISIBLE }
      } catch (e: Exception) {
        runOnUiThread { qrView.visibility = View.GONE; detail.append("\nQR fallback text: $text") }
      }
    }
  }

  private fun showTransferControls() {
    controls.removeAllViews()
    fun btn(label: String, action: () -> Unit): Button =
      Button(this).apply { text = label; setOnClickListener { action() } }
    controls.addView(btn("Pause") { receiver?.pause(); sender?.pause() })
    controls.addView(btn("Resume") { receiver?.resume(); sender?.resume() })
    controls.addView(btn("Cancel") { receiver?.cancel(); sender?.cancel() })
    controls.visibility = View.VISIBLE
  }

  private fun hideTransferControls() { controls.visibility = View.GONE }

  private fun shareJson(stats: ThroughputSampler.Stats, sha256: String, name: String, benchmark: Boolean) {
    val json = stats.toJson("ndt1-native-local", sha256) {
      put("file", name)
      put("benchmark", benchmark)
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

  /** Mission §16 failover: native fails → open the PWA's WebRTC path. */
  private fun offerPwaFallback() {
    controls.removeAllViews()
    controls.addView(Button(this).apply {
      text = "Open NexDrop Web (PWA, WebRTC)"
      setOnClickListener {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PWA_URL))) }
        catch (e: Exception) { toast("No browser available") }
      }
    })
    controls.visibility = View.VISIBLE
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

  private fun localIp(): String =
    java.net.NetworkInterface.getNetworkInterfaces().toList()
      .flatMap { it.inetAddresses.toList() }
      .firstOrNull { !it.isLoopbackAddress && it is java.net.Inet4Address }?.hostAddress ?: "127.0.0.1"

  private fun hasPermission(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED
  private fun askPermission(p: String, code: Int) { ActivityCompat.requestPermissions(this, arrayOf(p), code) }
  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
      when (requestCode) {
        REQ_NEARBY -> startReceiving()
        REQ_CAMERA -> if (benchModeMiB != null) startBenchmark(benchModeMiB!!) else startSending()
      }
    } else toast("Permission required for this mode")
  }
  private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

  companion object {
    const val PWA_URL = "https://pdfly-source.github.io/nexdrop/"
    private const val REQ_NEARBY = 1
    private const val REQ_NOTIF = 2
    private const val REQ_CAMERA = 3
  }
}
