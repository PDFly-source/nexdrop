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
    <header className="sticky top-0 z-40 w-full border-b border-white/[0.08] bg-nd-bg-0/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        {/* Zone 1: NexDrop Wordmark */}
        <div className="flex items-center gap-6">
          <button
            onClick={() => onTabChange('home')}
            aria-label="NexDrop home"
            className="flex items-center gap-2 group text-left"
          >
            <div className="relative flex h-7 w-7 items-center justify-center rounded-lg bg-nd-surface border border-white/10 group-hover:border-nd-teal/40 transition-colors">
              <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-nd-coral/80" />
              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-none stroke-nd-teal stroke-[2.2]">
                <path d="M7 10l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12 5v14" strokeLinecap="round" />
                <path d="M17 14l-5 5-5-5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 3" />
              </svg>
            </div>
            <span className="text-base font-semibold tracking-tight text-nd-text-primary">
              NexDrop
            </span>
          </button>

          {/* Zone 2: Desktop Workspace Navigation Tabs */}
          <nav aria-label="Workspace" className="hidden md:flex items-center gap-1 bg-nd-surface/60 p-1 rounded-xl border border-white/[0.06]">
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
                      ? 'bg-nd-teal text-nd-bg-0 shadow-sm font-semibold'
                      : 'text-nd-text-secondary hover:text-nd-text-primary hover:bg-white/[0.04]'
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
                ? 'border-nd-success/30 bg-nd-success/10 text-nd-teal-bright hover:bg-nd-success/15'
                : isConnecting
                ? 'border-nd-warning/30 bg-nd-warning/10 text-nd-warning hover:bg-nd-warning/15'
                : isReconnecting
                ? 'border-nd-warning/30 bg-nd-warning/10 text-nd-warning'
                : isPairing
                ? 'border-nd-teal/30 bg-nd-teal/10 text-nd-teal'
                : 'border-white/[0.08] bg-nd-surface text-nd-text-secondary hover:text-nd-text-primary hover:border-white/20'
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                isConnected
                  ? 'bg-nd-teal animate-pulse'
                  : isConnecting
                  ? 'bg-nd-warning animate-ping'
                  : isPairing
                  ? 'bg-nd-teal animate-ping'
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
