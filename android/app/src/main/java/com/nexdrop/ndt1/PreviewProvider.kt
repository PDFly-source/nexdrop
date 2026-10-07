package com.nexdrop.ndt1

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ImageDecoder
import android.graphics.pdf.PdfRenderer
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * v1.5 Phase C — REAL, bounded, asynchronous file previews for the send
 * queue. Strictly a UI/metadata subsystem:
 *
 *  - NEVER runs on a transfer thread (TurboSender/TurboReceiver own their
 *    threads; this subsystem owns ONE low-priority worker). No NDT1 code
 *    calls into this file and nothing here touches the transfer path.
 *  - NEVER reads a whole file into memory: images decode down-sampled
 *    (ImageDecoder target size / sampled BitmapFactory pre-28), video
 *    extracts ONE representative frame, PDF renders page 1 only, APK reads
 *    package metadata, audio reads duration metadata. A 10 GB file yields
 *    metadata + a <=512 px preview or an honest typed icon — nothing else.
 *  - NEVER fakes a preview: if bounded generation fails (corrupted file,
 *    revoked permission, unsupported content), the typed icon stays.
 *
 * Pure decision/cache/scheduling pieces (previewPlan, previewCacheKey,
 * BoundedLruCache, PreviewScheduler) are plain Kotlin and covered by JVM
 * unit tests; Android-frame generation is covered by the instrumented
 * PreviewInstrumentedTest on the emulator.
 */

/** Typed preview results — a preview is REAL or honestly absent. */
sealed class PreviewResult {
  data class ImagePreview(val bitmap: Bitmap) : PreviewResult()
  data class VideoPreview(val frame: Bitmap, val durationMs: Long) : PreviewResult()
  data class AudioPreview(val durationMs: Long) : PreviewResult()
  data class PdfPreview(val page: Bitmap) : PreviewResult()
  data class ApkPreview(val icon: Bitmap?, val label: String, val versionName: String) : PreviewResult()
  object TypedIcon : PreviewResult()   // honest fallback — never blank
  object Unavailable : PreviewResult() // generation not possible for this kind
}

/** What bounded generation should be ATTEMPTED for a classified file. */
enum class PreviewPlan { IMAGE, VIDEO, AUDIO, PDF, APK, ICON }

fun previewPlan(kind: FileKind): PreviewPlan = when (kind) {
  FileKind.IMAGE -> PreviewPlan.IMAGE
  FileKind.VIDEO -> PreviewPlan.VIDEO
  FileKind.AUDIO -> PreviewPlan.AUDIO
  FileKind.PDF -> PreviewPlan.PDF
  FileKind.APK -> PreviewPlan.APK
  else -> PreviewPlan.ICON // DOC/ARCHIVE/OTHER: typed icon only in Phase C — no fake document thumbnails
}

/** Stable cache key: URI + size + lastModified (stale previews never serve). */
fun previewCacheKey(uriString: String, size: Long, lastModified: Long): String = "$uriString|$size|$lastModified"

/**
 * Bounded LRU (entry-count): cached thumbnails are <=512 px ARGB bitmaps
 * (<=1 MiB each). Entry budget derives from the app heap profile instead of
 * a blind large constant — never more than ~48 entries even on huge heaps.
 */
class BoundedLruCache<K, V>(private val maxEntries: Int) {
  init { require(maxEntries > 0) { "maxEntries must be > 0" } }
  private val map = object : LinkedHashMap<K, V>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<K, V>?): Boolean = size > maxEntries
  }
  @Synchronized fun get(k: K): V? = map[k]
  @Synchronized fun put(k: K, v: V) { map[k] = v }
  @Synchronized fun evictAll() { map.clear() }
  @get:Synchronized val entries: Int get() = map.size
}

fun defaultPreviewCacheEntries(): Int =
  (Runtime.getRuntime().maxMemory() / (16L * 1024 * 1024)).toInt().coerceIn(12, 48)

// ---- v1.5 Phase C closure: EXIF mapping (pure, JVM unit-tested) ----------
// Canonical Android orientation table: the sampled legacy decode (API 26/27)
// gets upright previews. Values are the EXIF orientation shorts as Ints.

