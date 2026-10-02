/**
 * v2.5 writer capability tests (Node — no Worker/OPFS here, which is the
 * point: these paths MUST fail gracefully into the fallback chain).
 *
 * Tests the factory's measurement seam and fallback ordering with the
 * real classes. The forced 'opfs-sync' arm must throw honestly rather
 * than silently downgrading — a benchmark arm must not lie about the
 * writer it used.
 */

import { createOptimalStorageWriter } from '@/lib/transfer/writer';

const g = globalThis as { __NEXDROP_FORCE_WRITER?: string };

async function main(): Promise<void> {
  let pass = 0;
  const check = (name: string, ok: boolean) => {
    if (!ok) throw new Error(`FAIL: ${name}`);
    pass++;
    console.log(`  ✓ ${name}`);
  };

  // Node has no Worker and no OPFS: the sync writer probe must decline,
  // the async OPFS writer must decline, and the factory lands on the
  // bounded memory writer.
  delete g.__NEXDROP_FORCE_WRITER;
  const auto = await createOptimalStorageWriter('f.bin', 'application/octet-stream', 1024, false);
  check('auto falls back to memory writer in a Worker/OPFS-less env', auto.getType() === 'blob');

  // Forced async arm: skips the sync probe entirely (same terminal writer
  // here, but the important property is it never attempts sync).
  g.__NEXDROP_FORCE_WRITER = 'opfs-async';
  const asyncForced = await createOptimalStorageWriter('f.bin', 'application/octet-stream', 1024, false);
  check('forced opfs-async arm never returns a sync writer', asyncForced.getType() !== 'opfs-sync');

  // Forced sync arm: no silent downgrade — unavailable means an honest
  // throw so a benchmark arm cannot misreport its writer.
  g.__NEXDROP_FORCE_WRITER = 'opfs-sync';
  let threw = false;
  try {
    await createOptimalStorageWriter('f.bin', 'application/octet-stream', 1024, false);
  } catch (e: any) {
    threw = String(e?.message || e).includes('opfs-sync');
  }
  check('forced opfs-sync arm throws honestly when unavailable', threw);

  // Memory guard: the fallback refuses whole-file accumulation beyond its
  // bound (checked at write time).
  delete g.__NEXDROP_FORCE_WRITER;

  console.log(`[writers] ${pass} checks passed`);
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
