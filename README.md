# NexDrop

**PRIVATE. DIRECT. FAST.** — Peer-to-peer file & text sharing between your devices, in the browser.

- **No server** — no signaling relay, no database, no backend of any kind
- **No accounts, no auth**
- **No cloud uploads** — files go straight from device to device over WebRTC DataChannels
- **Manual local pairing** — QR codes (or copy/paste codes) exchanged directly between the two devices
- **E2EE** — DTLS transport encryption plus an application-layer AES-256-GCM session key derived from an ECDH handshake (HKDF-SHA256)
- **Honest verification** — incremental SHA-256 hashes are compared on both ends; a 6-digit verification code is derived from the actual shared secret
- **Streaming large files** — 64 KiB chunks via `File.slice()`, ACK flow control, DataChannel backpressure, and progressive writes to File System Access API / OPFS / memory fallback. Multi-GB files never load fully into RAM.
- **Installable PWA** — offline app shell, service worker, manifest
- **Local history** — transfer metadata stays in your browser's localStorage; nothing is uploaded

## How pairing works

1. One device taps **Create pairing** → shows an offer QR
2. The other device taps **Join pairing** → scans the offer → shows an answer QR
3. The first device scans the answer → the direct connection opens

If either payload is too large for a single QR, NexDrop automatically splits it into a short numbered sequence. No camera? Use the built-in **image QR import**, **paste**, or **invite link** fallbacks.

> Direct connectivity depends on your browser and network. For the most reliable link, keep both devices on the same Wi-Fi.

## Development

The app is a Next.js static export, hosted from GitHub Pages at
<https://pdfly-source.github.io/nexdrop/>

The `basePath` is `/nexdrop` (repository name), so run dev with:

```bash
npm install
npm run dev
# open http://localhost:3000/nexdrop
```

## Build & deploy

Deploys are automated by GitHub Actions (`.github/workflows/deploy.yml`) on every push to `main`: lint → typecheck → static export → GitHub Pages.

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
- Each device generates an ephemeral ECDH P-256 key pair; the public keys travel inside the QR pairing code
- Both sides derive the same AES-256-GCM key via HKDF-SHA256 and encrypt every file chunk with a unique IV
- The 6-digit verification code is derived from the shared secret — if both screens match, the handshake wasn't tampered with
- STUN servers are used only for local NAT discovery; file data never passes through them, and no TURN relay is used

## License

MIT
