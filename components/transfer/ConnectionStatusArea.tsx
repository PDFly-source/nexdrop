'use client';

import React, { useEffect, useState } from 'react';
import { renderPairingQr } from '@/lib/pairing/render';
import {
  Wifi,
  WifiOff,
  QrCode,
  ShieldCheck,
  RefreshCw,
  PowerOff,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Copy,
  Check,
  Activity,
  Lock,
  Loader2,
  Link as LinkIcon,
  ArrowRight,
  LogIn,
  TriangleAlert,
  Download,
} from 'lucide-react';
import { SessionState, PeerInfo, PairingError } from '@/types/session';
import { copyToClipboard } from '@/lib/clipboard';
import { QrScannerModal } from '@/components/pairing/QrScannerModal';
import type { PairingQr } from '@/hooks/useNexDropSession';

interface ConnectionStatusAreaProps {
  sessionState: SessionState;
  offerQr: PairingQr | null;
  answerQr: PairingQr | null;
  pairingError: PairingError | string | null;
  peerInfo: PeerInfo | null;
  sasCode: string | null;
  isSecurityVerified: boolean;
  rttMs: number | null;
  onCreatePairing: () => void;
  onCreatePairingManual: () => void;
  pairingMode: 'signal' | 'manual' | null;
  signalUnavailable: boolean;
  signalJoinerAccepted: boolean;
  /** HOST: the pending join request shown on the decision card. */
  joinRequestInfo: { deviceName: string; platform: string | null } | null;
  onSubmitAnswer: (code: string) => Promise<boolean>;
  onJoinWithOffer: (code: string) => Promise<boolean>;
  onAcceptPendingOffer: () => Promise<boolean>;
  onDeclinePendingOffer: () => void;
  /** HOST: accept the pending join request (the authorization decision). */
  onAcceptJoinRequest: () => Promise<boolean>;
  /** HOST: decline the pending join request. */
  onDeclineJoinRequest: () => void;
  onStartOver: () => void;
  pendingOfferInfo: {
    device?: string;
    expiresAt: number;
    platform?: string | null;
    fileCount?: number | null;
    totalBytes?: number | null;
    connectionType?: string | null;
  } | null;
  onClearPairingError: () => void;
  onDisconnect: () => void;
  onOpenSecurityModal: () => void;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/** Error copy that humans can act on. */
function pairingErrorMessage(err: PairingError | string | null): string {
  switch (err) {
    case 'invalid-format':
      return 'That pairing code is not valid. Ask the other device to create a new one.';
    case 'corrupt-segment':
      return 'A pairing QR fragment did not read correctly. Scan that fragment again.';
    case 'expired':
      return 'That pairing code has expired. Create a new pairing on the other device.';
    case 'not-offer':
      return 'That code is an answer, not a pairing offer. Scan it on the device that created the pairing.';
    case 'not-answer':
      return 'That code is an offer, not an answer. Scan the QR shown on the joining device.';
    case 'wrong-session':
      return 'That answer belongs to a different pairing. Restart pairing on both devices.';
    case 'timeout':
      return 'Pairing timed out. Please start again.';
    case 'declined':
      return 'Connection declined. The other device chose not to connect.';
    case 'signal-unavailable':
      return 'Automatic pairing is unavailable right now (the pairing service could not be reached). You can still pair with manual codes.';
    case 'signal-network':
      return 'Could not reach the pairing service. Check your connection, or ask the other device for a manual pairing code.';
    case 'already-joined':
      return 'This pairing was already used by another device. Ask for a new pairing.';
    case 'unsupported-browser':
      return 'This browser does not support WebRTC data channels. Try a modern browser like Chrome, Edge, Firefox or Safari.';
    default:
      return err || 'Something went wrong. Please start pairing again.';
  }
}

export const ConnectionStatusArea: React.FC<ConnectionStatusAreaProps> = ({
  sessionState,
  offerQr,
  answerQr,
  pairingError,
  peerInfo,
  sasCode,
  isSecurityVerified,
  rttMs,
  onCreatePairing,
  onCreatePairingManual,
  pairingMode,
  signalUnavailable,
  signalJoinerAccepted,
  joinRequestInfo,
  onSubmitAnswer,
  onJoinWithOffer,
  onAcceptPendingOffer,
  onDeclinePendingOffer,
  onAcceptJoinRequest,
  onDeclineJoinRequest,
  onStartOver,
  pendingOfferInfo,
  onClearPairingError,
  onDisconnect,
  onOpenSecurityModal,
}) => {
  const [isScannerOpen, setIsScannerOpen] = useState<boolean>(false);
  const [scannerPurpose, setScannerPurpose] = useState<'offer' | 'answer'>('answer');
  const [isDetailsOpen, setIsDetailsOpen] = useState<boolean>(false);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [offerSegmentIndex, setOfferSegmentIndex] = useState<number>(0);
  const [answerSegmentIndex, setAnswerSegmentIndex] = useState<number>(0);

  // A NEW pairing session (new segments array) must always start its QR
  // carousel on page 1 — a stale page index must never carry over into
  // the next pairing. The segments arrays are session-scoped state in
  // the hook, so this render-time adjustment (React's documented pattern
  // for deriving state from changed props) fires exactly once per session.
  const [prevOfferSegments, setPrevOfferSegments] = useState(offerQr?.segments);
  if (prevOfferSegments !== offerQr?.segments) {
    setPrevOfferSegments(offerQr?.segments);
    setOfferSegmentIndex(0);
  }
  const [prevAnswerSegments, setPrevAnswerSegments] = useState(answerQr?.segments);
  if (prevAnswerSegments !== answerQr?.segments) {
    setPrevAnswerSegments(answerQr?.segments);
    setAnswerSegmentIndex(0);
  }

  // Expiry countdown for active pairing payloads
  const [secondsRemaining, setSecondsRemaining] = useState<number>(600);

  const isPairingActive =
    sessionState === 'hosting-offer' ||
    sessionState === 'hosting' ||
    sessionState === 'waiting-for-join' ||
    sessionState === 'join-requested' ||
    sessionState === 'accepted' ||
    sessionState === 'awaiting-accept' ||
    sessionState === 'joiner-answer' ||
    sessionState === 'connecting';

  // Joiner: countdown driven by the OFFER's own expiry timestamp.
  const [acceptSecondsRemaining, setAcceptSecondsRemaining] = useState<number>(600);
  useEffect(() => {
    if (sessionState !== 'awaiting-accept' || !pendingOfferInfo) return;
    const tick = () =>
      setAcceptSecondsRemaining(Math.max(0, Math.floor((pendingOfferInfo.expiresAt - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [sessionState, pendingOfferInfo]);

  useEffect(() => {
    if (!isPairingActive) return;
    const startedAt = Date.now();
    const total = 10 * 60; // pairing payloads live 10 minutes
    const timer = setInterval(() => {
      setSecondsRemaining(Math.max(0, total - Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [isPairingActive, sessionState]);

  // ---------------------------------------------------------------------
  // QR rendering (per current segment)
  // ---------------------------------------------------------------------

  // 'hosting' is the signal-paired host screen: it shows the OFFER QR
  // exactly like the manual 'hosting-offer' flow — never the answer side.
  const offerActive = sessionState === 'hosting-offer' || sessionState === 'hosting';
  const offerSegments = offerQr?.segments ?? [];
  const answerSegments = answerQr?.segments ?? [];
  const activeQrText = offerActive
    ? offerSegments[offerSegmentIndex]?.text ?? ''
    : sessionState === 'joiner-answer'
      ? answerSegments[answerSegmentIndex]?.text ?? ''
      : '';

  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  useEffect(() => {
    if (!activeQrText) return;
    let isMounted = true;
    // Canonical options: standard polarity + quiet zone. An inverted
    // light-on-dark QR is NOT reliably decodable by phone cameras.
    renderPairingQr(activeQrText)
      .then((url) => {
        if (isMounted) setQrDataUrl(url);
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, [activeQrText]);

  const activeSegments = offerActive ? offerSegments : answerSegments;
  const activeSegmentIndex = offerActive ? offerSegmentIndex : answerSegmentIndex;
  const setActiveSegmentIndex = offerActive ? setOfferSegmentIndex : setAnswerSegmentIndex;

  const handleCopyCode = async () => {
    const code = offerActive ? offerQr?.code : answerQr?.code;
    if (!code) return;
    const ok = await copyToClipboard(code);
    if (ok) {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  const handleCopyLink = async () => {
    if (!offerQr?.code || typeof window === 'undefined') return;
    const link = `${window.location.origin}${window.location.pathname}#join=${offerQr.code}`;
    const ok = await copyToClipboard(link);
    if (ok) {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  /** Download the pairing QR as PNG image(s) — one file per segment. */
  const handleDownloadQr = async () => {
    const segs = activeSegments;
    if (!segs.length) return;
    for (let i = 0; i < segs.length; i++) {
      try {
        // Download uses the exact same canonical options as the live QR.
        const url = await renderPairingQr(segs[i].text);
        const a = document.createElement('a');
        a.href = url;
        a.download =
          segs.length > 1
            ? `nexdrop-qr-${i + 1}-of-${segs.length}.png`
            : 'nexdrop-qr.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch {
        // best-effort download; copy/paste fallbacks remain available
      }
    }
  };

  const openScanner = (purpose: 'offer' | 'answer') => {
    setScannerPurpose(purpose);
    onClearPairingError();
    setIsScannerOpen(true);
  };

  const handleScanComplete = async (code: string) => {
    setIsScannerOpen(false);
    if (scannerPurpose === 'answer') {
      const ok = await onSubmitAnswer(code);
      if (!ok) {
        // pairingError is set by the hook — reopen the scanner so the user can retry
        setTimeout(() => setIsScannerOpen(true), 1500);
      }
    } else {
      await onJoinWithOffer(code);
    }
  };

  const formatTimer = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // ---------------------------------------------------------------------
  // CONNECTED
  // ---------------------------------------------------------------------

  if (sessionState === 'connected' || sessionState === 'transferring' || sessionState === 'completed') {
    return (
      <div className="rounded-2xl border border-nd-success/25 bg-nd-bg-1 p-4 sm:p-5 shadow-sm transition-all">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-nd-success/10 border border-nd-success/30 text-nd-teal">
              <Wifi className="w-5 h-5" aria-hidden="true" />
              <span className="absolute -top-1 -right-1 flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-nd-success opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-nd-teal" />
              </span>
            </div>

            <div>
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-nd-teal">
                  <span className="h-2 w-2 rounded-full bg-nd-teal animate-pulse" aria-hidden="true" />
                  Connected
                </span>
                <span className="text-white/45">·</span>
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-nd-success/90 bg-nd-success/10 px-2 py-0.5 rounded-full border border-nd-success/20">
                  <Lock className="w-2.5 h-2.5" aria-hidden="true" />
                  P2P · E2E Encrypted
                </span>
              </div>

              <div className="flex items-baseline gap-2 mt-0.5">
                <h2 className="text-base sm:text-lg font-semibold text-nd-text-primary">
                  {peerInfo?.name || 'Remote Device'}
                </h2>
                <span className="text-xs text-nd-text-secondary">
                  {peerInfo?.platform || 'WebRTC Peer'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:self-center">
            {rttMs !== null && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-nd-surface text-[11px] text-nd-text-secondary">
                <Activity className="w-3 h-3 text-nd-teal" aria-hidden="true" />
                <span>RTT {rttMs} ms</span>
              </div>
            )}

            <button
              onClick={() => setIsDetailsOpen(!isDetailsOpen)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-nd-surface text-xs text-nd-text-secondary hover:text-nd-text-primary hover:border-white/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
              aria-expanded={isDetailsOpen}
            >
              <span>Details</span>
              {isDetailsOpen ? <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />}
            </button>

            <button
              onClick={onDisconnect}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-nd-error/20 bg-nd-error/10 text-xs font-medium text-nd-error hover:bg-nd-error/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-error"
              title="Disconnect current session"
            >
              <PowerOff className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Disconnect</span>
            </button>
          </div>
        </div>

        {isDetailsOpen && (
          <div className="mt-4 pt-4 border-t border-white/[0.06] grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-nd-text-secondary">
            <div className="rounded-xl bg-nd-surface border border-white/[0.06] p-3">
              <span className="text-[10px] uppercase font-mono tracking-wider text-nd-text-secondary/80 block mb-1">
                Encryption
              </span>
              <div className="flex items-center gap-2 text-nd-text-primary font-medium">
                <ShieldCheck className="w-4 h-4 text-nd-teal" aria-hidden="true" />
                <span>DTLS + AES-256-GCM</span>
              </div>
              <p className="text-[11px] text-nd-text-secondary/80 mt-1">
                Transport encryption plus application-layer chunk encryption with a session key derived from an ECDH handshake.
              </p>
            </div>

            <div className="rounded-xl bg-nd-surface border border-white/[0.06] p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] uppercase font-mono tracking-wider text-nd-text-secondary/80">
                  Verification Code
                </span>
                {isSecurityVerified && (
                  <span className="text-[10px] text-nd-teal font-medium">Verified</span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-bold text-nd-teal tracking-wider">
                  {sasCode || '—'}
                </span>
                <button
                  onClick={onOpenSecurityModal}
                  className="text-[11px] text-nd-teal-bright hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal rounded"
                >
                  Verify
                </button>
              </div>
              <p className="text-[11px] text-nd-text-secondary/80 mt-1">
                Derived from the pairing handshake. Compare it on both devices.
              </p>
            </div>

            <div className="rounded-xl bg-nd-surface border border-white/[0.06] p-3">
              <span className="text-[10px] uppercase font-mono tracking-wider text-nd-text-secondary/80 block mb-1">
                Active Channels
              </span>
              <div className="flex flex-wrap gap-1 text-[10px] font-mono text-nd-text-primary">
                <span className="px-1.5 py-0.5 rounded bg-white/[0.06]">control</span>
                <span className="px-1.5 py-0.5 rounded bg-white/[0.06]">file</span>
                <span className="px-1.5 py-0.5 rounded bg-white/[0.06]">clipboard</span>
                <span className="px-1.5 py-0.5 rounded bg-white/[0.06]">text</span>
              </div>
              <p className="text-[11px] text-nd-text-secondary/80 mt-1">
                Direct device-to-device WebRTC. Files never touch any server.
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // HOSTING: offer QR shown, waiting for the joiner's answer
  // ---------------------------------------------------------------------

  if (sessionState === 'hosting-offer' || sessionState === 'hosting') {
    return (
      <div className="rounded-2xl border border-white/[0.1] bg-nd-bg-1 p-5 shadow-sm text-left">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-nd-teal">
              <span className="h-2 w-2 rounded-full bg-nd-teal animate-pulse" aria-hidden="true" />
              {pairingMode === 'manual' ? 'Step 1 of 2 — Show this QR' : 'Scan once — the rest is automatic'}
            </div>
            <h2 className="text-base font-semibold text-nd-text-primary mt-0.5">Pairing offer ready</h2>
            <p className="text-xs text-nd-text-secondary mt-0.5">
              On the other device, choose <strong className="text-nd-text-primary">Join pairing</strong> and scan this code.
              {pairingMode === 'manual' ? null : (
                <>
                  {' '}
                  When a device scans, you choose whether to accept it — then the connection completes by itself. No second scan.
                </>
              )}
              {' '}Session <span className="font-mono text-nd-text-primary">{offerQr?.sessionId}</span>
            </p>
          </div>
          <span className="text-[11px] font-mono text-nd-text-secondary shrink-0" aria-live="polite">
            {formatTimer(secondsRemaining)}
          </span>
        </div>

        {pairingError && (
          <div className="mt-3 rounded-lg border border-nd-warning/30 bg-nd-warning/10 px-3 py-2 text-xs text-nd-warning" role="alert">
            {pairingErrorMessage(pairingError)}
          </div>
        )}

        <div className="mt-4 flex flex-col sm:flex-row gap-5">
          <div className="flex flex-col items-center shrink-0 self-center">
            <div className="p-3 rounded-xl bg-nd-bg-1 border border-white/[0.08]">
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrDataUrl} alt="NexDrop pairing offer QR code" className="w-44 h-44 sm:w-48 sm:h-48 rounded-lg" />
              ) : (
                <div className="w-44 h-44 flex flex-col items-center justify-center gap-2 text-nd-text-secondary">
                  <Loader2 className="w-6 h-6 animate-spin text-nd-teal" aria-hidden="true" />
                  <span className="text-[11px]">Preparing offer…</span>
                </div>
              )}
            </div>

            {activeSegments.length > 1 && (
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => setActiveSegmentIndex(Math.max(0, activeSegmentIndex - 1))}
                  disabled={activeSegmentIndex === 0}
                  className="p-1.5 rounded-lg border border-white/[0.1] bg-nd-surface-elevated text-nd-text-secondary disabled:text-nd-text-muted hover:text-nd-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
                  aria-label="Previous QR code"
                >
                  <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                </button>
                <span className="text-[11px] font-mono text-nd-text-secondary">
                  Code {activeSegmentIndex + 1} / {activeSegments.length}
                </span>
                <button
                  onClick={() => setActiveSegmentIndex(Math.min(activeSegments.length - 1, activeSegmentIndex + 1))}
                  disabled={activeSegmentIndex === activeSegments.length - 1}
                  className="p-1.5 rounded-lg border border-white/[0.1] bg-nd-surface-elevated text-nd-text-secondary disabled:text-nd-text-muted hover:text-nd-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
                  aria-label="Next QR code"
                >
                  <ChevronRight className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            )}

            <div className="mt-3 flex items-center gap-2 text-[11px] font-medium text-nd-text-secondary" aria-live="polite">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-nd-teal" aria-hidden="true" />
              {pairingMode !== 'manual' && signalJoinerAccepted
                ? 'Device accepted — establishing secure channel…'
                : 'Waiting for a device to scan…'}
            </div>
          </div>

          <div className="flex-1 min-w-0 flex flex-col gap-2.5">
            {pairingMode === 'manual' ? (
              <p className="text-xs text-nd-text-secondary">
                No camera available on the other device? Share the pairing code or link instead.
              </p>
            ) : (
              <p className="text-xs text-nd-text-secondary">
                Automatic pairing is active: after the other device accepts, the secure
                connection completes on its own.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleCopyCode}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/[0.1] bg-nd-surface-elevated text-xs font-medium text-nd-text-primary hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
              >
                {copiedCode ? <Check className="w-3.5 h-3.5 text-nd-teal" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5 text-nd-text-secondary" aria-hidden="true" />}
                <span>{copiedCode ? 'Code copied' : 'Copy pairing code'}</span>
              </button>
              <button
                onClick={handleDownloadQr}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/[0.1] bg-nd-surface-elevated text-xs font-medium text-nd-text-primary hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
              >
                <Download className="w-3.5 h-3.5 text-nd-text-secondary" aria-hidden="true" />
                <span>{activeSegments.length > 1 ? 'Download QR codes' : 'Download QR'}</span>
              </button>
              <button
                onClick={handleCopyLink}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/[0.1] bg-nd-surface-elevated text-xs font-medium text-nd-text-primary hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
              >
                {copiedLink ? <Check className="w-3.5 h-3.5 text-nd-teal" aria-hidden="true" /> : <LinkIcon className="w-3.5 h-3.5 text-nd-text-secondary" aria-hidden="true" />}
                <span>{copiedLink ? 'Link copied' : 'Copy invite link'}</span>
              </button>
            </div>

            {pairingMode === 'manual' ? (
              <div className="mt-1 rounded-xl border border-nd-teal/25 bg-nd-teal/[0.06] p-3.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-nd-teal">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-nd-teal/15 text-[10px] font-bold">2</span>
                  Step 2 — Scan the answer
                </div>
                <p className="text-[11px] text-nd-text-secondary mt-1.5 leading-relaxed">
                  Once the other device scans this QR, it shows an <strong className="text-nd-text-primary">answer code</strong>. Scan it back here to finish connecting.
                </p>
                <button
                  onClick={() => openScanner('answer')}
                  className="mt-2.5 inline-flex items-center gap-2 rounded-xl bg-nd-teal px-4 py-2.5 text-xs font-semibold text-nd-bg-0 hover:bg-nd-teal-bright transition-all shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
                >
                  <QrCode className="w-4 h-4" aria-hidden="true" />
                  <span>Scan answer QR</span>
                </button>
              </div>
            ) : (
              <div className="mt-1 rounded-xl border border-nd-teal/25 bg-nd-teal/[0.06] p-3.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-nd-teal">
                  <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                  Automatic connection
                </div>
                <p className="text-[11px] text-nd-text-secondary mt-1.5 leading-relaxed">
                  When the other device taps <strong className="text-nd-text-primary">Accept</strong>, the
                  encrypted connection finishes by itself. If automatic pairing is unavailable,
                  you can switch to manual codes at any time.
                </p>
                <button
                  onClick={onCreatePairingManual}
                  className="mt-2.5 inline-flex items-center gap-2 rounded-xl border border-white/[0.12] bg-nd-surface-elevated px-4 py-2.5 text-xs font-semibold text-nd-text-primary hover:bg-white/[0.08] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
                >
                  <span>Use manual pairing code</span>
                </button>
              </div>
            )}

            <button
              onClick={onDisconnect}
              className="mt-auto self-start text-xs text-nd-text-secondary hover:text-nd-error transition-colors px-2 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-error rounded"
            >
              Cancel pairing
            </button>
          </div>
        </div>

        <QrScannerModal
          key={isScannerOpen ? 'scanner-open' : 'scanner-closed'}
          isOpen={isScannerOpen}
          title={scannerPurpose === 'answer' ? 'Scan the answer QR' : 'Scan pairing QR'}
          onClose={() => setIsScannerOpen(false)}
          onScanComplete={handleScanComplete}
        />
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // JOINER: scanned a valid offer — explicit consent before ANY WebRTC work
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // JOINER: join request filed — waiting for the HOST's decision
  // ---------------------------------------------------------------------
  if (sessionState === 'waiting-for-join') {
    return (
      <div className="rounded-2xl border border-nd-warning/25 bg-nd-bg-1 p-5 sm:p-6 shadow-sm text-left">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-nd-warning">
              <span className="h-2 w-2 rounded-full bg-nd-warning animate-ping" aria-hidden="true" />
              Join request sent
            </div>
            <h2 className="text-lg font-semibold text-nd-text-primary mt-1">Waiting for the sender to accept</h2>
          </div>
          <span className="text-[11px] font-mono text-nd-text-secondary shrink-0" aria-live="polite">
            {formatTimer(secondsRemaining)}
          </span>
        </div>

        <div className="mt-4 space-y-2.5 rounded-xl border border-white/[0.06] bg-nd-surface p-4 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-nd-text-secondary">Sender</span>
            <span className="font-medium text-nd-text-primary text-right truncate max-w-[60%]">
              {pendingOfferInfo?.device || 'A nearby device'}
            </span>
          </div>
          {pendingOfferInfo?.platform ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-nd-text-secondary">Platform</span>
              <span className="font-medium text-nd-text-primary text-right truncate max-w-[60%]">{pendingOfferInfo.platform}</span>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <span className="text-nd-text-secondary">Connection</span>
            <span className="font-medium text-nd-text-primary text-right">Direct peer-to-peer</span>
          </div>
        </div>

        <p className="mt-3 text-[11px] text-nd-text-secondary leading-relaxed">
          The sender decides whether to accept this connection. Nothing transfers until they do.
        </p>

        <div className="mt-5 flex flex-col-reverse sm:flex-row gap-3">
          <button
            onClick={onDeclinePendingOffer}
            className="flex-1 rounded-xl border border-white/[0.12] bg-nd-surface-elevated px-5 py-3.5 text-sm font-semibold text-nd-text-primary hover:bg-white/[0.08] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
          >
            Cancel request
          </button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // HOST: incoming connection request — the Accept/Decline decision
  // ---------------------------------------------------------------------
  if (sessionState === 'join-requested') {
    return (
      <div className="rounded-2xl border border-nd-teal/25 bg-nd-bg-1 p-5 sm:p-6 shadow-sm text-left">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-nd-teal">
              <span className="h-2 w-2 rounded-full bg-nd-teal animate-pulse" aria-hidden="true" />
              New connection request
            </div>
            <h2 className="text-lg font-semibold text-nd-text-primary mt-1">
              {joinRequestInfo?.deviceName || 'A device'} wants to connect
            </h2>
          </div>
          <span className="text-[11px] font-mono text-nd-text-secondary shrink-0" aria-live="polite">
            {formatTimer(secondsRemaining)}
          </span>
        </div>

        <dl className="mt-4 space-y-2.5 rounded-xl border border-white/[0.06] bg-nd-surface p-4 text-xs">
          {joinRequestInfo?.platform ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-nd-text-secondary">Platform</dt>
              <dd className="font-medium text-nd-text-primary text-right truncate max-w-[60%]">{joinRequestInfo.platform}</dd>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <dt className="text-nd-text-secondary">Connection</dt>
            <dd className="font-medium text-nd-text-primary text-right">Direct peer connection</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-nd-text-secondary">Security</dt>
            <dd className="font-medium text-nd-teal text-right">End-to-end encrypted</dd>
          </div>
        </dl>

        <p className="mt-3 text-[11px] text-nd-text-secondary leading-relaxed">
          Accepting opens a direct WebRTC connection between these two devices. No files, keys or
          history are ever sent to any server.
        </p>

        <div className="mt-5 flex flex-col-reverse sm:flex-row gap-3">
          <button
            onClick={onDeclineJoinRequest}
            className="flex-1 rounded-xl border border-white/[0.12] bg-nd-surface-elevated px-5 py-3.5 text-sm font-semibold text-nd-text-primary hover:bg-white/[0.08] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
          >
            Decline
          </button>
          <button
            onClick={() => void onAcceptJoinRequest()}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-nd-teal px-5 py-3.5 text-sm font-bold text-nd-bg-0 hover:bg-nd-teal-bright transition-all shadow-lg shadow-nd-teal/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
          >
            <ShieldCheck className="w-4 h-4" aria-hidden="true" />
            Accept
          </button>
        </div>
      </div>
    );
  }

  if (sessionState === 'awaiting-accept') {
    return (
      <div className="rounded-2xl border border-nd-teal/25 bg-nd-bg-1 p-5 sm:p-6 shadow-sm text-left">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-nd-teal">
              <span className="h-2 w-2 rounded-full bg-nd-teal animate-pulse" aria-hidden="true" />
              Pairing request received
            </div>
            <h2 className="text-lg font-semibold text-nd-text-primary mt-1">{pairingMode === 'signal' ? 'Incoming connection' : 'NexDrop wants to connect'}</h2>
          </div>
          <span className="text-[11px] font-mono text-nd-text-secondary shrink-0" aria-live="polite">
            {formatTimer(acceptSecondsRemaining)}
          </span>
        </div>

        <dl className="mt-4 space-y-2.5 rounded-xl border border-white/[0.06] bg-nd-surface p-4 text-xs">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-nd-text-secondary">Device</dt>
            <dd className="font-medium text-nd-text-primary text-right truncate max-w-[60%]">
              {pendingOfferInfo?.device || 'A nearby device'}
            </dd>
          </div>
          {pendingOfferInfo?.platform ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-nd-text-secondary">Platform</dt>
              <dd className="font-medium text-nd-text-primary text-right truncate max-w-[60%]">{pendingOfferInfo.platform}</dd>
            </div>
          ) : null}
          {typeof pendingOfferInfo?.fileCount === 'number' && pendingOfferInfo.fileCount > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-nd-text-secondary">Files queued</dt>
              <dd className="font-medium text-nd-text-primary text-right">
                {pendingOfferInfo.fileCount}
                {typeof pendingOfferInfo.totalBytes === 'number' && pendingOfferInfo.totalBytes > 0
                  ? ` · ${formatBytes(pendingOfferInfo.totalBytes)}`
                  : ''}
              </dd>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <dt className="text-nd-text-secondary">Connection</dt>
            <dd className="font-medium text-nd-text-primary text-right">Direct peer-to-peer</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-nd-text-secondary">Security</dt>
            <dd className="font-medium text-nd-teal text-right">End-to-end encrypted</dd>
          </div>
        </dl>

        <p className="mt-3 text-[11px] text-nd-text-secondary leading-relaxed">
          Accept to connect securely. Files travel directly between these devices; pairing metadata uses the signaling service.
        </p>

        <div className="mt-5 flex flex-col-reverse sm:flex-row gap-3">
          <button
            onClick={onDeclinePendingOffer}
            className="flex-1 rounded-xl border border-white/[0.12] bg-nd-surface-elevated px-5 py-3.5 text-sm font-semibold text-nd-text-primary hover:bg-white/[0.08] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
          >
            Decline
          </button>
          <button
            onClick={() => void onAcceptPendingOffer()}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-nd-teal px-5 py-3.5 text-sm font-bold text-nd-bg-0 hover:bg-nd-teal-bright transition-all shadow-lg shadow-nd-teal/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
          >
            <ShieldCheck className="w-4 h-4" aria-hidden="true" />
            {pairingMode === 'signal' ? 'Accept' : 'Accept & Connect'}
          </button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // JOINER: answer QR shown, waiting for the host to scan it
  // ---------------------------------------------------------------------

  if (sessionState === 'joiner-answer') {
    return (
      <div className="rounded-2xl border border-white/[0.1] bg-nd-bg-1 p-5 shadow-sm text-left">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-nd-teal">
              <span className="h-2 w-2 rounded-full bg-nd-teal animate-pulse" aria-hidden="true" />
              Step 2 of 2 — Return the code
            </div>
            <h2 className="text-base font-semibold text-nd-text-primary mt-0.5">
              Return this connection code to the sender
            </h2>
            <p className="text-xs text-nd-text-secondary mt-0.5">
              On the first device, tap <strong className="text-nd-text-primary">Scan answer QR</strong> and point it here —
              the connection then opens automatically. No camera there? Send the copied answer code instead.
              Session <span className="font-mono text-nd-text-primary">{answerQr?.sessionId}</span>
            </p>
          </div>
          <span className="text-[11px] font-mono text-nd-text-secondary shrink-0" aria-live="polite">
            {formatTimer(secondsRemaining)}
          </span>
        </div>

        <div className="mt-4 flex flex-col sm:flex-row gap-5">
          <div className="flex flex-col items-center shrink-0 self-center">
            <div className="p-3 rounded-xl bg-nd-bg-1 border border-white/[0.08]">
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrDataUrl} alt="NexDrop pairing answer QR code" className="w-44 h-44 sm:w-48 sm:h-48 rounded-lg" />
              ) : (
                <div className="w-44 h-44 flex flex-col items-center justify-center gap-2 text-nd-text-secondary">
                  <Loader2 className="w-6 h-6 animate-spin text-nd-teal" aria-hidden="true" />
                  <span className="text-[11px]">Preparing answer…</span>
                </div>
              )}
            </div>

            {activeSegments.length > 1 && (
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => setActiveSegmentIndex(Math.max(0, activeSegmentIndex - 1))}
                  disabled={activeSegmentIndex === 0}
                  className="p-1.5 rounded-lg border border-white/[0.1] bg-nd-surface-elevated text-nd-text-secondary disabled:text-nd-text-muted hover:text-nd-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
                  aria-label="Previous QR code"
                >
                  <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                </button>
                <span className="text-[11px] font-mono text-nd-text-secondary">
                  Code {activeSegmentIndex + 1} / {activeSegments.length}
                </span>
                <button
                  onClick={() => setActiveSegmentIndex(Math.min(activeSegments.length - 1, activeSegmentIndex + 1))}
                  disabled={activeSegmentIndex === activeSegments.length - 1}
                  className="p-1.5 rounded-lg border border-white/[0.1] bg-nd-surface-elevated text-nd-text-secondary disabled:text-nd-text-muted hover:text-nd-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
                  aria-label="Next QR code"
                >
                  <ChevronRight className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 flex flex-col gap-2.5">
            <p className="text-xs text-nd-text-secondary">
              This code is the technical fallback of local pairing — WebRTC needs the answer
              returned to the sender, and with no signaling server the return trip goes
              through this QR or the copied code.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleCopyCode}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/[0.1] bg-nd-surface-elevated text-xs font-medium text-nd-text-primary hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
              >
                {copiedCode ? <Check className="w-3.5 h-3.5 text-nd-teal" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5 text-nd-text-secondary" aria-hidden="true" />}
                <span>{copiedCode ? 'Code copied' : 'Copy answer code'}</span>
              </button>
              <button
                onClick={handleDownloadQr}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/[0.1] bg-nd-surface-elevated text-xs font-medium text-nd-text-primary hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
              >
                <Download className="w-3.5 h-3.5 text-nd-text-secondary" aria-hidden="true" />
                <span>{activeSegments.length > 1 ? 'Download QR codes' : 'Download QR'}</span>
              </button>
            </div>

            <div className="rounded-xl border border-white/[0.06] bg-nd-surface p-3 text-[11px] text-nd-text-secondary leading-relaxed">
              <div className="flex items-center gap-1.5 font-medium text-nd-warning mb-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                Waiting for the host device…
              </div>
              Keep both screens unlocked. Direct connectivity depends on your network; if it fails, restart pairing.
            </div>

            <button
              onClick={onDisconnect}
              className="mt-auto self-start text-xs text-nd-text-secondary hover:text-nd-error transition-colors px-2 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-error rounded"
            >
              Cancel pairing
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // CONNECTING
  // ---------------------------------------------------------------------

  if (sessionState === 'connecting' || sessionState === 'accepted') {
    return (
      <div className="rounded-2xl border border-nd-warning/25 bg-nd-bg-1 p-5 shadow-sm text-left">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-nd-warning/10 border border-nd-warning/30 text-nd-warning">
              <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
            </div>
            <div>
              <span className="flex items-center gap-1.5 text-xs font-semibold text-nd-warning">
                <span className="h-2 w-2 rounded-full bg-nd-warning animate-ping" aria-hidden="true" />
                Connecting…
              </span>
              <h2 className="text-base font-semibold text-nd-text-primary mt-0.5">
                Establishing the secure peer-to-peer link
              </h2>
              <p className="text-xs text-nd-text-secondary" aria-live="polite">
                Checking peer… verifying the shared security code… negotiating a direct
                WebRTC connection. This can take a few seconds.
              </p>
            </div>
          </div>

          <button
            onClick={onDisconnect}
            className="self-start sm:self-center px-3 py-1.5 rounded-lg border border-white/[0.08] bg-nd-surface text-xs text-nd-text-secondary hover:text-nd-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // DISCONNECTED / FAILED / CLOSED
  // ---------------------------------------------------------------------

  if (
    sessionState === 'disconnected' ||
    sessionState === 'failed' ||
    sessionState === 'closed' ||
    sessionState === 'declined'
  ) {
    const failed = sessionState === 'failed';
    const declined = sessionState === 'declined';
    return (
      <div className="rounded-2xl border border-nd-error/20 bg-nd-bg-1 p-5 shadow-sm text-left" role="alert">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-nd-error/10 border border-nd-error/30 text-nd-error">
              {failed || declined ? <TriangleAlert className="w-5 h-5" aria-hidden="true" /> : <WifiOff className="w-5 h-5" aria-hidden="true" />}
            </div>
            <div>
              <span className="text-xs font-semibold text-nd-error">
                {declined ? 'Connection declined' : failed ? 'Connection failed' : 'Device disconnected'}
              </span>
              <h2 className="text-base font-semibold text-nd-text-primary mt-0.5">
                {declined
                  ? 'The pairing was not accepted'
                  : failed
                    ? 'The direct link could not be established'
                    : 'The peer session has ended'}
              </h2>
              <p className="text-xs text-nd-text-secondary">
                {pairingError
                  ? pairingErrorMessage(pairingError)
                  : failed
                    ? 'Both devices need a working network path between them (for example the same Wi-Fi). Try pairing again.'
                    : 'Restart pairing on both devices to reconnect.'}
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-2.5">
            <button
              onClick={onCreatePairing}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-nd-teal px-4 py-2.5 text-xs font-semibold text-nd-bg-0 hover:bg-nd-teal-bright transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Pair again</span>
            </button>
            <button
              onClick={onStartOver}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/[0.12] bg-nd-surface-elevated px-4 py-2.5 text-xs font-semibold text-nd-text-primary hover:bg-white/[0.08] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
            >
              <LogIn className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Start over</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // IDLE (default) — start a pairing or join one
  // ---------------------------------------------------------------------

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-nd-bg-1 p-5 sm:p-6 shadow-sm text-left">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
        <div className="flex items-center gap-3.5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.04] border border-white/[0.08] text-nd-text-secondary">
            <Wifi className="w-6 h-6" aria-hidden="true" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-nd-text-secondary">
                <span className="h-2 w-2 rounded-full bg-white/30" aria-hidden="true" />
                Not connected
              </span>
            </div>
            <h2 className="text-base sm:text-lg font-semibold text-nd-text-primary mt-0.5">
              No device connected
            </h2>
            <p className="text-xs text-nd-text-secondary max-w-md">
              Pair another device to share files and text directly over an encrypted peer-to-peer link. No account, nothing is uploaded.
            </p>
          </div>
        </div>

        {signalUnavailable && (
          <div className="mt-3 w-full rounded-xl border border-nd-warning/30 bg-nd-warning/10 px-4 py-3 text-xs text-nd-warning" role="alert">
            <div className="font-semibold">Automatic pairing unavailable</div>
            <p className="mt-1 text-nd-warning/90 leading-relaxed">
              The pairing service could not be reached, so one-scan automatic pairing is
              off right now. You can still pair with manual codes.
            </p>
            <button
              onClick={onCreatePairingManual}
              className="mt-2 inline-flex items-center gap-2 rounded-xl border border-nd-warning/40 bg-nd-warning/15 px-4 py-2 text-xs font-semibold text-nd-warning hover:bg-nd-warning/25 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-warning"
            >
              <span>Use manual pairing code</span>
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 sm:self-center">
          <button
            onClick={() => openScanner('offer')}
            className="flex items-center gap-2 rounded-xl border border-white/[0.1] bg-nd-surface px-4 py-2.5 text-xs font-medium text-nd-text-primary hover:bg-white/[0.08] hover:border-nd-teal/30 transition-all shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
          >
            <LogIn className="w-4 h-4 text-nd-teal" aria-hidden="true" />
            <span>Join pairing</span>
          </button>
          <button
            onClick={onCreatePairing}
            className="flex items-center gap-2 rounded-xl bg-nd-teal px-4 py-2.5 text-xs font-semibold text-nd-bg-0 hover:bg-nd-teal-bright transition-all shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
          >
            <span>Create pairing</span>
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <p className="mt-4 text-[11px] text-nd-text-secondary/80 leading-relaxed border-t border-white/[0.06] pt-3">
        One scan: the joining device accepts, and the encrypted connection completes by itself.
        Manual QR/clipboard pairing is available as a fallback. Direct connectivity depends on your
        network and browser — for the most reliable link, keep both devices on the same Wi-Fi network.
      </p>

      <QrScannerModal
        key={isScannerOpen ? 'scanner-open' : 'scanner-closed'}
        isOpen={isScannerOpen}
        title={scannerPurpose === 'answer' ? 'Scan the answer QR' : 'Scan pairing QR'}
        onClose={() => setIsScannerOpen(false)}
        onScanComplete={handleScanComplete}
      />
    </div>
  );
};
