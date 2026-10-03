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
  implementation(project(":app")) // shared NDT1 transport layer
  implementation("androidx.leanback:leanback:1.0.0")
}
