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
        onTransferComplete?.({
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
  }, [peerManager, cipherRef, onTransferComplete]);

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

      switch (msg.type) {
        case 'FILE_START':
          if (!receiver) return;
          setIncomingFiles((prev) => [
            {
              id: msg.transferId,
              name: msg.name,
              size: msg.size,
              type: msg.mime,
              status: 'transferring',
              progress: 0,
              bytesTransferred: 0,
              speedBps: 0,
              etaSeconds: 0,
              direction: 'incoming',
              startedAt: Date.now(),
            },
            ...prev,
          ]);
          void receiver.startTransfer(msg);
          break;

        case 'ACK':
          sender?.handleAck(msg.index);
          break;

        case 'FILE_END':
          void receiver?.finishTransfer(msg);
          break;

        case 'PAUSE':
          receiver?.handlePause(msg as FilePauseMessage);
          break;

        case 'RESUME':
          receiver?.handleResume(msg as FileResumeMessage);
          break;

        case 'CANCEL':
          if (msg.transferId) {
            sender?.cancel(msg.reason || 'Cancelled by peer');
            void receiver?.cancel(msg.reason || 'Cancelled by peer');
          } else {
            // Session-level cancel
            sender?.cancel('Session cancelled by peer');
            void receiver?.cancel('Session cancelled by peer');
          }
          isTransferringRef.current = false;
          setActiveTransfer((prev) =>
            prev ? { ...prev, status: 'cancelled' } : prev
          );
          break;

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

  const processNextQueueItem = useCallback(() => {
    if (isTransferringRef.current || !peerManager || !isPeerConnected) return;

    setSendQueue((currentQueue) => {
      const nextIndex = currentQueue.findIndex((item) => item.status === 'queued');
      if (nextIndex === -1) return currentQueue;

      const targetItem = currentQueue[nextIndex];
      if (!targetItem.file) return currentQueue;

      const fileChannel = peerManager.getChannel('file');
      if (!fileChannel || fileChannel.readyState !== 'open') {
        return currentQueue;
      }

      isTransferringRef.current = true;

      const sender = new SenderEngine({
        file: targetItem.file,
        transferId: targetItem.id,
        fileChannel,
        sendControlMessage: (msg: any) => peerManager.sendControl(msg),
        cipher: cipherRef.current,
        onProgress: (p: SenderProgress) => {
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

          onTransferComplete?.({
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

      return currentQueue.map((item, idx) =>
        idx === nextIndex ? { ...item, status: 'transferring' } : item
      );
    });
  }, [peerManager, isPeerConnected, cipherRef, onTransferComplete]);

  useEffect(() => {
    processNextQueueItemRef.current = processNextQueueItem;
  }, [processNextQueueItem]);

  useEffect(() => {
    if (isPeerConnected && !isTransferringRef.current) {
      processNextQueueItem();
    }
  }, [sendQueue, isPeerConnected, processNextQueueItem]);

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
