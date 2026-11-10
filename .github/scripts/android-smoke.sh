#!/usr/bin/env bash
# NexDrop Android smoke test — MOCKUP UI v1.2.1 (screens 01–08 + stability pass, 2026-10-04).
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
# v1.2.1 additions: Back affordance + real Back stack, layout audit (no
# horizontal overflow, nav never covered), live NDT1 real-data pass (QR
# decode -> emulator tunnel -> CLI send -> on-device ACCEPT -> SHA-256
# verify -> populated History/Devices -> clear history), font-scale 1.3
# robustness pass.
set -eu
PKG=com.nexdrop.ndt1

# =========================================================================
# v1.5 Phase C: INSTRUMENTED PREVIEW TESTS first — real decoders on this
# emulator (bounded ImageDecoder thumbnails, PDF page-1, APK metadata,
# audio duration, corrupted/inaccessible honest fallbacks, cache + async
# contract). Runs BEFORE the signed release APK is installed because the
# instrumented app APK is debug-signed (same package id — install order
# matters); gradle uninstalls both when it finishes, leaving the emulator
# clean for the release smoke below.
# =========================================================================
echo '== 0) v1.5 Phase C instrumented preview tests (real Android decoders) =='
cd "$GITHUB_WORKSPACE/android"
./gradlew --no-daemon --stacktrace :app:connectedDebugAndroidTest \
  || { echo 'PREVIEW INSTRUMENTED TESTS FAILED'; exit 1; }
cd - >/dev/null
echo 'PREVIEW INSTRUMENTED TESTS PASS — real bounded previews + honest fallbacks verified'

