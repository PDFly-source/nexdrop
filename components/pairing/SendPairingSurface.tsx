'use client';
import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck, Lock, Zap, Copy, Check } from 'lucide-react';
import { renderPairingQr } from '@/lib/pairing/render';
import { formatBytes } from '@/lib/utils/format';
import { isSignalQr } from '@/lib/pairing/signalPayload';
import type { PairingQr } from '@/hooks/useNexDropSession';
import type { SendFlowState } from '@/lib/transfer/sendFlow';

interface Props {
  state: SendFlowState;
  offerQr: PairingQr | null;
  error: string | null;
  queuedCount: number;
  /** First queued file name + totals — the receiver sees who/what before accepting. */
  fileSummary: { firstName: string; totalBytes: number; count: number } | null;
  /** Wall-clock ms when the pairing expires (null = not pairing). */
  expiresAt: number | null;
  onCancel: () => void;
  onRetry: () => void;
  onOpenDevices: () => void;
  onRemoveFiles: () => void;
}
const copy: Record<SendFlowState, string> = {
  idle: 'Choose files to send', send_intent: 'Choose files to send', file_queued: 'File ready',
  auto_pairing: 'Preparing a secure connection', waiting_for_peer: 'Waiting for receiver…',
  peer_request_received: 'Receiver accepted', connecting: 'Connecting securely…',
  connected: 'Connected', preparing_transfer: 'Preparing transfer', transferring: 'Sending…',
  verifying: 'Verifying…', completed: 'Transfer complete', failed: "Couldn't connect",
  cancelled: 'Connection cancelled',
};
export function SendPairingSurface({ state, offerQr, error, queuedCount, fileSummary, expiresAt, onCancel, onRetry, onOpenDevices, onRemoveFiles }: Props) {
  const [image, setImage] = useState<{ code: string; url: string } | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  // Live countdown to the pairing's real expiry — never a decorative timer.
  useEffect(() => {
    if (!expiresAt) { setSecondsLeft(null); return; }
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  const copyCode = async () => {
    if (!code || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try { await navigator.clipboard.writeText(code); setCodeCopied(true); setTimeout(() => setCodeCopied(false), 2000); } catch { /* paste fallbacks remain */ }
  };
  // Only the existing NDPS1 one-scan payload. Never render legacy answer/carousel UI here.
  const code = state === 'waiting_for_peer' && offerQr && isSignalQr(offerQr.code) ? offerQr.code : null;
  useEffect(() => {
    if (!code) return;
    let disposed = false;
    void renderPairingQr(code, 640).then(url => {
      if (!disposed) { setImage({ code, url }); setQrError(null); }
    }).catch(() => { if (!disposed) setQrError('Could not display the connection code. Please try again.'); });
    return () => { disposed = true; };
  }, [code]);
  const expired = error === 'expired' || error === 'timeout';
  const failed = state === 'failed' || !!qrError;
  const busy = ['file_queued', 'auto_pairing', 'connecting', 'peer_request_received'].includes(state);
  const actionClass = 'min-h-[44px] rounded-xl px-4 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal';
  const details = error === 'signal-unavailable' || error === 'signal-network'
    ? 'The pairing service could not be reached. Check your connection.'
    : error === 'unsupported-browser' ? 'This browser does not support direct connections.'
    : error === 'declined' ? 'The other device declined the connection.'
    : error;
  return (
    <section aria-labelledby="send-connection-heading" data-testid="send-pairing" data-state={state}
      className="rounded-2xl border border-nd-teal/20 bg-nd-surface p-5 space-y-4">
      <div>
        {queuedCount > 0 && <p className="text-xs text-nd-text-secondary mb-1">{queuedCount} {queuedCount === 1 ? 'file' : 'files'} ready</p>}
        <h2 id="send-connection-heading" className="text-base font-semibold text-nd-text-primary">{state === 'waiting_for_peer' ? 'Ready to share' : 'Connect a device'}</h2>
        <p role="status" aria-live="polite" aria-atomic="true" className="text-sm text-nd-teal-bright mt-2 flex items-center gap-2">
          {busy ? <Loader2 aria-hidden="true" className="w-4 h-4 motion-safe:animate-spin" /> : <ShieldCheck aria-hidden="true" className="w-4 h-4" />}
          {expired && failed ? 'Pairing expired' : copy[state]}
        </p>
      </div>
      {code && image?.code === code && !qrError && (
        <div className="text-center space-y-3 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-300">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.url} alt="Pairing QR code. Scan this code from the other device" width={280} height={280}
            className="mx-auto max-w-full rounded-xl border-4 border-nd-teal/30" />
          <p className="text-sm text-nd-text-primary">Scan this QR with the receiving device</p>
          {fileSummary && (
            <p className="text-xs text-nd-text-secondary min-w-0">
              <span className="text-nd-text-primary font-medium truncate">{fileSummary.firstName}</span>
              {fileSummary.count > 1 ? ` +${fileSummary.count - 1} more` : ''}
              {' · '}{formatBytes(fileSummary.totalBytes)}
            </p>
          )}
          <p className="flex items-center justify-center gap-3 text-[11px] text-nd-text-secondary">
            <span className="inline-flex items-center gap-1"><Lock className="w-3 h-3" aria-hidden="true" /> Encrypted P2P</span>
            <span className="inline-flex items-center gap-1"><Zap className="w-3 h-3" aria-hidden="true" /> Direct transfer</span>
          </p>
          <p className="text-xs text-nd-text-secondary">
            Waiting for receiver…
            {secondsLeft !== null && <span className="ml-1 font-mono">Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</span>}
          </p>
          <button type="button" onClick={() => void copyCode()}
            className="inline-flex items-center gap-1.5 text-[11px] text-nd-text-secondary hover:text-nd-text-primary px-2 py-1 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-nd-teal">
            {codeCopied ? <Check className="w-3 h-3" aria-hidden="true" /> : <Copy className="w-3 h-3" aria-hidden="true" />}
            {codeCopied ? 'Pairing code copied' : 'Copy pairing code'}
          </button>
        </div>
      )}
      {failed && !expired && <p role="alert" className="text-sm text-nd-text-secondary">{qrError || details || "Couldn't connect. Please try again."}</p>}
      {(failed || state === 'cancelled') ? (
        <div className="flex flex-wrap gap-2">
          {queuedCount > 0 && <button onClick={onRetry} className={`${actionClass} bg-nd-teal text-nd-bg-0`}>Try again</button>}
          <button onClick={onOpenDevices} className={`${actionClass} border border-white/10 text-nd-text-primary`}>Open Devices</button>
          {state === 'cancelled' && queuedCount > 0 && <>
            <span className="text-xs text-nd-text-secondary self-center">Files kept in your queue.</span>
            <button onClick={onRemoveFiles} className={`${actionClass} border border-white/10 text-nd-text-primary`}>Remove {queuedCount === 1 ? 'file' : 'files'}</button>
          </>}
        </div>
      ) : (busy || state === 'waiting_for_peer') && (
        <button onClick={onCancel} className={`${actionClass} border border-white/10 text-nd-text-primary`}>Cancel connection</button>
      )}
      <p className="text-[11px] text-nd-text-secondary">Private · Direct · Fast</p>
    </section>
  );
}
