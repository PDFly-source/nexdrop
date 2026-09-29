'use client';

import { useSyncExternalStore } from 'react';

const subscribe = (callback: () => void) => {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
};

const getSnapshot = () => {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
};

const getServerSnapshot = () => true;

/**
 * Returns true if the client is online.
 * Safe for SSR: guaranteed to match initial server HTML without hydration errors.
 */
export function useNetworkStatus(): boolean {
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );
}
