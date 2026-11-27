import type { DriverDim, DriverRow, Filter, FunnelStepResult, GoalFunnel, GoalStep, JourneyRow } from '../contract';
import { parseRange } from './analytics';
import { filterSql, filtersFrom } from './filters';
import { findGoal, goalSteps } from './goals';
import { HttpError } from './http';
import { rawQuery } from './store/duck';

/**
 * How sessions reach a goal: the ordered funnel through the goal's steps, the segments (entry page, pages viewed,
 * source, device, errors hit, …) that convert clearly better or worse than average, and the most common journeys.
 * Counted over raw events, like /conversions. Two statements: one for the ordered steps, one for everything that
 * needs a row per session.
 */

export const DRIVER_DIMS: DriverDim[] = ['entry', 'page', 'source', 'device', 'browser', 'country', 'error'];
/** Segments smaller than this are too noisy to call better or worse. */
export const MIN_SESSIONS = 20;
const RANKED = 8;
const PER_DIM = 25;
const JOURNEYS = 15;
const JOURNEY_PAGES = 3;
const EXITS = 5;

/** 95% Wilson score interval of c successes out of n. */
export function wilson(c: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 1];
  const p = c / n, z2 = z * z, d = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export function driverRow(dim: DriverDim, key: string, sessions: number, converted: number, baseline: number, at: string | null = null): DriverRow {
  const rate = sessions ? converted / sessions : 0;
  const [low, high] = wilson(converted, sessions);
  return { dim, key, at, sessions, converted, rate, baseline, lift: baseline > 0 ? rate / baseline : null, low, high, impact: converted - sessions * baseline };
}

/**
 * An error compared with the other sessions that viewed the page it happened on: only sessions that get that far can
 * hit it, so against the overall rate an error deep in the funnel would look harmless. Falls back to the overall rate
 * when the page isn't among the counted ones.
 */
export function errorRow(key: string, at: string | null, sessions: number, converted: number, pages: Map<string, DriverRow>, overall: number): DriverRow {
  const page = at != null ? pages.get(at) : undefined;
  const others = page ? page.sessions - sessions : 0;
  const baseline = page && others > 0 ? Math.max(0, page.converted - converted) / others : overall;
  return driverRow('error', key, sessions, converted, Math.min(1, baseline), at);
}

/**
 * Segments that convert clearly better (best) or worse (worst) than their baseline: the 95% interval lies entirely
 * above or below it. Sorted by how many conversions they add or miss against it, so a large segment with a real
 * effect outranks a tiny one at 100%. Errors only count as troublesome.
 */
export function rankDrivers(rows: DriverRow[], limit = RANKED): { best: DriverRow[]; worst: DriverRow[] } {
  const big = rows.filter((r) => r.sessions >= MIN_SESSIONS);
  return {
    best: big.filter((r) => r.dim !== 'error' && r.low > r.baseline).sort((a, b) => b.impact - a.impact).slice(0, limit),
    worst: big.filter((r) => r.high < r.baseline).sort((a, b) => a.impact - b.impact).slice(0, limit),
  };
}

/** A session's first pages with repeats (reloads, SPA re-renders) collapsed, cut to `max`. */
export function collapseJourney(pages: string[], max = JOURNEY_PAGES): string[] {
  const out: string[] = [];
  for (const p of pages) {
    if (out[out.length - 1] !== p) out.push(p);
    if (out.length === max) break;
  }
  return out;
}

/** Groups raw page arrays by their collapsed journey. */
export function mergeJourneys(rows: Array<{ pages: string[]; sessions: number; converted: number }>, limit = JOURNEYS): JourneyRow[] {
  const by = new Map<string, JourneyRow>();
  for (const r of rows) {
    const pages = collapseJourney(r.pages);
    if (!pages.length) continue;
    const k = pages.join('\u0000');
    const cur = by.get(k) ?? { pages, sessions: 0, converted: 0, rate: 0, low: 0, high: 1 };
    cur.sessions += r.sessions;
    cur.converted += r.converted;
    by.set(k, cur);
  }
  return [...by.values()]
    .map((j) => {
      const [low, high] = wilson(j.converted, j.sessions);
      return { ...j, rate: j.sessions ? j.converted / j.sessions : 0, low, high };
    })
    .sort((a, b) => b.sessions - a.sessions || b.converted - a.converted)
    .slice(0, limit);
}

/** `steps` query param: unsaved steps to preview in place of the goal's own. */
function previewSteps(raw: string | undefined): GoalStep[] | null {
  if (raw === undefined) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new HttpError(400, 'steps must be a JSON array'); }
  return goalSteps(v);
}

/** An error event as one line (NULL for other events): its message, or "POST /api/checkout 502" for a failed request. */
export const ERROR_KEY = `CASE WHEN type = 'error' THEN left(error_message, 200)
                   WHEN type = 'http_error' THEN concat_ws(' ', http_method, COALESCE(http_route, split_part(http_url, '?', 1)), http_status::text)
              END`;

