/**
 * Strict Typed Protocol for NexDrop P2P Transfers.
 * Never load full large files into memory; stream via 64 KiB chunks with backpressure & ACK flow control.
 */

export const CHUNK_SIZE = 64 * 1024; // 64 KiB chunks
export const BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024; // 256 KiB threshold
export const DEFAULT_FLOW_CONTROL_WINDOW = 16; // Chunks in-flight before waiting for ACK

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

// Discriminated union protocol messages sent over the "control" DataChannel
export interface FileStartMessage {
  type: 'FILE_START';
  transferId: string;
  name: string;
  size: number;
  mime: string;
  chunkSize: number;
  totalChunks: number;
  e2eeEnabled?: boolean;
  appMintlyMeta?: AppMintlyMetadata;
}

export interface ChunkAckMessage {
  type: 'ACK';
  transferId: string;
  index: number;
}

export interface FileEndMessage {
  type: 'FILE_END';
  transferId: string;
  hash?: string;
}

export interface CancelMessage {
  type: 'CANCEL';
  transferId: string;
  reason?: string;
}

export interface ResumeMessage {
  type: 'RESUME';
  transferId: string;
  nextChunk: number;
}

export interface VerifyMessage {
  type: 'VERIFY';
  transferId: string;
  hash: string;
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

export interface LiveTextOpMessage {
  type: 'LIVE_TEXT_OP';
  revision: number;
  operation: 'insert' | 'delete' | 'replace';
  position: number;
  text?: string;
  length?: number;
}

export type ControlMessage =
  | FileStartMessage
  | ChunkAckMessage
  | FileEndMessage
  | CancelMessage
  | ResumeMessage
  | VerifyMessage
  | SecurityVerifyMessage
  | TextTransferMessage
  | ClipboardSyncMessage
  | PeerMetadataMessage
  | LiveTextOpMessage;

// Metadata for binary chunk header prefix (16 bytes prefix on the "file" DataChannel)
// Or chunk metadata sent with binary chunk
export interface BinaryChunkHeader {
  transferId: string;
  index: number;
  byteLength: number;
  iv?: Uint8Array; // For E2EE AES-256-GCM
}

export interface AppMintlyMetadata {
  isApp: boolean;
  appName?: string;
  appId?: string;
  description?: string;
  icon?: string;
  version?: string;
}
