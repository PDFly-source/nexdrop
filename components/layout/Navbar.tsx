'use client';

import React from 'react';
import { PWAInstallButton } from '@/components/ui/PWAInstallButton';
import { Home, ArrowDownUp, MonitorSmartphone, Settings } from 'lucide-react';
import { SessionState } from '@/types/session';

export type WorkspaceTab = 'home' | 'transfers' | 'devices' | 'settings';

interface NavbarProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  sessionState: SessionState;
  peerName?: string;
  onOpenConnectionDetails?: () => void;
  onStartPairing?: () => void;
}

const DESKTOP_TABS: { id: WorkspaceTab; label: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }> }[] = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'transfers', label: 'Transfers', icon: ArrowDownUp },
  { id: 'devices', label: 'Devices', icon: MonitorSmartphone },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  onTabChange,
  sessionState,
  peerName,
  onOpenConnectionDetails,
  onStartPairing,
}) => {
  const isConnected = sessionState === 'connected';
  const isConnecting = sessionState === 'connecting';
  const isReconnecting = sessionState === 'disconnected';
  const isPairing = sessionState === 'hosting-offer' || sessionState === 'joiner-answer';

  const handleStatusBadgeClick = () => {
    if (isConnected) {
      onOpenConnectionDetails?.();
    } else {
      onStartPairing?.();
    }
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-white/[0.08] bg-[#070A0D]/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        {/* Zone 1: NexDrop Wordmark */}
        <div className="flex items-center gap-6">
          <button
            onClick={() => onTabChange('home')}
            aria-label="NexDrop home"
            className="flex items-center gap-2 group text-left"
          >
            <div className="relative flex h-7 w-7 items-center justify-center rounded-lg bg-[#11171B] border border-white/10 group-hover:border-emerald-400/40 transition-colors">
              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-none stroke-[#00F5A0] stroke-[2.2]">
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
          <nav aria-label="Workspace" className="hidden md:flex items-center gap-1 bg-[#11171B]/60 p-1 rounded-xl border border-white/[0.06]">
            {DESKTOP_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => onTabChange(tab.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    isActive
                      ? 'bg-[#00F5A0] text-[#070A0D] shadow-sm font-semibold'
                      : 'text-[#9AA7AE] hover:text-[#F5F7F8] hover:bg-white/[0.04]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Zone 3: Connection Status & Quick Actions */}
        <div className="flex items-center gap-2.5">
          {/* Connection status badge */}
          <button
            onClick={handleStatusBadgeClick}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              isConnected
                ? 'border-emerald-400/30 bg-emerald-400/10 text-[#00D9B5] hover:bg-emerald-400/15'
                : isConnecting
                ? 'border-amber-500/30 bg-amber-500/10 text-[#FFB84D] hover:bg-amber-500/15'
                : isReconnecting
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                : isPairing
                ? 'border-[#00F5A0]/30 bg-[#00F5A0]/10 text-[#00F5A0]'
                : 'border-white/[0.08] bg-[#11171B] text-[#9AA7AE] hover:text-[#F5F7F8] hover:border-white/20'
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                isConnected
                  ? 'bg-[#00F5A0] animate-pulse'
                  : isConnecting
                  ? 'bg-[#FFB84D] animate-ping'
                  : isPairing
                  ? 'bg-[#00F5A0] animate-ping'
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
