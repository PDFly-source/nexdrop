#!/usr/bin/env bash
# NexDrop Android startup smoke test — PRODUCTION UI (mission 2026-10-04).
# Runs INSIDE reactivecircus/android-emulator-runner with an API 36 emulator.
# The emulator action executes its `script` input line-by-line, so all logic
# lives in this file instead of the YAML.
set -eu
PKG=com.nexdrop.ndt1

tap_by_text() {
  # The app is a ScrollView: tall states can push buttons off-screen, where
  # uiautomator no longer reports them. Dump, find, tap — scroll and retry.
  local i found=0
  rm -f /tmp/tap.cmd
  for i in 1 2 3 4 5; do
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
    adb pull /sdcard/ui.xml ui.xml >/dev/null
    if python3 - "$1" <<'PYEOF' > /tmp/tap.cmd
import sys, re
label = sys.argv[1]
xml = open('ui.xml', encoding='utf-8').read()
# prefer exact text, then substring (both case-insensitive — buttons render caps)
cands = [(m.group(1), m.group(2), m.group(3), m.group(4), m.group(5))
         for m in re.finditer(r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
         if m.group(1).casefold() == label.casefold()]
if not cands:
    cands = [(m.group(1), m.group(2), m.group(3), m.group(4), m.group(5))
             for m in re.finditer(r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
             if label.casefold() in m.group(1).casefold()]
if cands:
    _, x1, y1, x2, y2 = cands[0]
    print(f"adb shell input tap {(int(x1)+int(x2))//2} {(int(y1)+int(y2))//2}")
    sys.exit(0)
sys.exit(1)
PYEOF
    then
      found=1
      break
    fi
    echo "  (label '$1' not visible — scrolling down, attempt $i)"
    adb shell input swipe 160 500 160 150 300
    sleep 1
  done
  if [ "$found" = 0 ]; then
    echo "SMOKE FAIL: label '$1' never became visible after scrolling"
    cat ui.xml
    exit 1
  fi
  cat /tmp/tap.cmd
  bash /tmp/tap.cmd
  sleep 2
}

dump_ui() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  adb pull /sdcard/ui.xml ui.xml >/dev/null
}

resumed() {
  adb shell dumpsys window 2>/dev/null | grep -i 'mCurrentFocus' || true
  adb shell dumpsys activity activities 2>/dev/null | grep -i 'ResumedActivity' || true
}

echo '== 1) launch: production HOME must appear, no crash, no debug buttons =='
adb install -r NexDrop-debug.apk
adb logcat -c
adb shell am start -W -n "$PKG/$PKG.MainActivity"
sleep 6
adb shell pidof "$PKG" > /dev/null || { echo 'SMOKE FAIL: process died'; adb logcat -d > logcat.txt; exit 1; }
if adb logcat -d | grep -q 'FATAL EXCEPTION'; then echo 'SMOKE FAIL: FATAL EXCEPTION on launch'; adb logcat -d > logcat.txt; exit 1; fi
dump_ui
grep -qi 'nexdrop' ui.xml || { echo 'SMOKE FAIL: home title missing'; cat ui.xml; exit 1; }
grep -qi 'private.*direct.*fast\|PRIVATE' ui.xml || { echo 'SMOKE FAIL: tagline missing'; cat ui.xml; exit 1; }
grep -qi 'send' ui.xml || { echo 'SMOKE FAIL: SEND missing'; cat ui.xml; exit 1; }
grep -qi 'receive' ui.xml || { echo 'SMOKE FAIL: RECEIVE missing'; exit 1; }
grep -qi 'LOCAL DIRECT' ui.xml || { echo 'SMOKE FAIL: transport status card missing'; cat ui.xml; exit 1; }
# Mission §10: benchmarks are ENGINEERING-ONLY — they must NOT be on Home.
if grep -qi 'benchmark' ui.xml; then echo 'SMOKE FAIL: benchmark button leaked onto the production Home'; cat ui.xml; exit 1; fi
echo 'HOME OK — production layout, no debug controls'

echo '== 2) SEND: QR scanner must NOT open before the CAMERA permission is granted =='
tap_by_text 'SEND'
if resumed | grep -q CaptureActivity; then echo 'SMOKE FAIL: scanner opened without permission'; exit 1; fi
echo 'permission gate OK (scanner did not open without grant)'
adb shell input keyevent 4
sleep 1

echo '== 3) SEND: with CAMERA granted the scanner opens =='
adb shell pm grant "$PKG" android.permission.CAMERA
tap_by_text 'SEND'
sleep 3
resumed | grep -q CaptureActivity || { echo 'SMOKE FAIL: scanner did not open'; adb logcat -d > logcat.txt; exit 1; }
echo 'scanner opens after grant'
adb shell input keyevent 4
sleep 1

echo '== 4) RECEIVE: ONE QR + truthful LOCAL DIRECT card + foreground service =='
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS
tap_by_text 'RECEIVE'
sleep 8
adb shell pidof "$PKG" > /dev/null || { echo 'SMOKE FAIL: died starting receive'; adb logcat -d > logcat.txt; exit 1; }
dump_ui
grep -qi 'LOCAL DIRECT' ui.xml || { echo 'SMOKE FAIL: LOCAL DIRECT badge missing'; cat ui.xml; exit 1; }
grep -qi 'NDT1 TCP' ui.xml || { echo 'SMOKE FAIL: NDT1 TCP line missing'; cat ui.xml; exit 1; }
grep -qi 'IP:' ui.xml || { echo 'SMOKE FAIL: local IP missing'; cat ui.xml; exit 1; }
grep -qi 'Route reachable: YES' ui.xml || { echo 'SMOKE FAIL: route reachable not YES'; cat ui.xml; exit 1; }
grep -qi 'Internet: NOT REQUIRED' ui.xml || { echo 'SMOKE FAIL: Internet NOT REQUIRED line missing'; cat ui.xml; exit 1; }
echo 'receive path OK — ONE QR screen, truthful transport card'
# Back to Home (Done), then Settings
tap_by_text 'Done'
sleep 2

echo '== 5) Settings -> Device Test: engineering tools live BEHIND Settings =='
tap_by_text 'Settings'
sleep 2
dump_ui
grep -qi 'device test' ui.xml || { echo 'SMOKE FAIL: Device Test entry missing in Settings'; cat ui.xml; exit 1; }
tap_by_text 'Device Test (Advanced)'
sleep 2
dump_ui
grep -qi 'benchmark' ui.xml || { echo 'SMOKE FAIL: benchmarks missing in Device Test'; cat ui.xml; exit 1; }
echo 'Device Test reachable — benchmarks hidden behind Settings (production §10)'

echo '== 6) Benchmark path still works: scanner opens for the native benchmark =='
tap_by_text 'Benchmark NATIVE'
sleep 3
resumed | grep -q CaptureActivity || { echo 'SMOKE FAIL: benchmark scan did not open'; adb logcat -d > logcat.txt; exit 1; }
adb shell input keyevent 4
sleep 1

echo '== 7) final: no crash anywhere in the whole run =='
if adb logcat -d | grep -q 'FATAL EXCEPTION'; then adb logcat -d > logcat.txt; echo 'SMOKE FAIL: FATAL EXCEPTION during run'; exit 1; fi
adb logcat -d > logcat.txt
echo 'STARTUP SMOKE TEST PASSED — production Home, permission gates, ONE-QR receive, hidden Device Test, benchmark path all clean'
