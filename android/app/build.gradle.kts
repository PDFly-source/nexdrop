plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}
android {
  namespace = "com.nexdrop.ndt1.app"
  compileSdk = 34
  defaultConfig {
    applicationId = "com.nexdrop.ndt1"
    minSdk = 26
    targetSdk = 34
    versionCode = 1
    versionName = "1.0"
  }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlinOptions { jvmTarget = "17" }
}
dependencies {
  implementation(project(":ndt1")) // shared NDT1 transport layer
  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("androidx.activity:activity-ktx:1.9.2")
  // QR: pure-Java encoder (companion QR) + embedded scanner (ONE QR scan UX)
  implementation("com.google.zxing:core:3.5.3")
  implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
