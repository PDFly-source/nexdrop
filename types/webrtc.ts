/**
 * WebRTC types for NexDrop.
 * Runtime connection states mirror the real RTCPeerConnection lifecycle.
 */

export const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    // A small set of STUN servers is used ONLY for local network / NAT discovery.
    // No TURN relay, no signaling, no credentials — files never touch any server.
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
  iceCandidatePoolSize: 0,
};

/**
 * Runtime peer connection states.
 * 'connected' is only ever set when the required DataChannels are actually open.
 */
export type WebRTCConnectionState =
  | 'idle'
  | 'new'
  | 'gathering'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

/** Dedicated DataChannels used by NexDrop. */
export type ChannelName = 'control' | 'file' | 'clipboard' | 'text';

export const DATA_CHANNELS: ChannelName[] = ['control', 'file', 'clipboard', 'text'];

/** Channels that must be open before the session is reported as connected. */
export const REQUIRED_CHANNELS: ChannelName[] = ['control', 'file'];
