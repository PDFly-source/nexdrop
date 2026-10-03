'use client';

/**
 * "Device Test & Diagnostics" screen — owner-run physical validation.
 *
 * Opened from Settings → Advanced (production PWA) or the developer
 * diagnostics panel (?diag=1). Records values measured by the real
 * engines — never fabricated:
 *  - file name/size/SHA-256 from the real transfer engine completions,
 *  - avg/peak/sustained speed from real timestamps + byte counts,
 *  - connection/ICE/RTT/bitrate from getStats() samples,
 *  - collapse timeline + first-changing-variable from the 10 Hz engine
 *    timelines,
 *  - Pass/Fail is the owner's explicit verdict.
 * The normal ONE QR → Accept → automatic connection → transfer journey is
 * untouched; this screen only OBSERVES it. The guided live test (case
 * 'live') is the v2.5.2 two-device 341.48 MB diagnostics flow.
 */

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { X, Play, Check, Ban, RotateCcw, ClipboardCopy, Download, FileText, Trash2, Braces, Activity } from 'lucide-react';
import type { DeviceTestMeta, DeviceTestRecord } from '@/types/devicetest';
import { DEVICE_TEST_CASES, GUIDED_CASES, MANUAL_CASES } from '@/lib/devicetest/matrix';
import { liveCollapseAnalysis, buildLiveTestReport, buildLiveTestJson } from '@/lib/devicetest/report';
import {
  armTest,
  buildDeviceTestReport,
  clearAllTests,
  closeDeviceTest,
  deviceTestAvgBps,
  deviceTestDurationSeconds,
  getServerDeviceTestSnapshot,
  getDeviceTestSnapshot,
  markTest,
  resetTest,
  setDeviceTestMeta,
  setTestNotes,
  subscribeDeviceTest,
} from '@/lib/devicetest/recorder';

const MB = 1e6;
const fmtBytes = (b: number): string =>
  b > 0 ? (b >= MB ? `${(b / MB).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(0)} KB` : `${b} B`) : '—';
const fmtMBps = (bps: number | null): string => (bps && bps > 0 ? `${(bps / MB).toFixed(2)} MB/s` : '—');
const fmtTime = (ms: number | null): string =>
  ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const fmtSec = (s: number | null): string => (s !== null ? `${s.toFixed(2)} s` : '—');
const shortSha = (h: string | null): string => (h ? `${h.slice(0, 12)}…` : '—');

/** Real device identity from the user agent — never guessed. */
function thisDeviceLabel(): string {
  if (typeof navigator === 'undefined') return '';
  const ua = navigator.userAgent;
  const frag = ua.match(/\(([^)]+)\)/)?.[1] || '';
  const chrome = ua.match(/Chrome\/([\d.]+)/)?.[1];
  const parts = [frag || null, chrome ? `Chrome ${chrome.split('.')[0]}` : null].filter(Boolean);
  return parts.join(' · ');
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 py-0.5">
      <span className="text-[11px] text-nd-text-secondary shrink-0">{label}</span>
      <span className="text-[11px] font-mono text-nd-text-primary text-right break-all">{value}</span>
    </div>
  );
}

/** ---------------------------------------------------------------------------
 * LIVE readout (Phase 5): reads the real telemetry window at ~2.5 Hz while
 * mounted. Every value is a live engine/getStats sample; N/A when the
 * browser does not expose it. Nothing is synthesized or cached.
 */
