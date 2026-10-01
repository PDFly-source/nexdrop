/**
 * REAL transport statistics via RTCPeerConnection.getStats().
 *
 * Answers the questions that actually explain physical transfer speed:
 * - Is the selected ICE candidate pair direct (host/srflx) or relayed (TURN)?
 * - What is the true network RTT of the selected pair?
 * - How many bytes has the transport carried, and at what available bitrate?
 *
 * Every value is read straight from the browser's own stats report — nothing
 * is synthesized. Fields are null when the browser does not expose them.
 */

export interface TransportStats {
  /** true when the peer connection reports a succeeded, selected pair. */
  connected: boolean;
  /** honest transport classification from the selected candidate pair:
   *  LOCAL_DIRECT (host<->host over a private/mDNS address — same LAN),
   *  INTERNET_DIRECT (srflx/prflx NAT traversal, or host with a public IP),
   *  RELAY (TURN), or unknown. Derived ONLY from real candidate data. */
  transport: 'local' | 'internet' | 'relay' | 'unknown';
  /** selected pair local candidate IP/address (may be an mDNS .local name) */
  localAddress: string | null;
  /** selected pair remote candidate IP/address (may be an mDNS .local name) */
  remoteAddress: string | null;
  /** selected pair local candidate type: host | srflx | prflx | relay */
  localCandidateType: string | null;
  /** selected pair remote candidate type: host | srflx | prflx | relay */
  remoteCandidateType: string | null;
  /** candidate-pair currentRoundTripTime in ms */
  rttMs: number | null;
  /** candidate-pair bytesSent (network transport level) */
  bytesSent: number | null;
  /** candidate-pair bytesReceived (network transport level) */
  bytesReceived: number | null;
  /** candidate-pair availableOutgoingBitrate in bits/s (estimate, if exposed) */
  outgoingBitrateBps: number | null;
  /** candidate-pair availableIncomingBitrate in bits/s (estimate, if exposed) */
  incomingBitrateBps: number | null;
  /** selected pair network protocol ('udp'|'tcp'), from the candidates */
  protocol: string | null;
  /** local candidate network interface type as reported by the browser:
   *  'wifi' | 'cellular' | 'ethernet' | ... — the ONLY reliable answer to
   *  "is the 5G icon a cellular WebRTC path?" (Chrome local candidate).
   *  Null when the browser does not expose it (privacy restrictions). */
  networkType: string | null;
  /** relay protocol ('udp'|'tcp'|'tls') when a relay candidate is selected */
  relayProtocol: string | null;
  /** selected candidate-pair STUN requests sent (loss evidence denominator) */
  requestsSent: number | null;
  /** selected candidate-pair STUN responses received */
  responsesReceived: number | null;
  /** selected candidate-pair consent/STUN retransmissions sent — real
   *  network-loss evidence on the active path (higher = lossier path) */
  retransmissionsSent: number | null;
  /** totalRoundTripTime (seconds) of the selected pair when exposed */
  totalRoundTripTimeS: number | null;
  /** negotiated SCTP maxMessageSize (pc.sctp.maxMessageSize), when readable */
  sctpMaxMessageSize: number | null;
  /** dtls transport state */
  dtlsState: string | null;
  /** sctp transport state */
  sctpState: string | null;
  /** selected candidate-pair state */
  pairState: string | null;
  timestamp: number;
}

interface CandidateLike {
  type?: string;
  candidateType?: string;
  address?: string;
  relayProtocol?: string;
  url?: string;
  protocol?: string;
  networkType?: string;
}
interface PairLike {
  type?: string;
  state?: string;
  nominated?: boolean;
  selected?: boolean;
  localCandidateId?: string;
  remoteCandidateId?: string;
  currentRoundTripTime?: number;
  bytesSent?: number;
  bytesReceived?: number;
  availableOutgoingBitrate?: number;
  availableIncomingBitrate?: number;
  requestsSent?: number;
  responsesReceived?: number;
  retransmissionsSent?: number;
  totalRoundTripTime?: number;
}

export function transportLabel(t: TransportStats | null | undefined): string {
  if (!t || t.transport === 'unknown') return 'Unknown';
  if (t.transport === 'relay') return 'Relay';
  return t.transport === 'local' ? 'Local Direct' : 'Internet Direct';
}

/** RFC1918/ULA/link-local/mDNS — an address reachable only on the local network. */
function isPrivateAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  if (addr.endsWith('.local') || addr.endsWith('.local.')) return true; // mDNS-obfuscated host
  if (
    /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i.test(addr)
  ) return true;
  // IPv4-mapped / bracketed IPv6 ULA/link-local
  return false;
}