/** (degrees CW, flipX) for an EXIF orientation value — pure. */
fun exifTransformSpec(orientation: Int): Pair<Int, Boolean> = when (orientation) {
  ExifInterface.ORIENTATION_ROTATE_90.toInt() -> 90 to false
  ExifInterface.ORIENTATION_ROTATE_180.toInt() -> 180 to false
  ExifInterface.ORIENTATION_ROTATE_270.toInt() -> 270 to false
  ExifInterface.ORIENTATION_FLIP_HORIZONTAL.toInt() -> 0 to true
  ExifInterface.ORIENTATION_FLIP_VERTICAL.toInt() -> 180 to true
  ExifInterface.ORIENTATION_TRANSPOSE.toInt() -> 270 to true
  ExifInterface.ORIENTATION_TRANSVERSE.toInt() -> 90 to true
  else -> 0 to false // NORMAL / UNDEFINED / unknown — never guess a rotation
}

// ---- v1.5 Phase C closure: APK bridge policy (pure, JVM unit-tested) ------

/** Larger APKs keep the honest typed icon — bounded cache-disk use. */
internal const val APK_BRIDGE_MAX_BYTES = 256L * 1024 * 1024

/** Required free-space headroom above the streamed copy. */
internal const val APK_BRIDGE_MARGIN_BYTES = 64L * 1024 * 1024

/**
 * Bridge ONLY when the size is honestly known (FileMeta resolved it), the
 * APK is within the cap, and the cache dir has real room. Otherwise the
 * typed icon stays — no speculative multi-hundred-MB copies. Pure.
 */
fun shouldBridgeApk(size: Long, usableBytes: Long): Boolean =
  size in 1..APK_BRIDGE_MAX_BYTES && usableBytes > size + APK_BRIDGE_MARGIN_BYTES

/**
 * Dedup + cancellation for preview jobs. submit() is a no-op for a key
 * already in flight (re-renders reuse the eventual result via the cache).
 * cancelAll() bumps a generation: queued-but-not-started jobs no-op when
 * the worker reaches them; the at-most-one already-running job finishes
 * harmlessly. Cache failures/cancellation never propagate to callers.
 */
class PreviewScheduler(private val runner: (Runnable) -> Unit) {
  private val lock = Any()
  private val inFlight = HashSet<String>()
  @Volatile private var generation = 0
  val inFlightCount: Int get() = synchronized(lock) { inFlight.size }

  /** @return true when this call actually enqueued the job (false = deduped or rejected). */
  fun submit(key: String, task: () -> Unit): Boolean = synchronized(lock) {
    if (key in inFlight) return false
    inFlight += key
    val g = generation
    try {
      runner(Runnable {
        try { if (g == generation) task() }
        catch (_: Exception) { /* preview errors are always swallowed */ }
        finally { synchronized(lock) { inFlight -= key } }
      })
    } catch (_: Exception) {
      // a dead/rejected preview worker must never crash the queue or a
      // transfer — release the key and report rejection
      inFlight -= key
      return false
    }
    true
  }

  fun cancelAll() { synchronized(lock) { generation++ } }
}

/**
 * The Android-side provider. ONE low-priority worker thread (previews
 * never steal cycles from transfer threads), a bounded LRU, and a
 * main-thread callback contract. `generate` is synchronous (for the
 * instrumented tests and the worker); `request` is the async UI entry.
 */
class PreviewProvider(appContext: Context) {

  private val cache = BoundedLruCache<String, PreviewResult>(defaultPreviewCacheEntries())
  private val main = Handler(Looper.getMainLooper())
  private val worker: Executor = Executors.newSingleThreadExecutor { r ->
    Thread(r, "ndt-preview").apply { priority = Thread.MIN_PRIORITY } // never competes with transfer threads
  }
  private val scheduler = PreviewScheduler { r -> worker.execute(r) }
  private val counter = AtomicInteger(0)

  fun cacheEntries(): Int = cache.entries

