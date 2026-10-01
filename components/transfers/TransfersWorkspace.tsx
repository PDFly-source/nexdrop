'use client';

import React, { useState } from 'react';
import { UploadCloud, Download, ShieldCheck, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { SendDropzone } from '@/components/transfer/SendDropzone';
import { IncomingTransfersCard } from '@/components/transfer/IncomingTransfersCard';
import { ActiveTransferCard } from '@/components/transfer/ActiveTransferCard';
import { TransferCompleteBanner } from '@/components/transfer/TransferCompleteBanner';
import { HistoryWorkspace } from '@/components/history/HistoryWorkspace';
import { Reveal } from '@/components/ui/Reveal';
import { SendPairingSurface } from '@/components/pairing/SendPairingSurface';
import type { PairingQr } from '@/hooks/useNexDropSession';
import type { SendFlowState } from '@/lib/transfer/sendFlow';
import { FileItem, LocalHistoryItem } from '@/types/transfer';

interface ActiveTransferSummary {
  id: string;
  name: string;
  size: number;
  direction: 'outgoing' | 'incoming';
  status: 'transferring' | 'paused' | 'completed' | 'cancelled' | 'failed';
  progress: number;
  bytesTransferred: number;
  speedBps: number;
  etaSeconds: number;
  hash?: string;
  integrityVerified?: boolean;
}

interface TransfersWorkspaceProps {
  sendFlowState: SendFlowState;
  offerQr: PairingQr | null;
  pairingError: string | null;
  onCancelConnection: () => void;
  onRetryConnection: () => void;
  sendQueue: FileItem[];
  incomingFiles: FileItem[];
  activeTransfer: ActiveTransferSummary | null;
  onNavigateHome: () => void;
  historyItems: LocalHistoryItem[];
  isConnected: boolean;
  supportsFileSystemAccess: boolean;
  onFilesSelected: (files: FileList | File[]) => void;
  onRemoveItem: (id: string) => void;
  onClearCompleted: () => void;
  onPauseTransfer: () => void;
  onResumeTransfer: () => void;
  onCancelTransfer: () => void;
  onClearHistory: () => void;
  onPromptConnect: () => void;
  /** Wall-clock ms when the active pairing expires (null = none). */
  pairingExpiresAt: number | null;
  onPreviewFile: (file: FileItem) => void;
}

export const TransfersWorkspace: React.FC<TransfersWorkspaceProps> = ({
  sendFlowState, offerQr, pairingError, onCancelConnection, onRetryConnection,
  sendQueue,
  incomingFiles,
  activeTransfer,
  historyItems,
  onNavigateHome,
  isConnected,
  supportsFileSystemAccess,
  onFilesSelected,
  onRemoveItem,
  onClearCompleted,
  onPauseTransfer,
  onResumeTransfer,
  onCancelTransfer,
  onClearHistory,
  onPromptConnect,
  pairingExpiresAt,
  onPreviewFile,
}) => {
  // Mobile Send / Receive segmented toggle
  const [mobileTransferMode, setMobileTransferMode] = useState<'send' | 'receive'>('send');
  // "Send another" pulses this counter to open the file chooser instantly.
  const [sendAnotherSignal, setSendAnotherSignal] = useState(0);

  const activeItem = activeTransfer?.direction === 'outgoing'
    ? sendQueue.find(file => file.id === activeTransfer.id)
    : incomingFiles.find(file => file.id === activeTransfer?.id);
  const completionItem = activeTransfer ? { ...activeTransfer,
    integrityVerified: activeItem?.integrityVerified,
    blobUrl: activeItem?.blobUrl,
    status: activeTransfer.status === 'completed' && activeItem?.integrityVerified !== true
      ? 'verifying' : activeTransfer.status,
  } : null;

  return (
    <div className="space-y-6">
      {/* LAYER 7 — real completion state (reads the engine, never fakes it) */}
      <TransferCompleteBanner
        activeTransfer={completionItem}
        onNavigateHome={onNavigateHome}
        onSendAnother={() => setSendAnotherSignal(n => n + 1)}
      />

      {/* Active Transfer (highlighted at top when running) */}
      {activeTransfer && (
        <div className="animate-in fade-in duration-150">
          <ActiveTransferCard
            activeTransfer={activeTransfer}
            onPause={onPauseTransfer}
            onResume={onResumeTransfer}
            onCancel={onCancelTransfer}
          />
        </div>
      )}

      {/* Mobile Segmented Toggle [ Send ] [ Receive ] */}
      <div className="flex lg:hidden items-center justify-center">
        <div
          role="tablist"
          aria-label="Send or receive"
          className="grid grid-cols-2 rounded-xl bg-nd-surface p-1 border border-white/[0.08] w-full max-w-xs shadow-sm"
        >
          <button
            role="tab"
            aria-selected={mobileTransferMode === 'send'}
            onClick={() => setMobileTransferMode('send')}
            className={`flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-lg transition-all min-h-[44px] ${
              mobileTransferMode === 'send'
                ? 'bg-nd-teal text-nd-bg-0 shadow-sm'
                : 'text-nd-text-secondary hover:text-nd-text-primary'
            }`}
          >
            <UploadCloud className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Send ({sendQueue.length})</span>
          </button>
          <button
            role="tab"
            aria-selected={mobileTransferMode === 'receive'}
            onClick={() => setMobileTransferMode('receive')}
            className={`flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-lg transition-all min-h-[44px] ${
              mobileTransferMode === 'receive'
                ? 'bg-nd-teal text-nd-bg-0 shadow-sm'
                : 'text-nd-text-secondary hover:text-nd-text-primary'
            }`}
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Receive ({incomingFiles.length})</span>
          </button>
        </div>
      </div>

      {/* Send / Receive panels: desktop 2-column, mobile tabbed */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        <div
          className={`lg:col-span-6 flex flex-col ${
            mobileTransferMode === 'send' ? 'block' : 'hidden lg:flex'
          }`}
        >
          <div className="flex flex-col gap-4">
          <SendDropzone
            sendQueue={sendQueue}
            isConnected={isConnected}
            onFilesSelected={onFilesSelected}
            onRemoveItem={onRemoveItem}
            onClearCompleted={onClearCompleted}
            openSignal={sendAnotherSignal}
          />
          {(sendQueue.length > 0 || sendFlowState === 'auto_pairing') && (
            <SendPairingSurface state={sendFlowState} offerQr={offerQr} error={pairingError}
              queuedCount={sendQueue.filter(f => f.status === 'queued').length}
              fileSummary={(() => { const q = sendQueue.filter(f => f.status === 'queued');
                return q.length ? { firstName: q[0].name, totalBytes: q.reduce((n, f) => n + f.size, 0), count: q.length } : null; })()}
              expiresAt={pairingExpiresAt}
              onCancel={onCancelConnection} onRetry={onRetryConnection} onOpenDevices={onPromptConnect}
              onRemoveFiles={() => sendQueue.filter(f => f.status === 'queued').forEach(f => onRemoveItem(f.id))} />
          )}
          </div>
        </div>

        <div
          className={`lg:col-span-6 flex flex-col ${
            mobileTransferMode === 'receive' ? 'block' : 'hidden lg:flex'
          }`}
        >
          <IncomingTransfersCard
            incomingFiles={incomingFiles}
            onPreviewFile={onPreviewFile}
            supportsFileSystemAccess={supportsFileSystemAccess}
          />
        </div>
      </div>

      {/* Trust & architecture banner */}
      <div className="rounded-2xl border border-white/[0.06] bg-nd-bg-1 p-5 text-xs text-nd-text-secondary flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-nd-success/10 text-nd-teal border border-nd-success/20">
            <ShieldCheck className="w-4 h-4" aria-hidden="true" />
          </div>
          <div>
            <p className="font-medium text-nd-text-primary">Direct P2P Architecture</p>
            <p className="text-[11px] text-nd-text-secondary mt-0.5">
              Pairing uses a lightweight ephemeral signaling service. Files and text travel directly between devices over encrypted WebRTC DataChannels.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0 self-start sm:self-center">
          <Link
            href="/security"
            className="flex items-center gap-1 text-[11px] text-nd-teal-bright hover:underline"
          >
            <span>Security Whitepaper</span>
            <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </Link>
          <span aria-hidden="true" className="text-white/20">·</span>
          <Link
            href="/privacy"
            className="flex items-center gap-1 text-[11px] text-nd-text-secondary hover:text-white"
          >
            <span>Privacy Policy</span>
          </Link>
        </div>
      </div>

      {/* Transfer history with status filters (Active state is the card above) */}
      <Reveal>
        <HistoryWorkspace
          historyItems={historyItems}
          onClearHistory={onClearHistory}
          onNavigateTransfer={onPromptConnect}
        />
      </Reveal>
    </div>
  );
};
