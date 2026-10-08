package com.nexdrop.ndt1

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import java.io.File

/**
 * File experience (v1.5 Phase B): real, cheap file metadata for the send
 * queue. ONE ContentResolver query per URI resolves name + size (and
 * lastModified when the provider exposes it); MIME comes from
 * ContentResolver.getType. Nothing is ever read into memory — this is
 * metadata only; the transfer engine keeps streaming via its own
 * ContentResolverStream exactly as in v1.4.x.
 *
 * FileKind.classify(mime, filename) is PURE Kotlin (no Android imports)
 * so it is directly unit-testable in the app unit-test source set, and is
 * reused by the Phase C preview system to pick the bounded decoder.
 * Never guesses a preview it cannot make; classification only picks icons.
 */
enum class FileKind { IMAGE, VIDEO, AUDIO, PDF, APK, ARCHIVE, DOC, OTHER }

object FileMeta {

  data class Meta(
    val name: String,
    val size: Long,
    val mime: String?,
    val lastModified: Long, // epoch ms, or -1 when unavailable (honest)
    val kind: FileKind,
  )

  // ---- MIME tables (lowercase) -------------------------------------------

  private val DOC_MIMES = setOf(
    "application/msword", "application/rtf", "application/json", "application/csv",
    "application/epub+zip", "application/vnd.ms-excel", "application/vnd.ms-powerpoint",
    "application/vnd.oasis.opendocument.text",
  )
  private val DOC_MIME_PREFIXES = listOf(
    "text/", "application/vnd.openxmlformats-officedocument.",
  )
  private val ARCHIVE_MIMES = setOf(
    "application/zip", "application/x-zip-compressed", "application/x-rar-compressed",
    "application/vnd.rar", "application/x-7z-compressed", "application/x-tar",
    "application/gzip", "application/x-gzip", "application/x-bzip2",
  )
  private val APK_MIME = "application/vnd.android.package-archive"
  private val PDF_MIME = "application/pdf"

  private val IMAGE_EXTS = setOf("jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "avif", "svg")
  private val VIDEO_EXTS = setOf("mp4", "mkv", "mov", "avi", "webm", "m4v", "3gp", "ts")
  private val AUDIO_EXTS = setOf("mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "amr", "wma", "mid")
  private val ARCHIVE_EXTS = setOf("zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst")
  private val DOC_EXTS = setOf("txt", "md", "doc", "docx", "rtf", "csv", "json", "xml", "html", "htm", "xls", "xlsx", "ppt", "pptx", "epub", "log", "pages")
  private val APK_EXTS = setOf("apk", "apks", "xapk")

  /** Pure classification: MIME first, honest filename-extension fallback. */
  fun classify(mime: String?, filename: String?): FileKind {
    val m = mime?.lowercase()?.trim()?.takeIf { it.isNotEmpty() && it != "*/*" && it != "application/octet-stream" }
    if (m != null) {
      when {
        m.startsWith("image/") -> return FileKind.IMAGE
        m.startsWith("video/") -> return FileKind.VIDEO
        m.startsWith("audio/") -> return FileKind.AUDIO
        m == PDF_MIME -> return FileKind.PDF
        m == APK_MIME -> return FileKind.APK
        m in ARCHIVE_MIMES -> return FileKind.ARCHIVE
        m in DOC_MIMES || DOC_MIME_PREFIXES.any { m.startsWith(it) } -> return FileKind.DOC
      }
    }
    val ext = filename?.substringAfterLast('.', "")?.lowercase() ?: ""
    return when (ext) {
      in IMAGE_EXTS -> FileKind.IMAGE
      in VIDEO_EXTS -> FileKind.VIDEO
      in AUDIO_EXTS -> FileKind.AUDIO
      "pdf" -> FileKind.PDF
      in APK_EXTS -> FileKind.APK
      in ARCHIVE_EXTS -> FileKind.ARCHIVE
      in DOC_EXTS -> FileKind.DOC
      else -> FileKind.OTHER
    }
  }

  /**
   * ONE query per URI (name + size + provider lastModified when available).
   * file:// URIs use plain File stats. Returns null when the provider gives
   * nothing — callers reject honestly, never invent metadata.
   */
  fun load(context: Context, uri: Uri): Meta? {
    if (uri.scheme == "file") {
      val f = File(uri.path ?: return null)
      if (!f.exists()) return null
      val n = f.name.ifEmpty { return null }
      val mime = null // no ContentResolver MIME for file://; classify by extension
      return Meta(n, f.length(), mime, f.lastModified(), classify(mime, n))
    }
    if (uri.scheme != "content") return null
    var name: String? = null
    var size = -1L
    var lastMod = -1L
    try {
      context.contentResolver.query(uri, null, null, null, null)?.use { c ->
        if (!c.moveToFirst()) return null
        val nIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        val sIdx = c.getColumnIndex(OpenableColumns.SIZE)
        val lIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
        name = if (nIdx >= 0) c.getString(nIdx) else null
        size = if (sIdx >= 0 && !c.isNull(sIdx)) c.getLong(sIdx) else -1L
        if (lIdx >= 0 && !c.isNull(lIdx)) lastMod = c.getLong(lIdx)
      } ?: return null
    } catch (_: Exception) {
      return null
    }
    val resolved = name ?: uri.lastPathSegment ?: return null
    val mime = try { context.contentResolver.getType(uri) } catch (_: Exception) { null }
    return Meta(resolved, size, mime, lastMod, classify(mime, resolved))
  }
}
