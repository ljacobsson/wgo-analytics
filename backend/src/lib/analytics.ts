import type {
  BreakdownRow, ClickRow, ErrorGroup, EventsResponse, EventType, FieldInfo, FieldsResponse, FieldValuesResponse, FilterScope, GeoResponse,
  HttpErrorGroup, LogRecord, LogsResponse, MetricInfo,
  MetricSeriesResponse, PageRow, ServiceRow, Span, StatsResponse, Totals, TraceResponse, TraceSummary, VitalsResponse,
} from '../contract';
import { rawQuery, inList, type Window as Win } from './store/duck';
import { aliasMap } from './clickAliases';
import { stacksFor } from './errorStacks';
import { toApiEvent, type EventRow } from './events';
import { COLUMNS, fieldExpression, filtersFrom, includeBots, jsonPath, parseFilters } from './filters';
import { Hll } from './hll';
import { HttpError } from './http';
import { projectRetention } from './retention';
import { hourlySketches, hourlyTypes, mergeKeyed, planRange, rolledDim, type Plan, type RollupDim, type Span as Window } from './rollups';

type Params = Record<string, string | undefined>;

export interface Range {
  from: Date;
  to: Date;
}

const MAX_RANGE_MS = 92 * 24 * 3600 * 1000;

export function parseRange(p: Params, defaultMs = 24 * 3600 * 1000): Range {
  const to = p.to ? new Date(p.to) : new Date();
  const from = p.from ? new Date(p.from) : new Date(to.getTime() - defaultMs);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) throw new HttpError(400, 'Invalid from/to');
  if (from >= to) throw new HttpError(400, '`from` must be before `to`');
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new HttpError(400, 'Range too large (max 92 days)');
  return { from, to };
}

const BUCKETS = [60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400];
/** Choose a bucket giving roughly 40–120 points over the range. */
export function pickBucket({ from, to }: Range): number {
  const seconds = (to.getTime() - from.getTime()) / 1000;
  return BUCKETS.find((b) => seconds / b <= 120) ?? 86400;
}

export function bucketStarts({ from, to }: Range, bucket: number): number[] {
  const out: number[] = [];
  const startMs = Math.floor(from.getTime() / 1000 / bucket) * bucket * 1000;
  for (let t = startMs; t < to.getTime(); t += bucket * 1000) out.push(t);
  return out;
}

