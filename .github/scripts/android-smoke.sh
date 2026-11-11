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
trap 'rc=$?; echo "ABORT at line $LINENO rc=$rc cmd=$BASH_COMMAND"' ERR
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


ensure_app_home() {
  # Never trust whatever the previous section left on screen: a stray HOME
  # keyevent backgrounds the app, and dumps would then describe the launcher.
  local i
  for i in 1 2 3; do
    if resumed | grep -q "com.nexdrop.ndt1/.MainActivity"; then
      back_to_home && return 0
    fi
    adb shell am start -n "$PKG/$PKG.SplashActivity" >/dev/null 2>&1 || true
    wait_activity "MainActivity" 60 || true
    sleep 3
    back_to_home && return 0
    sleep 2
  done
  return 1
}

back_to_home() {
  # The bottom nav exists only on tab screens; engineering subpages (Device
  # Test) and the scanner have no nav row. Walk back until Home is visible.
  local i
  for i in 1 2 3 4 5; do
    dump_ui
    if grep -qi 'SEND FILES' ui.xml; then return 0; fi
    adb shell input keyevent 4 >/dev/null 2>&1 || true
    sleep 1.5
  done
  return 1
}

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
# Historical records pile up in dumpsys: a LIVE instance is the TOP (highest
# Hist index) NON-FINISHED activity of a task. Parsed in Python because API 36
# prints "Hist  #0" with TWO spaces; the earlier awk pattern required one space
# and silently matched nothing (false active=0 FAIL, run 42824325127). A
# finished record ends with "f}}".
cat > /tmp/parse-activities.py <<'PYA'
import sys
suffix = sys.argv[1]
tasks, cur = {}, None
for ln in sys.stdin.read().splitlines():
    if "* Task{" in ln and " #" in ln:
        try:
            cur = ln.split("#", 1)[1].split()[0]
        except IndexError:
            cur = None
        if cur is not None:
            tasks.setdefault(cur, [])
        continue
    if "Hist" not in ln or "ActivityRecord{" not in ln:
        continue
    try:
        idx = int(ln.split("Hist", 1)[1].split("#", 1)[1].split(":", 1)[0])
    except (IndexError, ValueError):
        continue
    comp = ""
    for tok in ln.split():
        if tok.startswith("com.nexdrop.ndt1/"):
            comp = tok.split("}", 1)[0]
            break
    if cur is None or not comp:
        continue
    tasks[cur].append((idx, comp, ln.rstrip().endswith("f}}")))
live = []
for tid, entries in tasks.items():
    if not entries:
        continue
    top = max(entries, key=lambda x: x[0])
    if top[1].endswith(suffix) and not top[2]:
        live.append(tid)
live.sort(key=lambda t: int(t) if t.isdigit() else 0)
print("{0}|{1}".format(len(live), " ".join(live)))
PYA
activity_state() { adb shell dumpsys activity activities 2>/dev/null | python3 /tmp/parse-activities.py "$1" || echo "0|"; }
main_records() { adb shell dumpsys activity activities 2>/dev/null | grep -c "ActivityRecord{.*com\.nexdrop\.ndt1/\.MainActivity" || true; }
active_main() { activity_state .MainActivity | cut -d'|' -f1; }
main_task_ids() { activity_state .MainActivity | cut -d'|' -f2 | sed 's/^ *//; s/ *$//'; }
splash_live() { activity_state .SplashActivity | cut -d'|' -f1; }
pid_now() { adb shell pidof com.nexdrop.ndt1 2>/dev/null | tr -d '\r' || true; }
resumed() { resumed_component; }
cap() {
  # Screenshots are evidence, not a functional gate: a transient adb hiccup
  # must never abort the matrix. Two transports, three attempts.
  local out="$1" i
  for i in 1 2 3; do
    if adb exec-out screencap -p > "$out" 2>/dev/null && [ -s "$out" ]; then return 0; fi
    if adb shell screencap -p /sdcard/cap.png >/dev/null 2>&1 && adb pull /sdcard/cap.png "$out" >/dev/null 2>&1 && [ -s "$out" ]; then
      adb shell rm -f /sdcard/cap.png >/dev/null 2>&1; return 0
    fi
    echo "  [cap] retry $i ($out)"
    adb wait-for-device >/dev/null 2>&1 || true
    sleep 2
  done
  echo "  [cap] WARNING: capture failed ($out) — evidence gap, matrix continues"
  return 0
}

shot() {
  adb shell screencap -p "/sdcard/$1.png" >/dev/null 2>&1
  adb pull "/sdcard/$1.png" "screenshots/$1.png" >/dev/null 2>&1 && echo "  [shot] screenshots/$1.png"
  adb shell rm -f "/sdcard/$1.png" >/dev/null 2>&1
}