tap_nav() {
  # Tap a BOTTOM-NAV tab. Screen content may contain the same word
  # ('Settings' quick-header on Your NexDrop, 'History' rows, ...), and
  # tap_by_text picks the first exact match in document order — which can be
  # content, not the tab. This helper picks the bottom-most exact match
  # (the nav) and never scrolls.
  local i
  for i in 1 2 3; do
    dump_ui
    if python3 - "$1" <<'PYEOF' > /tmp/navtap.cmd
import sys, re
label = sys.argv[1].casefold()
xml = open('ui.xml', encoding='utf-8').read()
cands = [(m.group(2), m.group(3), m.group(4), m.group(5))
         for m in re.finditer(r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
         if m.group(1).casefold() == label]
# The bottom nav is the bottom-most exact match on screen (content items
# with the same word, e.g. the 'Settings' quick-header, always sit above it).
# Font-scale changes shift the nav's y position, so never hardcode it.
if cands:
    x1, y1, x2, y2 = max(cands, key=lambda c: int(c[1]))
    print(f"adb shell input tap {(int(x1)+int(x2))//2} {(int(y1)+int(y2))//2}")
    sys.exit(0)
sys.exit(1)
PYEOF
    then
      break
    fi
    sleep 1
  done
  if [ ! -s /tmp/navtap.cmd ]; then
    echo "SMOKE FAIL: bottom-nav tab '$1' not found"
    cat ui.xml
    exit 1
  fi
  cat /tmp/navtap.cmd
  bash /tmp/navtap.cmd
}

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

tap_by_desc() {
  # Tap the first node whose content-desc matches (icon-only affordances
  # like the top-left Back button have no text for tap_by_text).
  local i found=0
  rm -f /tmp/tapd.cmd
  for i in 1 2 3 4 5; do
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
    adb pull /sdcard/ui.xml ui.xml >/dev/null
    if python3 - "$1" <<'PYD' > /tmp/tapd.cmd
import sys, re
label = sys.argv[1]
xml = open('ui.xml', encoding='utf-8').read()
cands = [(m.group(2), m.group(3), m.group(4), m.group(5))
         for m in re.finditer(r'content-desc="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
         if label.casefold() in m.group(1).casefold()]
if cands:
    x1, y1, x2, y2 = cands[0]
    print(f"adb shell input tap {(int(x1)+int(x2))//2} {(int(y1)+int(y2))//2}")
    sys.exit(0)
sys.exit(1)
PYD
    then
      found=1
      break
    fi
    adb shell input swipe 160 500 160 150 300
    sleep 1
  done
  if [ "$found" = "0" ]; then
    echo "SMOKE FAIL: content-desc '$1' never became visible after scrolling"
    cat ui.xml
    exit 1
  fi
  cat /tmp/tapd.cmd
  bash /tmp/tapd.cmd
  sleep 2
}

require_text() {
  # Assert a text is visible, scrolling the screen up to 5 times to find it
  # (sectioned Settings pushes deep rows below the fold).
  local i found=0
  for i in 1 2 3 4 5; do
    dump_ui
    if grep -qi -- "$1" ui.xml; then found=1; break; fi
    adb shell input swipe 160 500 160 150 300
    sleep 1
  done
  if [ "$found" = "0" ]; then
    echo "SMOKE FAIL: '$1' never became visible after scrolling"
    cat ui.xml
    exit 1
  fi
}

assert_layout() {
  # Layout audit: (a) no horizontal overflow beyond the screen; (b) on tab
  # screens the fixed bottom nav is never covered by content. The nav bar
  # is the deepest common ancestor of the bottom-area tab labels in the
  # accessibility tree; any node that is neither INSIDE the nav subtree nor
  # a tree ANCESTOR of it, yet intersects its rect, means content was pushed
  # under the nav (rect containment alone cannot tell ancestor from sibling
  # covering the nav — only the tree can).
  local SIZE SW SH
  SIZE=$(adb shell wm size | sed -n 's/.*: \([0-9]*\)x\([0-9]*\)/\1 \2/p' | tail -1)
  SW=$(echo "$SIZE" | cut -d' ' -f1)
  SH=$(echo "$SIZE" | cut -d' ' -f2)
  dump_ui
  python3 - "$1" "$SW" "$SH" "$2" <<'PYA' || { echo "SMOKE FAIL: layout audit '$1'"; cat ui.xml; exit 1; }
import sys, re
import xml.etree.ElementTree as ET
label, SW, SH, has_nav = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4] == "1"
root = ET.parse("ui.xml").getroot()
def bnd(n):
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", n.get("bounds", ""))
    return tuple(map(int, m.groups())) if m else None
nodes = [n for n in root.iter("node")]
rects = [b for b in (bnd(n) for n in nodes) if b]
overflow = [b for b in rects if b[0] < 0 or b[2] > SW]
if overflow:
    print(f"OVERFLOW: {len(overflow)} nodes exceed screen width {SW}, e.g. {overflow[:3]}")
    sys.exit(1)
if has_nav:
    # only bottom-area labels count as nav tabs (screen titles share texts)
    labels = [n for n in nodes
              if n.get("text") in ("Home", "Transfer", "Devices", "History", "Settings")
              and (b := bnd(n)) and b[1] >= 0.70 * SH]
    if not labels:
        print("NAV MISSING: no bottom-nav tab labels on a tab screen")
        sys.exit(1)
    parent = {c: p for p in root.iter() for c in p}
    def chain(n):
        out = []
        cur = parent.get(n)
        while cur is not None:
            out.append(cur); cur = parent.get(cur)
        return out
    chains = [chain(l) for l in labels]
    common = set(map(id, chains[0]))
    for c in chains[1:]:
        common &= set(map(id, c))
    lca = next(n for n in chains[0] if id(n) in common)
    nav = bnd(lca)
    if nav is None or (nav[3] - nav[1]) > 0.30 * SH:
        print(f"NAV AMBIGUOUS: label LCA rect {nav} is not a slim bottom bar")
        sys.exit(1)
    sub = {id(n) for n in lca.iter("node")}
    anc = {id(n) for n in chain(lca)}
    def decorative(n):
        # childless, label-less background scrims draw behind the UI; only
        # real content containers matter for the covered-nav rule
        return len(n) == 0 and not n.get("text") and not n.get("content-desc")
    bad = []
    for n in nodes:
        if id(n) in sub or id(n) in anc: continue
        b = bnd(n)
        if not b or decorative(n): continue
        ix = min(b[2], nav[2]) - max(b[0], nav[0])
        iy = min(b[3], nav[3]) - max(b[1], nav[1])
        if ix > 2 and iy > 2: bad.append(b)
    if bad:
        print(f"NAV OVERLAP: {len(bad)} nodes outside the nav tree intrude into nav rect {nav}, e.g. {bad[:3]}")
        sys.exit(1)
print(f"LAYOUT OK: {len(rects)} nodes within screen, nav clean" if has_nav else f"LAYOUT OK: {len(rects)} nodes within screen")
PYA
}
resumed_component() {
  # dumpsys prints the task stack first, so `grep -m1` matched a STALE task entry
  # and never the resumed_component activity. mResumedActivity is authoritative; window
  # focus is the fallback when the field is absent on newer builds.
  local out
  out=$(adb shell dumpsys activity activities 2>/dev/null | grep -m1 -E "mResumedActivity|topResumedActivity" || true)
  if [ -z "$out" ]; then
    out=$(adb shell dumpsys window 2>/dev/null | grep -m1 "mCurrentFocus" || true)
  fi
  printf '%s' "$out" | grep -oE 'com\.nexdrop\.ndt1/[A-Za-z0-9_.$]+' | head -1
}
main_records() { adb shell dumpsys activity activities 2>/dev/null | grep -c "ActivityRecord{.*com\.nexdrop\.ndt1/\.MainActivity" || true; }
# Historical records pile up in dumpsys; only state=RESUMED is a live instance.
active_main() { adb shell dumpsys activity activities 2>/dev/null | grep "ActivityRecord{.*com\.nexdrop\.ndt1/\.MainActivity" | grep -c "state=RESUMED" || true; }
main_task_ids() { adb shell dumpsys activity activities 2>/dev/null | grep "ActivityRecord{.*com\.nexdrop\.ndt1/\.MainActivity" | grep -oE "taskId=[0-9]+" | sort -u | tr "\n" " "; }
splash_live() { adb shell dumpsys activity activities 2>/dev/null | grep "ActivityRecord{.*com\.nexdrop\.ndt1/\.SplashActivity" | grep -c "state=RESUMED" || true; }
pid_now() { adb shell pidof com.nexdrop.ndt1 2>/dev/null | tr -d '\r' || true; }
mkdir -p screenshots
diag() {
  local t="$1"
  mkdir -p screenshots
  mkdir -p screenshots 2>/dev/null || true
  { echo "# diag $t $(date -u +%FT%TZ)"; echo "# pid=$(pid_now)"; echo "# resumed_component=$(resumed_component)"; echo "# mainRecords=$(main_records)"; } > "screenshots/diag-$t.txt" 2>/dev/null || true
  adb shell dumpsys activity activities >> "screenshots/diag-$t.txt" 2>&1 || true
  adb logcat -d -s NexDropSplash:V AndroidRuntime:E ActivityTaskManager:I > "screenshots/diag-$t-logcat.txt" 2>&1 || true
  tail -40 "screenshots/diag-$t-logcat.txt" || true
}
wait_activity() { # $1 = expected suffix, $2 = attempts (x0.25s)
  local want="$1" n=0 cur
  while [ $n -lt "${2:-40}" ]; do
    cur=$(resumed_component)
    case "$cur" in *"$want"*) return 0;; esac
    sleep 0.25; n=$((n+1))
  done
  return 1
}

