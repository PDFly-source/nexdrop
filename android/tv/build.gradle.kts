plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}
android {
  namespace = "com.nexdrop.tv"
  compileSdk = 34
  defaultConfig {
    applicationId = "com.nexdrop.tv"
    minSdk = 26
    targetSdk = 34
    versionCode = 1
    versionName = "1.0"
  }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlinOptions { jvmTarget = "17" }
}
dependencies {
  implementation("androidx.core:core-ktx:1.13.1")
  implementation(project(":ndt1")) // shared NDT1 transport layer (library)
  implementation("androidx.leanback:leanback:1.0.0")
  implementation("androidx.appcompat:appcompat:1.7.0") // theme + AlertDialog on TV
  // QR encoder only (receive-only client; TV never scans)
  implementation("com.google.zxing:core:3.5.3")
}
