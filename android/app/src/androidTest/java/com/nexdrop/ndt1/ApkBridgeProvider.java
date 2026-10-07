package com.nexdrop.ndt1;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * TEST-ONLY provider (v1.5 Phase C closure). Gives the instrumented tests a
 * content:// face over files they write into the target app's cacheDir, so
 * the content:// APK bridge is exercised end-to-end exactly the way SAF /
 * share-sheet APK shares arrive (streamed via ContentResolver, no path).
 *
 * <p>Deliberately written in JAVA: this provider runs in the TEST package's
 * own process, whose classloader holds only the test APK. Kotlin code there
 * needs kotlin-stdlib dexed into the androidTest APK, which proved fragile —
 * the instrumentation process resolves the stdlib from the target APK, so
 * any packaging regression silently crashes the provider process with
 * NoClassDefFoundError the moment a resolver call arrives. Java has no
 * runtime dependency and cannot regress this way.
 *
 * <p>content://com.nexdrop.ndt1.test.apkbridge/&lt;filename&gt; maps to a
 * file in the directory supplied via the ?dir= query parameter (fixture
 * only, guarded to /data/user/), defaulting to the provider's own cacheDir.
 * query() reports DISPLAY_NAME and SIZE the same way real document
 * providers do.
 */
public class ApkBridgeProvider extends ContentProvider {

  private File fileFor(Uri uri) {
    String name = uri.getLastPathSegment();
    if (name == null) return null;
    if (name.contains("/") || name.contains("..")) return null; // path traversal guard
    String dir = uri.getQueryParameter("dir");
    File dirFile;
    // Fixture-only guard: never serve from outside the app data sandbox.
    if (dir != null && dir.startsWith("/data/user/")) {
      dirFile = new File(dir);
    } else {
      dirFile = getContext() == null ? null : getContext().getCacheDir();
    }
    if (dirFile == null) return null;
    File f = new File(dirFile, name);
    return f.isFile() ? f : null;
  }

  @Override
  public boolean onCreate() {
    return true;
  }

  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    File f = fileFor(uri);
    if (f == null) throw new FileNotFoundException(uri.toString());
    try {
      return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    } catch (IOException e) {
      throw new FileNotFoundException(uri.toString());
    }
  }

  @Override
  public Cursor query(Uri uri, String[] projection, String selection,
                      String[] selectionArgs, String sortOrder) {
    File f = fileFor(uri);
    if (f == null) return null;
    MatrixCursor c = new MatrixCursor(
        new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
    c.addRow(new Object[]{f.getName(), f.length()});
    return c;
  }

  @Override
  public String getType(Uri uri) {
    return "application/octet-stream";
  }

  @Override
  public Uri insert(Uri uri, ContentValues values) {
    return null;
  }

  @Override
  public int delete(Uri uri, String selection, String[] selectionArgs) {
    return 0;
  }

  @Override
  public int update(Uri uri, ContentValues values, String selection,
                    String[] selectionArgs) {
    return 0;
  }
}