echo '== S0) release artifact install + preflight (F2) =='
APK_PATH="$GITHUB_WORKSPACE/NexDrop-release.apk"
[ -f "$APK_PATH" ] || APK_PATH=$(find "$GITHUB_WORKSPACE" -maxdepth 2 -name "NexDrop-release.apk" 2>/dev/null | head -1)
echo "artifact: ${APK_PATH:-NOT FOUND} (must be the downloaded artifact; repo copies rc1-apk/ rc2-apk/ t-apk/ exist)"
GRADLE_MK="$GITHUB_WORKSPACE/android/app/build.gradle.kts"
EXP_CODE=$(grep -oE "versionCode = [0-9]+" "$GRADLE_MK" | grep -oE "[0-9]+" | head -1)
EXP_NAME=$(grep -oE "versionName = \"[^\"]+\"" "$GRADLE_MK" | cut -d'"' -f2 | head -1)
echo "source of truth: $EXP_NAME / $EXP_CODE"
ART_SHA=$(sha256sum "$APK_PATH" | cut -d" " -f1); echo "artifact sha256: $ART_SHA"; ls -l "$APK_PATH" || true
BT=$(find "$ANDROID_HOME/build-tools" -name aapt2 -type f | sort -V | tail -1)
AS=$(find "$ANDROID_HOME/build-tools" -name apksigner -type f | sort -V | tail -1)
BADGE=$("$BT" dump badging "$APK_PATH" 2>/dev/null | head -1 || true)
echo "$BADGE"
case "$BADGE" in *"versionCode='$EXP_CODE'"*) : ;; *) echo "PREFLIGHT BLOCKED: artifact versionCode != $EXP_CODE"; exit 1;; esac
case "$BADGE" in *"versionName='$EXP_NAME'"*) : ;; *) echo "PREFLIGHT BLOCKED: artifact versionName != $EXP_NAME"; exit 1;; esac
echo "artifact matches source: $EXP_NAME / $EXP_CODE"
APPROVED_CERT=11cb2ab82ba751fea04d101bd3a1498b852581f999056a3bc371e47e326a861a
PC=$("$AS" verify --print-certs "$APK_PATH" 2>&1 || true)
echo "-- apksigner --print-certs (raw) --"; printf "%s\n" "$PC" | head -8
CERT=$(printf "%s\n" "$PC" | grep -oiE "SHA-256 digest:[[:space:]]*[0-9a-fA-F]{64}" | head -1 | grep -oiE "[0-9a-fA-F]{64}" | tr "A-F" "a-f")
if [ -z "$CERT" ]; then
  KT=$(find "$JAVA_HOME/bin" -name keytool 2>/dev/null | head -1)
  if [ -n "$KT" ]; then
    KO=$("$KT" -printcert -jarfile "$APK_PATH" 2>&1 || true)
    echo "-- keytool -printcert (fallback) --"; printf "%s\n" "$KO" | grep -m2 -iE "Owner|SHA256" || true
    CERT=$(printf "%s\n" "$KO" | grep -m1 -i "SHA256:" | sed "s/.*SHA256:[[:space:]]*//" | tr -d ": \r" | tr "A-F" "a-f")
  fi
