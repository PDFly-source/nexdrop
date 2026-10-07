package com.nexdrop.ndt1

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File

/**
 * TEST-ONLY provider (v1.5 Phase C closure). Gives the instrumented tests a
 * content:// face over files they write into the target app's cacheDir, so
 * the content:// APK bridge is exercised end-to-end exactly the way SAF /
 * share-sheet APK shares arrive (streamed via ContentResolver, no path).
 *
 * <content://com.nexdrop.ndt1.test.apkbridge/<filename>> maps to
 * <context.cacheDir>/<filename>. query() reports DISPLAY_NAME and SIZE the
 * same way real document providers do.
 */
class ApkBridgeProvider : ContentProvider() {

  private fun fileFor(uri: Uri): File? {
    val name = uri.lastPathSegment ?: return null
    if (name.contains('/') || name.contains("..")) return null // path traversal guard
    val f = File(context!!.cacheDir, name)
    return if (f.isFile) f else null
  }

  override fun onCreate(): Boolean = true

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? =
    fileFor(uri)?.let { ParcelFileDescriptor.open(it, ParcelFileDescriptor.MODE_READ_ONLY) }

  override fun openAssetFile(uri: Uri, mode: String): ParcelFileDescriptor? = openFile(uri, mode)

  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? {
    val f = fileFor(uri) ?: return null
    return MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).apply {
      addRow(arrayOf(f.name, f.length()))
    }
  }

  override fun getType(uri: Uri): String? = "application/octet-stream"
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
