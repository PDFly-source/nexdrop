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
  /** honest transport classification from the selected candidate pair */
  transport: 'direct' | 'relay' | 'unknown';
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
}

export function transportLabel(t: TransportStats | null | undefined): string {
  if (!t || t.transport === 'unknown') return 'Unknown';
  return t.transport === 'relay' ? 'Relay' : 'Direct P2P';
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

  let transport: TransportStats['transport'] = 'unknown';
  if (localType && remoteType) {
    transport =
      localType === 'relay' || remoteType === 'relay'
        ? 'relay'
        : 'direct'; // host/srflx/prflx candidates reach the peer directly
  }

  return {
    connected: !!(bestPair && (bestPair.state === 'succeeded' || bestPair.selected === true)),
    transport,
    localCandidateType: localType,
    remoteCandidateType: remoteType,
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
    dtlsState,
    sctpState,
    pairState: bestPair?.state ?? null,
    timestamp: Date.now(),
  };
}
