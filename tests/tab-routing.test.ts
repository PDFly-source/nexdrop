/**
 * Tab routing checks — the 4-tab structure is real routing, not just state.
 * Run with `npx tsx tests/tab-routing.test.ts`. Verifies, without a browser:
 *  - every workspace tab has a #/tab route and back-parse round-trips;
 *  - non-route hashes (#join= invites, garbage, empty) never hijack a tab;
 *  - a #join= invite resolves the initial view to Devices;
 *  - the shell reads the tab from the URL store (useSyncExternalStore,
 *    hydration-safe) and routes all transitions through navigateToTab;
 *  - the legacy #join= invite deep-link handling is untouched.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  navigateToTab,
  parseTabFromHash,
  resolveInitialTab,
  subscribeRouter,
  TAB_ROUTES,
  tabRoute,
} from '../lib/navigation/routing';

let count = 0;
function ok(actual: unknown, label: string) {
  assert.ok(actual, label);
  count++;
  console.log(`  \u2713 ${label}`);
}
function eq(actual: unknown, expected: unknown, label: string) {
  assert.deepEqual(actual, expected, label);
  count++;
  console.log(`  \u2713 ${label}`);
}

console.log('[tab-routing] route table');
eq(Object.keys(TAB_ROUTES).sort(), ['devices', 'home', 'settings', 'transfers'], 'all four tabs have routes');
eq(TAB_ROUTES.home, '#/home', 'home route');
eq(TAB_ROUTES.transfers, '#/transfers', 'transfers route');
eq(TAB_ROUTES.devices, '#/devices', 'devices route');
eq(TAB_ROUTES.settings, '#/settings', 'settings route');

console.log('[tab-routing] hash parsing');
eq(parseTabFromHash('#/transfers'), 'transfers', '#/transfers parses');
eq(parseTabFromHash('#/home'), 'home', '#/home parses');
eq(parseTabFromHash('#/devices'), 'devices', '#/devices parses');
eq(parseTabFromHash('#/settings'), 'settings', '#/settings parses');
eq(parseTabFromHash('#join=abc123'), null, '#join= invite is NOT a tab route');
eq(parseTabFromHash(''), null, 'empty hash is not a route');
eq(parseTabFromHash(null), null, 'null hash is not a route');
eq(parseTabFromHash('#/home/extra'), null, 'sloppy suffix does not match a route');
eq(parseTabFromHash('#/Home'), null, 'route matching is case-sensitive (no silent recovery)');
eq(parseTabFromHash('#transfers'), null, 'missing slash does not match a route');

console.log('[tab-routing] round-trip and initial resolution');
for (const tab of Object.keys(TAB_ROUTES) as (keyof typeof TAB_ROUTES)[]) {
  eq(parseTabFromHash(tabRoute(tab)), tab, `${tab} round-trips through its hash`);
}
eq(resolveInitialTab('#/settings'), 'settings', 'explicit tab deep-link wins on load');
eq(resolveInitialTab('#join=NexDrop-offer'), 'devices', '#join= invite starts on Devices');
eq(resolveInitialTab(''), 'home', 'plain load starts on Home');
eq(resolveInitialTab('#/nonsense'), 'home', 'unknown hash falls back to Home');

console.log('[tab-routing] router store exports');
const routing = readFileSync('lib/navigation/routing.ts', 'utf8');
ok(typeof subscribeRouter === 'function', 'subscribeRouter exported for useSyncExternalStore');
ok(typeof navigateToTab === 'function', 'navigateToTab exported (pushState + notify)');
ok(routing.includes("window.addEventListener('popstate'"), 'store subscribes to browser back/forward');
ok(routing.includes('window.history.pushState'), 'transitions push URL state (deep-linkable)');

console.log('[tab-routing] app shell wiring (source assertions)');
const page = readFileSync('app/page.tsx', 'utf8');
ok(
  page.includes('useSyncExternalStore(subscribeRouter, getRouterTab, getServerRouterTab)'),
  'shell reads the tab from the URL store (hydration-safe)'
);
ok(!page.includes('setActiveTab'), 'no local tab state in the shell — the URL is the single source of truth');
ok(page.includes("hash.startsWith('#join=')"), '#join= invite deep-link handling preserved');
ok(page.includes("navigateToTab('devices')"), 'pairing auto-navigation goes through the router');
ok(page.includes("navigateToTab('transfers')"), 'transfer auto-navigation goes through the router');

console.log(`[tab-routing] ${count} checks passed`);
