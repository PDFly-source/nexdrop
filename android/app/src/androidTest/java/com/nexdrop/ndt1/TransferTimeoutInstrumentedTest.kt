package com.nexdrop.ndt1

import android.app.ActivityManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationManagerCompat
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
 * drives the SAME handler the platform calls (`handleDataSyncTimeout`, reached
 * through the debug-only ACTION_SIMULATE_TIMEOUT path) against a REAL
 * foreground-service instance, and asserts observable outcomes:
 *   - the foreground service really starts (it is a live FGS, not a stub),
 *   - the timeout path really stops it (no silent survival),
 *   - when notifications are permitted, the honest failure notice is posted
 *     and it never claims success,
 *   - the process survives (no crash).
 *
 * Notification *visibility* depends on POST_NOTIFICATIONS being granted in the
 * emulator image, which CI cannot rely on; that assertion is therefore gated
 * on NotificationManagerCompat.areNotificationsEnabled() and reported honestly
 * instead of being faked.
 */
@RunWith(AndroidJUnit4::class)
class TransferTimeoutInstrumentedTest {

  private fun poll(timeoutMs: Long, stepMs: Long = 250, cond: () -> Boolean): Boolean {
    val end = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < end) {
      if (cond()) return true
      Thread.sleep(stepMs)
    }
    return cond()
  }

  @Test
  fun dataSyncTimeoutStopsHonestly() {
    // onTimeout exists from API 35; the matrix emulator is API 36.
    if (Build.VERSION.SDK_INT < 35) return

    val inst = InstrumentationRegistry.getInstrumentation()
    val ctx: Context = inst.targetContext
    runCatching {
      inst.uiAutomation.executeShellCommand(
        "pm grant ${ctx.packageName} android.permission.POST_NOTIFICATIONS").close()
    }

    // The override must exist and be bound exactly as the platform calls it.
    val override = TransferService::class.java.getDeclaredMethod(
      "onTimeout", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType)
    assertNotNull("Service.onTimeout override missing", override)

    val am = ctx.getSystemService(ActivityManager::class.java)
    fun serviceRunning() = am.getRunningServices(Int.MAX_VALUE)
      .any { it.service.className == TransferService::class.java.name }

    ActivityScenario.launch(MainActivity::class.java).use {
      // A REAL foreground service carrying a live transfer surface.
      ContextCompat.startForegroundService(
        ctx, Intent(ctx, TransferService::class.java).putExtra("text", "1%  ·  test  —  probe.bin"))

      assertTrue("foreground service never started", poll(10_000) { serviceRunning() })
      val noticesEnabled = NotificationManagerCompat.from(ctx).areNotificationsEnabled()

      // Drive the real timeout handler (the exact path Service.onTimeout uses).
      TransferService.simulateTimeout(ctx)

      assertTrue("service still running after the dataSync timeout", poll(12_000) { !serviceRunning() })

      val nm = ctx.getSystemService(NotificationManager::class.java)
      val texts = nm.activeNotifications.map {
        it.notification.extras.getCharSequence("android.text")?.toString().orEmpty()
      }
      if (noticesEnabled) {
        assertTrue(
          "honest timeout notice missing (seen: $texts)",
          texts.any { it.contains("data-sync limit", ignoreCase = true) })
        assertFalse(
          "timeout must never be reported as success",
          texts.any { it.contains("Transfer complete", ignoreCase = true) })
      } else {
        println("NOTICE ASSERTION SKIPPED: notifications disabled in this emulator image")
      }

      // Activity must still be alive and resumed: no crash, no kill.
      val resumed = poll(5_000) {
        val d = inst.uiAutomation.executeShellCommand("dumpsys activity activities")
          .use { s -> java.io.BufferedReader(java.io.InputStreamReader(s.inputStream)).readText() }
        d.contains("ResumedActivity") && d.contains("com.nexdrop.ndt1")
      }
      assertTrue("app did not survive the timeout path", resumed)
    }
  }
}
