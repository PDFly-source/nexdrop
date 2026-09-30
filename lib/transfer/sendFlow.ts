import type { SessionState } from '@/types/session';
import type { FileItem } from '@/types/transfer';

/** UX orchestration only. Session and transfer engines remain authoritative. */
export type SendIntentState = 'idle' | 'send_intent' | 'file_queued' | 'auto_pairing' | 'failed' | 'cancelled';
export type SendFlowState = SendIntentState | 'waiting_for_peer' | 'peer_request_received' |
  'connecting' | 'connected' | 'preparing_transfer' | 'transferring' | 'verifying' | 'completed';
export type SendFlowEvent = 'SEND' | 'QUEUE' | 'PAIR' | 'FAIL' | 'CANCEL';
export function sendFlowReducer(state: SendIntentState, event: SendFlowEvent): SendIntentState {
  switch (event) {
    case 'SEND': return state === 'idle' ? 'send_intent' : state;
    case 'QUEUE': return 'file_queued';
    case 'PAIR': return 'auto_pairing';
    case 'FAIL': return 'failed';
    case 'CANCEL': return 'cancelled';
  }
}
export const pairingInProgress = (session: SessionState) =>
  ['hosting', 'hosting-offer', 'waiting-for-join', 'join-requested', 'accepted',
    'awaiting-accept', 'joiner-answer', 'connecting'].includes(session);
export const peerConnected = (session: SessionState) =>
  session === 'connected' || session === 'transferring' || session === 'completed';
export function sendFlowState(intent: SendIntentState, session: SessionState, queue: FileItem[]): SendFlowState {
  if (intent === 'cancelled') return 'cancelled';
  if (session === 'failed' || session === 'declined' || session === 'disconnected' || intent === 'failed') return 'failed';
  if (session === 'join-requested') return 'peer_request_received';
  if (session === 'accepted' || session === 'connecting') return 'connecting';
  if (session === 'hosting' || session === 'hosting-offer') return 'waiting_for_peer';
  if (queue.some(f => f.status === 'transferring' || f.status === 'paused')) return 'transferring';
  if (queue.some(f => f.status === 'preparing')) return 'preparing_transfer';
  if (!queue.some(f => f.status === 'queued') && queue.some(f => f.status === 'failed' || f.integrityVerified === false)) return 'failed';
  const completed = queue.filter(f => f.status === 'completed');
  if (!queue.some(f => f.status === 'queued') && completed.length) {
    return completed.every(f => f.integrityVerified === true) ? 'completed' : 'verifying';
  }
  if (peerConnected(session)) return 'connected';
  return intent;
}
