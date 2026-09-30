'use client';

import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { QR_RENDER_OPTIONS } from '@/lib/pairing/qrOptions';
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
  onSubmitAnswer: (code: string) => Promise<boolean>;
  onJoinWithOffer: (code: string) => Promise<boolean>;
  onAcceptPendingOffer: () => Promise<boolean>;
  onDeclinePendingOffer: () => void;
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
  onSubmitAnswer,
  onJoinWithOffer,
  onAcceptPendingOffer,
  onDeclinePendingOffer,
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

  const offerSegments = offerQr?.segments ?? [];
  const answerSegments = answerQr?.segments ?? [];
  const activeQrText =
    sessionState === 'hosting-offer'
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
    QRCode.toDataURL(activeQrText, QR_RENDER_OPTIONS)
      .then((url) => {
        if (isMounted) setQrDataUrl(url);
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, [activeQrText]);

  const activeSegments = sessionState === 'hosting-offer' ? offerSegments : answerSegments;
  const activeSegmentIndex = sessionState === 'hosting-offer' ? offerSegmentIndex : answerSegmentIndex;
  const setActiveSegmentIndex = sessionState === 'hosting-offer' ? setOfferSegmentIndex : setAnswerSegmentIndex;

  const handleCopyCode = async () => {
    const code = sessionState === 'hosting-offer' ? offerQr?.code : answerQr?.code;
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
        const url = await QRCode.toDataURL(segs[i].text, QR_RENDER_OPTIONS);
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

  if (sessionState === 'connected') {
    return (
      <div className="rounded-2xl border border-emerald-500/25 bg-[#111418] p-4 sm:p-5 shadow-sm transition-all">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-[#19C37D]">
              <Wifi className="w-5 h-5" aria-hidden="true" />
              <span className="absolute -top-1 -right-1 flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-[#19C37D]" />
              </span>
            </div>

            <div>
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-[#19C37D]">
                  <span className="h-2 w-2 rounded-full bg-[#19C37D] animate-pulse" aria-hidden="true" />
                  Connected
                </span>
                <span className="text-white/45">·</span>
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400/90 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                  <Lock className="w-2.5 h-2.5" aria-hidden="true" />
                  P2P · E2E Encrypted
                </span>
              </div>

              <div className="flex items-baseline gap-2 mt-0.5">
                <h2 className="text-base sm:text-lg font-semibold text-[#F5F7F8]">
                  {peerInfo?.name || 'Remote Device'}
                </h2>
                <span className="text-xs text-[#9AA3AD]">
                  {peerInfo?.platform || 'WebRTC Peer'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:self-center">
            {rttMs !== null && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-[#15191E] text-[11px] text-[#9AA3AD]">
                <Activity className="w-3 h-3 text-[#19C37D]" aria-hidden="true" />
                <span>RTT {rttMs} ms</span>
              </div>
            )}

            <button
              onClick={() => setIsDetailsOpen(!isDetailsOpen)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-[#15191E] text-xs text-[#9AA3AD] hover:text-[#F5F7F8] hover:border-white/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
              aria-expanded={isDetailsOpen}
            >
              <span>Details</span>
              {isDetailsOpen ? <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />}
            </button>

            <button
              onClick={onDisconnect}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/20 bg-red-500/10 text-xs font-medium text-red-400 hover:bg-red-500/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
              title="Disconnect current session"
            >
              <PowerOff className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Disconnect</span>
            </button>
          </div>
        </div>

        {isDetailsOpen && (
          <div className="mt-4 pt-4 border-t border-white/[0.06] grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-[#9AA3AD]">
            <div className="rounded-xl bg-[#15191E] border border-white/[0.06] p-3">
              <span className="text-[10px] uppercase font-mono tracking-wider text-[#9AA3AD]/80 block mb-1">
                Encryption
              </span>
              <div className="flex items-center gap-2 text-[#F5F7F8] font-medium">
                <ShieldCheck className="w-4 h-4 text-[#19C37D]" aria-hidden="true" />
                <span>DTLS + AES-256-GCM</span>
              </div>
              <p className="text-[11px] text-[#9AA3AD]/80 mt-1">
                Transport encryption plus application-layer chunk encryption with a session key derived from an ECDH handshake.
              </p>
            </div>

            <div className="rounded-xl bg-[#15191E] border border-white/[0.06] p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] uppercase font-mono tracking-wider text-[#9AA3AD]/80">
                  Verification Code
                </span>
                {isSecurityVerified && (
                  <span className="text-[10px] text-[#19C37D] font-medium">Verified</span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-bold text-[#19C37D] tracking-wider">
                  {sasCode || '—'}
                </span>
                <button
                  onClick={onOpenSecurityModal}
                  className="text-[11px] text-[#3DD6A0] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D] rounded"
                >
                  Verify
                </button>
              </div>
              <p className="text-[11px] text-[#9AA3AD]/80 mt-1">
                Derived from the pairing handshake. Compare it on both devices.
              </p>
            </div>

            <div className="rounded-xl bg-[#15191E] border border-white/[0.06] p-3">
              <span className="text-[10px] uppercase font-mono tracking-wider text-[#9AA3AD]/80 block mb-1">
                Active Channels
              </span>
              <div className="flex flex-wrap gap-1 text-[10px] font-mono text-[#F5F7F8]">
                <span className="px-1.5 py-0.5 rounded bg-white/[0.06]">control</span>
                <span className="px-1.5 py-0.5 rounded bg-white/[0.06]">file</span>
                <span className="px-1.5 py-0.5 rounded bg-white/[0.06]">clipboard</span>
                <span className="px-1.5 py-0.5 rounded bg-white/[0.06]">text</span>
              </div>
              <p className="text-[11px] text-[#9AA3AD]/80 mt-1">
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

  if (sessionState === 'hosting-offer') {
    return (
      <div className="rounded-2xl border border-white/[0.1] bg-[#111418] p-5 shadow-sm text-left">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-[#19C37D]">
              <span className="h-2 w-2 rounded-full bg-[#19C37D] animate-pulse" aria-hidden="true" />
              {pairingMode === 'manual' ? 'Step 1 of 2 — Show this QR' : 'Scan once — the rest is automatic'}
            </div>
            <h2 className="text-base font-semibold text-[#F5F7F8] mt-0.5">Pairing offer ready</h2>
            <p className="text-xs text-[#9AA3AD] mt-0.5">
              On the other device, choose <strong className="text-[#F5F7F8]">Join pairing</strong> and scan this code.
              {pairingMode === 'manual' ? null : (
                <>
                  {' '}
                  After they tap <strong className="text-[#F5F7F8]">Accept</strong>, the connection completes by itself — no second scan.
                </>
              )}
              {' '}Session <span className="font-mono text-[#F5F7F8]">{offerQr?.sessionId}</span>
            </p>
          </div>
          <span className="text-[11px] font-mono text-[#9AA3AD] shrink-0" aria-live="polite">
            {formatTimer(secondsRemaining)}
          </span>
        </div>

        {pairingError && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400" role="alert">
            {pairingErrorMessage(pairingError)}
          </div>
        )}

        <div className="mt-4 flex flex-col sm:flex-row gap-5">
          <div className="flex flex-col items-center shrink-0 self-center">
            <div className="p-3 rounded-xl bg-[#111418] border border-white/[0.08]">
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrDataUrl} alt="NexDrop pairing offer QR code" className="w-44 h-44 sm:w-48 sm:h-48 rounded-lg" />
              ) : (
                <div className="w-44 h-44 flex flex-col items-center justify-center gap-2 text-[#9AA3AD]">
                  <Loader2 className="w-6 h-6 animate-spin text-[#19C37D]" aria-hidden="true" />
                  <span className="text-[11px]">Preparing offer…</span>
                </div>
              )}
            </div>

            {activeSegments.length > 1 && (
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => setActiveSegmentIndex(Math.max(0, activeSegmentIndex - 1))}
                  disabled={activeSegmentIndex === 0}
                  className="p-1.5 rounded-lg border border-white/[0.1] bg-[#1B2026] text-[#9AA3AD] disabled:text-[#828B94] hover:text-[#F5F7F8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
                  aria-label="Previous QR code"
                >
                  <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                </button>
                <span className="text-[11px] font-mono text-[#9AA3AD]">
                  Code {activeSegmentIndex + 1} / {activeSegments.length}
                </span>
                <button
                  onClick={() => setActiveSegmentIndex(Math.min(activeSegments.length - 1, activeSegmentIndex + 1))}
                  disabled={activeSegmentIndex === activeSegments.length - 1}
                  className="p-1.5 rounded-lg border border-white/[0.1] bg-[#1B2026] text-[#9AA3AD] disabled:text-[#828B94] hover:text-[#F5F7F8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
                  aria-label="Next QR code"
                >
                  <ChevronRight className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            )}

            <div className="mt-3 flex items-center gap-2 text-[11px] font-medium text-[#9AA3AD]" aria-live="polite">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[#19C37D]" aria-hidden="true" />
              {pairingMode !== 'manual' && signalJoinerAccepted
                ? 'Device accepted — establishing secure channel…'
                : 'Waiting for a device to scan…'}
            </div>
          </div>

          <div className="flex-1 min-w-0 flex flex-col gap-2.5">
            {pairingMode === 'manual' ? (
              <p className="text-xs text-[#9AA3AD]">
                No camera available on the other device? Share the pairing code or link instead.
              </p>
            ) : (
              <p className="text-xs text-[#9AA3AD]">
                Automatic pairing is active: after the other device accepts, the secure
                connection completes on its own.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleCopyCode}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/[0.1] bg-[#1B2026] text-xs font-medium text-[#F5F7F8] hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
              >
                {copiedCode ? <Check className="w-3.5 h-3.5 text-[#19C37D]" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5 text-[#9AA3AD]" aria-hidden="true" />}
                <span>{copiedCode ? 'Code copied' : 'Copy pairing code'}</span>
              </button>
              <button
                onClick={handleDownloadQr}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/[0.1] bg-[#1B2026] text-xs font-medium text-[#F5F7F8] hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
              >
                <Download className="w-3.5 h-3.5 text-[#9AA3AD]" aria-hidden="true" />
                <span>{activeSegments.length > 1 ? 'Download QR codes' : 'Download QR'}</span>
              </button>
              <button
                onClick={handleCopyLink}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/[0.1] bg-[#1B2026] text-xs font-medium text-[#F5F7F8] hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
              >
                {copiedLink ? <Check className="w-3.5 h-3.5 text-[#19C37D]" aria-hidden="true" /> : <LinkIcon className="w-3.5 h-3.5 text-[#9AA3AD]" aria-hidden="true" />}
                <span>{copiedLink ? 'Link copied' : 'Copy invite link'}</span>
              </button>
            </div>

            {pairingMode === 'manual' ? (
              <div className="mt-1 rounded-xl border border-[#19C37D]/25 bg-[#19C37D]/[0.06] p-3.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#19C37D]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#19C37D]/15 text-[10px] font-bold">2</span>
                  Step 2 — Scan the answer
                </div>
                <p className="text-[11px] text-[#9AA3AD] mt-1.5 leading-relaxed">
                  Once the other device scans this QR, it shows an <strong className="text-[#F5F7F8]">answer code</strong>. Scan it back here to finish connecting.
                </p>
                <button
                  onClick={() => openScanner('answer')}
                  className="mt-2.5 inline-flex items-center gap-2 rounded-xl bg-[#19C37D] px-4 py-2.5 text-xs font-semibold text-[#0B0D0F] hover:bg-[#3DD6A0] transition-all shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
                >
                  <QrCode className="w-4 h-4" aria-hidden="true" />
                  <span>Scan answer QR</span>
                </button>
              </div>
            ) : (
              <div className="mt-1 rounded-xl border border-[#19C37D]/25 bg-[#19C37D]/[0.06] p-3.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#19C37D]">
                  <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                  Automatic connection
                </div>
                <p className="text-[11px] text-[#9AA3AD] mt-1.5 leading-relaxed">
                  When the other device taps <strong className="text-[#F5F7F8]">Accept</strong>, the
                  encrypted connection finishes by itself. If automatic pairing is unavailable,
                  you can switch to manual codes at any time.
                </p>
                <button
                  onClick={onCreatePairingManual}
                  className="mt-2.5 inline-flex items-center gap-2 rounded-xl border border-white/[0.12] bg-[#1B2026] px-4 py-2.5 text-xs font-semibold text-[#F5F7F8] hover:bg-white/[0.08] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
                >
                  <span>Use manual pairing code</span>
                </button>
              </div>
            )}

            <button
              onClick={onDisconnect}
              className="mt-auto self-start text-xs text-[#9AA3AD] hover:text-red-400 transition-colors px-2 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 rounded"
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

  if (sessionState === 'awaiting-accept') {
    return (
      <div className="rounded-2xl border border-[#19C37D]/25 bg-[#111418] p-5 sm:p-6 shadow-sm text-left">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-[#19C37D]">
              <span className="h-2 w-2 rounded-full bg-[#19C37D] animate-pulse" aria-hidden="true" />
              Pairing request received
            </div>
            <h2 className="text-lg font-semibold text-[#F5F7F8] mt-1">NexDrop wants to connect</h2>
          </div>
          <span className="text-[11px] font-mono text-[#9AA3AD] shrink-0" aria-live="polite">
            {formatTimer(acceptSecondsRemaining)}
          </span>
        </div>

        <dl className="mt-4 space-y-2.5 rounded-xl border border-white/[0.06] bg-[#15191E] p-4 text-xs">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-[#9AA3AD]">Device</dt>
            <dd className="font-medium text-[#F5F7F8] text-right truncate max-w-[60%]">
              {pendingOfferInfo?.device || 'A nearby device'}
            </dd>
          </div>
          {pendingOfferInfo?.platform ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[#9AA3AD]">Platform</dt>
              <dd className="font-medium text-[#F5F7F8] text-right truncate max-w-[60%]">{pendingOfferInfo.platform}</dd>
            </div>
          ) : null}
          {typeof pendingOfferInfo?.fileCount === 'number' && pendingOfferInfo.fileCount > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[#9AA3AD]">Files queued</dt>
              <dd className="font-medium text-[#F5F7F8] text-right">
                {pendingOfferInfo.fileCount}
                {typeof pendingOfferInfo.totalBytes === 'number' && pendingOfferInfo.totalBytes > 0
                  ? ` · ${formatBytes(pendingOfferInfo.totalBytes)}`
                  : ''}
              </dd>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <dt className="text-[#9AA3AD]">Connection</dt>
            <dd className="font-medium text-[#F5F7F8] text-right">Direct peer-to-peer</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-[#9AA3AD]">Security</dt>
            <dd className="font-medium text-[#19C37D] text-right">End-to-end encrypted</dd>
          </div>
        </dl>

        <p className="mt-3 text-[11px] text-[#9AA3AD] leading-relaxed">
          Accepting starts a direct WebRTC connection between these two devices. Nothing is sent to any server.
        </p>

        <div className="mt-5 flex flex-col-reverse sm:flex-row gap-3">
          <button
            onClick={onDeclinePendingOffer}
            className="flex-1 rounded-xl border border-white/[0.12] bg-[#1B2026] px-5 py-3.5 text-sm font-semibold text-[#F5F7F8] hover:bg-white/[0.08] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
          >
            Decline
          </button>
          <button
            onClick={() => void onAcceptPendingOffer()}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-[#19C37D] px-5 py-3.5 text-sm font-bold text-[#0B0D0F] hover:bg-[#3DD6A0] transition-all shadow-lg shadow-[#19C37D]/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
          >
            <ShieldCheck className="w-4 h-4" aria-hidden="true" />
            Accept &amp; Connect
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
      <div className="rounded-2xl border border-white/[0.1] bg-[#111418] p-5 shadow-sm text-left">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-[#19C37D]">
              <span className="h-2 w-2 rounded-full bg-[#19C37D] animate-pulse" aria-hidden="true" />
              Step 2 of 2 — Return the code
            </div>
            <h2 className="text-base font-semibold text-[#F5F7F8] mt-0.5">
              Return this connection code to the sender
            </h2>
            <p className="text-xs text-[#9AA3AD] mt-0.5">
              On the first device, tap <strong className="text-[#F5F7F8]">Scan answer QR</strong> and point it here —
              the connection then opens automatically. No camera there? Send the copied answer code instead.
              Session <span className="font-mono text-[#F5F7F8]">{answerQr?.sessionId}</span>
            </p>
          </div>
          <span className="text-[11px] font-mono text-[#9AA3AD] shrink-0" aria-live="polite">
            {formatTimer(secondsRemaining)}
          </span>
        </div>

        <div className="mt-4 flex flex-col sm:flex-row gap-5">
          <div className="flex flex-col items-center shrink-0 self-center">
            <div className="p-3 rounded-xl bg-[#111418] border border-white/[0.08]">
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrDataUrl} alt="NexDrop pairing answer QR code" className="w-44 h-44 sm:w-48 sm:h-48 rounded-lg" />
              ) : (
                <div className="w-44 h-44 flex flex-col items-center justify-center gap-2 text-[#9AA3AD]">
                  <Loader2 className="w-6 h-6 animate-spin text-[#19C37D]" aria-hidden="true" />
                  <span className="text-[11px]">Preparing answer…</span>
                </div>
              )}
            </div>

            {activeSegments.length > 1 && (
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => setActiveSegmentIndex(Math.max(0, activeSegmentIndex - 1))}
                  disabled={activeSegmentIndex === 0}
                  className="p-1.5 rounded-lg border border-white/[0.1] bg-[#1B2026] text-[#9AA3AD] disabled:text-[#828B94] hover:text-[#F5F7F8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
                  aria-label="Previous QR code"
                >
                  <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                </button>
                <span className="text-[11px] font-mono text-[#9AA3AD]">
                  Code {activeSegmentIndex + 1} / {activeSegments.length}
                </span>
                <button
                  onClick={() => setActiveSegmentIndex(Math.min(activeSegments.length - 1, activeSegmentIndex + 1))}
                  disabled={activeSegmentIndex === activeSegments.length - 1}
                  className="p-1.5 rounded-lg border border-white/[0.1] bg-[#1B2026] text-[#9AA3AD] disabled:text-[#828B94] hover:text-[#F5F7F8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
                  aria-label="Next QR code"
                >
                  <ChevronRight className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 flex flex-col gap-2.5">
            <p className="text-xs text-[#9AA3AD]">
              This code is the technical fallback of local pairing — WebRTC needs the answer
              returned to the sender, and with no signaling server the return trip goes
              through this QR or the copied code.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleCopyCode}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/[0.1] bg-[#1B2026] text-xs font-medium text-[#F5F7F8] hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
              >
                {copiedCode ? <Check className="w-3.5 h-3.5 text-[#19C37D]" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5 text-[#9AA3AD]" aria-hidden="true" />}
                <span>{copiedCode ? 'Code copied' : 'Copy answer code'}</span>
              </button>
              <button
                onClick={handleDownloadQr}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/[0.1] bg-[#1B2026] text-xs font-medium text-[#F5F7F8] hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
              >
                <Download className="w-3.5 h-3.5 text-[#9AA3AD]" aria-hidden="true" />
                <span>{activeSegments.length > 1 ? 'Download QR codes' : 'Download QR'}</span>
              </button>
            </div>

            <div className="rounded-xl border border-white/[0.06] bg-[#15191E] p-3 text-[11px] text-[#9AA3AD] leading-relaxed">
              <div className="flex items-center gap-1.5 font-medium text-amber-400 mb-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                Waiting for the host device…
              </div>
              Keep both screens unlocked. Direct connectivity depends on your network; if it fails, restart pairing.
            </div>

            <button
              onClick={onDisconnect}
              className="mt-auto self-start text-xs text-[#9AA3AD] hover:text-red-400 transition-colors px-2 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 rounded"
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

  if (sessionState === 'connecting') {
    return (
      <div className="rounded-2xl border border-amber-500/25 bg-[#111418] p-5 shadow-sm text-left">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
              <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
            </div>
            <div>
              <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                <span className="h-2 w-2 rounded-full bg-amber-400 animate-ping" aria-hidden="true" />
                Connecting…
              </span>
              <h2 className="text-base font-semibold text-[#F5F7F8] mt-0.5">
                Establishing the secure peer-to-peer link
              </h2>
              <p className="text-xs text-[#9AA3AD]" aria-live="polite">
                Checking peer… verifying the shared security code… negotiating a direct
                WebRTC connection. This can take a few seconds.
              </p>
            </div>
          </div>

          <button
            onClick={onDisconnect}
            className="self-start sm:self-center px-3 py-1.5 rounded-lg border border-white/[0.08] bg-[#15191E] text-xs text-[#9AA3AD] hover:text-[#F5F7F8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
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

  if (sessionState === 'disconnected' || sessionState === 'failed' || sessionState === 'closed') {
    const failed = sessionState === 'failed';
    return (
      <div className="rounded-2xl border border-red-500/20 bg-[#111418] p-5 shadow-sm text-left" role="alert">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-red-500/10 border border-red-500/30 text-red-400">
              {failed ? <TriangleAlert className="w-5 h-5" aria-hidden="true" /> : <WifiOff className="w-5 h-5" aria-hidden="true" />}
            </div>
            <div>
              <span className="text-xs font-semibold text-red-400">
                {failed ? 'Connection failed' : 'Device disconnected'}
              </span>
              <h2 className="text-base font-semibold text-[#F5F7F8] mt-0.5">
                {failed ? 'The direct link could not be established' : 'The peer session has ended'}
              </h2>
              <p className="text-xs text-[#9AA3AD]">
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
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#19C37D] px-4 py-2.5 text-xs font-semibold text-[#0B0D0F] hover:bg-[#3DD6A0] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Pair again</span>
            </button>
            <button
              onClick={onStartOver}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/[0.12] bg-[#1B2026] px-4 py-2.5 text-xs font-semibold text-[#F5F7F8] hover:bg-white/[0.08] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
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
    <div className="rounded-2xl border border-white/[0.08] bg-[#111418] p-5 sm:p-6 shadow-sm text-left">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
        <div className="flex items-center gap-3.5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.04] border border-white/[0.08] text-[#9AA3AD]">
            <Wifi className="w-6 h-6" aria-hidden="true" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-[#9AA3AD]">
                <span className="h-2 w-2 rounded-full bg-white/30" aria-hidden="true" />
                Not connected
              </span>
            </div>
            <h2 className="text-base sm:text-lg font-semibold text-[#F5F7F8] mt-0.5">
              No device connected
            </h2>
            <p className="text-xs text-[#9AA3AD] max-w-md">
              Pair another device to share files and text directly over an encrypted peer-to-peer link. No server, no account, nothing is uploaded.
            </p>
          </div>
        </div>

        {signalUnavailable && (
          <div className="mt-3 w-full rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-400" role="alert">
            <div className="font-semibold">Automatic pairing unavailable</div>
            <p className="mt-1 text-amber-400/90 leading-relaxed">
              The pairing service could not be reached, so one-scan automatic pairing is
              off right now. You can still pair with manual codes.
            </p>
            <button
              onClick={onCreatePairingManual}
              className="mt-2 inline-flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-500/25 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              <span>Use manual pairing code</span>
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 sm:self-center">
          <button
            onClick={() => openScanner('offer')}
            className="flex items-center gap-2 rounded-xl border border-white/[0.1] bg-[#15191E] px-4 py-2.5 text-xs font-medium text-[#F5F7F8] hover:bg-white/[0.08] hover:border-[#19C37D]/30 transition-all shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
          >
            <LogIn className="w-4 h-4 text-[#19C37D]" aria-hidden="true" />
            <span>Join pairing</span>
          </button>
          <button
            onClick={onCreatePairing}
            className="flex items-center gap-2 rounded-xl bg-[#19C37D] px-4 py-2.5 text-xs font-semibold text-[#0B0D0F] hover:bg-[#3DD6A0] transition-all shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#19C37D]"
          >
            <span>Create pairing</span>
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <p className="mt-4 text-[11px] text-[#9AA3AD]/80 leading-relaxed border-t border-white/[0.06] pt-3">
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
