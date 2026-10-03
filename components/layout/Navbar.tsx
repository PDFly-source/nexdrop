'use client';

import React, { useEffect } from 'react';
import { PWAInstallButton } from '@/components/ui/PWAInstallButton';
import { useInputModalities } from '@/hooks/useCapabilities';
import { Home, ArrowDownUp, MonitorSmartphone, Settings } from 'lucide-react';
import { ConnectionPhase, TransferDirection } from '@/types/session';

export type WorkspaceTab = 'home' | 'transfers' | 'devices' | 'settings';

interface NavbarProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  /** AUTHORITATIVE connection phase — the badge derives ONLY from this. */
  connectionPhase: ConnectionPhase;
  transferDirection?: TransferDirection | null;
  peerName?: string;
  peerPlatform?: string;
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
  connectionPhase,
  transferDirection,
  peerName,
  peerPlatform,
  onOpenConnectionDetails,
  onStartPairing,
}) => {
  // TV mode: larger type + stronger focus outlines when this browser runs
  // on a TV form factor (no touch, coarse pointer, large landscape screen).
  // Detected from what the browser actually exposes — never from OS class.
  const { tv } = useInputModalities();
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('tv-mode', tv);
  }, [tv]);
  /**
   * The badge is a pure function of the authoritative phase — NO local
   * re-derivation from raw states, so it can never contradict the actual
   * connection (e.g. "Not connected" while a transfer is verifiably running).
   */
  const livePhases: ConnectionPhase[] = ['connected', 'transferring', 'verifying', 'completed'];
  const isLive = livePhases.includes(connectionPhase);
  const isBusy =
    connectionPhase === 'connecting' ||
    connectionPhase === 'pairing' ||
    connectionPhase === 'waiting_for_peer' ||
    connectionPhase === 'incoming_request';

  const peerLabel = peerName || peerPlatform?.split(' · ')[0] || 'peer';
  const platformShort = peerPlatform?.split(' · ')[1] || '';
  let label: string;
  switch (connectionPhase) {
    case 'pairing':
      label = 'Waiting for receiver…';
      break;
    case 'waiting_for_peer':
      label = 'Waiting for peer…';
      break;
    case 'incoming_request':
      label = 'Incoming request…';
      break;
    case 'connecting':
      label = 'Connecting…';
      break;
    case 'connected':
    case 'completed':
      label = platformShort ? `${peerLabel} · ${platformShort}` : peerLabel;
      break;
    case 'transferring':
      label =
        transferDirection === 'incoming'
          ? `Receiving from ${peerLabel}`
          : `Sending to ${peerLabel}`;
      break;
    case 'verifying':
      label = 'Verifying…';
      break;
    case 'disconnected':
      label = 'Not connected';
      break;
    case 'failed':
      label = 'Connection failed';
      break;
    default:
      label = 'Ready';
  }

  const handleStatusBadgeClick = () => {
    if (isLive) {
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
            data-connection-phase={connectionPhase}
            title={connectionPhase === 'transferring' || connectionPhase === 'verifying' ? 'Transfer active over an open DataChannel' : undefined}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              isLive
                ? connectionPhase === 'transferring' || connectionPhase === 'verifying'
                  ? 'border-nd-teal/40 bg-nd-teal/10 text-nd-teal-bright'
                  : 'border-nd-success/30 bg-nd-success/10 text-nd-teal-bright hover:bg-nd-success/15'
                : isBusy
                ? 'border-nd-warning/30 bg-nd-warning/10 text-nd-warning hover:bg-nd-warning/15'
                : connectionPhase === 'failed'
                ? 'border-nd-coral/30 bg-nd-coral/10 text-nd-coral'
                : 'border-white/[0.08] bg-nd-surface text-nd-text-secondary hover:text-nd-text-primary hover:border-white/20'
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                isLive
                  ? 'bg-nd-teal animate-pulse'
                  : isBusy
                  ? 'bg-nd-warning animate-ping'
                  : 'bg-white/30'
              }`}
            />
            {connectionPhase === 'transferring' && (
              <span aria-hidden="true" className="text-nd-teal-bright">
                {transferDirection === 'incoming' ? '↓' : '↑'}
              </span>
            )}
            {isLive && connectionPhase !== 'transferring' && (
              <span aria-hidden="true" className="text-nd-teal-bright">●</span>
            )}
            <span className="text-[11px] sm:text-xs max-w-[10rem] sm:max-w-none truncate">{label}</span>
          </button>

          {/* PWA Install Button */}
          <PWAInstallButton />
        </div>
      </div>
    </header>
  );
};
