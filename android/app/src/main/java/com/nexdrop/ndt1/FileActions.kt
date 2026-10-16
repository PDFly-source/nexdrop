package com.nexdrop.ndt1

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import java.io.File

/**
 * Shared file-action service (v1.4.3 file-handling fix) — ONE reliable
 * implementation for Open, Share, Save and Install APK, used by BOTH the
 * Transfer Complete screen and History (previously two ad-hoc paths with
 * broken MIME resolution and no install/save route).
 *
 * Security contract:
 *  - every call targets a java.io.File resolved by FileMimes.safeResolve or
 *    handed over by the live receiver path (app-private downloads dir);
 *  - sharing/opening goes exclusively through the app's FileProvider
 *    (exported=false, grantUriPermissions) with FLAG_GRANT_READ only —
 *    never a file:// URI, never arbitrary paths;
 *  - nothing is deleted or moved by these actions.
 */
object FileActions {

  private fun providerUri(context: Context, f: File): Uri =
    FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", f)

  /** Robust MIME: deterministic table first, Android MimeTypeMap only as a
   *  fallback, octet-stream last. Fixes the "no app can open .apk/.docx"
   *  root cause. */
  fun mimeFor(context: Context, name: String): String {
    FileMimes.mimeForName(name)?.let { return it }
    val ext = FileMimes.extensionOf(name)
    if (ext.isNotEmpty()) {
      try {
        android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)?.let { return it }
      } catch (_: Exception) {}
    }
    return FileMimes.DEFAULT_MIME
  }

  private fun viewIntent(context: Context, f: File, mime: String, action: String): Intent =
    Intent(action).apply {
      val uri = providerUri(context, f)
      setDataAndType(uri, mime)
      // Belt-and-braces grant: FLAG on the intent plus ClipData — required
      // by some target apps to accept a content URI.
      clipData = ClipData.newRawUri("nexdrop-file", uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

  sealed class FileActionResult {
    /** The system actually accepted the launch request. */
    data class Launched(val detail: String) : FileActionResult()
    /** A real, honest failure with an actionable message. */
    data class Failed(val reason: String) : FileActionResult()
  }

  /**
   * OPEN the received file with the best matching app. Launch is only
   * reported successful when the system accepted the ACTION_VIEW request.
   */
  fun open(activity: Activity, f: File): FileActionResult {
    if (!f.exists() || !f.canRead()) {
      return FileActionResult.Failed(
        "File not found on this device. It may have been deleted or moved — " +
          "receiving it again restores it.")
    }
    val mime = mimeFor(activity, f.name)
    return try {
      activity.startActivity(viewIntent(activity, f, mime, Intent.ACTION_VIEW))
      FileActionResult.Launched("Opening ${f.name} ($mime)")
    } catch (e: ActivityNotFoundException) {
      FileActionResult.Failed(
        "No app on this device can open ${f.name} ($mime). Try SAVE FILE, then open it from the destination app.")
    } catch (e: SecurityException) {
      FileActionResult.Failed("Access to ${f.name} was denied by the system (${e.message}).")
    } catch (e: Exception) {
      FileActionResult.Failed("Could not open ${f.name}: ${e.message ?: "unexpected error"}.")
    }
  }

  /** SHARE the real file bytes via FileProvider with a correct MIME (APK
   *  shares as package-archive so capable receivers offer to install). */
  fun share(activity: Activity, f: File): FileActionResult {
    if (!f.exists() || !f.canRead()) {
      return FileActionResult.Failed("File not found on this device — nothing to share.")
    }
    val mime = mimeFor(activity, f.name)
    return try {
      val send = Intent(Intent.ACTION_SEND).apply {
        type = mime
        putExtra(Intent.EXTRA_STREAM, providerUri(activity, f))
        clipData = ClipData.newRawUri("nexdrop-file", providerUri(activity, f))
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.startActivity(Intent.createChooser(send, "Share ${f.name}"))
      FileActionResult.Launched("Sharing ${f.name} ($mime)")
    } catch (e: ActivityNotFoundException) {
      FileActionResult.Failed("No app can share this file type.")
    } catch (e: Exception) {
      FileActionResult.Failed("Could not share ${f.name}: ${e.message ?: "unexpected error"}.")
    }
  }

  /**
   * INSTALL APK — Android's supported package-installer flow only. Shows
   * the system install confirmation; NEVER bypasses the unknown-apps
   * permission (user is sent to Settings when not granted) and NEVER
   * installs silently.
   */
  fun installApk(activity: Activity, f: File): FileActionResult {
    if (!FileMimes.isApk(f.name, f)) {
      return FileActionResult.Failed(
        "${f.name} is not a valid APK (extension or file signature check failed).")
    }
    // Android O+ requires the user to allow installs from this app first.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      !activity.packageManager.canRequestPackageInstalls()) {
      return try {
        activity.startActivity(Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
          data = Uri.parse("package:${activity.packageName}")
        })
        FileActionResult.Launched(
          "Allow installs from NexDrop in Settings (unknown apps), then tap INSTALL APK again.")
      } catch (e: Exception) {
        FileActionResult.Failed(
          "NexDrop is not allowed to install apps. Enable \"Allow from this source\" for NexDrop in Android Settings.")
      }
    }
    return try {
      activity.startActivity(viewIntent(activity, f, FileMimes.APK_MIME, Intent.ACTION_VIEW))
      FileActionResult.Launched("Android install confirmation for ${f.name} — the system shows the final prompt.")
    } catch (e: ActivityNotFoundException) {
      FileActionResult.Failed("No package installer is available on this device.")
    } catch (e: SecurityException) {
      FileActionResult.Failed(
        "Install blocked by the system. Enable \"Allow from this source\" for NexDrop in Android Settings.")
    } catch (e: Exception) {
      FileActionResult.Failed("Could not start installation: ${e.message ?: "unexpected error"}.")
    }
  }

  /**
   * Save via Storage Access Framework: build a CREATE_DOCUMENT request for
   * the user-selected destination with the original filename suggested.
   * The caller launches it with its ActivityResultLauncher and handles the
   * returned URI via [copyTo].
   */
  fun saveIntent(context: Context, f: File): Intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
    addCategory(Intent.CATEGORY_OPENABLE)
    type = mimeFor(context, f.name)
    putExtra(Intent.EXTRA_TITLE, FileMimes.suggestSaveName(f.name))
  }

  sealed class SaveResult {
    data class Saved(val displayName: String, val bytes: Long, val sizeMatch: Boolean) : SaveResult()
    data class Failed(val reason: String) : SaveResult()
  }

  /**
   * Stream the source into the SAF target (64 KiB bounded buffer — never
   * whole-file in RAM), then verify the target really exists with the
   * expected size before reporting success. The source file is only read,
   * never moved, modified or deleted.
   */
  fun copyTo(resolver: ContentResolver, source: File, target: Uri): SaveResult {
    if (!source.exists() || !source.canRead()) return SaveResult.Failed("Source file is missing on this device.")
    val expected = source.length()
    return try {
      resolver.openOutputStream(target, "w")?.use { out ->
        java.io.FileInputStream(source).use { ins ->
          val copied = FileMimes.copyStream(ins, out)
          if (copied != expected) {
            return SaveResult.Failed("Save incomplete: $copied of $expected bytes written — the destination may be corrupt. Try again.")
          }
        }
      } ?: return SaveResult.Failed("The selected destination could not be opened for writing.")
      // verify through the provider itself: existence + size
      var displayName = source.name
      var savedSize = expected
      resolver.query(target, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          val di = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (di >= 0 && !c.isNull(di)) displayName = c.getString(di)
          val si = c.getColumnIndex(OpenableColumns.SIZE)
          if (si >= 0 && !c.isNull(si)) savedSize = c.getLong(si)
        }
      }
      if (savedSize >= 0 && savedSize != expected) {
        SaveResult.Failed("Saved file size mismatch (expected $expected bytes, destination reports $savedSize).")
      } else {
        SaveResult.Saved(displayName, expected, sizeMatch = true)
      }
    } catch (e: Exception) {
      SaveResult.Failed("Save failed: ${e.message ?: "destination write error"}. The original file is untouched.")
    }
  }
}
