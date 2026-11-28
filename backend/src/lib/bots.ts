import { COUNTRY_ZONES } from './countryZones';

/**
 * Bot classification at ingest. Events are kept but flagged (events.bot = the reason), and analytics leave them
 * out unless asked (bots=1), like Google Analytics and PostHog do.
 *
 * - user-agent:        a crawler or headless browser says so in its user agent
 * - automation:        the browser reports it's driven by automation (navigator.webdriver)
 * - timezone-mismatch: the browser's UTC offset matches none of the time zones of the country CloudFront
 *   located its IP in. Scrapers rotate proxies around the world but keep one machine's time zone (often UTC
 *   on servers). Real visitors' clocks match where they are; travellers and VPNs exiting in another time zone
 *   are the exception (rare, and still visible with "Show bots").
 */

/** The `bot` reason of development traffic (lib/devTraffic.ts): your own pages, left out like bots. */
export const DEV_REASON = 'development';

/**
 * Whether an event's page URL is on a built-in development host (lib/devTraffic.ts isDevUrl, as DuckDB SQL): file:
 * pages, localhost and *.localhost/.local/.internal/.lan/.home/.corp, single-label names, private, loopback,
 * link-local and CGNAT IPv4 addresses and IPv6 literals. Checked at query time too, so events stored before they
 * were flagged at ingest are left out as well. test/devTraffic.test.ts keeps it in step with isDevUrl.
 */
export const DEV_URL_PATTERN = String.raw`^(file:|https?://([^/?#@]*@)?(localhost|[^/?#:.\[]*|[^/?#:\[]*\.(localhost|local|internal|lan|home|corp)|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.\d+\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|\[[^\]]*\])\.?(:\d*)?([/?#]|$))`;
const DEV_URL = `coalesce(regexp_matches(url, '${DEV_URL_PATTERN}', 'i'), false)`;
/** Development traffic: flagged at ingest, or on a built-in development host (events stored before flagging). */
export const DEV_SQL = `(coalesce(bot, '') = '${DEV_REASON}' OR ${DEV_URL})`;
/** Human traffic: neither a bot nor development traffic. */
export const HUMAN_SQL = `(bot IS NULL AND NOT ${DEV_URL})`;
/** Bot traffic that isn't development traffic. */
export const BOT_SQL = `(bot IS NOT NULL AND NOT ${DEV_SQL})`;
/** Why an event is left out ('development' or the bot reason), null for humans. */
export const REASON_SQL = `(CASE WHEN ${DEV_URL} THEN '${DEV_REASON}' ELSE bot END)`;

const formatters = new Map<string, Intl.DateTimeFormat | null>();
const offsets = new Map<string, number | null>();

/** UTC offset in minutes of an IANA zone at an instant (cached per zone and hour; DST-aware). */
export function offsetMinutes(zone: string, at: Date): number | null {
  const key = `${zone}@${Math.floor(at.getTime() / 3_600_000)}`;
  if (offsets.has(key)) return offsets.get(key)!;
  let fmt = formatters.get(zone);
  if (fmt === undefined) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
    } catch {
      fmt = null; // not a time zone this runtime knows: no signal
    }
    formatters.set(zone, fmt);
  }
  let value: number | null = null;
  if (fmt) {
    const name = fmt.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? ''; // "GMT+05:30" | "GMT"
    const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
    if (m) value = m[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  }
  if (offsets.size > 10_000) offsets.clear();
  offsets.set(key, value);
  return value;
}

export function timezoneMismatch(tz: string | null | undefined, country: string | null | undefined, at = new Date()): boolean {
  if (!tz || !country) return false;
  const zones = COUNTRY_ZONES.get(country.toUpperCase());
  const browser = offsetMinutes(tz, at);
  if (!zones || browser === null) return false;
  return !zones.some((z) => offsetMinutes(z, at) === browser);
}

export function botReason(s: { uaIsBot: boolean; webdriver?: unknown; tz?: unknown; country?: string | null; at?: Date }): string | null {
  if (s.uaIsBot) return 'user-agent';
  if (s.webdriver === true) return 'automation';
  if (typeof s.tz === 'string' && timezoneMismatch(s.tz, s.country, s.at)) return 'timezone-mismatch';
  return null;
}
