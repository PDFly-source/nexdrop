'use client';

import React from 'react';
import Link from 'next/link';
import { PWAInstallButton } from '@/components/ui/PWAInstallButton';
import { ShieldCheck, Cpu, ArrowDownUp, Clipboard, History, Settings, Lock } from 'lucide-react';
import { SessionState } from '@/types/session';

export type WorkspaceTab = 'transfer' | 'clipboard' | 'history' | 'settings';

interface NavbarProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  sessionState: SessionState;
  peerName?: string;
  onOpenConnectionDetails?: () => void;
  onStartPairing?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  onTabChange,
  sessionState,
  peerName,
  onOpenConnectionDetails,
  onStartPairing,
}) => {
  const isConnected = sessionState === 'connected';
  const isConnecting = sessionState === 'connecting' || sessionState === 'signaling';
  const isReconnecting = sessionState === 'reconnecting';
  const isPairing = sessionState === 'pairing';

  const handleStatusBadgeClick = () => {
    if (isConnected) {
      onOpenConnectionDetails?.();
    } else {
      onStartPairing?.();
    }
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-white/[0.08] bg-[#0B0D0F]/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        {/* Zone 1: NexDrop Wordmark */}
        <div className="flex items-center gap-6">
          <button
            onClick={() => onTabChange('transfer')}
            className="flex items-center gap-2 group text-left"
          >
            <div className="relative flex h-7 w-7 items-center justify-center rounded-lg bg-[#15191E] border border-white/10 group-hover:border-emerald-500/40 transition-colors">
              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-none stroke-[#19C37D] stroke-[2.2]">
                <path d="M7 10l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12 5v14" strokeLinecap="round" />
                <path d="M17 14l-5 5-5-5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 3" />
              </svg>
            </div>
            <span className="text-base font-semibold tracking-tight text-[#F5F7F8]">
              NexDrop
            </span>
          </button>

          {/* Zone 2: Desktop Workspace Navigation Tabs */}
          <nav className="hidden md:flex items-center gap-1 bg-[#15191E]/60 p-1 rounded-xl border border-white/[0.06]">
            <button
              onClick={() => onTabChange('transfer')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'transfer'
                  ? 'bg-[#19C37D] text-[#0B0D0F] shadow-sm font-semibold'
                  : 'text-[#9AA3AD] hover:text-[#F5F7F8] hover:bg-white/[0.04]'
              }`}
            >
              Transfer
            </button>
            <button
              onClick={() => onTabChange('clipboard')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'clipboard'
                  ? 'bg-[#19C37D] text-[#0B0D0F] shadow-sm font-semibold'
                  : 'text-[#9AA3AD] hover:text-[#F5F7F8] hover:bg-white/[0.04]'
              }`}
            >
              Clipboard
            </button>
            <button
              onClick={() => onTabChange('history')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'history'
                  ? 'bg-[#19C37D] text-[#0B0D0F] shadow-sm font-semibold'
                  : 'text-[#9AA3AD] hover:text-[#F5F7F8] hover:bg-white/[0.04]'
              }`}
            >
              History
            </button>
            <button
              onClick={() => onTabChange('settings')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'settings'
                  ? 'bg-[#19C37D] text-[#0B0D0F] shadow-sm font-semibold'
                  : 'text-[#9AA3AD] hover:text-[#F5F7F8] hover:bg-white/[0.04]'
              }`}
            >
              Settings
            </button>
          </nav>
        </div>

        {/* Zone 3: Connection Status & Quick Actions */}
        <div className="flex items-center gap-2.5">
          {/* Connection status badge */}
          <button
            onClick={handleStatusBadgeClick}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              isConnected
                ? 'border-emerald-500/30 bg-emerald-500/10 text-[#3DD6A0] hover:bg-emerald-500/15'
                : isConnecting
                ? 'border-amber-500/30 bg-amber-500/10 text-[#F59E0B] hover:bg-amber-500/15'
                : isReconnecting
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                : isPairing
                ? 'border-[#19C37D]/30 bg-[#19C37D]/10 text-[#19C37D]'
                : 'border-white/[0.08] bg-[#15191E] text-[#9AA3AD] hover:text-[#F5F7F8] hover:border-white/20'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isConnected
                  ? 'bg-[#19C37D] animate-pulse'
                  : isConnecting
                  ? 'bg-[#F59E0B] animate-ping'
                  : isPairing
                  ? 'bg-[#19C37D] animate-ping'
                  : 'bg-white/30'
              }`}
            />
            <span className="text-[11px] sm:text-xs">
              {isConnected
                ? peerName || 'Connected'
                : isConnecting
                ? 'Connecting…'
                : isReconnecting
                ? 'Reconnecting…'
                : isPairing
                ? 'Waiting for Peer…'
                : 'Not connected'}
            </span>
          </button>

          {/* PWA Install Button */}
          <PWAInstallButton />
        </div>
      </div>
    </header>
  );
};
