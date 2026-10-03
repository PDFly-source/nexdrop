# NexDrop native clients — Android, Android TV

Native NDT1 Turbo implementations per `docs/TURBO-PROTOCOL.md` (the
authoritative spec) — byte-for-byte interoperable with the Node reference
companion (`companion/src/`).

## Modules

- `:app` — phone client (send + receive). `Frames.kt` + `Handshake.kt`
  implement the wire protocol; `TurboReceiver.kt` listens/authenticates and
  streams to disk with a durable-offset writer (`DurableWriter.kt`); the
  sender (`TurboSender.kt`) streams content URIs via ContentResolver with a
  bounded buffer, 512 KiB frames, 8 MiB window. `TransferService.kt` is the
  foreground service (Phase 19). `DiscoveryBeacon.kt` speaks the NDD1 UDP
  beacon (port 53819).
- `:tv` — Android TV RECEIVE-ONLY receiver (Phase 8): leanback, remote
  navigation, large type, Accept/Decline, progress, SHA-256 verdict.

## Memory contract

Both sides stream: ContentResolver/FileChannel with bounded buffers. RAM
never scales with file size (100 MB .. 10 GB+). Resume answers READY with
the durable offset; a 10 GB transfer never restarts from zero.

## Building

Open `android/` in Android Studio (AGP 8.5, Kotlin 1.9, SDK 34, minSdk 26)
or run `./gradlew :app:assembleDebug :tv:assembleDebug`. No Google services
are required.

## Protocol interop

The Kotlin layer mirrors `companion/src/frames.ts` exactly (big-endian
16-byte header, magic NDT1, header CRC32, HELLO proof = HMAC-SHA256(token,
nonce_be || "ndt1-hello")). Any device pairing against the desktop
companion CLI (`npx tsx companion/src/cli.ts receive/send`) speaks the same
bytes. Loopback/CI numbers live in `tests/turbo.test.ts`; REAL DEVICE
benchmarks (Android→Android, →TV, →Desktop) are the final authority and
are pending physical runs — see the mission report.
