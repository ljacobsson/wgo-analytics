import type { ExplainDim, ExplainDriver, ExplainMetric, Explanation, Filter, ReleaseMarker } from '../contract';
import { parseRange, pickBucket } from './analytics';
import { filterSql, filtersFrom, parseFilters } from './filters';
import { wilson } from './funnel';
import { findGoal } from './goals';
import { HttpError } from './http';
import { RELEASE_SQL, releaseMarkers } from './releases';
import { rawQuery } from './store/duck';
import { suppressedSql } from './suppressions';

/**
 * "Why did this change?": compares a metric in a window with a baseline (by default the window before it) and says
 * which segments account for the change, when it started and whether a release went out just before.
 *
 * - Segments are ranked by their *excess* change: what changed beyond growing or shrinking in line with the total.
 *   A browser with 60% of traffic that brings 60% of the new errors isn't the cause; one with 5% that brings 80% is.
 * - The start is a single change point (CUSUM) over the bucketed series of both windows, reported only when the
 *   level shift is well beyond Poisson noise.
 * - Goal conversion compares each segment's rate in both windows, kept only when their 95% intervals separate.
 */

type Q = Record<string, string | undefined>;
const MAX_DRIVERS = 8;
const PER_DIM = 50;
const MIN_COUNT_CHANGE = 5;
const MIN_SESSIONS = 20;

// ---------------------------------------------------------------- pure parts (tested on their own)

export interface SegmentCounts { dim: ExplainDim; key: string; current: number; previous: number }

/**
 * Segments that explain a change of a count from `prev` to `cur`, biggest first. Excess = current − previous × growth:
 * the part of a segment's change that the overall growth doesn't account for.
 */
export function countDrivers(rows: SegmentCounts[], cur: number, prev: number, limit = MAX_DRIVERS): ExplainDriver[] {
  const change = cur - prev;
  if (!change) return [];
  const up = change > 0;
  const g = prev > 0 ? cur / prev : null;
  return rows
    .filter((r) => r.key !== '(none)')
    .map((r) => {
      const excess = g === null ? r.current - r.previous : r.current - r.previous * g;
      return { r, excess };
    })
    // moved in the same direction as the total, by more than in line with it, and by a meaningful amount
    .filter(({ r, excess }) => (up ? excess > 0 : excess < 0) && Math.abs(r.current - r.previous) >= MIN_COUNT_CHANGE && Math.abs(excess) >= Math.abs(change) * 0.1)
    .sort((a, b) => Math.abs(b.excess) - Math.abs(a.excess))
    .slice(0, limit)
    .map(({ r }) => ({ dim: r.dim, key: r.key, current: r.current, previous: r.previous, share: (r.current - r.previous) / change, before: prev > 0 ? r.previous / prev : 0 }));
}

export interface SegmentRates extends SegmentCounts { convCurrent: number; convPrevious: number }

/**
 * Segments whose conversion rate clearly moved in the same direction as the overall rate, by impact: conversions
 * gained or lost at the segment's current traffic. `share` relates that to the overall gain or loss.
 */
export function rateDrivers(rows: SegmentRates[], total: { cur: number; prev: number; rateCur: number; ratePrev: number }, limit = MAX_DRIVERS): ExplainDriver[] {
  const change = total.cur * (total.rateCur - total.ratePrev);
  if (!change) return [];
  const up = change > 0;
  return rows
    .filter((r) => r.key !== '(none)' && r.current >= MIN_SESSIONS)
    .map((r) => {
      // a segment new in this window (a release, a campaign) is compared with the overall baseline
      const own = r.previous >= MIN_SESSIONS;
      const rc = r.convCurrent / r.current, rp = own ? r.convPrevious / r.previous : total.ratePrev;
      const [cl, ch] = wilson(r.convCurrent, r.current);
      const [pl, ph] = own ? wilson(r.convPrevious, r.previous) : wilson(Math.round(total.ratePrev * total.prev), total.prev);
      return { r, rc, rp, separate: up ? cl > ph : ch < pl, impact: r.current * (rc - rp) };
    })
    .filter((x) => x.separate)
    .sort((a, b) => (up ? b.impact - a.impact : a.impact - b.impact))
    .slice(0, limit)
    .map(({ r, rc, rp, impact }) => ({
      dim: r.dim, key: r.key, current: r.current, previous: r.previous, share: impact / change,
      before: total.prev ? r.previous / total.prev : 0, rate: { current: rc, previous: rp },
    }));
}

