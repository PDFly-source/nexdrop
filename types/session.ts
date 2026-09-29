/**
 * Session and Pairing type definitions for NexDrop.
 */

export type SessionState =
  | 'idle'
  | 'pairing'
  | 'signaling'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'closed';

export type PairingMode = 'qr' | 'pin' | 'link' | 'manual';

export interface QrPayload {
  v: 1;
  app: 'nexdrop';
  session: string;
  token: string;
  pin?: string;
  host?: string;
  name?: string;
}

export interface PeerInfo {
  id: string;
  name: string;
  platform: string;
  connectedAt: number;
  securityCode?: string;
  securityVerified?: boolean;
  capabilities?: {
    fileSystemAccess: boolean;
    opfs: boolean;
    crypto: boolean;
  };
}

export interface SignalingMessage {
  type: 'offer' | 'answer' | 'candidate' | 'join' | 'leave' | 'ping' | 'pong';
  sessionId: string;
  fromPeerId: string;
  toPeerId?: string;
  payload?: any;
  timestamp: number;
}
