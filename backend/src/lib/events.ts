import { createHash, randomUUID } from 'node:crypto';
import type { AnalyticsEvent, EventType } from '../contract';
import { NO_GEO, type Geo } from './geo';
import { botReason } from './bots';
import { DEV_REASON, isDevUrl, type DevHosts } from './devTraffic';
import { parseUserAgent } from './ua';

/** SDK wire format (see sdk/README.md). */
export interface WireBatch {
  k: string;
  a: string;
  sentAt: number;
  ctx?: { sdk?: string; ua?: string; lang?: string; sw?: number; sh?: number; tz?: string; release?: string; env?: string; [k: string]: unknown };
  e: WireEvent[];
}
export interface WireEvent {
  id: string;
  t: EventType;
  ts: number;
  s: string;
  u?: string;
  url: string;
  path: string;
  title?: string;
  ref?: string;
  d?: Record<string, unknown>;
}

/** One row of the `events` table, in column order. */
export interface EventRow {
  project_id: string;
  ts: Date;
  id: string;
  type: EventType;
  session_id: string | null;
  anon_id: string | null;
  user_id: string | null;
  url: string | null;
  path: string | null;
  title: string | null;
  referrer: string | null;
  selector: string | null;
  element_text: string | null;
  element_tag: string | null;
  track_name: string | null;
  error_message: string | null;
  error_stack: string | null;
  error_source: string | null;
  fingerprint: string | null;
  http_method: string | null;
  http_url: string | null;
  http_route: string | null;
  http_status: number | null;
  duration_ms: number | null;
  name: string | null;
  props: Record<string, unknown>;
  browser: string | null;
  os: string | null;
  device: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
  bot: string | null;
}

export const EVENT_COLUMNS: (keyof EventRow)[] = [
  'project_id', 'ts', 'id', 'type', 'session_id', 'anon_id', 'user_id', 'url', 'path', 'title', 'referrer',
  'selector', 'element_text', 'element_tag', 'track_name', 'error_message', 'error_stack', 'error_source', 'fingerprint',
  'http_method', 'http_url', 'http_route', 'http_status', 'duration_ms', 'name', 'props', 'browser', 'os', 'device',
  'country', 'region', 'city', 'lat', 'lon', 'bot',
];