const limitParam = (v: string | undefined, def: number, max: number) => {
  const n = Number(v ?? def);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
};
const likeEscape = (s: string) => `%${s.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
/** ILIKE with the backslash escape PostgreSQL uses by default (DuckDB has none). */
const ILIKE = (param: string) => `ILIKE ${param} ESCAPE '\\'`;
const iso = (d: Date | string | null) => (d ? (d instanceof Date ? d : new Date(d)).toISOString() : null);
const BUCKET_SQL = (col: string, param: string) => `to_timestamp(floor(extract(epoch from ${col}) / ${param}::double) * ${param}::double)`;

// ---------------- product analytics ----------------

const DAY_MS = 86_400_000;
/** Ranges at least this long read hourly rollups (their chart buckets are an hour or more anyway). */
const ROLLUP_MIN_RANGE_MS = 3 * DAY_MS;

/**
 * Rollups instead of raw events, when they can answer the question: no filters (rollups have no
 * per-event fields), and either a long range or one reaching back past the project's raw retention.
 */
async function rollupPlan(pid: string, r: Range, p: Params): Promise<Plan | null> {
  if (parseFilters(p.filters).length || includeBots(p)) return null; // rollups hold human traffic only
  if (r.to.getTime() - r.from.getTime() < ROLLUP_MIN_RANGE_MS) {
    const days = await projectRetention(pid);
    if (r.from.getTime() >= Date.now() - days * DAY_MS) return null;
  }
  return planRange(r.from, r.to);
}

async function rawTotals(pid: string, r: Range, p: Params): Promise<Totals> {
  const params: unknown[] = [pid, r.from, r.to];
  const F = filtersFrom(p, 'events', params);
  const [row] = await rawQuery<Totals>(pid, r,
    `SELECT count(*)::int AS events,
            sum(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END)::int AS pageviews,
            sum(CASE WHEN type = 'click' THEN 1 ELSE 0 END)::int AS clicks,
            sum(CASE WHEN type = 'error' THEN 1 ELSE 0 END)::int AS errors,
            sum(CASE WHEN type = 'http_error' THEN 1 ELSE 0 END)::int AS "httpErrors",
            count(DISTINCT session_id)::int AS sessions,
            count(DISTINCT anon_id)::int AS users
       FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3${F}`,
    params,
  );
  const z = (n: number | null) => n ?? 0;
  return {
    events: z(row?.events), pageviews: z(row?.pageviews), clicks: z(row?.clicks), errors: z(row?.errors),
    httpErrors: z(row?.httpErrors), sessions: z(row?.sessions), users: z(row?.users),
  };
}

const TYPE_TOTAL: Record<string, keyof Totals> = { pageview: 'pageviews', click: 'clicks', error: 'errors', http_error: 'httpErrors' };

/** Totals from hourly rollups (sessions and users: merged HyperLogLog sketches, about ±2%). */
async function rolledTotals(pid: string, plan: Plan): Promise<Totals> {
  const [types, sketches] = await Promise.all([hourlyTypes(pid, plan), hourlySketches(pid, plan)]);
  const t: Totals = { events: 0, pageviews: 0, clicks: 0, errors: 0, httpErrors: 0, sessions: 0, users: 0 };
  for (const row of types) {
    t.events += row.n;
    const k = TYPE_TOTAL[row.type];
    if (k) t[k] += row.n;
  }
  const sessions = new Hll();
  const users = new Hll();
  for (const s of sketches) {
    sessions.merge(s.sessions);
    users.merge(s.users);
  }
  t.sessions = sessions.count();
  t.users = users.count();
  return t;
}

async function totals(pid: string, r: Range, p: Params): Promise<Totals> {
  const plan = await rollupPlan(pid, r, p);
  return plan ? rolledTotals(pid, plan) : rawTotals(pid, r, p);
}

/** GET /totals: totals of one window. The dashboard fetches the comparison window with this, on a slower clock. */
export async function totalsFor(pid: string, p: Params): Promise<Totals> {
  return totals(pid, parseRange(p), p);
}

type SeriesPoint = StatsResponse['series'][number];
const emptyPoint = (t: number): SeriesPoint => ({ t: new Date(t).toISOString(), pageview: 0, click: 0, error: 0, http_error: 0, custom: 0 });

const rawBotSessions = async (pid: string, span: Window): Promise<number> =>
  (await rawQuery<{ n: number }>(pid, span,
    `SELECT count(DISTINCT session_id)::int AS n FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND bot IS NOT NULL`,
    [pid, span.from, span.to],
  ))[0]?.n ?? 0;

/**
 * Sessions left out as bots in a range, so the dashboard can say how much it's hiding. Long ranges read the
 * rollups' 'bot' rows (hourly distinct counts summed, so a bot session spanning hours counts once per hour).
 */
async function botSessions(pid: string, r: Range, p: Params, plan: Plan | null): Promise<number | undefined> {
  if (includeBots(p)) return undefined;
  if (!plan) return rawBotSessions(pid, r);
  const [rolled, tail] = await Promise.all([
    rolledDim(pid, 'bot', plan.roll, 'sessions', 50),
    plan.raw ? rawBotSessions(pid, plan.raw) : Promise.resolve(0),
  ]);
  return rolled.reduce((a, b) => a + b.sessions, tail);
}

/** `compare=0` skips the previous window (the dashboard asks for it separately via /totals). */
export async function stats(pid: string, p: Params): Promise<StatsResponse> {
  const r = parseRange(p);
  const span = r.to.getTime() - r.from.getTime();
  const prevRange = { from: new Date(r.from.getTime() - span), to: r.from };
  const compare = p.compare !== '0' && p.compare !== 'false';
  const plan = await rollupPlan(pid, r, p);
  const hiddenBots = botSessions(pid, r, p, plan);
  hiddenBots.catch(() => undefined); // awaited below; if another query fails first, this must not be an unhandled rejection
  // rollups are hourly: their buckets are at least an hour
  const bucket = plan ? Math.max(pickBucket(r), 3600) : pickBucket(r);
  const byT = new Map<number, SeriesPoint>();
  for (const t of bucketStarts(r, bucket)) byT.set(t, emptyPoint(t));
  const add = (t: number, type: string, n: number) => {
    const point = byT.get(t);
    if (point && type in point && type !== 't') (point as unknown as Record<string, number>)[type] += n;
  };

  if (plan) {
    const [current, previous, hours] = await Promise.all([
      rolledTotals(pid, plan),
      compare ? totals(pid, prevRange, p) : Promise.resolve(null),
      hourlyTypes(pid, plan),
    ]);
    for (const h of hours) add(Math.floor(h.hour / 1000 / bucket) * bucket * 1000, h.type, h.n);
    return { bucketSeconds: bucket, totals: current, previous, series: [...byT.values()], botSessions: await hiddenBots };
  }

  const seriesParams: unknown[] = [pid, r.from, r.to, bucket];
  const F = filtersFrom(p, 'events', seriesParams);
  const [current, previous, rows] = await Promise.all([
    rawTotals(pid, r, p),
    compare ? totals(pid, prevRange, p) : Promise.resolve(null),
    rawQuery<{ t: Date; type: EventType; n: number }>(pid, r,
      `SELECT ${BUCKET_SQL('ts', '$4')} AS t, type, count(*)::int AS n
         FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3${F}
        GROUP BY 1, 2`,
      seriesParams,
    ),
  ]);
  for (const row of rows) add(row.t.getTime(), row.type, row.n);
  return { bucketSeconds: bucket, totals: current, previous, series: [...byT.values()], botSessions: await hiddenBots };
}

/**
 * Most clicked targets, one row per selector + text + tracked name. A selector with an alias is one row whatever its
 * text (a "Buy" button showing a different price on each product page); its text and name are only kept when
 * every click had the same one.
 */
export async function clicks(pid: string, p: Params): Promise<ClickRow[]> {
  const r = parseRange(p);
  const names = await aliasMap(pid);
  const params: unknown[] = [pid, r.from, r.to, limitParam(p.limit, 50, 500)];
  const F = filtersFrom(p, 'events', params);
  const merged = names.size ? `selector IN ${inList(params, [...names.keys()])}` : 'false';
  const rows = await rawQuery<{ selector: string; element_text: string | null; track_name: string | null; element_tag: string | null; count: number; sessions: number; rage: number; last_seen: Date }>(pid, r,
    `SELECT selector,
            CASE WHEN count(DISTINCT element_text) > 1 THEN NULL ELSE max(element_text) END AS element_text,
            CASE WHEN count(DISTINCT track_name) > 1 THEN NULL ELSE max(track_name) END AS track_name,
            max(element_tag) AS element_tag,
            count(*)::int AS count, count(DISTINCT session_id)::int AS sessions,
            sum(CASE WHEN props->>'rage' IS NOT NULL THEN 1 ELSE 0 END)::int AS rage, max(ts) AS last_seen
       FROM events
      WHERE project_id = $1 AND type = 'click' AND ts >= $2 AND ts < $3 AND selector IS NOT NULL${F}
      GROUP BY selector, CASE WHEN ${merged} THEN NULL ELSE element_text END, CASE WHEN ${merged} THEN NULL ELSE track_name END
      ORDER BY count DESC LIMIT $4`,
    params,
  );
  return rows.map((x) => ({
    selector: x.selector, elementText: x.element_text, trackName: x.track_name, elementTag: x.element_tag, alias: names.get(x.selector) ?? null,
    count: x.count, sessions: x.sessions, rageClicks: x.rage, lastSeen: iso(x.last_seen)!,
  }));
}

async function rawPages(pid: string, span: Window, limit: number, p: Params): Promise<PageRow[]> {
  const params: unknown[] = [pid, span.from, span.to, limit];
  const F = filtersFrom(p, 'events', params);
  return rawQuery<PageRow>(pid, span,
    `SELECT path, count(*)::int AS views, count(DISTINCT session_id)::int AS sessions
       FROM events WHERE project_id = $1 AND type = 'pageview' AND ts >= $2 AND ts < $3 AND path IS NOT NULL${F}
      GROUP BY path ORDER BY views DESC LIMIT $4`,
    params,
  );
}

/** Long ranges: pageviews are exact; sessions add up hourly distinct counts, so a session spanning hours counts more than once. */
export async function pages(pid: string, p: Params): Promise<PageRow[]> {
  const r = parseRange(p);
  const limit = limitParam(p.limit, 50, 500);
  const plan = await rollupPlan(pid, r, p);
  if (!plan) return rawPages(pid, r, limit, p);
  const [rolled, raw] = await Promise.all([
    rolledDim(pid, 'page', plan.roll, 'events', limit + 50),
    plan.raw ? rawPages(pid, plan.raw, 500, p) : Promise.resolve([]),
  ]);
  const tail = raw.map((x) => ({ key: x.path, events: x.views, sessions: x.sessions }));
  return mergeKeyed(rolled, tail, 'events', limit).map((x) => ({ path: x.key, views: x.events, sessions: x.sessions }));
}

const SPARK_BUCKETS = 24;

/** One stack per error group: from error_stacks, or (events stored before it existed) from a raw event. */
async function sampleStacks(pid: string, r: Range, fingerprints: string[]): Promise<Map<string, string>> {
  const stacks = await stacksFor(pid, fingerprints);
  const missing = fingerprints.filter((f) => !stacks.has(f));
  if (missing.length) {
    const params: unknown[] = [pid, r.from, r.to];
    const legacy = await rawQuery<{ fingerprint: string; stack: string }>(pid, r,
      `SELECT fingerprint, max(error_stack) AS stack FROM events
        WHERE project_id = $1 AND type = 'error' AND ts >= $2 AND ts < $3 AND fingerprint IN ${inList(params, missing)} AND error_stack IS NOT NULL
        GROUP BY 1`,
      params,
    );
    for (const l of legacy) stacks.set(l.fingerprint, l.stack);
  }
  return stacks;
}

export async function errors(pid: string, p: Params): Promise<ErrorGroup[]> {
  const r = parseRange(p);
  const params: unknown[] = [pid, r.from, r.to, limitParam(p.limit, 100, 500)];
  const F = filtersFrom(p, 'events', params);
  const groups = await rawQuery<{ fingerprint: string; message: string; kind: string | null; count: number; sessions: number; first_seen: Date; last_seen: Date; sample_url: string | null; source: string | null }>(pid, r,
    `SELECT fingerprint, max(error_message) AS message, max(props->>'kind') AS kind,
            sum(COALESCE((props->>'count')::int, 1))::int AS count, count(DISTINCT session_id)::int AS sessions,
            min(ts) AS first_seen, max(ts) AS last_seen,
            max(url) AS sample_url, max(error_source) AS source
       FROM events WHERE project_id = $1 AND type = 'error' AND ts >= $2 AND ts < $3 AND fingerprint IS NOT NULL${F}
      GROUP BY fingerprint ORDER BY count DESC LIMIT $4`,
    params,
  );
  if (!groups.length) return [];
  const step = (r.to.getTime() - r.from.getTime()) / 1000 / SPARK_BUCKETS;
  const sparkParams: unknown[] = [pid, r.from, r.to, step];
  const fps = inList(sparkParams, groups.map((g) => g.fingerprint));
  const SF = filtersFrom(p, 'events', sparkParams);
  const spark = await rawQuery<{ fingerprint: string; b: number; n: number }>(pid, r,
    `SELECT fingerprint, floor(extract(epoch from (ts - $2::TIMESTAMP)) / $4::double)::int AS b,
            sum(COALESCE((props->>'count')::int, 1))::int AS n
       FROM events WHERE project_id = $1 AND type = 'error' AND ts >= $2 AND ts < $3 AND fingerprint IN ${fps}${SF}
      GROUP BY 1, 2`,
    sparkParams,
  );
  const stacks = await sampleStacks(pid, r, groups.map((g) => g.fingerprint));
  const series = new Map(groups.map((g) => [g.fingerprint, new Array<number>(SPARK_BUCKETS).fill(0)]));
  for (const s of spark) {
    const arr = series.get(s.fingerprint);
    if (arr && s.b >= 0 && s.b < SPARK_BUCKETS) arr[s.b] += s.n;
  }
  return groups.map((g) => ({
    fingerprint: g.fingerprint, message: g.message, kind: g.kind, count: g.count, sessions: g.sessions,
    firstSeen: iso(g.first_seen)!, lastSeen: iso(g.last_seen)!, sampleStack: stacks.get(g.fingerprint) ?? null, sampleUrl: g.sample_url,
    source: g.source, series: series.get(g.fingerprint)!,
  }));
}

export async function httpErrors(pid: string, p: Params): Promise<HttpErrorGroup[]> {
  const r = parseRange(p);
  const params: unknown[] = [pid, r.from, r.to, limitParam(p.limit, 100, 500)];
  const F = filtersFrom(p, 'events', params);
  const rows = await rawQuery<{ method: string; route: string; status: number; count: number; sessions: number; avg: number | null; last_seen: Date; sample_url: string | null }>(pid, r,
    `SELECT http_method AS method, http_route AS route, http_status AS status, count(*)::int AS count,
            count(DISTINCT session_id)::int AS sessions, avg(duration_ms)::float8 AS avg,
            max(ts) AS last_seen, max(http_url) AS sample_url
       FROM events WHERE project_id = $1 AND type = 'http_error' AND ts >= $2 AND ts < $3${F}
      GROUP BY 1, 2, 3 ORDER BY count DESC LIMIT $4`,
    params,
  );
  return rows.map((x) => ({
    method: x.method ?? 'GET', route: x.route ?? '(unknown)', status: x.status ?? 0, count: x.count, sessions: x.sessions,
    avgDurationMs: Math.round(x.avg ?? 0), lastSeen: iso(x.last_seen)!, sampleUrl: x.sample_url,
  }));
}

const BREAKDOWN_DIMS: Record<string, string> = {
  browser: 'browser',
  os: 'os',
  device: 'device',
  // host part of the referrer URL
  referrer: `NULLIF(split_part(referrer, '/', 3), '')`,
  country: 'country',
  city: `CASE WHEN city IS NULL THEN NULL ELSE city || ', ' || COALESCE(country, '?') END`,
};

async function rawBreakdown(pid: string, span: Window, dim: string, p: Params, limit: number): Promise<BreakdownRow[]> {
  const expr = BREAKDOWN_DIMS[dim];
  // SPA navigations carry the previous in-app URL as referrer; only external referrers count.
  const typeFilter =
    dim === 'referrer' ? `AND type = 'pageview' AND (referrer IS NULL OR split_part(referrer, '/', 3) <> split_part(url, '/', 3))` : '';
  const params: unknown[] = [pid, span.from, span.to];
  const F = filtersFrom(p, 'events', params);
  return rawQuery<BreakdownRow>(pid, span,
    `SELECT COALESCE(${expr}, ${dim === 'referrer' ? `'(direct)'` : `'Unknown'`}) AS key, count(DISTINCT session_id)::int AS count
       FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3 ${typeFilter}${F}
      GROUP BY 1 ORDER BY count DESC LIMIT ${limit}`,
    params,
  );
}

/** Long ranges count each session once, in the hour it started (attributes such as browser don't change within a session). */
export async function breakdown(pid: string, p: Params): Promise<BreakdownRow[]> {
  const r = parseRange(p);
  const dim = p.dim ?? 'browser';
  if (!BREAKDOWN_DIMS[dim]) throw new HttpError(400, 'dim must be browser, os, device, referrer, country or city');
  const plan = await rollupPlan(pid, r, p);
  if (!plan) return rawBreakdown(pid, r, dim, p, 12);
  const [rolled, raw] = await Promise.all([
    rolledDim(pid, dim as RollupDim, plan.roll, 'sessions', 50),
    plan.raw ? rawBreakdown(pid, plan.raw, dim, p, 50) : Promise.resolve([]),
  ]);
  const tail = raw.map((x) => ({ key: x.key, events: 0, sessions: x.count }));
  return mergeKeyed(rolled, tail, 'sessions', 12).map((x) => ({ key: x.key, count: x.sessions }));
}

export async function geo(pid: string, p: Params): Promise<GeoResponse> {
  const r = parseRange(p);
  const params: unknown[] = [pid, r.from, r.to];
  const F = filtersFrom(p, 'events', params);
  const [points, countries, [counts]] = await Promise.all([
    rawQuery<{ lat: number; lon: number; city: string | null; country: string | null; sessions: number; events: number }>(pid, r,
      `SELECT lat, lon, max(city) AS city, max(country) AS country,
              count(DISTINCT session_id)::int AS sessions, count(*)::int AS events
         FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND lat IS NOT NULL${F}
        GROUP BY lat, lon ORDER BY sessions DESC LIMIT 1000`,
      params,
    ),
    rawQuery<{ country: string; sessions: number; events: number }>(pid, r,
      `SELECT country, count(DISTINCT session_id)::int AS sessions, count(*)::int AS events
         FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND country IS NOT NULL${F}
        GROUP BY country ORDER BY sessions DESC LIMIT 250`,
      params,
    ),
    rawQuery<{ located: number; total: number }>(pid, r,
      `SELECT count(DISTINCT CASE WHEN country IS NOT NULL THEN session_id END)::int AS located,
              count(DISTINCT session_id)::int AS total
         FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3${F}`,
      params,
    ),
  ]);
  return { points, countries, located: counts?.located ?? 0, total: counts?.total ?? 0 };
}

export async function vitals(pid: string, p: Params): Promise<VitalsResponse> {
  const r = parseRange(p);
  const pct = (k: string) => `percentile_cont(0.75) WITHIN GROUP (ORDER BY (props->>'${k}')::float8) AS ${k}`;
  const params: unknown[] = [pid, r.from, r.to];
  const F = filtersFrom(p, 'events', params);
  const [row] = await rawQuery<{ samples: number; lcp: number | null; fcp: number | null; cls: number | null; inp: number | null; ttfb: number | null }>(pid, r,
    `SELECT count(*)::int AS samples, ${['lcp', 'fcp', 'cls', 'inp', 'ttfb'].map(pct).join(', ')}
       FROM events WHERE project_id = $1 AND type = 'vitals' AND ts >= $2 AND ts < $3${F}`,
    params,
  );
  return { samples: row?.samples ?? 0, p75: { lcp: row?.lcp ?? null, fcp: row?.fcp ?? null, cls: row?.cls ?? null, inp: row?.inp ?? null, ttfb: row?.ttfb ?? null } };
}

/**
 * Newest rows first, a slice at a time (last hour, day, week, then the rest), stopping once `limit` rows are
 * found: the latest 100 events of a busy project shouldn't scan its whole range.
 */
async function newestFirst<T>(w: Win, limit: number, fetch: (slice: Win, limit: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  const from = w.from.getTime();
  let end = w.to.getTime();
  for (const back of [3600_000, DAY_MS, 7 * DAY_MS, Infinity]) {
    const start = Math.max(from, w.to.getTime() - back);
    if (start < end) out.push(...(await fetch({ from: new Date(start), to: new Date(end) }, limit - out.length)));
    if (out.length >= limit || start <= from) break;
    end = start;
  }
  return out;
}

const validDate = (v: string | undefined) => {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `Invalid date: ${v}`);
  return d;
};

export async function events(pid: string, p: Params): Promise<EventsResponse> {
  const limit = limitParam(p.limit, 100, 500);
  // no `from`: everything still stored
  const w: Win = {
    from: validDate(p.from) ?? new Date(Date.now() - (await projectRetention(pid)) * DAY_MS),
    to: validDate(p.before) ?? validDate(p.to) ?? new Date(Date.now() + 60_000),
  };
  const where = ['project_id = $1', 'ts >= $2', 'ts < $3'];
  const params: unknown[] = [pid, w.from, w.to];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (p.type) add('type = ?', p.type);
  if (p.sessionId) add('session_id = ?', p.sessionId);
  if (p.fingerprint) add('fingerprint = ?', p.fingerprint);
  if (p.located === '1' || p.located === 'true') where.push('lat IS NOT NULL');
  // one ~11 km map cell (coordinates are stored rounded to 0.1°)
  const lat = Number(p.lat), lon = Number(p.lon);
  if (p.lat && p.lon && Number.isFinite(lat) && Number.isFinite(lon)) {
    add('lat = ?', Math.round(lat * 10) / 10);
    add('lon = ?', Math.round(lon * 10) / 10);
  }
  if (p.q) {
    params.push(likeEscape(p.q));
    const n = `$${params.length}`;
    where.push(
      `(${['path', 'selector', 'element_text', 'track_name', 'error_message', 'http_url', 'name', 'user_id'].map((c) => `${c} ${ILIKE(n)}`).join(' OR ')})`,
    );
  }
  const F = filtersFrom(p, 'events', params);
  const sql = `SELECT * FROM events WHERE ${where.join(' AND ')}${F} ORDER BY ts DESC LIMIT $${params.length + 1}`;
  const rows = await newestFirst(w, limit, (slice, n) => rawQuery<EventRow>(pid, slice, sql, [pid, slice.from, slice.to, ...params.slice(3), n]));
  const evts = rows.map(toApiEvent);
  // error events no longer carry their stack: show their group's
  const needStack = evts.filter((e) => e.type === 'error' && !e.errorStack && e.fingerprint);
  if (needStack.length) {
    const stacks = await stacksFor(pid, needStack.map((e) => e.fingerprint!));
    for (const e of needStack) e.errorStack = stacks.get(e.fingerprint!) ?? null;
  }
  return { events: evts, nextBefore: rows.length === limit ? evts[evts.length - 1].ts : null };
}

// ---------------- OpenTelemetry ----------------

export async function traces(pid: string, p: Params): Promise<TraceSummary[]> {
  const r = parseRange(p, 3600 * 1000);
  const params: unknown[] = [pid, r.from, r.to];
  const having: string[] = [];
  const where: string[] = [];
  if (p.service) {
    params.push(p.service);
    having.push(`sum(CASE WHEN service = $${params.length} THEN 1 ELSE 0 END) > 0`);
  }
  if (p.minDurationMs && Number(p.minDurationMs) > 0) {
    params.push(Number(p.minDurationMs));
    having.push(`extract(epoch from (max(end_time) - min(start_time))) * 1000 >= $${params.length}`);
  }
  if (p.errorsOnly === '1' || p.errorsOnly === 'true') having.push('sum(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) > 0');
  if (p.q) {
    params.push(likeEscape(p.q));
    where.push(`trace_id IN (SELECT trace_id FROM spans WHERE project_id = $1 AND start_time >= $2 AND start_time < $3 AND (name ${ILIKE('$' + params.length)} OR trace_id = $${params.length + 1}))`);
    params.push(p.q.toLowerCase());
  }
  const F = filtersFrom(p, 'spans', params);
  if (F) where.push(`trace_id IN (SELECT trace_id FROM spans WHERE project_id = $1 AND start_time >= $2 AND start_time < $3${F})`);
  params.push(limitParam(p.limit, 100, 500));
  const rows = await rawQuery<{ trace_id: string; root_name: string | null; any_name: string; root_service: string | null; any_service: string; start: Date; dur: number; span_count: number; error_count: number; services: string }>(pid, r,
    `SELECT trace_id,
            max(CASE WHEN parent_span_id IS NULL THEN name END) AS root_name, min(name) AS any_name,
            max(CASE WHEN parent_span_id IS NULL THEN service END) AS root_service, min(service) AS any_service,
            min(start_time) AS start,
            (extract(epoch from (max(end_time) - min(start_time))) * 1000)::float8 AS dur,
            count(*)::int AS span_count,
            sum(CASE WHEN status_code = 2 THEN 1 ELSE 0 END)::int AS error_count,
            string_agg(DISTINCT service, ',') AS services
       FROM spans
      WHERE project_id = $1 AND start_time >= $2 AND start_time < $3 ${where.length ? 'AND ' + where.join(' AND ') : ''}
      GROUP BY trace_id
      ${having.length ? 'HAVING ' + having.join(' AND ') : ''}
      ORDER BY start DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((x) => ({
    traceId: x.trace_id,
    rootName: x.root_name ?? x.any_name,
    service: x.root_service ?? x.any_service,
    start: iso(x.start)!,
    durationMs: Math.round(x.dur * 1000) / 1000,
    spanCount: x.span_count,
    errorCount: x.error_count,
    services: x.services ? x.services.split(',') : [],
  }));
}