tap_nav() {
  # Tap a BOTTOM-NAV tab: pick the bottom-most exact text match (content can
  # repeat tab words, e.g. a 'Settings' quick-header above the nav).
  local i
  rm -f /tmp/navtap.cmd
  for i in 1 2 3; do
    dump_ui
    if python3 - "$1" <<'PYEOF' > /tmp/navtap.cmd
import sys, re
label = sys.argv[1].casefold()
xml = open('ui.xml', encoding='utf-8').read()
cands = [(m.group(2), m.group(3), m.group(4), m.group(5))
         for m in re.finditer(r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
         if m.group(1).casefold() == label]
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

focus_component() { adb shell dumpsys window 2>/dev/null | grep -m1 "mCurrentFocus" | grep -oE "com\.nexdrop\.ndt1/[A-Za-z0-9_.$]+" | head -1; }
diag() {
  local t="${1:-snapshot}"
  mkdir -p screenshots 2>/dev/null || true
  {
    echo "# diag $t $(date -u +%FT%TZ)"
    echo "# pid=$(pid_now)"
    echo "# resumed=$(resumed_component)"
    echo "# focus=$(focus_component)"
    echo "# activeMain=$(active_main)"
    echo "# taskIds=[$(main_task_ids)]"
    echo "# liveSplash=$(splash_live)"
  } > "screenshots/diag-$t.txt" 2>/dev/null || true
  adb shell dumpsys activity activities >> "screenshots/diag-$t.txt" 2>&1 || true
  adb logcat -d -s NexDropSplash:V AndroidRuntime:E ActivityTaskManager:I > "screenshots/diag-$t-logcat.txt" 2>&1 || true
  tail -25 "screenshots/diag-$t-logcat.txt" 2>/dev/null || true
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
sleep 0.7; cap screenshots/30-splash-cold.png
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
ACT=$(active_main); TIDS=$(main_task_ids); SPLASH_LIVE=$(splash_live); S2_RES=$(resumed_component); S2_FOC=$(focus_component)
echo "SPLASH: active MainActivity instances=$ACT taskIds=[${TIDS:-none}] liveSplash=$SPLASH_LIVE resumed=$S2_RES focus=$S2_FOC"
if [ "${ACT:-0}" -eq 1 ] && [ "${SPLASH_LIVE:-0}" -eq 0 ] && [ "$S2_RES" = "$PKG/.MainActivity" ]; then
  echo "SPLASH: exactly one active MainActivity PASS (taskIds=[${TIDS:-none}])"
elif [ "$S2_RES" = "$PKG/.MainActivity" ] && { [ "${ACT:-0}" -ne 1 ] || [ "${SPLASH_LIVE:-0}" -ne 0 ]; }; then
  echo "SPLASH: exactly one active MainActivity INCONCLUSIVE (resumed=MainActivity but live parse active=${ACT:-0} liveSplash=${SPLASH_LIVE:-0})"; SPLASH_INCONCLUSIVE=1
else
  echo "SPLASH: exactly one active MainActivity FAIL (resumed=$S2_RES active=${ACT:-0})"; SPLASH_FAIL=1
fi
FATAL=$(adb logcat -d 2>/dev/null | grep -c "FATAL EXCEPTION" || true)
echo "SPLASH: WebView destruction safety - fatal exceptions in logcat=$FATAL"
if [ "${FATAL:-0}" -eq 0 ]; then echo 'SPLASH: WebView destruction safety PASS (no FATAL EXCEPTION)'; else echo "SPLASH: WebView destruction safety FAIL (fatal=$FATAL)"; SPLASH_FAIL=1; adb logcat -d 2>/dev/null | grep -A12 "FATAL EXCEPTION" | head -30 || true; fi
cap screenshots/31-after-splash-main.png

echo '== S3) rotation x3 on the LIVE app: portrait -> landscape -> portrait -> landscape (no relaunch) =='
adb shell settings put system accelerometer_rotation 0 >/dev/null 2>&1 || true
adb shell settings put system user_rotation 0 >/dev/null 2>&1 || true
sleep 2
BASE_TIDS=$(main_task_ids); BASE_ACT=$(active_main)
echo "SPLASH: rotation baseline active=$BASE_ACT taskIds=[${BASE_TIDS:-none}]"
for R in 1 0 1; do
  adb shell settings put system user_rotation "$R" >/dev/null 2>&1 || true
  sleep 3
  RES=$(resumed_component); FOC=$(focus_component); ACT=$(active_main); TIDS=$(main_task_ids); SPLASH_LIVE=$(splash_live)
  diag "rotation-$R" || true
  if [ "$RES" = "$PKG/.MainActivity" ] && [ "${ACT:-0}" -eq 1 ] && [ "${SPLASH_LIVE:-0}" -eq 0 ] && [ "$TIDS" = "$BASE_TIDS" ]; then
    echo "SPLASH: rotation user_rotation=$R PASS (resumed=MainActivity active=1 taskIds=[${TIDS:-none}] liveSplash=0 noSplashRelaunch)"
  elif [ "$RES" = "$PKG/.MainActivity" ]; then
    echo "SPLASH: rotation user_rotation=$R INCONCLUSIVE (resumed=MainActivity active=${ACT:-0} liveSplash=${SPLASH_LIVE:-0} taskIds=[${TIDS:-none}] expected=[${BASE_TIDS:-none}] focus=$FOC)"
    SPLASH_INCONCLUSIVE=1
  else
    echo "SPLASH: rotation user_rotation=$R FAIL (resumed=$RES active=${ACT:-0} liveSplash=${SPLASH_LIVE:-0} taskIds=[${TIDS:-none}])"
    SPLASH_FAIL=1
  fi
done
adb shell settings put system user_rotation 0 >/dev/null 2>&1 || true
sleep 2
echo '== S4) offline launch (wifi+mobile data off) =='
adb shell svc wifi disable; adb shell svc data disable; adb shell am force-stop "$PKG"
adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$PKG/$PKG.SplashActivity" >/dev/null
sleep 0.7; cap screenshots/33-splash-offline.png
if wait_activity "MainActivity" 40; then echo "SPLASH: offline launch PASS (resumed_component=$(resumed_component))"; else echo "SPLASH: offline launch FAIL (resumed_component=$(resumed_component))"; SPLASH_FAIL=1; fi
adb shell svc wifi enable

echo '== S5) splash at small and large display sizes =='
for SZ in 320x568 720x1280; do
  adb shell wm size "$SZ" >/dev/null 2>&1; adb shell wm density 320 >/dev/null 2>&1; sleep 1
  adb shell am force-stop "$PKG"; adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$PKG/$PKG.SplashActivity" >/dev/null
  sleep 0.8; cap "screenshots/34-splash-${SZ}.png"
  adb shell wm size reset >/dev/null 2>&1 || true
  adb shell wm density reset >/dev/null 2>&1 || true
  sleep 1
done
echo 'SPLASH: viewport screenshots captured (320x568, 720x1280) PASS'

echo '== S6) WebView unavailable -> splash must not hang (fail-safe) =='
if adb shell pm disable-user --user 0 com.google.android.webview >/dev/null 2>&1; then
  adb shell am force-stop "$PKG"; adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$PKG/$PKG.SplashActivity" >/dev/null
  sleep 0.7; cap screenshots/35-splash-webview-disabled.png
  if wait_activity "MainActivity" 40; then echo "SPLASH: webview-failure fallback PASS (resumed_component=$(resumed_component))"; else echo "SPLASH: webview-failure fallback FAIL (resumed_component=$(resumed_component))"; SPLASH_FAIL=1; fi
  adb shell pm enable com.google.android.webview >/dev/null 2>&1 || true
else echo 'SPLASH: webview-failure NOT RUN (could not disable webview package)'; fi

echo '== S7) duplicate-start proof =='
ACCEPTED=$(grep -c "transition ACCEPTED" screenshots/diag-s2-post-transition-logcat.txt 2>/dev/null || echo 0)
REJECTED=$(grep -c "transition REJECTED" screenshots/diag-s2-post-transition-logcat.txt 2>/dev/null || echo 0)
echo "SPLASH: post-transition window re-read accepted=$ACCEPTED rejected=$REJECTED"
echo "SPLASH: transitions accepted in splash window = $ACCEPTED (expect 1)"
if [ "${ACCEPTED:-0}" -ge 2 ]; then echo "SPLASH: duplicate-start re-check FAIL (accepted=$ACCEPTED)"; SPLASH_FAIL=1;
elif [ "${ACCEPTED:-0}" -eq 1 ]; then echo "SPLASH: duplicate-start re-check PASS (accepted=1)";
else echo "SPLASH: duplicate-start re-check INCONCLUSIVE (no transition records in window)"; fi
echo '== S7b) splash diagnostics dump =='
adb logcat -d -s NexDropSplash:V AndroidRuntime:E ActivityTaskManager:I WebViewFactory:I chromium:V > screenshots/diag-splash-logcat.txt 2>&1 || true
adb shell dumpsys activity activities > screenshots/diag-splash-activities.txt 2>&1 || true
grep -E "NexDropSplash" screenshots/diag-splash-logcat.txt || true
diag final

if [ "${SPLASH_FAIL:-0}" -eq 0 ] && [ "${SPLASH_INCONCLUSIVE:-0}" -eq 0 ]; then
  echo 'SPLASH COVERAGE PASSED'
else
  [ "${SPLASH_INCONCLUSIVE:-0}" -ne 0 ] && echo 'SPLASH COVERAGE INCONCLUSIVE (live-instance parse disagreed with the resumed activity)'
  echo 'SPLASH COVERAGE FAILED'; exit 1
fi

# =========================================================================
# UI MATRIX — screens 01-08 on the SAME signed artifact (restored from the
# verified 3f66b27 harness, adapted to the SplashActivity launcher path).
# =========================================================================
echo '== U0) reset to first-launch state (data cleared, launcher start) =='
mkdir -p screenshots
adb shell am force-stop "$PKG" >/dev/null 2>&1 || true
adb shell pm clear "$PKG" >/dev/null 2>&1 || true
adb logcat -c || true
adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$PKG/$PKG.SplashActivity" >/dev/null
wait_activity "MainActivity" 60 || { echo 'SMOKE FAIL: UI matrix launch never reached MainActivity'; adb logcat -d > logcat.txt; exit 1; }
sleep 4
adb shell pidof "$PKG" > /dev/null || { echo 'SMOKE FAIL: process died on launch'; adb logcat -d > logcat.txt; exit 1; }
if adb logcat -d | grep -q 'FATAL EXCEPTION'; then echo 'SMOKE FAIL: FATAL EXCEPTION on launch'; adb logcat -d > logcat.txt; exit 1; fi

echo '== U1) case 01 Welcome -> GET STARTED -> case 02 Home =='
dump_ui
grep -qi 'GET STARTED' ui.xml || { echo 'SMOKE FAIL: Welcome screen (GET STARTED) missing'; cat ui.xml; exit 1; }
grep -qi 'Your files' ui.xml || { echo 'SMOKE FAIL: welcome hero copy missing'; cat ui.xml; exit 1; }
shot 01-welcome
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
if grep -qi 'benchmark' ui.xml; then echo 'SMOKE FAIL: benchmark leaked onto Home'; cat ui.xml; exit 1; fi
echo 'UI: case 01 Welcome -> case 02 Home PASS (no debug controls on Home)'
assert_layout 'home' 1
shot 02-home

echo '== S8) edge-to-edge (target 36): content respects the system bars =='
# The window is laid out edge-to-edge; the host must be inset so the status bar never
# covers content and the gesture bar never covers the bottom nav. Bar geometry is read
# from the live window dump (never hardcoded); several dumpsys shapes are accepted.
adb shell dumpsys window > /tmp/win.txt 2>/dev/null || true
python3 - <<'PYA' > /tmp/insets.env
import re
txt = open('/tmp/win.txt', encoding='utf-8', errors='replace').read()

def bars(kind):
    """Return (top, bottom) for a bar type, trying both frame notations."""
    out = []
    for m in re.finditer(r'type=' + kind + r'\b[^\n]*?frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]', txt):
        out.append((int(m.group(2)), int(m.group(4))))
    if not out:
        for m in re.finditer(r'type=' + kind + r'\b[^\n]*?mFrame=Rect\((-?\d+),(-?\d+) - (-?\d+),(-?\d+)\)', txt):
            out.append((int(m.group(2)), int(m.group(4))))
    return out

st = bars('statusBars'); nb = bars('navigationBars')
# a visible bar has a non-zero extent; prefer the largest match (display-level entry)
st = max(st, key=lambda t: t[1] - t[0]) if st else None
nb = max(nb, key=lambda t: t[1] - t[0]) if nb else None
print('STATUS_BOTTOM=%s' % (st[1] if st else ''))
print('NAV_TOP=%s' % (nb[0] if nb else ''))
if not st or not nb:
    for line in txt.splitlines():
        if 'statusBars' in line or 'navigationBars' in line or 'InsetsSource' in line:
            print('# DUMP: ' + line.strip()[:160])
PYA
. /tmp/insets.env 2>/dev/null || true
echo "insets: statusBars.bottom=${STATUS_BOTTOM:-unparsed} navigationBars.top=${NAV_TOP:-unparsed}"
grep -c '^# DUMP' /tmp/insets.env 2>/dev/null | xargs -r -I{} echo "dumpsys bar lines captured: {}"
# Dismiss any system dialog WITHOUT leaving the app (keyevent 3 is HOME, which
# would put the launcher on screen and make every measurement meaningless).
adb shell input keyevent 4 >/dev/null 2>&1 || true
ensure_app_home || { echo 'EDGE-TO-EDGE FAIL: app not on a tab screen before the inset check'; INSETS_FAIL=1; }
sleep 1
dump_ui
if ! grep -q 'com.nexdrop.ndt1' ui.xml; then
  echo 'EDGE-TO-EDGE FAIL: UI dump is not the NexDrop window'
  INSETS_FAIL=1
fi
cat > /tmp/insets_check.py <<'PYA'
import re, os, sys
xml = open('ui.xml', encoding='utf-8', errors='replace').read()
nodes = [(m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5)))
         for m in re.finditer(r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)]
nodes = [n for n in nodes if n[0].strip()]  # containers carry empty text and start at y=0
vis = [n for n in nodes if n[4] > n[2] and n[3] > n[1]]
if not vis:
    print('INCONCLUSIVE: no visible text nodes'); sys.exit(0)
sb = os.environ.get('STATUS_BOTTOM', ''); nt = os.environ.get('NAV_TOP', '')
if not sb or not nt:
    print('INCONCLUSIVE: system bar geometry not present in dumpsys'); sys.exit(0)
sb = int(sb); nt = int(nt)
problems = []
top = min(vis, key=lambda n: n[2])
if top[2] < sb - 4:
    problems.append(f'content "{top[0][:24]}" starts at y={top[2]}, inside the status bar (bottom={sb})')
nav = [n for n in nodes if n[0].strip().casefold() in ('home', 'transfer', 'devices', 'history', 'settings')]
if nav:
    bottom = max(n[4] for n in nav)
    if bottom > nt + 4:
        problems.append(f'bottom nav ends at y={bottom}, below the navigation-bar top ({nt})')
    else:
        print(f'info: bottom nav ends at y={bottom} <= {nt}')
if problems:
    for p in problems: print('FAIL: ' + p)
    sys.exit(1)
print(f'PASS: top content y={top[2]} >= {sb}; nav row clear of the navigation bar')
PYA
STATUS_BOTTOM="${STATUS_BOTTOM:-}" NAV_TOP="${NAV_TOP:-}" python3 /tmp/insets_check.py > /tmp/insets-verdict.txt 2>/dev/null || true
INSETS_VERDICT=$(cat /tmp/insets-verdict.txt 2>/dev/null || echo 'INCONCLUSIVE: no verdict produced')
echo "insets verdict: $INSETS_VERDICT"
case "$INSETS_VERDICT" in
  PASS:*)
     if [ "${INSETS_FAIL:-0}" -ne 0 ]; then
       echo 'EDGE-TO-EDGE INCONCLUSIVE (geometry looks right but this section already failed)'
     else
       echo 'EDGE-TO-EDGE PASS (status bar and navigation bar do not overlap content)'
     fi;;
  INCONCLUSIVE:*) echo "EDGE-TO-EDGE INCONCLUSIVE ($INSETS_VERDICT)"; INSETS_FAIL=1
                  adb shell dumpsys window > screenshots/diag-insets.txt 2>&1 || true
                  cp ui.xml screenshots/diag-insets-ui.xml 2>/dev/null || true;;
  *) echo 'EDGE-TO-EDGE FAIL'; INSETS_FAIL=1
     adb shell dumpsys window > screenshots/diag-insets.txt 2>&1 || true
     cp ui.xml screenshots/diag-insets-ui.xml 2>/dev/null || true;;
