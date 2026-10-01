'use client';

import React, { useRef } from 'react';
import {
  ArrowUpFromLine,
  ArrowDownToLine,
  FolderOpen,
  Image as ImageIcon,
  Video,
  FileText,
  Package,
  ClipboardList,
  ChevronRight,
  ArrowUpRight,
  ArrowDownLeft,
  FileCheck,
  ShieldCheck,
} from 'lucide-react';
import { LocalHistoryItem } from '@/types/transfer';
import { SessionState } from '@/types/session';
import { formatBytes, formatTimestamp } from '@/lib/utils/format';
import { Reveal } from '@/components/ui/Reveal';

interface HomeWorkspaceProps {
  isConnected: boolean;
  peerName?: string;
  sessionState: SessionState;
  historyItems: LocalHistoryItem[];
  sendQueueCount: number;
  incomingCount: number;
  onBeginSend: () => void;
  onFilesSelected: (files: FileList | File[]) => void;
  /** Opens the Text & Clipboard sheet. */
  onOpenText: () => void;
  onNavigate: (tab: 'transfers' | 'devices' | 'settings') => void;
  /** Home → RECEIVE: opens the QR scanner directly. */
  onReceiveScan: () => void;
}

const QUICK_ACTIONS: {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  accept: string;
  hint: string;
}[] = [
  { id: 'files', label: 'Files', icon: FolderOpen, accept: '', hint: 'Any file type' },
  { id: 'photos', label: 'Photos', icon: ImageIcon, accept: 'image/*', hint: 'Images' },
  { id: 'videos', label: 'Videos', icon: Video, accept: 'video/*', hint: 'Video files' },
  { id: 'apps', label: 'Apps', icon: Package, accept: '.apk,.apks,.xapk,.aab,application/vnd.android.package-archive', hint: 'APK & packages' },
];