export async function sampleTransportStats(
  pc: RTCPeerConnection | null
): Promise<TransportStats | null> {
  if (!pc || typeof pc.getStats !== 'function') return null;
  let report: RTCStatsReport;
  try {
    report = await pc.getStats();
  } catch {
    return null;
  }

  const candidates = new Map<string, CandidateLike>();
  const bestRef: { pair: PairLike | null } = { pair: null };
  let dtlsState: string | null = null;
  let sctpState: string | null = null;

  report.forEach((entry: PairLike & CandidateLike & { id?: string }) => {
    const t = entry.type;
    if (t === 'candidate-pair') {
      // Prefer the browser's designated selected pair; fall back to the first
      // nominated succeeded pair (Firefox/Safari differences).
      const ok =
        entry.state === 'succeeded' || entry.state === 'in-progress' || entry.state === undefined;
      if ((entry.selected === true || entry.nominated === true) && ok) {
        if (!bestRef.pair || entry.selected === true) bestRef.pair = entry;
      } else if (!bestRef.pair && entry.state === 'succeeded') {
        bestRef.pair = entry;
      }
    } else if (t === 'local-candidate' || t === 'remote-candidate') {
      if (entry.id) candidates.set(entry.id, entry);
    } else if (t === 'transport') {
      dtlsState = typeof (entry as { dtlsState?: string }).dtlsState === 'string'
        ? (entry as { dtlsState: string }).dtlsState
        : dtlsState;
    } else if (t === 'sctp-transport') {
      sctpState = typeof (entry as { state?: string }).state === 'string'
        ? (entry as { state: string }).state
        : sctpState;
    }
  });

  const bestPair = bestRef.pair;
  const local = bestPair?.localCandidateId ? candidates.get(bestPair.localCandidateId) : undefined;
  const remote = bestPair?.remoteCandidateId
    ? candidates.get(bestPair.remoteCandidateId)
    : undefined;
  const localType = local?.candidateType || local?.type || null;
  const remoteType = remote?.candidateType || remote?.type || null;

  const localAddress = (local?.address as string | undefined) ?? (local as { ip?: string } | undefined)?.ip ?? null;
  const remoteAddress = (remote?.address as string | undefined) ?? (remote as { ip?: string } | undefined)?.ip ?? null;

  let transport: TransportStats['transport'] = 'unknown';
  if (localType && remoteType) {
    if (localType === 'relay' || remoteType === 'relay') {
      transport = 'relay';
    } else if (remoteType === 'host') {
      // host<->host: the peer's own interface is directly reachable. When
      // its address is private/mDNS-obfuscated, both devices share a LAN —
      // LOCAL_DIRECT. A public host address (no NAT, e.g. a server) is
      // INTERNET_DIRECT.
      transport = isPrivateAddress(remoteAddress) ? 'local' : 'internet';
    } else {
      // srflx/prflx: NAT traversal succeeded — traffic leaves the local network.
      transport = 'internet';
    }
  }

  // Negotiated SCTP max message size — read from the live object graph,
  // never assumed (browsers negotiate 16 KiB..256 KiB depending on peer).
  let sctpMaxMessageSize: number | null = null;
  try {
    const sctp = (pc as unknown as { sctp?: { maxMessageSize?: number } }).sctp;
    if (sctp && typeof sctp.maxMessageSize === 'number' && sctp.maxMessageSize > 0) {
      sctpMaxMessageSize = sctp.maxMessageSize;
    }
  } catch {
    sctpMaxMessageSize = null;
  }

  return {
    connected: !!(bestPair && (bestPair.state === 'succeeded' || bestPair.selected === true)),
    transport,
    localAddress,
    remoteAddress,
    localCandidateType: localType,
    remoteCandidateType: remoteType,
    protocol: local?.protocol || remote?.protocol || null,
    networkType: local?.networkType ?? null,
    relayProtocol: local?.relayProtocol ?? remote?.relayProtocol ?? null,
    requestsSent: typeof bestPair?.requestsSent === 'number' ? bestPair.requestsSent : null,
    responsesReceived: typeof bestPair?.responsesReceived === 'number' ? bestPair.responsesReceived : null,
    retransmissionsSent:
      typeof bestPair?.retransmissionsSent === 'number' ? bestPair.retransmissionsSent : null,
    totalRoundTripTimeS:
      typeof bestPair?.totalRoundTripTime === 'number' ? bestPair.totalRoundTripTime : null,
    sctpMaxMessageSize,
    rttMs:
      typeof bestPair?.currentRoundTripTime === 'number' && bestPair.currentRoundTripTime >= 0
        ? Math.round(bestPair.currentRoundTripTime * 1000)
        : null,
    bytesSent: typeof bestPair?.bytesSent === 'number' ? bestPair.bytesSent : null,
    bytesReceived: typeof bestPair?.bytesReceived === 'number' ? bestPair.bytesReceived : null,
    outgoingBitrateBps:
      typeof bestPair?.availableOutgoingBitrate === 'number'
        ? bestPair.availableOutgoingBitrate
        : null,
    incomingBitrateBps:
      typeof bestPair?.availableIncomingBitrate === 'number'
        ? bestPair.availableIncomingBitrate
        : null,
    dtlsState,
    sctpState,
    pairState: bestPair?.state ?? null,
    timestamp: Date.now(),
  };
}