interface SpanDbRow {
  trace_id: string; span_id: string; parent_span_id: string | null; name: string; kind: number; service: string;
  start_time: Date; end_time: Date; duration_ms: number; status_code: number; status_message: string | null;
  attributes: Record<string, unknown>; resource: Record<string, unknown>; events: Span['events'];
}

/**
 * All spans of one trace. Spans are stored by day, so a trace is looked up around `at` (any time within it,
 * e.g. a log record's) when given, then in the last two days, then across everything still stored.
 */
export async function trace(pid: string, traceId: string, p: Params = {}): Promise<TraceResponse> {
  if (!/^[0-9a-f]{32}$/i.test(traceId)) throw new HttpError(400, 'Invalid trace id');
  const at = validDate(p.at)?.getTime();
  const now = Date.now();
  const windows: Win[] = [
    ...(at ? [{ from: new Date(at - DAY_MS), to: new Date(at + DAY_MS) }] : []),
    { from: new Date(now - 2 * DAY_MS), to: new Date(now + 60_000) },
    { from: new Date(now - (await projectRetention(pid)) * DAY_MS), to: new Date(now + 60_000) },
  ];
  let rows: SpanDbRow[] = [];
  for (const w of windows) {
    rows = await rawQuery<SpanDbRow>(pid, w,
      // timestamps are millisecond-precision: on ties, roots sort before their children
      `SELECT * FROM spans WHERE project_id = $1 AND trace_id = $2
        ORDER BY start_time, (parent_span_id IS NOT NULL), end_time DESC LIMIT 5000`,
      [pid, traceId.toLowerCase()],
    );
    if (rows.length) break;
  }
  if (!rows.length) throw new HttpError(404, 'Trace not found');
  return {
    spans: rows.map((s) => ({
      traceId: s.trace_id, spanId: s.span_id, parentSpanId: s.parent_span_id, name: s.name, kind: s.kind, service: s.service,
      start: iso(s.start_time)!, end: iso(s.end_time)!, durationMs: s.duration_ms, statusCode: s.status_code,
      statusMessage: s.status_message, attributes: s.attributes ?? {}, resource: s.resource ?? {}, events: s.events ?? [],
    })),
  };
}

