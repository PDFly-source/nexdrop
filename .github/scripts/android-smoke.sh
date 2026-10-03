#!/usr/bin/env bash
# NexDrop Android startup smoke test (mission §8).
# Runs INSIDE reactivecircus/android-emulator-runner with an API 36 emulator.
# Single-line entry point: the emulator action executes its `script` input
# line-by-line, so all logic lives in this file instead of the YAML.
set -eu
PKG=com.nexdrop.ndt1

tap_by_text() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  adb pull /sdcard/ui.xml ui.xml >/dev/null
  python3 - "$1" <<'PYEOF' > /tmp/tap.cmd
import sys, re
label = sys.argv[1]
xml = open('ui.xml', encoding='utf-8').read()
for m in re.finditer(r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml):
    if label in m.group(1):
        x = (int(m.group(2)) + int(m.group(4))) // 2
        y = (int(m.group(3)) + int(m.group(5))) // 2
        print(f"adb shell input tap {x} {y}")
        sys.exit(0)
sys.exit(1)
PYEOF
  cat /tmp/tap.cmd
  bash /tmp/tap.cmd
  sleep 2
}

resumed() {
  adb shell dumpsys activity activities | grep -o 'mResumedActivity[^ ]* [^ ]*' | head -1 || true
}

echo '== 1) launch: MainActivity must appear, no crash =='
adb install -r NexDrop-debug.apk
adb logcat -c
adb shell am start -W -n "$PKG/$PKG.MainActivity"
sleep 6
adb shell pidof "$PKG" > /dev/null || { echo 'SMOKE FAIL: process died'; adb logcat -d > logcat.txt; exit 1; }
if adb logcat -d | grep -q 'FATAL EXCEPTION'; then echo 'SMOKE FAIL: FATAL EXCEPTION on launch'; adb logcat -d > logcat.txt; exit 1; fi
adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
adb pull /sdcard/ui.xml ui.xml >/dev/null
grep -q 'NexDrop Turbo' ui.xml || { echo 'SMOKE FAIL: minimal UI not visible'; cat ui.xml; exit 1; }
grep -q 'Receive' ui.xml || { echo 'SMOKE FAIL: Receive control missing'; exit 1; }
echo 'LAUNCH OK — minimal stable UI visible'

echo '== 2) Send: QR scanner must NOT open before the CAMERA permission is granted =='
tap_by_text 'Send — scan ONE QR'
if resumed | grep -q CaptureActivity; then echo 'SMOKE FAIL: scanner opened without permission'; exit 1; fi
echo 'permission gate OK (scanner did not open without grant)'
adb shell input keyevent 4
sleep 1

echo '== 3) Send: with CAMERA granted the scanner opens =='
adb shell pm grant "$PKG" android.permission.CAMERA
tap_by_text 'Send — scan ONE QR'
sleep 3
resumed | grep -q CaptureActivity || { echo 'SMOKE FAIL: scanner did not open'; adb logcat -d > logcat.txt; exit 1; }
echo 'scanner opens after grant'
adb shell input keyevent 4
sleep 1

echo '== 4) Receive: QR + foreground service start, no crash =='
adb shell pm grant "$PKG" android.permission.NEARBY_WIFI_DEVICES
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS
tap_by_text 'Receive — show ONE QR'
sleep 8
adb shell pidof "$PKG" > /dev/null || { echo 'SMOKE FAIL: died starting receive'; adb logcat -d > logcat.txt; exit 1; }
adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
adb pull /sdcard/ui.xml ui.xml >/dev/null
grep -q 'Receiving — QR ready' ui.xml || { echo 'SMOKE FAIL: receive QR not ready'; cat ui.xml; adb logcat -d > logcat.txt; exit 1; }
echo 'receive path OK — native receiver bound, no crash'

echo '== 5) Benchmark: scanner opens for the native benchmark path =='
adb shell input keyevent 4
sleep 1
tap_by_text 'Benchmark NATIVE 358 MB'
sleep 3
resumed | grep -q CaptureActivity || { echo 'SMOKE FAIL: benchmark scan did not open'; adb logcat -d > logcat.txt; exit 1; }
adb shell input keyevent 4
sleep 1

echo '== 6) final: no crash anywhere in the whole run =='
if adb logcat -d | grep -q 'FATAL EXCEPTION'; then adb logcat -d > logcat.txt; echo 'SMOKE FAIL: FATAL EXCEPTION during run'; exit 1; fi
adb logcat -d > logcat.txt
echo 'STARTUP SMOKE TEST PASSED — launch, permission gate, scanner, receive, benchmark all clean'