export const HomeWorkspace: React.FC<HomeWorkspaceProps> = ({
  isConnected,
  peerName,
  sessionState,
  historyItems,
  sendQueueCount,
  incomingCount,
  onFilesSelected,
  onOpenText,
  onBeginSend,
  onNavigate,
  onReceiveScan,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingAcceptRef = useRef<string>('');

  const openPicker = (accept: string) => {
    pendingAcceptRef.current = accept;
    if (fileInputRef.current) {
      fileInputRef.current.accept = accept;
      fileInputRef.current.click();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(e.target.files);
      onNavigate('transfers');
    }
    e.target.value = '';
  };

  const isPaired = isConnected || sessionState === 'transferring' || sessionState === 'completed';
  const recentItems = historyItems.slice(0, 5);

  return (
    <div className="space-y-6 text-left">
      {/* Hidden file picker driven by quick actions */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileChange}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />

      {/* ------------------------------------------------------------- */}
      {/* HERO — primary actions + live connection state                 */}
      {/* ------------------------------------------------------------- */}
      <section className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-nd-bg-1 p-6 sm:p-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.14]"
          style={{
            background: 'radial-gradient(ellipse 55% 45% at 50% -10%, rgba(24, 184, 166, 0.5), transparent 70%)',
          }}
        />

        <div className="relative">
          {/* Brand + live status */}
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-semibold tracking-[0.22em] uppercase text-nd-teal animate-in fade-in duration-300">
              Private · Direct · Fast
            </p>
            <span
              aria-live="polite"
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                isPaired
                  ? 'border-nd-success/30 bg-nd-success/10 text-nd-teal-bright'
                  : 'border-white/[0.1] bg-nd-surface text-nd-text-secondary'
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${isPaired ? 'bg-nd-teal animate-pulse' : 'bg-white/30'}`}
              />
              {isPaired ? peerName || 'Connected' : 'No device connected'}
            </span>
          </div>

          <p className="mt-3 text-[10px] font-semibold tracking-[0.25em] text-nd-teal animate-in fade-in duration-500">
            PRIVATE • DIRECT • FAST
          </p>
          <h2 className="mt-1.5 text-2xl sm:text-3xl font-semibold tracking-tight text-nd-text-primary text-balance animate-in fade-in slide-in-from-bottom-2 duration-500">
            Send directly.
            <br />
            <span className="text-nd-text-secondary">Keep it private.</span>
          </h2>
          <p className="mt-2 text-xs sm:text-sm text-nd-text-secondary max-w-md leading-relaxed animate-in fade-in duration-700">
            Share files &amp; text directly between your devices. Private by design — no cloud file uploads.
          </p>

          {/* Primary actions — the two strongest actions on Home */}
          <div className="mt-6 grid grid-cols-2 gap-3 max-w-md animate-in fade-in slide-in-from-bottom-2 duration-500">
            <button
              onClick={onBeginSend}
              className="nd-press group flex flex-col items-center justify-center gap-1 rounded-xl bg-nd-teal px-5 py-3.5 text-sm font-semibold text-nd-bg-0 hover:bg-nd-teal-bright transition-colors min-h-[56px] shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal focus-visible:ring-offset-2 focus-visible:ring-offset-nd-bg-0"
            >
              <span className="flex items-center gap-2">
                <ArrowUpFromLine className="w-4 h-4" aria-hidden="true" />
                <span>Send</span>
              </span>
              <span className="text-[10px] font-medium text-nd-bg-0/70">
                Photos, videos, files &amp; apps
              </span>
            </button>
            <button
              onClick={onReceiveScan}
              className="nd-press group flex flex-col items-center justify-center gap-1 rounded-xl border border-white/[0.12] bg-nd-surface px-5 py-3.5 text-sm font-semibold text-nd-text-primary hover:bg-nd-surface-elevated transition-colors min-h-[56px] focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal focus-visible:ring-offset-2 focus-visible:ring-offset-nd-bg-0"
            >
              <span className="flex items-center gap-2">
                <ArrowDownToLine className="w-4 h-4 text-nd-teal-bright" aria-hidden="true" />
                <span>Receive</span>
              </span>
              <span className="text-[10px] font-medium text-nd-text-secondary">
                Accept files from another device
              </span>
            </button>
          </div>

        </div>
      </section>

      {/* ------------------------------------------------------------- */}
      {/* QUICK ACTIONS                                                  */}
      {/* ------------------------------------------------------------- */}
      <section aria-labelledby="quick-actions-heading">
        <div className="flex items-center justify-between mb-3">
          <h3 id="quick-actions-heading" className="text-sm font-semibold text-nd-text-primary">
            Quick Actions
          </h3>
          {sendQueueCount + incomingCount > 0 && (
            <button
              onClick={() => onNavigate('transfers')}
              className="text-[11px] text-nd-teal-bright hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal rounded px-1"
            >
              {sendQueueCount} queued · {incomingCount} received
            </button>
          )}
        </div>

        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5">
          {QUICK_ACTIONS.map((action, index) => {
            const Icon = action.icon;
            return (
              <button
                key={action.id}
                onClick={() => openPicker(action.accept)}
                style={{ animationDelay: `${index * 40}ms` }}
                className="nd-press flex flex-col items-center gap-2 rounded-xl border border-white/[0.07] bg-nd-surface px-2 py-4 text-center hover:bg-nd-surface-elevated hover:border-white/[0.12] transition-colors min-h-[44px] animate-in fade-in slide-in-from-bottom-2 duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-nd-bg-1 border border-white/[0.06] text-nd-teal-bright">
                  <Icon className="w-4 h-4" aria-hidden="true" />
                </span>
                <span className="text-[11px] font-medium text-nd-text-primary">{action.label}</span>
              </button>
            );
          })}

          {/* Text */}
          <button
            onClick={onOpenText}
            style={{ animationDelay: '160ms' }}
            className="nd-press flex flex-col items-center gap-2 rounded-xl border border-white/[0.07] bg-nd-surface px-2 py-4 text-center hover:bg-nd-surface-elevated hover:border-white/[0.12] transition-colors min-h-[44px] animate-in fade-in slide-in-from-bottom-2 duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-nd-bg-1 border border-white/[0.06] text-nd-teal">
              <FileText className="w-4 h-4" aria-hidden="true" />
            </span>
            <span className="text-[11px] font-medium text-nd-text-primary">Text</span>
          </button>

          {/* Clipboard */}
          <button
            onClick={onOpenText}
            style={{ animationDelay: '200ms' }}
            className="nd-press flex flex-col items-center gap-2 rounded-xl border border-white/[0.07] bg-nd-surface px-2 py-4 text-center hover:bg-nd-surface-elevated hover:border-white/[0.12] transition-colors min-h-[44px] animate-in fade-in slide-in-from-bottom-2 duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-nd-bg-1 border border-white/[0.06] text-nd-coral">
              <ClipboardList className="w-4 h-4" aria-hidden="true" />
            </span>
            <span className="text-[11px] font-medium text-nd-text-primary">Clipboard</span>
          </button>
        </div>
      </section>

      {/* ------------------------------------------------------------- */}
      {/* RECENT TRANSFERS — real local history only                     */}
      {/* ------------------------------------------------------------- */}
      <section aria-labelledby="recent-heading">
        <div className="flex items-center justify-between mb-3">
          <h3 id="recent-heading" className="text-sm font-semibold text-nd-text-primary">
            Recent Transfers
          </h3>
          {historyItems.length > 0 && (
            <button
              onClick={() => onNavigate('transfers')}
              className="inline-flex items-center gap-0.5 text-[11px] text-nd-teal-bright hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal rounded px-1"
            >
              <span>View all</span>
              <ChevronRight className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
        </div>

        <Reveal>
        <div className="rounded-2xl border border-white/[0.08] bg-nd-surface">
          {recentItems.length === 0 ? (
            <div className="py-10 px-5 text-center">
              <ShieldCheck className="w-8 h-8 mx-auto mb-2 text-nd-text-secondary/30" aria-hidden="true" />
              <p className="text-xs font-medium text-nd-text-secondary">No transfers yet</p>
              <p className="text-[11px] mt-1 text-nd-text-secondary/80">
                When you send or receive files, they appear here — stored only on this device.
              </p>
              <button
                onClick={() => openPicker('')}
                className="mt-4 inline-flex items-center gap-2 rounded-xl bg-nd-teal px-4 py-2 text-xs font-semibold text-nd-bg-0 hover:bg-nd-teal-bright transition-colors min-h-[36px] focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
              >
                <ArrowUpFromLine className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Send your first file</span>
              </button>
            </div>
          ) : (
            <ul className="divide-y divide-white/[0.04]">
              {recentItems.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-4 px-4 py-3 text-xs">
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      aria-hidden="true"
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
                        item.direction === 'sent'
                          ? 'bg-nd-teal-bright/10 text-nd-teal-bright border-nd-teal-bright/20'
                          : 'bg-nd-success/10 text-nd-teal-bright border-nd-success/20'
                      }`}
                    >
                      {item.direction === 'sent' ? (
                        <ArrowUpRight className="w-4 h-4" />
                      ) : (
                        <ArrowDownLeft className="w-4 h-4" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-nd-text-primary max-w-[45vw] sm:max-w-xs">
                        {item.name}
                      </p>
                      <div className="flex items-center gap-1.5 text-[11px] text-nd-text-secondary mt-0.5">
                        <span>{formatBytes(item.size)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatTimestamp(item.timestamp)}</span>
                        {item.hashVerified === true && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-nd-teal inline-flex items-center gap-0.5">
                              <FileCheck className="w-3 h-3" aria-hidden="true" />
                              Verified
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <span
                    className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-medium uppercase border ${
                      item.status === 'completed'
                        ? 'bg-nd-success/10 text-nd-teal-bright border-nd-success/20'
                        : 'bg-nd-error/10 text-nd-error border-nd-error/20'
                    }`}
                  >
                    {item.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        </Reveal>
      </section>
    </div>
  );
};