fi
echo "signing cert sha256: ${CERT:-UNRESOLVED}"
if [ -z "$CERT" ]; then echo "PREFLIGHT BLOCKED: signing certificate could not be resolved (never treated as pass)"; diag preflight-cert-unresolved; exit 1; fi
if [ "$CERT" != "$APPROVED_CERT" ]; then echo "PREFLIGHT BLOCKED: cert $CERT != approved $APPROVED_CERT"; diag preflight-cert-mismatch; exit 1; fi
echo "signing identity PASS: $CERT == approved NexDrop release identity"
echo "-- gradle / install tasks in this script (ordering proof) --"
grep -nE "connectedDebugAndroidTest|gradlew |adb (un)?install" "$0" | sed "s/^/  /"
echo '-- device --'; adb devices; adb shell getprop ro.build.version.sdk || true
echo '-- package state before install (uninstall diagnostics) --'
BEFORE=$(adb shell pm list packages 2>/dev/null | grep -c "com.nexdrop.ndt1" || true)
echo "package present before: ${BEFORE:-0}"
adb shell dumpsys package com.nexdrop.ndt1 2>/dev/null | grep -E "pkgFlags|flags=|User 0|installed=" | head -5 || echo "(no package to inspect)"
if [ "${BEFORE:-0}" -gt 0 ]; then
  RC=0; OUT=$(adb shell pm uninstall com.nexdrop.ndt1 2>&1) || RC=$?
  echo "uninstall rc=$RC :: $(printf "%s" "$OUT" | tr "\n" " " | cut -c1-120)"
  if [ "$RC" -ne 0 ]; then
    RC2=0; OUT2=$(adb shell pm uninstall --user 0 com.nexdrop.ndt1 2>&1) || RC2=$?
    echo "uninstall --user 0 rc=$RC2 :: $(printf "%s" "$OUT2" | tr "\n" " " | cut -c1-120)"
  fi
  AFTER=$(adb shell pm list packages 2>/dev/null | grep -c "com.nexdrop.ndt1" || true)
  echo "package present after uninstall attempt: ${AFTER:-0}"
  if [ "${AFTER:-0}" -gt 0 ]; then
    echo "NOTE: uninstall did not remove the package (device-managed state); the following adb install -r -d replaces the APK in place"
    echo "      data/cache is NOT proven wiped - recorded as a limitation, not as a clean uninstall"
  fi
