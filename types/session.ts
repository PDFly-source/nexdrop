/**
 * Session types for NexDrop pairing.
 *
 * Two pairing paths exist:
 *  - AUTOMATIC (primary): one-scan pairing via the ephemeral signaling
 *    service — the joiner scans ONE QR (session id + single-use join token
 *    + endpoint, never SDP/ICE/keys), the host accepts or declines, and the
 *    SDP/ICE exchange happens automatically through the service.
 *  - MANUAL (fallback, states below): when the signaling service is
 *    unreachable, the offer/answer SDP is exchanged by QR code or
 *    copy/paste directly between the two devices — no signaling involved.
 *
 * In BOTH paths files and text travel only over the direct peer-to-peer
 * WebRTC DataChannels; the signaling service never relays file contents.
 */

/**
 * High-level session state machine.
 *
 * idle               — nothing happening
 * hosting-offer      — this device created an offer, waiting for the answer
 * joiner-answer      — this device scanned an offer, showing its answer
 * connecting         — descriptions exchanged, waiting for DataChannels to open
 * connected          — DataChannels open (real, verified)
 * disconnected       — peer connection dropped after being connected
 * failed             — connection or pairing failed
 * closed             — session closed by the user
 */
export type SessionState =
  | 'idle'
  // HOST: share created via the signaling service — ONE QR is visible.
  | 'hosting'
  // JOINER: join request filed, waiting for the HOST's decision.
  | 'waiting-for-join'
  // HOST: a join request arrived — the Accept/Decline decision is pending.
  | 'join-requested'
  // HOST accepted — automatic SDP/ICE exchange is in progress.
  | 'accepted'
  // Legacy manual code-flow states (fallback pairing).
  | 'hosting-offer'
  | 'awaiting-accept'
  | 'joiner-answer'
  | 'connecting'
  | 'connected'
  | 'transferring'
  | 'completed'
  | 'declined'
  | 'disconnected'
  | 'failed'
  | 'closed';

export interface PeerInfo {
  id: string;
  name: string;
  platform: string;
  connectedAt: number;
  capabilities: {
    fileSystemAccess: boolean;
    opfs: boolean;
    crypto: boolean;
  };
}

/** Result of parsing an incoming pairing payload (offer or answer). */
export interface ParsedPairingPayload {
  kind: 'offer' | 'answer';
  /** Raw (uncompressed) SDP. */
  sdp: string;
  /** ECDH P-256 public key, raw bytes. */
  peerPublicKey: ArrayBuffer;
  /** Creation timestamp (ms epoch) from the sending device. */
  createdAt: number;
  /** Expiry timestamp (ms epoch) from the sending device. */
  expiresAt: number;
  /** SHA-256 (base64url) of the original offer payload — answers only. */
  ackOfOffer?: string;
  /** Short label of the sending device, when provided. */
  device?: string;
}

export type PairingError =
  | 'invalid-format'
  | 'corrupt-segment'
  | 'expired'
  | 'not-offer'
  | 'not-answer'
  | 'wrong-session'
  | 'incomplete'
  | 'timeout'
  | 'unsupported-browser'
  | 'declined'
  | 'signal-unavailable'
  | 'signal-network'
  | 'already-joined';

/**
 * AUTHORITATIVE connection phase — the single source of truth for any
 * user-facing connection status (header badge, diagnostics). Derived in
 * exactly one place (useNexDropSession) from the real RTCPeerConnection
 * lifecycle plus the transfer engines' activity. The header may ONLY read
 * this — never re-derive from SessionState.
 *
 * An open DataChannel with an actively pumping transfer engine IS a live
 * connection: a transient ICE 'disconnected' blip must never show
 * "Not connected" while bytes are verifiably flowing.
 */
export type ConnectionPhase =
  | 'idle' // nothing happening — "Ready"
  | 'pairing' // share created, ONE QR visible, waiting for a receiver — "Waiting for receiver…"
  | 'waiting_for_peer' // join request filed, waiting for the host's decision
  | 'incoming_request' // host: a join request is pending Accept/Decline
  | 'connecting' // SDP/ICE exchange or DataChannels opening — "Connecting…"
  | 'connected' // DataChannels open (real, verified)
  | 'transferring' // transfer engine actively streaming file bytes
  | 'verifying' // receiver computing the SHA-256 verdict / verdict in flight
  | 'completed' // transfer(s) finished and verified, link still up
  | 'disconnected' // peer connection genuinely dropped, no data flowing
  | 'failed'; // connection or pairing failed

/** Direction of the actively-streaming transfer (drives ↑/↓ header labels). */
export type TransferDirection = 'outgoing' | 'incoming';

/** What the transfer engines report about live activity — never faked. */
export interface TransferActivity {
  active: boolean;
  direction: TransferDirection | null;
  /** Receiver is hashing the completed file for the SHA-256 verdict. */
  verifying: boolean;
}