/** A filter list as one SQL boolean (never NULL), its values bound into `params`. */
const condition = (filters: Filter[], params: unknown[]) => `COALESCE((${filterSql(filters, 'events', params).slice(' AND '.length)}), false)`;

const RANGE = `project_id = $1 AND ts >= $2 AND ts < $3 AND session_id IS NOT NULL`;

/** Statement A: sessions reaching each step in order, the median time from the step before, and where the rest left. */
async function orderedSteps(pid: string, r: { from: Date; to: Date }, p: Record<string, string | undefined>, all: Array<{ name: string; filters: Filter[] }>) {
  const params: unknown[] = [pid, r.from, r.to];
  const F = filtersFrom(p, 'events', params);
  const ks = all.map((s, i) => `${condition(s.filters, params)} AS k${i}`).join(', ');
  const any = all.map((_, i) => `k${i}`).join(' OR ');
  const ctes = [
    `m AS (SELECT * FROM (SELECT session_id, ts, ${ks} FROM events WHERE ${RANGE}${F}) x WHERE ${any})`,
    `t0 AS (SELECT session_id, min(ts) AS t FROM m WHERE k0 GROUP BY session_id)`,
  ];
  for (let i = 1; i < all.length; i++) {
    ctes.push(`t${i} AS (SELECT m.session_id, min(m.ts) AS t, max(p.t) AS prev FROM m JOIN t${i - 1} p ON p.session_id = m.session_id
                 WHERE m.k${i} AND m.ts >= p.t GROUP BY m.session_id)`);
  }
  const selects = all.map((_, i) => i === 0
    ? `SELECT 'step' AS kind, 0 AS i, NULL::text AS key, count(*)::int AS n, NULL::float8 AS med FROM t0`
    : `SELECT 'step', ${i}, NULL, count(*)::int, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t - prev)::float8) FROM t${i}`);
  if (all.length > 1) {
    // the last page of every session that got somewhere in the funnel
    ctes.push(`lastp AS (SELECT session_id, (array_agg(path ORDER BY ts DESC))[1] AS path FROM events
                WHERE ${RANGE} AND type = 'pageview'${F} AND session_id IN (SELECT session_id FROM t0) GROUP BY session_id)`);
    for (let i = 0; i < all.length - 1; i++) {
      selects.push(`(SELECT 'exit', ${i}, COALESCE(l.path, '(no pageview)'), count(*)::int, NULL FROM t${i} a
                      LEFT JOIN t${i + 1} b ON b.session_id = a.session_id LEFT JOIN lastp l ON l.session_id = a.session_id
                     WHERE b.session_id IS NULL GROUP BY 3 ORDER BY 4 DESC LIMIT ${EXITS})`);
    }
  }
  const rows = await rawQuery<{ kind: 'step' | 'exit'; i: number; key: string | null; n: number; med: number | null }>(pid, r,
    `WITH ${ctes.join(',\n')}\n${selects.join('\nUNION ALL ')}`,
    params,
  );
  const out: FunnelStepResult[] = all.map((s) => ({ name: s.name, filters: s.filters, sessions: 0, medianSeconds: null, exits: [] }));
  for (const row of rows) {
    const step = out[row.i];
    if (row.kind === 'step') Object.assign(step, { sessions: row.n, medianSeconds: row.med == null ? null : Number(row.med) });
    else step.exits.push({ key: row.key ?? '(no pageview)', sessions: row.n });
  }
  for (const s of out) s.exits.sort((a, b) => b.sessions - a.sessions);
  return out;
}

type SessionRow = { dim: DriverDim | 'total' | 'journey'; key: string | null; sessions: number; converted: number; pages: string[] | null; at: string | null };