const TYPES = new Set<EventType>(['pageview', 'click', 'error', 'http_error', 'custom', 'vitals', 'identify']);
export const MAX_EVENTS_PER_BATCH = 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const str = (v: unknown, max = 2048): string | null => {
  if (v === undefined || v === null || v === '') return null;
  const s = typeof v === 'string' ? v : String(v);
  return s.length > max ? s.slice(0, max) : s;
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A v4-shaped UUID derived from `seed`: the same input always gets the same id. */
export function stableUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Gives events without a valid id one derived from `sourceId` (e.g. an SQS message id) and their position, so a
 * redelivered batch maps to the same rows and compaction drops the duplicates. The SDK always sends ids.
 */
export function fillMissingIds(batch: WireBatch, sourceId: string): void {
  if (!batch || !Array.isArray(batch.e)) return;
  batch.e.forEach((e, i) => {
    if (e && typeof e === 'object' && !(typeof e.id === 'string' && uuidRe.test(e.id))) e.id = stableUuid(`${sourceId}:${i}`);
  });
}

/**
 * Normalize an SDK batch into event rows. Invalid events are dropped, never the whole batch. Events from development
 * pages (lib/devTraffic.ts: built-in hosts plus the project's `devHosts`) are flagged bot = 'development'.
 */
export function normalizeBatch(projectId: string, batch: WireBatch, receivedAt = Date.now(), userAgentHeader?: string, geo: Geo = NO_GEO, devHosts: DevHosts = []): EventRow[] {
  if (!batch || !Array.isArray(batch.e)) return [];
  const skew = clockSkew(batch, receivedAt);
  const ua = parseUserAgent(str(batch.ctx?.ua) ?? userAgentHeader ?? '');
  const ctxExtras: Record<string, unknown> = {};
  for (const k of ['lang', 'sw', 'sh', 'tz', 'release', 'env', 'sdk'] as const) if (batch.ctx?.[k] !== undefined) ctxExtras[k] = batch.ctx[k];
  // one verdict per batch: it all comes from the same browser, location and time zone
  const bot = botReason({ uaIsBot: ua.browser === 'Bot', webdriver: batch.ctx?.wd, tz: batch.ctx?.tz, country: geo.country, at: new Date(receivedAt) });

  const rows: EventRow[] = [];
  for (const e of batch.e.slice(0, MAX_EVENTS_PER_BATCH)) {
    if (!e || !TYPES.has(e.t)) continue;
    const ts = eventTime(e.ts, skew, receivedAt);
    const d = (e.d && typeof e.d === 'object' ? e.d : {}) as Record<string, unknown>;
    const row: EventRow = {
      project_id: projectId,
      ts: new Date(ts),
      id: typeof e.id === 'string' && uuidRe.test(e.id) ? e.id.toLowerCase() : randomUUID(),
      type: e.t,
      session_id: str(e.s, 64),
      anon_id: str(batch.a, 64),
      user_id: str(e.u, 256),
      url: str(e.url),
      path: str(e.path, 1024) ?? safePath(e.url),
      title: str(e.title, 512),
      referrer: e.t === 'pageview' ? str(e.ref) : null,
      selector: null, element_text: null, element_tag: null, track_name: null,
      error_message: null, error_stack: null, error_source: null, fingerprint: null,
      http_method: null, http_url: null, http_route: null, http_status: null, duration_ms: null,
      name: null,
      props: { ...d, ...(Object.keys(ctxExtras).length ? { $ctx: ctxExtras } : {}) },
      browser: ua.browser,
      os: ua.os,
      device: ua.device,
      ...geo,
      // your own testing (even automated) is development traffic first
      bot: isDevUrl(e.url, devHosts) ? DEV_REASON : bot,
    };
    switch (e.t) {
      case 'click':
        row.selector = str(d.sel, 512);
        row.element_text = str(d.text, 200);
        row.element_tag = str(d.tag, 32);
        row.track_name = str(d.name, 200);
        break;
      case 'error':
        row.error_message = str(d.msg, 2000) ?? 'Unknown error';
        row.error_stack = str(d.stack, 8000);
        row.error_source = str(d.src, 1024);
        row.fingerprint = errorFingerprint(row.error_message, row.error_stack, row.error_source, str(d.kind));
        break;
      case 'http_error':
        row.http_method = (str(d.method, 16) ?? 'GET').toUpperCase();
        row.http_url = str(d.url);
        row.http_route = row.http_url ? normalizeRoute(row.http_url) : null;
        row.http_status = num(d.status) ?? 0;
        row.duration_ms = num(d.dur) !== null ? Math.round(num(d.dur)!) : null;
        break;
      case 'custom':
        row.name = str(d.name, 200);
        break;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Correction for badly-set client clocks (the SDK stamps sentAt right before sending). Coarse on purpose: a
 * retried batch must map to the same `ts`, because (project_id, ts, id) dedupes retries.
 */
export function clockSkew(batch: WireBatch, receivedAt: number): number {
  const raw = typeof batch.sentAt === 'number' ? receivedAt - batch.sentAt : 0;
  return Math.abs(raw) > 120_000 ? Math.round(raw / 60_000) * 60_000 : 0;
}

/** An event time with the batch's skew applied, or the receive time when it's implausible. */
export function eventTime(ts: unknown, skew: number, receivedAt: number): number {
  const t = (num(ts) ?? receivedAt) + skew;
  return t > receivedAt + MAX_FUTURE_SKEW_MS || t < receivedAt - MAX_AGE_MS ? receivedAt : t;
}

function safePath(url: unknown): string | null {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return null;
  }
}

/**
 * Group errors that are "the same bug": volatile parts of the message (numbers, quoted values, ids)
 * are erased, and the first stack frame location is included without line/column jitter from minifiers.
 */
export function errorFingerprint(message: string, stack: string | null, source: string | null, kind: string | null): string {
  const msg = message
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/(["'`]).*?\1/g, '<str>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, '<n>')
    .slice(0, 300);
  // the first frame: V8 `at fn (url:1:2)`, Firefox/Safari `fn@url:1:2`, or Dart (the Flutter SDK) `#0  fn (package:app/x.dart:1:2)`
  const frame = stack
    ?.split('\n')
    .map((l) => l.trim())
    .find((l) => /^at |@|^#\d+\s/.test(l))
    ?.replace(/:\d+:\d+\)?$/, '')
    .replace(/\?[^\s)]*/, '');
  const basis = [kind ?? '', msg, frame ?? (kind === 'resource' ? source ?? '' : '')].join('|');
  return createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

/** /api/users/123/orders/9f8e...?x=1 -> /api/users/:id/orders/:id (keeps host for cross-origin calls). */
export function normalizeRoute(url: string): string {
  let host = '';
  let path = url;
  try {
    const u = new URL(url, 'http://relative.invalid');
    host = u.host === 'relative.invalid' ? '' : u.host;
    path = u.pathname;
  } catch {
    path = url.split('?')[0];
  }
  const segments = path.split('/').map((seg) =>
    /^\d+$/.test(seg) || uuidRe.test(seg) || /^[0-9a-f]{12,}$/i.test(seg) || (seg.length > 20 && /\d/.test(seg) && /^[\w-]+$/.test(seg))
      ? ':id'
      : seg,
  );
  return host + segments.join('/');
}

/** Convert an EventRow-shaped DB row into the API representation. */
export function toApiEvent(r: EventRow): AnalyticsEvent {
  return {
    id: r.id,
    type: r.type,
    ts: (r.ts instanceof Date ? r.ts : new Date(r.ts)).toISOString(),
    sessionId: r.session_id,
    anonId: r.anon_id,
    userId: r.user_id,
    url: r.url,
    path: r.path,
    title: r.title,
    referrer: r.referrer,
    selector: r.selector,
    elementText: r.element_text,
    elementTag: r.element_tag,
    trackName: r.track_name,
    errorMessage: r.error_message,
    errorStack: r.error_stack,
    errorSource: r.error_source,
    fingerprint: r.fingerprint,
    httpMethod: r.http_method,
    httpUrl: r.http_url,
    httpRoute: r.http_route,
    httpStatus: r.http_status,
    durationMs: r.duration_ms,
    name: r.name,
    props: (typeof r.props === 'string' ? JSON.parse(r.props) : r.props) ?? {},
    browser: r.browser,
    os: r.os,
    device: r.device,
    country: r.country ?? null,
    region: r.region ?? null,
    city: r.city ?? null,
    lat: r.lat ?? null,
    lon: r.lon ?? null,
    bot: r.bot ?? null,
  };
}

export function eventRowValues(r: EventRow): unknown[] {
  return EVENT_COLUMNS.map((c) => (c === 'props' ? JSON.stringify(r.props) : r[c]));
}
