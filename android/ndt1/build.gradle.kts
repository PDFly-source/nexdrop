plugins {
  id("com.android.library")
  id("org.jetbrains.kotlin.android")
}
android {
  namespace = "com.nexdrop.ndt1"
  compileSdk = 34
  defaultConfig { minSdk = 26 }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlinOptions { jvmTarget = "17" }
}
// Pure transport library: NDT1 framing, handshake, sender/receiver, durable
// writer, QR pairing payload, benchmark sampler. No UI, no camera — shared
// byte-for-byte by :app (phone) and :tv (receiver-only).
dependencies { }
