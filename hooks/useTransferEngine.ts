'use client';

/**
 * useTransferEngine — bridges the WebRTC peer channels to the
 * sender/receiver engines, drives real runtime progress state, and records
 * local history metadata.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SenderEngine, SenderProgress } from '@/lib/transfer/sender';
import { ReceiverEngine, ReceiverProgress } from '@/lib/transfer/receiver';
import { ChunkCipher, randomId } from '@/lib/crypto';
import {
  ControlMessage,
  FileItem,
  FileVerifyMessage,
  FilePauseMessage,
  FileResumeMessage,
} from '@/types/transfer';
import { PeerConnectionManager } from '@/lib/webrtc/peer';
import { sounds } from '@/lib/utils/sound';

export interface ActiveTransferState {
  id: string;
  name: string;
  size: number;
  direction: 'outgoing' | 'incoming';
  status: 'transferring' | 'paused' | 'completed' | 'cancelled' | 'failed';
  progress: number;
  bytesTransferred: number;
  speedBps: number;
  etaSeconds: number;
  writerType?: string;
}

interface TransferCompleteInfo {
  transferId?: string;
  name: string;
  size: number;
  direction: 'sent' | 'received';
  hashVerified?: boolean;
}

/** Cap on incoming-file entries kept in the UI (blob URLs of evicted items are revoked). */
const MAX_INCOMING_ITEMS = 20;


