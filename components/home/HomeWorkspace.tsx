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
  QrCode,
} from 'lucide-react';
import { LocalHistoryItem } from '@/types/transfer';
import { SessionState } from '@/types/session';
import { formatBytes, formatTimestamp } from '@/lib/utils/format';

interface HomeWorkspaceProps {
  isConnected: boolean;
  peerName?: string;
  sessionState: SessionState;
  historyItems: LocalHistoryItem[];
  sendQueueCount: number;
  incomingCount: number;
  onFilesSelected: (files: FileList | File[]) => void;
  /** Opens the Text & Clipboard sheet. */
  onOpenText: () => void;
  onNavigate: (tab: 'transfers' | 'devices' | 'settings') => void;
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
  onNavigate,
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
      <section className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0B0F12] p-6 sm:p-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.14]"
          style={{
            background: 'radial-gradient(ellipse 55% 45% at 50% -10%, rgba(0, 245, 160, 0.5), transparent 70%)',
          }}
        />

        <div className="relative">
          {/* Brand + live status */}
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-semibold tracking-[0.22em] uppercase text-[#00F5A0]">
              Private · Direct · Fast
            </p>
            <span
              aria-live="polite"
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                isPaired
                  ? 'border-emerald-400/30 bg-emerald-400/10 text-[#00D9B5]'
                  : 'border-white/[0.1] bg-[#11171B] text-[#9AA7AE]'
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${isPaired ? 'bg-[#00F5A0] animate-pulse' : 'bg-white/30'}`}
              />
              {isPaired ? peerName || 'Connected' : 'No device connected'}
            </span>
          </div>

          <h2 className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight text-[#F5F7F8] text-balance">
            Send directly.
            <br />
            <span className="text-[#9AA7AE]">Keep it private.</span>
          </h2>
          <p className="mt-2 text-xs sm:text-sm text-[#9AA7AE] max-w-md leading-relaxed">
            Share files &amp; text directly between your devices. Private by design — no cloud file uploads.
          </p>

          {/* Primary actions */}
          <div className="mt-6 grid grid-cols-2 gap-3 max-w-md">
            <button
              onClick={() => openPicker('')}
              className="group flex items-center justify-center gap-2 rounded-xl bg-[#00F5A0] px-5 py-3.5 text-sm font-semibold text-[#070A0D] hover:bg-[#00D9B5] active:scale-[0.98] transition-all min-h-[44px] shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00F5A0] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B0F12]"
            >
              <ArrowUpFromLine className="w-4 h-4" aria-hidden="true" />
              <span>Send</span>
            </button>
            <button
              onClick={() => onNavigate('devices')}
              className="group flex items-center justify-center gap-2 rounded-xl border border-white/[0.12] bg-[#11171B] px-5 py-3.5 text-sm font-semibold text-[#F5F7F8] hover:bg-[#172027] active:scale-[0.98] transition-all min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00F5A0] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B0F12]"
            >
              <ArrowDownToLine className="w-4 h-4 text-[#9AA7AE]" aria-hidden="true" />
              <span>Receive</span>
            </button>
          </div>

          {/* Device pairing shortcut */}
          {!isPaired && (
            <button
              onClick={() => onNavigate('devices')}
              className="mt-4 inline-flex items-center gap-2 text-xs text-[#00D9B5] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00F5A0] rounded px-1"
            >
              <QrCode className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Connect a device — one-scan QR pairing</span>
            </button>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------- */}
      {/* QUICK ACTIONS                                                  */}
      {/* ------------------------------------------------------------- */}
      <section aria-labelledby="quick-actions-heading">
        <div className="flex items-center justify-between mb-3">
          <h3 id="quick-actions-heading" className="text-sm font-semibold text-[#F5F7F8]">
            Quick Actions
          </h3>
          {sendQueueCount + incomingCount > 0 && (
            <button
              onClick={() => onNavigate('transfers')}
              className="text-[11px] text-[#00D9B5] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00F5A0] rounded px-1"
            >
              {sendQueueCount} queued · {incomingCount} received
            </button>
          )}
        </div>

        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5">
          {QUICK_ACTIONS.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.id}
                onClick={() => openPicker(action.accept)}
                className="flex flex-col items-center gap-2 rounded-xl border border-white/[0.07] bg-[#11171B] px-2 py-4 text-center hover:bg-[#172027] hover:border-white/[0.12] active:scale-[0.97] transition-all min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00F5A0]"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0B0F12] border border-white/[0.06] text-[#00D9B5]">
                  <Icon className="w-4 h-4" aria-hidden="true" />
                </span>
                <span className="text-[11px] font-medium text-[#F5F7F8]">{action.label}</span>
              </button>
            );
          })}

          {/* Text */}
          <button
            onClick={onOpenText}
            className="flex flex-col items-center gap-2 rounded-xl border border-white/[0.07] bg-[#11171B] px-2 py-4 text-center hover:bg-[#172027] hover:border-white/[0.12] active:scale-[0.97] transition-all min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00F5A0]"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0B0F12] border border-white/[0.06] text-[#39D9FF]">
              <FileText className="w-4 h-4" aria-hidden="true" />
            </span>
            <span className="text-[11px] font-medium text-[#F5F7F8]">Text</span>
          </button>

          {/* Clipboard */}
          <button
            onClick={onOpenText}
            className="flex flex-col items-center gap-2 rounded-xl border border-white/[0.07] bg-[#11171B] px-2 py-4 text-center hover:bg-[#172027] hover:border-white/[0.12] active:scale-[0.97] transition-all min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00F5A0]"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0B0F12] border border-white/[0.06] text-[#A78BFA]">
              <ClipboardList className="w-4 h-4" aria-hidden="true" />
            </span>
            <span className="text-[11px] font-medium text-[#F5F7F8]">Clipboard</span>
          </button>
        </div>
      </section>

      {/* ------------------------------------------------------------- */}
      {/* RECENT TRANSFERS — real local history only                     */}
      {/* ------------------------------------------------------------- */}
      <section aria-labelledby="recent-heading">
        <div className="flex items-center justify-between mb-3">
          <h3 id="recent-heading" className="text-sm font-semibold text-[#F5F7F8]">
            Recent Transfers
          </h3>
          {historyItems.length > 0 && (
            <button
              onClick={() => onNavigate('transfers')}
              className="inline-flex items-center gap-0.5 text-[11px] text-[#00D9B5] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00F5A0] rounded px-1"
            >
              <span>View all</span>
              <ChevronRight className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-[#11171B]">
          {recentItems.length === 0 ? (
            <div className="py-10 px-5 text-center">
              <ShieldCheck className="w-8 h-8 mx-auto mb-2 text-[#9AA7AE]/30" aria-hidden="true" />
              <p className="text-xs font-medium text-[#9AA7AE]">No transfers yet</p>
              <p className="text-[11px] mt-1 text-[#9AA7AE]/80">
                When you send or receive files, they appear here — stored only on this device.
              </p>
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
                          ? 'bg-sky-500/10 text-sky-400 border-sky-500/20'
                          : 'bg-emerald-500/10 text-[#00D9B5] border-emerald-500/20'
                      }`}
                    >
                      {item.direction === 'sent' ? (
                        <ArrowUpRight className="w-4 h-4" />
                      ) : (
                        <ArrowDownLeft className="w-4 h-4" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-[#F5F7F8] max-w-[45vw] sm:max-w-xs">
                        {item.name}
                      </p>
                      <div className="flex items-center gap-1.5 text-[11px] text-[#9AA7AE] mt-0.5">
                        <span>{formatBytes(item.size)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatTimestamp(item.timestamp)}</span>
                        {item.hashVerified === true && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-[#00F5A0] inline-flex items-center gap-0.5">
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
                        ? 'bg-emerald-500/10 text-[#00D9B5] border-emerald-500/20'
                        : 'bg-red-500/10 text-[#FF5C5C] border-red-500/20'
                    }`}
                  >
                    {item.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
};
