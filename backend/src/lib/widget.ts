import type { WidgetCatalog, WidgetOverview, WidgetRange, WidgetStat, WidgetStatOption, WidgetSummary } from '../contract';
import { breakdown, pages } from './analytics';
import { Hll } from './hll';
import { HttpError } from './http';
import { projectRetention } from './retention';
import { hourlySketches, hourlyTypes, planRange, type Plan } from './rollups';
import { rawQuery } from './store/duck';
import { suppressedSql } from './suppressions';

/**
 * Data for the Android home-screen widget: a catalog of stats the user can pick, and a summary that computes
 * only the stats a widget asked for. Every additive stat comes from one query over 2×24 buckets spanning the
 * previous window and the current one, so the total, the comparison and the sparkline share a scan.
 */

type Params = Record<string, string | undefined>;

const RANGES: Record<WidgetRange, number> = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
const POINTS = 24;
const NOW_MINUTES = 30; // visitors-now sparkline: one point per minute
const ACTIVE_MS = 5 * 60_000; // "now" = seen in the last 5 minutes
export const MAX_STATS = 8;

interface Def {
  label: string;
  description: string;
  category: WidgetStatOption['category'];
  unit: WidgetStat['unit'];
  better: WidgetStat['better'];
  page: string;
}

const BUILTIN: Record<string, Def> = {
  visitors_now: { label: 'Visitors now', description: 'Sessions active in the last 5 minutes', category: 'Traffic', unit: 'count', better: 'none', page: 'live' },
  pageviews: { label: 'Pageviews', description: 'Page loads and SPA navigations', category: 'Traffic', unit: 'count', better: 'up', page: 'overview' },
  sessions: { label: 'Sessions', description: 'Distinct browser sessions', category: 'Traffic', unit: 'count', better: 'up', page: 'overview' },
  users: { label: 'Visitors', description: 'Distinct anonymous visitors', category: 'Traffic', unit: 'count', better: 'up', page: 'overview' },
  top_country: { label: 'Top country', description: 'Country with the most sessions', category: 'Traffic', unit: 'text', better: 'none', page: 'overview' },
  clicks: { label: 'Clicks', description: 'All captured clicks', category: 'Engagement', unit: 'count', better: 'up', page: 'clicks' },
  top_page: { label: 'Top page', description: 'Most viewed path', category: 'Engagement', unit: 'text', better: 'none', page: 'overview' },
  errors: { label: 'JS errors', description: 'Uncaught errors and rejections', category: 'Reliability', unit: 'count', better: 'down', page: 'errors' },
  http_errors: { label: 'Failed API calls', description: 'HTTP 4xx/5xx and network failures', category: 'Reliability', unit: 'count', better: 'down', page: 'network' },
  lcp: { label: 'LCP p75', description: 'Largest Contentful Paint, 75th percentile', category: 'Performance', unit: 'ms', better: 'down', page: 'overview' },
  inp: { label: 'INP p75', description: 'Interaction to Next Paint, 75th percentile', category: 'Performance', unit: 'ms', better: 'down', page: 'overview' },
  cls: { label: 'CLS p75', description: 'Cumulative Layout Shift, 75th percentile', category: 'Performance', unit: 'score', better: 'down', page: 'overview' },
  traces: { label: 'Traces', description: 'Root spans received from your services', category: 'Backend', unit: 'count', better: 'none', page: 'traces' },
  latency_p95: { label: 'Latency p95', description: 'Root span duration, 95th percentile', category: 'Backend', unit: 'ms', better: 'down', page: 'traces' },
  span_errors: { label: 'Failed spans', description: 'Spans with error status', category: 'Backend', unit: 'count', better: 'down', page: 'traces' },
  log_errors: { label: 'Error logs', description: 'Log records at ERROR or above', category: 'Backend', unit: 'count', better: 'down', page: 'logs' },
};

// Web Vitals thresholds (good ≤ first, poor > second), same as the dashboard
const VITALS: Record<string, [number, number]> = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25] };

const DYNAMIC = /^(track|event|metric):(.{1,200})$/s;

export function parseWidgetRange(v: string | undefined): WidgetRange {
  const r = (v ?? '24h') as WidgetRange;
  if (!(r in RANGES)) throw new HttpError(400, 'range must be 1h, 24h, 7d or 30d');
  return r;
}