function LiveReadout() {
  const [t, setT] = useState<ReturnType<typeof getTelemetry>>(() => getTelemetry());
  useEffect(() => {
    const timer = setInterval(() => setT(getTelemetry()), 400);
    return () => clearInterval(timer);
  }, []);
  const sender = t.sender;
  const receiver = t.receiver;
  const transport = t.transport;
  const path =
    transport?.transport === 'local' ? 'LOCAL DIRECT'
    : transport?.transport === 'internet' ? 'INTERNET DIRECT'
    : transport?.transport === 'relay' ? 'RELAY'
    : 'N/A';
  const connLabel = transport?.connected
    ? 'CONNECTED'
    : transport?.connectionState || t.dataChannelState || 'N/A';
  const throughput = sender?.throughputBps ?? receiver?.throughputBps ?? null;
  return (
    <div className="rounded-lg border border-nd-teal/40 bg-black/30 px-3 py-2 divide-y divide-white/5" aria-live="polite">
      <p className="text-[10px] font-semibold text-nd-teal tracking-wider pb-1">NEXDROP DEVICE TEST — LIVE</p>
      <Field label="Connection" value={connLabel} />
      <Field label="Path" value={path} />
      <Field label="Protocol" value={transport?.protocol ? transport.protocol.toUpperCase() : 'N/A'} />
      <Field label="RTT" value={transport?.rttMs != null ? `${Math.round(transport.rttMs)} ms` : 'N/A'} />
      <Field label="Available outbound" value={transport?.outgoingBitrateBps ? fmtMBps(transport.outgoingBitrateBps / 8) : 'N/A'} />
      <Field label="Available inbound" value={transport?.incomingBitrateBps ? fmtMBps(transport.incomingBitrateBps / 8) : 'N/A'} />
      <Field label="Actual throughput" value={fmtMBps(throughput)} />
      <Field label="Sender buffer" value={sender?.bufferedAmount != null ? fmtBytes(sender.bufferedAmount) : 'N/A'} />
      <Field label="In-flight" value={sender?.inFlightBytes != null ? fmtBytes(sender.inFlightBytes) : 'N/A'} />
      <Field label="Window" value={sender?.windowBytes != null ? fmtBytes(sender.windowBytes) : 'N/A'} />
      <Field label="Receiver write" value={receiver?.writeMsEwma != null ? `${receiver.writeMsEwma.toFixed(1)} ms` : 'N/A'} />
      <Field label="Queue" value={receiver?.queueDepth != null ? String(receiver.queueDepth) : 'N/A'} />
      <Field label="Retransmissions" value={transport?.retransmissionsSent != null ? String(transport.retransmissionsSent) : 'N/A'} />
      <Field label="Stalls" value={sender?.stalls != null ? String(sender.stalls) : 'N/A'} />
      <Field label="ICE state" value={transport?.iceConnectionState || 'N/A'} />
      <Field label="Durable written" value={receiver?.writeStage?.bytes ? fmtBytes(receiver.writeStage.bytes) : 'N/A'} />
    </div>
  );
}

function getTelemetry() {
  if (typeof window === 'undefined') return { sender: null, receiver: null, transport: null, dataChannelState: null };
  return window.__NEXDROP_TELEMETRY__ || { sender: null, receiver: null, transport: null, dataChannelState: null };
}

/** ---------------------------------------------------------------------------
 * Guided live test card (case 'live').
 */
