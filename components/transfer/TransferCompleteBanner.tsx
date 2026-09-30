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
}

interface TransferCompleteBannerProps {
  /** The engine's active transfer — completion is read from its REAL status. */
  activeTransfer: EngineTransferLike | null;
  onNavigateHome: () => void;
}

/**
 * LAYER 7 — restrained success state. Appears only when the real engine
 * reports a completed transfer; never simulates a success.
 */
export const TransferCompleteBanner: React.FC<TransferCompleteBannerProps> = ({
  activeTransfer,
  onNavigateHome,
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
      className="relative rounded-2xl border border-emerald-500/25 bg-[#0B0F12] p-4 sm:p-5 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <div className="flex items-start gap-3.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-[#00F5A0]">
          <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[#F5F7F8]">Transfer complete</p>
          <p className="mt-0.5 text-xs text-[#9AA7AE]">
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
            <span className="text-[#F5F7F8] font-medium">{justCompleted.name}</span> ·{' '}
            {formatBytes(justCompleted.size)}
            {verified && (
              <span className="text-[#00F5A0] inline-flex items-center gap-1">
                {' '}· <FileCheck className="w-3 h-3" aria-hidden="true" /> SHA-256 verified
              </span>
            )}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={onNavigateHome}
              className="rounded-lg bg-[#00F5A0] px-3.5 py-2 text-xs font-semibold text-[#070A0D] hover:bg-[#00D9B5] transition-colors min-h-[36px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00F5A0]"
            >
              Done
            </button>
            <button
              onClick={dismiss}
              className="rounded-lg border border-white/[0.1] bg-[#11171B] px-3.5 py-2 text-xs font-medium text-[#9AA7AE] hover:text-[#F5F7F8] hover:border-white/20 transition-colors min-h-[36px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00F5A0]"
            >
              Keep sending
            </button>
          </div>
        </div>

        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-lg p-1.5 text-[#9AA7AE] hover:text-[#F5F7F8] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00F5A0]"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};