/** Statement B: one row per session (entry page, source, device, …), then sessions and conversions per segment. */
async function sessionSegments(pid: string, r: { from: Date; to: Date }, p: Record<string, string | undefined>, goal: Filter[]) {
  const params: unknown[] = [pid, r.from, r.to];
  const F = filtersFrom(p, 'events', params);
  const hit = condition(goal, params);
  const seg = (dim: DriverDim, key: string) =>
    `(SELECT '${dim}', ${key}, count(*)::int, count(goal_at)::int, NULL, NULL FROM s GROUP BY 2 ORDER BY 3 DESC LIMIT 100)`;
  // pages viewed and errors hit before converting (for sessions that never convert: all of them); errors per page
  const before = (dim: DriverDim, key: string, at: string, where: string) =>
    `(SELECT '${dim}', ${key}, count(DISTINCT session_id)::int, count(DISTINCT CASE WHEN goal_at IS NOT NULL THEN session_id END)::int, NULL, ${at}
        FROM e WHERE ${where} AND (goal_at IS NULL OR ts < goal_at) GROUP BY 2, 6 ORDER BY 3 DESC LIMIT 100)`;
  return rawQuery<SessionRow>(pid, r,
    `WITH ev AS (
       SELECT session_id, ts, type, path, device, browser, country,
              -- external referrer host of a pageview ('' = direct; SPA navigations carry the app's own URL)
              CASE WHEN type = 'pageview' THEN
                CASE WHEN referrer IS NULL OR split_part(referrer, '/', 3) = split_part(url, '/', 3) THEN '' ELSE split_part(referrer, '/', 3) END
              END AS ref,
              ${ERROR_KEY} AS err,
              ${hit} AS hit
         FROM events WHERE ${RANGE}${F}),
     g AS (SELECT session_id, min(ts) AS goal_at FROM ev WHERE hit GROUP BY session_id),
     e AS (SELECT ev.*, g.goal_at FROM ev LEFT JOIN g ON g.session_id = ev.session_id),
     s AS (
       SELECT session_id, max(goal_at) AS goal_at,
              (array_agg(path ORDER BY ts) FILTER (WHERE type = 'pageview' AND path IS NOT NULL))[1] AS entry,
              (array_agg(ref ORDER BY ts) FILTER (WHERE ref IS NOT NULL))[1] AS source,
              max(device) AS device, max(browser) AS browser, max(country) AS country,
              (array_agg(path ORDER BY ts) FILTER (WHERE type = 'pageview' AND path IS NOT NULL AND (goal_at IS NULL OR ts <= goal_at)))[1:8] AS pages
         FROM e GROUP BY session_id)
     SELECT 'total' AS dim, NULL::text AS key, count(*)::int AS sessions, count(goal_at)::int AS converted, NULL::text[] AS pages, NULL::text AS at FROM s
     UNION ALL ${seg('entry', `COALESCE(entry, '(no pageview)')`)}
     UNION ALL ${seg('source', `CASE WHEN source IS NULL THEN '(no pageview)' WHEN source = '' THEN '(direct)' ELSE source END`)}
     UNION ALL ${seg('device', `COALESCE(device, 'Unknown')`)}
     UNION ALL ${seg('browser', `COALESCE(browser, 'Unknown')`)}
     UNION ALL ${seg('country', `COALESCE(country, 'Unknown')`)}
     UNION ALL ${before('page', 'path', 'NULL', `type = 'pageview' AND path IS NOT NULL`)}
     UNION ALL ${before('error', 'err', 'path', 'err IS NOT NULL')}
     UNION ALL (SELECT 'journey', NULL, count(*)::int, count(goal_at)::int, pages, NULL FROM s WHERE cardinality(pages) > 0
                 GROUP BY pages ORDER BY 3 DESC LIMIT 1000)`,
    params,
  );
}

/** GET /goals/{id}/funnel */
export async function goalFunnel(pid: string, goalId: string, p: Record<string, string | undefined>): Promise<GoalFunnel> {
  const r = parseRange(p);
  const goal = await findGoal(pid, goalId);
  const steps = previewSteps(p.steps) ?? goal.steps;
  const all = [...steps, { name: goal.name, filters: goal.filters }];

  const [ordered, rows] = await Promise.all([orderedSteps(pid, r, p, all), sessionSegments(pid, r, p, goal.filters)]);

  const total = rows.find((x) => x.dim === 'total');
  const sessions = total?.sessions ?? 0, converted = total?.converted ?? 0;
  const overall = sessions ? converted / sessions : 0;
  const dims = Object.fromEntries(DRIVER_DIMS.map((d) => [d, [] as DriverRow[]])) as Record<DriverDim, DriverRow[]>;
  const journeys: Array<{ pages: string[]; sessions: number; converted: number }> = [];
  for (const x of rows) {
    if (x.dim === 'journey') journeys.push({ pages: x.pages ?? [], sessions: x.sessions, converted: x.converted });
    else if (x.dim !== 'total' && x.dim !== 'error') dims[x.dim].push(driverRow(x.dim, x.key ?? '', x.sessions, x.converted, overall));
  }
  const pages = new Map(dims.page.map((r) => [r.key, r]));
  for (const x of rows) if (x.dim === 'error') dims.error.push(errorRow(x.key ?? '', x.at, x.sessions, x.converted, pages, overall));
  const { best, worst } = rankDrivers(DRIVER_DIMS.flatMap((d) => dims[d]));
  for (const d of DRIVER_DIMS) dims[d] = dims[d].sort((a, b) => b.sessions - a.sessions).slice(0, PER_DIM);

  return {
    goal: { id: goal.id, name: goal.name, filters: goal.filters },
    sessions, converted,
    steps: ordered,
    best, worst, dims,
    journeys: mergeJourneys(journeys),
  };
}