function LiveCard({ record, meta, caseDef }: { record: DeviceTestRecord; meta: DeviceTestMeta; caseDef: { id: string; title: string; hint: string } }) {
  const caseId = caseDef.id;
  const armed = record.armedAt !== null && record.endedAt === null;
  const avg = deviceTestAvgBps(record);
  const duration = deviceTestDurationSeconds(record);
  const [report, setReport] = useState('');
  const [summary, setSummary] = useState('');
  const [copied, setCopied] = useState('');

  const copyText = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      // clipboard unavailable — the text stays visible/selectable
    }
  };

  const download = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const genReport = () => {
    setReport(buildLiveTestReport(record, meta));
    const analysis = liveCollapseAnalysis(record);
    const firsts = analysis.firstChanges.slice(0, 3).map((c) => `${c.kind}@${c.tSec.toFixed(0)}s:${c.variable}`);
    setSummary(
      [
        `Path: ${record.connection || 'unknown'} · RTT ${record.rttMs != null ? `${Math.round(record.rttMs)}ms` : 'N/A'}`,
        `Avg ${fmtMBps(avg)} · Peak ${fmtMBps(record.peakBps)} · Sustained ${fmtMBps(record.sustainedBps)}`,
        `Stalls ${record.lastStalls ?? 'N/A'} · SHA-256 ${record.shaVerified === true ? 'PASS' : record.shaVerified === false ? 'FAIL' : 'N/A'}`,
        firsts.length > 0 ? `First change: ${firsts.join(', ')}` : 'No collapse events detected',
        `Likely bottleneck: ${analysis.likelyLayer}`,
      ].join('\n'),
    );
  };

  const stepCls = 'text-[11px] text-nd-text-secondary leading-relaxed';

  return (
    <div className={`rounded-xl border p-3 ${armed ? 'border-nd-teal' : record.result === 'passed' ? 'border-emerald-600/40' : record.result === 'failed' ? 'border-red-500/40' : 'border-white/10'}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-nd-text-primary">{caseDef.title}</p>
          <p className="text-[11px] text-nd-text-secondary mt-0.5">
            Real-device diagnostics with the production engine. Every recorded value is measured; nothing is simulated.
          </p>
        </div>
        <span className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 font-semibold ${armed ? 'bg-nd-teal text-nd-bg-0' : record.result === 'passed' ? 'bg-emerald-600/20 text-emerald-400' : record.result === 'failed' ? 'bg-red-500/20 text-red-400' : 'bg-white/5 text-nd-text-secondary'}`}>
          {armed ? 'ARMED — sampling at 5 Hz' : record.result === 'passed' ? 'PASSED' : record.result === 'failed' ? 'FAILED' : 'not run'}
        </span>
      </div>

      {/* Step 1: role */}
      <div className="mt-3">
        <p className="text-[10px] font-semibold text-nd-text-secondary">STEP 1 — This phone is the…</p>
        <div className="mt-1 flex gap-2">
          {(['sender', 'receiver'] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setDeviceTestMeta({ role: meta.role === r ? '' : r })}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg border ${meta.role === r ? 'bg-nd-teal text-nd-bg-0 border-nd-teal' : 'border-white/10 text-nd-text-primary'}`}
            >
              {r === 'sender' ? 'Sender' : 'Receiver'}
            </button>
          ))}
        </div>
      </div>

      {/* Steps 2-3 live in the Devices & network section at the top of this screen. */}
      <ol className={`mt-3 space-y-1 ${stepCls}`} aria-label="Guided test steps">
        <li>STEP 2 — Device names: fill &quot;Devices &amp; network&quot; above (or tap &quot;Use this device&quot;).</li>
        <li>STEP 3 — Network: note the real path (Wi-Fi / hotspot / cellular) in the Network field.</li>
        <li>STEP 4 — Pair: tap Start Test below, close this screen, then pair both phones with the normal NexDrop QR flow.</li>
        <li>STEP 5 — Transfer: <span className="text-nd-text-primary">{caseDef.hint}</span> Keep this screen open to watch the live readout.</li>
      </ol>

      <div className="mt-3 flex flex-wrap gap-2 items-center">
        {!armed && !record.result && (
          <button type="button" onClick={() => armTest(caseId)} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-nd-teal text-nd-bg-0">
            <Play className="w-3 h-3" aria-hidden="true" /> Start Test
          </button>
        )}
        {armed && (
          <>
            <button
              type="button"
              onClick={() => markTest(caseId, 'passed')}
              disabled={record.shaVerified === false}
              className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg ${record.shaVerified === false ? 'bg-white/5 text-nd-text-secondary cursor-not-allowed' : 'bg-emerald-600 text-white'}`}
              title={record.shaVerified === false ? 'SHA-256 verification failed — cannot be marked Passed' : 'Record the owner verdict'}
            >
              <Check className="w-3 h-3" aria-hidden="true" /> Mark Passed
            </button>
            <button type="button" onClick={() => markTest(caseId, 'failed')} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-500/40 text-red-400">
              <Ban className="w-3 h-3" aria-hidden="true" /> Mark Failed
            </button>
          </>
        )}
        {(record.armedAt !== null || record.result) && (
          <button type="button" onClick={() => resetTest(caseId)} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-white/10 text-nd-text-secondary">
            <RotateCcw className="w-3 h-3" aria-hidden="true" /> Reset
          </button>
        )}
      </div>

      {armed && (
        <div className="mt-3">
          <LiveReadout />
        </div>
      )}

      {(record.files.length > 0 || record.lastBytes > 0) && (
        <div className="mt-2 rounded-lg bg-black/20 px-3 py-2 divide-y divide-white/5">
          <Field label="File(s)" value={record.files.map((f) => f.name).join(', ') || '—'} />
          <Field label="Total size" value={fmtBytes(record.totalBytes)} />
          <Field label="Duration" value={fmtSec(duration)} />
          <Field label="Average" value={fmtMBps(avg)} />
          <Field label="Peak" value={fmtMBps(record.peakBps)} />
          <Field label="Sustained" value={fmtMBps(record.sustainedBps)} />
          <Field label="SHA-256" value={record.files.length === 1 ? shortSha(record.files[0].sha256) : record.files.length > 1 ? `${record.files.length} files, see report` : '—'} />
          <Field label="Verified" value={record.shaVerified === true ? '✓ verified' : record.shaVerified === false ? '✗ FAILED' : '—'} />
        </div>
      )}

      {record.shaVerified === false && (
        <p className="mt-2 text-[11px] text-red-400" role="alert">
          SHA-256 verification failed on this test — it cannot be marked Passed.
        </p>
      )}

      <textarea
        value={record.notes}
        onChange={(e) => setTestNotes('live', e.target.value)}
        placeholder="Notes (observed behavior, environment, anything off)…"
        className="mt-2 w-full text-[11px] rounded-lg bg-black/20 border border-white/10 px-2 py-1.5 text-nd-text-primary placeholder:text-nd-text-secondary/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-nd-teal"
        rows={2}
      />

      {(record.armedAt !== null || record.result) && (
        <div className="mt-2 flex flex-wrap gap-2 items-center">
          <button type="button" onClick={genReport} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-nd-teal text-nd-bg-0">
            <FileText className="w-3 h-3" aria-hidden="true" /> Generate Report
          </button>
          {report && (
            <>
              <button type="button" onClick={() => copyText(report, 'report')} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-white/10 text-nd-text-primary">
                <ClipboardCopy className="w-3 h-3" aria-hidden="true" /> {copied === 'report' ? 'Copied' : 'Copy Report'}
              </button>
              <button
                type="button"
                onClick={() => download(report, `nexdrop-device-test-${new Date().toISOString().slice(0, 10)}.txt`, 'text/plain')}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-white/10 text-nd-text-primary"
              >
                <Download className="w-3 h-3" aria-hidden="true" /> Download .txt
              </button>
              <button
                type="button"
                onClick={() => download(buildLiveTestJson(record, meta), `nexdrop-device-test-${caseId}-${new Date().toISOString().slice(0, 10)}.json`, 'application/json')}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-white/10 text-nd-text-primary"
              >
                <Braces className="w-3 h-3" aria-hidden="true" /> Download JSON
              </button>
            </>
          )}
          {summary && (
            <button type="button" onClick={() => copyText(summary, 'summary')} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-white/10 text-nd-text-primary">
              <Activity className="w-3 h-3" aria-hidden="true" /> {copied === 'summary' ? 'Copied' : 'Copy Diagnostics Summary'}
            </button>
          )}
        </div>
      )}

      {report && (
        <pre className="mt-3 text-[10px] font-mono whitespace-pre-wrap rounded-lg bg-black/30 border border-white/10 p-3 text-nd-text-primary max-h-72 overflow-y-auto">
          {report}
        </pre>
      )}
    </div>
  );
}

