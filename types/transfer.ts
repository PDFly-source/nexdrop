/**
 * Strict Typed Protocol for NexDrop P2P Transfers.
 * Never load full large files into memory; stream via 64 KiB chunks with
 * backpressure & ACK flow control.
 */

export const CHUNK_SIZE = 64 * 1024; // 64 KiB chunks
export const BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024; // 256 KiB threshold
export const DEFAULT_FLOW_CONTROL_WINDOW = 16; // Chunks in-flight before waiting for ACK
// Receiver ACKs every ACK_BATCH chunks (and the final chunk) — one control
// frame per batch instead of one per chunk keeps the SCTP queue lean.
export const ACK_BATCH = 8;

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
  storageTarget?: 'filesystem' | 'opfs' | 'blob';
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
}

export interface ChunkAckMessage {
  type: 'ACK';
  transferId: string;
  index: number;
  /** Receiver's EWMA ms per chunk write — real write-throughput feedback
   *  for the sender's flow control. Optional: old peers omit it. */
  w?: number;
}

export interface FileEndMessage {
  type: 'FILE_END';
  transferId: string;
  /** Incremental SHA-256 of the plaintext file content, hex. */
  hash: string;
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
