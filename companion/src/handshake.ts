/**
 * Ephemeral session authentication for the Turbo transport (mission Phase 14).
 *
 * The session token is minted during pairing (QR / ephemeral signaling) and
 * lives only for the session TTL. Both sides prove possession with
 * HMAC-SHA256(token, nonce | "ndt1-hello"), then the server answers with
 * AUTH_OK echoing the client's nonce — a challenge/response that is bound
 * to one connection, so a captured HELLO cannot be replayed later (the
 * server rejects any second HELLO on the same connection and any HELLO
 * whose session is already completed).
 *
 * No permanent keys are stored; the token is passed in memory by whoever
 * created the session (CLI arg / QR-scan result on a real device).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const NDT_AUTH_TTL_MS = 10 * 60 * 1000; // pairing and session share a 10-min TTL

export function newSessionToken(): { token: string; tokenBytes: Buffer; sessionId: string } {
  const tokenBytes = randomBytes(32);
  const token = tokenBytes.toString('base64url');
  const sessionId = randomBytes(4).toString('hex');
  return { token, tokenBytes, sessionId };
}

/** Client proof for HELLO: HMAC(token, nonce | label). */
export function helloProof(tokenBytes: Buffer, nonce: number): Buffer {
  const nonceB = Buffer.alloc(4);
  nonceB.writeUInt32BE(nonce, 0);
  return createHmac('sha256', tokenBytes).update(Buffer.concat([nonceB, Buffer.from('ndt1-hello')])).digest();
}

/** Server-side verification of a HELLO proof (constant time). */
export function verifyHelloProof(tokenBytes: Buffer, nonce: number, proof: Uint8Array): boolean {
  const expect = helloProof(tokenBytes, nonce);
  if (proof.length !== expect.length) return false;
  return timingSafeEqual(expect, Buffer.from(proof));
}

/** Ongoing-connection packet MAC key: derived, never the token itself. */
export function deriveChannelKey(tokenBytes: Buffer, sessionId: string): Buffer {
  return createHmac('sha256', tokenBytes).update(`ndt1-chan|${sessionId}`).digest();
}

/** Fresh random nonce for HELLO / PING. */
export function randomNonce(): number {
  return randomBytes(4).readUInt32BE(0);
}

export type RejectReason =
  | 0x01 // bad token proof
  | 0x02 // unknown session
  | 0x03 // session expired
  | 0x04 // session already completed
  | 0x05; // protocol version

export const REJECT_LABELS: Record<number, string> = {
  0x01: 'bad-token',
  0x02: 'unknown-session',
  0x03: 'session-expired',
  0x04: 'session-completed',
  0x05: 'bad-version',
};