export async function services(pid: string, p: Params): Promise<ServiceRow[]> {
  const r = parseRange(p, 3600 * 1000);
  const params: unknown[] = [pid, r.from, r.to];
  const F = filtersFrom(p, 'spans', params);
  const rows = await rawQuery<{ service: string; spans: number; errors: number; p50: number; p95: number }>(pid, r,
    `SELECT service, count(*)::int AS spans, sum(CASE WHEN status_code = 2 THEN 1 ELSE 0 END)::int AS errors,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95
       FROM spans WHERE project_id = $1 AND start_time >= $2 AND start_time < $3${F}
      GROUP BY service ORDER BY spans DESC LIMIT 100`,
    params,
  );
  return rows.map((x) => ({ service: x.service, spans: x.spans, errors: x.errors, p50Ms: x.p50 ?? 0, p95Ms: x.p95 ?? 0 }));
}

export async function logs(pid: string, p: Params): Promise<LogsResponse> {
  const r = parseRange(p, 3600 * 1000);
  const limit = limitParam(p.limit, 200, 1000);
  const w: Win = { from: r.from, to: validDate(p.before) ?? r.to };
  const params: unknown[] = [pid, w.from, w.to];
  const where = ['project_id = $1', 'ts >= $2', 'ts < $3'];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (p.severity && Number(p.severity) > 0) add('severity_number >= ?', Number(p.severity));
  if (p.service) add('service = ?', p.service);
  if (p.traceId) add('trace_id = ?', p.traceId.toLowerCase());
  if (p.q) add(`body ${ILIKE('?')}`, likeEscape(p.q));
  const F = filtersFrom(p, 'logs', params);
  type LogDbRow = { id: string; ts: Date; severity_number: number; severity_text: string | null; body: string; service: string; trace_id: string | null; span_id: string | null; attributes: Record<string, unknown>; resource: Record<string, unknown> };
  const sql = `SELECT id, ts, severity_number, severity_text, body, service, trace_id, span_id, attributes, resource
       FROM logs WHERE ${where.join(' AND ')}${F} ORDER BY ts DESC LIMIT $${params.length + 1}`;
  const rows = await newestFirst(w, limit, (slice, n) => rawQuery<LogDbRow>(pid, slice, sql, [pid, slice.from, slice.to, ...params.slice(3), n]));
  const out: LogRecord[] = rows.map((x) => ({
    id: x.id, ts: iso(x.ts)!, severityNumber: x.severity_number, severityText: x.severity_text, body: x.body, service: x.service,
    traceId: x.trace_id, spanId: x.span_id, attributes: x.attributes ?? {}, resource: x.resource ?? {},
  }));
  return { logs: out, nextBefore: rows.length === limit ? out[out.length - 1].ts : null };
}

