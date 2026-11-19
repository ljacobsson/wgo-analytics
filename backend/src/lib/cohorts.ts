import type { RetentionCohort, RetentionPeriod, RetentionResponse } from '../contract';
import { findGoal } from './goals';
import { HttpError } from './http';
import { ROLLUP_RETENTION_DAYS } from './rollups';
import { rawQuery } from './store/duck';
import { firstDay } from './store/maintain';

/**
 * Retention cohorts over visitor_days (lib/visitors.ts): people grouped by the period they started in (first seen,
 * or first reached a goal), and the share of each group that came back in the periods after. Periods are UTC days,
 * ISO weeks (Monday) or calendar months. visitor_days hold 400 days, so ranges here may be that long.
 */

const DAY = 86_400_000;
const MAX_RANGE_MS = ROLLUP_RETENTION_DAYS * DAY;
const DEFAULT_RANGE_MS = 84 * DAY;
const MAX_COHORTS: Record<RetentionPeriod, number> = { day: 30, week: 26, month: 13 };
const MAX_SPLITS = 5;

// ---------------------------------------------------------------- periods (pure)

/** Start of the UTC day, ISO week (Monday 00:00) or calendar month containing `ms`. */
export function periodStart(ms: number, period: RetentionPeriod): number {
  const d = new Date(ms);
  if (period === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const day = Math.floor(ms / DAY) * DAY;
  if (period === 'day') return day;
  return day - ((d.getUTCDay() + 6) % 7) * DAY; // getUTCDay: 0 = Sunday
}

/** Start of the period `n` periods after (or before, n < 0) the period starting at `start`. */
export function addPeriods(start: number, period: RetentionPeriod, n: number): number {
  if (period === 'month') {
    const d = new Date(start);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
  }
  return start + n * (period === 'week' ? 7 : 1) * DAY;
}

// ---------------------------------------------------------------- matrix (pure)

/** k = -1: the cohort's size; k >= 0: people of the cohort active in period k after it. One row per split key. */
export interface MatrixRow { cohort: number; split: string; k: number; n: number }

const round = (x: number) => Math.round(x * 10_000) / 10_000;

/** Number of period columns a cohort has: period k counts once it is complete (period 0 always counts). */
function columns(cohort: number, period: RetentionPeriod, now: number): number {
  let n = 1;
  while (addPeriods(cohort, period, n + 1) <= now) n++;
  return n;
}

/** Size-weighted average per period over the cohorts old enough for it. */
function weighted(cohorts: Array<{ size: number; counts: number[] }>): number[] {
  const len = Math.max(0, ...cohorts.map((c) => c.counts.length));
  const out: number[] = [];
  for (let k = 0; k < len; k++) {
    let size = 0, count = 0;
    for (const c of cohorts) {
      if (c.counts.length > k) {
        size += c.size;
        count += c.counts[k];
      }
    }
    out.push(size ? round(count / size) : 0);
  }
  return out;
}

/** Builds the response matrix from aggregated rows: cohorts from `first` to `last` (period starts), as of `now`. */
export function buildMatrix(rows: MatrixRow[], o: { period: RetentionPeriod; first: number; last: number; now: number }) {
  const { period } = o;
  const sizes = new Map<string, number>(); // cohort|split -> size
  const counts = new Map<string, number>(); // cohort|split|k -> n
  const splitSizes = new Map<string, number>();
  for (const r of rows) {
    if (r.k < 0) {
      sizes.set(`${r.cohort}|${r.split}`, r.n);
      splitSizes.set(r.split, (splitSizes.get(r.split) ?? 0) + r.n);
    } else counts.set(`${r.cohort}|${r.split}|${r.k}`, r.n);
  }
  const splitKeys = [...splitSizes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);

  const cohortStarts: number[] = [];
  for (let c = o.first; c <= o.last; c = addPeriods(c, period, 1)) cohortStarts.push(c);

  const perSplit = (keys: string[]) => cohortStarts.map((c) => {
    const cols = columns(c, period, o.now);
    const size = keys.reduce((a, k) => a + (sizes.get(`${c}|${k}`) ?? 0), 0);
    const cnt = Array.from({ length: cols }, (_, k) => keys.reduce((a, s) => a + (counts.get(`${c}|${s}|${k}`) ?? 0), 0));
    return { start: c, size, counts: cnt };
  });

  const all = perSplit(splitKeys);
  const cohorts: RetentionCohort[] = all.map((c) => ({
    start: new Date(c.start).toISOString(), size: c.size, counts: c.counts, values: c.counts.map((n) => (c.size ? round(n / c.size) : 0)),
  }));
  const splits = splitKeys.length > 1 || (splitKeys.length === 1 && splitKeys[0] !== '')
    ? splitKeys.slice(0, MAX_SPLITS).map((key) => ({ key, size: splitSizes.get(key) ?? 0, average: weighted(perSplit([key])) }))
    : undefined;
  return { cohorts, average: weighted(all), splits };
}

// ---------------------------------------------------------------- endpoint

type Params = Record<string, string | undefined>;

function parseWindow(p: Params, now: number): { from: Date; to: Date } {
  const to = p.to ? new Date(p.to) : new Date(now);
  const from = p.from ? new Date(p.from) : new Date(to.getTime() - DEFAULT_RANGE_MS);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) throw new HttpError(400, 'Invalid from/to');
  if (from >= to) throw new HttpError(400, '`from` must be before `to`');
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new HttpError(400, `Range too large (max ${ROLLUP_RETENTION_DAYS} days)`);
  return { from, to };
}