/**
 * Single change point of a count series (CUSUM): the index where the level after differs most from the level
 * before, if the shift is beyond 3 standard errors of Poisson noise. Null otherwise.
 */
export function changePoint(values: number[]): { index: number; before: number; after: number } | null {
  const n = values.length;
  if (n < 4) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let s = 0, best = 0, k = -1;
  for (let i = 0; i < n - 1; i++) {
    s += values[i] - mean;
    if (Math.abs(s) > best) { best = Math.abs(s); k = i + 1; }
  }
  if (k < 1 || k > n - 1) return null;
  const before = values.slice(0, k).reduce((a, b) => a + b, 0) / k;
  const after = values.slice(k).reduce((a, b) => a + b, 0) / (n - k);
  // standard error of the difference of two Poisson means (at least a count of 1 per bucket, so empty stretches don't make noise look like a signal)
  const se = Math.sqrt(Math.max(before, 1) / k + Math.max(after, 1) / (n - k));
  if (Math.abs(after - before) < 3 * se || Math.abs(after - before) < 0.25 * Math.max(before, after)) return null;
  return { index: k, before, after };
}

/** Whether a change between two counts is beyond the noise of counts that size (about 3σ of Poisson). */
export const countSignificant = (cur: number, prev: number) => Math.abs(cur - prev) >= Math.max(MIN_COUNT_CHANGE, 3 * Math.sqrt(cur + prev));

const DIM_PHRASE: Record<ExplainDim, (k: string) => string> = {
  path: (k) => `on ${k}`,
  entry: (k) => `from visits that start on ${k}`,
  browser: (k) => `in ${k}`,
  os: (k) => `on ${k}`,
  device: (k) => `on ${k}`,
  country: (k) => `from ${k}`,
  release: (k) => `in release ${k}`,
  source: (k) => (k === '(direct)' ? 'from direct visits' : `from ${k}`),
  error: (k) => `from "${k.length > 80 ? k.slice(0, 79) + '…' : k}"`,
  request: (k) => `from ${k}`,
};
export const driverPhrase = (d: Pick<ExplainDriver, 'dim' | 'key'>) => DIM_PHRASE[d.dim](d.key);

const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;
const fmtNum = (n: number) => (Math.abs(n) >= 100 || Number.isInteger(n) ? Math.round(n).toLocaleString('en-US') : n.toFixed(1));
const fmtRate = (r: number) => `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`;

