package com.nexdrop.tv

import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.nexdrop.ndt1.Handshake
import com.nexdrop.ndt1.Offer
import com.nexdrop.ndt1.QrPairing
import com.nexdrop.ndt1.TurboReceiver
import java.io.File

/**
 * NexDrop TV — RECEIVE-ONLY (Phase 8). Remote-control navigation only,
 * large readable UI, no touch gestures. Shows the device name + pairing
 * QR, then Accept/Decline on the incoming offer, then progress, then
 * TRANSFER COMPLETE + SHA-256 VERIFIED.
 */
class ReceiveActivity : AppCompatActivity(), TurboReceiver.Listener {
  private lateinit var title: TextView
  private lateinit var body: TextView
  private lateinit var buttons: LinearLayout
  private var pendingOffer: Offer? = null
  private var decision: ((Boolean) -> Unit)? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    title = TextView(this).apply { text = "NexDrop TV"; textSize = 40f; gravity = Gravity.CENTER }
    body = TextView(this).apply { textSize = 28f; gravity = Gravity.CENTER }
    buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
    val accept = Button(this).apply { text = "ACCEPT"; textSize = 28f }
    val decline = Button(this).apply { text = "DECLINE"; textSize = 28f }
    accept.setOnClickListener { decide(true) }
    decline.setOnClickListener { decide(false) }
    buttons.addView(accept); buttons.addView(decline); buttons.visibility = android.view.View.GONE
    val root = ScrollView(this)
    root.addView(LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
      addView(title); addView(body); addView(buttons)
    })
    setContentView(root)
    startReceiving()
  }

  private fun decide(yes: Boolean) {
    runOnUiThread { buttons.visibility = android.view.View.GONE }
    decision?.invoke(yes)
    decision = null
  }

  private fun startReceiving() {
    val session = Handshake.newSessionToken()
    val dl = File(getExternalFilesDir(null) ?: filesDir, "downloads").apply { mkdirs() }
    val receiver = TurboReceiver(session, dl, this)
    val port = receiver.start()
    runOnUiThread {
      title.text = Build.MODEL
      body.text = "READY TO RECEIVE\n\nPairing QR:\n${QrPairing.encode(session, localIp(), port, Build.MODEL)}\n\nWaiting for sender…"
    }
  }

  private fun localIp(): String =
    java.net.NetworkInterface.getNetworkInterfaces().toList()
      .flatMap { it.inetAddresses.toList() }
      .firstOrNull { !it.isLoopbackAddress && it is java.net.Inet4Address }?.hostAddress ?: "127.0.0.1"

  // ---- TurboReceiver.Listener ----
  override fun onOffer(offer: Offer): Boolean {
    var verdict = false
    decision = { verdict = it }
    runOnUiThread {
      pendingOffer = offer
      body.text = "Incoming:\n${offer.name}\n${offer.sizeBytes / 1048576} MiB\nfrom sender"
      buttons.visibility = android.view.View.VISIBLE
    }
    // Block until the user picks (remote navigation). Timeout 60 s = decline.
    val deadline = System.currentTimeMillis() + 60_000
    while (decision != null && System.currentTimeMillis() < deadline) Thread.sleep(100)
    return verdict
  }

  override fun onProgress(durable: Long, total: Long) = runOnUiThread {
    body.text = "Receiving…\n${durable / 1048576} / ${total / 1048576} MiB"
  }

  override fun onComplete(file: File, sha256: String, mbps: Double) = runOnUiThread {
    body.text = "TRANSFER COMPLETE\nSHA-256 VERIFIED\n${"%.1f".format(mbps)} MB/s"
  }

  override fun onError(message: String) = runOnUiThread {
    body.text = "Error: $message"
  }
}