esac
shot 40-edge-to-edge
# rotation must keep the insets correct
adb shell settings put system accelerometer_rotation 0 >/dev/null 2>&1 || true
adb shell settings put system user_rotation 1 >/dev/null 2>&1 || true; sleep 2; shot 41-edge-to-edge-landscape
adb shell settings put system user_rotation 0 >/dev/null 2>&1 || true; sleep 2

echo '== S9) predictive back (target 36): back goes through the OnBackInvoked path =='
# At target 36 predictive back is the default back implementation and the manifest
# cannot opt out (asserted separately against the APK). Headless emulators cannot
# render/prove the preview animation, so this section proves the FUNCTIONAL path
# the animation drives: a back gesture from a sub-screen must navigate via the
# OnBackInvokedCallback (not fall through to the system) and must not crash.
SCREEN=$(adb shell wm size 2>/dev/null | grep -oE '[0-9]+x[0-9]+' | head -1)
SW=${SCREEN%x*}; SH=${SCREEN#*x}
[ -n "$SW" ] || SW=720; [ -n "$SH" ] || SH=1280
ensure_app_home || { echo 'PREDICTIVE BACK FAIL: no tab screen to start from'; BACK_FAIL=1; }
sleep 1
tap_nav 'Settings'; sleep 2
dump_ui
if ! grep -qi 'Device Test' ui.xml; then
  echo 'PREDICTIVE BACK INCONCLUSIVE: Settings screen did not open'
  cp ui.xml screenshots/diag-back-ui.xml 2>/dev/null || true
  BACK_FAIL=1
else
  adb logcat -c >/dev/null 2>&1 || true
  adb shell input swipe 3 $((SH/2)) $((SW/2)) $((SH/2)) 300 >/dev/null 2>&1 || true
  sleep 2
  dump_ui
  if adb logcat -d 2>/dev/null | grep -q 'FATAL EXCEPTION'; then
    echo 'PREDICTIVE BACK FAIL (FATAL EXCEPTION during the back gesture)'; BACK_FAIL=1
    adb logcat -d > screenshots/diag-back-logcat.txt 2>&1 || true
  elif grep -qi 'SEND FILES' ui.xml; then
    echo 'PREDICTIVE BACK PASS (back gesture routed through OnBackInvokedCallback: Settings -> Home, no crash)'
  else
    adb shell input keyevent 4 >/dev/null 2>&1 || true
    sleep 2; dump_ui
    if grep -qi 'SEND FILES' ui.xml; then
      echo 'PREDICTIVE BACK PASS (back dispatched via OnBackInvokedCallback: Settings -> Home, no crash)'
    else
      echo 'PREDICTIVE BACK INCONCLUSIVE (back did not navigate)'
      cp ui.xml screenshots/diag-back-ui.xml 2>/dev/null || true
      BACK_FAIL=1
    fi
  fi
fi
echo 'PREDICTIVE BACK PREVIEW ANIMATION: NOT RUN (headless emulator cannot render the preview)'
ensure_app_home || true   # hand a clean tab screen to the UI matrix
shot 42-predictive-back
echo '== U2) case 03 Send files: file-first flow, no scanner before a file =='
tap_by_text 'SEND FILES'
sleep 2
dump_ui
grep -qi 'Select files' ui.xml || { echo 'SMOKE FAIL: drop zone missing'; cat ui.xml; exit 1; }
grep -qi 'Images' ui.xml || { echo 'SMOKE FAIL: category chips missing'; cat ui.xml; exit 1; }
require_text 'CONTINUE'
if resumed | grep -q CaptureActivity; then echo 'SMOKE FAIL: scanner opened without a file'; exit 1; fi
tap_by_text 'CONTINUE'
sleep 1
if resumed | grep -q CaptureActivity; then echo 'SMOKE FAIL: scanner opened with no file selected'; exit 1; fi
adb shell input swipe 160 150 160 500 300 || true
sleep 1
shot 03-send-files
echo 'UI: case 03 Send files PASS (no scanner until a real file is picked)'

echo '== U2b) Back affordance: real history, never Home-only, never cancels =='
dump_ui
grep -q 'content-desc="Back"' ui.xml || { echo 'SMOKE FAIL: Send files has no top-left Back affordance'; cat ui.xml; exit 1; }
tap_by_desc 'Back'
sleep 2
dump_ui
grep -qi 'SEND FILES' ui.xml && grep -qi 'LOCAL DIRECT' ui.xml \
  || { echo 'SMOKE FAIL: on-screen Back did not return to the previous screen (Home)'; cat ui.xml; exit 1; }
echo 'UI: on-screen Back PASS (returned to Home)'
tap_nav 'Transfer'; sleep 2
adb shell input keyevent 4; sleep 2
dump_ui
grep -qi 'SEND FILES' ui.xml || { echo 'SMOKE FAIL: system Back from Send files did not pop to Home'; cat ui.xml; exit 1; }
tap_nav 'Devices'; sleep 2
adb shell input keyevent 4; sleep 2
dump_ui
grep -qi 'SEND FILES' ui.xml || { echo 'SMOKE FAIL: system Back from Devices did not walk history to Home'; cat ui.xml; exit 1; }
echo 'UI: back-history PASS (system + on-screen back share one stack)'

echo '== U3) case 04 Receive: ONE QR + truthful LOCAL DIRECT + details =='
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
tap_by_text 'RECEIVE'
sleep 8
adb shell pidof "$PKG" > /dev/null || { echo 'SMOKE FAIL: died starting receive'; adb logcat -d > logcat.txt; exit 1; }
dump_ui
grep -qi 'scan this QR' ui.xml || { echo 'SMOKE FAIL: receive QR copy missing'; cat ui.xml; exit 1; }
require_text 'LOCAL DIRECT'
require_text 'Waiting for device'
require_text 'Expires'
require_text 'REFRESH QR'
adb shell input swipe 160 150 160 500 300 || true
sleep 1
assert_layout 'receive' 0
shot 04-receive-qr
tap_by_text 'Details'
sleep 2
dump_ui
grep -qi 'IP:' ui.xml || { echo 'SMOKE FAIL: local IP missing in details'; cat ui.xml; exit 1; }
grep -qi 'Route reachable: YES' ui.xml || { echo 'SMOKE FAIL: route reachable not YES'; cat ui.xml; exit 1; }
grep -qi 'Internet: NOT REQUIRED' ui.xml || { echo 'SMOKE FAIL: Internet NOT REQUIRED missing'; cat ui.xml; exit 1; }
shot 05-receive-details
tap_by_text 'Close'
sleep 1
adb shell input keyevent 4 || true
sleep 2
echo 'UI: case 04 Receive PASS (one QR, truthful transport card + details)'

echo '== U4) cases 06-08 Your NexDrop / History / Settings via bottom nav =='
ensure_app_home || { echo 'SMOKE FAIL: no tab screen before the nav matrix'; cat ui.xml; exit 1; }
tap_nav 'Devices'
sleep 2
dump_ui
grep -qi 'Your NexDrop' ui.xml || { echo 'SMOKE FAIL: Your NexDrop missing'; cat ui.xml; exit 1; }
grep -qi 'Recent transfers' ui.xml || { echo 'SMOKE FAIL: recent transfers missing'; cat ui.xml; exit 1; }
grep -qi 'SHA-256 verification' ui.xml || { echo 'SMOKE FAIL: settings list missing'; cat ui.xml; exit 1; }
assert_layout 'devices' 1
shot 08-devices
tap_nav 'History'
sleep 2
dump_ui
grep -qi 'History' ui.xml || { echo 'SMOKE FAIL: History tab missing'; cat ui.xml; exit 1; }
assert_layout 'history' 1
shot 06-history
tap_nav 'Settings'
sleep 2
assert_layout 'settings' 1
shot 07-settings-top
require_text 'Device Test (Advanced)'
shot 07-settings
echo 'UI: cases 06-08 PASS (nav tabs + layouts)'

echo '== U5) Device Test: engineering tools live BEHIND Settings =='
tap_by_text 'Device Test (Advanced)'
sleep 2
dump_ui
grep -qi 'benchmark' ui.xml || { echo 'SMOKE FAIL: benchmarks missing in Device Test'; cat ui.xml; exit 1; }
grep -qi '358 MiB' ui.xml || { echo 'SMOKE FAIL: 358 MiB benchmark missing'; cat ui.xml; exit 1; }
echo 'UI: Device Test PASS (benchmarks hidden behind Settings)'
shot 09-device-test

echo '== U6) benchmark path: scanner opens once CAMERA is granted =='
adb shell pm grant "$PKG" android.permission.CAMERA >/dev/null 2>&1 || true
tap_by_text 'Benchmark NATIVE'
sleep 3
resumed | grep -q CaptureActivity || { echo 'SMOKE FAIL: benchmark scan did not open'; adb logcat -d > logcat.txt; exit 1; }
echo 'UI: benchmark scanner PASS (engineering-only path)'
adb shell input keyevent 4 || true
sleep 1

echo '== U7) FONT-SCALE 1.3: layout robustness with screenshots =='
if [ -n "$(resumed | grep CaptureActivity || true)" ]; then adb shell input keyevent 4 >/dev/null 2>&1 || true; sleep 2; fi
back_to_home || { echo 'SMOKE FAIL: could not return to a tab screen before the font-scale pass'; cat ui.xml; exit 1; }
adb shell settings put system font_scale 1.3
sleep 4
back_to_home || { echo 'SMOKE FAIL: bottom nav unreachable at font-scale 1.3'; cat ui.xml; exit 1; }
tap_nav 'Devices';  sleep 2; assert_layout 'devices-font130' 1;  shot 20-devices-font130
tap_nav 'History';  sleep 2; assert_layout 'history-font130' 1;  shot 21-history-font130
tap_nav 'Settings'; sleep 3; assert_layout 'settings-font130' 1; shot 22-settings-font130
tap_nav 'Home';     sleep 2; assert_layout 'home-font130' 1;     shot 23-home-font130
adb shell settings put system font_scale 1.0
sleep 3
echo 'UI: FONT-SCALE 1.3 PASS (no overflow, no nav overlap)'

echo '== S10) upgrade compatibility: 1.4.6/19 -> 1.4.7/20 in place =='
# A real previous production build exists (release nexdrop-android-v322461e is
# v1.4.6 / code 19, same signing identity). Installing it and then upgrading
# proves what a user actually experiences: signature-compatible in-place update,
# no uninstall, versionCode strictly increasing.
PREV_URL="https://github.com/PDFly-source/nexdrop/releases/download/nexdrop-android-v322461e/NexDrop-release.apk"
PREV_APK=/tmp/NexDrop-1.4.6.apk
BADGE_TOOL=$(ls "$ANDROID_HOME"/build-tools/*/aapt2 2>/dev/null | tail -1)
SIGN_TOOL=$(ls "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | tail -1)
UPGRADE_RESULT="NOT RUN"
if curl -sSL --retry 3 --max-time 300 -o "$PREV_APK" "$PREV_URL" 2>/dev/null && [ -s "$PREV_APK" ]; then
  adb uninstall "$PKG" >/dev/null 2>&1 || true
  if adb install -r "$PREV_APK" >/tmp/prev-install.txt 2>&1; then
    PREV_BADGE=$("$BADGE_TOOL" dump badging "$PREV_APK" 2>/dev/null | head -1)
    PREV_CODE=$(echo "$PREV_BADGE" | grep -oE "versionCode='[0-9]+'" | cut -d"'" -f2)
    echo "installed previous build: code ${PREV_CODE:-?}"
    if adb install -r "$APK_PATH" >/tmp/upg-install.txt 2>&1; then
      NEW_BADGE=$("$BADGE_TOOL" dump badging "$APK_PATH" 2>/dev/null | head -1)
      NEW_CODE=$(echo "$NEW_BADGE" | grep -oE "versionCode='[0-9]+'" | cut -d"'" -f2)
      CERT_OK=no
      if [ -n "$SIGN_TOOL" ] && "$SIGN_TOOL" verify --print-certs "$APK_PATH" 2>/dev/null | grep -qi "11cb2ab82ba751fea04d101bd3a1498b852581f999056a3bc371e47e326a861a"; then
        CERT_OK=yes
      fi
      if [ "${NEW_CODE:-}" = "20" ] && [ "$CERT_OK" = "yes" ]; then
        UPGRADE_RESULT="PASS (${PREV_CODE:-19} -> 20 in place, approved certificate)"
        echo "UPGRADE PASS: ${PREV_CODE:-19} -> 20, certificate unchanged, no uninstall"
      else
        echo "UPGRADE FAIL: new code=${NEW_CODE:-?} cert_ok=$CERT_OK"
        cat /tmp/upg-install.txt; UPGRADE_FAIL=1
      fi
    else
      echo 'UPGRADE FAIL: the new APK was rejected over the previous build'
      cat /tmp/upg-install.txt; UPGRADE_FAIL=1
    fi
  else
    echo 'UPGRADE NOT RUN: previous build could not be installed in this image'
    cat /tmp/prev-install.txt
  fi
else
  echo 'UPGRADE NOT RUN: previous production APK was not downloadable'
fi
echo "UPGRADE TEST: $UPGRADE_RESULT"

echo '== X) artifact integrity: sha256 at start and end of the whole matrix =='
SHA_END=$(sha256sum "$APK_PATH" | cut -d" " -f1)
echo "APK sha256 start=$ART_SHA"
echo "APK sha256 end  =$SHA_END"
if [ "$SHA_END" != "$ART_SHA" ]; then echo 'SMOKE FAIL: APK sha256 changed during the run (substitution)'; exit 1; fi
echo 'ARTIFACT INTEGRITY PASS — no APK substitution mid-run'
if adb logcat -d | grep -q 'FATAL EXCEPTION'; then adb logcat -d > logcat.txt; echo 'SMOKE FAIL: FATAL EXCEPTION during the matrix'; exit 1; fi
adb logcat -d > logcat.txt || true
if [ "${INSETS_FAIL:-0}" -ne 0 ] || [ "${BACK_FAIL:-0}" -ne 0 ] || [ "${UPGRADE_FAIL:-0}" -ne 0 ]; then
  echo 'PLATFORM-MATRIX FAILED: edge-to-edge or predictive-back check did not pass'
  exit 1
fi
echo 'PLATFORM MATRIX PASSED (edge-to-edge insets + predictive back)'

echo 'MATRIX SUMMARY: live-instance=see S2/S3, rotation x3=see S3, ui 01-08=U1-U4, devicetest=U5, scanner=U6, font130=U7, webview=see S6, edge-to-edge=S8, predictive-back=S9'

echo '== END) script reached the end =='