/** The one-paragraph explanation: how much it changed, what accounts for it, and when it started. */
export function summarize(e: Omit<Explanation, 'summary'>): string {
  const isRate = e.metric === 'goal';
  const show = (v: number) => (isRate ? fmtRate(v) : fmtNum(v));
  const up = e.current > e.previous;
  if (e.current === e.previous) return `${e.label} didn't change (${show(e.current)}).`;
  let how: string;
  if (e.previous === 0) how = `${e.label} went from none to ${show(e.current)}.`;
  else {
    const r = e.current / e.previous;
    const size = r >= 2 ? `up ${r.toFixed(1)}×` : r <= 0.5 ? `down ${Math.round((1 - r) * 100)}%` : `${up ? 'up' : 'down'} ${Math.round(Math.abs(r - 1) * 100)}%`;
    how = `${e.label} ${isRate ? 'is' : 'are'} ${size} (${show(e.current)} vs ${show(e.previous)} before).`;
  }
  if (!e.significant) return `${how} That's within the normal ups and downs for numbers this size.`;
  const parts = [how];
  const [a, b] = e.drivers;
  if (a) {
    const second = b && b.dim !== a.dim ? `, mostly ${driverPhrase(b)}` : '';
    if (isRate) parts.push(`The biggest ${up ? 'gain' : 'drop'} is ${driverPhrase(a)} (${fmtRate(a.rate!.previous)} → ${fmtRate(a.rate!.current)})${second}.`);
    else {
      const share = Math.min(100, Math.round(a.share * 100));
      parts.push(`${share}% of the ${up ? 'increase' : 'decrease'} is ${driverPhrase(a)}${a.before < 0.5 ? `, which was ${Math.round(a.before * 100)}% of the total before` : ''}${second}.`);
    }
  } else parts.push(`It's spread evenly: no single page, browser, device, country or release stands out.`);
  if (e.startedAt) {
    const rel = e.release;
    const mins = rel ? Math.round((Date.parse(e.startedAt) - Date.parse(rel.firstSeen)) / 60_000) : 0;
    const name = rel && (rel.kind === 'web' ? `release ${rel.version}` : `${rel.service} ${rel.version}`);
    parts.push(`It started around ${hhmm(e.startedAt)}${rel ? (mins >= 0 ? `, ${mins} minutes after ${name} was first seen` : `, ${-mins} minutes before ${name} was first seen`) : ''}.`);
  } else if (e.release) {
    const rel = e.release;
    parts.push(`${rel.kind === 'web' ? `Release ${rel.version}` : `${rel.service} ${rel.version}`} was first seen at ${hhmm(rel.firstSeen)}, in this period.`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------- queries

const TYPE_LABEL: Record<string, string> = { error: 'Errors', http_error: 'Failed requests', pageview: 'Pageviews', click: 'Clicks', custom: 'Custom events', vitals: 'Web Vitals samples' };

const typeOf = (where: Filter[]) => where.find((f) => f.field === 'type' && f.op === 'eq')?.value;

/** Dimensions of single events (SQL; NULL → '(none)'), plus the type-specific ones the metric's filters call for. */
function eventDims(where: Filter[]): Array<[ExplainDim, string]> {
  const dims: Array<[ExplainDim, string]> = [
    ['path', 'path'], ['browser', 'browser'], ['os', 'os'], ['device', 'device'], ['country', 'country'], ['release', RELEASE_SQL],
  ];
  const t = typeOf(where);
  if (t === 'error') dims.push(['error', 'left(error_message, 200)']);
  if (t === 'http_error') dims.push(['request', `concat_ws(' ', http_method, COALESCE(http_route, split_part(http_url, '?', 1)), CASE WHEN http_status = 0 THEN 'network error' ELSE http_status::VARCHAR END)`]);
  return dims;
}

interface Win { from: Date; to: Date }

function windows(p: Q): { cur: Win; base: Win } {
  const cur = parseRange(p);
  const span = cur.to.getTime() - cur.from.getTime();
  const base = p.baseFrom || p.baseTo
    ? parseRange({ from: p.baseFrom, to: p.baseTo ?? new Date(Date.parse(p.baseFrom!) + span).toISOString() })
    : { from: new Date(cur.from.getTime() - span), to: cur.from };
  if (base.from >= cur.from && base.to > cur.from) throw new HttpError(400, 'The baseline must come before the current window');
  return { cur, base };
}

/** Counts (events or distinct sessions) per segment in both windows, one scan. */
async function countSegments(pid: string, w: { cur: Win; base: Win }, p: Q, where: Filter[], sessions: boolean) {
  const all = { from: w.base.from, to: w.cur.to };
  const params: unknown[] = [pid, all.from, all.to, w.cur.from, w.base.to];
  const F = filtersFrom(p, 'events', params) + filterSql(where, 'events', params) + await suppressedSql(pid, params);
  const dims = eventDims(where);
  const cols = dims.map(([d, sql]) => `COALESCE((${sql})::VARCHAR, '(none)') AS ${d}`).join(', ');
  const val = (cond: string) => (sessions ? `count(DISTINCT CASE WHEN ${cond} THEN session_id END)::int` : `sum(CASE WHEN ${cond} THEN 1 ELSE 0 END)::int`);
  const c = val('cur'), b = val('NOT cur');
  const per = dims.map(([d]) => `(SELECT '${d}' AS dim, ${d} AS key, ${c} AS c, ${b} AS b FROM m GROUP BY ${d} ORDER BY abs(${c} - ${b}) DESC LIMIT ${PER_DIM})`);
  // only rows in one of the two windows (the baseline may end before the current window starts)
  const rows = await rawQuery<{ dim: string; key: string | null; c: number; b: number }>(pid, all,
    `WITH m AS MATERIALIZED (
       SELECT ts >= $4 AS cur, session_id, ${cols} FROM events
        WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND (ts >= $4 OR ts < $5)${F})
     SELECT 'total' AS dim, NULL AS key, ${c} AS c, ${b} AS b FROM m
     UNION ALL ${per.join('\n     UNION ALL ')}`,
    params,
  );
  const total = rows.find((r) => r.dim === 'total');
  return {
    cur: total?.c ?? 0, prev: total?.b ?? 0,
    segments: rows.filter((r) => r.dim !== 'total').map((r) => ({ dim: r.dim as ExplainDim, key: r.key ?? '(none)', current: r.c, previous: r.b })),
  };
}

/** Per-bucket values over both windows (gaps filled with zeros), for the change point and the chart. */
async function bucketSeries(pid: string, w: { cur: Win; base: Win }, p: Q, where: Filter[], sessions: boolean, bucket: number) {
  const params: unknown[] = [pid, w.base.from, w.cur.to, bucket];
  const F = filtersFrom(p, 'events', params) + filterSql(where, 'events', params) + await suppressedSql(pid, params);
  const rows = await rawQuery<{ t: Date; n: number }>(pid, { from: w.base.from, to: w.cur.to },
    `SELECT to_timestamp(floor(extract(epoch from ts) / $4::double) * $4::double) AS t, ${sessions ? 'count(DISTINCT session_id)' : 'count(*)'}::int AS n
       FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3${F} GROUP BY 1`,
    params,
  );
  const by = new Map(rows.map((r) => [r.t.getTime(), r.n]));
  const out: Array<{ t: number; value: number }> = [];
  const step = bucket * 1000;
  const start = Math.floor(w.base.from.getTime() / step) * step;
  for (let t = start; t < w.cur.to.getTime(); t += step) {
    // skip a gap between a custom baseline and the current window
    if (t >= w.base.to.getTime() && t + step <= w.cur.from.getTime()) continue;
    out.push({ t, value: by.get(t) ?? 0 });
  }
  return out;
}

/** Sessions and conversions per session segment in both windows (a session belongs to the window it started in). */
async function goalSegments(pid: string, w: { cur: Win; base: Win }, p: Q, goal: Filter[]) {
  const all = { from: w.base.from, to: w.cur.to };
  const params: unknown[] = [pid, all.from, all.to, w.cur.from, w.base.to];
  const F = filtersFrom(p, 'events', params);
  const hit = `COALESCE((${filterSql(goal, 'events', params).slice(' AND '.length)}), false)`;
  const dims: ExplainDim[] = ['entry', 'source', 'device', 'browser', 'os', 'country', 'release'];
  const seg = (d: ExplainDim) =>
    `(SELECT '${d}' AS dim, ${d} AS key, sum(cur::int)::int AS c, sum((NOT cur)::int)::int AS b,
             sum(CASE WHEN cur AND conv THEN 1 ELSE 0 END)::int AS cc, sum(CASE WHEN NOT cur AND conv THEN 1 ELSE 0 END)::int AS bc
        FROM s GROUP BY ${d} ORDER BY count(*) DESC LIMIT ${PER_DIM})`;
  return rawQuery<{ dim: string; key: string | null; c: number; b: number; cc: number; bc: number }>(pid, all,
    `WITH s AS MATERIALIZED (
       SELECT session_id, min(ts) >= $4 AS cur, bool_or(${hit}) AS conv,
              COALESCE((array_agg(path ORDER BY ts) FILTER (WHERE type = 'pageview' AND path IS NOT NULL))[1], '(none)') AS entry,
              COALESCE((array_agg(CASE WHEN referrer IS NULL OR split_part(referrer, '/', 3) = split_part(url, '/', 3) THEN '(direct)' ELSE split_part(referrer, '/', 3) END ORDER BY ts)
                FILTER (WHERE type = 'pageview'))[1], '(none)') AS source,
              COALESCE(max(device), '(none)') AS device, COALESCE(max(browser), '(none)') AS browser, COALESCE(max(os), '(none)') AS os,
              COALESCE(max(country), '(none)') AS country, COALESCE(max(${RELEASE_SQL}), '(none)') AS release
         FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND session_id IS NOT NULL${F}
        GROUP BY session_id HAVING min(ts) >= $4 OR min(ts) < $5)
     SELECT 'total' AS dim, NULL AS key, sum(cur::int)::int AS c, sum((NOT cur)::int)::int AS b,
            sum(CASE WHEN cur AND conv THEN 1 ELSE 0 END)::int AS cc, sum(CASE WHEN NOT cur AND conv THEN 1 ELSE 0 END)::int AS bc FROM s
     UNION ALL ${dims.map(seg).join('\n     UNION ALL ')}`,
    params,
  );
}

/** A release first seen around the change (30 min before to 10 min after), else during the current window. */
async function releaseNear(pid: string, startedAt: number | null, cur: Win): Promise<ReleaseMarker | null> {
  if (startedAt !== null) {
    const near = await releaseMarkers(pid, new Date(startedAt - 30 * 60_000), new Date(startedAt + 10 * 60_000));
    // the one closest before the change, else the first after it
    const before = near.filter((m) => Date.parse(m.firstSeen) <= startedAt);
    return before.length ? before[before.length - 1] : near[0] ?? null;
  }
  const during = await releaseMarkers(pid, cur.from, cur.to);
  return during.find((m) => m.kind === 'web') ?? during[0] ?? null;
}

/** GET /explain */
export async function explain(pid: string, p: Q): Promise<Explanation> {
  const metric = (p.metric ?? 'events') as ExplainMetric;
  if (!['events', 'sessions', 'goal'].includes(metric)) throw new HttpError(400, 'metric must be events, sessions or goal');
  const w = windows(p);
  const where = parseFilters(p.where);
  const bucket = pickBucket(w.cur);

  if (metric === 'goal') {
    if (!p.goalId) throw new HttpError(400, 'goalId is required for metric=goal');
    const goal = await findGoal(pid, p.goalId);
    const rows = await goalSegments(pid, w, p, goal.filters);
    const t = rows.find((r) => r.dim === 'total');
    const cs = t?.c ?? 0, bs = t?.b ?? 0, cc = t?.cc ?? 0, bc = t?.bc ?? 0;
    const rc = cs ? cc / cs : 0, rb = bs ? bc / bs : 0;
    const [cl, ch] = wilson(cc, cs), [bl, bh] = wilson(bc, bs);
    const segments = rows.filter((r) => r.dim !== 'total').map((r) => ({ dim: r.dim as ExplainDim, key: r.key ?? '(none)', current: r.c, previous: r.b, convCurrent: r.cc, convPrevious: r.bc }));
    const significant = cs >= MIN_SESSIONS && bs >= MIN_SESSIONS && (cl > bh || ch < bl);
    const drivers = significant ? rateDrivers(segments, { cur: cs, prev: bs, rateCur: rc, ratePrev: rb }) : [];
    const release = await releaseNear(pid, null, w.cur);
    const e: Omit<Explanation, 'summary'> = {
      metric, label: p.label || `${goal.name} conversion`, current: rc, previous: rb, ratio: rb ? rc / rb : null,
      significant, startedAt: null, release, drivers,
      bucketSeconds: bucket, series: [], baseFrom: w.base.from.toISOString(), from: w.cur.from.toISOString(),
    };
    return { ...e, summary: summarize(e) };
  }

  const sessions = metric === 'sessions';
  const [counts, series] = await Promise.all([countSegments(pid, w, p, where, sessions), bucketSeries(pid, w, p, where, sessions, bucket)]);
  const significant = countSignificant(counts.cur, counts.prev);
  const cp = significant ? changePoint(series.map((s) => s.value)) : null;
  // a change point only counts when it's in the current window and goes the same way as the overall change
  const startedAt = cp && series[cp.index].t >= w.cur.from.getTime() && (cp.after > cp.before) === (counts.cur > counts.prev) ? series[cp.index].t : null;
  const release = significant ? await releaseNear(pid, startedAt, w.cur) : null;
  const t = typeOf(where);
  const label = p.label || (sessions ? (where.length ? 'Sessions with a match' : 'Sessions') : (t && TYPE_LABEL[t]) || (where.length ? 'Matching events' : 'Events'));
  const e: Omit<Explanation, 'summary'> = {
    metric, label, current: counts.cur, previous: counts.prev, ratio: counts.prev ? counts.cur / counts.prev : null, significant,
    startedAt: startedAt !== null ? new Date(startedAt).toISOString() : null, release,
    drivers: significant ? countDrivers(counts.segments, counts.cur, counts.prev) : [],
    bucketSeconds: bucket, series: series.map((s) => ({ t: new Date(s.t).toISOString(), value: s.value })),
    baseFrom: w.base.from.toISOString(), from: w.cur.from.toISOString(),
  };
  return { ...e, summary: summarize(e) };
}
