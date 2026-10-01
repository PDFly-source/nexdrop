/**
 * WebRTC types for NexDrop.
 * Runtime connection states mirror the real RTCPeerConnection lifecycle.
 */

export const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    // A small set of STUN servers is used ONLY for local network / NAT discovery.
    // No TURN relay, no credentials — file data never passes through any
    // server, not even these STUN endpoints. (Pairing SDP/ICE travel via the
    // ephemeral signaling service on the automatic path, or QR/copy-paste
    // on the manual fallback path — never through STUN.)
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
export type ChannelName = 'control' | 'file' | 'file-1' | 'file-2' | 'file-3' | 'clipboard' | 'text';

export const DATA_CHANNELS: ChannelName[] = ['control', 'file', 'file-1', 'file-2', 'file-3', 'clipboard', 'text'];
/** Parallel binary file channels, in activation order. 'file' is channel 0
 * (always required); file-1..file-3 are optional extra SCTP streams for
 * TURBO multi-channel striping — old peers simply never open them. */
export const FILE_CHANNELS: ChannelName[] = ['file', 'file-1', 'file-2', 'file-3'];

/** Channels that must be open before the session is reported as connected. */
export const REQUIRED_CHANNELS: ChannelName[] = ['control', 'file'];
