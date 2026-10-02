/**
 * Strict Typed Protocol for NexDrop P2P Transfers.
 * Never load full large files into memory; stream via 64 KiB chunks with
 * backpressure & ACK flow control.
 */

// ---- Transfer flow-control constants (all MEASURED, none decorative) ----
/** Conservative starting chunk size; grows per measured stability. */
export const CHUNK_SIZE = 64 * 1024; // 64 KiB
/** Largest chunk the sender may ever use (also clamped to negotiated SCTP limit − headroom). */
export const MAX_CHUNK_BYTES = 256 * 1024; // 256 KiB
/**
 * SCTP send-buffer pacing (bufferedAmountLowThreshold pattern):
 * keep sending while bufferedAmount <= BUFFER_HIGH_WATER; above it, wait
 * for 'bufferedamountlow', which fires when the buffer drains to
 * BUFFER_LOW_WATER. The old 256 KiB threshold + 50 ms failsafe timer
 * acted as a throughput sawtooth (fill 256 KiB → wait → repeat) and
 * throttled fast links; these bounds keep the pipeline FULL instead.
 */
export const BUFFER_HIGH_WATER = 4 * 1024 * 1024; // 4 MiB
export const BUFFER_LOW_WATER = 1 * 1024 * 1024; // 1 MiB
/**
 * In-flight byte window bounds (memory-bounded by design): starts at
 * INITIAL, grows ×1.5 per clean full-window drain up to MAX, shrinks on
 * real pressure but never below MIN — so a high-RTT link can never
 * collapse into stop-and-wait behavior.
 */
/**
 * App-level send pacer (v2.6, the burst-collapse fix). The real-device
 * cellular run (LIVE 2026-10-02: 358.07 MB APK, sustained 0.53 MB/s,
 * peak 67.15 MB/s, 29 stalls, ACK gaps to 12.585 s) proved the failure
 * mode: whenever 'bufferedamountlow' fired, the pump refilled the whole
 * 4 MiB SCTP buffer INSTANTLY. On a lossy high-RTT path that burst floods
 * the receiver's UDP socket, SCTP congestion control collapses, and the
 * association spends minutes in RTO backoff crawling at ~0.5 MB/s — the
 * same signature CI reproduces (~0.4 MB/s after sustained bursts).
 *
 * The pacer bounds the APP send rate with a token bucket (zero standing
 * memory; bounded by PACE_BURST_BYTES credit) and tracks the MEASURED
 * goodput with a profile-tuned margin, so a healthy path is never
 * throttled below what it proves it can sustain, while a fragile path
 * is never flooded into collapse. Purely additive to the buffer
 * high/low-water backpressure, which remains as the hard safety net.
 */
export const PACE_INITIAL_BPS = 8 * 1024 * 1024; // 8 MB/s conservative start
export const PACE_MIN_BPS = 512 * 1024; // 512 KB/s floor (never stop-and-wait)
export const PACE_MAX_BPS = 64 * 1024 * 1024; // 64 MB/s cap (above every measured WebRTC goodput)
export const PACE_BURST_BYTES = 512 * 1024; // bucket credit — small transfers start instantly
/** Transfer profile: auto (default, measured), turbo (aggressive margins + channel pool), standard (conservative). */
export type TransferProfile = 'auto' | 'turbo' | 'standard';
export const INITIAL_WINDOW_BYTES = 1 * 1024 * 1024; // 1 MiB
export const MIN_WINDOW_BYTES = 512 * 1024; // 512 KiB floor
export const MAX_WINDOW_BYTES = 16 * 1024 * 1024; // 16 MiB cap (bounded memory)
// Receiver ACK policy (v2.3, cumulative-byte ACK pipeline): ACK when the
// durably-written byte frontier has advanced >= ACK_BYTE_TARGET since the
// last ACK, and never let it wait more than ACK_MAX_DELAY_MS — whichever
// fires first. Byte-based (not chunk-count) so the cadence stays constant
// across the 64/128/256 KiB chunk ladder. One control frame per coalesced
// window keeps the SCTP queue lean; the timer guarantees the frontier
// advances even mid-batch. BOUNDARY events (pause, resume, cancel, error,
// completion, backpressure) always ACK IMMEDIATELY — the checkpoint rule.
// Defaults chosen by CI benchmark sweep (2026-10-01): see tests/e2e/benchmark.
export const ACK_BYTE_TARGET = 2 * 1024 * 1024; // 2 MiB cumulative-byte floor
export const ACK_MAX_DELAY_MS = 20; // time-based coalescing ceiling
/** Upper bound of the coalescing sweep (safety rail, benchmark-only). */
export const ACK_BYTE_TARGET_MAX = 4 * 1024 * 1024;

export type TransferStatus =
  | 'queued'
  | 'preparing'
  | 'transferring'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface FileItem {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified?: number;
  file?: File; // Sender only
  blobUrl?: string; // Receiver preview or completed object URL
  status: TransferStatus;
  progress: number; // 0 to 100
  bytesTransferred: number;
  speedBps: number; // bytes per second
  etaSeconds: number; // estimated seconds remaining
  hash?: string;
  integrityVerified?: boolean;
  error?: string;
  direction: 'outgoing' | 'incoming';
  startedAt?: number;
  completedAt?: number;
  storageTarget?: 'filesystem' | 'opfs' | 'opfs-sync' | 'blob';
}

