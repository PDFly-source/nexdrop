'use client';

/**
 * useNexDropSession — manual, server-less WebRTC pairing orchestration.
 *
 * Flow (NO signaling server, NO database, NO accounts):
 *
 * HOST (Create pairing):
 *   1. ECDH keypair + RTCPeerConnection + offer
 *   2. Wait for ICE gathering → SDP contains all candidates
 *   3. Build compact pairing code → show as QR (or copy/paste)
 *   4. Scan/paste the joiner's answer QR
 *   5. acceptAnswer → DataChannels open → 'connected'
 *
 * JOINER (Join pairing):
 *   1. Scan/paste the host's offer QR
 *   2. ECDH keypair + setRemoteDescription + answer
 *   3. Wait for ICE gathering → build answer pairing code → show as QR
 *   4. When the host applies the answer, DataChannels open → 'connected'
 *
 * Both sides derive the same AES-256-GCM session key and the same 6-digit
 * SAS verification code from the ECDH shared secret.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PeerConnectionManager } from '@/lib/webrtc/peer';
import { BrowserCapabilities, DeviceInfo } from '@/lib/detection/capabilities';
import { useBrowserCapabilities, useDeviceInfo } from '@/hooks/useCapabilities';
import {
  createChunkCipher,
  deriveSessionCipherSalt,
  deriveSasCode,
  deriveSessionAesKey,
  deriveSharedBits,
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  importPublicKeyRaw,
  randomId,
  computeSha256Base64Url,
  ChunkCipher,
} from '@/lib/crypto';
import { buildPairingCode, parsePairingCode, segmentPairingCode, toPairingError } from '@/lib/pairing/payload';
import { sounds } from '@/lib/utils/sound';
import {
  subscribeHistory,
  getHistorySnapshot,
  getServerHistorySnapshot,
  addHistoryRecord,
  clearHistoryRecords,
} from '@/lib/storage/history';
import {
  SessionState,
  PeerInfo,
  PairingError,
} from '@/types/session';
import {
  ControlMessage,
  FileItem,
  TextTransferMessage,
  ClipboardSyncMessage,
  LocalHistoryItem,
} from '@/types/transfer';

export type { LocalHistoryItem };

export interface PairingQr {
  /** Full pairing code (used for copy/paste fallback and invite links). */
  code: string;
  /** Short human-readable session ID shown on both pairing screens. */
  sessionId: string;
  /** Segments to render as QR codes (1 for most cases). */
  segments: { index: number; total: number; text: string }[];
}

