/**
 * SignalingClient — thin client for the ephemeral signaling service.
 *
 * Transport security: HTTPS only, short timeouts, no credentials. The
 * service stores only pairing session metadata (never files, keys, or
 * history) and destroys the session the moment the DataChannel opens.
 */

export interface SignalSessionInfo {
  sessionId: string;
  hostToken: string;
  joinToken: string;
  expiresAt: number;
  version: number;
}

export interface SignalValidateInfo {
  status: 'waiting' | 'offer-published' | 'join-requested' | 'host-accepted' | 'answered' | 'declined' | 'connected';
  hasOffer: boolean;
  deviceName: string;
  platform: string | null;
  fileCount: number | null;
  totalBytes: number | null;
  connectionType: string;
  expiresAt: number;
}

export interface SignalHostPoll {
  status:
    | 'waiting'
    | 'offer-published'
    | 'join-requested'
    | 'host-accepted'
    | 'answered'
    | 'declined'
    | 'connected';
  /** Present when status === 'join-requested' — renders the host's decision card. */
  joinRequest?: { deviceName: string; platform: string | null };
  answer?: { sdp: string; publicKey: string };
}

export interface SignalJoinPoll {
  /** 'join-requested' = request filed, awaiting the host's decision. */
  status: 'join-requested' | 'host-accepted' | 'answered' | 'declined';
  /** Present when the host accepted and the offer is ready to consume. */
  offer?: { sdp: string; publicKey: string; deviceName: string };
  offerReady?: boolean;
}

export type SignalError =
  | 'network'
  | 'expired'
  | 'not-found'
  | 'already-joined'
  | 'offer-not-ready'
  | 'declined'
  | 'invalid'
  | 'server';

export class SignalingError extends Error {
  constructor(public kind: SignalError, message?: string) {
    super(message || kind);
    this.name = 'SignalingError';
  }
}

const TIMEOUT_MS = 10000;

/** Public endpoint of the deployed ephemeral signaling function. */
export const SIGNALING_ENDPOINT =
  (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_SIGNALING_URL) ||
  'https://nex-agent-5f552f95.base44.app/functions/nexdropSignal';

async function call<T>(endpoint: string, payload: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new SignalingError('network');
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    if (!res.ok) throw new SignalingError('server');
  }
  if (res.ok) return data as T;
  switch (data?.error) {
    case 'expired':
      throw new SignalingError('expired');
    case 'session-not-found':
      throw new SignalingError('not-found');
    case 'already-joined':
      throw new SignalingError('already-joined');
    case 'offer-not-ready':
      throw new SignalingError('offer-not-ready');
    case 'declined':
      throw new SignalingError('declined');
    case 'rate-limited':
    case 'payload-too-large':
    case 'invalid-offer':
    case 'invalid-answer':
    case 'invalid-state':
    case 'bad-json':
    case 'origin-not-allowed':
      throw new SignalingError('invalid');
    default:
      throw new SignalingError('server');
  }
}

export class SignalingClient {
  constructor(private endpoint: string = SIGNALING_ENDPOINT) {}

  /** HOST: create the short-lived session (before showing the QR). */
  createSession(meta: {
    deviceName: string;
    platform?: string;
    fileCount?: number;
    totalBytes?: number;
  }): Promise<SignalSessionInfo> {
    return call<SignalSessionInfo>(this.endpoint, { action: 'create', ...meta });
  }

  /** HOST: publish the gathered offer (self-contained ICE). */
  publishOffer(hostToken: string, sdp: string, publicKey: string): Promise<{ ok: true }> {
    return call(this.endpoint, { action: 'publishOffer', hostToken, sdp, publicKey });
  }

  /** HOST: poll for the joiner's answer / state. */
  pollHost(hostToken: string): Promise<SignalHostPoll> {
    return call<SignalHostPoll>(this.endpoint, { action: 'pollHost', hostToken });
  }

  /** Either side: DataChannel open — session is destroyed server-side. */
  reportConnected(token: { hostToken?: string; joinToken?: string }): Promise<{ ok: true }> {
    return call(this.endpoint, { action: 'reportConnected', ...token });
  }

  /** JOINER: validate the scanned session BEFORE filing a request. */
  validate(joinToken: string): Promise<SignalValidateInfo> {
    return call<SignalValidateInfo>(this.endpoint, { action: 'validate', joinToken });
  }

  /** JOINER: file a single-use join request. The HOST decides; no offer
   *  material is returned — only confirmation the request was filed. */
  joinRequest(
    joinToken: string,
    meta: { deviceName: string; platform?: string }
  ): Promise<{ ok: true; deviceName: string; expiresAt: number }> {
    return call(this.endpoint, { action: 'joinRequest', joinToken, ...meta });
  }

  /** JOINER: poll for the host's decision (and the offer once accepted). */
  pollJoin(joinToken: string): Promise<SignalJoinPoll> {
    return call<SignalJoinPoll>(this.endpoint, { action: 'pollJoin', joinToken });
  }

  /** HOST: accept the pending join request — the authorization decision. */
  hostAccept(hostToken: string): Promise<{ ok: true; deviceName: string }> {
    return call(this.endpoint, { action: 'hostAccept', hostToken });
  }

  /** HOST: decline the pending join request — nothing survives. */
  hostDecline(hostToken: string): Promise<{ ok: true }> {
    return call(this.endpoint, { action: 'hostDecline', hostToken });
  }

  /** JOINER: publish the gathered answer. */
  publishAnswer(joinToken: string, sdp: string, publicKey: string): Promise<{ ok: true }> {
    return call(this.endpoint, { action: 'publishAnswer', joinToken, sdp, publicKey });
  }

  /** JOINER: decline — the host is notified, nothing survives. */
  decline(joinToken: string): Promise<{ ok: true }> {
    return call(this.endpoint, { action: 'decline', joinToken });
  }
}
