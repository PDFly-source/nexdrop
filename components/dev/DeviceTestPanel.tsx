'use client';

/**
 * Developer-only "Device Test" screen — OWNER-RUN physical validation.
 *
 * Opt-in exactly like the diagnostics panel (localStorage
 * 'nexdrop:diagnostics' = '1' or ?diag=1). Records the 10-case physical
 * matrix with values measured by the real engines — never fabricated:
 *  - file name/size/SHA-256 from the real transfer engine completions,
 *  - avg/peak speed from real timestamps + byte counts,
 *  - connection/ICE/RTT from getStats() samples,
 *  - Pass/Fail is the owner's explicit verdict.
 * The normal ONE QR → Accept → automatic connection → transfer journey is
 * untouched; this screen only OBSERVES it.
 */

import React, { useState, useSyncExternalStore } from 'react';
import { X, Play, Check, Ban, RotateCcw, ClipboardCopy, Download, FileText, Trash2 } from 'lucide-react';
import type { DeviceTestRecord } from '@/types/devicetest';
import { isDevModeEnabled } from '@/lib/devicetest/gate';
import { DEVICE_TEST_CASES } from '@/lib/devicetest/matrix';
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
  const [enabled] = useState(isDevModeEnabled);
  const snap = useSyncExternalStore(subscribeDeviceTest, getDeviceTestSnapshot, getServerDeviceTestSnapshot);
  const [report, setReport] = useState('');
  const [copied, setCopied] = useState(false);

  if (!enabled || !snap.open) return null;
  const { records, meta } = snap;

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
    <div className="fixed inset-0 z-[100] bg-nd-bg-0/95 backdrop-blur-sm overflow-y-auto" role="dialog" aria-label="Device Test — developer only">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-nd-text-primary">NEXDROP — Device Test</h2>
            <p className="text-[11px] text-nd-text-secondary mt-0.5">
              Developer-only physical validation. Values are measured by the real engines — never
              fabricated. Run the matrix on two real phones; CI and browser-automation results stay
              separate.
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

        <div className="mt-4 space-y-3">
          {records.map((r) => (
            <CaseCard key={r.caseId} record={r} />
          ))}
        </div>

        <section className="mt-6 rounded-xl border border-white/10 p-3">
          <div className="flex flex-wrap gap-2 items-center">
            <button type="button" onClick={() => setReport(buildDeviceTestReport())} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-nd-teal text-nd-bg-0">
              <FileText className="w-3 h-3" aria-hidden="true" /> Generate Report
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
          Physical matrix not complete until you run it on two real phones. Until then NexDrop carries
          CI + browser-automation verification only.
        </p>
      </div>
    </div>
  );
}
