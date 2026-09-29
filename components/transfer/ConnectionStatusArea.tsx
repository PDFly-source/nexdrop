'use client';

import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  Wifi,
  WifiOff,
  QrCode,
  KeyRound,
  ShieldCheck,
  Shield,
  Clock,
  ArrowRight,
  RefreshCw,
  PowerOff,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Smartphone,
  Laptop,
  Activity,
  Lock,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { SessionState, PeerInfo } from '@/types/session';
import { copyToClipboard } from '@/lib/clipboard';

interface ConnectionStatusAreaProps {
  sessionState: SessionState;
  sessionId: string | null;
  pin: string | null;
  qrPayload: string;
  peerInfo: PeerInfo | null;
  sasCode: string;
  isSecurityVerified: boolean;
  rttMs: number | null;
  onOpenScanner: () => void;
  onOpenPinModal: () => void;
  onCreateSession: () => void;
  onDisconnect: () => void;
  onOpenSecurityModal: () => void;
}

export const ConnectionStatusArea: React.FC<ConnectionStatusAreaProps> = ({
  sessionState,
  sessionId,
  pin,
  qrPayload,
  peerInfo,
  sasCode,
  isSecurityVerified,
  rttMs,
  onOpenScanner,
  onOpenPinModal,
  onCreateSession,
  onDisconnect,
  onOpenSecurityModal,
}) => {
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [copiedPin, setCopiedPin] = useState<boolean>(false);
  const [isDetailsOpen, setIsDetailsOpen] = useState<boolean>(false);

  // Expiry countdown timer (starts at 15m = 900s)
  const [secondsRemaining, setSecondsRemaining] = useState<number>(900);

  useEffect(() => {
    if (sessionState !== 'pairing') return;

    const expiresAt = Date.now() + 15 * 60 * 1000;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      setSecondsRemaining(left);
    }, 1000);

    return () => clearInterval(timer);
  }, [sessionState, sessionId]);

  // Generate dynamic QR image when payload changes
  useEffect(() => {
    let isMounted = true;
    if (!qrPayload) return;

    QRCode.toDataURL(qrPayload, {
      width: 200,
      margin: 1,
      color: {
        dark: '#F5F7F8',
        light: '#111418',
      },
    })
      .then((url) => {
        if (isMounted) setQrDataUrl(url);
      })
      .catch((e) => console.error('QR code generation error:', e));

    return () => {
      isMounted = false;
    };
  }, [qrPayload]);

  const handleCopyLink = async () => {
    if (!pin) return;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const shareUrl = `${origin}/?pin=${pin}`;
    const ok = await copyToClipboard(shareUrl);
    if (ok) {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  const handleCopyPin = async () => {
    if (!pin) return;
    const ok = await copyToClipboard(pin);
    if (ok) {
      setCopiedPin(true);
      setTimeout(() => setCopiedPin(false), 2000);
    }
  };

  const formatTimer = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // State 1: CONNECTED
  if (sessionState === 'connected') {
    return (
      <div className="rounded-2xl border border-emerald-500/25 bg-[#111418] p-4 sm:p-5 shadow-sm transition-all">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-[#19C37D]">
              <Smartphone className="w-5 h-5" />
              <span className="absolute -top-1 -right-1 flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-[#19C37D]" />
              </span>
            </div>

            <div>
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-[#19C37D]">
                  <span className="h-2 w-2 rounded-full bg-[#19C37D] animate-pulse" />
                  Connected
                </span>
                <span className="text-white/20">·</span>
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400/90 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                  <Lock className="w-2.5 h-2.5" />
                  P2P • Encrypted
                </span>
              </div>

              <div className="flex items-baseline gap-2 mt-0.5">
                <h3 className="text-base sm:text-lg font-semibold text-[#F5F7F8]">
                  {peerInfo?.name || 'Remote Device'}
                </h3>
                <span className="text-xs text-[#9AA3AD]">
                  {peerInfo?.platform || 'WebRTC Peer'}
                </span>
              </div>
            </div>
          </div>

          {/* Right Action & Stats */}
          <div className="flex items-center gap-2 sm:self-center">
            {rttMs !== null && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-[#15191E] text-[11px] text-[#9AA3AD]">
                <Activity className="w-3 h-3 text-[#19C37D]" />
                <span>RTT {rttMs} ms</span>
              </div>
            )}

            <button
              onClick={() => setIsDetailsOpen(!isDetailsOpen)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-[#15191E] text-xs text-[#9AA3AD] hover:text-[#F5F7F8] hover:border-white/20 transition-colors"
            >
              <span>Details</span>
              {isDetailsOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>

            <button
              onClick={onDisconnect}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/20 bg-red-500/10 text-xs font-medium text-red-400 hover:bg-red-500/20 transition-colors"
              title="Disconnect current session"
            >
              <PowerOff className="w-3.5 h-3.5" />
              <span>Disconnect</span>
            </button>
          </div>
        </div>

        {/* Expandable Technical & Security Details Panel */}
        {isDetailsOpen && (
          <div className="mt-4 pt-4 border-t border-white/[0.06] grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-[#9AA3AD] animate-in fade-in duration-150">
            <div className="rounded-xl bg-[#15191E] border border-white/[0.06] p-3">
              <span className="text-[10px] uppercase font-mono tracking-wider text-[#9AA3AD]/60 block mb-1">
                Security & Encryption
              </span>
              <div className="flex items-center gap-2 text-[#F5F7F8] font-medium">
                <ShieldCheck className="w-4 h-4 text-[#19C37D]" />
                <span>DTLS-SRTP E2EE</span>
              </div>
              <p className="text-[11px] text-[#9AA3AD]/80 mt-1">Direct browser-to-browser encrypted DataChannel</p>
            </div>

            <div className="rounded-xl bg-[#15191E] border border-white/[0.06] p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] uppercase font-mono tracking-wider text-[#9AA3AD]/60">
                  SAS Verification Code
                </span>
                {isSecurityVerified && (
                  <span className="text-[10px] text-[#19C37D] font-medium">Verified</span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-bold text-[#19C37D] tracking-wider">
                  {sasCode}
                </span>
                <button
                  onClick={onOpenSecurityModal}
                  className="text-[11px] text-[#3DD6A0] hover:underline"
                >
                  Verify
                </button>
              </div>
              <p className="text-[11px] text-[#9AA3AD]/80 mt-1">Compare this number with other screen</p>
            </div>

            <div className="rounded-xl bg-[#15191E] border border-white/[0.06] p-3">
              <span className="text-[10px] uppercase font-mono tracking-wider text-[#9AA3AD]/60 block mb-1">
                Active Channels
              </span>
              <div className="flex flex-wrap gap-1 text-[10px] font-mono text-[#F5F7F8]">
                <span className="px-1.5 py-0.5 rounded bg-white/[0.06]">control</span>
                <span className="px-1.5 py-0.5 rounded bg-white/[0.06]">file</span>
                <span className="px-1.5 py-0.5 rounded bg-white/[0.06]">clipboard</span>
                <span className="px-1.5 py-0.5 rounded bg-white/[0.06]">text</span>
              </div>
              <p className="text-[11px] text-[#9AA3AD]/80 mt-1">Direct memory-guarded WebRTC transport</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  // State 2: CONNECTING / SIGNALING
  if (sessionState === 'connecting' || sessionState === 'signaling') {
    return (
      <div className="rounded-2xl border border-amber-500/25 bg-[#111418] p-5 shadow-sm text-left">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                  <span className="h-2 w-2 rounded-full bg-amber-400 animate-ping" />
                  Connecting securely…
                </span>
              </div>
              <h3 className="text-base font-semibold text-[#F5F7F8] mt-0.5">
                Negotiating WebRTC Peer Connection
              </h3>
              <p className="text-xs text-[#9AA3AD]">Exchanging SDP offer/answer &amp; ICE candidates over temporary relay</p>
            </div>
          </div>

          <button
            onClick={onDisconnect}
            className="self-start sm:self-center px-3 py-1.5 rounded-lg border border-white/[0.08] bg-[#15191E] text-xs text-[#9AA3AD] hover:text-[#F5F7F8]"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // State 3: RECONNECTING
  if (sessionState === 'reconnecting') {
    return (
      <div className="rounded-2xl border border-amber-500/30 bg-[#111418] p-5 shadow-sm text-left">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
              <RefreshCw className="w-5 h-5 animate-spin" />
            </div>
            <div>
              <span className="text-xs font-semibold text-amber-400">Connection interrupted</span>
              <h3 className="text-base font-semibold text-[#F5F7F8] mt-0.5">
                Reconnecting with ICE restart…
              </h3>
              <p className="text-xs text-[#9AA3AD]">Your session is preserved. Attempting peer re-negotiation.</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onDisconnect}
              className="px-3 py-1.5 rounded-lg border border-red-500/20 bg-red-500/10 text-xs text-red-400 hover:bg-red-500/20"
            >
              Reset Session
            </button>
          </div>
        </div>
      </div>
    );
  }

  // State 4: DISCONNECTED
  if (sessionState === 'disconnected') {
    return (
      <div className="rounded-2xl border border-red-500/20 bg-[#111418] p-5 shadow-sm text-left">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-red-500/10 border border-red-500/30 text-red-400">
              <WifiOff className="w-5 h-5" />
            </div>
            <div>
              <span className="text-xs font-semibold text-red-400">Device disconnected</span>
              <h3 className="text-base font-semibold text-[#F5F7F8] mt-0.5">
                The peer session has ended
              </h3>
              <p className="text-xs text-[#9AA3AD]">You can reconnect or start a fresh pairing session.</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onCreateSession}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#19C37D] text-xs font-medium text-[#0B0D0F] hover:bg-[#3DD6A0] transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>New Session</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // State 5: PAIRING (Waiting for device...)
  if (sessionState === 'pairing') {
    return (
      <div className="rounded-2xl border border-white/[0.08] bg-[#111418] p-5 sm:p-6 shadow-sm text-left">
        <div className="flex flex-col md:flex-row gap-6 items-center">
          {/* QR Code Container */}
          <div className="shrink-0 flex flex-col items-center">
            <div className="relative rounded-2xl bg-[#15191E] p-3 border border-white/[0.08] shadow-inner">
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrDataUrl}
                  alt="Pairing QR Code"
                  className="w-40 h-40 sm:w-44 sm:h-44 rounded-xl object-contain"
                />
              ) : (
                <div className="w-40 h-40 sm:w-44 sm:h-44 flex items-center justify-center text-xs text-[#9AA3AD]">
                  <Loader2 className="w-6 h-6 animate-spin text-[#19C37D]" />
                </div>
              )}
            </div>
            <span className="text-[11px] text-[#9AA3AD] mt-2 flex items-center gap-1">
              <QrCode className="w-3 h-3 text-[#19C37D]" />
              Scan with second device camera
            </span>
          </div>

          {/* Pairing Info & PIN */}
          <div className="flex-1 w-full space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-[#19C37D] animate-ping" />
                <span className="text-xs font-semibold text-[#19C37D]">Waiting for device…</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-[#9AA3AD] font-mono bg-white/[0.04] px-2.5 py-1 rounded-md">
                <Clock className="w-3.5 h-3.5 text-amber-400" />
                <span>Expires in {formatTimer(secondsRemaining)}</span>
              </div>
            </div>

            <div>
              <p className="text-xs text-[#9AA3AD]">Or enter this 6-digit PIN on the other device:</p>
              <div className="flex items-center gap-3 mt-1.5">
                <div className="flex items-center tracking-widest text-2xl sm:text-3xl font-mono font-bold text-[#F5F7F8] bg-[#15191E] px-4 py-2 rounded-xl border border-white/[0.08]">
                  {pin ? `${pin.slice(0, 3)} ${pin.slice(3, 6)}` : '------'}
                </div>
                <button
                  onClick={handleCopyPin}
                  className="flex h-11 items-center gap-1.5 px-3 rounded-xl border border-white/[0.08] bg-[#15191E] text-xs text-[#9AA3AD] hover:text-[#F5F7F8] hover:border-white/20 transition-colors"
                >
                  {copiedPin ? <Check className="w-4 h-4 text-[#19C37D]" /> : <Copy className="w-4 h-4" />}
                  <span>{copiedPin ? 'Copied' : 'Copy PIN'}</span>
                </button>
              </div>
            </div>

            {/* Quick Actions */}
            <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-white/[0.06]">
              <button
                onClick={handleCopyLink}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-[#15191E] text-xs text-[#9AA3AD] hover:text-[#F5F7F8] transition-colors"
              >
                {copiedLink ? <Check className="w-3.5 h-3.5 text-[#19C37D]" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedLink ? 'Link Copied' : 'Copy Pairing Link'}</span>
              </button>

              <button
                onClick={onOpenScanner}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-[#15191E] text-xs text-[#9AA3AD] hover:text-[#19C37D] transition-colors"
              >
                <QrCode className="w-3.5 h-3.5" />
                <span>Scan Other Device</span>
              </button>

              <button
                onClick={onOpenPinModal}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-[#15191E] text-xs text-[#9AA3AD] hover:text-[#19C37D] transition-colors"
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span>Enter Peer PIN</span>
              </button>

              <button
                onClick={onDisconnect}
                className="ml-auto text-xs text-[#9AA3AD] hover:text-red-400 transition-colors px-2 py-1.5"
              >
                Cancel Session
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // State 6: NOT CONNECTED (idle) - The default initial focused state!
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#111418] p-5 sm:p-6 shadow-sm text-left">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
        <div className="flex items-center gap-3.5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.04] border border-white/[0.08] text-[#9AA3AD]">
            <Wifi className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-[#9AA3AD]">
                <span className="h-2 w-2 rounded-full bg-white/30" />
                Not connected
              </span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold text-[#F5F7F8] mt-0.5">
              No device connected
            </h3>
            <p className="text-xs text-[#9AA3AD]">
              Connect another device to start sharing files and clipboard directly over private WebRTC.
            </p>
          </div>
        </div>

        {/* Pairing Actions: Scan QR, Enter PIN, Create Session */}
        <div className="flex flex-wrap items-center gap-2 sm:self-center">
          <button
            onClick={onOpenScanner}
            className="flex items-center gap-2 rounded-xl border border-white/[0.1] bg-[#15191E] px-4 py-2.5 text-xs font-medium text-[#F5F7F8] hover:bg-white/[0.08] hover:border-[#19C37D]/30 transition-all shadow-sm"
          >
            <QrCode className="w-4 h-4 text-[#19C37D]" />
            <span>Scan QR</span>
          </button>

          <button
            onClick={onOpenPinModal}
            className="flex items-center gap-2 rounded-xl border border-white/[0.1] bg-[#15191E] px-4 py-2.5 text-xs font-medium text-[#F5F7F8] hover:bg-white/[0.08] hover:border-[#19C37D]/30 transition-all shadow-sm"
          >
            <KeyRound className="w-4 h-4 text-emerald-400" />
            <span>Enter PIN</span>
          </button>

          <button
            onClick={onCreateSession}
            className="flex items-center gap-2 rounded-xl bg-[#19C37D] px-4 py-2.5 text-xs font-medium text-[#0B0D0F] hover:bg-[#3DD6A0] transition-all shadow-sm font-semibold"
          >
            <span>Create Session</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