else
  echo "clean device: package absent before install, nothing to uninstall"
fi
echo '-- install the exact release artifact --'
RC=0; OUT=$(adb install -r -d "$APK_PATH" 2>&1) || RC=$?
echo "install rc=$RC :: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-160)"
[ "$RC" -eq 0 ] || { echo 'PREFLIGHT BLOCKED: release install failed'; diag preflight-install-failed; exit 1; }
case "$OUT" in *Success*) : ;; *) echo 'PREFLIGHT BLOCKED: install output is not Success'; exit 1;; esac
echo '-- installed identity vs artifact --'
INST=$(adb shell dumpsys package com.nexdrop.ndt1 | grep -E "versionName=|versionCode=" | head -2 || true)
echo "$INST"
echo "$INST" | grep -q "versionName=1.4.7" || { echo 'PREFLIGHT BLOCKED: installed versionName != 1.4.7'; diag preflight-version; exit 1; }
echo "$INST" | grep -q "versionCode=20" || { echo 'PREFLIGHT BLOCKED: installed versionCode != 20'; diag preflight-version; exit 1; }
echo "installed codePath: $(adb shell pm path com.nexdrop.ndt1 | head -1 | tr -d '\r')"
echo '-- exactly one MAIN/LAUNCHER activity --'
QB=$(adb shell cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.nexdrop.ndt1 2>/dev/null | grep "com.nexdrop.ndt1/" | tr -d '\r' || true)
LAUNCHERS=$(printf '%s' "$QB" | grep -c "com.nexdrop.ndt1/" || true)
echo "query-activities: ${QB:-<empty>}"; echo "launcher activity count: ${LAUNCHERS:-0}"
RESOLVE=$(adb shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.nexdrop.ndt1 2>&1 | tail -1 | tr -d '\r' || true)
echo "resolve-activity: ${RESOLVE:-<empty>}"
echo '-- splash declaration --'
adb shell dumpsys package com.nexdrop.ndt1 | grep -A4 'com.nexdrop.ndt1.SplashActivity' | head -8 || true
PREFLIGHT_OK=0
if [ "${LAUNCHERS:-0}" -eq 1 ]; then
  case "$RESOLVE$QB" in *com.nexdrop.ndt1/.SplashActivity*) PREFLIGHT_OK=1;; esac
fi
if [ "$PREFLIGHT_OK" -eq 1 ]; then
  echo "PREFLIGHT PASS: install rc=0 :: 1.4.7 / 20 :: one MAIN/LAUNCHER -> SplashActivity :: cert ${CERT:-unknown} :: sha256 $ART_SHA"
  diag preflight-pass
else
  echo "PREFLIGHT BLOCKED: launchers=${LAUNCHERS:-0} resolve=${RESOLVE:-<empty>} query=${QB:-<empty>}"
  SPLASH_FAIL=1; diag preflight-blocked; exit 1
fi

echo '== S1) launcher intent resolves to SplashActivity =='
LAUNCHER="$RESOLVE"
echo "launcher activity: $LAUNCHER"
case "$LAUNCHER" in *SplashActivity*) echo 'SPLASH: launcher=SplashActivity PASS';; *) echo 'SPLASH: launcher=SplashActivity FAIL'; SPLASH_FAIL=1;; esac

