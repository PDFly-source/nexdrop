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
  // Measured fat link: ≥ 20 MiB/s sustained with ZERO stalls is a LAN-class
  // path (cellular-shaped links physically cannot produce it — see the
  // cellular suite's ~500 KB/s ceiling). It earns the ceiling immediately
  // instead of paying the 64→128→256 learning ladder on the next transfer:
  // the 2026-10-01 CI sweep measured a 256 KiB pin at +26%/+18% over the
  // adaptive ramp (28.6/32.9 vs 22.7/27.8 MiB/s on the 341.48 MB file).
  if (throughputBps >= 20 * 1024 * 1024) {
    profile.chunkSize = ADAPT_MAX_CHUNK;
    return;
  }
  profile.chunkSize = Math.min(ADAPT_MAX_CHUNK, chunkSize * 2);
}

/** A transfer failed: the link proved unstable at this size — reset. */
export function noteTransferFailure(): void {
  profile.chunkSize = 0;
}
