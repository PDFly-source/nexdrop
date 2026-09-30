'use client';
import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { renderPairingQr } from '@/lib/pairing/render';
import { isSignalQr } from '@/lib/pairing/signalPayload';
import type { PairingQr } from '@/hooks/useNexDropSession';
import type { SendFlowState } from '@/lib/transfer/sendFlow';

interface Props {
  state: SendFlowState;
  offerQr: PairingQr | null;
  error: string | null;
  queuedCount: number;
  onCancel: () => void;
  onRetry: () => void;
  onOpenDevices: () => void;
  onRemoveFiles: () => void;
}
const copy: Record<SendFlowState, string> = {
  idle: 'Choose files to send', send_intent: 'Choose files to send', file_queued: 'File ready',
  auto_pairing: 'Preparing a secure connection', waiting_for_peer: 'Ready to connect',
  peer_request_received: 'Incoming connection', connecting: 'Connecting', connected: 'Connected',
  preparing_transfer: 'Preparing transfer', transferring: 'Sending', verifying: 'Verifying',
  completed: 'Transfer complete', failed: "Couldn't connect", cancelled: 'Connection cancelled',
};
export function SendPairingSurface({ state, offerQr, error, queuedCount, onCancel, onRetry, onOpenDevices, onRemoveFiles }: Props) {
  const [image, setImage] = useState<{ code: string; url: string } | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
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
    : error === 'unsupported-browser' ? 'This browser does not support WebRTC data channels.'
    : error === 'declined' ? 'The other device declined the connection.'
    : error;
  return (
    <section aria-labelledby="send-connection-heading" data-testid="send-pairing" data-state={state}
      className="rounded-2xl border border-nd-teal/20 bg-nd-surface p-5 space-y-4">
      <div>
        {queuedCount > 0 && <p className="text-xs text-nd-text-secondary mb-1">{queuedCount} {queuedCount === 1 ? 'file' : 'files'} ready</p>}
        <h2 id="send-connection-heading" className="text-base font-semibold text-nd-text-primary">Connect a device</h2>
        <p role="status" aria-live="polite" aria-atomic="true" className="text-sm text-nd-teal-bright mt-2 flex items-center gap-2">
          {busy ? <Loader2 aria-hidden="true" className="w-4 h-4 motion-safe:animate-spin" /> : <ShieldCheck aria-hidden="true" className="w-4 h-4" />}
          {expired && failed ? 'Pairing expired' : copy[state]}
        </p>
      </div>
      {code && image?.code === code && !qrError && (
        <div className="text-center space-y-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.url} alt="Pairing QR code. Scan this code from the other device" width={280} height={280}
            className="mx-auto max-w-full rounded-xl border-4 border-nd-teal/30" />
          <p className="text-sm text-nd-text-primary">Scan this code from the other device</p>
          <p className="text-xs text-nd-text-secondary">Waiting for the other device…</p>
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