/** Matrix case card (cases 01-10) — unchanged manual-validation card. */
function CaseCard({ record }: { record: DeviceTestRecord }) {
  const armed = record.armedAt !== null && record.endedAt === null;
  const avg = deviceTestAvgBps(record);
  const duration = deviceTestDurationSeconds(record);
  const hasMeasured = record.files.length > 0 || record.lastBytes > 0;

  return (
    <div className={`rounded-xl border p-3 ${armed ? 'border-nd-teal' : record.result === 'passed' ? 'border-emerald-600/40' : record.result === 'failed' ? 'border-red-500/40' : 'border-white/10'}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-nd-text-primary">
            {record.caseId} — {record.title}
          </p>
          <p className="text-[11px] text-nd-text-secondary mt-0.5">{DEVICE_TEST_CASES.find((c) => c.id === record.caseId)?.hint || ''}</p>
        </div>
        <span className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 font-semibold ${armed ? 'bg-nd-teal text-nd-bg-0' : record.result === 'passed' ? 'bg-emerald-600/20 text-emerald-400' : record.result === 'failed' ? 'bg-red-500/20 text-red-400' : 'bg-white/5 text-nd-text-secondary'}`}>
          {armed ? 'ARMED — sampling' : record.result === 'passed' ? 'PASSED' : record.result === 'failed' ? 'FAILED' : 'not run'}
        </span>
      </div>

      {hasMeasured && (
        <div className="mt-2 rounded-lg bg-black/20 px-3 py-2 divide-y divide-white/5">
          <Field label="File(s)" value={record.files.map((f) => f.name).join(', ') || '—'} />
          <Field label="Total size" value={fmtBytes(record.totalBytes)} />
          <Field label="Start (first bytes)" value={fmtTime(record.transferStartedAt)} />
          <Field label="End (completion)" value={fmtTime(record.transferEndedAt)} />
          <Field label="Duration" value={fmtSec(duration)} />
          <Field label="Average" value={fmtMBps(avg)} />
          <Field label="Peak" value={fmtMBps(record.peakBps || null)} />
          <Field label="SHA-256" value={record.files.length === 1 ? shortSha(record.files[0].sha256) : record.files.length > 1 ? `${record.files.length} files, see report` : '—'} />
          <Field label="Verified" value={record.shaVerified === true ? '✓ verified' : record.shaVerified === false ? '✗ FAILED' : '—'} />
          <Field label="Connection" value={record.connection || 'unknown'} />
          <Field label="ICE candidates" value={record.iceCandidates || '—'} />
          <Field label="RTT" value={record.rttMs ? `${Math.round(record.rttMs)} ms` : '—'} />
          <Field label="DataChannel" value={record.dataChannelState || '—'} />
          <Field label="Last sampled bytes" value={fmtBytes(record.lastBytes)} />
        </div>
      )}

      {armed && record.lastSampleBps >= 0 && (
        <p className="mt-2 text-[11px] font-mono text-nd-teal">
          live: {fmtMBps(record.lastSampleBps || null)} · {record.connection || 'connection unknown'} · {record.dataChannelState || 'channel —'}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2 items-center">
        {!armed && !record.result && (
          <button type="button" onClick={() => armTest(record.caseId)} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-nd-teal text-nd-bg-0">
            <Play className="w-3 h-3" aria-hidden="true" /> Start Test
          </button>
        )}
        {armed && (
          <>
            <button
              type="button"
              onClick={() => markTest(record.caseId, 'passed')}
              disabled={record.shaVerified === false}
              className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg ${record.shaVerified === false ? 'bg-white/5 text-nd-text-secondary cursor-not-allowed' : 'bg-emerald-600 text-white'}`}
              title={record.shaVerified === false ? 'SHA-256 verification failed — cannot be marked Passed' : 'Record the owner verdict'}
            >
              <Check className="w-3 h-3" aria-hidden="true" /> Mark Passed
            </button>
            <button type="button" onClick={() => markTest(record.caseId, 'failed')} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-500/40 text-red-400">
              <Ban className="w-3 h-3" aria-hidden="true" /> Mark Failed
            </button>
          </>
        )}
        {(record.armedAt !== null || record.result) && (
          <button type="button" onClick={() => resetTest(record.caseId)} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-white/10 text-nd-text-secondary">
            <RotateCcw className="w-3 h-3" aria-hidden="true" /> Reset
          </button>
        )}
      </div>

      {record.shaVerified === false && (
        <p className="mt-2 text-[11px] text-red-400" role="alert">
          SHA-256 verification failed on this test — it cannot be marked Passed.
        </p>
      )}

      <textarea
        value={record.notes}
        onChange={(e) => setTestNotes(record.caseId, e.target.value)}
        placeholder="Notes (observed behavior, environment, anything off)…"
        className="mt-2 w-full text-[11px] rounded-lg bg-black/20 border border-white/10 px-2 py-1.5 text-nd-text-primary placeholder:text-nd-text-secondary/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-nd-teal"
        rows={2}
      />
    </div>
  );
}

export default function DeviceTestPanel() {
  const snap = useSyncExternalStore(subscribeDeviceTest, getDeviceTestSnapshot, getServerDeviceTestSnapshot);
  const [report, setReport] = useState('');
  const [copied, setCopied] = useState(false);
  const [guidedId, setGuidedId] = useState('live');

  if (!snap.open) return null;
  const { records, meta } = snap;
  const guidedDef = GUIDED_CASES.find((c) => c.id === guidedId) ?? GUIDED_CASES[0];
  const liveRecord = records.find((r) => r.caseId === guidedDef.id) ?? null;
  const matrixRecords = records.filter((r) => MANUAL_CASES.some((c) => c.id === r.caseId));

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — the report stays visible/selectable
    }
  };

  const downloadReport = () => {
    const blob = new Blob([report], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexdrop-physical-device-report-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-[100] bg-nd-bg-0/95 backdrop-blur-sm overflow-y-auto" role="dialog" aria-label="Device Test & Diagnostics">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-nd-text-primary">NEXDROP — Device Test &amp; Diagnostics</h2>
            <p className="text-[11px] text-nd-text-secondary mt-0.5">
              Real-device diagnostics. Values are measured by the real engines — never fabricated. The
              transfer engine is untouched; this screen only observes it. Diagnostics stay on this
              device.
            </p>
          </div>
          <button type="button" onClick={closeDeviceTest} aria-label="Close Device Test" className="p-2 rounded-lg border border-white/10 text-nd-text-secondary hover:text-nd-text-primary shrink-0">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <section className="mt-4 rounded-xl border border-white/10 p-3">
          <p className="text-xs font-semibold text-nd-text-primary mb-2">Devices &amp; network</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(['deviceA', 'deviceB'] as const).map((key) => (
              <div key={key}>
                <label className="text-[10px] text-nd-text-secondary" htmlFor={`dt-${key}`}>
                  {key === 'deviceA' ? 'Device A (sender)' : 'Device B (receiver)'} — Android / Chrome / model
                </label>
                <div className="flex gap-1">
                  <input
                    id={`dt-${key}`}
                    value={meta[key]}
                    onChange={(e) => setDeviceTestMeta({ [key]: e.target.value })}
                    placeholder="e.g. Android 13 · Pixel 7 · Chrome 129"
                    className="w-full text-xs rounded-lg bg-black/20 border border-white/10 px-2 py-1.5 text-nd-text-primary placeholder:text-nd-text-secondary/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-nd-teal"
                  />
                  <button
                    type="button"
                    onClick={() => setDeviceTestMeta({ [key]: thisDeviceLabel() || meta[key] })}
                    title="Fill from this device's user agent (real data)"
                    className="text-[10px] px-2 rounded-lg border border-white/10 text-nd-text-secondary hover:text-nd-text-primary shrink-0"
                  >
                    Use this device
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2">
            <label className="text-[10px] text-nd-text-secondary" htmlFor="dt-network">Network</label>
            <input
              id="dt-network"
              value={meta.network}
              onChange={(e) => setDeviceTestMeta({ network: e.target.value })}
              placeholder="Wi-Fi / hotspot / other (as actually used)"
              className="w-full text-xs rounded-lg bg-black/20 border border-white/10 px-2 py-1.5 text-nd-text-primary placeholder:text-nd-text-secondary/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-nd-teal"
            />
          </div>
          <div className="mt-2">
            <label className="text-[10px] text-nd-text-secondary" htmlFor="dt-extra">General notes</label>
            <textarea
              id="dt-extra"
              value={meta.extra}
              onChange={(e) => setDeviceTestMeta({ extra: e.target.value })}
              rows={2}
              className="w-full text-xs rounded-lg bg-black/20 border border-white/10 px-2 py-1.5 text-nd-text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-nd-teal"
            />
          </div>
        </section>

        <div className="mt-4">
          <p className="text-xs font-semibold text-nd-text-secondary mb-1">Guided diagnostics — pick a scenario</p>
          <div className="flex flex-wrap gap-1.5 mb-2" role="tablist" aria-label="Guided test scenarios">
            {GUIDED_CASES.map((c) => {
              const r = records.find((x) => x.caseId === c.id);
              const armed = r && r.armedAt !== null && r.endedAt === null;
              const done = r?.result === 'passed' ? ' ✓' : r?.result === 'failed' ? ' ✗' : '';
              return (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={c.id === guidedDef.id}
                  onClick={() => setGuidedId(c.id)}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg border ${armed ? 'border-nd-teal text-nd-teal' : c.id === guidedDef.id ? 'bg-white/10 text-nd-text-primary border-white/20' : 'border-white/10 text-nd-text-secondary hover:text-nd-text-primary'}`}
                >
                  {c.id === 'live' ? c.title : c.id.toUpperCase()}{done}
                </button>
              );
            })}
          </div>
          {liveRecord && <LiveCard record={liveRecord} meta={meta} caseDef={guidedDef} />}
        </div>

        <p className="mt-5 text-xs font-semibold text-nd-text-secondary">Manual validation matrix (10 cases)</p>
        <div className="mt-1 space-y-3">
          {matrixRecords.map((r) => (
            <CaseCard key={r.caseId} record={r} />
          ))}
        </div>

        <section className="mt-6 rounded-xl border border-white/10 p-3">
          <div className="flex flex-wrap gap-2 items-center">
            <button type="button" onClick={() => setReport(buildDeviceTestReport())} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-nd-teal text-nd-bg-0">
              <FileText className="w-3 h-3" aria-hidden="true" /> Generate Full Report
            </button>
            {report && (
              <>
                <button type="button" onClick={copyReport} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-white/10 text-nd-text-primary">
                  <ClipboardCopy className="w-3 h-3" aria-hidden="true" /> {copied ? 'Copied' : 'Copy'}
                </button>
                <button type="button" onClick={downloadReport} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-white/10 text-nd-text-primary">
                  <Download className="w-3 h-3" aria-hidden="true" /> Download .txt
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => { if (confirm('Clear all recorded Device Test results?')) { clearAllTests(); setReport(''); } }}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-red-500/40 text-red-400 ml-auto"
            >
              <Trash2 className="w-3 h-3" aria-hidden="true" /> Clear all
            </button>
          </div>
          {report && (
            <pre className="mt-3 text-[10px] font-mono whitespace-pre-wrap rounded-lg bg-black/30 border border-white/10 p-3 text-nd-text-primary max-h-72 overflow-y-auto">
              {report}
            </pre>
          )}
        </section>

        <p className="mt-4 text-[10px] text-nd-text-secondary">
          All values are measured on this device (engine telemetry, getStats()). Nothing is uploaded —
          reports and JSON exports stay local until you share them.
        </p>
      </div>
    </div>
  );
}
