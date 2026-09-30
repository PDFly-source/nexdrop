'use client';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { FileItem } from '@/types/transfer';
import type { SessionState } from '@/types/session';
import { pairingInProgress, peerConnected, sendFlowReducer, sendFlowState } from '@/lib/transfer/sendFlow';

interface Options {
  sessionState: SessionState;
  sendQueue: FileItem[];
  addFiles: (files: File[]) => void;
  createPairing: (options?: { sendFirst?: boolean; fileCount?: number; totalBytes?: number }) => Promise<boolean>;
  disconnect: () => void;
}
export function useSendFlow({ sessionState, sendQueue, addFiles, createPairing, disconnect }: Options) {
  const [intent, dispatch] = useReducer(sendFlowReducer, 'idle');
  // Resource ownership guards async operations, not a second connection state.
  const attempt = useRef(0);
  const running = useRef(false);
  const ownsPairing = useRef(false);
  const beginSend = useCallback(() => dispatch('SEND'), []);
  const queueFiles = useCallback((files: FileList | File[]) => {
    const valid = Array.from(files).filter(file => file instanceof File &&
      !!file.name && Number.isSafeInteger(file.size) && file.size >= 0);
    if (!valid.length) return;
    addFiles(valid);
    dispatch('QUEUE');
  }, [addFiles]);
  const cancelConnection = useCallback(() => {
    attempt.current++;
    running.current = false;
    ownsPairing.current = false;
    disconnect();
    dispatch('CANCEL');
  }, [disconnect]);
  const retry = useCallback(() => dispatch('QUEUE'), []);
  const queued = sendQueue.filter(f => f.status === 'queued');
  const queuedCount = queued.length;
  const totalBytes = queued.reduce((sum, f) => sum + f.size, 0);
  useEffect(() => {
    if (peerConnected(sessionState)) ownsPairing.current = false;
    if (intent === 'auto_pairing' && ownsPairing.current && !running.current && sessionState === 'idle') {
      cancelConnection(); // Cancellation from Devices shares the same lifecycle.
      return;
    }
    // Removing the last file also invalidates an automatically owned QR.
    if (!queuedCount && ownsPairing.current && !peerConnected(sessionState)) {
      cancelConnection();
      return;
    }
    if (intent !== 'file_queued' || !queuedCount || running.current) return;
    if (peerConnected(sessionState) || pairingInProgress(sessionState)) {
      dispatch('PAIR'); // Observe the already-owned session, never replace it.
      return;
    }
    running.current = true;
    ownsPairing.current = true;
    const id = ++attempt.current;
    dispatch('PAIR');
    void createPairing({ sendFirst: true, fileCount: queuedCount, totalBytes }).then(ok => {
      if (id !== attempt.current) return;
      running.current = false;
      if (!ok) dispatch('FAIL');
    }).catch(() => {
      if (id !== attempt.current) return;
      running.current = false;
      dispatch('FAIL');
    });
  }, [intent, queuedCount, totalBytes, sessionState, createPairing, cancelConnection]);
  return { state: sendFlowState(intent, sessionState, sendQueue), beginSend, queueFiles, cancelConnection, retry };
}
