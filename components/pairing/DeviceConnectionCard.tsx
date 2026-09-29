'use client';

import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  QrCode,
  KeyRound,
  ShieldCheck,
  CheckCircle2,
  Share2,
  Copy,
  Check,
  Radio,
  ArrowRight,
  PowerOff,
  Sparkles,
} from 'lucide-react';
import { SessionState, PeerInfo } from '@/types/session';
import { QrScannerModal } from './QrScannerModal';
import { copyToClipboard } from '@/lib/clipboard';

interface DeviceConnectionCardProps {
  sessionState: SessionState;
  sessionId: string | null;
  pin: string | null;
  qrPayload: string;
  peerInfo: PeerInfo | null;
  sasCode: string;
  isSecurityVerified: boolean;
  onOpenSecurityModal: () => void;
  onCreateSession: () => void;
  onJoinByPin: (pin: string) => Promise<boolean>;
  onJoinByQr: (payload: string) => Promise<boolean>;
  onDisconnect: () => void;
}

export const DeviceConnectionCard: React.FC<DeviceConnectionCardProps> = ({
  sessionState,
  sessionId,
  pin,
  qrPayload,
  peerInfo,
  sasCode,
  isSecurityVerified,
  onOpenSecurityModal,
  onCreateSession,
  onJoinByPin,
  onJoinByQr,
  onDisconnect,
}) => {
  const [activeTab, setActiveTab] = useState<'create' | 'pin'>('create');
  const [inputPin, setInputPin] = useState<string>('');
  const [isJoining, setIsJoining] = useState<boolean>(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [isScannerOpen, setIsScannerOpen] = useState<boolean>(false);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  const isConnected = sessionState === 'connected';

  // Generate QR image whenever qrPayload changes
  useEffect(() => {
    let active = true;
    if (!qrPayload) return;

    QRCode.toDataURL(qrPayload, {
      width: 220,
      margin: 1,
      color: {
        dark: '#F5F7F8',
        light: '#111418',
      },
    })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch((e) => console.error('QR generation error:', e));

    return () => {
      active = false;
    };
  }, [qrPayload]);

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inputPin.trim().length !== 6) return;

    setJoinError(null);
    setIsJoining(true);
    const ok = await onJoinByPin(inputPin.trim());
    setIsJoining(false);
    if (!ok) {
      setJoinError('Invalid or expired PIN code. Please verify and retry.');
    }
  };

  const handleCopyDirectLink = async () => {
    if (!pin) return;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const shareUrl = `${origin}/?pin=${pin}`;
    const ok = await copyToClipboard(shareUrl);
    if (ok) {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  // Connected State Card
  if (isConnected) {
    return (
      <div className="rounded-xl border border-white/[0.08] bg-[#15191E] p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#19C37D] opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#19C37D]" />
            </span>
            <h2 className="text-sm font-semibold text-[#F5F7F8]">Device Connected</h2>
          </div>

          <button
            onClick={onDisconnect}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors"
            title="Terminate P2P session"
          >
            <PowerOff className="w-3.5 h-3.5" />
            <span>Disconnect</span>
          </button>
        </div>

        <div className="mt-4 rounded-lg border border-white/[0.06] bg-[#111418] p-3.5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-semibold text-[#F5F7F8]">
                {peerInfo?.name || 'Connected Peer'}
              </p>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-[#9AA3AD]">
                <span>{peerInfo?.platform || 'Direct Peer'}</span>
                <span>·</span>
                <span className="text-[#3DD6A0]">P2P / WebRTC</span>
                <span>·</span>
                <span>Transport Encrypted</span>
              </div>
            </div>

            <div className="flex items-center gap-1 text-[11px]">
              {isSecurityVerified ? (
                <div className="flex items-center gap-1 text-[#22C55E]">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span className="font-mono">{sasCode}</span>
                </div>
              ) : (
                <button
                  onClick={onOpenSecurityModal}
                  className="flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-[#F59E0B] hover:bg-amber-500/20"
                >
                  <ShieldCheck className="w-3 h-3" />
                  <span>Verify ({sasCode})</span>
                </button>
              )}
            </div>
          </div>
        </div>

        <p className="mt-3 text-[11px] text-[#9AA3AD]">
          Direct peer connection active. You can now drag and drop files or synchronize clipboard items.
        </p>
      </div>
    );
  }

  // Pairing / Connecting / Idle State Card
  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#15191E] p-5 shadow-sm">
      <div className="flex items-center justify-between pb-3 border-b border-white/[0.06]">
        <div>
          <h2 className="text-sm font-semibold text-[#F5F7F8]">Connect a device</h2>
          <p className="text-xs text-[#9AA3AD] mt-0.5">Pair two browsers directly using QR or 6-digit PIN</p>
        </div>

        <button
          onClick={() => setIsScannerOpen(true)}
          className="flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-[#1B2026] px-3 py-1.5 text-xs font-medium text-[#F5F7F8] hover:bg-white/[0.08] hover:border-white/20 transition-colors"
        >
          <QrCode className="w-3.5 h-3.5 text-[#19C37D]" />
          <span>Scan QR</span>
        </button>
      </div>

      {/* Tabs: Display QR & PIN vs Enter PIN */}
      <div className="mt-4 flex items-center gap-1 p-1 bg-[#111418] rounded-lg">
        <button
          onClick={() => setActiveTab('create')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
            activeTab === 'create'
              ? 'bg-[#1B2026] text-[#F5F7F8] shadow-sm'
              : 'text-[#9AA3AD] hover:text-[#F5F7F8]'
          }`}
        >
          <QrCode className="w-3.5 h-3.5" />
          <span>Show QR & PIN</span>
        </button>

        <button
          onClick={() => setActiveTab('pin')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
            activeTab === 'pin'
              ? 'bg-[#1B2026] text-[#F5F7F8] shadow-sm'
              : 'text-[#9AA3AD] hover:text-[#F5F7F8]'
          }`}
        >
          <KeyRound className="w-3.5 h-3.5" />
          <span>Enter PIN</span>
        </button>
      </div>

      {activeTab === 'create' ? (
        <div className="mt-4 flex flex-col sm:flex-row items-center gap-5">
          {/* QR Code Container */}
          <div className="flex flex-col items-center justify-center p-3 rounded-xl bg-[#111418] border border-white/[0.06] shrink-0">
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt="NexDrop Pairing QR Code"
                className="w-36 h-36 rounded-lg"
              />
            ) : (
              <div className="w-36 h-36 flex flex-col items-center justify-center gap-2 text-[#9AA3AD]">
                <Radio className="w-6 h-6 animate-pulse text-[#19C37D]" />
                <span className="text-[11px]">Creating session...</span>
              </div>
            )}
          </div>

          {/* PIN & Direct Link Controls */}
          <div className="flex-1 w-full text-left">
            <p className="text-[11px] text-[#9AA3AD]">Or enter this 6-digit code on the other device:</p>
            <div className="mt-2 flex items-center gap-3">
              <span className="font-mono text-2xl font-bold tracking-widest text-[#19C37D]">
                {pin ? `${pin.slice(0, 3)} ${pin.slice(3)}` : '••••••'}
              </span>

              <button
                onClick={onCreateSession}
                className="text-[11px] text-[#9AA3AD] hover:text-[#F5F7F8] underline"
                title="Generate new temporary pairing session"
              >
                New Session
              </button>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                onClick={handleCopyDirectLink}
                disabled={!pin}
                className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#111418] px-3 py-1.5 text-xs text-[#F5F7F8] hover:bg-white/[0.04] transition-colors disabled:opacity-50"
              >
                {copiedLink ? <Check className="w-3.5 h-3.5 text-[#22C55E]" /> : <Copy className="w-3.5 h-3.5 text-[#9AA3AD]" />}
                <span>{copiedLink ? 'Link Copied' : 'Copy Direct Link'}</span>
              </button>
            </div>

            <p className="mt-3 text-[11px] text-[#9AA3AD] leading-relaxed">
              Open NexDrop on phone, laptop, or tablet. Point camera at QR or enter 6-digit PIN. Session expires automatically.
            </p>
          </div>
        </div>
      ) : (
        <form onSubmit={handlePinSubmit} className="mt-4">
          <p className="text-xs text-[#9AA3AD]">
            Enter the 6-digit code shown on the other device:
          </p>

          <div className="mt-3 flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={inputPin}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '');
                setInputPin(val);
                setJoinError(null);
              }}
              placeholder="e.g. 482913"
              className="w-full rounded-lg border border-white/[0.12] bg-[#111418] px-4 py-2.5 font-mono text-lg tracking-widest text-[#F5F7F8] placeholder:text-[#9AA3AD]/40 focus:border-[#19C37D] focus:outline-none"
            />

            <button
              type="submit"
              disabled={inputPin.length !== 6 || isJoining}
              className="flex items-center gap-1.5 rounded-lg bg-[#19C37D] px-4 py-2.5 text-xs font-semibold text-[#0B0D0F] hover:bg-[#3DD6A0] disabled:opacity-40 transition-colors whitespace-nowrap"
            >
              <span>{isJoining ? 'Pairing...' : 'Connect'}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {joinError && (
            <p className="mt-2 text-xs text-[#EF4444]">{joinError}</p>
          )}

          <p className="mt-3 text-[11px] text-[#9AA3AD]">
            PINs are cryptographically random, ephemeral, and invalidated after pairing.
          </p>
        </form>
      )}

      {/* Camera QR Scanner Modal */}
      <QrScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        onScanSuccess={(scanned) => {
          onJoinByQr(scanned);
        }}
      />
    </div>
  );
};
