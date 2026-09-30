/**
 * Session types for NexDrop manual local pairing.
 * There is NO signaling server: the offer/answer SDP is exchanged by QR code
 * or copy/paste between the two devices.
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
