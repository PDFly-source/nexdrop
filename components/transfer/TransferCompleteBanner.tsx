'use client';

import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, X, ArrowUpRight, ArrowDownLeft, FileCheck } from 'lucide-react';
import { formatBytes } from '@/lib/utils/format';

/** Minimal structural shape the banner reads from the real engine item. */
interface EngineTransferLike {
  name: string;
  size: number;
  direction: 'outgoing' | 'incoming';
  status: string;
  integrityVerified?: boolean;
  hashVerified?: boolean;
  /** Receiver object URL — enables [Open file] after verification. */
  blobUrl?: string;
}

interface TransferCompleteBannerProps {
  /** The engine's active transfer — completion is read from its REAL status. */
  activeTransfer: EngineTransferLike | null;
  onNavigateHome: () => void;
  /** Opens the system file chooser immediately ("Send another"). */
  onSendAnother?: () => void;
}

/**
 * LAYER 7 — restrained success state. Appears only when the real engine
 * reports a completed transfer; never simulates a success.
 */
export const TransferCompleteBanner: React.FC<TransferCompleteBannerProps> = ({
  activeTransfer,
  onNavigateHome,
  onSendAnother,
}) => {
  const [justCompleted, setJustCompleted] = useState<EngineTransferLike | null>(null);
  const dismiss = () => setJustCompleted(null);
  const prevStatusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeTransfer) {
      prevStatusRef.current = null;
      return;
    }
    const prev = prevStatusRef.current;
    prevStatusRef.current = activeTransfer.status;
    if (activeTransfer.status === 'completed' && prev && prev !== 'completed') {
      setJustCompleted(activeTransfer);
    }
  }, [activeTransfer]);

  if (!justCompleted) return null;

  const isOutgoing = justCompleted.direction === 'outgoing';
  const verified = justCompleted.integrityVerified === true;

  return (
    <div
      role="status"
      aria-live="polite"
      className="relative rounded-2xl border border-nd-success/25 bg-nd-bg-1 p-4 sm:p-5 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      {/* Tiny coral celebratory brand accent — the only brand color on
          the success surface; status stays semantic green. */}
      <span aria-hidden="true" className="absolute right-4 top-4 h-1.5 w-1.5 rounded-full bg-nd-coral/70" />
      <div className="flex items-start gap-3.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-nd-success/10 border border-nd-success/30 text-nd-teal motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-50 motion-safe:duration-300">
          <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-nd-text-primary">
            {isOutgoing ? 'Transfer complete' : 'Transfer received'}
          </p>
          <p className="mt-0.5 text-xs text-nd-text-secondary">
            <span className="inline-flex items-center gap-1">
              {isOutgoing ? (
                <>
                  <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                  Sent
                </>
              ) : (
                <>
                  <ArrowDownLeft className="w-3 h-3" aria-hidden="true" />
                  Received
                </>
              )}
            </span>{' '}
            <span className="text-nd-text-primary font-medium">{justCompleted.name}</span> ·{' '}
            {formatBytes(justCompleted.size)}
            {verified && (
              <span className="text-nd-teal inline-flex items-center gap-1">
                {' '}· <FileCheck className="w-3 h-3" aria-hidden="true" /> SHA-256 verified
              </span>
            )}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {isOutgoing && onSendAnother && (
              <button
                onClick={onSendAnother}
                className="rounded-lg bg-nd-teal px-3.5 py-2 text-xs font-semibold text-nd-bg-0 hover:bg-nd-teal-bright transition-colors min-h-[36px] focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
              >
                Send more
              </button>
            )}
            {!isOutgoing && justCompleted.blobUrl && (
              <>
                <button
                  onClick={() => { if (justCompleted.blobUrl) window.open(justCompleted.blobUrl, '_blank', 'noopener'); }}
                  className="rounded-lg bg-nd-teal px-3.5 py-2 text-xs font-semibold text-nd-bg-0 hover:bg-nd-teal-bright transition-colors min-h-[36px] focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
                >
                  Open file
                </button>
                <a
                  href={justCompleted.blobUrl}
                  download={justCompleted.name}
                  className="rounded-lg border border-white/[0.1] bg-nd-surface px-3.5 py-2 text-xs font-medium text-nd-text-secondary hover:text-nd-text-primary hover:border-white/20 transition-colors min-h-[36px] inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
                >
                  Save
                </a>
              </>
            )}
            <button
              onClick={onNavigateHome}
              className="rounded-lg border border-white/[0.1] bg-nd-surface px-3.5 py-2 text-xs font-medium text-nd-text-secondary hover:text-nd-text-primary hover:border-white/20 transition-colors min-h-[36px] focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
            >
              Done
            </button>
          </div>
        </div>

        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-lg p-1.5 text-nd-text-secondary hover:text-nd-text-primary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};
