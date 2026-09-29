'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PeerConnectionManager } from '@/lib/webrtc/peer';
import { CompositeSignalingTransport } from '@/lib/signaling/transport';
import { BrowserCapabilities, DeviceInfo } from '@/lib/detection/capabilities';
import { useBrowserCapabilities, useDeviceInfo } from '@/hooks/useCapabilities';
import { deriveSasCode, generateSixDigitPin } from '@/lib/crypto';
import { sounds } from '@/lib/utils/sound';
import {
  subscribeHistory,
  getHistorySnapshot,
  getServerHistorySnapshot,
  addHistoryRecord,
  clearHistoryRecords,
} from '@/lib/storage/history';
import { SessionState, PeerInfo, SignalingMessage, QrPayload } from '@/types/session';
import { ControlMessage, FileItem, TextTransferMessage, ClipboardSyncMessage, LocalHistoryItem } from '@/types/transfer';
import { WebRTCConnectionState } from '@/types/webrtc';

export type { LocalHistoryItem };

async function safeFetchJson<T = any>(
  url: string,
  options?: RequestInit
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options?.headers || {}),
      },
    });

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return {
        ok: false,
        status: res.status,
        data: null,
        error: `Server returned non-JSON response (${res.status})`,
      };
    }

    const data = await res.json().catch(() => null);
    return {
      ok: res.ok && data !== null,
      status: res.status,
      data,
      error: res.ok ? undefined : (data?.error || `Request failed with status ${res.status}`),
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: err?.message || 'Network error',
    };
  }
}

