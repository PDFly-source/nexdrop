'use client';

/**
 * Development-only transfer diagnostics panel.
 *
 * Opt-in: localStorage 'nexdrop:diagnostics' = '1' or ?diag=1 in the URL.
 * Renders ONLY values the engines measured in real time (live from
 * window.__NEXDROP_TELEMETRY__, refreshed 5×/second): RTT, smoothed RTT,
 * chunk size, window size, bufferedAmount, ACK count/rate, receiver write
 * latency + queue depth, throughput, bytes, stalls. '—' when a value is
 * not being produced. No synthesized, averaged-away or cosmetic numbers.
 */

import { useEffect, useState } from 'react';
import type { NexDropTelemetry } from '@/lib/transfer/telemetry';

function isDiagnosticsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(window.location.search).get('diag') === '1') return true;
  try {
    return window.localStorage.getItem('nexdrop:diagnostics') === '1';
  } catch {
    return false;
  }
}

const fmtBytes = (b: number | undefined): string => {
  if (b === undefined || Number.isNaN(b)) return '—';
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KiB`;
  return `${(b / 1024 / 1024).toFixed(1)} MiB`;
};
const fmtBps = (v: number | undefined): string => {
  if (!v || v <= 0) return '—';
  return `${(v / 1024 / 1024).toFixed(2)} MiB/s`;
};
const fmtMs = (v: number | undefined): string => (v === undefined || v <= 0 ? '—' : `${Math.round(v)} ms`);
const fmtKib = (v: number | undefined): string =>
  v === undefined || v <= 0 ? '—' : `${(v / 1024).toFixed(0)} KiB`;

export default function DiagnosticsPanel() {
  const [enabled] = useState(isDiagnosticsEnabled);
  const [data, setData] = useState<NexDropTelemetry | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      setData((prev) => ({
        sender: (window as any).__NEXDROP_TELEMETRY__?.sender ?? prev?.sender ?? null,
        receiver: (window as any).__NEXDROP_TELEMETRY__?.receiver ?? prev?.receiver ?? null,
      }));
    }, 200);
    return () => clearInterval(timer);
  }, [enabled]);

  if (!enabled) return null;
  const s = data?.sender;
  const r = data?.receiver;

  const senderRows: Array<[string, string]> = [
    ['Throughput (ACK clock)', fmtBps(s?.throughputBps)],
    ['Smoothed RTT', fmtMs(s?.srttMs)],
    ['Min RTT', fmtMs(s?.minRttMs)],
    ['Chunk size', fmtKib(s?.chunkSize)],
    ['Window', s?.windowBytes ? `${fmtBytes(s.windowBytes)} (${s.windowChunks} chunks)` : '—'],
    ['bufferedAmount', fmtBytes(s?.bufferedAmount)],
    ['Max buffered', fmtBytes(s?.maxBufferedAmount)],
    ['ACKs', s?.ackCount ? String(s.ackCount) : '—'],
    ['Stalls', s?.stalls !== undefined ? String(s.stalls) : '—'],
    ['Sent / acked', s ? `${fmtBytes(s.bytesSent)} / ${fmtBytes(s.bytesAcked)}` : '—'],
  ];
  const receiverRows: Array<[string, string]> = [
    ['Throughput (recv)', fmtBps(r?.throughputBps)],
    ['Write EWMA', fmtMs(r?.writeMsEwma)],
    ['Queue depth', r?.queueDepth !== undefined ? String(r.queueDepth) : '—'],
    ['Max queue', r?.maxQueueDepth !== undefined ? String(r.maxQueueDepth) : '—'],
    ['ACKs sent', r?.acksSent ? String(r.acksSent) : '—'],
    ['Received', fmtBytes(r?.bytesReceived)],
    ['Writer', r?.writerType || '—'],
    ['Heap', r?.heapBytes ? fmtBytes(r.heapBytes) : '—'],
  ];

  return (
    <div className="rounded-xl border border-white/[0.06] bg-nd-bg-1 p-4 text-left">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-nd-text-primary">
          Transfer diagnostics <span className="text-nd-text-secondary font-normal">(live, measured)</span>
        </p>
        <p className="text-[10px] text-nd-text-secondary">refresh 5 Hz</p>
      </div>
      <div className="flex flex-wrap gap-8">
        <DiagSection title="Sender" rows={senderRows} />
        <DiagSection title="Receiver" rows={receiverRows} />
      </div>
    </div>
  );
}


function DiagSection({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="min-w-[220px]">
      <p className="text-[10px] uppercase tracking-wider text-nd-teal-bright mb-1.5">{title}</p>
      <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-[11px] font-mono">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <span className="text-nd-text-secondary">{k}</span>
            <span className="text-right text-nd-text-primary">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
