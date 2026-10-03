# NexDrop Turbo Protocol v1 (NDT1)

Native local transport spec for implementers (Android app, Android TV,
desktop companion, future bridges). The browser PWA **cannot** implement
this — browsers expose no raw TCP/UDP sockets, and an HTTPS page cannot
open insecure sockets to LAN IPs. The PWA keeps WebRTC (see
`lib/transport/selector.ts`); native runtimes speak NDT1 directly.

## Design rules (hard constraints)

- No cloud relay, no server file relay, no upload. Local sockets only.
- No whole-file RAM buffering. File → bounded buffer → socket → disk.
- No JSON/base64 on the hot data path. Binary framing only (frames.ts).
- SHA-256 verified from durable bytes by the receiver; sender hash is
  never trusted.
- Pairing root is the SAME ephemeral token used by QR/signaling pairing
  (single-use, 10-minute TTL). No permanent keys are stored.

## Transport priority (AUTO — `selectTransport`)

1. Native LAN TCP when both endpoints support it and share a LAN
2. Wi-Fi Direct + TCP when available and usable
3. Native local/hotspot sockets
4. WebRTC (fallback; the only option for browsers)

Priority order between TCP variants is about *availability*, not speed:
all TCP variants saturate the physical link (see benchmarks below).

## Frame format (all integers big-endian)

```
 0  4  magic "NDT1"                      (u32)
 4  1  version = 1                       (u8)
 5  1  frame type                        (u8)
 6  2  flags                             (u16)
 8  4  payload length (max 8 MiB)       (u32)
12  4  CRC32 of header bytes 0..11       (u32)
16 ..  payload
```

DATA payload: `fileId u32 | offset u64 | fileSize u64 | len u32 | bytes`.

## Session flow

```
client                                 server
  HELLO{sessionId, HMAC(token,nonce), nonce}
                                       AUTH_OK{nonce echo}   (or REJECT{reason})
  OFFER{fileId, size, name, sha256}
                                       accept/decline (UX callback)
  <READY{fileId, durableOffset}>       resume: sender skips to offset
  DATA* (offset-addressed frames)
                                       PROGRESS{durableOffset}  ~512 KiB cadence
  COMPLETE{fileId, sha256}
                                       VERIFY_OK | VERIFY_FAIL{receiver sha}
```

## Flow control

Sliding window over the receiver's DURABLE offset:
`sent - durable <= 8 MiB` (FLOW_WINDOW_BYTES). The receiver reports its
durable position every 512 KiB (and at least every 200 ms) — the sender
self-clocks against it. RAM on both sides is bounded by the window, never
by the file.

## Resume (Phase 5 of the mission)

A dropped connection does NOT end the session. The receiver keeps its
durable writer open and re-hashes the durable prefix when reopening, so
after re-auth + re-OFFER it answers READY with the current durable offset
and the sender continues from there. A 10 GB transfer never restarts from
zero. (A receiver-process restart re-hashes the on-disk prefix before
answering READY.)

## Measured configuration (2-core CI runner, TCP loopback)

| Setting | Value | Evidence |
|---|---|---|
| Frame size | 512 KiB | 392.5 MB/s vs 232–322 for 1–4 MiB (bigger is worse) |
| TCP_NODELAY | ON | 416.4 vs 355.3 MB/s (+17%) |
| Flow window | 8 MiB | bounded RAM; loopback saturates anyway |
| 1 GiB sustained | ~207–379 MB/s | wall 2.7–4.9 s, SHA PASS, on-disk verified |
| Parallel streams | 1 | not benchmarked against 2+ yet (Phase 6 rule: measure first) |

The same code path (Node companion, `companion/src/`) provides the
reference implementation: `frames.ts`, `handshake.ts`, `tcpTransport.ts`,
`fileStream.ts`, `discovery.ts`, `cli.ts`.

## Discovery

UDP broadcast on port 53819, 1 Hz (companion). Android should prefer
NSD/mDNS advertising `_nexdrop._tcp`. The advertisement contains ONLY
ephemeral session info: deviceName, deviceType, capabilities, port,
sessionId, single-use token, nonce, packet CRC.

## Android implementation notes (Phase 7/11/13 — NOT built yet)

- `WifiP2pManager` for discovery/connection; after group formation, use
  the group owner's local address with plain TCP sockets (NDT1 frames).
- Permissions only when the user invokes local transfer (NEARBY_WIFI_DEVICES
  + location on 13+).
- Receiver storage: stream `socket -> bounded buffer -> FileChannel`, never
  `byte[]` of the whole file.
- Android TV: leanback receiver UI (device name + QR, Accept/Cancel via
  remote), same NDT1 data plane.

The companion (`companion/src/cli.ts`) is the interop reference: any
implementation that passes `tests/turbo.test.ts` semantics against it is
protocol-compatible.