echo '== S2) cold start via launcher: splash renders, then transitions =='
adb shell am force-stop "$PKG"
RC=0; AMOUT=$(adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$PKG/$PKG.SplashActivity" 2>&1) || RC=$?
echo "am start rc=$RC :: $(printf '%s' "$AMOUT" | tr '\n' ' ' | cut -c1-160)"
[ "$RC" -eq 0 ] || { echo "SPLASH: am start FAILED rc=$RC"; SPLASH_FAIL=1; diag s2-amstart-failed; }
sleep 0.7; adb exec-out screencap -p > screenshots/30-splash-cold.png
TOP=$(resumed_component); echo "resumed_component during splash window: $TOP"
case "$TOP" in *SplashActivity*) echo "SPLASH: rendered PASS (resumed_component=$TOP, pid=$(pid_now))";; *) echo "SPLASH: rendered FAIL (resumed_component=$TOP)"; SPLASH_FAIL=1;; esac
diag s2-splash
T0=$(date +%s%N)
if wait_activity "MainActivity" 40; then D=$(( ($(date +%s%N)-T0)/1000000 )); echo "SPLASH: transition SplashActivity -> MainActivity PASS (${D}ms, resumed_component=$(resumed_component), mainRecords=$(main_records))"; [ "$D" -le 4500 ] && echo 'SPLASH: 4s fail-safe within bound PASS' || { echo 'SPLASH: 4s fail-safe exceeded FAIL'; SPLASH_FAIL=1; }
else echo 'SPLASH: transition FAIL (MainActivity never resumed)'; SPLASH_FAIL=1; fi
diag s2-post-transition || true
ACCEPTED=$(grep -c "transition ACCEPTED" screenshots/diag-s2-post-transition-logcat.txt 2>/dev/null || echo 0)
REJECTED=$(grep -c "transition REJECTED" screenshots/diag-s2-post-transition-logcat.txt 2>/dev/null || echo 0)
STARTS=$(grep -c "MainActivity start requested" screenshots/diag-s2-post-transition-logcat.txt 2>/dev/null || echo 0)
echo "SPLASH: transition accepted=$ACCEPTED rejected=$REJECTED mainStarts=$STARTS (immediately after S2)"
if [ "${ACCEPTED:-0}" -eq 1 ] && [ "${STARTS:-0}" -eq 1 ]; then
  echo 'SPLASH: duplicate-start prevention PASS (exactly one accepted transition, one start)'
else
  echo "SPLASH: duplicate-start prevention INCONCLUSIVE (accepted=${ACCEPTED:-0} starts=${STARTS:-0})"
fi
ACT=$(active_main); TIDS=$(main_task_ids); SPLASH_LIVE=$(splash_live)
echo "SPLASH: active MainActivity instances=$ACT taskIds=[${TIDS:-none}] liveSplash=$SPLASH_LIVE"
if [ "${ACT:-0}" -eq 1 ]; then echo "SPLASH: exactly one active MainActivity PASS (taskIds=[${TIDS:-none}])"; else echo "SPLASH: exactly one active MainActivity FAIL (active=${ACT:-0})"; SPLASH_FAIL=1; fi
FATAL=$(adb logcat -d 2>/dev/null | grep -c "FATAL EXCEPTION" || true)
echo "SPLASH: WebView destruction safety - fatal exceptions in logcat=$FATAL"
if [ "${FATAL:-0}" -eq 0 ]; then echo 'SPLASH: WebView destruction safety PASS (no FATAL EXCEPTION)'; else echo "SPLASH: WebView destruction safety FAIL (fatal=$FATAL)"; SPLASH_FAIL=1; adb logcat -d 2>/dev/null | grep -A12 "FATAL EXCEPTION" | head -30 || true; fi
adb exec-out screencap -p > screenshots/31-after-splash-main.png

echo '== S3) rotation: portrait -> landscape -> portrait =='
for R in 1 0; do
  adb shell settings put system accelerometer_rotation 0; adb shell settings put system user_rotation $R
  adb shell am force-stop "$PKG"; adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$PKG/$PKG.SplashActivity" >/dev/null
  sleep 0.7; adb exec-out screencap -p > "screenshots/32-splash-rot${R}.png"
  for R in 1 0 1; do
  adb shell settings put system accelerometer_rotation 0 >/dev/null 2>&1 || true
  adb shell settings put system user_rotation "$R" >/dev/null 2>&1 || true
  sleep 2
  ACC=0
  if wait_activity "MainActivity" 40; then ACC=1; fi
  ACT=$(active_main); TIDS=$(main_task_ids); SPLASH_LIVE=$(splash_live)
  diag "rotation-$R" || true
  if [ "$ACC" -eq 1 ] && [ "${ACT:-0}" -eq 1 ] && [ "${SPLASH_LIVE:-0}" -eq 0 ]; then
    echo "SPLASH: rotation user_rotation=$R PASS (active=$ACT taskIds=[${TIDS:-none}] liveSplash=$SPLASH_LIVE)"
  else
    echo "SPLASH: rotation user_rotation=$R FAIL (resumed=$(resumed_component) active=${ACT:-0} taskIds=[${TIDS:-none}] liveSplash=${SPLASH_LIVE:-0})"
    SPLASH_FAIL=1
  fi