export function parseStatKeys(v: string | undefined): string[] {
  // keys are comma-separated; names inside dynamic keys are URI-encoded so they may contain commas
  const keys = [...new Set((v ?? '').split(',').map((k) => safeDecode(k.trim())).filter(Boolean))];
  if (!keys.length) throw new HttpError(400, 'stats is required');
  if (keys.length > MAX_STATS) throw new HttpError(400, `At most ${MAX_STATS} stats per widget`);
  for (const k of keys) if (!BUILTIN[k] && !DYNAMIC.test(k)) throw new HttpError(400, `Unknown stat: ${k}`);
  return keys;
}
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------- catalog

export async function catalog(pid: string): Promise<WidgetCatalog> {
  const since = new Date(Date.now() - 7 * 86400e3);
  const recent = { from: since, to: new Date(Date.now() + 60_000) };
  const [tracks, events, metrics] = await Promise.all([
    rawQuery<{ name: string; n: number }>(pid, recent,
      `SELECT track_name AS name, count(*)::int AS n FROM events
        WHERE project_id = $1 AND type = 'click' AND ts >= $2 AND track_name IS NOT NULL
        GROUP BY 1 ORDER BY n DESC LIMIT 30`,
      [pid, since],
    ),
    rawQuery<{ name: string; n: number }>(pid, recent,
      `SELECT name, count(*)::int AS n FROM events
        WHERE project_id = $1 AND type = 'custom' AND ts >= $2 AND name IS NOT NULL
        GROUP BY 1 ORDER BY n DESC LIMIT 30`,
      [pid, since],
    ),
    rawQuery<{ name: string; unit: string | null; description: string | null }>(pid, recent,
      `SELECT name, max(unit) AS unit, max(description) AS description FROM metric_points
        WHERE project_id = $1 AND ts >= $2 GROUP BY 1 ORDER BY 1 LIMIT 60`,
      [pid, since],
    ),
  ]);
  const options: WidgetStatOption[] = Object.entries(BUILTIN).map(([key, d]) => ({ key, label: d.label, description: d.description, category: d.category }));
  for (const t of tracks) options.push({ key: `track:${t.name}`, label: t.name, description: `Clicks on data-track="${t.name}"`, category: 'Tracked clicks' });
  for (const e of events) options.push({ key: `event:${e.name}`, label: e.name, description: 'Custom event count', category: 'Custom events' });
  for (const m of metrics) {
    options.push({ key: `metric:${m.name}`, label: m.name, description: m.description || `Latest value${m.unit ? ` (${m.unit})` : ''}`, category: 'Metrics' });
  }
  return { options };
}

// ---------------------------------------------------------------- summary

interface Win {
  from: Date;
  to: Date;
  prevFrom: Date;
  step: number; // seconds per bucket
}

/** Bucket index over [prevFrom, to): 0..23 = previous window, 24..47 = current window. */
const B = (col: string) => `floor(extract(epoch from (${col} - $2::TIMESTAMP)) / $4::double)::int`;

/** Split 48 bucket rows into previous total, current total and the current window's series. */
function split(rows: Array<{ b: number }>, get: (r: never) => number | null) {
  const series = new Array<number>(POINTS).fill(0);
  let cur = 0;
  let prev = 0;
  for (const r of rows) {
    const v = get(r as never) ?? 0;
    if (r.b >= 0 && r.b < POINTS) prev += v;
    else if (r.b >= POINTS && r.b < POINTS * 2) {
      cur += v;
      series[r.b - POINTS] += v;
    }
  }
  return { cur, prev, series };
}

/** Non-additive per-bucket values (percentiles, averages): gaps carry the last value forward. */
function gapSeries(rows: Array<{ b: number }>, get: (r: never) => number | null): number[] {
  const raw = new Array<number | null>(POINTS).fill(null);
  for (const r of rows) if (r.b >= POINTS && r.b < POINTS * 2) raw[r.b - POINTS] = get(r as never);
  const first = raw.find((v) => v != null) ?? null;
  if (first == null) return [];
  let last = first;
  return raw.map((v) => (v == null ? last : (last = v)));
}

type Part = Pick<WidgetStat, 'value' | 'previous' | 'series'> & PartExtra;
type PartExtra = { text?: string | null; rating?: WidgetStat['rating']; unit?: WidgetStat['unit']; suffix?: string | null; label?: string };

type Loader = (pid: string, w: Win, keys: string[]) => Promise<Record<string, Part>>;
/** Both windows (previous and current) of a widget request. */
const span = (w: Win) => ({ from: w.prevFrom, to: w.to });

