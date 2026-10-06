# NexDrop Android v1.4.3 — RELEASE VERIFICATION

## Status: PRODUCTION RELEASED (2026-10-06)

- versionName: **1.4.3** · versionCode: **16**
- Branch: `main` (merged from `maint/v1.4.3-telemetry`, candidate commit `3cfb1bd`)
- NDT1 protocol: **UNCHANGED** — wire format, frames, handshake, discovery, resume and
  durability contract are byte-identical to v1.4.2.
- Transfer engine behavior: **UNCHANGED** — TurboSender, DurableWriter, Frames, Handshake,
  DiscoveryBeacon are byte-identical to v1.4.2. The only production-code change is a
  display-telemetry fix in `TurboReceiver.kt` (see below).

## The fix (maintenance scope — one bug)

Recovered-transfer result-screen average speed is now session-scoped:

```
average = sessionBytes / sessionWall    (recovered transfer)
```

Previously a recovered transfer divided the FULL durable total (including bytes received
before the interruption) by only the resumed session's wall time, producing an inflated
display value (physical case: 375.4 MB / 2.88 s = 130.22 MB/s). File integrity, SHA-256
verification, durable-offset resume and actual transfer speed were never affected — the bug
was in the displayed number only. Normal (non-recovered) transfers keep the existing
calculation unchanged.

## Verification basis (CI/integration)

- 48/48 unit tests PASS (40 existing + new regression tests A/B/C/E, including a real-TCP
  interrupted-transfer → durable-offset resume test asserting the result stats count only
  the resumed session's bytes, with SHA-256 verified and content byte-identical).
- Startup smoke on the **signed** APK (API 36 emulator): launch, 7 live NDT1 transfers,
  interrupted-transfer → durable-offset resume → SHA-256 VERIFIED, font-scale 1.3,
  back stack, layout audit — ALL PASS.
- APK signing verification PASS: APK Signature Scheme v2 + v3, certificate
  CN=NexDrop Release, SHA-256 fingerprint `11cb2ab82ba751fea04d101bd3a1498b852581f999056a3bc371e47e326a861a`.
- APK: `NexDrop-release.apk`, 3,704,023 bytes,
  SHA-256 `6a2a98e549a29712a439948d3f4cac0bc5e2f7001ec816047908d41d8297d10c`.

## Owner physical verification — WAIVED BY EXPLICIT OWNER APPROVAL

The two additional physical verification tests for v1.4.3 (one recovered transfer, one
normal transfer) were **not performed**. The owner explicitly approved the production
release without them on 2026-10-06; the release basis is the CI/integration evidence above.

**Honesty notes:**
- No physical v1.4.3 performance measurements were made. No new physical speed numbers are
  claimed for this release.
- The documented ~40 MB/s on a favorable 5 GHz route is **historical** performance,
  physically validated on the v1.4.2 engine (whose transfer behavior is byte-identical in
  v1.4.3). It is not a v1.4.3 test result.
