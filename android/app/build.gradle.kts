plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}
android {
  // MUST equal the Kotlin package of MainActivity/TransferService
  // (com.nexdrop.ndt1). The manifest declares components as ".MainActivity";
  // AGP resolves those names against THIS namespace. With the mismatched
  // "com.nexdrop.ndt1.app" namespace the merged manifest pointed at a class
  // that does not exist, and the app crashed instantly on launch:
  //   java.lang.RuntimeException: Unable to instantiate activity
  //   ComponentInfo{com.nexdrop.ndt1/com.nexdrop.ndt1.app.MainActivity}:
  //   java.lang.ClassNotFoundException: com.nexdrop.ndt1.app.MainActivity
  // (verified in the shipped NexDrop-debug.apk merged manifest).
  namespace = "com.nexdrop.ndt1"
  compileSdk = 34
  defaultConfig {
    applicationId = "com.nexdrop.ndt1"
    minSdk = 26
    targetSdk = 34
    // Production release (mission 2026-10-04 §14): production label/icons,
    // release build in CI. Debug APK stays available for engineering.
    versionCode = 16
    versionName = "1.4.3"  // maintenance: recovered-transfer result-average scope fix (display telemetry only — wire protocol, durability, resume, SHA-256 and performance byte-identical to 1.4.2)
  }
  // Production signing (mission 2026-10-04 signing pipeline): the keystore
  // and passwords live ONLY in GitHub Actions secrets
  // (NEXDROP_RELEASE_KEYSTORE_B64 / NEXDROP_KEYSTORE_PASSWORD /
  // NEXDROP_KEY_PASSWORD) — never in this repository. CI decodes the
  // keystore to a runner-local file and exports these env vars before
  // assembleRelease; locally, without the env vars, the build falls back
  // to unsigned so nothing breaks for engineering builds.
  signingConfigs {
    create("release") {
      val ksFile = System.getenv("NEXDROP_KEYSTORE_FILE")
      val ksPw = System.getenv("NEXDROP_KEYSTORE_PASSWORD")
      val keyPw = System.getenv("NEXDROP_KEY_PASSWORD")
      if (ksFile != null && ksPw != null && keyPw != null) {
        storeFile = file(ksFile)
        storePassword = ksPw
        keyAlias = "nexdrop" // stable production alias
        keyPassword = keyPw
        // minSdk 26: v2+v3 are what modern Android verifies; v1 (JAR) adds
        // bloat and is only needed below API 24.
        enableV1Signing = false
        enableV2Signing = true
        enableV3Signing = true
      }
    }
  }
  buildTypes {
    release {
      // minify off: no reflection-sensitive code; keeps the APK debuggable
      // in stack traces and avoids an unverifiable R8 pass at this stage
      isMinifyEnabled = false
      // Sign only when CI provided the keystore via env; otherwise the
      // artifact stays unsigned (never silently debug-signed).
      if (System.getenv("NEXDROP_KEYSTORE_FILE") != null) {
        signingConfig = signingConfigs.getByName("release")
      }
    }
  }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlinOptions { jvmTarget = "17" }
}
dependencies {
  implementation(project(":ndt1")) // shared NDT1 transport layer
  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("androidx.activity:activity-ktx:1.9.2")
  // SAF folder → recursive file queue (PRIORITY 1, no storage permission)
  implementation("androidx.documentfile:documentfile:1.0.1")
  // QR: pure-Java encoder (companion QR) + embedded scanner (ONE QR scan UX)
  implementation("com.google.zxing:core:3.5.3")
  implementation("com.journeyapps:zxing-android-embedded:4.3.0")
  // v1.5 Phase B: app-module unit tests (FileKind classification — pure JVM)
  testImplementation("junit:junit:4.13.2")
}