export async function metrics(pid: string, p: Params): Promise<MetricInfo[]> {
  const r = parseRange(p);
  const rows = await rawQuery<{ name: string; type: MetricInfo['type']; unit: string | null; description: string | null; service: string; points: number; last_seen: Date }>(pid, r,
    `SELECT name, type, unit, max(description) AS description, service, count(*)::int AS points, max(ts) AS last_seen
       FROM metric_points WHERE project_id = $1 AND ts >= $2 AND ts < $3
      GROUP BY name, type, unit, service ORDER BY name LIMIT 1000`,
    [pid, r.from, r.to],
  );
  return rows.map(({ last_seen, ...x }) => ({ ...x, lastSeen: iso(last_seen)! }));
}

const AGGS: Record<string, string> = {
  avg: 'avg(value)',
  sum: 'sum(value)',
  min: 'min(value)',
  max: 'max(value)',
  p95: 'percentile_cont(0.95) WITHIN GROUP (ORDER BY value)',
};
const MAX_SERIES = 10;

export async function metricSeries(pid: string, p: Params): Promise<MetricSeriesResponse> {
  if (!p.name) throw new HttpError(400, 'name is required');
  const r = parseRange(p);
  const agg = AGGS[p.agg ?? 'avg'];
  if (!agg) throw new HttpError(400, 'agg must be avg, sum, min, max or p95');
  const bucket = pickBucket(r);
  const groupBy = p.groupBy?.trim();
  const keyExpr = groupBy ? `COALESCE(json_extract_string(attributes, $5), '(none)')` : '$2::text';
  const params: unknown[] = [pid, p.name, r.from, r.to];
  if (groupBy) params.push(jsonPath([groupBy]));
  params.push(bucket);
  const bucketParam = `$${params.length}`;
  const rows = await rawQuery<{ key: string; t: Date; value: number }>(pid, r,
    `SELECT ${keyExpr} AS key, ${BUCKET_SQL('ts', bucketParam)} AS t, (${agg})::float8 AS value
       FROM metric_points WHERE project_id = $1 AND name = $2 AND ts >= $3 AND ts < $4
      GROUP BY 1, 2 ORDER BY 2`,
    params,
  );
  const byKey = new Map<string, Array<{ t: string; value: number }>>();
  for (const row of rows) {
    if (!byKey.has(row.key)) byKey.set(row.key, []);
    byKey.get(row.key)!.push({ t: iso(row.t)!, value: row.value });
  }
  const series = [...byKey.entries()]
    .map(([key, points]) => ({ key, points }))
    .sort((a, b) => b.points.length - a.points.length)
    .slice(0, MAX_SERIES);
  return { bucketSeconds: bucket, series };
}

