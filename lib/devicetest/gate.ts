/**
 * Shared developer-mode gate — opt-in, identical for the diagnostics panel
 * and the Device Test screen. localStorage 'nexdrop:diagnostics' = '1'
 * or ?diag=1 in the URL.
 */
export function isDevModeEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(window.location.search).get('diag') === '1') return true;
  try {
    return window.localStorage.getItem('nexdrop:diagnostics') === '1';
  } catch {
    return false;
  }
}
