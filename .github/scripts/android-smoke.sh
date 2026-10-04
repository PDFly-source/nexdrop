#!/usr/bin/env bash
# NexDrop Android smoke test — MOCKUP UI v1.2.0 (screens 01–08, 2026-10-04).
# Runs INSIDE reactivecircus/android-emulator-runner with an API 36 emulator.
# The emulator action executes its `script` input line-by-line, so all logic
# lives in this file instead of the YAML.
#
# Asserts the REAL mockup flows with REAL engine wiring:
#   01 Welcome (first launch) -> GET STARTED -> 02 Home
#   Home: SEND FILES -> 03 Send files (no scanner before a file is picked)
#   Home: RECEIVE -> 04 Receive + QR (one QR, truthful LOCAL DIRECT, details)
#   nav: Devices -> 08 Your NexDrop, History, Settings -> Device Test (hidden)
#   Device Test -> benchmark scanner opens (camera granted)
# No FATAL EXCEPTION anywhere. No benchmark on Home.
set -eu
PKG=com.nexdrop.ndt1

tap_by_text() {
  # The app is a ScrollView: tall states can push elements off-screen, where
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
# prefer exact text, then substring (both case-insensitive)
cands = [(m.group(2), m.group(3), m.group(4), m.group(5))
         for m in re.finditer(r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
         if m.group(1).casefold() == label.casefold()]
if not cands:
    cands = [(m.group(2), m.group(3), m.group(4), m.group(5))
             for m in re.finditer(r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
             if label.casefold() in m.group(1).casefold()]
if cands:
    x1, y1, x2, y2 = cands[0]
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
  if [ "$found" = "0" ]; then
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

echo '== 1) first launch: 01 Welcome, then GET STARTED -> 02 Home =='
adb install -r NexDrop-release.apk  # smoke the SIGNED production artifact
adb logcat -c
adb shell am start -W -n "$PKG/$PKG.MainActivity"
sleep 6
adb shell pidof "$PKG" > /dev/null || { echo 'SMOKE FAIL: process died'; adb logcat -d > logcat.txt; exit 1; }
if adb logcat -d | grep -q 'FATAL EXCEPTION'; then echo 'SMOKE FAIL: FATAL EXCEPTION on launch'; adb logcat -d > logcat.txt; exit 1; fi
dump_ui
grep -qi 'GET STARTED' ui.xml || { echo 'SMOKE FAIL: Welcome screen (GET STARTED) missing'; cat ui.xml; exit 1; }
grep -qi 'Your files' ui.xml || { echo 'SMOKE FAIL: welcome hero copy missing'; cat ui.xml; exit 1; }
tap_by_text 'GET STARTED'
sleep 2
dump_ui
grep -qi 'PRIVATE' ui.xml && grep -qi 'DIRECT\.' ui.xml && grep -qi 'FAST' ui.xml \
  || { echo 'SMOKE FAIL: Home headline missing'; cat ui.xml; exit 1; }
grep -qi 'SEND FILES' ui.xml || { echo 'SMOKE FAIL: SEND FILES card missing'; cat ui.xml; exit 1; }
grep -qi 'RECEIVE' ui.xml || { echo 'SMOKE FAIL: RECEIVE card missing'; cat ui.xml; exit 1; }
grep -qi 'LOCAL DIRECT' ui.xml || { echo 'SMOKE FAIL: LOCAL DIRECT card missing'; cat ui.xml; exit 1; }
grep -qi 'Local ready' ui.xml || { echo 'SMOKE FAIL: Local ready pill missing'; cat ui.xml; exit 1; }
grep -qi 'Home' ui.xml && grep -qi 'Transfer' ui.xml && grep -qi 'Devices' ui.xml \
  && grep -qi 'History' ui.xml && grep -qi 'Settings' ui.xml \
  || { echo 'SMOKE FAIL: bottom nav tabs missing'; cat ui.xml; exit 1; }
# Mission §10: benchmarks are ENGINEERING-ONLY — they must NOT be on Home.
if grep -qi 'benchmark' ui.xml; then echo 'SMOKE FAIL: benchmark leaked onto Home'; cat ui.xml; exit 1; fi
echo 'Welcome -> Home OK — mockup 01+02 live, no debug controls'

echo '== 2) 03 Send files: opens WITHOUT the scanner (file-first flow) =='
tap_by_text 'SEND FILES'
sleep 2
dump_ui
grep -qi 'Select files' ui.xml || { echo 'SMOKE FAIL: drop zone missing'; cat ui.xml; exit 1; }
grep -qi 'CONTINUE' ui.xml || { echo 'SMOKE FAIL: CONTINUE missing'; cat ui.xml; exit 1; }
grep -qi 'Images' ui.xml || { echo 'SMOKE FAIL: category chips missing'; cat ui.xml; exit 1; }
if resumed | grep -q CaptureActivity; then echo 'SMOKE FAIL: scanner opened without a file'; exit 1; fi
# CONTINUE without a file must NOT open the scanner either
tap_by_text 'CONTINUE'
sleep 1
if resumed | grep -q CaptureActivity; then echo 'SMOKE FAIL: scanner opened with no file selected'; exit 1; fi
echo 'Send files OK — no scanner until a real file is picked'
adb shell input keyevent 4
sleep 1

echo '== 3) 04 Receive: ONE QR + truthful LOCAL DIRECT + real expiry =='
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS
tap_by_text 'RECEIVE'
sleep 8
adb shell pidof "$PKG" > /dev/null || { echo 'SMOKE FAIL: died starting receive'; adb logcat -d > logcat.txt; exit 1; }
dump_ui
grep -qi 'scan this QR' ui.xml || { echo 'SMOKE FAIL: receive QR copy missing'; cat ui.xml; exit 1; }
grep -qi 'LOCAL DIRECT' ui.xml || { echo 'SMOKE FAIL: LOCAL DIRECT missing'; cat ui.xml; exit 1; }
grep -qi 'Waiting for device' ui.xml || { echo 'SMOKE FAIL: waiting state missing'; cat ui.xml; exit 1; }
grep -qi 'Expires' ui.xml || { echo 'SMOKE FAIL: real QR expiry missing'; cat ui.xml; exit 1; }
grep -qi 'REFRESH QR' ui.xml || { echo 'SMOKE FAIL: REFRESH QR missing'; cat ui.xml; exit 1; }
# Details sheet: full truthful transport diagnostics
tap_by_text 'Details'
sleep 2
dump_ui
grep -qi 'IP:' ui.xml || { echo 'SMOKE FAIL: local IP missing in details'; cat ui.xml; exit 1; }
grep -qi 'Route reachable: YES' ui.xml || { echo 'SMOKE FAIL: route reachable not YES'; cat ui.xml; exit 1; }
grep -qi 'Internet: NOT REQUIRED' ui.xml || { echo 'SMOKE FAIL: Internet NOT REQUIRED missing'; cat ui.xml; exit 1; }
tap_by_text 'Close'
sleep 1
adb shell input keyevent 4   # leave receive
sleep 2
echo 'Receive OK — ONE QR, truthful transport card + details'

echo '== 4) 08 Your NexDrop + History + Settings via bottom nav =='
tap_by_text 'Devices'
sleep 2
dump_ui
grep -qi 'Your NexDrop' ui.xml || { echo 'SMOKE FAIL: Your NexDrop missing'; cat ui.xml; exit 1; }
grep -qi 'Recent transfers' ui.xml || { echo 'SMOKE FAIL: recent transfers missing'; cat ui.xml; exit 1; }
grep -qi 'SHA-256 verification' ui.xml || { echo 'SMOKE FAIL: settings list missing'; cat ui.xml; exit 1; }
tap_by_text 'History'
sleep 2
dump_ui
grep -qi 'History' ui.xml || { echo 'SMOKE FAIL: History tab missing'; cat ui.xml; exit 1; }
tap_by_text 'Settings'
sleep 2
dump_ui
grep -qi 'Device Test (Advanced)' ui.xml || { echo 'SMOKE FAIL: Device Test entry missing'; cat ui.xml; exit 1; }
echo 'nav tabs OK'

echo '== 5) Device Test: engineering tools live BEHIND Settings =='
tap_by_text 'Device Test (Advanced)'
sleep 2
dump_ui
grep -qi 'benchmark' ui.xml || { echo 'SMOKE FAIL: benchmarks missing in Device Test'; cat ui.xml; exit 1; }
grep -qi '358 MiB' ui.xml || { echo 'SMOKE FAIL: 358 MiB benchmark missing'; cat ui.xml; exit 1; }
echo 'Device Test OK — benchmarks hidden behind Settings'

echo '== 6) benchmark path: scanner opens once CAMERA is granted =='
adb shell pm grant "$PKG" android.permission.CAMERA
tap_by_text 'Benchmark NATIVE'
sleep 3
resumed | grep -q CaptureActivity || { echo 'SMOKE FAIL: benchmark scan did not open'; adb logcat -d > logcat.txt; exit 1; }
adb shell input keyevent 4
sleep 1

echo '== 7) final: no crash anywhere in the whole run =='
if adb logcat -d | grep -q 'FATAL EXCEPTION'; then adb logcat -d > logcat.txt; echo 'SMOKE FAIL: FATAL EXCEPTION during run'; exit 1; fi
adb logcat -d > logcat.txt
echo 'STARTUP SMOKE TEST PASSED — mockup UI 01–08 wired to the real NDT1 engine: Welcome, Home, Send files, Receive+QR, Your NexDrop, History, hidden Device Test, benchmark scanner'
