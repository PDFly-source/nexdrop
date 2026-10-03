'use client';

/**
 * useNexDropSession — WebRTC pairing orchestration for BOTH pairing paths.
 *
 * AUTOMATIC one-scan path (primary): the host publishes a short-lived
 * session on the ephemeral signaling service and shows ONE QR (session id +
 * single-use join token + endpoint — no SDP/ICE/key material). The joiner
 * scans it once and files a join request; the HOST decides (Accept /
 * Decline). On Accept the SDP offer/answer and ICE candidates are exchanged
 * automatically through the service and the DataChannels open — no second
 * QR, no answer code, ever.
 *
 * MANUAL path (fallback when the signaling service is unreachable):
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
 * No database, no accounts. Files and text travel only over the direct
 * peer connection; the signaling service only carries connection
 * establishment metadata. Both sides derive the same AES-256-GCM session
 * key and the same 6-digit SAS verification code from the ECDH shared
 * secret.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PeerConnectionManager } from '@/lib/webrtc/peer';
import { ConnectionPhase, TransferActivity, TransferDirection } from '@/types/session';
import { sampleTransportStats } from '@/lib/transfer/transportStats';
import { updateTransportTelemetry, updateDataChannelState } from '@/lib/transfer/telemetry';
import { BrowserCapabilities, DeviceInfo } from '@/lib/detection/capabilities';
import { useBrowserCapabilities, useDeviceInfo } from '@/hooks/useCapabilities';
import {
  createChunkCipher,
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
import { buildSignalQr, isSignalQr, parseSignalQr } from '@/lib/pairing/signalPayload';
import { SignalingClient, SignalingError, SIGNALING_ENDPOINT } from '@/lib/signaling/client';
import { bytesToBase64Url, base64UrlToBytes } from '@/lib/crypto';
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

/** Short, honest label of this device for the remote accept screen.
 * Only what the browser actually reports — no invented model info. */
function buildDeviceLabel(info: DeviceInfo): string {
  const uaData = typeof navigator !== 'undefined' ? (navigator as any).userAgentData : null;
  const platform = (uaData?.platform as string) || info.os || 'Unknown device';
  return `NexDrop · ${platform}`.slice(0, 48);
}