export function useTransferEngine(
  peerManager: PeerConnectionManager | null,
  isPeerConnected: boolean,
  onFileChunkCallbackRef: React.MutableRefObject<((chunk: ArrayBuffer) => void) | null>,
  onControlCallbackRef: React.MutableRefObject<((msg: ControlMessage) => void) | null>,
  cipherRef: React.MutableRefObject<ChunkCipher | null>,
  onTransferComplete?: (item: TransferCompleteInfo) => void,
  onTransferVerified?: (transferId: string, match: boolean) => void
) {
  const [sendQueue, setSendQueue] = useState<FileItem[]>([]);
  const [incomingFiles, setIncomingFiles] = useState<FileItem[]>([]);
  const [activeTransfer, setActiveTransfer] = useState<ActiveTransferState | null>(null);

  const activeSenderRef = useRef<SenderEngine | null>(null);
  const receiverEngineRef = useRef<ReceiverEngine | null>(null);

  // The consumer (app/page.tsx) passes onTransferComplete / onTransferVerified
  // as inline arrows, so their identity changes on every render. Referencing
  // them in effect dependency arrays recreated the RECEIVER ENGINE (and
  // rebuilt the send-queue callback) on every re-render — mid-transfer the
  // new engine had no transferId, so every incoming chunk was silently
  // dropped and the transfer stalled at 0 bytes forever. Keep the latest
  // callbacks in refs instead so effects depend only on stable values.
  const onTransferCompleteRef = useRef(onTransferComplete);
  const onTransferVerifiedRef = useRef(onTransferVerified);
  useEffect(() => {
    onTransferCompleteRef.current = onTransferComplete;
    onTransferVerifiedRef.current = onTransferVerified;
  }, [onTransferComplete, onTransferVerified]);
  const isTransferringRef = useRef<boolean>(false);
  const peerManagerRef = useRef<PeerConnectionManager | null>(null);

  useEffect(() => {
    peerManagerRef.current = peerManager;
  }, [peerManager]);

  // -----------------------------------------------------------------------
  // Receiver engine (bound to the current peer manager & session cipher)
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!peerManager) return;

    receiverEngineRef.current = new ReceiverEngine({
      getCipher: () => cipherRef.current,
      onProgress: (p: ReceiverProgress) => {
        setActiveTransfer({
          id: p.transferId,
          name: p.name,
          size: p.size,
          direction: 'incoming',
          status: p.status,
          progress: p.percentage,
          bytesTransferred: p.bytesReceived,
          speedBps: p.speedBps,
          etaSeconds: p.etaSeconds,
          writerType: p.writerType,
        });
        setIncomingFiles((prev) =>
          prev.map((item) =>
            item.id === p.transferId
              ? {
                  ...item,
                  status: p.status,
                  progress: p.percentage,
                  bytesTransferred: p.bytesReceived,
                  speedBps: p.speedBps,
                  etaSeconds: p.etaSeconds,
                  storageTarget: p.writerType,
                }
              : item
          )
        );
      },
      onCompleted: (p: ReceiverProgress) => {
        sounds.playComplete();
        setActiveTransfer((prev) =>
          prev?.id === p.transferId
            ? { ...prev, status: 'completed', progress: 100, writerType: p.writerType }
            : prev
        );
        setIncomingFiles((prev) =>
          prev.map((item) =>
            item.id === p.transferId
              ? {
                  ...item,
                  status: 'completed',
                  progress: 100,
                  bytesTransferred: p.size,
                  blobUrl: p.blobUrl,
                  integrityVerified: p.hashVerified,
                  completedAt: Date.now(),
                }
              : item
          )
        );
        onTransferCompleteRef.current?.({
          transferId: p.transferId,
          name: p.name,
          size: p.size,
          direction: 'received',
          hashVerified: p.hashVerified,
        });
      },
      onError: (transferId: string, err: string) => {
        sounds.playError();
        setActiveTransfer((prev) => (prev?.id === transferId ? { ...prev, status: 'failed' } : prev));
        setIncomingFiles((prev) =>
          prev.map((item) => (item.id === transferId ? { ...item, status: 'failed', error: err } : item))
        );
      },
      sendControlMessage: (msg: any) => {
        return peerManagerRef.current ? peerManagerRef.current.sendControl(msg) : false;
      },
    });

    return () => {
      receiverEngineRef.current = null;
    };
  }, [peerManager, cipherRef]);

  // -----------------------------------------------------------------------
  // Incoming WebRTC events
  // -----------------------------------------------------------------------

  useEffect(() => {
    onFileChunkCallbackRef.current = (chunk: ArrayBuffer) => {
      void receiverEngineRef.current?.handleChunk(chunk);
    };

    onControlCallbackRef.current = (msg: ControlMessage) => {
      const receiver = receiverEngineRef.current;
      const sender = activeSenderRef.current;
      console.debug('[nexdrop] control:', (msg as { type?: string }).type,
        'for', (msg as { transferId?: string }).transferId ?? 'session',
        '| active sender:', sender?.activeTransferId ?? 'none',
        '| active receiver:', receiver?.activeTransferId ?? 'none');

      switch (msg.type) {
        case 'FILE_START':
          if (!receiver) return;
          setIncomingFiles((prev) => {
            const next = [
              {
                id: msg.transferId,
                name: msg.name,
                size: msg.size,
                type: msg.mime,
                status: 'transferring' as const,
                progress: 0,
                bytesTransferred: 0,
                speedBps: 0,
                etaSeconds: 0,
                direction: 'incoming' as const,
                startedAt: Date.now(),
              },
              ...prev,
            ];
            // Bound the incoming list: revoke the blob URL of any completed
            // item evicted past the cap so object URLs (and the blobs they
            // pin) cannot accumulate without limit across a long session.
            if (next.length > MAX_INCOMING_ITEMS) {
              next.slice(MAX_INCOMING_ITEMS).forEach((evicted) => {
                if (evicted.blobUrl) URL.revokeObjectURL(evicted.blobUrl);
              });
              return next.slice(0, MAX_INCOMING_ITEMS);
            }
            return next;
          });
          void receiver.startTransfer(msg);
          break;

        case 'ACK':
          sender?.handleAck(msg.index);
          break;

        case 'FILE_END':
          console.debug('[nexdrop] FILE_END received for', (msg as { transferId?: string }).transferId?.slice(0, 8));
          void receiver?.finishTransfer(msg);
          break;

        case 'PAUSE':
          receiver?.handlePause(msg as FilePauseMessage);
          break;

        case 'RESUME':
          receiver?.handleResume(msg as FileResumeMessage);
          break;

        case 'CANCEL': {
          // A CANCEL names a transfer (or the whole session). Only cancel the
          // engine if it is ACTUALLY handling that transfer — a cancel for a
          // completed/old transfer must never kill a live one.
          const cancelId = msg.transferId as string | undefined;
          const r = cancelId
            ? cancelId === receiver?.activeTransferId
            : !!receiver?.activeTransferId;
          const s = cancelId
            ? cancelId === sender?.activeTransferId
            : !!sender?.activeTransferId;
          if (s) sender?.cancel(msg.reason || 'Cancelled by peer');
          if (r) void receiver?.cancel(msg.reason || 'Cancelled by peer');
          if (s || r) {
            isTransferringRef.current = false;
            setActiveTransfer((prev) =>
              prev && prev.id === (cancelId ?? prev.id) ? { ...prev, status: 'cancelled' } : prev
            );
          }
          break;
        }

        case 'VERIFY': {
          // Receiver's integrity verdict about OUR outgoing file
          const v = msg as FileVerifyMessage;
          setSendQueue((q) =>
            q.map((item) =>
              item.id === v.transferId ? { ...item, integrityVerified: v.match } : item
            )
          );
          onTransferVerified?.(v.transferId, v.match);
          break;
        }

        default:
          break;
      }
    };

    return () => {
      onFileChunkCallbackRef.current = null;
      onControlCallbackRef.current = null;
    };
  }, [onFileChunkCallbackRef, onControlCallbackRef, onTransferVerified]);

  // -----------------------------------------------------------------------
  // Send queue processing
  // -----------------------------------------------------------------------

  const processNextQueueItemRef = useRef<() => void>(() => {});
  // Mirror of sendQueue for imperative reads — state updaters must stay pure,
  // so the sender is created/started OUTSIDE the setSendQueue updater.
  const sendQueueRef = useRef<FileItem[]>([]);
  useEffect(() => {
    sendQueueRef.current = sendQueue;
  }, [sendQueue]);

  const processNextQueueItem = useCallback(() => {
    if (isTransferringRef.current || !peerManager || !isPeerConnected) return;

    {
      const currentQueue = sendQueueRef.current;
      const nextIndex = currentQueue.findIndex((item) => item.status === 'queued');
      if (nextIndex === -1) return;

      const targetItem = currentQueue[nextIndex];
      if (!targetItem.file) return;

      const fileChannel = peerManager.getChannel('file');
      if (!fileChannel || fileChannel.readyState !== 'open') {
        return;
      }

      isTransferringRef.current = true;
      console.debug('[nexdrop] queue: starting transfer', targetItem.id, targetItem.name);

      const sender = new SenderEngine({
        file: targetItem.file,
        transferId: targetItem.id,
        fileChannel,
        sendControlMessage: (msg: any) => peerManager.sendControl(msg),
        cipher: cipherRef.current,
        onProgress: (p: SenderProgress) => {
          console.debug('[nexdrop] sender progress:', p.transferId.slice(0, 8), p.status, p.percentage + '%');
          setActiveTransfer({
            id: p.transferId,
            name: targetItem.name,
            size: targetItem.size,
            direction: 'outgoing',
            status: p.status,
            progress: p.percentage,
            bytesTransferred: p.bytesTransferred,
            speedBps: p.speedBps,
            etaSeconds: p.etaSeconds,
          });
          setSendQueue((q) =>
            q.map((item) =>
              item.id === p.transferId
                ? {
                    ...item,
                    status: p.status,
                    progress: p.percentage,
                    bytesTransferred: p.bytesTransferred,
                    speedBps: p.speedBps,
                    etaSeconds: p.etaSeconds,
                  }
                : item
            )
          );
        },
        onCompleted: (transferId: string, hash: string) => {
          console.debug('[nexdrop] sender completed:', transferId.slice(0, 8));
          sounds.playComplete();
          isTransferringRef.current = false;
          activeSenderRef.current = null;

          setSendQueue((q) =>
            q.map((item) =>
              item.id === transferId
                ? {
                    ...item,
                    status: 'completed',
                    progress: 100,
                    bytesTransferred: item.size,
                    hash,
                    // Verification verdict arrives later via the VERIFY message
                    integrityVerified: undefined,
                    completedAt: Date.now(),
                  }
                : item
            )
          );

          onTransferCompleteRef.current?.({
            transferId,
            name: targetItem.name,
            size: targetItem.size,
            direction: 'sent',
            hashVerified: undefined,
          });

          setTimeout(() => {
            processNextQueueItemRef.current();
          }, 200);
        },
        onError: (transferId: string, err: string) => {
          console.debug('[nexdrop] sender ERROR:', transferId.slice(0, 8), err);
          sounds.playError();
          isTransferringRef.current = false;
          activeSenderRef.current = null;

          setSendQueue((q) =>
            q.map((item) => (item.id === transferId ? { ...item, status: 'failed', error: err } : item))
          );
          setActiveTransfer((prev) =>
            prev?.id === transferId ? { ...prev, status: 'failed' } : prev
          );
        },
      });

      activeSenderRef.current = sender;
      void sender.start();

      // Mark the item in state (pure update) and in the ref mirror so a
      // second processNextQueueItem call in the same tick cannot double-start.
      setSendQueue((q) =>
        q.map((item, idx) =>
          idx === nextIndex && item.id === targetItem.id ? { ...item, status: 'transferring' } : item
        )
      );
      sendQueueRef.current = sendQueueRef.current.map((item, idx) =>
        idx === nextIndex && item.id === targetItem.id ? { ...item, status: 'transferring' } : item
      );
    }
  }, [peerManager, isPeerConnected, cipherRef]);

  useEffect(() => {
    processNextQueueItemRef.current = processNextQueueItem;
  }, [processNextQueueItem]);

  useEffect(() => {
    if (isPeerConnected && !isTransferringRef.current) {
      processNextQueueItem();
    }
  }, [sendQueue, isPeerConnected, processNextQueueItem]);

  // The peer connection dropped (disconnect/failure): abort the in-flight
  // transfer immediately instead of letting the sender keep pushing the
  // remaining file into a dead channel's send buffer. With manual QR pairing
  // there is no ICE restart, so the transfer is genuinely stopped — the UI
  // must say Failed, never Completed.
  const wasConnectedRef = useRef(false);
  useEffect(() => {
    if (isPeerConnected) {
      wasConnectedRef.current = true;
      return;
    }
    if (!wasConnectedRef.current) return;
    wasConnectedRef.current = false;

    const sender = activeSenderRef.current;
    const receiver = receiverEngineRef.current;
    console.debug('[nexdrop] disconnect effect: sender=', sender?.activeTransferId ?? 'none',
      'receiver=', receiver?.activeTransferId ?? 'none');
    if (!sender && !receiver) return;

    activeSenderRef.current = null;
    isTransferringRef.current = false;

    if (sender) {
      void sender.cancel('Connection lost');
    }
    if (receiver) {
      void receiver.cancel('Connection lost');
    }

    // sender.cancel()/receiver.cancel() emit a 'cancelled' progress event
    // synchronously; override it with the truthful failure status after.
    setSendQueue((q) =>
      q.map((item) =>
        item.status === 'transferring' || item.status === 'paused' || item.status === 'cancelled'
          ? { ...item, status: 'failed', error: 'Connection lost during transfer' }
          : item
      )
    );
    setIncomingFiles((q) =>
      q.map((item) =>
        item.status === 'transferring' || item.status === 'paused' || item.status === 'cancelled'
          ? { ...item, status: 'failed' }
          : item
      )
    );
    setActiveTransfer((prev) => (prev ? { ...prev, status: 'failed' } : prev));
  }, [isPeerConnected]);

  // -----------------------------------------------------------------------
  // Public queue operations
  // -----------------------------------------------------------------------

  const addFilesToSend = useCallback((files: FileList | File[]) => {
    const newItems: FileItem[] = Array.from(files).map((file) => ({
      id: randomId(),
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified,
      file,
      status: 'queued',
      progress: 0,
      bytesTransferred: 0,
      speedBps: 0,
      etaSeconds: 0,
      direction: 'outgoing',
    }));
    setSendQueue((prev) => [...prev, ...newItems]);
  }, []);

  const removeSendItem = useCallback((id: string) => {
    setSendQueue((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target?.status === 'transferring' && activeSenderRef.current) {
        activeSenderRef.current.cancel();
        isTransferringRef.current = false;
        activeSenderRef.current = null;
      }
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const reorderSendQueue = useCallback((fromIndex: number, toIndex: number) => {
    setSendQueue((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(fromIndex, 1);
      copy.splice(toIndex, 0, moved);
      return copy;
    });
  }, []);

  const clearCompletedSends = useCallback(() => {
    setSendQueue((prev) =>
      prev.filter((i) => i.status !== 'completed' && i.status !== 'failed')
    );
  }, []);

  const pauseActiveTransfer = useCallback(() => {
    activeSenderRef.current?.pause();
  }, []);

  const resumeActiveTransfer = useCallback(() => {
    activeSenderRef.current?.resume();
  }, []);

  const cancelActiveTransfer = useCallback(() => {
    if (activeSenderRef.current) {
      activeSenderRef.current.cancel();
      isTransferringRef.current = false;
      activeSenderRef.current = null;
    }
    void receiverEngineRef.current?.cancel();
    setActiveTransfer(null);
  }, []);

  return {
    sendQueue,
    incomingFiles,
    activeTransfer,
    addFilesToSend,
    removeSendItem,
    reorderSendQueue,
    clearCompletedSends,
    pauseActiveTransfer,
    resumeActiveTransfer,
    cancelActiveTransfer,
  };
}