  /**
   * Async UI entry. Cache hit → callback fires synchronously (UI thread
   * callers); miss → bounded generation on the preview worker, callback on
   * the main thread. Duplicate in-flight keys dedup (returns silently; the
   * row keeps its typed icon until the next render finds a warm cache).
   */
  fun request(uri: Uri, size: Long, lastModified: Long, kind: FileKind, mime: String?, callback: (PreviewResult) -> Unit) {
    val key = previewCacheKey(uri.toString(), size, lastModified)
    val hit = cache.get(key)
    if (hit != null) { callback(hit); return }
    scheduler.submit(key) {
      val res = generate(uri, size, lastModified, kind, mime)
      cache.put(key, res)
      main.post { callback(res) }
    }
  }

  fun cancelAll() { scheduler.cancelAll(); cache.evictAll() }

  /** Synchronous bounded generation (worker + instrumented tests). */
  fun generate(uri: Uri, size: Long, lastModified: Long, kind: FileKind, mime: String?): PreviewResult = try {
    when (previewPlan(kind)) {
      PreviewPlan.IMAGE -> imagePreview(uri)
      PreviewPlan.VIDEO -> videoPreview(uri)
      PreviewPlan.AUDIO -> audioPreview(uri)
      PreviewPlan.PDF -> pdfPreview(uri)
      PreviewPlan.APK -> apkPreview(uri, size)
      PreviewPlan.ICON -> PreviewResult.TypedIcon
    }
  } catch (_: Exception) {
    PreviewResult.TypedIcon // corrupted / inaccessible / revoked — honest fallback, never a crash
  }

  // ---- IMAGE: bounded decode, never the full original resolution ----

  private fun imagePreview(uri: Uri): PreviewResult {
    if (Build.VERSION.SDK_INT >= 28) {
      val src = ImageDecoder.createSource(appContentResolver, uri)
      val bmp = ImageDecoder.decodeBitmap(src) { decoder, info, _ ->
        val (tw, th) = targetSize(info.size.width, info.size.height)
        decoder.setTargetSize(tw, th)
        // EXIF orientation is applied automatically by ImageDecoder.
        // Corrupted input throws (NO partial-image listener): honest fallback.
      }
      return PreviewResult.ImagePreview(bmp)
    }
    return decodeLegacyImage(uri)?.let { PreviewResult.ImagePreview(it) } ?: PreviewResult.TypedIcon
  }

  private fun targetSize(w: Int, h: Int): Pair<Int, Int> {
    val maxDim = max(w, h).coerceAtLeast(1)
    val scale = min(1f, MAX_DIM.toFloat() / maxDim)
    return max(1, (w * scale).roundToInt()) to max(1, (h * scale).roundToInt())
  }