/** Long windows (or ones reaching past raw retention) come from hourly rollups, like the dashboard's. */
async function widgetPlan(pid: string, w: Win): Promise<Plan | null> {
  if (w.to.getTime() - w.from.getTime() < 3 * 86400e3 && w.prevFrom.getTime() >= Date.now() - (await projectRetention(pid)) * 86400e3) return null;
  return planRange(w.prevFrom, w.to);
}

/** eventCounts from rollups: each hour lands in the bucket its start falls in. */
async function rolledEventCounts(pid: string, w: Win, plan: Plan): Promise<Record<string, Part>> {
  const [types, sketches] = await Promise.all([hourlyTypes(pid, plan), hourlySketches(pid, plan)]);
  const bucketOf = (hour: number) => Math.max(0, Math.floor((hour - w.prevFrom.getTime()) / 1000 / w.step));
  const rows = new Map<number, { b: number; pageview: number; click: number; error: number; http_error: number; s: Hll; u: Hll }>();
  const row = (b: number) => {
    let r = rows.get(b);
    if (!r) rows.set(b, (r = { b, pageview: 0, click: 0, error: 0, http_error: 0, s: new Hll(), u: new Hll() }));
    return r;
  };
  for (const t of types) {
    const r = row(bucketOf(t.hour));
    if (t.type in r && t.type !== 'b') (r as unknown as Record<string, number>)[t.type] += t.n;
  }
  for (const k of sketches) {
    const r = row(bucketOf(k.hour));
    r.s.merge(k.sessions);
    r.u.merge(k.users);
  }
  const list = [...rows.values()].map((r) => ({ ...r, sessions: r.s.count(), users: r.u.count() }));
  const window = (cur: boolean, pick: 's' | 'u') => {
    const h = new Hll();
    for (const r of rows.values()) if (r.b >= POINTS === cur) h.merge(r[pick]);
    return h.count();
  };
  const out: Record<string, Part> = {};
  const col = { pageviews: 'pageview', clicks: 'click', errors: 'error', http_errors: 'http_error' } as const;
  for (const [key, c] of Object.entries(col)) {
    const s = split(list, (r: Record<string, number>) => r[c]);
    out[key] = { value: s.cur, previous: s.prev, series: s.series };
  }
  out.sessions = { value: window(true, 's'), previous: window(false, 's'), series: split(list, (r: { sessions: number }) => r.sessions).series };
  out.users = { value: window(true, 'u'), previous: window(false, 'u'), series: split(list, (r: { users: number }) => r.users).series };
  return out;
}

const eventCounts: Loader = async (pid, w, keys) => {
  const plan = await widgetPlan(pid, w);
  if (plan) return rolledEventCounts(pid, w, plan); // rollups already leave out suppressed errors
  // errors a suppression rule covers but that were stored before the rule existed don't count (as on the dashboard)
  const params: unknown[] = [pid, w.prevFrom, w.to, w.step];
  const S = await suppressedSql(pid, params);
  const [rows, [d]] = await Promise.all([
    rawQuery<{ b: number; pageview: number; click: number; error: number; http_error: number; sessions: number; users: number }>(pid, span(w),
      `SELECT ${B('ts')} AS b,
              sum(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END)::int AS pageview,
              sum(CASE WHEN type = 'click' THEN 1 ELSE 0 END)::int AS click,
              sum(CASE WHEN type = 'error' THEN 1 ELSE 0 END)::int AS error,
              sum(CASE WHEN type = 'http_error' THEN 1 ELSE 0 END)::int AS http_error,
              count(DISTINCT session_id)::int AS sessions, count(DISTINCT anon_id)::int AS users
         FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND bot IS NULL${S} GROUP BY 1`,
      params,
    ),
    // distinct counts don't add up across buckets: count each window once
    keys.some((k) => k === 'sessions' || k === 'users')
      ? rawQuery<{ s_cur: number; s_prev: number; u_cur: number; u_prev: number }>(pid, span(w),
          `SELECT count(DISTINCT CASE WHEN ts >= $4 THEN session_id END)::int AS s_cur,
                  count(DISTINCT CASE WHEN ts < $4 THEN session_id END)::int AS s_prev,
                  count(DISTINCT CASE WHEN ts >= $4 THEN anon_id END)::int AS u_cur,
                  count(DISTINCT CASE WHEN ts < $4 THEN anon_id END)::int AS u_prev
             FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND bot IS NULL`,
          [pid, w.prevFrom, w.to, w.from],
        )
      : Promise.resolve([undefined]),
  ]);
  const out: Record<string, Part> = {};
  const col = { pageviews: 'pageview', clicks: 'click', errors: 'error', http_errors: 'http_error' } as const;
  for (const [key, c] of Object.entries(col)) {
    const s = split(rows, (r: Record<string, number>) => r[c]);
    out[key] = { value: s.cur, previous: s.prev, series: s.series };
  }
  out.sessions = { value: d?.s_cur ?? 0, previous: d?.s_prev ?? 0, series: split(rows, (r: { sessions: number }) => r.sessions).series };
  out.users = { value: d?.u_cur ?? 0, previous: d?.u_prev ?? 0, series: split(rows, (r: { users: number }) => r.users).series };
  return out;
};

