import type { DevTrafficSettings } from '../contract';
import { DEV_REASON } from './bots';
import { query } from './db';
import { HttpError } from './http';
import { wildcard } from './suppressions';
import { isPublicHost } from './triggers';

/**
 * Development traffic: events from pages on development hosts are stored but flagged (events.bot = 'development'),
 * so they're left out of analytics, live watches and triggers like bot traffic, and shown with `dev=1`.
 *
 * - Always: localhost, loopback, private and link-local addresses, single-label names ("devbox"), local-only
 *   domains (.localhost, .local, .internal, .lan, …) and pages opened from disk (file:).
 * - Per project (projects.dev_traffic): wildcard patterns on the page's hostname ("*.vercel.app", "*.test").
 *
 * Mobile SDK events (url "app:/screen") have no host and are never development traffic.
 */

export { DEV_REASON };
export const MAX_HOSTS = 50;
const MAX_HOST_CHARS = 253;

/** Whether a page hostname is a development one (the built-in list). */
export const isDevHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return !!host && !isPublicHost(host);
};

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
  const b = body as { hosts?: unknown };
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
  return { hosts };
}

/** The stored column as settings (anything unexpected reads as no extra hosts). */
export function devTrafficOf(stored: unknown): DevTrafficSettings {
  let s = stored;
  if (typeof s === 'string') {
    try {
      s = JSON.parse(s);
    } catch {
      s = null;
    }
  }
  const hosts = s && typeof s === 'object' ? (s as { hosts?: unknown }).hosts : null;
  return { hosts: Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string') : [] };
}

// ---------------------------------------------------------------- matching

/** The project's extra host patterns, compiled. */
export type DevHosts = RegExp[];

export const compileDevHosts = (s: DevTrafficSettings): DevHosts => s.hosts.map(wildcard);

/** Whether a page URL is development traffic: a built-in development host or one of the project's patterns. */
export function isDevUrl(url: string | null | undefined, hosts: DevHosts = []): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'file:') return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false; // app:/screen (mobile SDKs) and the like
  const host = u.hostname.toLowerCase();
  return isDevHost(host) || hosts.some((re) => re.test(host) || re.test(host.replace(/^\[|\]$/g, '')));
}

// ---------------------------------------------------------------- per project (cached)

const cache = new Map<string, { hosts: DevHosts; exp: number }>();
const CACHE_MS = 30_000;

/** A project's extra development hosts, cached per container for 30 s (read on every ingest batch). */
export async function devHostsOf(pid: string): Promise<DevHosts> {
  const hit = cache.get(pid);
  if (hit && hit.exp > Date.now()) return hit.hosts;
  const rows = await query<{ dev_traffic: unknown }>('SELECT dev_traffic FROM projects WHERE id = $1', [pid]);
  const hosts = compileDevHosts(devTrafficOf(rows[0]?.dev_traffic));
  cache.set(pid, { hosts, exp: Date.now() + CACHE_MS });
  if (cache.size > 1000) cache.delete(cache.keys().next().value!);
  return hosts;
}

/** Forget a project's cached hosts in this container (others pick up a change within 30 s). */
export const forgetDevHosts = (pid: string) => cache.delete(pid);