  /**
   * API 26/27 path: bounded header read, ONE sampled decode, then EXIF
   * orientation applied to the <=512 px thumbnail (ImageDecoder applies
   * EXIF automatically from API 28; this manual pass closes that gap for
   * 26/27). Orientation is read with androidx.exifinterface — the
   * platform android.media.ExifInterface on these APIs is unreliable and
   * androidx is the maintained, dependency-free replacement (~100 KB, no
   * transitive deps; NOT a large image framework).
   * `internal` so the instrumented tests can exercise this exact branch on
   * any API level.
   */
  internal fun decodeLegacyImage(uri: Uri): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    // NOTE: the bounds decode legitimately returns null — the null check must
    // be on the STREAM, never on the decode result (an elvis on the `use`
    // block would reject every image: the original Phase C code had exactly
    // that bug, silently disabling previews on API 26/27 devices; caught by
    // the closure instrumented tests).
    val boundsStream = appContentResolver.openInputStream(uri) ?: return null
    boundsStream.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val (tw, th) = targetSize(bounds.outWidth, bounds.outHeight)
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= tw && bounds.outHeight / (sample * 2) >= th) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    val bmp = appContentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null
    return applyExifOrientation(bmp, readExifOrientation(uri))
  }

  /** Fresh bounded stream — only the JPEG EXIF segment is parsed. */
  private fun readExifOrientation(uri: Uri): Int = try {
    appContentResolver.openInputStream(uri)?.use { stream ->
      ExifInterface(stream).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL.toInt())
    } ?: ExifInterface.ORIENTATION_NORMAL.toInt()
  } catch (_: Exception) {
    ExifInterface.ORIENTATION_NORMAL.toInt() // no/unparseable EXIF → treat as upright, never a crash
  }

  /** Rotate/flip the small thumbnail only — the original is never loaded. */
  internal fun applyExifOrientation(bmp: Bitmap, orientation: Int): Bitmap {
    val (degrees, flipX) = exifTransformSpec(orientation)
    if (degrees == 0 && !flipX) return bmp
    val m = android.graphics.Matrix()
    m.setRotate(degrees.toFloat())
    if (flipX) m.postScale(-1f, 1f)
    return try {
      Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
    } catch (_: Exception) {
      bmp // OutOfMemoryError-free safety: rotation is cosmetic, keep upright-decode
    }
  }

  // ---- VIDEO: ONE representative frame + duration; never decodes the file ----

  private fun videoPreview(uri: Uri): PreviewResult {
    val mmr = MediaMetadataRetriever()
    try {
      mmr.setDataSource(app, uri)
      val durationMs = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: -1L
      val vw = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      val vh = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
      val frame: Bitmap? = if (vw > 0 && vh > 0 && Build.VERSION.SDK_INT >= 27) {
        // getScaledFrameAtTime: bounded decode of a single early frame
        // (closest sync at ~0 ms), aspect-true target dimensions.
        val scale = min(1f, MAX_DIM.toFloat() / max(vw, vh))
        val tw = max(1, (vw * scale).roundToInt()); val th = max(1, (vh * scale).roundToInt())
        mmr.getScaledFrameAtTime(0L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, tw, th)
      } else {
        mmr.getFrameAtTime(0L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)?.let { full ->
          // pre-27: extract one frame then bound it immediately
          val (tw, th) = targetSize(full.width, full.height)
          if (tw >= full.width && th >= full.height) full
          else Bitmap.createScaledBitmap(full, tw, th, true).also { if (it !== full) full.recycle() }
        }
      }
      return if (frame != null) PreviewResult.VideoPreview(frame, durationMs) else PreviewResult.TypedIcon
    } finally {
      try { mmr.release() } catch (_: Exception) {}
    }
  }

  // ---- AUDIO: duration metadata only — no decode, no waveform in Phase C ----

  private fun audioPreview(uri: Uri): PreviewResult {
    val mmr = MediaMetadataRetriever()
    try {
      mmr.setDataSource(app, uri)
      val d = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: -1L
      return PreviewResult.AudioPreview(d)
    } finally {
      try { mmr.release() } catch (_: Exception) {}
    }
  }

  // ---- PDF: page 1 only, bounded render, all resources closed ----

  private fun pdfPreview(uri: Uri): PreviewResult {
    val pfd: ParcelFileDescriptor = when (uri.scheme) {
      "file" -> ParcelFileDescriptor.open(File(uri.path ?: return PreviewResult.TypedIcon), ParcelFileDescriptor.MODE_READ_ONLY)
      "content" -> appContentResolver.openFileDescriptor(uri, "r") ?: return PreviewResult.TypedIcon
      else -> return PreviewResult.TypedIcon
    }
    try {
      PdfRenderer(pfd).use { renderer ->
        if (renderer.pageCount <= 0) return PreviewResult.TypedIcon
        renderer.openPage(0).use { page ->
          val (tw, th) = targetSize(page.width, page.height)
          val bmp = Bitmap.createBitmap(tw, th, Bitmap.Config.ARGB_8888)
          bmp.eraseColor(android.graphics.Color.WHITE) // transparent PDF pages should not read as a blank preview
          page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
          return PreviewResult.PdfPreview(bmp)
        }
      }
    } finally {
      try { pfd.close() } catch (_: Exception) {}
    }
  }

  // ---- APK: package metadata only — NEVER install, launch or execute ----

  private fun apkPreview(uri: Uri, size: Long): PreviewResult {
    val path = if (uri.scheme == "file") uri.path ?: return PreviewResult.TypedIcon else null
    return when {
      path != null -> apkPreviewFromPath(path)
      uri.scheme == "content" -> apkPreviewViaBridge(uri, size)
      else -> PreviewResult.TypedIcon
    }
  }

  private fun apkPreviewFromPath(path: String): PreviewResult {
    val pm = app.packageManager
    val pi = pm.getPackageArchiveInfo(path, 0) ?: return PreviewResult.TypedIcon
    val ai = pi.applicationInfo ?: return PreviewResult.TypedIcon
    ai.sourceDir = path; ai.publicSourceDir = path
    val label = try { ai.loadLabel(pm)?.toString() ?: "" } catch (_: Exception) { "" }
    val version = pi.versionName ?: ""
    val iconBmp = try { drawableToBoundedBitmap(ai.loadIcon(pm)) } catch (_: Exception) { null }
    return PreviewResult.ApkPreview(iconBmp, label, version)
  }

  /**
   * content:// APKs (SAF / share-sheet sources) have no filesystem path, and
   * PackageManager only reads metadata from a file. Bridge = a STREAMED copy
   * into a temporary cache file (64 KiB buffer, bounded to the caller-known
   * size), metadata extraction, immediate deletion in finally. Constraints,
   * all enforced here:
   *   - never the whole file in RAM (64 KiB chunks)
   *   - never persisted as user data (cache dir, always deleted; stale
   *     leftovers from a killed process are swept on the next bridge)
   *   - never installed, launched or executed — getPackageArchiveInfo only
   *     parses zip/package metadata
   *   - never on the main thread (runs on the single preview worker)
   *   - cancellation-safe: queued jobs never started allocate nothing; the
   *     at-most-one in-flight bridge always reaches its finally-delete
   *   - the original URI is only ever READ, never modified
   *   - unknown size, oversized APK (> 256 MB) or insufficient cache space
   *     → honest TypedIcon, no copy is started
   */
  private fun apkPreviewViaBridge(uri: Uri, size: Long): PreviewResult {
    val dir = app.cacheDir
    if (!shouldBridgeApk(size, dir.usableSpace)) return PreviewResult.TypedIcon
    sweepStaleBridgeFiles(dir)
    val tmp = File(dir, "ndt1-apk-bridge-${counter.incrementAndGet()}.apk")
    try {
      if (!streamCopyBounded(uri, tmp, size)) return PreviewResult.TypedIcon
      return apkPreviewFromPath(tmp.absolutePath)
    } finally {
      try { tmp.delete() } catch (_: Exception) { /* best-effort */ }
    }
  }

  private fun streamCopyBounded(uri: Uri, dst: File, size: Long): Boolean {
    appContentResolver.openInputStream(uri)?.use { src ->
      FileOutputStream(dst).use { out ->
        val buf = ByteArray(64 * 1024)
        var remaining = size
        while (remaining > 0) {
          val n = src.read(buf, 0, min(buf.size.toLong(), remaining).toInt())
          if (n <= 0) return false // source shorter than claimed — honest reject
          out.write(buf, 0, n)
          remaining -= n
        }
        return true
      }
    } ?: return false
  }

  /** Remnants of a process-killed bridge must never accumulate. */
  private fun sweepStaleBridgeFiles(dir: File) {
    try {
      dir.listFiles { f -> f.name.startsWith("ndt1-apk-bridge-") }?.forEach { f -> f.delete() }
    } catch (_: Exception) { /* sweep is best-effort */ }
  }

  private fun drawableToBoundedBitmap(drawable: android.graphics.drawable.Drawable): Bitmap {
    val w = max(1, min(MAX_DIM, drawable.intrinsicWidth.coerceAtLeast(1)))
    val h = max(1, min(MAX_DIM, drawable.intrinsicHeight.coerceAtLeast(1)))
    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bmp)
    drawable.setBounds(0, 0, w, h)
    drawable.draw(canvas)
    return bmp
  }

  private val app: Context = appContext.applicationContext
  private val appContentResolver get() = app.contentResolver

  companion object {
    private const val MAX_DIM = 512 // bounded preview dimension (256–512 px target)
  }
}
