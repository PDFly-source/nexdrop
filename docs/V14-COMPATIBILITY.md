# NexDrop v1.4 — v1.3.0 architecture audit + feature compatibility matrix

Baseline: **v1.3.0 (code 5), main @ 0496112** — 341.5 MB Android→Android native
NDT1 TCP, 6.84 MB/s avg, 52 s, SHA-256 VERIFIED. The NDT1 transfer engine is
**FROZEN**: Frames.kt, Handshake.kt, TurboSender.kt, TurboReceiver.kt,
DurableWriter.kt, LocalNet.kt, QrPairing.kt and the wire protocol are not
modified by v1.4. Discovery (NDD1 beacon, control plane only, never carries
file data) gains one additive, backward-compatible field.

## v1.3.0 architecture (audited)

| Layer | Location | Role |
|---|---|---|
| NDT1 engine (FROZEN) | `android/ndt1/src/main/java/com/nexdrop/ndt1/` | Frames (wire), Handshake (HMAC token), TurboSender/TurboReceiver, DurableWriter (resume), LocalNet, QrPairing, Bench (ThroughputSampler/SpeedFormat) |
| NDD1 discovery | `android/ndt1/.../DiscoveryBeacon.kt`, `companion/src/discovery.ts` | UDP 53819, 1 Hz, ephemeral session info only — present but **unused by the app path in v1.3.0** |
| Native UI | `android/app/.../MainActivity.kt` (12 screens), `ui/Design.kt`, `HistoryStore.kt` | 5-tab nav, queue, accept sheet, transfer, result, history actions |
| Foreground service | `TransferService.kt` | truthful progress notification, dataSync type |
| TV client | `android/tv/.../ReceiveActivity.kt` | receive-only |
| PWA | Next.js app, WebRTC engine + transport selector | browser fallback, never claims native |
| Companion CLI | `companion/src/` | frames/handshake/tcp/fileStream/discovery in TS; used by CI smoke |
| CI | `android-build.yml` (apk → startup-smoke → release), `deploy.yml`, `.github/scripts/android-smoke.sh` | signed build, API 36 emulator smoke incl. real 341 MB NDT1 transfer, auto release |

## Feature compatibility matrix

| # | Feature | Verdict | Where it lands |
|---|---|---|---|
| 1 | Nearby Devices (REAL discovery only) | **NATIVE** — NDD1 UDP beacon already exists in engine + companion; app wires advertise/browse and pairs from the beacon token. PWA: browsers cannot send/receive UDP → **UNSUPPORTED in PWA** (honest). | Send screen (browse), Receive (advertise) |
| 2 | Android Share Sheet | **NATIVE** — `ACTION_SEND` / `ACTION_SEND_MULTIPLE` intent-filter, `EXTRA_STREAM` uris feed the real send queue. Not applicable to PWA (browser share is a different mechanism). | Manifest + MainActivity |
| 3 | Trusted Devices | **NATIVE** — stable per-install device id in the beacon body (additive field), local trust store written only after a SHA-256-verified transfer. PWA pairing model differs (ephemeral signaling) → deferred. | Devices screen + prefs |
| 4 | Auto-Accept (trusted only) | **NATIVE** — off by default, Settings toggle, gated on beacon-resolved trusted peer id. Unresolvable peer → normal accept sheet. | Settings + accept path |
| 5 | Preview Before Accept | **NATIVE (metadata now)** — accept sheet gains real sender name (beacon), real SHA-256 fingerprint (already in OFFER), file type. Image thumbnail / video poster / APK meta shown where the file REALLY exists locally (sender queue, History via real content queries). Content previews *before* the bytes arrive would require an OFFER-frame extension = engine change → **v1.5, after a new physical baseline**, honest note in-UI meanwhile. | Accept sheet, queue rows, History |
| 6 | Live transfer notification | **NATIVE** — exists (TransferService); v1.4 adds completion notification with real stats + open/share action. | TransferService |
| 7 | Transfer speed graph | **NATIVE** — sparkline fed by the existing ThroughputSampler history (real samples, no smoothing fiction). | Transfer screen |
| 8 | Shareable completion card | **NATIVE** — result screen card rendered to a real PNG, shared via FileProvider (system share sheet). PWA: roadmap. | Result screen |
| 9 | Light / Dark / System theme | **NATIVE** — DayNight-aware palette behind the same `D` tokens; existing Settings rows unchanged, Theme row added. | Design.kt + Settings |
| 10 | Accessibility / large text / tablet / landscape | **NATIVE** — content descriptions, 48 dp touch targets, font-scale pass beyond 1.3, landscape/tablet layout audit. PWA already responsive. | View layer |
| 11 | Better empty/error states | **BOTH** — honest empty states for History/Devices/queue and failure guidance (NATIVE); PWA states already exist. | View layer |
| 12 | Turbo Link real measurement | **NATIVE** — RTT via the protocol's own PING/PONG over a real handshake probe (engine API used, not modified) + measured throughput facts from verified transfers. Never invents a "quality" grade. | Devices screen |
| 13 | Nearby Radar | **NATIVE presence only** — Android exposes no RSSI/distance API for arbitrary peers; any radar distance would be fake. Discovered devices render as an honest presence list (no fake rings). | Send screen |
| 14 | Group Drop | **ROADMAP** — multi-receiver fan-out needs new pairing/session work against the frozen engine; not in v1.4 (implement "only if safely implementable"). | — |
| 15 | NFC / hotspot | **UNSUPPORTED (honest)** — Android Beam was removed in API 30; programmatic hotspot enablement is privileged (system apps). Devices screen shows a truthful unavailable state. | Devices screen |
| 16 | Web Drop / PWA fallback | **BOTH (regression guard)** — PWA untouched; every CI run keeps deploy + WebRTC suite green; native PWA fallback entry points unchanged. | CI guard |

## Regression rule

If any feature causes the CI real-data NDT1 transfer (341 MB) to regress
materially from **6.84 MB/s**, work stops and the regression is fixed before
any further feature. Discovery, share-sheet, trust, preview, graph, theme and
notification changes are all app-layer; none touch the transfer data path.
