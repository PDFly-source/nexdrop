'use client';

/**
 * Development-only transfer diagnostics panel.
 *
 * Opt-in: localStorage 'nexdrop:diagnostics' = '1' or ?diag=1 in the URL.
 * Renders ONLY values measured in real time:
 *  - Connection: getStats() transport truth — direct/relay, ICE candidate
 *    types, candidate-pair RTT, transport byte counters, DataChannel state.
 *  - Sender: ACK-cadence throughput, RTT, window, chunk, buffering, stalls.
 *  - Receiver: write latency, queue depth, writer type, heap.
 * Refreshed 5x/second from window.__NEXDROP_TELEMETRY__. '—' when a value
 * is not being produced. No synthesized, averaged-away or cosmetic numbers.
 */

import { useEffect, useRef, useState } from 'react';
import type { NexDropTelemetry } from '@/lib/transfer/telemetry';
import { transportLabel } from '@/lib/transfer/transportStats';
import { isDevModeEnabled } from '@/lib/devicetest/gate';
import { openDeviceTest } from '@/lib/devicetest/recorder';

const fmtBytes = (b: number | undefined | null): string => {
  if (b === undefined || b === null || Number.isNaN(b)) return '—';
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KiB`;
  return `${(b / 1024 / 1024).toFixed(1)} MiB`;
};
const fmtBps = (v: number | undefined): string => {
  if (!v || v <= 0) return '—';
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KiB/s`;
  return `${(v / 1024 / 1024).toFixed(2)} MiB/s`;
};
const fmtMs = (v: number | undefined | null): string =>
  v === undefined || v === null || v <= 0 ? '—' : `${Math.round(v)} ms`;
const fmtKib = (v: number | undefined): string =>
  v === undefined || v <= 0 ? '—' : `${(v / 1024).toFixed(0)} KiB`;

export default function DiagnosticsPanel() {
  const [enabled] = useState(isDevModeEnabled);
  const [data, setData] = useState<NexDropTelemetry | null>(null);
  /** Measured peak throughput this session (running max of real samples). */
  const [peakBps, setPeakBps] = useState(0);
  const peakRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      const t = (window as any).__NEXDROP_TELEMETRY__ as NexDropTelemetry | undefined;
      if (!t) return;
      const live = Math.max(t.sender?.throughputBps ?? 0, t.receiver?.throughputBps ?? 0);
      if (live > peakRef.current) {
        peakRef.current = live;
        setPeakBps(live);
      }
      setData({ ...t });
    }, 200);
    return () => clearInterval(timer);
  }, [enabled]);

  if (!enabled) return null;
  const s = data?.sender;
  const r = data?.receiver;
  const t = data?.transport;
  const dc = data?.dataChannelState;

  const connectionRows: Array<[string, string]> = [
    ['WebRTC', t?.connected ? '✓ connected' : 'not connected'],
    ['Transport', t ? transportLabel(t) : '—'],
    [
      'ICE candidates',
      t?.localCandidateType && t?.remoteCandidateType
        ? `${t.localCandidateType} → ${t.remoteCandidateType}`
        : '—',
    ],
    ['Pair RTT', fmtMs(t?.rttMs)],
    ['Pair state', t?.pairState || '—'],
    ['DTLS / SCTP', `${t?.dtlsState || '—'} / ${t?.sctpState || '—'}`],
    ['DataChannel', dc || '—'],
    ['Transport bytes', t ? `${fmtBytes(t.bytesSent)} ↓ ${fmtBytes(t.bytesReceived)}` : '—'],
    ['Outgoing bitrate', t?.outgoingBitrateBps ? fmtBps(t.outgoingBitrateBps / 8) : '—'],
  ];
  const senderRows: Array<[string, string]> = [
    ['Throughput (ACK clock)', fmtBps(s?.throughputBps)],
    ['Peak (session max)', fmtBps(peakBps)],
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
    <>
      <div className="mb-4">
        <button type="button" onClick={openDeviceTest} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-nd-teal text-nd-bg-0">
          Device Test — owner physical validation
        </button>
      </div>
      <div className="rounded-xl border border-white/[0.06] bg-nd-bg-1 p-4 text-left">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-nd-text-primary">
          Transfer diagnostics <span className="text-nd-text-secondary font-normal">(live, measured)</span>
        </p>
        <p className="text-[10px] text-nd-text-secondary">refresh 5 Hz</p>
      </div>
      <div className="flex flex-wrap gap-8">
        <DiagSection title="Connection" rows={connectionRows} />
        <DiagSection title="Sender" rows={senderRows} />
        <DiagSection title="Receiver" rows={receiverRows} />
        </div>
      </div>
    </>
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