export function useNexDropSession() {
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  /** REAL engine activity — the second input of the authoritative phase. */
  const [transferActivity, setTransferActivityState] = useState<TransferActivity>({
    active: false,
    direction: null,
    verifying: false,
  });
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
  /** Joiner side: the scanned, validated offer/session awaiting Accept. */
  const [pendingOfferInfo, setPendingOfferInfo] = useState<{
    device?: string;
    expiresAt: number;
    platform?: string | null;
    fileCount?: number | null;
    totalBytes?: number | null;
    connectionType?: string | null;
  } | null>(null);
  const pendingOfferRef = useRef<{ code: string; peerPublicKey: ArrayBuffer; sdp: string; expiresAt: number } | null>(null);
  const [answerQr, setAnswerQr] = useState<PairingQr | null>(null);
  const [pairingError, setPairingError] = useState<PairingError | string | null>(null);
  /** 'signal' = one-scan automatic pairing; 'manual' = legacy code flow. */
  const [pairingMode, setPairingMode] = useState<'signal' | 'manual' | null>(null);
  /** Wall-clock ms when the active pairing session expires (null = none). */
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number | null>(null);
  /** HOST-side signaling session (kept in a ref — never re-rendered). */
  const signalHostRef = useRef<{
    hostToken: string;
    joinToken: string;
    sessionId: string;
    expiresAt: number;
    endpoint: string;
  } | null>(null);
  const pairingGenerationRef = useRef(0);
  const sendFirstHostRef = useRef(false);
  const receiverConsentRef = useRef(false);
  const signalPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const signalAnswerAppliedRef = useRef(false);
  /** JOINER-side validated signaling session awaiting consent. */
  const pendingSignalRef = useRef<{
    joinToken: string;
    endpoint: string;
    expiresAt: number;
  } | null>(null);
  const [signalUnavailable, setSignalUnavailable] = useState(false);
  /** HOST signal mode: joiner tapped Accept — answer is on its way. */
  const [signalJoinerAccepted, setSignalJoinerAccepted] = useState(false);
  /** HOST signal mode: the pending join request the host must Accept/Decline. */
  const [joinRequestInfo, setJoinRequestInfo] = useState<{ deviceName: string; platform: string | null } | null>(null);
  /** JOINER signal mode: the answer build is in flight (one-shot poll guard). */
  const joinerBuildingRef = useRef(false);
  /** Single-flight guard for the joiner's pollJoin loop (1.2 s interval,
   *  slow network): an overlapping in-flight poll could resolve AFTER the
   *  session was consumed/destroyed and return 404, killing a connection
   *  that had actually opened. One request at a time, and a late 404 must
   *  never abort an answer that is already in flight. */
  const joinerPollingRef = useRef(false);
  /** HOST signal mode: request card shown once (notification guard). */
  const joinRequestShownRef = useRef(false);
  const [rttMs, setRttMs] = useState<number | null>(null);
  /** REAL selected ICE path from getStats (1 Hz): 'relay' when a TURN relay
   *  carries the traffic, 'direct' for host/srflx paths. The UI must never
   *  claim P2P for a relayed connection. */
  const [transportKind, setTransportKind] = useState<'local' | 'internet' | 'relay' | 'unknown'>('unknown');
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

  /** base64url public key string → raw ArrayBuffer (for importPublicKeyRaw). */
  const pubKeyBytes = (b64: string): ArrayBuffer => {
    const bytes = base64UrlToBytes(b64);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  };

  const stopSignalPolling = useCallback(() => {
    if (signalPollRef.current) {
      clearInterval(signalPollRef.current);
      signalPollRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    pairingGenerationRef.current++;
    sendFirstHostRef.current = false;
    receiverConsentRef.current = false;
    const host = signalHostRef.current;
    if (host) void new SignalingClient(host.endpoint).hostDecline(host.hostToken).catch(() => {});
    if (expiryTimerRef.current) {
      clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
    stopSignalPolling();
    signalHostRef.current = null;
    pendingSignalRef.current = null;
    signalAnswerAppliedRef.current = false;
    setSignalUnavailable(false);
    setPairingMode(null);
    if (peerManagerRef.current) {
      peerManagerRef.current.close();
      peerManagerRef.current = null;
    }
    setActivePeerManager(null);
    keyPairRef.current = null;
    offerCodeRef.current = null;
    pendingOfferRef.current = null;
    setPendingOfferInfo(null);
    cipherRef.current = null;
    setSessionState('idle');
    setTransferActivityState({ active: false, direction: null, verifying: false });
    setPeerInfo(null);
    setSasCode(null);
    setIsSecurityVerified(false);
    setOfferQr(null);
    setAnswerQr(null);
    setPairingError(null);
    setRttMs(null);
    setTransportKind('unknown');
    setSignalJoinerAccepted(false);
    setJoinRequestInfo(null);
    joinerBuildingRef.current = false;
    joinerPollingRef.current = false;
    joinRequestShownRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            // The pairing handshake is complete — disarm the 10-minute
            // offer/answer expiry. Previously this timer kept running after
            // a successful connect and killed live sessions (state flipped
            // to failed mid-transfer) exactly 10 minutes after pairing was
            // created. From here the session lifetime is governed by the
            // DataChannel / ICE states below.
            if (expiryTimerRef.current) {
              clearTimeout(expiryTimerRef.current);
              expiryTimerRef.current = null;
            }
            // Signaling-mode pairing: the DataChannel is open — tell the
            // signaling service to DESTROY the session record immediately.
            stopSignalPolling();
            {
              const host = signalHostRef.current;
              const pending = pendingSignalRef.current;
              signalHostRef.current = null;
              pendingSignalRef.current = null;
              if (host) {
                new SignalingClient(host.endpoint)
                  .reportConnected({ joinToken: host.joinToken })
                  .catch(() => {});
              } else if (pending) {
                new SignalingClient(pending.endpoint)
                  .reportConnected({ joinToken: pending.joinToken })
                  .catch(() => {});
              }
            }
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
            // NEVER clobber an active pairing screen: the host stays on
            // hosting (showing the offer QR / the join-request card) and
            // the joiner stays on waiting-for-join while their
            // RTCPeerConnection legitimately cycles through
            // new/gathering/connecting during ICE. The UI state machine
            // must not allow impossible states (pairing screen vanished).
            setSessionState((prev) =>
              prev === 'connected' ||
              prev === 'transferring' ||
              prev === 'completed' ||
              prev === 'hosting' ||
              prev === 'hosting-offer' ||
              prev === 'join-requested' ||
              prev === 'accepted' ||
              prev === 'waiting-for-join' ||
              prev === 'joiner-answer' ||
              prev === 'connecting'
                ? prev
                : 'connecting'
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities, deviceInfo, vibrationEnabled]);

  /** Derive session cipher + SAS from local private key & remote public key. */
  const establishSessionKeys = useCallback(async (remotePubRaw: ArrayBuffer) => {
    if (!keyPairRef.current) throw new Error('no-keypair');
    const remotePub = await importPublicKeyRaw(remotePubRaw);
    const sharedBits = await deriveSharedBits(keyPairRef.current.privateKey, remotePub);
    const aesKey = await deriveSessionAesKey(sharedBits);
    cipherRef.current = await createChunkCipher(aesKey);
    const sas = await deriveSasCode(sharedBits);
    setSasCode(sas);
    setIsSecurityVerified(false);
  }, []);

  const schedulePairingExpiry = useCallback((expiresAt = Date.now() + 10 * 60 * 1000) => {
    if (expiryTimerRef.current) clearTimeout(expiryTimerRef.current);
    setPairingExpiresAt(expiresAt);
    expiryTimerRef.current = setTimeout(() => {
      // Pairing payloads expire after 10 minutes
      cleanup();
      setPairingExpiresAt(null);
      setPairingError('expired');
      setSessionState('failed');
    }, Math.max(0, expiresAt - Date.now()));
  }, [cleanup]);

  // -----------------------------------------------------------------------
  // HOST: polling loop for signal-mode pairing. Waits for the joiner's
  // answer over the ephemeral signaling service and applies it
  // automatically — the user NEVER scans a second code.
  // -----------------------------------------------------------------------
  const startSignalHostPolling = useCallback(
    (host: { hostToken: string; joinToken: string; sessionId: string; expiresAt: number; endpoint: string }) => {
      stopSignalPolling();
      const signal = new SignalingClient(host.endpoint);
      const generation = pairingGenerationRef.current;
      let polling = false;
      signalPollRef.current = setInterval(async () => {
        if (signalAnswerAppliedRef.current || polling) return;
        polling = true;
        try {
          const res = await signal.pollHost(host.hostToken);
          if (generation !== pairingGenerationRef.current) return;
          if (res.status === 'declined') {
            stopSignalPolling();
            peerManagerRef.current?.close();
            setPairingError('declined');
            setSessionState('declined');
            sounds.playError();
            return;
          }
          // A join request arrived — THE HOST now makes the Accept/Decline
          // decision. No offer material has been released to the joiner yet.
          if (res.status === 'join-requested') {
            // File selection + sharing this invitation authorizes the sender.
            // The receiver must accept before a join request can exist.
            if (sendFirstHostRef.current) {
              await signal.hostAccept(host.hostToken);
              if (generation !== pairingGenerationRef.current) return;
              setSignalJoinerAccepted(true);
              setSessionState('accepted');
              return;
            }
            if (!joinRequestShownRef.current) {
              joinRequestShownRef.current = true;
              setJoinRequestInfo(res.joinRequest ?? { deviceName: 'Unknown device', platform: null });
              setSessionState('join-requested');
              sounds.playConnect();
              if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(60);
            }
            return;
          }
          if (res.status === 'host-accepted') {
            setSignalJoinerAccepted(true);
            return;
          }
          if (res.status === 'answered' && res.answer && peerManagerRef.current && keyPairRef.current) {
            signalAnswerAppliedRef.current = true;
            stopSignalPolling();
            try {
              await establishSessionKeys(pubKeyBytes(res.answer.publicKey));
              if (generation !== pairingGenerationRef.current || !peerManagerRef.current) return;
              await peerManagerRef.current.acceptAnswer(res.answer.sdp);
              if (generation !== pairingGenerationRef.current) return;
              setSessionState('connecting');
            } catch {
              if (generation !== pairingGenerationRef.current) return;
              setPairingError('The joiner answer could not be applied. Please start pairing again.');
              setSessionState('failed');
              sounds.playError();
            }
            return;
          }
        } catch (err) {
          if (generation !== pairingGenerationRef.current) return;
          if (err instanceof SignalingError && (err.kind === 'expired' || err.kind === 'not-found')) {
            stopSignalPolling();
            setPairingError('expired');
            setSessionState('failed');
            sounds.playError();
          }
          // Transient network errors: keep polling until TTL.
        } finally {
          polling = false;
        }
      }, 1200);
    },
    [establishSessionKeys, stopSignalPolling]
  );

  // -----------------------------------------------------------------------
  // HOST: create pairing — PRIMARY path is ONE-scan automatic pairing via
  // the ephemeral signaling service. The QR contains ONLY a session id, a
  // single-use join token and the endpoint — no SDP, no keys. The joiner's
  // answer arrives automatically; there is NO answer QR and NO second scan.
  // -----------------------------------------------------------------------
  const createPairing = useCallback(async (options?: { sendFirst?: boolean; fileCount?: number; totalBytes?: number }): Promise<boolean> => {
    if (typeof RTCPeerConnection === 'undefined') {
      setPairingError('unsupported-browser');
      setSessionState('failed');
      return false;
    }

    cleanup();
    setPairingError(null);
    setTextMessages([]);
    setClipboardItems([]);

    const generation = pairingGenerationRef.current;
    sendFirstHostRef.current = !!options?.sendFirst;
    const signal = new SignalingClient();
    let info;
    try {
      info = await signal.createSession({
        deviceName: buildDeviceLabel(deviceInfo),
        platform: `${deviceInfo.os} · ${deviceInfo.browser}`.slice(0, 32),
        fileCount: options?.fileCount,
        totalBytes: options?.totalBytes,
      });
    } catch {
      if (generation !== pairingGenerationRef.current) return false;
      // Signaling service unreachable — NEVER fake a success. The UI shows
      // "Automatic pairing unavailable" and offers the manual code flow.
      setSignalUnavailable(true);
      setPairingError('signal-unavailable');
      setSessionState('idle');
      return false;
    }

    if (generation !== pairingGenerationRef.current) {
      void signal.hostDecline(info.hostToken).catch(() => {});
      return false;
    }
    const code = buildSignalQr({
      a: 'nexdrop',
      v: 1,
      s: info.sessionId,
      t: info.joinToken,
      e: SIGNALING_ENDPOINT,
      ...(options?.sendFirst ? { i: 'send' as const } : {}),
    });
    signalHostRef.current = {
      hostToken: info.hostToken,
      joinToken: info.joinToken,
      sessionId: info.sessionId,
      expiresAt: info.expiresAt,
      endpoint: SIGNALING_ENDPOINT,
    };
    signalAnswerAppliedRef.current = false;
    setSignalJoinerAccepted(false);
    setPairingMode('signal');
    setOfferQr({
      code,
      sessionId: info.sessionId.slice(0, 8).toUpperCase(),
      segments: [{ index: 1, total: 1, text: code }], // always ONE code
    });
    setSessionState('hosting');
    schedulePairingExpiry(info.expiresAt);

    // Background: build the offer + gather ICE, publish to the signaling
    // service, then poll for the joiner's answer. The QR is already visible;
    // the joiner's consent screen can appear before the offer is published.
    void (async () => {
      try {
        const keyPair = await generateEcdhKeyPair();
        if (generation !== pairingGenerationRef.current) return;
        keyPairRef.current = keyPair;
        const peer = buildPeerManager();
        peer.initialize(true);
        const localDesc = await peer.createOfferAndWaitForIce();
        if (generation !== pairingGenerationRef.current) return;
        const pubB64 = bytesToBase64Url(new Uint8Array(await exportPublicKeyRaw(keyPair.publicKey)));
        try {
          await signal.publishOffer(info.hostToken, localDesc.sdp || '', pubB64);
        } catch {
          // Offer publishing raced a decline/expiry, or hit a transient
          // network error. NEVER fake a failure state from this alone —
          // start polling and let the session's own state tell the truth.
        }
      } catch {
        if (generation !== pairingGenerationRef.current) return;
        // LOCAL offer creation failed (e.g. no WebRTC support) — honest error.
        setPairingError('Could not create the WebRTC offer. Please start pairing again.');
        setSessionState('failed');
        sounds.playError();
        return;
      }
      if (generation !== pairingGenerationRef.current) return;
      if (signalHostRef.current) startSignalHostPolling(signalHostRef.current);
    })();

    return true;
  }, [buildPeerManager, cleanup, deviceInfo, schedulePairingExpiry, startSignalHostPolling]);

  // -----------------------------------------------------------------------
  // HOST: MANUAL pairing (fallback when the signaling service is
  // unreachable) — the legacy one-QR-each-direction code flow.
  // -----------------------------------------------------------------------
  const createPairingManual = useCallback(async (): Promise<boolean> => {
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
        device: buildDeviceLabel(deviceInfo),
      });
      offerCodeRef.current = code;

      const segId = randomId().slice(0, 8);
      setPairingMode('manual');
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
  }, [buildPeerManager, cleanup, schedulePairingExpiry, deviceInfo]);

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
          // v1 answers carry the full 256-bit ack; NDP2 compact answers carry
          // its 128-bit prefix to stay inside the single-QR budget.
          if (parsed.ackOfOffer !== expectedAck && !expectedAck.startsWith(parsed.ackOfOffer ?? '')) {
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
  // JOINER: scan/paste an offer → ACCEPT screen → produce the answer
  // -----------------------------------------------------------------------
  /** JOINER step 1: scan + validate the offer, then WAIT for explicit user
   *  consent. No keypair, no RTCPeerConnection, no ICE — nothing is created
   *  before the user taps Accept & Connect. */
  // ---------------------------------------------------------------------
  // JOINER: polling loop for signal-mode pairing. Waits for the HOST's
  // decision. The offer is only released once the host has accepted — the
  // joiner then builds the WebRTC answer and publishes it automatically.
  // No user action, no second QR, ever.
  // -----------------------------------------------------------------------
  const startSignalJoinPolling = useCallback(
    (pending: { joinToken: string; endpoint: string; expiresAt: number }) => {
      stopSignalPolling();
      const signal = new SignalingClient(pending.endpoint);
      const generation = pairingGenerationRef.current;
      signalPollRef.current = setInterval(async () => {
        if (joinerBuildingRef.current || joinerPollingRef.current) return;
        joinerPollingRef.current = true;
        try {
          const res = await signal.pollJoin(pending.joinToken);
          if (generation !== pairingGenerationRef.current) return;
          if (res.status === 'declined') {
            stopSignalPolling();
            pendingSignalRef.current = null;
            setPendingOfferInfo(null);
            setPairingError('declined');
            setSessionState('declined');
            sounds.playError();
            return;
          }
          if (res.status === 'host-accepted' && res.offerReady && res.offer) {
            joinerBuildingRef.current = true; // one-shot: build the answer once
            stopSignalPolling(); // the poll loop's job is done — no late poll may
                                  // see the consumed session as a fatal 404
            setSessionState('connecting');
            void (async () => {
              try {
                const keyPair = await generateEcdhKeyPair();
                if (generation !== pairingGenerationRef.current) return;
                keyPairRef.current = keyPair;
                const peer = buildPeerManager();
                peer.initialize(false);
                const localDesc = await peer.acceptOfferAndWaitForIce(res.offer!.sdp);
                if (generation !== pairingGenerationRef.current) return;
                await establishSessionKeys(pubKeyBytes(res.offer!.publicKey));
                if (generation !== pairingGenerationRef.current) return;
                const pubB64 = bytesToBase64Url(new Uint8Array(await exportPublicKeyRaw(keyPair.publicKey)));
                await signal.publishAnswer(pending.joinToken, localDesc.sdp || '', pubB64);
                if (generation !== pairingGenerationRef.current) return;
                setPendingOfferInfo(null);
                // Stays 'connecting' until the host applies the answer and
                // the DataChannel opens → onStateChange('connected').
              } catch {
                if (generation !== pairingGenerationRef.current) return;
                stopSignalPolling();
                setPairingError('Could not complete the connection. Please start pairing again.');
                setSessionState('failed');
                sounds.playError();
              }
            })();
          }
        } catch (err) {
          if (generation !== pairingGenerationRef.current) return;
          if (err instanceof SignalingError && (err.kind === 'expired' || err.kind === 'not-found')) {
            // A 404/410 that arrives while the answer is already being built
            // is a straggler response from before the session was consumed —
            // the connection is opening; it must NOT be treated as fatal.
            if (joinerBuildingRef.current) return;
            stopSignalPolling();
            setPairingError('expired');
            setSessionState('failed');
            sounds.playError();
          }
          // Transient network errors: keep polling silently until TTL.
        } finally {
          joinerPollingRef.current = false;
        }
      }, 1200);
    },
    [buildPeerManager, establishSessionKeys, stopSignalPolling]
  );

  const joinWithOffer = useCallback(
    async (offerCode: string): Promise<boolean> => {
      if (typeof RTCPeerConnection === 'undefined') {
        setPairingError('unsupported-browser');
        setSessionState('failed');
        return false;
      }

      cleanup();
      const generation = pairingGenerationRef.current;
      setPairingError(null);
      setTextMessages([]);
      setClipboardItems([]);

      // NDPS1: ONE-scan automatic pairing. Validate the session, FILE a
      // single-use join request, then WAIT for the HOST's decision. The
      // host renders the Accept/Decline card; no keypair, no
      // RTCPeerConnection, no offer material exists on this side until the
      // host accepts.
      if (isSignalQr(offerCode)) {
        try {
          const payload = parseSignalQr(offerCode);
          const signal = new SignalingClient(payload.e);
          const info = await signal.validate(payload.t);
          if (generation !== pairingGenerationRef.current) return false;
          // File the join request — single-use, first request wins.
          if (payload.i !== 'send') await signal.joinRequest(payload.t, {
            deviceName: buildDeviceLabel(deviceInfo),
            platform: `${deviceInfo.os} · ${deviceInfo.browser}`.slice(0, 32),
          });
          if (generation !== pairingGenerationRef.current) return false;
          pendingSignalRef.current = {
            joinToken: payload.t,
            endpoint: payload.e,
            expiresAt: info.expiresAt,
          };
          setPendingOfferInfo({
            device: info.deviceName,
            expiresAt: info.expiresAt,
            platform: info.platform,
            fileCount: info.fileCount,
            totalBytes: info.totalBytes,
            connectionType: info.connectionType,
          });
          setPairingMode('signal');
          if (payload.i === 'send') {
            receiverConsentRef.current = true;
            setSessionState('awaiting-accept');
          } else {
            setSessionState('waiting-for-join');
            startSignalJoinPolling(pendingSignalRef.current);
          }
          schedulePairingExpiry(info.expiresAt);
          return true;
        } catch (err) {
          if (generation !== pairingGenerationRef.current) return false;
          if (err instanceof SignalingError) {
            if (err.kind === 'expired') setPairingError('expired');
            else if (err.kind === 'not-found') setPairingError('invalid-format');
            else if (err.kind === 'already-joined') setPairingError('already-joined');
            else if (err.kind === 'network') setPairingError('signal-network');
            else setPairingError('invalid-format');
          } else {
            setPairingError('invalid-format');
          }
          setSessionState('failed');
          return false;
        }
      }

      try {
        const parsed = await parsePairingCode(offerCode);
        if (parsed.kind !== 'offer') {
          setPairingError('not-offer');
          setSessionState('failed');
          return false;
        }

        // Hold the validated offer; the connection request screen takes over.
        pendingOfferRef.current = {
          code: offerCode.trim(),
          peerPublicKey: parsed.peerPublicKey,
          sdp: parsed.sdp,
          expiresAt: parsed.expiresAt,
        };
        setPendingOfferInfo({
          device: parsed.device,
          expiresAt: parsed.expiresAt,
        });
        setPairingMode('manual');
        setSessionState('awaiting-accept');
        return true;
      } catch (err: any) {
        const pe = toPairingError(err);
        setPairingError(pe || err?.message || 'The offer code was invalid or expired.');
        setSessionState('failed');
        return false;
      }
    },
    [cleanup, deviceInfo, schedulePairingExpiry, startSignalJoinPolling]
  );

  /** JOINER step 2 (MANUAL fallback only): user tapped Accept & Connect —
   *  start the REAL WebRTC negotiation and produce the answer code. In the
   *  signal flow the HOST decides; the joiner never confirms here. */
  const acceptPendingOffer = useCallback(async (): Promise<boolean> => {
    const signalPending = pendingSignalRef.current;
    if (signalPending && !receiverConsentRef.current) return false;
    if (signalPending && receiverConsentRef.current) {
      receiverConsentRef.current = false; // one request even on repeated clicks
      const generation = pairingGenerationRef.current;
      try {
        await new SignalingClient(signalPending.endpoint).joinRequest(signalPending.joinToken, {
          deviceName: buildDeviceLabel(deviceInfo),
          platform: `${deviceInfo.os} · ${deviceInfo.browser}`.slice(0, 32),
        });
        if (generation !== pairingGenerationRef.current) return false;
        setPairingError(null);
        setSessionState('waiting-for-join');
        startSignalJoinPolling(signalPending);
        return true;
      } catch (err) {
        if (generation !== pairingGenerationRef.current) return false;
        receiverConsentRef.current = true;
        setPairingError(err instanceof SignalingError && err.kind === 'expired' ? 'expired' : 'signal-network');
        return false;
      }
    }
    // ---- MANUAL mode (legacy fallback) ----
    const pending = pendingOfferRef.current;
    if (!pending) {
      setPairingError('invalid-format');
      setSessionState('failed');
      return false;
    }
    if (pending.expiresAt + 2 * 60 * 1000 < Date.now()) {
      pendingOfferRef.current = null;
      setPendingOfferInfo(null);
      setPairingError('expired');
      setSessionState('failed');
      return false;
    }

    try {
      const keyPair = await generateEcdhKeyPair();
      keyPairRef.current = keyPair;

      const peer = buildPeerManager();
      peer.initialize(false);

      const localDesc = await peer.acceptOfferAndWaitForIce(pending.sdp);

      // Bind the answer to this exact offer via an ack of the offer code
      const ack = await computeSha256Base64Url(pending.code);
      const code = await buildPairingCode({
        kind: 'answer',
        sdp: localDesc.sdp || '',
        publicKey: await exportPublicKeyRaw(keyPair.publicKey),
        ackOfOffer: ack,
      });

      await establishSessionKeys(pending.peerPublicKey);

      pendingOfferRef.current = null;
      setPendingOfferInfo(null);

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
  }, [buildPeerManager, establishSessionKeys, schedulePairingExpiry, deviceInfo, startSignalJoinPolling]);

  // ---------------------------------------------------------------------
  // HOST: the join-request decision. The Accept/Decline buttons on the
  // HOST's request card drive these — the joiner has no authority.
  // ---------------------------------------------------------------------

  /** HOST: accept the pending join request. The joiner receives the offer
   *  and completes the WebRTC answer automatically. */
  const acceptJoinRequest = useCallback(async (): Promise<boolean> => {
    const host = signalHostRef.current;
    if (!host) return false;
    try {
      await new SignalingClient(host.endpoint).hostAccept(host.hostToken);
    } catch (err) {
      if (err instanceof SignalingError && (err.kind === 'expired' || err.kind === 'not-found')) {
        stopSignalPolling();
        setPairingError('expired');
        setSessionState('failed');
        sounds.playError();
        return false;
      }
      // Transient network error — keep the request card, allow a retry.
      setPairingError('Could not reach the pairing service. Please try again.');
      return false;
    }
    setJoinRequestInfo(null);
    setSessionState('accepted');
    return true;
  }, [stopSignalPolling]);

  /** HOST: decline the pending join request. Nothing survives: the joiner
   *  is told the honest declined state and no WebRTC transfer starts. */
  const declineJoinRequest = useCallback(() => {
    const host = signalHostRef.current;
    if (host) {
      new SignalingClient(host.endpoint)
        .hostDecline(host.hostToken)
        .catch(() => {});
    }
    stopSignalPolling();
    peerManagerRef.current?.close();
    setJoinRequestInfo(null);
    setPairingError('declined');
    setSessionState('declined');
    sounds.playError();
  }, [stopSignalPolling]);

  /**
   * Session-level transfer activity, driven ONLY by the transfer engines —
   * never faked. Feeds both the legacy SessionState machine and the
   * authoritative ConnectionPhase (see connectionPhase below).
   */
  const setTransferActivity = useCallback(
    (active: boolean, direction?: TransferDirection, verifying?: boolean) => {
      setTransferActivityState((prev) => ({
        active,
        direction: active ? (direction ?? prev.direction) : null,
        verifying: active && !!verifying,
      }));
      setSessionState((prev) => {
        if (active && !verifying) {
          return prev === 'connected' || prev === 'completed' ? 'transferring' : prev;
        }
        return prev === 'transferring' && !active ? 'completed' : prev;
      });
    },
    []
  );

  /**
   * AUTHORITATIVE connection phase — derived in exactly ONE place, from the
   * real peer-connection lifecycle plus live engine activity. Any
   * user-facing connection status (header, diagnostics) may read ONLY this.
   *
   * An open DataChannel with an actively pumping engine IS a live
   * connection: a transient ICE 'disconnected' blip must never show
   * "Not connected" while bytes are verifiably flowing.
   */
  /**
   * Screen Wake Lock while a transfer is ACTIVE: Android Chrome throttles
   * timers in hidden pages and can freeze the renderer when the screen
   * turns off — during an 11-minute physical transfer that can stall the
   * receiver's ACK cadence and the sender's pipeline. Holding the screen
   * awake while bytes flow is the browser-sanctioned mitigation
   * (navigator.wakeLock, best-effort, silently ignored where unsupported).
   */
  const transferActive = transferActivity.active && !transferActivity.verifying;
  useEffect(() => {
    const wl = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ released: boolean; release: () => Promise<void> }> } }).wakeLock;
    if (!transferActive || !wl) return;
    let lock: { released: boolean; release: () => Promise<void> } | null = null;
    let disposed = false;
    const acquire = async () => {
      if (disposed || lock?.released === false) return;
      try {
        lock = await wl.request('screen');
      } catch {
        /* denied / unsupported — transfers still run, just less protected */
      }
    };
    const onVisibility = () => {
      // Wake locks auto-release when the page becomes hidden; re-acquire
      // when the user returns (e.g. after a manual screen-off).
      if (document.visibilityState === 'visible') void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      try {
        void lock?.release?.();
      } catch {
        /* already released */
      }
    };
  }, [transferActive]);

  const connectionPhase = useMemo<ConnectionPhase>(() => {
    if (transferActivity.active) {
      if (transferActivity.verifying) return 'verifying';
      return 'transferring';
    }
    switch (sessionState) {
      case 'hosting':
      case 'hosting-offer':
      case 'awaiting-accept':
        return 'pairing';
      case 'waiting-for-join':
      case 'joiner-answer':
        return 'waiting_for_peer';
      case 'join-requested':
        return 'incoming_request';
      case 'accepted':
      case 'connecting':
        return 'connecting';
      case 'connected':
        return 'connected';
      case 'transferring':
        return 'transferring';
      case 'completed':
        return 'completed';
      case 'disconnected':
        return 'disconnected';
      case 'failed':
      case 'declined':
        return 'failed';
      default:
        return 'idle'; // idle, closed
    }
  }, [sessionState, transferActivity.active, transferActivity.verifying]);

  /**
   * REAL transport stats via getStats() — 1 Hz while a peer connection
   * exists. Feeds the dev diagnostics panel (direct/relay, ICE candidate
   * types, candidate-pair RTT, transport byte counters). Read-only, honest.
   */
  useEffect(() => {
    if (!activePeerManager) return;
    let stopped = false;
    const tick = async () => {
      try {
        const stats = await sampleTransportStats(activePeerManager.getPeerConnection());
        if (!stopped && stats) {
          updateTransportTelemetry(stats);
          setTransportKind((prev) => (prev === stats.transport ? prev : stats.transport));
        }
        if (!stopped)
          updateDataChannelState(activePeerManager.getChannel('file')?.readyState ?? null);
      } catch {
        /* stats are best-effort diagnostics */
      }
    };
    void tick();
    const timer = setInterval(tick, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [activePeerManager]);

  /** JOINER decline: terminate the pending session completely. Nothing was
   *  created yet (no RTCPeerConnection ever existed), and cleanup discards
   *  the stashed offer and all session material. In signal mode this also
   *  WITHDRAWS the pending join request — the host is shown the honest
   *  declined state. */
  const declinePendingOffer = useCallback(() => {
    const pendingSignal = pendingSignalRef.current;
    if (pendingSignal) {
      // Tell the signaling service so the host sees the honest state.
      new SignalingClient(pendingSignal.endpoint)
        .decline(pendingSignal.joinToken)
        .catch(() => {});
    }
    cleanup();
    setPairingError(null);
    setSessionState('idle');
  }, [cleanup]);

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
    connectionPhase,
    transferActivity,
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
    transportKind,
    peerManager: activePeerManager,
    cipher: cipherRef,
    createPairing,
    createPairingManual,
    pairingMode,
    pairingExpiresAt,
    signalUnavailable,
    signalJoinerAccepted,
    joinRequestInfo,
    submitAnswer,
    joinWithOffer,
    acceptPendingOffer,
    declinePendingOffer,
    acceptJoinRequest,
    declineJoinRequest,
    setTransferActivity,
    pendingOfferInfo,
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
