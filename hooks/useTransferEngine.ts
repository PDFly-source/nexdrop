'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SenderEngine, SenderProgress } from '@/lib/transfer/sender';
import { ReceiverEngine, ReceiverProgress } from '@/lib/transfer/receiver';
import { ControlMessage, FileItem } from '@/types/transfer';
import { PeerConnectionManager } from '@/lib/webrtc/peer';
import { sounds } from '@/lib/utils/sound';

export function useTransferEngine(
  peerManager: PeerConnectionManager | null,
  isPeerConnected: boolean,
  onFileChunkCallbackRef: React.MutableRefObject<((chunk: ArrayBuffer) => void) | null>,
  onControlCallbackRef: React.MutableRefObject<((msg: ControlMessage) => void) | null>,
  onTransferComplete?: (item: { name: string; size: number; direction: 'sent' | 'received'; hashVerified?: boolean }) => void
) {
  // Outgoing send queue
  const [sendQueue, setSendQueue] = useState<FileItem[]>([]);
  // Incoming received files list
  const [incomingFiles, setIncomingFiles] = useState<FileItem[]>([]);
  // Active in-progress transfer (either sending or receiving)
  const [activeTransfer, setActiveTransfer] = useState<{
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
  } | null>(null);

  const activeSenderRef = useRef<SenderEngine | null>(null);
  const receiverEngineRef = useRef<ReceiverEngine | null>(null);
  const isTransferringRef = useRef<boolean>(false);

  // Initialize Receiver Engine
  useEffect(() => {
    receiverEngineRef.current = new ReceiverEngine({
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
        setActiveTransfer((prev) => (prev?.id === p.transferId ? { ...prev, status: 'completed', progress: 100 } : prev));
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
                }
              : item
          )
        );

        if (onTransferComplete) {
          onTransferComplete({
            name: p.name,
            size: p.size,
            direction: 'received',
            hashVerified: p.hashVerified,
          });
        }
      },
      onError: (transferId: string, err: string) => {
        sounds.playError();
        setActiveTransfer((prev) => (prev?.id === transferId ? { ...prev, status: 'failed' } : prev));
        setIncomingFiles((prev) =>
          prev.map((item) => (item.id === transferId ? { ...item, status: 'failed', error: err } : item))
        );
      },
      sendControlMessage: (msg: any) => {
        return peerManager ? peerManager.sendControl(msg) : false;
      },
    });
  }, [peerManager, onTransferComplete]);

  // Hook up incoming WebRTC events
  useEffect(() => {
    onFileChunkCallbackRef.current = (chunk: ArrayBuffer) => {
      if (receiverEngineRef.current) {
        receiverEngineRef.current.handleChunk(chunk);
      }
    };

    onControlCallbackRef.current = (msg: ControlMessage) => {
      if (msg.type === 'FILE_START') {
        // Register incoming file
        const newIncoming: FileItem = {
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
        };

        setIncomingFiles((prev) => [newIncoming, ...prev]);
        if (receiverEngineRef.current) {
          receiverEngineRef.current.startTransfer(msg);
        }
      } else if (msg.type === 'ACK') {
        if (activeSenderRef.current) {
          activeSenderRef.current.handleAck(msg.index);
        }
      } else if (msg.type === 'FILE_END') {
        if (receiverEngineRef.current) {
          receiverEngineRef.current.finishTransfer(msg);
        }
      } else if (msg.type === 'CANCEL') {
        if (activeSenderRef.current) {
          activeSenderRef.current.cancel(msg.reason);
        }
        if (receiverEngineRef.current) {
          receiverEngineRef.current.cancel(msg.reason);
        }
      }
    };

    return () => {
      onFileChunkCallbackRef.current = null;
      onControlCallbackRef.current = null;
    };
  }, [onFileChunkCallbackRef, onControlCallbackRef]);

  const processNextQueueItemRef = useRef<() => void>(() => {});

  // Process next file in queue
  const processNextQueueItem = useCallback(async () => {
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
        onCompleted: (transferId: string, hash?: string) => {
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
                    integrityVerified: true,
                    completedAt: Date.now(),
                  }
                : item
            )
          );

          if (onTransferComplete) {
            onTransferComplete({
              name: targetItem.name,
              size: targetItem.size,
              direction: 'sent',
              hashVerified: true,
            });
          }

          // Trigger next item in queue after short settle delay
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
          setActiveTransfer((prev) => (prev?.id === transferId ? { ...prev, status: 'failed' } : prev));
        },
      });

      activeSenderRef.current = sender;
      sender.start();

      return currentQueue.map((item, idx) => (idx === nextIndex ? { ...item, status: 'transferring' } : item));
    });
  }, [peerManager, isPeerConnected, onTransferComplete]);

  useEffect(() => {
    processNextQueueItemRef.current = processNextQueueItem;
  }, [processNextQueueItem]);

  // Trigger queue processing when queue changes or connection opens
  useEffect(() => {
    if (isPeerConnected && !isTransferringRef.current) {
      processNextQueueItem();
    }
  }, [sendQueue, isPeerConnected, processNextQueueItem]);

  // Enqueue new files
  const addFilesToSend = useCallback((files: FileList | File[]) => {
    const newItems: FileItem[] = Array.from(files).map((file) => ({
      id: crypto.randomUUID ? crypto.randomUUID() : `file_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
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

  // Remove file from send queue
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

  // Reorder send queue items
  const reorderSendQueue = useCallback((fromIndex: number, toIndex: number) => {
    setSendQueue((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(fromIndex, 1);
      copy.splice(toIndex, 0, moved);
      return copy;
    });
  }, []);

  // Clear completed send items
  const clearCompletedSends = useCallback(() => {
    setSendQueue((prev) => prev.filter((i) => i.status !== 'completed' && i.status !== 'failed'));
  }, []);

  // Pause active sender
  const pauseActiveTransfer = useCallback(() => {
    if (activeSenderRef.current) {
      activeSenderRef.current.pause();
    }
  }, []);

  // Resume active sender
  const resumeActiveTransfer = useCallback(() => {
    if (activeSenderRef.current) {
      activeSenderRef.current.resume();
    }
  }, []);

  // Cancel active transfer
  const cancelActiveTransfer = useCallback(() => {
    if (activeSenderRef.current) {
      activeSenderRef.current.cancel();
      isTransferringRef.current = false;
      activeSenderRef.current = null;
    }
    if (receiverEngineRef.current) {
      receiverEngineRef.current.cancel();
    }
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
