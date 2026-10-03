# NexDrop native clients — Android, Android TV

Native NDT1 Turbo implementations per `docs/TURBO-PROTOCOL.md` (the
authoritative spec) — byte-for-byte interoperable with the Node reference
companion (`companion/src/`).

## Why a native layer exists (honest architecture)

A pure PWA **cannot** open TCP sockets, bind ports, or use Wi-Fi Direct —
the browser sandbox forbids it. The PWA keeps WebRTC everywhere and stays
fully functional. This companion is the **Android ↔ Android native local
acceleration layer** (mission 2026-10-03): the same ONE-QR flow
(Receive → ONE QR → scan → Accept/Decline → automatic connection →
transfer), with NDT1 TCP underneath instead of WebRTC.

Transport selection is automatic and truthful:

| Pair | Transport |
| --- | --- |
| Native app ↔ native app (Android↔Android) | **NATIVE LOCAL (NDT1 TCP)** |
| Native app ↔ Windows / TV browser / PWA | **WebRTC via the NexDrop PWA** |
| Browser ↔ browser | **WebRTC (PWA)** |

On native failure the app shows "Native Local unavailable" and offers the
deployed PWA (WebRTC path). Reconnecting within the 10-minute session
resumes from the durable offset — never from zero.

## Modules

- `:ndt1` — pure transport library: `Frames.kt` + `Handshake.kt` (wire
  protocol), `TurboReceiver.kt` (TCP server, HELLO auth, OFFER
  accept/decline, PROGRESS 512 KiB + CREDIT, VERIFY), `TurboSender.kt`
  (ContentResolver streaming, 8 MiB window, 512 KiB frames, TCP_NODELAY,
  2 MiB socket buffers, resume from READY offset), `DurableWriter.kt`
  (FileChannel explicit-position writes, fsync-coalescing, part-file
  finalize), `QrPairing.kt` (pairing payload), `Bench.kt` (honest
  throughput sampler + deterministic benchmark generator),
  `DiscoveryBeacon.kt` (NDD1 UDP beacon, port 53819).
- `:app` — phone client (send + receive + benchmark): ONE QR display
  (rendered bitmap) and scan (ZXing), Accept/Decline dialog, progress with
  average/ETA from durable bytes, Pause/Resume/Cancel (wire frames),
  NATIVE 358 MB / 1 GB benchmark with shareable JSON, PWA failover link.
- `:tv` — Android TV RECEIVE-ONLY receiver (leanback, remote navigation,
  large type, real QR for the sender phone to scan, Accept/Decline,
  progress, SHA-256 verdict).

## Memory contract

Both sides stream: ContentResolver/FileChannel with bounded buffers. RAM
never scales with file size (100 MB .. 10 GB+). Resume answers READY with
the durable offset; a 10 GB transfer never restarts from zero.

## Building

Open `android/` in Android Studio (AGP 8.5, Kotlin 1.9, SDK 34, minSdk 26)
or run `./gradlew :app:assembleDebug :tv:assembleDebug`. No Google services
are required.

Honest status: **this sandbox has no Android SDK** — the Gradle build has
not been executed here. Compile in Android Studio before the first device
run.

## Protocol interop

The Kotlin layer mirrors `companion/src/frames.ts` exactly (big-endian
16-byte header, magic NDT1, header CRC32, HELLO proof = HMAC-SHA256(token,
nonce_be || "ndt1-hello")). Any device pairing against the desktop
companion CLI (`npx tsx companion/src/cli.ts receive/send`) speaks the
same bytes. Loopback/CI numbers live in `tests/turbo.test.ts`; REAL DEVICE
benchmarks (Android→Android, →TV, →Desktop) are the final authority and
are pending physical runs — see the mission report.
