/**
 * WebRTC configuration and DataChannel contracts for NexDrop.
 */

export type ChannelName = 'control' | 'file' | 'clipboard' | 'text' | 'metadata';

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: ['stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302'] },
  ],
  iceCandidatePoolSize: 10,
};

export type WebRTCConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed'
  | 'closed';

export interface DataChannelsMap {
  control?: RTCDataChannel;
  file?: RTCDataChannel;
  clipboard?: RTCDataChannel;
  text?: RTCDataChannel;
  metadata?: RTCDataChannel;
}
