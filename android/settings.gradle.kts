pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
  repositories { google(); mavenCentral() }
}
rootProject.name = "NexDrop"
include(":ndt1", ":app", ":tv")
