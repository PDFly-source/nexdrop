'use client';

import React from 'react';
import { Pause, Play, X, ArrowUpRight, ArrowDownLeft, ShieldCheck } from 'lucide-react';
import { formatBytes, formatSpeed, formatEta } from '@/lib/utils/format';

interface ActiveTransferCardProps {
  activeTransfer: {
    id: string;
    name: string;
    size: number;
    direction: 'outgoing' | 'incoming';
    status: 'transferring' | 'paused' | 'completed' | 'cancelled' | 'failed';
    progress: number;
    bytesTransferred: number;
    speedBps: number;
    etaSeconds: number;
    writerType?: string;
  } | null;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}

export const ActiveTransferCard: React.FC<ActiveTransferCardProps> = ({
  activeTransfer,
  onPause,
  onResume,
  onCancel,
}) => {
  if (!activeTransfer || activeTransfer.status === 'completed' || activeTransfer.status === 'cancelled') {
    return null;
  }

  const {
    name,
    size,
    direction,
    status,
    progress,
    bytesTransferred,
    speedBps,
    etaSeconds,
  } = activeTransfer;

  // SVG Circular Progress math
  const radius = 38;
  const strokeWidth = 5;
  const normalizedRadius = radius - strokeWidth * 0.5;
  const circumference = normalizedRadius * 2 * Math.PI;
  const strokeDashoffset = circumference - (progress / 100) * circumference;

  return (
    <div className="rounded-xl border border-white/[0.12] bg-nd-surface p-5 shadow-lg">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
        {/* Left: Info & Metrics */}
        <div className="flex-1 min-w-0 text-left w-full">
          <div className="flex items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-md ${
                direction === 'outgoing'
                  ? 'bg-nd-teal/10 text-nd-teal'
                  : 'bg-nd-success/10 text-nd-teal-bright'
              }`}
            >
              {direction === 'outgoing' ? (
                <ArrowUpRight className="w-3.5 h-3.5" />
              ) : (
                <ArrowDownLeft className="w-3.5 h-3.5" />
              )}
            </span>
            <span className="text-xs font-medium text-nd-text-secondary uppercase tracking-wider">
              {direction === 'outgoing' ? 'Sending to peer' : 'Receiving from peer'}
            </span>
            <span className="text-white/45">·</span>
            <span className="text-xs text-nd-teal font-mono">
              {status === 'paused' ? 'Paused' : 'Streaming'}
            </span>
          </div>

          <h2 className="mt-1.5 truncate text-base font-semibold text-nd-text-primary">
            {name}
          </h2>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-nd-text-secondary">
            <span>
              <strong className="font-mono text-nd-text-primary font-normal">
                {formatBytes(bytesTransferred)}
              </strong>{' '}
              /{' '}
              <span className="font-mono">{formatBytes(size)}</span>
            </span>

            <span>·</span>

            <span className="font-mono text-nd-teal-bright">
              {formatSpeed(speedBps)}
            </span>

            <span>·</span>

            <span className="font-mono text-nd-text-secondary">
              {formatEta(etaSeconds)}
            </span>
          </div>

          {/* Action buttons */}
          <div className="mt-4 flex items-center gap-2">
            {direction === 'outgoing' && (
              <>
                {status === 'paused' ? (
                  <button
                    onClick={onResume}
                    className="flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-nd-surface-elevated px-3 py-1.5 text-xs font-medium text-nd-text-primary hover:bg-white/10 transition-colors"
                  >
                    <Play className="w-3.5 h-3.5 fill-current text-nd-teal" />
                    <span>Resume</span>
                  </button>
                ) : (
                  <button
                    onClick={onPause}
                    className="flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-nd-surface-elevated px-3 py-1.5 text-xs font-medium text-nd-text-primary hover:bg-white/10 transition-colors"
                  >
                    <Pause className="w-3.5 h-3.5 text-nd-text-secondary" />
                    <span>Pause</span>
                  </button>
                )}
              </>
            )}

            <button
              onClick={onCancel}
              className="flex items-center gap-1.5 rounded-lg border border-nd-error/20 bg-nd-error/10 px-3 py-1.5 text-xs font-medium text-nd-error hover:bg-nd-error/20 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              <span>Cancel</span>
            </button>
          </div>
        </div>

        {/* Right: SVG Circular Progress Indicator */}
        <div className="relative flex flex-col items-center justify-center shrink-0">
          <svg height={radius * 2} width={radius * 2} className="transform -rotate-90">
            {/* Background ring */}
            <circle
              stroke="rgba(255, 255, 255, 0.08)"
              fill="transparent"
              strokeWidth={strokeWidth}
              r={normalizedRadius}
              cx={radius}
              cy={radius}
            />
            {/* Active progress ring */}
            <circle
              stroke="var(--nd-teal)"
              fill="transparent"
              strokeWidth={strokeWidth}
              strokeDasharray={`${circumference} ${circumference}`}
              style={{ strokeDashoffset }}
              strokeLinecap="round"
              r={normalizedRadius}
              cx={radius}
              cy={radius}
              className="stroke-nd-teal transition-[stroke-dashoffset] duration-200 ease-out"
            />
          </svg>

          {/* Center text */}
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="font-mono text-base font-bold text-nd-text-primary leading-none">
              {progress.toFixed(0)}%
            </span>
          </div>

          <span className="mt-2 font-mono text-[11px] text-nd-text-secondary">
            {formatSpeed(speedBps)}
          </span>
        </div>
      </div>
    </div>
  );
};
