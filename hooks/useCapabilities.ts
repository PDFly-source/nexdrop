'use client';

import { useSyncExternalStore } from 'react';
import {
  detectBrowserCapabilities,
  getDeviceInfo,
  BrowserCapabilities,
  DeviceInfo,
} from '@/lib/detection/capabilities';

const DEFAULT_CAPABILITIES: BrowserCapabilities = {
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

const DEFAULT_DEVICE_INFO: DeviceInfo = {
  name: 'My Device',
  os: 'Unknown',
  browser: 'Browser',
  isMobile: false,
  isIOS: false,
  isAndroid: false,
};

const emptySubscribe = () => () => {};

let cachedCapabilities: BrowserCapabilities | null = null;
let cachedDeviceInfo: DeviceInfo | null = null;

export function useBrowserCapabilities(): BrowserCapabilities {
  return useSyncExternalStore(
    emptySubscribe,
    () => {
      if (!cachedCapabilities) {
        cachedCapabilities = detectBrowserCapabilities();
      }
      return cachedCapabilities;
    },
    () => DEFAULT_CAPABILITIES
  );
}

export function useDeviceInfo(): DeviceInfo {
  return useSyncExternalStore(
    emptySubscribe,
    () => {
      if (!cachedDeviceInfo) {
        cachedDeviceInfo = getDeviceInfo();
      }
      return cachedDeviceInfo;
    },
    () => DEFAULT_DEVICE_INFO
  );
}