export function useNexDropSession() {
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const detectedDeviceInfo = useDeviceInfo();
  const [customDeviceName, setCustomDeviceName] = useState<string | null>(null);

  const deviceInfo: DeviceInfo = useMemo(() => ({
    ...detectedDeviceInfo,
    name: customDeviceName || detectedDeviceInfo.name,
  }), [detectedDeviceInfo, customDeviceName]);

  const capabilities = useBrowserCapabilities();

  // Active Session details
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null);
  const [securityToken, setSecurityToken] = useState<string | null>(null);
  const [peerInfo, setPeerInfo] = useState<PeerInfo | null>(null);
  const [sasCode, setSasCode] = useState<string>('000 000');
  const [isSecurityVerified, setIsSecurityVerified] = useState<boolean>(false);
  const [qrPayload, setQrPayload] = useState<string>('');
  const [activePeerManager, setActivePeerManager] = useState<PeerConnectionManager | null>(null);
  const [rttMs, setRttMs] = useState<number | null>(null);

  // Messages & Clipboard
  const [textMessages, setTextMessages] = useState<TextTransferMessage[]>([]);
  const [clipboardItems, setClipboardItems] = useState<ClipboardSyncMessage[]>([]);
  const transferHistory = useSyncExternalStore(
    subscribeHistory,
    getHistorySnapshot,
    getServerHistorySnapshot
  );

  // Sound & notification preferences
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [vibrationEnabled, setVibrationEnabled] = useState<boolean>(true);

  // References
  const peerManagerRef = useRef<PeerConnectionManager | null>(null);
  const signalingRef = useRef<CompositeSignalingTransport | null>(null);
  const localPeerIdRef = useRef<string>('');
  const isInitiatorRef = useRef<boolean>(false);

  // Transfer engine event dispatchers
  const onFileChunkCallbackRef = useRef<((chunk: ArrayBuffer) => void) | null>(null);
  const onControlCallbackRef = useRef<((msg: ControlMessage) => void) | null>(null);

  // Initialize peer ID on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localPeerIdRef.current = crypto.randomUUID ? crypto.randomUUID() : `peer_${Date.now()}`;
  }, []);

  const addHistoryItem = useCallback((item: LocalHistoryItem) => {
    addHistoryRecord(item);
  }, []);

  const clearHistory = useCallback(() => {
    clearHistoryRecords();
  }, []);

  // Update sound preference
  const toggleSound = useCallback((val: boolean) => {
    setSoundEnabled(val);
    sounds.setEnabled(val);
    try {
      localStorage.setItem('nexdrop_sound', String(val));
    } catch (e) {}
  }, []);

  const toggleVibration = useCallback((val: boolean) => {
    setVibrationEnabled(val);
    try {
      localStorage.setItem('nexdrop_vibration', String(val));
    } catch (e) {}
  }, []);

  const updateDeviceName = useCallback((newName: string) => {
    setCustomDeviceName(newName);
    try {
      localStorage.setItem('nexdrop_device_name', newName);
    } catch (e) {}
  }, []);

  // Teardown existing peer & signaling
  const cleanup = useCallback(() => {
    if (peerManagerRef.current) {
      peerManagerRef.current.close();
      peerManagerRef.current = null;
    }
    setActivePeerManager(null);
    if (signalingRef.current) {
      signalingRef.current.close();
      signalingRef.current = null;
    }
    setSessionState('idle');
    setSessionId(null);
    setPin(null);
    setSecurityToken(null);
    setPeerInfo(null);
    setIsSecurityVerified(false);
    setQrPayload('');
    setRttMs(null);
  }, []);

  // Handle WebRTC connection state changes
  const handleRtcStateChange = useCallback((rtcState: WebRTCConnectionState) => {
    if (rtcState === 'connected') {
      setSessionState('connected');
      sounds.playConnect();
      if (vibrationEnabled && typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(80);
      }
      // Send metadata over metadata channel
      setTimeout(() => {
        if (peerManagerRef.current) {
          peerManagerRef.current.sendMetadata({
            type: 'PEER_METADATA',
            deviceName: deviceInfo.name,
            platform: `${deviceInfo.os} · ${deviceInfo.browser}`,
            supportsFileSystemAccess: !!capabilities?.fileSystemAccess,
            supportsOpfs: !!capabilities?.opfs,
            version: '1.0.0',
          });
        }
      }, 300);
    } else if (rtcState === 'connecting') {
      setSessionState('connecting');
    } else if (rtcState === 'reconnecting') {
      setSessionState('reconnecting');
    } else if (rtcState === 'disconnected' || rtcState === 'failed') {
      setSessionState('disconnected');
      sounds.playError();
    } else if (rtcState === 'closed') {
      setSessionState('closed');
    }
  }, [deviceInfo, capabilities, vibrationEnabled]);

  // Setup PeerConnection Manager
  const setupPeerManager = useCallback((isInitiator: boolean, activeSessionId: string) => {
    if (peerManagerRef.current) {
      peerManagerRef.current.close();
    }

    const peer = new PeerConnectionManager({
      onStateChange: handleRtcStateChange,
      onControlMessage: (data: any) => {
        if (data.type === 'SECURITY_VERIFY') {
          setIsSecurityVerified(data.verified);
        }
        if (onControlCallbackRef.current) {
          onControlCallbackRef.current(data);
        }
      },
      onFileChunk: (chunk: ArrayBuffer) => {
        if (onFileChunkCallbackRef.current) {
          onFileChunkCallbackRef.current(chunk);
        }
      },
      onClipboardMessage: (data: any) => {
        const item: ClipboardSyncMessage = data;
        setClipboardItems((prev) => [item, ...prev]);
        sounds.playConnect();
      },
      onTextMessage: (data: any) => {
        const msg: TextTransferMessage = data;
        setTextMessages((prev) => [msg, ...prev]);
        sounds.playConnect();
      },
      onMetadataMessage: (data: any) => {
        setPeerInfo((prev) => ({
          id: prev?.id || 'peer',
          name: data.deviceName || 'Connected Device',
          platform: data.platform || 'Unknown',
          connectedAt: Date.now(),
          capabilities: {
            fileSystemAccess: !!data.supportsFileSystemAccess,
            opfs: !!data.supportsOpfs,
            crypto: true,
          },
        }));
      },
      onSignalingCandidate: (candidate: RTCIceCandidate) => {
        if (signalingRef.current) {
          signalingRef.current.send({
            type: 'candidate',
            sessionId: activeSessionId,
            fromPeerId: localPeerIdRef.current,
            payload: candidate.toJSON(),
            timestamp: Date.now(),
          });
        }
      },
      onSignalingOffer: (offer: RTCSessionDescriptionInit) => {
        if (signalingRef.current) {
          signalingRef.current.send({
            type: 'offer',
            sessionId: activeSessionId,
            fromPeerId: localPeerIdRef.current,
            payload: offer,
            timestamp: Date.now(),
          });
        }
      },
      onSignalingAnswer: (answer: RTCSessionDescriptionInit) => {
        if (signalingRef.current) {
          signalingRef.current.send({
            type: 'answer',
            sessionId: activeSessionId,
            fromPeerId: localPeerIdRef.current,
            payload: answer,
            timestamp: Date.now(),
          });
        }
      },
      onRttChange: (ms: number) => {
        setRttMs(ms);
      },
    });

    peer.initialize(isInitiator);
    peerManagerRef.current = peer;
    setActivePeerManager(peer);
    return peer;
  }, [handleRtcStateChange]);

  // Connect Signaling Transport & Listeners
  const setupSignaling = useCallback(async (activeSessionId: string, isInitiator: boolean) => {
    if (signalingRef.current) {
      signalingRef.current.close();
    }

    const signaling = new CompositeSignalingTransport();
    await signaling.connect(activeSessionId, localPeerIdRef.current);
    signalingRef.current = signaling;

    signaling.onMessage(async (msg: SignalingMessage) => {
      const peer = peerManagerRef.current;
      if (!peer) return;

      if (msg.type === 'join' && isInitiatorRef.current) {
        // Remote peer joined! Create offer and initiate WebRTC handshake
        setSessionState('signaling');
        const offer = await peer.createOffer();
        if (offer) {
          await signaling.send({
            type: 'offer',
            sessionId: activeSessionId,
            fromPeerId: localPeerIdRef.current,
            payload: offer,
            timestamp: Date.now(),
          });
        }
      } else if (msg.type === 'offer' && !isInitiatorRef.current) {
        setSessionState('signaling');
        const answer = await peer.handleOffer(msg.payload);
        if (answer) {
          await signaling.send({
            type: 'answer',
            sessionId: activeSessionId,
            fromPeerId: localPeerIdRef.current,
            payload: answer,
            timestamp: Date.now(),
          });
        }
      } else if (msg.type === 'answer' && isInitiatorRef.current) {
        await peer.handleAnswer(msg.payload);
      } else if (msg.type === 'candidate') {
        await peer.addIceCandidate(msg.payload);
      }
    });

    return signaling;
  }, []);

  // 1. Create Session (Initiator / Host)
  const createSession = useCallback(async () => {
    cleanup();
    setSessionState('pairing');
    isInitiatorRef.current = true;

    try {
      // Generate cryptographic session parameters locally first
      // This guarantees instant 0ms feedback and resilience if server is warming up
      const newSessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const newPin = generateSixDigitPin();
      const token = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `tok_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      setSessionId(newSessionId);
      setPin(newPin);
      setSecurityToken(token);

      // Derive Short Authentication String (SAS code)
      const sas = await deriveSasCode(`${newSessionId}:${newPin}`);
      setSasCode(sas);

      // Setup QR payload
      const qrData: QrPayload = {
        v: 1,
        app: 'nexdrop',
        session: newSessionId,
        token,
        pin: newPin,
        name: deviceInfo.name,
      };
      setQrPayload(JSON.stringify(qrData));

      // Setup Peer Connection & Composite Signaling
      setupPeerManager(true, newSessionId);
      await setupSignaling(newSessionId, true);

      // Register session with ephemeral signaling relay asynchronously
      const res = await safeFetchJson<{
        success: boolean;
        sessionId?: string;
        pin?: string;
        token?: string;
      }>('/api/signaling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          sessionId: newSessionId,
          pin: newPin,
          token,
          peerId: localPeerIdRef.current,
        }),
      });

      if (!res.ok) {
        console.warn('Signaling server registration notice (running in direct/local mode):', res.error);
      }
    } catch (err) {
      console.warn('Session setup notice:', err);
    }
  }, [cleanup, deviceInfo.name, setupPeerManager, setupSignaling]);

  // 2. Join Session by 6-digit PIN
  const joinByPin = useCallback(async (inputPin: string): Promise<boolean> => {
    const cleanPin = inputPin.replace(/\s+/g, '').trim();
    if (cleanPin.length !== 6) return false;

    cleanup();
    setSessionState('pairing');
    isInitiatorRef.current = false;

    try {
      const res = await safeFetchJson<{
        success: boolean;
        sessionId?: string;
        pin?: string;
        token?: string;
        peerId?: string;
        error?: string;
      }>('/api/signaling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'join',
          pin: cleanPin,
          peerId: localPeerIdRef.current,
        }),
      });

      if (!res.ok || !res.data?.sessionId) {
        console.warn('Join by PIN failed:', res.error || 'Session not found');
        setSessionState('idle');
        return false;
      }

      const targetSessionId = res.data.sessionId;
      const token = res.data.token || '';

      setSessionId(targetSessionId);
      setPin(cleanPin);
      setSecurityToken(token);

      const sas = await deriveSasCode(`${targetSessionId}:${cleanPin}`);
      setSasCode(sas);

      setupPeerManager(false, targetSessionId);
      const signaling = await setupSignaling(targetSessionId, false);

      // Send join announcement to host
      await signaling.send({
        type: 'join',
        sessionId: targetSessionId,
        fromPeerId: localPeerIdRef.current,
        timestamp: Date.now(),
      });

      return true;
    } catch (err) {
      console.error('Join by PIN failed:', err);
      setSessionState('idle');
      return false;
    }
  }, [cleanup, setupPeerManager, setupSignaling]);

  // 3. Join Session by QR Code Payload or Direct Session ID
  const joinByQrPayload = useCallback(async (payloadString: string): Promise<boolean> => {
    try {
      let parsed: QrPayload | any = null;
      try {
        parsed = JSON.parse(payloadString);
      } catch (e) {
        // Maybe raw PIN was scanned
        if (/^\d{6}$/.test(payloadString.trim())) {
          return joinByPin(payloadString.trim());
        }
        return false;
      }

      if (!parsed || !parsed.session) return false;

      cleanup();
      setSessionState('pairing');
      isInitiatorRef.current = false;

      const targetSessionId = parsed.session;
      const targetPin = parsed.pin || '';
      const token = parsed.token || '';

      const res = await safeFetchJson<{
        success: boolean;
        sessionId?: string;
        pin?: string;
        token?: string;
        peerId?: string;
        error?: string;
      }>('/api/signaling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'join',
          sessionId: targetSessionId,
          pin: targetPin,
          peerId: localPeerIdRef.current,
        }),
      });

      if (!res.ok) {
        console.warn('Signaling server join notice (trying direct/broadcast connection):', res.error);
      }

      const activePin = targetPin || res.data?.pin || null;
      const activeToken = token || res.data?.token || null;

      setSessionId(targetSessionId);
      setPin(activePin);
      setSecurityToken(activeToken);

      const sas = await deriveSasCode(`${targetSessionId}:${activePin || ''}`);
      setSasCode(sas);

      setupPeerManager(false, targetSessionId);
      const signaling = await setupSignaling(targetSessionId, false);

      await signaling.send({
        type: 'join',
        sessionId: targetSessionId,
        fromPeerId: localPeerIdRef.current,
        timestamp: Date.now(),
      });

      return true;
    } catch (err) {
      console.error('Join by QR failed:', err);
      setSessionState('idle');
      return false;
    }
  }, [cleanup, joinByPin, setupPeerManager, setupSignaling]);

  // Send plain text, code, or URL to connected peer
  const sendTextMessage = useCallback((text: string, category: 'plain' | 'code' | 'url' | 'json' = 'plain', lang?: string) => {
    if (!peerManagerRef.current || sessionState !== 'connected') return false;
    const msg: TextTransferMessage = {
      type: 'TEXT_MESSAGE',
      id: crypto.randomUUID ? crypto.randomUUID() : `msg_${Date.now()}`,
      text,
      category,
      language: lang,
      timestamp: Date.now(),
    };

    const sent = peerManagerRef.current.sendText(msg);
    if (sent) {
      setTextMessages((prev) => [msg, ...prev]);
    }
    return sent;
  }, [sessionState]);

  // Send clipboard content
  const sendClipboardItem = useCallback((content: string, category: 'plain' | 'code' | 'url' | 'json' = 'plain') => {
    if (!peerManagerRef.current || sessionState !== 'connected') return false;
    const item: ClipboardSyncMessage = {
      type: 'CLIPBOARD_SYNC',
      id: crypto.randomUUID ? crypto.randomUUID() : `clip_${Date.now()}`,
      content,
      category,
      timestamp: Date.now(),
    };

    const sent = peerManagerRef.current.sendClipboard(item);
    if (sent) {
      setClipboardItems((prev) => [item, ...prev]);
    }
    return sent;
  }, [sessionState]);

  // Confirm SAS security code with peer
  const verifySasSecurityCode = useCallback((verified: boolean) => {
    setIsSecurityVerified(verified);
    if (peerManagerRef.current) {
      peerManagerRef.current.sendControl({
        type: 'SECURITY_VERIFY',
        sasCode,
        verified,
      });
    }
  }, [sasCode]);

  return {
    sessionState,
    sessionId,
    pin,
    securityToken,
    peerInfo,
    sasCode,
    isSecurityVerified,
    qrPayload,
    deviceInfo,
    capabilities,
    textMessages,
    clipboardItems,
    transferHistory,
    soundEnabled,
    vibrationEnabled,
    rttMs,
    peerManager: activePeerManager,
    createSession,
    joinByPin,
    joinByQrPayload,
    verifySasSecurityCode,
    sendTextMessage,
    sendClipboardItem,
    addHistoryItem,
    clearHistory,
    toggleSound,
    toggleVibration,
    updateDeviceName,
    disconnect: cleanup,
    onFileChunkCallbackRef,
    onControlCallbackRef,
  };
}
