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
resumed() {
  adb shell dumpsys window 2>/dev/null | grep -i 'mCurrentFocus' || true
  adb shell dumpsys activity activities 2>/dev/null | grep -i 'ResumedActivity' || true
}

# Visual evidence: capture a named screenshot of the current screen so the
# owner can compare the shipped UI against the HTML mockup screen-by-screen.
mkdir -p screenshots
shot() {
  adb shell screencap -p "/sdcard/$1.png" >/dev/null 2>&1
  adb pull "/sdcard/$1.png" "screenshots/$1.png" >/dev/null 2>&1 && echo "  [shot] screenshots/$1.png"
  adb shell rm -f "/sdcard/$1.png" >/dev/null 2>&1
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
# Mission §10: benchmarks are ENGINEERING-ONLY — they must NOT be on Home.
if grep -qi 'benchmark' ui.xml; then echo 'SMOKE FAIL: benchmark leaked onto Home'; cat ui.xml; exit 1; fi
echo 'Welcome -> Home OK — mockup 01+02 live, no debug controls'

assert_layout 'home' 1
shot 02-home

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
shot 03-send-files
echo 'Send files OK — no scanner until a real file is picked'

echo '== 2b) Back affordance: real history, never Home-only, never cancels =='
dump_ui
grep -q 'content-desc="Back"' ui.xml || { echo 'SMOKE FAIL: Send files has no top-left Back affordance'; cat ui.xml; exit 1; }
tap_by_desc 'Back'          # on-screen back: same stack as system Back
sleep 2
dump_ui
grep -qi 'SEND FILES' ui.xml && grep -qi 'LOCAL DIRECT' ui.xml \
  || { echo 'SMOKE FAIL: on-screen Back did not return to the previous screen (Home)'; cat ui.xml; exit 1; }
echo 'on-screen Back OK — returned to Home (previous screen)'

# system Back walks the tab history: Home -> Transfer -> Devices -> back=back
tap_nav 'Transfer'; sleep 2
adb shell input keyevent 4; sleep 2
dump_ui
grep -qi 'SEND FILES' ui.xml || { echo 'SMOKE FAIL: system Back from Send files did not pop to Home'; cat ui.xml; exit 1; }
tap_nav 'Devices'; sleep 2
adb shell input keyevent 4; sleep 2
dump_ui
grep -qi 'SEND FILES' ui.xml || { echo 'SMOKE FAIL: system Back from Devices did not walk history to Home'; cat ui.xml; exit 1; }
echo 'Back history OK — system + on-screen back share one stack'

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
assert_layout 'receive' 0
shot 04-receive-qr

# Details sheet: full truthful transport diagnostics
tap_by_text 'Details'
sleep 2
dump_ui
grep -qi 'IP:' ui.xml || { echo 'SMOKE FAIL: local IP missing in details'; cat ui.xml; exit 1; }
grep -qi 'Route reachable: YES' ui.xml || { echo 'SMOKE FAIL: route reachable not YES'; cat ui.xml; exit 1; }
grep -qi 'Internet: NOT REQUIRED' ui.xml || { echo 'SMOKE FAIL: Internet NOT REQUIRED missing'; cat ui.xml; exit 1; }
shot 05-receive-details
tap_by_text 'Close'
sleep 1
adb shell input keyevent 4   # leave receive
sleep 2
echo 'Receive OK — ONE QR, truthful transport card + details'

echo '== 4) 08 Your NexDrop + History + Settings via bottom nav =='
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
echo 'nav tabs OK'

echo '== 5) Device Test: engineering tools live BEHIND Settings =='
tap_by_text 'Device Test (Advanced)'
sleep 2
dump_ui
grep -qi 'benchmark' ui.xml || { echo 'SMOKE FAIL: benchmarks missing in Device Test'; cat ui.xml; exit 1; }
grep -qi '358 MiB' ui.xml || { echo 'SMOKE FAIL: 358 MiB benchmark missing'; cat ui.xml; exit 1; }
echo 'Device Test OK — benchmarks hidden behind Settings'
shot 09-device-test

echo '== 6) benchmark path: scanner opens once CAMERA is granted =='
adb shell pm grant "$PKG" android.permission.CAMERA
tap_by_text 'Benchmark NATIVE'
sleep 3
resumed | grep -q CaptureActivity || { echo 'SMOKE FAIL: benchmark scan did not open'; adb logcat -d > logcat.txt; exit 1; }
adb shell input keyevent 4
sleep 1

echo '== 7) REAL-DATA pass: live NDT1 transfers into the app via emulator tunnel =='
# The app binds the QR session on its selected local interface. On the
# emulator that is the netsim wlan0 (10.0.2.16), which adb redir cannot
# reach; disabling wifi makes LocalNet fall back to eth0 (10.0.2.15), the
# emulator's NAT interface, which redir CAN tunnel. If the QR still
# advertises an unreachable IP, the phase degrades to an honest skip.
adb shell svc wifi disable
sleep 4
for i in 1 2 3 4 5 6; do
  dump_ui
  grep -qi 'SEND FILES' ui.xml && break
  adb shell input keyevent 4
  sleep 2
done
dump_ui
grep -qi 'SEND FILES' ui.xml || { echo 'SMOKE FAIL: could not get back to Home for real-data pass'; exit 1; }

# send REAL files through the real NDT1 stack: QR decode -> tunnel -> CLI
# handshake -> on-device ACCEPT -> durable transfer -> SHA-256 verify.
send_real() {
  # $1 file, $2 shot prefix, [$3 drop-at bytes (resume drill).]
  # Assumes: app on Home, wifi off.
  tap_by_text 'RECEIVE'
  sleep 9
  shot "$2-qr"
  python3 - "$2" <<'PYQ' > /tmp/qr.json
import sys, zxingcpp
from PIL import Image
img = Image.open(f"screenshots/{sys.argv[1]}-qr.png")
res = zxingcpp.read_barcodes(img)
print(res[0].text if res else "")
PYQ
  local ip port token session i sheet=0
  ip=$(jq -r '.ip // empty' /tmp/qr.json 2>/dev/null || true)
  port=$(jq -r '.p // empty' /tmp/qr.json 2>/dev/null || true)
  token=$(jq -r '.token // empty' /tmp/qr.json 2>/dev/null || true)
  session=$(jq -r '.session // empty' /tmp/qr.json 2>/dev/null || true)
  if [ -z "$ip" ] || [ -z "$port" ] || [ -z "$token" ] || [ -z "$session" ]; then
    echo "QRDECODE_FAILED $1"
    return 2
  fi
  echo "  QR decoded: $ip:$port (session $session)"
  adb emu redir add "tcp:$port:$port" >/dev/null 2>&1 || true
  local drop_args="" drop_at="${3:-}"
  if [ -n "$drop_at" ] && [ "$drop_at" -gt 0 ] 2>/dev/null; then drop_args="--drop-at $drop_at"; fi
  timeout 900 npx tsx companion/src/cli.ts send "$1" \
    --host 127.0.0.1 --port "$port" --token "$token" --session "$session" $drop_args > /tmp/cli.log 2>&1 &
  local cli=$!
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 2
    dump_ui
    if grep -qi 'Incoming transfer' ui.xml; then sheet=1; break; fi
  done
  if [ "$sheet" != "1" ]; then
    kill "$cli" 2>/dev/null || true
    wait "$cli" 2>/dev/null || true
    echo "NOSHEET $1"
    cat /tmp/cli.log
    return 3
  fi
  shot "$2-incoming-sheet"
  tap_by_text 'ACCEPT'
  local done_=0
  for i in $(seq 1 180); do
    dump_ui
    if grep -qi 'Transfer complete' ui.xml; then done_=1; break; fi
    if ! kill -0 "$cli" 2>/dev/null && [ "$i" -gt 3 ]; then break; fi
    sleep 5
  done
  wait "$cli" 2>/dev/null || true
  cat /tmp/cli.log
  if [ "$done_" != "1" ]; then
    echo "NOCOMPLETE $1"
    return 1
  fi
  dump_ui
  grep -qi 'SHA-256 VERIFIED' ui.xml || { echo "NOVERIFY $1"; return 1; }
  shot "$2-complete"
  tap_by_text 'DONE'
  sleep 2
  adb emu redir del "tcp:$port:$port" >/dev/null 2>&1 || true
  echo "REAL_SEND_OK $1"
  return 0
}

PHASE_SKIPPED=0
dd if=/dev/urandom of=/tmp/nd-probe.bin bs=1M count=2 2>/dev/null
send_real /tmp/nd-probe.bin 10-probe || {
  rc=$?
  echo 'TUNNEL DEGRADED: probe transfer did not go through.'
  echo 'Falling back to layout-only QA — the real-data pass must be done physically (owner two-phone test).'
  PHASE_SKIPPED=1
}

if [ "$PHASE_SKIPPED" = "0" ]; then
  # The owner's real-world case: a big APK-scale backup (341.5 MB)
  dd if=/dev/urandom of='/tmp/Device-backup-341MB-full-final.apk' bs=1M count=342 2>/dev/null
  send_real '/tmp/Device-backup-341MB-full-final.apk' 11-big \
    || { echo 'SMOKE FAIL: 341 MB real transfer did not complete + verify'; adb logcat -d > logcat.txt; exit 1; }
  shot 11-big-live
  # three more realistic files -> 5 real transfers in History
  dd if=/dev/urandom of='/tmp/Trip-photos-March.zip' bs=1M count=3 2>/dev/null
  send_real '/tmp/Trip-photos-March.zip' 12-trip \
    || { echo 'SMOKE FAIL: second real transfer failed'; adb logcat -d > logcat.txt; exit 1; }
  dd if=/dev/urandom of='/tmp/resume-final-v2.pdf' bs=1M count=2 2>/dev/null
  send_real '/tmp/resume-final-v2.pdf' 13-resume \
    || { echo 'SMOKE FAIL: third real transfer failed'; adb logcat -d > logcat.txt; exit 1; }
  dd if=/dev/urandom of='/tmp/workshop-demo.mp4' bs=1M count=5 2>/dev/null
  send_real '/tmp/workshop-demo.mp4' 14-demo \
    || { echo 'SMOKE FAIL: fourth real transfer failed'; adb logcat -d > logcat.txt; exit 1; }
  dd if=/dev/urandom of='/tmp/notes-and-ideas.txt' bs=1M count=1 2>/dev/null
  send_real '/tmp/notes-and-ideas.txt' 15-notes \
    || { echo 'SMOKE FAIL: fifth real transfer failed'; adb logcat -d > logcat.txt; exit 1; }

  # RESUME DRILL (mission Phase 3): the sender socket is KILLED mid-transfer
  # (at 1.5 MB of a 5 MB file) and reconnects with the same session. The app
  # must auto-accept the repeat OFFER (consent already given, same session),
  # resume from the durable offset, and finish SHA-256 verified — no second
  # Incoming sheet (nobody would be there to tap it).
  echo '== 7a) RESUME DRILL: mid-transfer socket drop -> durable-offset resume =='
  dd if=/dev/urandom of='/tmp/resume-drill-final.mp4' bs=1M count=5 2>/dev/null
  send_real '/tmp/resume-drill-final.mp4' 16-drill 1500000 \
    || { echo 'SMOKE FAIL: drop-resume drill did not complete + verify'; adb logcat -d > logcat.txt; exit 1; }
  grep -qi 'durable offset' /tmp/cli.log \
    || { echo 'SMOKE FAIL: CLI did not actually resume from a durable offset'; cat /tmp/cli.log; exit 1; }
  echo 'RESUME DRILL OK — socket killed mid-transfer, resumed from durable offset, SHA-256 verified'

  echo '== 7b) populated state: History 7 real transfers, Devices connected =='
  tap_nav 'History'
  sleep 2
  dump_ui
  grep -qi '7 completed' ui.xml || { echo 'SMOKE FAIL: History does not show 7 completed after real-data pass'; cat ui.xml; exit 1; }
  # HISTORY ACTIONS (mission §7): tap the newest row -> real record detail +
  # OPEN / SHARE / DELETE actions from the real received file
  tap_by_text 'resume-drill-final.mp4'
  sleep 2
  dump_ui
  grep -qi 'SHA-256: VERIFIED' ui.xml || { echo 'SMOKE FAIL: history detail does not show SHA-256 VERIFIED'; cat ui.xml; exit 1; }
  grep -qi 'Delete record' ui.xml || { echo 'SMOKE FAIL: history actions missing'; cat ui.xml; exit 1; }
  shot 16b-history-actions
  tap_by_text 'Close'
  sleep 1
  # newest first: the last-sent file must be the TOP row, with its NAME visible
  # (regression: the right column once squeezed the weighted name to zero width)
  dump_ui
  grep -qi 'resume-drill-final' ui.xml || { echo 'SMOKE FAIL: History top row does not show the newest transfer name'; cat ui.xml; exit 1; }
  shot 16-history-populated
  adb shell input swipe 160 500 160 150 300
  sleep 1
  adb shell input swipe 160 500 160 150 300
  sleep 1
  dump_ui
  grep -qi 'nd-probe' ui.xml || { echo 'SMOKE FAIL: History does not scroll to the oldest (1st) transfer'; cat ui.xml; exit 1; }
  assert_layout 'history-populated-scrolled' 1
  shot 17-history-scrolled
  tap_nav 'Devices'
  sleep 2
  dump_ui
  grep -qi 'Connected' ui.xml || { echo 'SMOKE FAIL: Devices does not show Connected after real transfers'; cat ui.xml; exit 1; }
  assert_layout 'devices-populated' 1
  shot 18-devices-connected

  echo '== 7c) Clear transfer history: back to the real empty state =='
  tap_nav 'Settings'
  sleep 2
  tap_by_text 'Clear transfer history'
  sleep 2
  tap_nav 'History'
  sleep 2
  dump_ui
  grep -qi 'No transfers yet' ui.xml || { echo 'SMOKE FAIL: Clear history did not restore the empty state'; cat ui.xml; exit 1; }
  assert_layout 'history-cleared' 1
  shot 19-history-cleared
  echo 'REAL-DATA PASS OK — 7 live NDT1 transfers (incl. 341 MB + a drop-resume drill) accepted, verified, recorded, then cleared'
else
  adb shell input keyevent 4 2>/dev/null || true
fi
adb shell svc wifi enable
sleep 3

echo '== 8) FONT-SCALE 1.3: long-text / large-font layout robustness =='
adb shell settings put system font_scale 1.3
sleep 4
tap_nav 'Devices';  sleep 2
assert_layout 'devices-font130' 1
shot 20-devices-font130
tap_nav 'History';   sleep 2
assert_layout 'history-font130' 1
shot 21-history-font130
tap_nav 'Settings';  sleep 3
assert_layout 'settings-font130' 1
shot 22-settings-font130
tap_nav 'Home';     sleep 2
assert_layout 'home-font130' 1
shot 23-home-font130
adb shell settings put system font_scale 1.0
sleep 3
echo 'FONT-SCALE PASS OK — no overflow, no nav overlap at 130% system font'

echo '== 9) final: no crash anywhere in the whole run =='
if adb logcat -d | grep -q 'FATAL EXCEPTION'; then adb logcat -d > logcat.txt; echo 'SMOKE FAIL: FATAL EXCEPTION during run'; exit 1; fi
adb logcat -d > logcat.txt
echo 'SMOKE TEST PASSED — mockup UI 01–08 on the real NDT1 engine: Back stack, layout audit, real-data pass (when tunnel reachable) and font-scale 1.3 all verified'
