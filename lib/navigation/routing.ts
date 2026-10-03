/**
 * NexDrop tab routing (mission: refactor routing for the 4-tab structure).
 *
 * The workspace tabs are REAL routing, not just UI state:
 *   #/home  #/transfers  #/devices  #/settings
 * are deep-linkable, shareable, and support browser back/forward.
 *
 * The legacy `#join=<offer>` invite deep-link is preserved untouched —
 * it is not a tab route and never redirects. Invalid or unknown hashes
 * leave the current tab alone (no forced navigation, no fake state).
 */

import type { WorkspaceTab } from '@/components/layout/Navbar';

export const TAB_ROUTES: Record<WorkspaceTab, string> = {
  home: '#/home',
  transfers: '#/transfers',
  devices: '#/devices',
  settings: '#/settings',
};

const ROUTE_TO_TAB = new Map<string, WorkspaceTab>(
  (Object.entries(TAB_ROUTES) as [WorkspaceTab, string][]).map(([tab, route]) => [route, tab])
);

/** All tab hashes, e.g. for aria-current checks or tests. */
export const TAB_ROUTE_HASHES: readonly string[] = Object.values(TAB_ROUTES);

/**
 * The URL is the router store: the shell reads the active tab via
 * useSyncExternalStore (hydration-safe — SSR renders Home, the client
 * re-renders from the hash after mount) and writes via navigateToTab
 * (pushState + notify, so programmatic transitions AND browser
 * back/forward stay in sync). #join= invite links bypass tab routing
 * untouched and resolve the initial view to Devices.
 */

/**
 * Parse a location hash into a tab. Returns null for anything that is not
 * an exact tab route (#join= invites, garbage, empty hash).
 */
export function parseTabFromHash(hash: string | null | undefined): WorkspaceTab | null {
  if (!hash) return null;
  return ROUTE_TO_TAB.get(hash) ?? null;
}

/** The hash that represents a tab (always starts with "#/"). */
export function tabRoute(tab: WorkspaceTab): string {
  return TAB_ROUTES[tab];
}

/**
 * Resolve the tab an initial page load should show. Invite deep-links
 * (#join=) resolve to Devices so the accept/join flow is immediately
 * visible; explicit tab routes win; everything else defaults to Home.
 */
export function resolveInitialTab(hash: string | null | undefined): WorkspaceTab {
  const fromRoute = parseTabFromHash(hash);
  if (fromRoute) return fromRoute;
  if (hash && hash.startsWith('#join=')) return 'devices';
  return 'home';
}

// ---------------------------------------------------------------------------
// Router store (external system: the URL)
// ---------------------------------------------------------------------------

type RouterListener = () => void;
const listeners = new Set<RouterListener>();

/**
 * Subscribe to tab-route changes (browser back/forward via popstate, and
 * programmatic navigateToTab calls). For useSyncExternalStore.
 */
export function subscribeRouter(listener: RouterListener): () => void {
  const onPopState = () => listener();
  listeners.add(listener);
  window.addEventListener('popstate', onPopState);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', onPopState);
  };
}

/** Client snapshot: the tab the current URL resolves to. */
export function getRouterTab(): WorkspaceTab {
  return resolveInitialTab(window.location.hash);
}

/** Server snapshot: SSR always renders Home. */
export function getServerRouterTab(): WorkspaceTab {
  return 'home';
}

/**
 * Navigate to a tab: mirror into the URL (pushState so Back walks the tab
 * history we created) and notify subscribers. No-op when already there.
 */
export function navigateToTab(tab: WorkspaceTab): void {
  if (typeof window === 'undefined') return;
  const next = tabRoute(tab);
  if (window.location.hash !== next) {
    window.history.pushState({ ndTab: tab }, '', next);
  }
  for (const listener of listeners) listener();
}