const visitorsNow: Loader = async (pid) => {
  // per minute: sessions seen in the 5 minutes up to it, so the last point equals the headline number
  const window = ACTIVE_MS / 60_000;
  const now = Date.now();
  const start = new Date(now - (NOW_MINUTES + window) * 60_000);
  const rows = await rawQuery<{ session_id: string; m: number }>(pid, { from: start, to: new Date(now + 60_000) },
    `SELECT DISTINCT session_id, floor(extract(epoch from (ts - $2::TIMESTAMP)) / 60)::int AS m
       FROM events WHERE project_id = $1 AND ts >= $2 AND session_id IS NOT NULL AND bot IS NULL`,
    [pid, start],
  );
  const byMinute = new Map<number, Set<string>>();
  for (const r of rows) {
    if (!byMinute.has(r.m)) byMinute.set(r.m, new Set());
    byMinute.get(r.m)!.add(r.session_id);
  }
  const series = Array.from({ length: NOW_MINUTES }, (_, i) => {
    const seen = new Set<string>();
    const end = i + window; // minute index (from `start`) that point i stands for
    for (let m = end - window + 1; m <= end; m++) for (const sid of byMinute.get(m) ?? []) seen.add(sid);
    return seen.size;
  });
  return { visitors_now: { value: series[NOW_MINUTES - 1], previous: null, series } };
};

const rate = (key: string, v: number | null): WidgetStat['rating'] => {
  const t = VITALS[key];
  if (v == null || !t) return null;
  return v <= t[0] ? 'good' : v <= t[1] ? 'warn' : 'bad';
};

const vitals: Loader = async (pid, w, keys) => {
  const ks = keys.filter((k) => k in VITALS);
  // keys come from the fixed VITALS table, so interpolating them is safe
  const pct = ks.map((k) => `percentile_cont(0.75) WITHIN GROUP (ORDER BY (props->>'${k}')::float8) AS ${k}`).join(', ');
  const [rows, windows] = await Promise.all([
    rawQuery<{ b: number } & Record<string, number | null>>(pid, span(w),
      `SELECT ${B('ts')} AS b, ${pct} FROM events
        WHERE project_id = $1 AND type = 'vitals' AND ts >= $2 AND ts < $3 AND bot IS NULL GROUP BY 1`,
      [pid, w.prevFrom, w.to, w.step],
    ),
    rawQuery<{ cur: boolean } & Record<string, number | null>>(pid, span(w),
      `SELECT (ts >= $4) AS cur, ${pct} FROM events
        WHERE project_id = $1 AND type = 'vitals' AND ts >= $2 AND ts < $3 AND bot IS NULL GROUP BY 1`,
      [pid, w.prevFrom, w.to, w.from],
    ),
  ]);
  const cur = windows.find((r) => r.cur);
  const prev = windows.find((r) => !r.cur);
  const out: Record<string, Part> = {};
  for (const k of ks) {
    const value = cur?.[k] ?? null;
    out[k] = { value, previous: prev?.[k] ?? null, series: gapSeries(rows, (r: Record<string, number | null>) => r[k]), rating: rate(k, value) };
  }
  return out;
};