export function useNexDropSession() {
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const detectedDeviceInfo = useDeviceInfo();
  const [customDeviceName, setCustomDeviceName] = useState<string | null>(() => {
    try {
      return localStorage.getItem('nexdrop_device_name');
    } catch {
      return null;
    }
  });

  const deviceInfo: DeviceInfo = useMemo(
    () => ({ ...detectedDeviceInfo, name: customDeviceName || detectedDeviceInfo.name }),
    [detectedDeviceInfo, customDeviceName]
  );

  const capabilities = useBrowserCapabilities();

  // Session details
  const [peerInfo, setPeerInfo] = useState<PeerInfo | null>(null);
  const [sasCode, setSasCode] = useState<string | null>(null);
  const [isSecurityVerified, setIsSecurityVerified] = useState<boolean>(false);
  const [offerQr, setOfferQr] = useState<PairingQr | null>(null);
  const [answerQr, setAnswerQr] = useState<PairingQr | null>(null);
  const [pairingError, setPairingError] = useState<PairingError | string | null>(null);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [activePeerManager, setActivePeerManager] = useState<PeerConnectionManager | null>(null);

  // Messages & Clipboard
  const [textMessages, setTextMessages] = useState<TextTransferMessage[]>([]);
  const [clipboardItems, setClipboardItems] = useState<ClipboardSyncMessage[]>([]);

  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('nexdrop_sound') !== 'false';
    } catch {
      return true;
    }
  });
  const [vibrationEnabled, setVibrationEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('nexdrop_vibration') !== 'false';
    } catch {
      return true;
    }
  });

  // Refs
  const peerManagerRef = useRef<PeerConnectionManager | null>(null);
  const keyPairRef = useRef<CryptoKeyPair | null>(null);
  const offerCodeRef = useRef<string | null>(null);
  const cipherRef = useRef<ChunkCipher | null>(null);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Transfer engine event dispatchers
  const onFileChunkCallbackRef = useRef<((chunk: ArrayBuffer) => void) | null>(null);
  const onControlCallbackRef = useRef<((msg: ControlMessage) => void) | null>(null);

  const transferHistory = useSyncExternalStore(
    subscribeHistory,
    getHistorySnapshot,
    getServerHistorySnapshot
  );

  const addHistoryItem = useCallback((item: LocalHistoryItem) => {
    addHistoryRecord(item);
  }, []);

  const clearHistory = useCallback(() => {
    clearHistoryRecords();
  }, []);

  const toggleSound = useCallback((val: boolean) => {
    setSoundEnabled(val);
    sounds.setEnabled(val);
    try {
      localStorage.setItem('nexdrop_sound', String(val));
    } catch {
      // ignore
    }
  }, []);

  const toggleVibration = useCallback((val: boolean) => {
    setVibrationEnabled(val);
    try {
      localStorage.setItem('nexdrop_vibration', String(val));
    } catch {
      // ignore
    }
  }, []);

  const updateDeviceName = useCallback((newName: string) => {
    setCustomDeviceName(newName);
    try {
      localStorage.setItem('nexdrop_device_name', newName);
    } catch {
      // ignore
    }
  }, []);

  // Keep the sound engine in sync with the persisted preference
  useEffect(() => {
    sounds.setEnabled(soundEnabled);
  }, [soundEnabled]);

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  const cleanup = useCallback(() => {
    if (expiryTimerRef.current) {
      clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
    if (peerManagerRef.current) {
      peerManagerRef.current.close();
      peerManagerRef.current = null;
    }
    setActivePeerManager(null);
    keyPairRef.current = null;
    offerCodeRef.current = null;
    cipherRef.current = null;
    setSessionState('idle');
    setPeerInfo(null);
    setSasCode(null);
    setIsSecurityVerified(false);
    setOfferQr(null);
    setAnswerQr(null);
    setPairingError(null);
    setRttMs(null);
  }, []);

  useEffect(() => {
    return () => {
      peerManagerRef.current?.close();
    };
  }, []);

  // -----------------------------------------------------------------------
  // Peer manager setup
  // -----------------------------------------------------------------------

  const buildPeerManager = useCallback((): PeerConnectionManager => {
    peerManagerRef.current?.close();

    const peer = new PeerConnectionManager({
      onStateChange: (rtcState) => {
        switch (rtcState) {
          case 'connected':
            setSessionState('connected');
            sounds.playConnect();
            if (vibrationEnabled && typeof navigator !== 'undefined' && navigator.vibrate) {
              navigator.vibrate(80);
            }
            // Exchange device metadata over the control channel
            setTimeout(() => {
              peerManagerRef.current?.sendMetadata({
                type: 'PEER_METADATA',
                deviceName: deviceInfo.name,
                platform: `${deviceInfo.os} · ${deviceInfo.browser}`,
                supportsFileSystemAccess: !!capabilities?.fileSystemAccess,
                supportsOpfs: !!capabilities?.opfs,
                version: '1.0.0',
              });
            }, 300);
            break;
          case 'connecting':
          case 'new':
          case 'gathering':
            setSessionState((prev) =>
              prev === 'connected' ? prev : 'connecting'
            );
            break;
          case 'disconnected':
            setSessionState('disconnected');
            sounds.playError();
            break;
          case 'failed':
            setSessionState('failed');
            setPairingError(
              'Direct connection failed. Both devices must be online with a working network path between them.'
            );
            sounds.playError();
            break;
          case 'closed':
            setSessionState((prev) => (prev === 'connected' ? 'closed' : 'idle'));
            break;
          default:
            break;
        }
      },
      onControlMessage: (data) => {
        if (data.type === 'SECURITY_VERIFY') {
          setIsSecurityVerified(data.verified);
        } else if (data.type === 'PEER_METADATA') {
          setPeerInfo((prev) => ({
            id: prev?.id || 'peer',
            name: data.deviceName || 'Connected Device',
            platform: data.platform || 'Unknown',
            connectedAt: prev?.connectedAt || Date.now(),
            capabilities: {
              fileSystemAccess: !!data.supportsFileSystemAccess,
              opfs: !!data.supportsOpfs,
              crypto: true,
            },
          }));
        }
        onControlCallbackRef.current?.(data);
      },
      onFileChunk: (chunk) => {
        onFileChunkCallbackRef.current?.(chunk);
      },
      onClipboardMessage: (item: ClipboardSyncMessage) => {
        setClipboardItems((prev) => [item, ...prev]);
        sounds.playConnect();
      },
      onTextMessage: (msg: TextTransferMessage) => {
        setTextMessages((prev) => [msg, ...prev]);
        sounds.playConnect();
      },
      onRttChange: (ms) => setRttMs(ms),
    });

    peerManagerRef.current = peer;
    setActivePeerManager(peer);
    return peer;
  }, [capabilities, deviceInfo, vibrationEnabled]);

  /** Derive session cipher + SAS from local private key & remote public key. */
  const establishSessionKeys = useCallback(async (remotePubRaw: ArrayBuffer) => {
    if (!keyPairRef.current) throw new Error('no-keypair');
    const remotePub = await importPublicKeyRaw(remotePubRaw);
    const sharedBits = await deriveSharedBits(keyPairRef.current.privateKey, remotePub);
    const aesKey = await deriveSessionAesKey(sharedBits);
    const salt = await deriveSessionCipherSalt(sharedBits);
    cipherRef.current = await createChunkCipher(aesKey, salt);
    const sas = await deriveSasCode(sharedBits);
    setSasCode(sas);
    setIsSecurityVerified(false);
  }, []);

  const schedulePairingExpiry = useCallback(() => {
    if (expiryTimerRef.current) clearTimeout(expiryTimerRef.current);
    expiryTimerRef.current = setTimeout(() => {
      // Pairing payloads expire after 10 minutes
      setPairingError('timeout');
      peerManagerRef.current?.close();
      setSessionState('failed');
    }, 10 * 60 * 1000 + 2000);
  }, []);

  // -----------------------------------------------------------------------
  // HOST: create pairing (offer)
  // -----------------------------------------------------------------------

  const createPairing = useCallback(async (): Promise<boolean> => {
    if (typeof RTCPeerConnection === 'undefined') {
      setPairingError('unsupported-browser');
      setSessionState('failed');
      return false;
    }

    cleanup();
    setPairingError(null);
    setTextMessages([]);
    setClipboardItems([]);

    try {
      const keyPair = await generateEcdhKeyPair();
      keyPairRef.current = keyPair;

      const peer = buildPeerManager();
      peer.initialize(true);

      const localDesc = await peer.createOfferAndWaitForIce();
      const code = await buildPairingCode({
        kind: 'offer',
        sdp: localDesc.sdp || '',
        publicKey: await exportPublicKeyRaw(keyPair.publicKey),
      });
      offerCodeRef.current = code;

      const segId = randomId().slice(0, 8);
      setOfferQr({
        code,
        sessionId: segId.toUpperCase(),
        segments: segmentPairingCode(code, segId),
      });
      setSessionState('hosting-offer');
      schedulePairingExpiry();
      return true;
    } catch (err: any) {
      const pe = toPairingError(err);
      setPairingError(pe || err?.message || 'Could not create the pairing offer.');
      setSessionState('failed');
      return false;
    }
  }, [buildPeerManager, cleanup, schedulePairingExpiry]);

  // -----------------------------------------------------------------------
  // HOST: apply the scanned/pasted answer
  // -----------------------------------------------------------------------

  const submitAnswer = useCallback(
    async (answerCode: string): Promise<boolean> => {
      if (!peerManagerRef.current || !keyPairRef.current) {
        setPairingError('invalid-format');
        return false;
      }

      try {
        const parsed = await parsePairingCode(answerCode);
        if (parsed.kind !== 'answer') {
          setPairingError('not-answer');
          return false;
        }
        if (offerCodeRef.current) {
          const expectedAck = await computeSha256Base64Url(offerCodeRef.current);
          if (parsed.ackOfOffer !== expectedAck) {
            // The answer belongs to a different offer — refuse it.
            setPairingError('wrong-session');
            return false;
          }
        }

        await establishSessionKeys(parsed.peerPublicKey);
        await peerManagerRef.current.acceptAnswer(parsed.sdp);
        setSessionState('connecting');
        return true;
      } catch (err: any) {
        const pe = toPairingError(err);
        setPairingError(pe || err?.message || 'The answer code was invalid.');
        return false;
      }
    },
    [establishSessionKeys]
  );

  // -----------------------------------------------------------------------
  // JOINER: scan/paste an offer, produce the answer
  // -----------------------------------------------------------------------

  const joinWithOffer = useCallback(
    async (offerCode: string): Promise<boolean> => {
      if (typeof RTCPeerConnection === 'undefined') {
        setPairingError('unsupported-browser');
        setSessionState('failed');
        return false;
      }

      cleanup();
      setPairingError(null);
      setTextMessages([]);
      setClipboardItems([]);

      try {
        const parsed = await parsePairingCode(offerCode);
        if (parsed.kind !== 'offer') {
          setPairingError('not-offer');
          setSessionState('failed');
          return false;
        }

        const keyPair = await generateEcdhKeyPair();
        keyPairRef.current = keyPair;

        const peer = buildPeerManager();
        peer.initialize(false);

        const localDesc = await peer.acceptOfferAndWaitForIce(parsed.sdp);

        // Bind the answer to this exact offer via an ack of the offer code
        const ack = await computeSha256Base64Url(offerCode.trim());
        const code = await buildPairingCode({
          kind: 'answer',
          sdp: localDesc.sdp || '',
          publicKey: await exportPublicKeyRaw(keyPair.publicKey),
          ackOfOffer: ack,
        });

        await establishSessionKeys(parsed.peerPublicKey);

        const answerSegId = randomId().slice(0, 8);
        setAnswerQr({
          code,
          sessionId: answerSegId.toUpperCase(),
          segments: segmentPairingCode(code, answerSegId),
        });
        setSessionState('joiner-answer');
        schedulePairingExpiry();
        return true;
      } catch (err: any) {
        const pe = toPairingError(err);
        setPairingError(pe || err?.message || 'The offer code was invalid or expired.');
        setSessionState('failed');
        return false;
      }
    },
    [buildPeerManager, cleanup, establishSessionKeys, schedulePairingExpiry]
  );

  // -----------------------------------------------------------------------
  // Messaging (real DataChannel sends — no fakes)
  // -----------------------------------------------------------------------

  const sendTextMessage = useCallback(
    (text: string, category: 'plain' | 'code' | 'url' | 'json' = 'plain', lang?: string) => {
      const peer = peerManagerRef.current;
      if (!peer || !peer.isConnected()) return false;
      const msg: TextTransferMessage = {
        type: 'TEXT_MESSAGE',
        id: randomId(),
        text,
        category,
        language: lang,
        timestamp: Date.now(),
      };
      const sent = peer.sendText(msg);
      if (sent) setTextMessages((prev) => [msg, ...prev]);
      return sent;
    },
    []
  );

  const sendClipboardItem = useCallback(
    (content: string, category: 'plain' | 'code' | 'url' | 'json' = 'plain') => {
      const peer = peerManagerRef.current;
      if (!peer || !peer.isConnected()) return false;
      const item: ClipboardSyncMessage = {
        type: 'CLIPBOARD_SYNC',
        id: randomId(),
        content,
        category,
        timestamp: Date.now(),
      };
      const sent = peer.sendClipboard(item);
      if (sent) setClipboardItems((prev) => [item, ...prev]);
      return sent;
    },
    []
  );

  const verifySasSecurityCode = useCallback(
    (verified: boolean) => {
      setIsSecurityVerified(verified);
      peerManagerRef.current?.sendControl({
        type: 'SECURITY_VERIFY',
        sasCode: sasCode || '',
        verified,
      });
    },
    [sasCode]
  );

  const sendPeerCapabilities = useCallback((caps: BrowserCapabilities) => {
    peerManagerRef.current?.sendMetadata({
      type: 'PEER_METADATA',
      deviceName: deviceInfo.name,
      platform: `${deviceInfo.os} · ${deviceInfo.browser}`,
      supportsFileSystemAccess: !!caps.fileSystemAccess,
      supportsOpfs: !!caps.opfs,
      version: '1.0.0',
    });
  }, [deviceInfo]);

  return {
    sessionState,
    transferHistory,
    peerInfo,
    sasCode,
    isSecurityVerified,
    offerQr,
    answerQr,
    pairingError,
    deviceInfo,
    capabilities,
    textMessages,
    clipboardItems,
    soundEnabled,
    vibrationEnabled,
    rttMs,
    peerManager: activePeerManager,
    cipher: cipherRef,
    createPairing,
    submitAnswer,
    joinWithOffer,
    verifySasSecurityCode,
    sendTextMessage,
    sendClipboardItem,
    sendPeerCapabilities,
    addHistoryItem,
    clearHistory,
    toggleSound,
    toggleVibration,
    updateDeviceName,
    setPairingError,
    disconnect: cleanup,
    onFileChunkCallbackRef,
    onControlCallbackRef,
  };
}
