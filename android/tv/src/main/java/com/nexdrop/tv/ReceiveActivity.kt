package com.nexdrop.tv

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.nexdrop.ndt1.Handshake
import com.nexdrop.ndt1.LocalNet
import com.nexdrop.ndt1.Offer
import com.nexdrop.ndt1.QrPairing
import com.nexdrop.ndt1.ThroughputSampler
import com.nexdrop.ndt1.TurboReceiver
import java.io.File
import kotlin.concurrent.thread

/**
 * NexDrop TV — RECEIVE-ONLY (Phase 8). Remote-control navigation only,
 * large readable UI, no touch gestures. Shows the device name + a REAL
 * pairing QR (sender phone scans the TV screen), then Accept/Decline on
 * the incoming offer, then progress + speed, then TRANSFER COMPLETE +
 * SHA-256 VERIFIED.
 */
class ReceiveActivity : AppCompatActivity(), TurboReceiver.Listener {
  private lateinit var title: TextView
  private lateinit var body: TextView
  private lateinit var qrView: ImageView
  private lateinit var buttons: LinearLayout
  private var pendingOffer: Offer? = null
  private var decision: ((Boolean) -> Unit)? = null
  private var localEndpoint: LocalNet.Endpoint? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    title = TextView(this).apply { text = "NexDrop TV"; textSize = 40f; gravity = Gravity.CENTER }
    body = TextView(this).apply { textSize = 28f; gravity = Gravity.CENTER }
    qrView = ImageView(this).apply { visibility = View.GONE; setBackgroundColor(Color.WHITE) }
    buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
    val accept = Button(this).apply { text = "ACCEPT"; textSize = 28f }
    val decline = Button(this).apply { text = "DECLINE"; textSize = 28f }
    accept.setOnClickListener { decide(true) }
    decline.setOnClickListener { decide(false) }
    buttons.addView(accept); buttons.addView(decline); buttons.visibility = View.GONE
    val root = ScrollView(this)
    root.addView(LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
      addView(title); addView(body); addView(qrView); addView(buttons)
    })
    setContentView(root)
    startReceiving()
  }

  private fun decide(yes: Boolean) {
    runOnUiThread { buttons.visibility = View.GONE }
    decision?.invoke(yes)
    decision = null
  }

  private fun startReceiving() {
    // ANDROID_NATIVE_LOCAL endpoint selection (2026-10-04 routing fix):
    // never advertise a carrier CGNAT (100.64.0.0/10) address — only the
    // selected RFC 1918 Wi-Fi/hotspot/ethernet local endpoint.
    val endpoint = LocalNet.select()
    if (endpoint == null) {
      runOnUiThread {
        title.text = "NATIVE LOCAL UNAVAILABLE"
        body.text = LocalNet.unavailableText() + "\n\nPWA (WebRTC): https://pdfly-source.github.io/nexdrop/"
      }
      return
    }
    val session = Handshake.newSessionToken()
    val dl = File(getExternalFilesDir(null) ?: filesDir, "downloads").apply { mkdirs() }
    val receiver = TurboReceiver(session, dl, this)
    val port = try { receiver.start(0, endpoint.ip) } catch (e: Exception) {
      runOnUiThread {
        title.text = "NATIVE LOCAL UNAVAILABLE"
        body.text = "Cannot bind ${endpoint.ip}: ${e.message}\n\n" + LocalNet.unavailableText()
      }
      return
    }
    val ep = endpoint.copy(port = port)
    localEndpoint = ep
    val qrText = QrPairing.encode(session, ep.ip, port, Build.MODEL)
    runOnUiThread {
      title.text = Build.MODEL
      body.text = "READY TO RECEIVE\n\nScan this QR with the sender phone (NexDrop Turbo → Send)\n\n" +
        LocalNet.diagnostics(ep, reachable = "YES — server bound to ${ep.ip}:$port and listening")
    }
    thread(name = "tv-qr") {
      try {
        val size = 720
        val matrix = QRCodeWriter().encode(qrText, BarcodeFormat.QR_CODE, size, size)
        val pixels = IntArray(size * size)
        for (y in 0 until size) for (x in 0 until size) {
          pixels[y * size + x] = if (matrix.get(x, y)) Color.BLACK else Color.WHITE
        }
        val bmp = Bitmap.createBitmap(pixels, size, size, Bitmap.Config.RGB_565)
        runOnUiThread { qrView.setImageBitmap(bmp); qrView.visibility = View.VISIBLE }
      } catch (_: Exception) {
        runOnUiThread { body.append("\nQR fallback: $qrText") }
      }
    }
  }

  // ---- TurboReceiver.Listener ----
  override fun onOffer(offer: Offer): Boolean {
    var verdict = false
    decision = { verdict = it }
    runOnUiThread {
      pendingOffer = offer
      body.text = "Incoming:\n${offer.name}\n${offer.sizeBytes / 1048576} MiB\nfrom sender"
      buttons.visibility = View.VISIBLE
    }
    // Block until the user picks (remote navigation). Timeout 60 s = decline.
    val deadline = System.currentTimeMillis() + 60_000
    while (decision != null && System.currentTimeMillis() < deadline) Thread.sleep(100)
    return verdict
  }

  override fun onProgress(durable: Long, total: Long) = runOnUiThread {
    body.text = "Receiving…\n${durable / 1048576} / ${total / 1048576} MiB"
  }

  override fun onComplete(file: File, sha256: String, stats: ThroughputSampler.Stats) = runOnUiThread {
    body.text = "TRANSFER COMPLETE\nSHA-256 VERIFIED\n" +
      "average ${"%.2f".format(stats.averageBps / 1048576.0)} MB/s · " +
      "sustained ${"%.2f".format(stats.sustainedBps / 1048576.0)} MB/s\n" +
      "Transport: NATIVE LOCAL (NDT1 TCP)"
  }

  override fun onError(message: String) = runOnUiThread {
    body.text = "Error: $message\n\nRoute reachable: NO — native local path failed.\nPWA (WebRTC): https://pdfly-source.github.io/nexdrop/"
  }

  override fun onPeerConnected(peer: String) = runOnUiThread {
    val ep = localEndpoint ?: return@runOnUiThread
    body.text = "PEER CONNECTED\n" +
      LocalNet.diagnostics(ep, reachable = "YES — TCP connection established with peer $peer", peerIp = peer)
  }
}
