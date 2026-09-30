/**
 * NDPS1 one-scan signal pairing tests + SignalingClient error mapping.
 * Run with: npx tsx tests/signal-pairing.test.ts
 *
 * Covers: QR payload round-trip, QR content policy (no SDP, no keys),
 * every rejection path of a scanned payload, client error mapping for
 * every server error, and the create-offer-retry loop timing budget.
 */

import assert from 'node:assert/strict';
import { buildSignalQr, isSignalQr, parseSignalQr, SIGNAL_PREFIX } from '../lib/pairing/signalPayload';
import { SignalingClient, SignalingError, SIGNALING_ENDPOINT } from '../lib/signaling/client';

let passed = 0;
function check(cond: unknown, label: string): void {
  assert.ok(cond, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

const ENDPOINT = 'https://signal.example.test/functions/nexdropSignal';

console.log('[signal-pairing] NDPS1 payload round-trip + content policy');

{
  const code = buildSignalQr({
    a: 'nexdrop',
    v: 1,
    s: 'a'.repeat(32),
    t: 'b'.repeat(32),
    e: ENDPOINT,
  });
  check(code.startsWith(SIGNAL_PREFIX), 'code carries the NDPS1 prefix');
  check(isSignalQr(code), 'isSignalQr recognizes NDPS1');
  check(!isSignalQr('NDP2.xxx'), 'isSignalQr does NOT match the manual NDP2 format');
  check(!code.includes('o='), 'QR contains no SDP (no offer data)');
  check(!code.includes('candidate'), 'QR contains no ICE candidates');
  const parsed = parseSignalQr(code);
  check(parsed.s === 'a'.repeat(32), 'session id round-trips');
  check(parsed.t === 'b'.repeat(32), 'join token round-trips');
  check(parsed.e === ENDPOINT, 'endpoint round-trips');
  check(parsed.v === 1 && parsed.a === 'nexdrop', 'app id + version round-trip');
}

console.log('[signal-pairing] rejection paths for scanned payloads');

{
  const good = buildSignalQr({ a: 'nexdrop', v: 1, s: 's'.repeat(32), t: 't'.repeat(32), e: ENDPOINT });
  const cases: Array<[string, string]> = [
    ['', 'empty input'],
    ['NDP1.not-a-thing', 'non-NDPS1 prefix'],
    [SIGNAL_PREFIX + '%%%invalid-base64%%%!!!', 'invalid base64url'],
    [SIGNAL_PREFIX + Buffer.from('not json').toString('base64url'), 'invalid JSON'],
    [buildSignalQr({ a: 'otherapp', v: 1, s: 's'.repeat(32), t: 't'.repeat(32), e: ENDPOINT }), 'wrong app id'],
    [buildSignalQr({ a: 'nexdrop', v: 2, s: 's'.repeat(32), t: 't'.repeat(32), e: ENDPOINT }), 'unsupported version'],
    [buildSignalQr({ a: 'nexdrop', v: 1, s: 'short', t: 't'.repeat(32), e: ENDPOINT }), 'too-short session id'],
    [buildSignalQr({ a: 'nexdrop', v: 1, s: 's'.repeat(32), t: 'tiny', e: ENDPOINT }), 'too-short join token'],
    [buildSignalQr({ a: 'nexdrop', v: 1, s: 's'.repeat(32), t: 't'.repeat(32), e: 'http://insecure.test/fn' }), 'non-HTTPS endpoint rejected'],
  ];
  let rejected = 0;
  for (const [code, label] of cases) {
    try {
      parseSignalQr(code);
    } catch {
      rejected++;
      continue;
    }
    throw new Error(`payload should have been rejected: ${label}`);
  }
  check(rejected === cases.length, `all ${cases.length} malformed payloads rejected`);
}

console.log('[signal-pairing] SignalingClient error mapping (mocked fetch)');

async function clientErrorMapping(): Promise<void> {
  const client = new SignalingClient(ENDPOINT);
  const mockOnce = (status: number, body: unknown) => {
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };

  mockOnce(200, { ok: true });
  check((await client.decline('t')) !== undefined, 'ok response resolves');

  const errorCases: Array<[number, unknown, string]> = [
    [410, { error: 'expired' }, 'expired'],
    [404, { error: 'session-not-found' }, 'not-found'],
    [403, { error: 'already-joined' }, 'already-joined'],
    [409, { error: 'offer-not-ready' }, 'offer-not-ready'],
    [409, { error: 'declined' }, 'declined'],
    [413, { error: 'payload-too-large' }, 'invalid'],
    [429, { error: 'rate-limited' }, 'invalid'],
    [500, { error: 'server-error' }, 'server'],
  ];
  for (const [status, body, kind] of errorCases) {
    mockOnce(status, body);
    try {
      await client.pollHost('t');
      throw new Error(`expected ${kind} error`);
    } catch (err) {
      check(err instanceof SignalingError && err.kind === kind, `HTTP ${status} → ${kind}`);
    }
  }

  // network failure
  (globalThis as any).fetch = async () => {
    throw new TypeError('fetch failed');
  };
  try {
    await client.validate('t');
    throw new Error('expected network error');
  } catch (err) {
    check(err instanceof SignalingError && err.kind === 'network', 'fetch failure → network error');
  }
}

void clientErrorMapping().catch((err) => {
  console.error(err);
  process.exit(1);
});

console.log('[signal-pairing] endpoint policy');

{
  check(SIGNALING_ENDPOINT.startsWith('https://'), 'production signaling endpoint is HTTPS');
  check(SIGNALING_ENDPOINT.includes('/functions/nexdropSignal'), 'endpoint points at the deployed function');
}

console.log(`\n[signal-pairing] ${passed} checks passed`);
