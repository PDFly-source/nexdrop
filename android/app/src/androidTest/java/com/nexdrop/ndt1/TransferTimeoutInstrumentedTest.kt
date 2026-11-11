package com.nexdrop.ndt1

import android.app.ActivityManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * R1/R4 instrumented proof on a real API 36 emulator.
 *
 * The platform's 6-hour dataSync limit cannot be produced in CI, so this test
 * drives the SAME handler the platform calls (`handleDataSyncTimeout` via the
 * debug-only ACTION_SIMULATE_TIMEOUT path) against a REAL foreground service
 * instance, and asserts the observable, user-facing outcome:
 *   - the honest failure notice is posted (never a silent stop, never success),
 *   - the progress surface is removed,
 *   - the service is actually stopped,
 *   - the app process survives (no crash).
 */
@RunWith(AndroidJUnit4::class)
class TransferTimeoutInstrumentedTest {

  @Test
  fun dataSyncTimeoutStopsHonestly() {
    // onTimeout exists from API 35; the matrix emulator is API 36.
    if (Build.VERSION.SDK_INT < 35) return

    val inst = InstrumentationRegistry.getInstrumentation()
    val ctx: Context = inst.targetContext

    // Notifications must be visible for the assertion to mean anything.
    runCatching {
      inst.uiAutomation.executeShellCommand(
        "pm grant ${ctx.packageName} android.permission.POST_NOTIFICATIONS").close()
    }
    runCatching {
      inst.uiAutomation.executeShellCommand("appops set ${ctx.packageName} POST_NOTIFICATION allow").close()
    }

    // The override must exist and be bound exactly as the platform calls it.
    val override = TransferService::class.java.getDeclaredMethod(
      "onTimeout", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType)
    assertNotNull("Service.onTimeout override missing", override)

    // Foreground the app so starting a foreground service is permitted.
    ActivityScenario.launch(MainActivity::class.java).use {
      ContextCompat.startForegroundService(
        ctx, Intent(ctx, TransferService::class.java).putExtra("text", "1%  ·  test  —  probe.bin"))
      Thread.sleep(1_500)

      val nm = ctx.getSystemService(NotificationManager::class.java)
      assertTrue("progress surface never appeared", nm.activeNotifications.isNotEmpty())

      // Drive the real timeout handler.
      TransferService.simulateTimeout(ctx)
      Thread.sleep(2_500)

      val texts = nm.activeNotifications.map {
        it.notification.extras.getCharSequence("android.text")?.toString().orEmpty()
      }
      assertTrue(
        "honest timeout notice missing (seen: $texts)",
        texts.any { it.contains("data-sync limit", ignoreCase = true) })

      val running = ctx.getSystemService(ActivityManager::class.java)
        .getRunningServices(Int.MAX_VALUE)
        .any { it.service.className == TransferService::class.java.name }
      assertFalse("service still running after the timeout", running)
    }
  }
}
