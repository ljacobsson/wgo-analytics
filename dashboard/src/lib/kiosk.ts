import type { KioskPage } from '../api/contract';
import { PRESETS } from './time';

/**
 * Kiosk mode: the dashboard opened at #/kiosk/<token> runs as a signed-out wall display (kiosk/KioskApp.tsx).
 * Decided once at load, so a stray tap that changes the hash can't drop the screen out of kiosk mode.
 */
export const KIOSK_TOKEN: string | null = window.location.hash.match(/^#\/kiosk\/([^/?#]+)/)?.[1] ?? null;
export const isKiosk = () => KIOSK_TOKEN !== null;

/** Pages a kiosk can show (same list as the backend's KIOSK_PAGES). */
export const KIOSK_PAGES: readonly KioskPage[] = ['overview', 'live', 'clicks', 'errors', 'network', 'events', 'traces', 'logs', 'metrics', 'dashboard'];
export const isKioskPage = (page: string): page is KioskPage => (KIOSK_PAGES as readonly string[]).includes(page);

/** Where the dashboard is served from, without index.html or a trailing slash. */
export function dashboardBase(): string {
  return (window.location.origin + window.location.pathname).replace(/\/(index\.html)?$/, '');
}
export const kioskUrl = (token: string) => `${dashboardBase()}/#/kiosk/${token}`;
export const kioskScriptUrl = () => `${dashboardBase()}/downloads/wgo-kiosk.sh`;
/** The one command to run on a Raspberry Pi. */
export const kioskSetupCommand = (token: string) => `curl -fsSL ${kioskScriptUrl()} | sudo bash -s -- '${kioskUrl(token)}'`;

/** Normalised query string for a screen, so it compares equal to what the router reads back from the hash. */
export const normParams = (params: string) => new URLSearchParams(params.replace(/^\?/, '')).toString();

/** "Last 24h" etc. for a screen's params. */
export function rangeLabel(params: URLSearchParams): string {
  const r = params.get('range') ?? '24h';
  if (r === 'custom') return 'Fixed dates';
  return `Last ${(PRESETS as readonly string[]).includes(r) ? r : '24h'}`;
}
