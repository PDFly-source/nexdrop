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
  testOptions {
    unitTests.all {
      it.testLogging {
        showStandardStreams = true
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
      }
    }
  }
}
// Pure transport library: NDT1 framing, handshake, sender/receiver, durable
// writer, QR pairing payload, benchmark sampler. No UI, no camera — shared
// byte-for-byte by :app (phone) and :tv (receiver-only).
dependencies {
  // ANDROID_NATIVE_LOCAL endpoint-selection tests (routing fix 2026-10-04):
  // pure JVM — the transport + selection code paths use only java.* APIs.
  testImplementation("junit:junit:4.13.2")
  // Real org.json on the JVM test classpath (Android ships it at runtime;
  // the android.jar unit-test stub throws) — enables QR-pairing tests.
  testImplementation("org.json:json:20240303")
}
