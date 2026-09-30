'use client';

import React from 'react';
import { MonitorSmartphone, Globe, Cpu } from 'lucide-react';
import { ConnectionStatusArea } from '@/components/transfer/ConnectionStatusArea';
import { DeviceInfo } from '@/lib/detection/capabilities';
import { SessionState, PeerInfo, PairingError } from '@/types/session';
import type { PairingQr } from '@/hooks/useNexDropSession';

interface DevicesWorkspaceProps {
  deviceInfo: DeviceInfo;
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
  joinRequestInfo: { deviceName: string; platform: string | null } | null;
  onSubmitAnswer: (code: string) => Promise<boolean>;
  onJoinWithOffer: (code: string) => Promise<boolean>;
  onAcceptPendingOffer: () => Promise<boolean>;
  onDeclinePendingOffer: () => void;
  onAcceptJoinRequest: () => Promise<boolean>;
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

export const DevicesWorkspace: React.FC<DevicesWorkspaceProps> = (props) => {
  const { deviceInfo, ...connectionProps } = props;

  return (
    <div className="space-y-6">
      {/* This device identity card */}
      <section
        aria-labelledby="this-device-heading"
        className="rounded-2xl border border-white/[0.08] bg-[#11171B] p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
      >
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#0B0F12] border border-white/[0.08] text-[#00D9B5]">
            <MonitorSmartphone className="w-5 h-5" aria-hidden="true" />
          </div>
          <div>
            <h2 id="this-device-heading" className="text-sm font-semibold text-[#F5F7F8]">
              This Device
            </h2>
            <p className="text-xs text-[#9AA7AE] mt-0.5">{deviceInfo.name}</p>
            <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[11px] text-[#9AA7AE]">
              <span className="inline-flex items-center gap-1">
                <Globe className="w-3 h-3" aria-hidden="true" />
                {deviceInfo.os}
              </span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1">
                <Cpu className="w-3 h-3" aria-hidden="true" />
                {deviceInfo.browser}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/*
        ConnectionStatusArea owns the full real pairing state machine:
        one-scan QR (host), scanner (joiner), host Accept/Decline of the
        join request, automatic WebRTC connect, connected details and
        disconnect. It is reused unchanged — the engine stays the source
        of truth.
      */}
      {/* Keyed by session state: each state-machine transition replays one
          subtle 200ms fade — the pairing state change is felt, not flashed. */}
      <div key={props.sessionState} className="animate-in fade-in duration-200">
        <ConnectionStatusArea {...connectionProps} />
      </div>
    </div>
  );
};
