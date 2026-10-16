package com.nexdrop.ndt1

import java.io.File
import java.io.InputStream
import java.io.OutputStream

/**
 * Shared file-action logic (v1.4.3 file-handling fix) — PURE Kotlin, no
 * Android imports, directly unit-testable in the app unit-test source set
 * (same contract as FileKind/FileMeta).
 *
 * Root causes this fixes (see FileActions for the Android glue):
 *  - OPEN/SHARE used MimeTypeMap alone: it has NO entry for .apk (and
 *    several document types) on most devices, so received files were
 *    offered as application/octet-stream and no viewer accepted them.
 *  - APKs had no install path at all and no REQUEST_INSTALL_PACKAGES
 *    permission, so Android silently dropped package-installer intents.
 *  - There was no Save action anywhere.
 */
object FileMimes {

  const val APK_MIME = "application/vnd.android.package-archive"
  const val DEFAULT_MIME = "application/octet-stream"

  /** Lowercase extension -> MIME. Covers the types MimeTypeMap misses most
   *  (apk, office docs, archives) plus the common received formats. */
  private val EXT_MIMES = mapOf(
    // APK / packages (MimeTypeMap has no .apk entry — the Install fix)
    "apk" to APK_MIME, "apks" to APK_MIME, "xapk" to APK_MIME,
    // documents
    "pdf" to "application/pdf",
    "txt" to "text/plain", "log" to "text/plain", "md" to "text/markdown",
    "csv" to "text/csv", "json" to "application/json", "xml" to "application/xml",
    "html" to "text/html", "htm" to "text/html", "rtf" to "application/rtf",
    "doc" to "application/msword",
    "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls" to "application/vnd.ms-excel",
    "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ppt" to "application/vnd.ms-powerpoint",
    "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "epub" to "application/epub+zip",
    // images
    "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "png" to "image/png",
    "gif" to "image/gif", "webp" to "image/webp", "bmp" to "image/bmp",
    "heic" to "image/heic", "heif" to "image/heif", "svg" to "image/svg+xml",
    // video
    "mp4" to "video/mp4", "m4v" to "video/mp4", "mkv" to "video/x-matroska",
    "mov" to "video/quicktime", "webm" to "video/webm", "3gp" to "video/3gpp",
    "avi" to "video/x-msvideo", "ts" to "video/mp2t",
    // audio
    "mp3" to "audio/mpeg", "m4a" to "audio/mp4", "aac" to "audio/aac",
    "wav" to "audio/x-wav", "ogg" to "audio/ogg", "oga" to "audio/ogg",
    "opus" to "audio/opus", "flac" to "audio/flac", "amr" to "audio/amr",
    "mid" to "audio/midi",
    // archives
    "zip" to "application/zip", "7z" to "application/x-7z-compressed",
    "rar" to "application/vnd.rar", "tar" to "application/x-tar",
    "gz" to "application/gzip",
  )

  fun extensionOf(name: String): String {
    val i = name.lastIndexOf('.')
    return if (i < 0 || i == name.length - 1) "" else name.substring(i + 1).lowercase()
  }

  /** Deterministic MIME for a filename. Android's MimeTypeMap (in the glue)
   *  is only consulted as a fallback for extensions not in this table. */
  fun mimeForName(name: String): String? = EXT_MIMES[extensionOf(name)]

  /** ZIP local-file-header magic — every valid APK is a ZIP and starts with it. */
  private val ZIP_MAGIC = byteArrayOf(0x50, 0x4B, 0x03, 0x04)

  /** Bounded read of the first bytes of a file (never whole-file). */
  fun headBytes(f: File, count: Int = 4): ByteArray? = try {
    java.io.FileInputStream(f).use { ins ->
      val buf = ByteArray(count)
      var off = 0
      while (off < count) {
        val r = ins.read(buf, off, count - off)
        if (r < 0) break
        off += r
      }
      if (off == count) buf else buf.copyOf(off)
    }
  } catch (_: Exception) { null }

  /** APK by extension. Cheap first gate before any byte check. */
  fun isApkName(name: String): Boolean = extensionOf(name) in setOf("apk", "apks", "xapk")

  /** APK validated by BOTH extension and file metadata (ZIP magic header).
   *  A file named .apk that is not a ZIP is refused — never offered to the
   *  package installer. */
  fun isApk(name: String, f: File): Boolean {
    if (!isApkName(name)) return false
    val head = headBytes(f, 4) ?: return false
    if (head.size < 4) return false
    return (0..3).all { head[it] == ZIP_MAGIC[it] }
  }

  /**
   * Resolve a history record's file SAFELY. A persisted path or record name
   * is untrusted until proven: the canonical result must live inside one of
   * the app's own storage roots (prevents ../ traversal and arbitrary-path
   * access from a corrupted history file). Returns null when the resolved
   * file is outside every root or the name is not a plain file name.
   */
  fun safeResolve(roots: List<File>, persistedPath: String?, name: String): File? {
    fun insideRoots(f: File): Boolean {
      val canon = try { f.canonicalPath } catch (_: Exception) { return false }
      return roots.any { root ->
        val rc = try { root.canonicalPath } catch (_: Exception) { return@any false }
        canon == rc || canon.startsWith(rc + File.separator)
      }
    }
    if (name.isBlank() || name.contains('/') || name.contains('\\') || name.contains("..")) return null
    if (!persistedPath.isNullOrBlank()) {
      val p = File(persistedPath)
      if (insideRoots(p)) return p
    }
    return roots.firstNotNullOfOrNull { root -> File(root, name).takeIf { insideRoots(it) } }
  }

  /** Display name for a Save target: keep the original name; strip anything
   *  that is not safe inside a suggested SAF document title. */
  fun suggestSaveName(name: String): String {
    val cleaned = name.trim().replace(Regex("[\\/:*?\"<>|]"), "_")
    return if (cleaned.isBlank()) "nexdrop-file" else cleaned.take(120)
  }

  /**
   * Bounded-memory stream copy (64 KiB buffer — never whole-file in RAM).
   * Returns the number of bytes copied; the caller verifies == source size.
   */
  fun copyStream(input: InputStream, output: OutputStream, bufferSize: Int = 64 * 1024): Long {
    val buf = ByteArray(bufferSize)
    var total = 0L
    while (true) {
      val r = input.read(buf)
      if (r < 0) break
      output.write(buf, 0, r)
      total += r
    }
    output.flush()
    return total
  }
}
