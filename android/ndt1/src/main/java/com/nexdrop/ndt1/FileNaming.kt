package com.nexdrop.ndt1

/**
 * Deterministic received-file collision handling (v1.4.3 duplicate-name
 * fix). A file that already exists in the download directory is NEVER
 * silently overwritten: the new copy gets a " (n)" suffix before the
 * extension, first free slot starting at 1. Pure Kotlin, no Android
 * imports — directly unit-testable in the ndt1 test source set.
 *
 * Wire protocol untouched: the name is resolved AFTER SHA-256 verification
 * passes, only when the received bytes are about to be finalized on disk.
 */
object FileNaming {

  /**
   * Return `name` itself when free; otherwise "base (n).ext" with the first
   * free n >= 1. `taken` is the existence probe (directory listing / File
   * check owned by the caller).
   */
  fun collisionFreeName(name: String, taken: (String) -> Boolean): String {
    if (name.isEmpty()) return name
    if (!taken(name)) return name
    val dot = name.lastIndexOf('.')
    val base: String
    val ext: String
    if (dot > 0 && dot < name.length - 1) {
      base = name.substring(0, dot)
      ext = name.substring(dot)
    } else {
      base = name
      ext = ""
    }
    var i = 1
    while (i <= 100_000) {
      val candidate = "$base ($i)$ext"
      if (!taken(candidate)) return candidate
      i++
    }
    // pathological guard: a hostile FS state must never spin forever
    return "$base (${System.currentTimeMillis()})$ext"
  }
}
