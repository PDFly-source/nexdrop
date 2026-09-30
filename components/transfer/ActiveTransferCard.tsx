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
    <div className="rounded-xl border border-white/[0.12] bg-[#15191E] p-5 shadow-lg">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
        {/* Left: Info & Metrics */}
        <div className="flex-1 min-w-0 text-left w-full">
          <div className="flex items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-md ${
                direction === 'outgoing'
                  ? 'bg-blue-500/10 text-blue-400'
                  : 'bg-emerald-500/10 text-[#3DD6A0]'
              }`}
            >
              {direction === 'outgoing' ? (
                <ArrowUpRight className="w-3.5 h-3.5" />
              ) : (
                <ArrowDownLeft className="w-3.5 h-3.5" />
              )}
            </span>
            <span className="text-xs font-medium text-[#9AA3AD] uppercase tracking-wider">
              {direction === 'outgoing' ? 'Sending to peer' : 'Receiving from peer'}
            </span>
            <span className="text-white/45">·</span>
            <span className="text-xs text-[#19C37D] font-mono">
              {status === 'paused' ? 'Paused' : 'Streaming'}
            </span>
          </div>

          <h2 className="mt-1.5 truncate text-base font-semibold text-[#F5F7F8]">
            {name}
          </h2>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#9AA3AD]">
            <span>
              <strong className="font-mono text-[#F5F7F8] font-normal">
                {formatBytes(bytesTransferred)}
              </strong>{' '}
              /{' '}
              <span className="font-mono">{formatBytes(size)}</span>
            </span>

            <span>·</span>

            <span className="font-mono text-[#3DD6A0]">
              {formatSpeed(speedBps)}
            </span>

            <span>·</span>

            <span className="font-mono text-[#9AA3AD]">
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
                    className="flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-[#1B2026] px-3 py-1.5 text-xs font-medium text-[#F5F7F8] hover:bg-white/10 transition-colors"
                  >
                    <Play className="w-3.5 h-3.5 fill-current text-[#19C37D]" />
                    <span>Resume</span>
                  </button>
                ) : (
                  <button
                    onClick={onPause}
                    className="flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-[#1B2026] px-3 py-1.5 text-xs font-medium text-[#F5F7F8] hover:bg-white/10 transition-colors"
                  >
                    <Pause className="w-3.5 h-3.5 text-[#9AA3AD]" />
                    <span>Pause</span>
                  </button>
                )}
              </>
            )}

            <button
              onClick={onCancel}
              className="flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-[#EF4444] hover:bg-red-500/20 transition-colors"
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
              stroke="#19C37D"
              fill="transparent"
              strokeWidth={strokeWidth}
              strokeDasharray={`${circumference} ${circumference}`}
              style={{ strokeDashoffset }}
              strokeLinecap="round"
              r={normalizedRadius}
              cx={radius}
              cy={radius}
              className="transition-[stroke-dashoffset] duration-200 ease-out"
            />
          </svg>

          {/* Center text */}
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="font-mono text-base font-bold text-[#F5F7F8] leading-none">
              {progress.toFixed(0)}%
            </span>
          </div>

          <span className="mt-2 font-mono text-[11px] text-[#9AA3AD]">
            {formatSpeed(speedBps)}
          </span>
        </div>
      </div>
    </div>
  );
};