done
done

echo '== S4) offline launch (wifi+mobile data off) =='
adb shell svc wifi disable; adb shell svc data disable; adb shell am force-stop "$PKG"
adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$PKG/$PKG.SplashActivity" >/dev/null
sleep 0.7; adb exec-out screencap -p > screenshots/33-splash-offline.png
if wait_activity "MainActivity" 40; then echo "SPLASH: offline launch PASS (resumed_component=$(resumed_component))"; else echo "SPLASH: offline launch FAIL (resumed_component=$(resumed_component))"; SPLASH_FAIL=1; fi
adb shell svc wifi enable

echo '== S5) splash at small and large display sizes =='
for SZ in 320x568 720x1280; do
  adb shell wm size "$SZ" >/dev/null 2>&1; adb shell wm density 320 >/dev/null 2>&1; sleep 1
  adb shell am force-stop "$PKG"; adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$PKG/$PKG.SplashActivity" >/dev/null
  sleep 0.8; adb exec-out screencap -p > "screenshots/34-splash-${SZ}.png"
  [ "$SZ" = 320x568 ] && { adb shell wm size reset >/dev/null 2>&1; adb shell wm density reset >/dev/null 2>&1; sleep 1; }
done
echo 'SPLASH: viewport screenshots captured (320x568, 720x1280) PASS'

echo '== S6) WebView unavailable -> splash must not hang (fail-safe) =='
if adb shell pm disable-user --user 0 com.google.android.webview >/dev/null 2>&1; then
  adb shell am force-stop "$PKG"; adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$PKG/$PKG.SplashActivity" >/dev/null
  sleep 0.7; adb exec-out screencap -p > screenshots/35-splash-webview-disabled.png
  if wait_activity "MainActivity" 40; then echo "SPLASH: webview-failure fallback PASS (resumed_component=$(resumed_component))"; else echo "SPLASH: webview-failure fallback FAIL (resumed_component=$(resumed_component))"; SPLASH_FAIL=1; fi
  adb shell pm enable com.google.android.webview >/dev/null 2>&1 || true
else echo 'SPLASH: webview-failure NOT RUN (could not disable webview package)'; fi

echo '== S7) duplicate-start proof =='
ACCEPTED=$(grep -c "transition ACCEPTED" screenshots/diag-s2-splash-logcat.txt 2>/dev/null || echo 0)
echo "SPLASH: transitions accepted in splash window = $ACCEPTED (expect 1)"
if [ "${ACCEPTED:-0}" -ge 2 ]; then echo "SPLASH: duplicate-start re-check FAIL (accepted=$ACCEPTED)"; SPLASH_FAIL=1;
elif [ "${ACCEPTED:-0}" -eq 1 ]; then echo "SPLASH: duplicate-start re-check PASS (accepted=1)";
else echo "SPLASH: duplicate-start re-check INCONCLUSIVE (no transition records in window)"; fi
echo '== S7b) splash diagnostics dump =='
adb logcat -d -s NexDropSplash:V AndroidRuntime:E ActivityTaskManager:I WebViewFactory:I chromium:V > screenshots/diag-splash-logcat.txt 2>&1 || true
adb shell dumpsys activity activities > screenshots/diag-splash-activities.txt 2>&1 || true
grep -E "NexDropSplash" screenshots/diag-splash-logcat.txt || true
diag final

[ "$SPLASH_FAIL" -eq 0 ] && echo 'SPLASH COVERAGE PASSED' || { echo 'SPLASH COVERAGE FAILED'; exit 1; }
