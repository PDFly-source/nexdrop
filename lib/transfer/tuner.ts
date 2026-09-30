/**
 * Link profile tuner — MEASURED cross-transfer learning, never faked.
 *
 * The sender starts every session conservatively at 64 KiB chunks (clamped
 * to the negotiated SCTP maxMessageSize). When a transfer completes without
 * congestion stalls at a healthy measured throughput, the next transfer in
 * the same session may use a larger chunk. Any instability (send error,
 * ACK starvation, receiver write-bound) resets the profile to 64 KiB.
 *
 * This is browser-module state only — nothing persistent, nothing global
 * beyond the loaded page. It stores a single number: the learned chunk size.
 */

import { CHUNK_SIZE } from '@/types/transfer';

export const ADAPT_MAX_CHUNK = 256 * 1024; // hard ceiling for learned sizes

const profile = { chunkSize: 0 };

/** Reset to the conservative default (new session / instability). */
export function resetLinkProfile(): void {
  profile.chunkSize = 0;
}

/** Chunk size for a new transfer: learned when stable, else 64 KiB. */
export function initialChunkSize(negotiatedMaxMessageSize: number): number {
  const limit =
    negotiatedMaxMessageSize && negotiatedMaxMessageSize > 0 ? negotiatedMaxMessageSize : 65536;
  const desired = profile.chunkSize > 0 ? profile.chunkSize : CHUNK_SIZE;
  return Math.max(16 * 1024, Math.min(desired, limit - 256));
}

/** A transfer completed: learn only from clean, well-measured runs. */
export function noteTransferSuccess(chunkSize: number, throughputBps: number, stalls: number): void {
  if (stalls > 0 || throughputBps <= 1024 * 1024) {
    // Unstable or trivially small run — stay conservative.
    profile.chunkSize = 0;
    return;
  }
  profile.chunkSize = Math.min(ADAPT_MAX_CHUNK, chunkSize * 2);
}

/** A transfer failed: the link proved unstable at this size — reset. */
export function noteTransferFailure(): void {
  profile.chunkSize = 0;
}