const spans: Loader = async (pid, w) => {
  const cols = `sum(CASE WHEN parent_span_id IS NULL THEN 1 ELSE 0 END)::int AS traces,
                sum(CASE WHEN status_code = 2 THEN 1 ELSE 0 END)::int AS errors,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY CASE WHEN parent_span_id IS NULL THEN duration_ms END) AS p95`;
  const [rows, windows] = await Promise.all([
    rawQuery<{ b: number; traces: number; errors: number; p95: number | null }>(pid, span(w),
      `SELECT ${B('start_time')} AS b, ${cols} FROM spans WHERE project_id = $1 AND start_time >= $2 AND start_time < $3 GROUP BY 1`,
      [pid, w.prevFrom, w.to, w.step],
    ),
    rawQuery<{ cur: boolean; p95: number | null }>(pid, span(w),
      `SELECT (start_time >= $4) AS cur, ${cols} FROM spans WHERE project_id = $1 AND start_time >= $2 AND start_time < $3 GROUP BY 1`,
      [pid, w.prevFrom, w.to, w.from],
    ),
  ]);
  const t = split(rows, (r: { traces: number }) => r.traces);
  const e = split(rows, (r: { errors: number }) => r.errors);
  return {
    traces: { value: t.cur, previous: t.prev, series: t.series },
    span_errors: { value: e.cur, previous: e.prev, series: e.series },
    latency_p95: {
      value: windows.find((r) => r.cur)?.p95 ?? null,
      previous: windows.find((r) => !r.cur)?.p95 ?? null,
      series: gapSeries(rows, (r: { p95: number | null }) => r.p95),
    },
  };
};

const logErrors: Loader = async (pid, w) => {
  const rows = await rawQuery<{ b: number; n: number }>(pid, span(w),
    `SELECT ${B('ts')} AS b, count(*)::int AS n FROM logs
      WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND severity_number >= 17 GROUP BY 1`,
    [pid, w.prevFrom, w.to, w.step],
  );
  const s = split(rows, (r: { n: number }) => r.n);
  return { log_errors: { value: s.cur, previous: s.prev, series: s.series } };
};

const topPage: Loader = async (pid, w) => {
  const [row] = await pages(pid, { from: w.from.toISOString(), to: w.to.toISOString(), limit: '1' });
  return { top_page: { value: row?.views ?? null, previous: null, series: [], text: row?.path ?? null } };
};

const topCountry: Loader = async (pid, w) => {
  const rows = await breakdown(pid, { from: w.from.toISOString(), to: w.to.toISOString(), dim: 'country' });
  const row = rows.find((r) => r.key !== 'Unknown');
  return { top_country: { value: row?.count ?? null, previous: null, series: [], text: row?.key ?? null } };
};

async function dynamicStat(pid: string, w: Win, key: string): Promise<Part> {
  const [, kind, name] = key.match(DYNAMIC)!;
  if (kind === 'metric') {
    const rows = await rawQuery<{ b: number; v: number | null; unit: string | null }>(pid, span(w),
      `SELECT ${B('ts')} AS b, avg(value)::float8 AS v, max(unit) AS unit FROM metric_points
        WHERE project_id = $1 AND name = $5 AND ts >= $2 AND ts < $3 GROUP BY 1`,
      [pid, w.prevFrom, w.to, w.step, name],
    );
    const latest = (lo: number, hi: number) => rows.filter((r) => r.b >= lo && r.b < hi && r.v != null).sort((a, b) => b.b - a.b)[0]?.v ?? null;
    const unit = rows.find((r) => r.unit)?.unit ?? null;
    // seconds-based OTel units display better as durations
    const scale = unit === 's' ? 1000 : 1;
    const scaleOrNull = (v: number | null) => (v == null ? null : v * scale);
    const isMs = unit === 'ms' || unit === 's';
    const suffix = isMs || !unit || unit === '1' ? null : unit.replace(/^\{(.*)\}$/, '$1');
    return {
      label: name,
      unit: isMs ? 'ms' : 'score',
      suffix,
      value: scaleOrNull(latest(POINTS, POINTS * 2)),
      previous: scaleOrNull(latest(0, POINTS)),
      series: gapSeries(rows, (r: { v: number | null }) => r.v).map((v) => v * scale),
    };
  }
  const where = kind === 'track' ? `type = 'click' AND track_name = $5` : `type = 'custom' AND name = $5`;
  const rows = await rawQuery<{ b: number; n: number }>(pid, span(w),
    `SELECT ${B('ts')} AS b, count(*)::int AS n FROM events
      WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND bot IS NULL AND ${where} GROUP BY 1`,
    [pid, w.prevFrom, w.to, w.step, name],
  );
  const s = split(rows, (r: { n: number }) => r.n);
  return { label: name, value: s.cur, previous: s.prev, series: s.series };
}

