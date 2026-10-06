# NDT1 Parallel Transport — Design (v0, NOT IMPLEMENTED)

Status: DESIGN ONLY. No code, no wire changes shipped in rc6. This document
exists so the design is settled BEFORE a line is written, per the
performance-engineering mandate (§11: do not break the protocol, design the
parallel transport carefully).

## Go / No-Go gate (from the rc6 decisive physical test)

Implement ONLY if ALL hold on the rc6 single-stream physical run:
1. Throughput ≤ 10 MB/s with DEFAULT config on a healthy link
   (RSSI > −60 dBm, reported rate ≥ 150 Mbps — i.e., the radio can do more).
2. TX socket-write ≥ 85% of wall (sender starved by the path, not by us).
3. Storage stages (fsync+disk+SHA) ≤ 15% of wall.

If rc6's radio lock already lifts throughput ≥ 15 MB/s, this design stays
shelved and we chase route/band first.

## Why parallel streams can beat one stream on Wi-Fi

Single TCP over Wi-Fi loses airtime to per-stream dynamics: loss recovery
halves the congestion window and slow-starts back, delayed ACKs stretch the
send cycle, and any pause drains the pipe. N disjoint ranges over N sockets
overlap those stalls — what one stream loses to recovery, the others cover.
Expected sweet spot on phone Wi-Fi: 2–4 streams; N is capped at
min(4, Runtime.availableProcessors()).

## Compatibility contract (the hard requirement)

Old sender → new receiver: single stream, byte-identical v1 behavior. No
extra frames sent by the receiver before the sender asks.
New sender → old receiver: single stream only. The sender NEVER opens extra
connections unless the receiver explicitly confirmed support.

Why this is safe: both v1 endpoints IGNORE unknown frame types inside the
DATA phase (receiver: "unknown control on the data plane: ignore"; sender
drain: else->{}). Outside the DATA phase both endpoints are strict — so ALL
negotiation frames are exchanged strictly inside the DATA phase:

1. Control stream (stream 0) transfers range 0 exactly like a v1 transfer
   (HELLO/AUTH_OK/OFFER/READY → DATA frames) — an old receiver sees nothing
   unusual.
2. AFTER receiving READY, the new sender emits PARALLEL_REQ (new frame type,
   body: streamCount, rangeFrameSize) on the control stream. Old receiver
   ignores it and keeps transferring; no reply ever comes → sender stays
   single-stream forever. Old sender never sends it.
3. New receiver answers PARALLEL_OK (body: agreedStreamCount, dataPort) —
   old senders never read it because they never asked; and even if they
   somehow did, unknown types are ignored in their COMPLETE-phase loop.
4. Only after PARALLEL_OK does the sender open streams 1..N-1 to dataPort,
   each with its own HELLO carrying the same session token plus the stream
   index in the HELLO nonce bytes (version bit in HELLO version field set to
   2; v1 receivers reject version-2 HELLO with REJECT, which the sender
   treats as "no parallel" — an old receiver therefore never even reaches
   the multi-stream phase by construction).
5. Session token: single-use semantics preserved — the token authenticates
   the (sender, session) pair; stream index is bound into the helloProof
   nonce so a captured stream-0 proof cannot be replayed on stream 1.

## Ranges and durability

- File split into N contiguous ranges at frame-size-aligned boundaries;
  last range takes the remainder. Range i transfers on stream i as an
  ordinary offset-addressed NDT1 stream — DATA frames already carry
  absolute file offset, so NO frame format changes at all.
- Each stream has its own window and PROGRESS/CREDIT loop (unchanged frame
  types, per-connection semantics as today).
- DurableWriter becomes range-aware: writes land at absolute offsets
  (already supported — offset-addressed), the durability worker fsyncs the
  single fd (POSIX fsync is whole-file) and advances a per-range durable
  watermark; PROGRESS per stream reports only that range's fsynced prefix.
  The wire contract is unchanged per stream: PROGRESS never leads the disk.
- Resume: the .ndtpart gains a v2 manifest header (magic + version + range
  map + per-range durable offsets) written/updated on fsync. v1 part files
  (contiguous prefix) remain readable as N=1. Part files are transient and
  app-local; a versioned format is acceptable and documented.
- End-to-end SHA-256 unchanged: receiver hashes the whole assembled file
  incrementally per written byte (as today) and answers COMPLETE on the
  control stream with one VERIFY_OK/FAIL for the whole file. Range streams
  send RANGE_DONE (ignored by old receivers) and carry no SHA.

## Flow control

Per-stream window = WINDOW_BYTES (8 MiB default) as today. Aggregate
in-flight ≤ N × window; receiver RAM stays bounded (per-frame buffers +
fsync queue per stream, never whole-file). CREDIT per stream as today.
No shared window at v0 — per-stream independence keeps the semantics
identical to v1 and the code reuses the existing pump per connection.

## Telemetry (truthful, aggregated)

Per stream: existing TX/RX profile lines (socket write, read-wait, window
waits). Result screen adds: streams used, aggregate wall/bytes/MB/s,
per-stream MB/s, per-stream final offsets, and the honest note that
aggregate average = total bytes / wall (never a sum of per-stream averages
taken at different times). RadioPerf lock: one acquire for the whole
multi-stream session (already refcounted).

## Risks / open questions

- Hotspot AP airtime is shared: N streams can also WORSE throughput if the
  bottleneck is the radio PHY, not per-stream dynamics. The go/no-go gate
  exists precisely to distinguish these.
- Receiver accept loop is single-threaded (handleConnection serializes):
  v0 requires a thread-per-connection accept loop — bounded by N (≤ 4).
- Ordering of COMPLETE across streams: control stream waits for all
  RANGE_DONE before sending whole-file VERIFY (receiver side already
  serializes this per connection; cross-stream join is new, small state).
- fsync storms from N streams coalesce into one worker (already coalescing);
  worst case bounded by fsync cadence, unchanged contract.

## Test plan (before any merge)

1. Loopback unit tests: N=2/N=4 sender↔receiver, SHA pass, drop stream 1
   mid-transfer → resume from per-range durable; cancel joins all streams.
2. Compatibility: old-format sender (hand-rolled v1, as in
   Ndt1TcpBothWaysTest) ↔ new receiver: byte-identical single-stream pass.
   New sender ↔ old receiver mock: single-stream fallback, no extra frames
   answered, no extra connections opened.
3. CI emulator tunnel: 341 MB multi-stream vs single-stream A/B (loopback
   won't show radio gains — only correctness + no regression).
4. Physical: ONE decisive test, same protocol as rc6's, only after 1–3.
