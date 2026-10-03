/**
 * NexDrop TransferTransport — the transport-agnostic streaming interface.
 *
 * Pairing is SEPARATE from transport (see docs/TURBO-PROTOCOL.md): QR /
 * ephemeral signaling bootstraps a session (id + single-use token +
 * capabilities + available transports). Every transport implementation —
 * WebRTC DataChannel, native LAN TCP, Wi-Fi Direct TCP, Android native
 * local socket — then authenticates the SAME session and moves bytes.
 *
 * Implementations MUST:
 *  - stream files (never buffer a whole file in RAM),
 *  - report honest durable-byte speed (no peak/simulation),
 *  - support pause/resume/cancel and resumable reconnect,
 *  - verify SHA-256 before reporting completion,
 *  - never claim a transport they are not using.
 */

export type TransportKind = 'webrtc' | 'lan-tcp' | 'wifi-direct-tcp' | 'native-local';

export type TransportLinkType =
  | 'browser-webrtc'
  | 'lan-tcp'
  | 'wifi-direct-tcp'
  | 'hotspot-tcp'
  | 'native-local';

/** Which side of the transport this instance drives. */
export type TransportRole = 'sender' | 'receiver';

/** File metadata exchanged before any data frame. */
export interface TransferFileMeta {
  /** Stable per-session file id (u32 on the wire). */
  fileId: number;
  /** Display name (utf-8, never used on the hot path). */
  name: string;
  /** Exact byte size. */
  size: number;
  /** Sender's whole-file SHA-256 (hex) when known up front, else ''. */
  sha256?: string;
  /** MIME type if the sender knows it. */
  mime?: string;
}

/** Common telemetry every transport must expose (Phase: transport abstraction). */
export interface TransferStats {
  /** 'webrtc' | 'lan-tcp' | ... — which transport actually moved bytes. */
  transport: TransportKind;
  /** Human/physical link the bytes travelled (drives the UI badge). */
  linkType: TransportLinkType;
  localAddress: string;
  remoteAddress: string;
  /** Durable bytes moved (receiver-confirmed for TCP, ACKed for WebRTC). */
  bytesTransferred: number;
  elapsedMs: number;
  /** Durable bytes / second over the last telemetry window. */
  instantSpeed: number;
  /** Durable bytes / second since transfer start. */
  averageSpeed: number;
  /** Highest single-window durable speed observed (never reported AS the speed). */
  peakSpeed: number;
  /** Application-level round trip (telemetry echo), ms, or -1 if unknown. */
  rttMs: number;
  /** Transport retransmission count when the transport reports it, else -1. */
  retransmissions: number;
  /** Bytes currently accepted by the transport but not yet on the wire. */
  bufferedBytes: number;
  /** Frames/chunks queued for the disk writer on the receiving side. */
  writeQueue: number;
  /** Transfer-scoped integrity verdict: none | verifying | pass | fail. */
  integrity: 'none' | 'verifying' | 'pass' | 'fail';
  /** Receiver's durable offset — the resume point after any reconnect. */
  resumeOffset: number;
}

export type TransferPhase =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'awaiting-accept'
  | 'transferring'
  | 'paused'
  | 'verifying'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface TransferProgress {
  phase: TransferPhase;
  meta: TransferFileMeta | null;
  stats: TransferStats;
}

/** Emitted once per completed file with the verified SHA-256. */
export interface TransferResult {
  fileId: number;
  bytesTransferred: number;
  elapsedMs: number;
  sha256: string;
  /** Receiver-side verification result; sender learns it via the protocol. */
  integrity: 'pass' | 'fail';
}

/** Capabilities a device advertises during session bootstrap. */
export interface TransportCapabilities {
  /** Raw TCP over the local network (native/companion runtime only). */
  lanTcp: boolean;
  /** Wi-Fi Direct P2P (Android native runtime only). */
  wifiDirect: boolean;
  /** Android local/hotspot socket (native runtime only). */
  nativeLocal: boolean;
  /** WebRTC DataChannel (browser runtime — always true in the PWA). */
  webrtc: boolean;
}

export interface TransferTransport {
  readonly kind: TransportKind;

  /** Establish the transport (TCP connect / RTCPeerConnection). */
  connect(): Promise<void>;
  /** Server side: wait for an authenticated peer. */
  accept(): Promise<void>;
  /**
   * Sender: stream one file. MUST read from disk/OPFS in bounded chunks and
   * never materialize the whole file in RAM.
   */
  sendFile(meta: TransferFileMeta, source: AsyncIterable<Uint8Array>): Promise<void>;
  /**
   * Receiver: stream one incoming file to durable storage. Yields progress
   * so the caller can render it without polling.
   */
  receiveFile(sink: {
    write: (chunk: Uint8Array, offset: number) => Promise<void>;
    durableOffset: () => number;
  }): Promise<TransferResult>;
  pause(): void;
  resume(): void;
  cancel(): void;
  close(): Promise<void>;
  getStats(): TransferStats;
}