export interface LocalHistoryItem {
  id: string;
  name: string;
  size: number;
  direction: 'sent' | 'received';
  timestamp: number;
  status: 'completed' | 'failed' | 'cancelled';
  hashVerified?: boolean;
}

// ---------------------------------------------------------------------------
// Control channel protocol messages (JSON over the "control" DataChannel)
// ---------------------------------------------------------------------------

export interface FileStartMessage {
  type: 'FILE_START';
  transferId: string;
  name: string;
  size: number;
  mime: string;
  chunkSize: number;
  totalChunks: number;
  /** True when chunks are AES-GCM encrypted with the session E2EE key. */
  e2eeEnabled?: boolean;
  /** base64url 6-byte per-transfer IV prefix (E2EE transfers only). */
  ivPrefix?: string;
  /**
   * TURBO v2.4: end-to-end hash algorithm offered by the sender.
   *  - 's256m' — Merkle SHA-256 (native block digests; both ends must agree)
   *  - absent  — classic streaming SHA-256 (legacy; default for old peers)
   * The receiver answers HASH_OK when it accepts 's256m'; the sender falls
   * back to the classic digest otherwise.
   */
  hashAlgo?: 's256m';
}

export interface HashOkMessage {
  type: 'HASH_OK';
  transferId: string;
  /** The algorithm the receiver will use to verify ('s256m'). */
  algo: 's256m';
}

export interface ChunkAckMessage {
  type: 'ACK';
  transferId: string;
  /** Highest chunk index covered by `wb` (diagnostics; bytes are authoritative). */
  index: number;
  /**
   * Cumulative plaintext bytes RECEIVED and processed (decoded/decrypted,
   * hashed — not yet necessarily durable). Flow-control signal only.
   */
  rb?: number;
  /**
   * Cumulative plaintext bytes DURABLY WRITTEN — the authoritative ACK
   * frontier. The sender's window releases against THIS value; resume and
   * byte-accounting trust it, never the chunk index.
   */
  wb?: number;
  /** Receiver's EWMA ms per chunk write — real write-throughput feedback
   *  for the sender's flow control. Optional: old peers omit it. */
  w?: number;
  /** Receiver's pending queue depth (chunks decrypted but not yet durably
   *  written) — real receiver-backpressure feedback. Optional. */
  q?: number;
}

export interface FileEndMessage {
  type: 'FILE_END';
  transferId: string;
  /** Incremental SHA-256 of the plaintext file content, hex. */
  hash: string;
  /**
   * Scheme the SENDER used for `hash` (v2.5.3): 's256m' = Merkle chain of
   * 4 MiB native block digests; 'sha256' = plain streaming SHA-256. The
   * receiver mirrors this scheme when verifying — a timing-fallible
   * handshake must never turn into a false integrity FAIL (LIVE-1790935144052:
   * byte-perfect 358.07 MB transfer reported SHA FAIL because the sender
   * fell back to JS hashing after a late HASH_OK while the receiver kept
   * the merkle scheme — different schemes can never match).
   * Absent (legacy senders) = 'sha256'.
   */
  hashAlgo?: 'sha256' | 's256m';
}

export interface FileCancelMessage {
  type: 'CANCEL';
  transferId: string;
  reason?: string;
}

export interface FilePauseMessage {
  type: 'PAUSE';
  transferId: string;
}

export interface FileResumeMessage {
  type: 'RESUME';
  transferId: string;
  nextChunk: number;
}

export interface FileVerifyMessage {
  type: 'VERIFY';
  transferId: string;
  /** Result of comparing sender & receiver hashes. */
  match: boolean;
}

export interface SecurityVerifyMessage {
  type: 'SECURITY_VERIFY';
  sasCode: string;
  verified: boolean;
}

export interface TextTransferMessage {
  type: 'TEXT_MESSAGE';
  id: string;
  text: string;
  category: 'plain' | 'code' | 'url' | 'json';
  language?: string;
  timestamp: number;
}

export interface ClipboardSyncMessage {
  type: 'CLIPBOARD_SYNC';
  id: string;
  content: string;
  category: 'plain' | 'code' | 'url' | 'json';
  timestamp: number;
}

export interface PeerMetadataMessage {
  type: 'PEER_METADATA';
  deviceName: string;
  platform: string;
  supportsFileSystemAccess: boolean;
  supportsOpfs: boolean;
  version: string;
}

export interface PingMessage {
  type: 'PING';
  timestamp: number;
}

export interface PongMessage {
  type: 'PONG';
  timestamp: number;
}

export type ControlMessage =
  | FileStartMessage
  | HashOkMessage
  | ChunkAckMessage
  | FileEndMessage
  | FileCancelMessage
  | FilePauseMessage
  | FileResumeMessage
  | FileVerifyMessage
  | SecurityVerifyMessage
  | TextTransferMessage
  | ClipboardSyncMessage
  | PeerMetadataMessage
  | PingMessage
  | PongMessage;
