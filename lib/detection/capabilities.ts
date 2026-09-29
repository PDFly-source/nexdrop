/**
 * Browser Capability and Device Detection for NexDrop.
 * Executes strictly on client-side. Never accesses browser globals during SSR.
 */

export interface BrowserCapabilities {
  webRTC: boolean;
  dataChannel: boolean;
  fileSystemAccess: boolean;
  opfs: boolean;
  clipboard: boolean;
  webCrypto: boolean;
  serviceWorker: boolean;
  camera: boolean;
  vibration: boolean;
  audioContext: boolean;
  recommendedStorage: 'filesystem' | 'opfs' | 'blob';
  maxRecommendedFileSizeGb: number;
}

export interface DeviceInfo {
  name: string;
  os: string;
  browser: string;
  isMobile: boolean;
  isIOS: boolean;
  isAndroid: boolean;
}

export function detectBrowserCapabilities(): BrowserCapabilities {
  if (typeof window === 'undefined') {
    return {
      webRTC: false,
      dataChannel: false,
      fileSystemAccess: false,
      opfs: false,
      clipboard: false,
      webCrypto: false,
      serviceWorker: false,
      camera: false,
      vibration: false,
      audioContext: false,
      recommendedStorage: 'blob',
      maxRecommendedFileSizeGb: 2,
    };
  }

  const webRTC = typeof RTCPeerConnection !== 'undefined';
  const dataChannel = typeof RTCDataChannel !== 'undefined' || webRTC;
  const fileSystemAccess = typeof window !== 'undefined' && 'showSaveFilePicker' in window;
  const opfs =
    typeof navigator !== 'undefined' &&
    'storage' in navigator &&
    typeof navigator.storage.getDirectory === 'function';
  const clipboard = typeof navigator !== 'undefined' && 'clipboard' in navigator;
  const webCrypto = typeof window !== 'undefined' && 'crypto' in window && 'subtle' in window.crypto;
  const serviceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const camera =
    typeof navigator !== 'undefined' &&
    'mediaDevices' in navigator &&
    typeof navigator.mediaDevices.getUserMedia === 'function';
  const vibration = typeof navigator !== 'undefined' && 'vibrate' in navigator;
  const audioContext =
    typeof window !== 'undefined' &&
    ('AudioContext' in window || 'webkitAudioContext' in window);

  let recommendedStorage: 'filesystem' | 'opfs' | 'blob' = 'blob';
  let maxRecommendedFileSizeGb = 2; // Default memory-safe fallback

  if (fileSystemAccess) {
    recommendedStorage = 'filesystem';
    maxRecommendedFileSizeGb = 50; // Streams directly to disk, practically limited only by drive space
  } else if (opfs) {
    recommendedStorage = 'opfs';
    maxRecommendedFileSizeGb = 10; // OPFS can stream to persistent origin private filesystem
  }

  return {
    webRTC,
    dataChannel,
    fileSystemAccess,
    opfs,
    clipboard,
    webCrypto,
    serviceWorker,
    camera,
    vibration,
    audioContext,
    recommendedStorage,
    maxRecommendedFileSizeGb,
  };
}

export function getDeviceInfo(): DeviceInfo {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      name: 'NexDrop Device',
      os: 'Unknown',
      browser: 'Unknown',
      isMobile: false,
      isIOS: false,
      isAndroid: false,
    };
  }

  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  const isMobile = isIOS || isAndroid || /Mobi|Tablet/i.test(ua);

  let os = 'Unknown OS';
  if (/Windows NT/i.test(ua)) os = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) os = isIOS ? 'iOS' : 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Linux/i.test(ua)) os = 'Linux';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';

  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';

  // Device friendly name
  const storedName = typeof localStorage !== 'undefined' ? localStorage.getItem('nexdrop_device_name') : null;
  const name = storedName || `${os} ${browser}`;

  return {
    name,
    os,
    browser,
    isMobile,
    isIOS,
    isAndroid,
  };
}
