# NexDrop

**PRIVATE. DIRECT. FAST.** — Peer-to-peer file & text sharing between your devices, in the browser.

## Architecture

NexDrop uses lightweight ephemeral signaling only to establish the WebRTC
connection. Files and text travel directly between devices over encrypted
WebRTC DataChannels. The signaling service does not relay file contents.

- **No accounts, no auth** — nothing to sign up for
- **No cloud file uploads** — files go straight from device to device over
  WebRTC DataChannels; no storage bucket, CDN, or server filesystem ever
  receives file bytes
- **One-scan pairing** — the joiner scans a single QR; the connection then
  completes automatically (no answer QR, no second scan)
- **Host-controlled consent** — the host device accepts or declines every
  connection request
- **Short-lived sessions** — a pairing session expires automatically
  (10 minutes); the join token is single-use, and a declined session is
  permanently dead
- **Manual fallback** — if the signaling service is unreachable, NexDrop
  falls back to direct QR / copy-paste code exchange between the two
  screens, which needs no signaling at all
- **E2EE** — DTLS transport encryption plus an application-layer
  AES-256-GCM session key derived from an ECDH handshake (HKDF-SHA256)
- **Honest verification** — incremental SHA-256 hashes are compared on both
  ends; a 6-digit verification code is derived from the actual shared secret
- **Bounded-memory streaming** — 64 KiB chunks via `File.slice()`, ACK flow
  control, DataChannel backpressure, and progressive writes to the File
  System Access API / OPFS / memory fallback. Multi-GB files never load
  fully into RAM.
- **Installable PWA** — offline app shell, service worker, manifest
- **Local history** — transfer metadata stays in your browser's
  localStorage; nothing is uploaded

## What the signaling service sees (and what it never sees)

The ephemeral signaling service exists only to establish the direct
device-to-device connection. During the short pairing window it carries:

- session id, the single-use join token, and its expiry
- the SDP offer/answer and ICE candidates (standard, public connection
  establishment material)
- the ephemeral ECDH public keys and the joining device's name/platform
  (so the host can make an informed Accept/Decline decision)

It never receives file contents, file data chunks, clipboard text, or
transfer history. The session is destroyed the moment the DataChannels
open, and expires on its own within minutes if no connection happens.
The QR code itself carries no SDP, ICE, or key material — only the session
id, single-use join token, and endpoint.

If you prefer zero signaling involvement, the manual fallback path
exchanges everything directly between the two screens.

## How pairing works

**Automatic (primary — one scan):**

1. One device taps **Create pairing** → shows a single QR
2. The other device taps **Join pairing** → scans that ONE QR
3. The first device receives the connection request → taps **Accept**
4. Signaling, SDP, ICE, and the DataChannel complete automatically →
   **Connected** — real file transfer with SHA-256 verification follows

**Manual fallback (no signaling):**

1. One device taps **Create pairing** → shows an offer QR
2. The other device taps **Join pairing** → scans the offer → shows an
   answer QR
3. The first device scans the answer → the direct connection opens

If either manual payload is too large for a single QR, NexDrop automatically
splits it into a short numbered sequence. No camera? Use the built-in
**image QR import**, **paste**, or **invite link** fallbacks.

> Direct connectivity depends on your browser and network. For the most
> reliable link, keep both devices on the same Wi-Fi.

## Development

The app is a Next.js static export, hosted from GitHub Pages at
<https://pdfly-source.github.io/nexdrop/>

The `basePath` is `/nexdrop` (repository name), so run dev with:

```bash
npm install
npm run dev
# open http://localhost:3000/nexdrop
```

## Build, test & deploy

Deploys are automated by GitHub Actions (`.github/workflows/deploy.yml`) on
every push to `main`:

1. **build** — lint → typecheck → deterministic unit suite (crypto, pairing
   codecs, session state machines — tier A) → static export verification
2. **two-device-e2e** — real regression suite: two isolated browser
   sessions pair and transfer over a real WebRTC DataChannel path
3. **transfer-benchmark** — real two-device browser benchmark (tier C):
   measured throughput/RTT/bufferedAmount/heap from live engine telemetry,
   never synthesized values
4. **deploy** — publishes the verified export to GitHub Pages

Manual build:

```bash
npm run build   # produces ./out
```

## Browser support

- **Chromium desktop** (Chrome/Edge): best support — File System Access API streams received files straight to disk
- **Android Chrome, Firefox**: OPFS or in-memory fallback
- **Safari / iOS**: WebRTC works; large-file receiving uses the in-memory fallback (browsers without File System Access / OPFS streams are limited to ~1.5 GiB)

The app capability-detects everything and shows honest fallbacks instead of faking features.

## Security notes

- WebRTC DataChannels are DTLS-encrypted by default
- Each device generates an ephemeral ECDH P-256 key pair; public keys travel
  through the signaling service (automatic path) or inside the manual
  pairing code (fallback path)
- Both sides derive the same AES-256-GCM key via HKDF-SHA256 and encrypt
  every file chunk with a unique IV
- The 6-digit verification code is derived from the shared secret — if both
  screens match, the handshake wasn't tampered with
- STUN servers are used only for local NAT discovery; file data never passes
  through them, and no TURN relay is used

## License

MIT
