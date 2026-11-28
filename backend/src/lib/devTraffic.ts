import type { DevTrafficSettings } from '../contract';
import { query } from './db';
import type { WireBatch } from './events';
import { HttpError } from './http';
import { wildcard } from './suppressions';
import { isPublicHost } from './triggers';

/**
 * Development and test traffic: browser events, recordings and recording slots from pages on development hosts are
 * dropped at ingest when a project asks for it (projects.dev_traffic), so a developer running the site locally
 * doesn't show up in its analytics, errors, triggers or recordings.
 *
 * - `ignore`: localhost, loopback, private and link-local addresses, single-label names ("devbox") and local-only
 *   domains (.localhost, .local, .test, .internal, …), and pages opened from disk (file:).
 * - `hosts`: wildcard patterns on the page's hostname ("*.vercel.app", "staging.acme.com"), applied whether or not
 *   `ignore` is on.
 *
 * Mobile SDK events (url "app:/screen") have no host and are never dropped.
 */

export const MAX_HOSTS = 50;
const MAX_HOST_CHARS = 253;
export const DEFAULT_DEV_TRAFFIC: DevTrafficSettings = { ignore: false, hosts: [] };

/** Whether a page hostname is a development one (the built-in list behind `ignore`). */
export function isDevHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host === '0.0.0.0' || host === '[::]' || /\.(test|example|invalid|localdomain)$/.test(host)) return true;
  return !isPublicHost(host);
}

/** A host pattern as entered (maybe a pasted URL) reduced to a lower-case hostname pattern, or null when unusable. */
export function normalizeHostPattern(raw: string): string | null {
  let s = String(raw ?? '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.replace(/[/?#].*$/, ''); // path, query, fragment
  s = s.replace(/^[^@]*@/, ''); // credentials
  s = s.startsWith('[') ? s.replace(/\]:\d*$/, ']') : s.replace(/:\d*$/, ''); // port (after an IPv6 literal's "]")
  s = s.replace(/\.$/, '');
  if (!s || s.length > MAX_HOST_CHARS || !/^[a-z0-9*.\-_[\]:]+$/.test(s) || /^\*+$/.test(s)) return null;
  return s;
}

/** Validates DevTrafficSettings from an API body (400 on bad input); patterns are normalized and de-duplicated. */
export function parseDevTraffic(body: unknown): DevTrafficSettings {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'devTraffic must be an object');
  const b = body as { ignore?: unknown; hosts?: unknown };
  if (b.ignore !== undefined && typeof b.ignore !== 'boolean') throw new HttpError(400, 'devTraffic.ignore must be true or false');
  if (b.hosts !== undefined && !(Array.isArray(b.hosts) && b.hosts.every((h) => typeof h === 'string'))) {
    throw new HttpError(400, 'devTraffic.hosts must be a list of host names');
  }
  const hosts: string[] = [];
  for (const raw of (b.hosts as string[] | undefined) ?? []) {
    if (!raw.trim()) continue;
    const h = normalizeHostPattern(raw);
    if (!h) throw new HttpError(400, `"${raw.slice(0, 100)}" is not a host name or pattern`);
    if (!hosts.includes(h)) hosts.push(h);
  }
  if (hosts.length > MAX_HOSTS) throw new HttpError(400, `At most ${MAX_HOSTS} hosts`);
  return { ignore: b.ignore === true, hosts };
}

/** The stored column as settings (anything unexpected reads as the default). */
export function devTrafficOf(stored: unknown): DevTrafficSettings {
  const s = (typeof stored === 'string' ? safeJson(stored) : stored) as { ignore?: unknown; hosts?: unknown } | null;
  if (!s || typeof s !== 'object') return { ...DEFAULT_DEV_TRAFFIC };
  return {
    ignore: s.ignore === true,
    hosts: Array.isArray(s.hosts) ? s.hosts.filter((h): h is string => typeof h === 'string') : [],
  };
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- matching

export interface DevTrafficFilter { ignore: boolean; hosts: RegExp[] }

export const compileDevTraffic = (s: DevTrafficSettings): DevTrafficFilter => ({ ignore: s.ignore, hosts: s.hosts.map(wildcard) });

const active = (f: DevTrafficFilter) => f.ignore || f.hosts.length > 0;

/** Whether a page URL (or an Origin header) is development traffic under these settings. */
export function isDevUrl(f: DevTrafficFilter, url: string | null | undefined): boolean {
  if (!url || !active(f)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'file:') return f.ignore;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false; // app:/screen (mobile SDKs) and the like
  const host = u.hostname.toLowerCase();
  return (f.ignore && isDevHost(host)) || f.hosts.some((re) => re.test(host) || re.test(host.replace(/^\[|\]$/g, '')));
}

// ---------------------------------------------------------------- per project (cached)

const cache = new Map<string, { filter: DevTrafficFilter; exp: number }>();
const CACHE_MS = 30_000;

export async function devTrafficFilter(pid: string): Promise<DevTrafficFilter> {
  const hit = cache.get(pid);
  if (hit && hit.exp > Date.now()) return hit.filter;
  const rows = await query<{ dev_traffic: unknown }>('SELECT dev_traffic FROM projects WHERE id = $1', [pid]);
  const filter = compileDevTraffic(devTrafficOf(rows[0]?.dev_traffic));
  cache.set(pid, { filter, exp: Date.now() + CACHE_MS });
  if (cache.size > 1000) cache.delete(cache.keys().next().value!);
  return filter;
}

/** Forget a project's cached settings in this container (others pick up a change within 30 s). */
export const forgetDevTraffic = (pid: string) => cache.delete(pid);

/**
 * The batch without its events from development pages (recording chunks included: they carry the page URL too).
 * Returns the batch itself when nothing is dropped.
 */
export async function dropDevTraffic(pid: string, batch: WireBatch): Promise<WireBatch> {
  if (!batch || !Array.isArray(batch.e) || !batch.e.length) return batch;
  const f = await devTrafficFilter(pid);
  if (!active(f)) return batch;
  const kept = batch.e.filter((e) => !isDevUrl(f, e && typeof e === 'object' && typeof e.url === 'string' ? e.url : null));
  return kept.length === batch.e.length ? batch : { ...batch, e: kept };
}

/** Whether a request from this Origin header comes from a development page of the project. */
export async function isDevOrigin(pid: string, origin: string | undefined): Promise<boolean> {
  if (!origin || origin === 'null') return false;
  return isDevUrl(await devTrafficFilter(pid), origin);
}