const LOADERS: Array<{ keys: string[]; load: Loader }> = [
  { keys: ['pageviews', 'sessions', 'users', 'clicks', 'errors', 'http_errors'], load: eventCounts },
  { keys: ['visitors_now'], load: visitorsNow },
  { keys: Object.keys(VITALS), load: vitals },
  { keys: ['traces', 'latency_p95', 'span_errors'], load: spans },
  { keys: ['log_errors'], load: logErrors },
  { keys: ['top_page'], load: topPage },
  { keys: ['top_country'], load: topCountry },
];

/** Compute [keys] for one project over the last [range]. */
async function computeStats(pid: string, range: WidgetRange, keys: string[], to = new Date()): Promise<{ from: Date; to: Date; stats: WidgetStat[] }> {
  const span = RANGES[range];
  const w: Win = { to, from: new Date(to.getTime() - span), prevFrom: new Date(to.getTime() - 2 * span), step: span / 1000 / POINTS };

  const results: Record<string, Part> = {};
  await Promise.all([
    ...LOADERS.filter((l) => l.keys.some((k) => keys.includes(k))).map(async (l) => Object.assign(results, await l.load(pid, w, keys))),
    ...keys.filter((k) => DYNAMIC.test(k)).map(async (k) => { results[k] = await dynamicStat(pid, w, k); }),
  ]);

  const stats: WidgetStat[] = keys.map((key) => {
    const r = results[key];
    const def = BUILTIN[key];
    const kind = key.split(':')[0];
    return {
      key,
      label: r.label ?? def?.label ?? key,
      unit: r.unit ?? def?.unit ?? 'count',
      value: r.value,
      previous: r.previous,
      better: def?.better ?? (kind === 'metric' ? 'none' : 'up'),
      rating: r.rating ?? null,
      text: r.text ?? null,
      suffix: r.suffix ?? null,
      series: r.series,
      page: def?.page ?? (kind === 'track' ? 'clicks' : kind === 'metric' ? 'metrics' : 'events'),
    };
  });
  return { from: w.from, to: w.to, stats };
}

export async function summary(project: { id: string; name: string }, p: Params): Promise<WidgetSummary> {
  const range = parseWidgetRange(p.range);
  const keys = parseStatKeys(p.stats);
  const { from, to, stats } = await computeStats(project.id, range, keys);
  return { project, range, from: from.toISOString(), to: to.toISOString(), generatedAt: new Date().toISOString(), stats };
}

// ---------------------------------------------------------------- overview (all projects)

export const MAX_OVERVIEW_STATS = 3;
const MAX_OVERVIEW_PROJECTS = 30;
const OVERVIEW_CONCURRENCY = 4;
/** Text stats don't fit a one-line project row. Dynamic stats (track:/event:/metric:) are per project. */
const OVERVIEW_KEYS = Object.keys(BUILTIN).filter((k) => BUILTIN[k].unit !== 'text');

export function parseOverviewKeys(v: string | undefined): string[] {
  const keys = parseStatKeys(v);
  if (keys.length > MAX_OVERVIEW_STATS) throw new HttpError(400, `At most ${MAX_OVERVIEW_STATS} stats per project in an overview`);
  for (const k of keys) if (!OVERVIEW_KEYS.includes(k)) throw new HttpError(400, `Not available in an overview: ${k}`);
  return keys;
}

/**
 * The same stats for every project the user can see, busiest first (by the first stat). A project that fails
 * to load comes back with an error instead of failing the whole overview.
 */
export async function overview(projects: Array<{ id: string; name: string }>, p: Params): Promise<WidgetOverview> {
  const range = parseWidgetRange(p.range);
  const keys = parseOverviewKeys(p.stats);
  const list = projects.slice(0, MAX_OVERVIEW_PROJECTS);
  const to = new Date(); // one window for every project, so the rows compare
  const rows: WidgetOverview['projects'] = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < list.length; i = next++) {
      const project = { id: list[i].id, name: list[i].name };
      try {
        rows[i] = { project, stats: (await computeStats(project.id, range, keys, to)).stats, error: null };
      } catch (err) {
        console.error('widget overview: project failed', project.id, err);
        rows[i] = { project, stats: [], error: 'Failed to load' };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(OVERVIEW_CONCURRENCY, list.length) }, worker));
  const lead = (r: WidgetOverview['projects'][number]) => r.stats[0]?.value ?? -1;
  rows.sort((a, b) => lead(b) - lead(a) || a.project.name.localeCompare(b.project.name));
  return {
    range,
    from: new Date(to.getTime() - RANGES[range]).toISOString(),
    to: to.toISOString(),
    generatedAt: new Date().toISOString(),
    total: projects.length,
    projects: rows,
  };
}