const GOAL_RE = /^goal:(.+)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPLIT_SQL = {
  none: `''`,
  device: `coalesce(device, 'Unknown')`,
  country: `coalesce(country, 'Unknown')`,
  source: `CASE WHEN source IS NULL OR source = '' THEN '(direct)' ELSE source END`,
} as const;
type SplitBy = keyof typeof SPLIT_SQL;

/** SQL true when the visitor_days row reached the goal (goal ids are UUIDs kept as a JSON array of strings). */
const reached = (params: unknown[], goalId: string) => `strpos(goals::VARCHAR, '"' || $${params.push(goalId)} || '"') > 0`;

/** GET /retention?from&to&period&start&return&split */
export async function retention(pid: string, p: Params, now = Date.now()): Promise<RetentionResponse> {
  const period: RetentionPeriod = p.period === 'day' || p.period === 'month' ? p.period : p.period === undefined || p.period === 'week' ? 'week' : (() => { throw new HttpError(400, 'period must be day, week or month'); })();
  const start = p.start ?? 'first_seen';
  const ret = p.return ?? 'any';
  const split = (p.split ?? 'none') as SplitBy;
  if (!Object.hasOwn(SPLIT_SQL, split)) throw new HttpError(400, 'split must be none, device, country or source');
  const startGoal = GOAL_RE.exec(start)?.[1];
  const retGoal = GOAL_RE.exec(ret)?.[1];
  if (start !== 'first_seen' && !startGoal) throw new HttpError(400, 'start must be first_seen or goal:<id>');
  if (ret !== 'any' && !retGoal) throw new HttpError(400, 'return must be any or goal:<id>');
  for (const g of new Set([startGoal, retGoal])) {
    if (!g) continue;
    if (!UUID_RE.test(g)) throw new HttpError(404, 'Goal not found');
    await findGoal(pid, g); // 404 for an unknown goal
  }

  const { from, to } = parseWindow(p, now);
  const last = periodStart(Math.min(to.getTime(), now), period);
  const first = Math.max(periodStart(from.getTime(), period), addPeriods(last, period, -(MAX_COHORTS[period] - 1)));
  const unit = period; // date_trunc / date_diff unit names match

  const params: unknown[] = [pid, new Date(first), new Date(last)];
  const startCond = startGoal ? `AND ${reached(params, startGoal)}` : '';
  const retCond = retGoal ? `WHERE ${reached(params, retGoal)}` : '';
  const rows = await rawQuery<{ cohort: Date; split: string; k: number; n: number }>(pid, { from: new Date(now - MAX_RANGE_MS - 2 * DAY), to: new Date(now + DAY) },
    `WITH v AS (SELECT person, day, device, country, source, goals FROM visitor_days WHERE project_id = $1),
          f AS (SELECT person, date_trunc('${unit}', min(day)) AS cohort, arg_min(${SPLIT_SQL[split]}, day) AS split
                  FROM v WHERE true ${startCond} GROUP BY person),
          c AS (SELECT * FROM f WHERE cohort >= $2::TIMESTAMP AND cohort <= $3::TIMESTAMP),
          a AS (SELECT DISTINCT person, date_trunc('${unit}', day) AS ap FROM v ${retCond})
     SELECT cohort, split, -1 AS k, count(*)::int AS n FROM c GROUP BY 1, 2
     UNION ALL
     SELECT c.cohort, c.split, date_diff('${unit}', c.cohort, a.ap)::int AS k, count(*)::int AS n
       FROM c JOIN a ON a.person = c.person AND a.ap >= c.cohort GROUP BY 1, 2, 3`,
    params,
  );

  const m = buildMatrix(rows.map((r) => ({ cohort: new Date(r.cohort).getTime(), split: r.split, k: r.k, n: r.n })), { period, first, last, now });
  const since = await firstDay('visitor_days', pid);
  return { period, ...m, dataSince: since };
}