// ---------------- filter field discovery ----------------

const SCOPE_TABLE = {
  events: { table: 'events', time: 'ts', json: [['props', 'props.', true]] },
  logs: { table: 'logs', time: 'ts', json: [['attributes', 'attributes.', false], ['resource', 'resource.', false]] },
  spans: { table: 'spans', time: 'start_time', json: [['attributes', 'attributes.', false], ['resource', 'resource.', false]] },
} as const;

function scopeOf(p: Params): FilterScope {
  const s = (p.scope ?? 'events') as FilterScope;
  if (!(s in SCOPE_TABLE)) throw new HttpError(400, 'scope must be events, logs or spans');
  return s;
}

/** Fields offered by the filter UI: the fixed ones, plus JSON keys seen in the most recent rows. */
export async function fields(pid: string, p: Params): Promise<FieldsResponse> {
  const scope = scopeOf(p);
  const r = parseRange(p);
  const { table, time, json } = SCOPE_TABLE[scope];
  const builtin: FieldInfo[] = Object.entries(COLUMNS[scope]).map(([field, c]) => ({ field, type: c.type }));
  const discovered: FieldInfo[] = [];
  const SAMPLE = 5000;
  for (const [column, prefix] of json) {
    // top-level keys, plus one level down for event props (custom events keep their props under `props`)
    const rows = await rawQuery<{ k: string; n: number }>(pid, r,
      `SELECT k, count(*)::int AS n FROM (
         SELECT unnest(json_keys(j)) AS k FROM (
           SELECT ${column} AS j FROM ${table} WHERE project_id = $1 AND ${time} >= $2 AND ${time} < $3 AND json_type(${column}) = 'OBJECT'
            ORDER BY ${time} DESC LIMIT ${SAMPLE}
         ) s
       ) keys
       GROUP BY k ORDER BY n DESC, k LIMIT 200`,
      [pid, r.from, r.to],
    );
    for (const { k, n } of rows) {
      if (scope === 'events' && (k === 'props' || k === '$ctx')) continue; // expanded below
      discovered.push({ field: prefix + k, type: 'json', count: n });
    }
    if (scope === 'events') {
      for (const nested of ['props', '$ctx']) {
        const sub = await rawQuery<{ k: string; n: number }>(pid, r,
          `SELECT k, count(*)::int AS n FROM (
             SELECT unnest(json_keys(j)) AS k FROM (
               SELECT json_extract(${column}, $4) AS j FROM ${table}
                WHERE project_id = $1 AND ${time} >= $2 AND ${time} < $3 AND json_type(json_extract(${column}, $4)) = 'OBJECT'
                ORDER BY ${time} DESC LIMIT ${SAMPLE}
             ) s
           ) keys
           GROUP BY k ORDER BY n DESC, k LIMIT 100`,
          [pid, r.from, r.to, jsonPath([nested])],
        );
        for (const { k, n } of sub) discovered.push({ field: `${prefix}${nested}.${k}`, type: 'json', count: n });
      }
    }
  }
  discovered.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  return { builtin, discovered };
}

/** Most frequent values of a field (for autocomplete), optionally narrowed by a substring. */
export async function fieldValues(pid: string, p: Params): Promise<FieldValuesResponse> {
  const scope = scopeOf(p);
  if (!p.field) throw new HttpError(400, 'field is required');
  const r = parseRange(p);
  const { table, time } = SCOPE_TABLE[scope];
  const params: unknown[] = [pid, r.from, r.to];
  const expr = fieldExpression(scope, p.field, params);
  const qFilter = p.q ? ` AND (${expr})::text ${ILIKE('$' + params.push(likeEscape(p.q)))}` : '';
  const rows = await rawQuery<{ value: string; count: number }>(pid, r,
    `SELECT (${expr})::text AS value, count(*)::int AS count
       FROM ${table} WHERE project_id = $1 AND ${time} >= $2 AND ${time} < $3 AND (${expr}) IS NOT NULL${qFilter}
      GROUP BY 1 ORDER BY count DESC LIMIT 20`,
    params,
  );
  return { values: rows.map((x) => ({ value: x.value.length > 200 ? x.value.slice(0, 200) : x.value, count: x.count })) };
}
