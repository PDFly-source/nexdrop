# NexDrop Android 1.4.2 — documented known issues (NOT fixed in this release, by owner decision)

## 1. Recovered-transfer result screen can over-report average speed (cosmetic, display-only)

**Observed:** one receiver screenshot showed 130.22 MB/s on a very short 358 MiB
completed run, while the sender and every other measurement read ~40 MB/s.

**Root cause (code-verified, `ndt1/.../TurboReceiver.kt` + `Bench.kt`):**
on an INTERRUPTED-transfer recovery, the receiver's `ThroughputSampler` is created
when the resumed session starts (at the durable resume offset), but
`stats(durable)` at COMPLETE divides the FULL final durable total (which includes
bytes received before the interruption) by only the resumed session's wall time.
Example that matches the observation exactly: interruption at ~70% → resumed
session carries ~30% (≈113 MB) at a real ~39 MB/s in ≈2.88 s → displayed average
= 375.4 MB / 2.88 s = 130.22 MB/s. Transfer integrity is unaffected: SHA-256
verification, durability, resume offset and the sender-side average are all
correct. This is the same numerator/denominator ambiguity class as the
RC5 "Test 2" display anomaly, on the receiver side.

**Why it is not fixed in 1.4.2:** the honest fix (subtract the sampler-start
durable offset, i.e. report session bytes / session wall, matching the sender)
lives in the frozen NDT1 engine module. Per the release mandate the engine is
byte-identical to the physically validated build; a telemetry-only engine edit
would invalidate that guarantee. Documented for the first maintenance release.

**Fix design for 1.4.3 (3 lines + unit test, engine telemetry path only — wire,
CRC, SHA, resume and durability untouched):** capture `baseBytes =
writer.durableOffset` immediately after creating the sampler; call
`sampler.stats(durable - baseBytes)` so the receiver reports the same
session-bytes/session-wall quantity the sender reports. Add a regression unit
test: resumed transfer at offset X → stats.bytes == total - X and average ==
(total - X)/wall. UI cross-check (optional belt-and-braces in MainActivity):
if |stats.averageBps - bytes/duration| exceeds a sane epsilon, display the
wall-clock-derived value.

**User guidance for 1.4.2:** the average on a COMPLETED recovered transfer can
read high; trust the sender-side number, the wall duration, and the SHA-256
verification. Fresh (non-recovered) runs display correctly — validated across
all physical runs of this release.
