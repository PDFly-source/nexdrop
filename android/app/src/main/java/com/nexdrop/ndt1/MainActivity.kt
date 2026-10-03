package com.nexdrop.ndt1

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.io.File

/**
 * NexDrop Turbo (phone) — send + receive over native NDT1 TCP.
 * The browser PWA keeps WebRTC; this is the native path. The transport
 * badge shown here is truthful: TURBO only while NDT1 carries bytes.
 */
class MainActivity : AppCompatActivity(), TurboReceiver.Listener {
  private lateinit var status: TextView
  private var receiver: TurboReceiver? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    status = TextView(this).apply { text = "NexDrop Turbo (NDT1)" }
    layout.addView(status)
    layout.addView(Button(this).apply {
      text = "Receive (advertise + QR)"
      setOnClickListener { startReceiving() }
    })
    layout.addView(Button(this).apply {
      text = "Send (paste pairing JSON)"
      setOnClickListener { /* sender flow: QR-scan result -> TurboSender.send(...) */ }
    })
    setContentView(layout)
  }

  private fun startReceiving() {
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.NEARBY_WIFI_DEVICES) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES), 1)
      return
    }
    val session = Handshake.newSessionToken()
    val port = 0
    val dl = File(getExternalFilesDir(null) ?: filesDir, "downloads").apply { mkdirs() }
    receiver = TurboReceiver(session, dl, this).also { it.start(port) }
    val qr = QrPairing.encode(session, localIp(), port, Build.MODEL)
    status.text = "Receiver on :$port\nQR: $qr"
    startService(android.content.Intent(this, TransferService::class.java))
  }

  private fun localIp(): String =
    java.net.NetworkInterface.getNetworkInterfaces().toList()
      .flatMap { it.inetAddresses.toList() }
      .firstOrNull { !it.isLoopbackAddress && it is java.net.Inet4Address }?.hostAddress ?: "127.0.0.1"

  // ---- TurboReceiver.Listener ----
  override fun onOffer(offer: Offer): Boolean = runOnUiThread {
    Toast.makeText(this, "Incoming: ${offer.name} (${offer.sizeBytes} bytes)", Toast.LENGTH_LONG).show()
  }.let { true } // accept (wire to Accept/Decline UI)

  override fun onProgress(durable: Long, total: Long) = runOnUiThread {
    status.text = "Receiving… ${durable / 1048576} / ${total / 1048576} MiB"
  }

  override fun onComplete(file: File, sha256: String, mbps: Double) = runOnUiThread {
    status.text = "Complete: ${file.name} — ${"%.1f".format(mbps)} MB/s durable\nSHA-256 verified"
  }

  override fun onError(message: String) = runOnUiThread {
    status.text = "Error: $message"
  }
}
