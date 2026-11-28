import { buildInsert, query } from './db';
import { HUMAN_SQL, REASON_SQL } from './bots';
import { Hll } from './hll';
import { getJobState, setJobState } from './jobState';
import { rawQuery } from './store/duck';
import { firstDay } from './store/maintain';
import { suppressedSql } from './suppressions';

/**
 * Hourly rollups of the events table (Parquet, read through DuckDB), stored in DSQL: a few hundred rows per
 * project-hour at most, which keeps long ranges fast and cheap. Long dashboard ranges (and anything older than a project's raw
 * retention) read these instead of raw events, so their cost depends on the number of hours, not on traffic.
 *
 * A single watermark (`job_state` 'rollup') marks the end of the last rolled hour for all projects.
 * Readers take whole hours before it from the rollups and read raw events from it onwards.
 * Late events (offline SDK batches) are picked up by re-rolling the previous hour once; anything later
 * than that only shows in raw-backed views.
 */

export const HOUR = 3600_000;
/** How long hourly rollups are kept (raw retention is per project, see retention.ts). */
export const ROLLUP_RETENTION_DAYS = 400;
/** How far back a first run rolls up existing data (= the longest range the API accepts). */
const BACKFILL_MS = 92 * 24 * HOUR;
/** Sessions end after 30 min of inactivity (SDK default): a session active in an hour that started earlier has an event within this. */
const SESSION_LOOKBACK_MS = HOUR;
/** Keys kept per dimension and hour (long tails of paths or cities are dropped). */
const MAX_KEYS = 200;
/** Hours are complete a few minutes after they end (in-flight SDK batches). */
const SETTLE_MS = 5 * 60_000;
const STATE = 'rollup';

export const floorHour = (t: number) => Math.floor(t / HOUR) * HOUR;

export const BREAKDOWN_DIMS = ['browser', 'os', 'device', 'referrer', 'country', 'city'] as const;
export type BreakdownDim = (typeof BREAKDOWN_DIMS)[number];
/**
 * 'bot': key = detection reason, sessions = distinct bot sessions in the hour (the only non-human rows)
 * 'signal': key = spans | logs | metric_points, events = rows stored in the hour (runSignalCounts)
 */
export type RollupDim = 'type' | 'page' | 'bot' | 'signal' | BreakdownDim;
/** Key used when a session has no value for a dimension (matches the raw breakdown query). */
export const MISSING_KEY = (dim: BreakdownDim) => (dim === 'referrer' ? '(direct)' : 'Unknown');

// ---------------------------------------------------------------- job

interface SessionRow {
  session_id: string;
  anon_id: string | null;
  first: Date;
  last: Date;
  browser: string | null;
  os: string | null;
  device: string | null;
  country: string | null;
  city: string | null;
  referrer: string | null;
  pageviews: string;
}

/** Computes and upserts one project-hour. Idempotent: re-running it replaces the counts. */
export async function rollupHour(pid: string, hourMs: number): Promise<void> {
  const hour = new Date(hourMs);
  const end = new Date(hourMs + HOUR);
  const w = { from: new Date(hourMs - SESSION_LOOKBACK_MS), to: end };
  // suppressed errors (lib/suppressions.ts) stored before their rule existed don't count either
  const typeParams: unknown[] = [pid, hour, end];
  const S = await suppressedSql(pid, typeParams);
  const [types, pages, sessions, bots] = await Promise.all([
    rawQuery<{ key: string; n: string }>(pid, w,
      `SELECT type AS key, count(*) AS n FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND ${HUMAN_SQL}${S} GROUP BY 1`,
      typeParams,
    ),
    rawQuery<{ key: string; n: string; s: string }>(pid, w,
      `SELECT path AS key, count(*) AS n, count(DISTINCT session_id) AS s
         FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND ${HUMAN_SQL} AND type = 'pageview' AND path IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT ${MAX_KEYS}`,
      [pid, hour, end],
    ),
    // every session active in the hour; `first` tells whether it started in it. Session attributes are
    // constant within a session, so max() just picks the value. Referrer: external referrer of a pageview.
    rawQuery<SessionRow>(pid, w,
      `SELECT session_id, max(anon_id) AS anon_id, min(ts) AS first, max(ts) AS last,
              max(browser) AS browser, max(os) AS os, max(device) AS device, max(country) AS country,
              max(CASE WHEN city IS NULL THEN NULL ELSE city || ', ' || COALESCE(country, '?') END) AS city,
              max(CASE WHEN type = 'pageview' AND referrer IS NOT NULL AND split_part(referrer, '/', 3) <> split_part(url, '/', 3)
                       THEN NULLIF(split_part(referrer, '/', 3), '') END) AS referrer,
              sum(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END) AS pageviews
         FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND ${HUMAN_SQL} AND session_id IS NOT NULL
        GROUP BY session_id`,
      [pid, new Date(hourMs - SESSION_LOOKBACK_MS), end],
    ),
    // excluded traffic, so long ranges can say how many bot sessions they hide without scanning raw events
    rawQuery<{ key: string; s: string }>(pid, w,
      `SELECT ${REASON_SQL} AS key, count(DISTINCT session_id) AS s FROM events
        WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND NOT ${HUMAN_SQL} AND session_id IS NOT NULL GROUP BY 1`,
      [pid, hour, end],
    ),
  ]);
  if (!types.length && !bots.length) return;

  const rows: unknown[][] = [];
  for (const t of types) rows.push([pid, 'type', hour, t.key, Number(t.n), 0]);
  for (const p of pages) rows.push([pid, 'page', hour, p.key, Number(p.n), Number(p.s)]);
  for (const b of bots) rows.push([pid, 'bot', hour, b.key, 0, Number(b.s)]);

  const sessionHll = new Hll();
  const userHll = new Hll();
  const started = new Map<BreakdownDim, Map<string, number>>(BREAKDOWN_DIMS.map((d) => [d, new Map()]));
  for (const s of sessions) {
    if (s.last.getTime() < hourMs) continue; // only active before this hour
    sessionHll.add(s.session_id);
    if (s.anon_id) userHll.add(s.anon_id);
    if (s.first.getTime() < hourMs) continue; // started earlier: counted in the hour it started
    for (const dim of BREAKDOWN_DIMS) {
      // referrer: only sessions that had a pageview count, as in the raw breakdown
      if (dim === 'referrer' && Number(s.pageviews) === 0) continue;
      const key = s[dim] ?? MISSING_KEY(dim);
      const m = started.get(dim)!;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
  }
  for (const [dim, counts] of started) {
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_KEYS);
    for (const [key, n] of top) rows.push([pid, dim, hour, key, 0, n]);
  }

  for (let i = 0; i < rows.length; i += 500) {
    const { sql, params } = buildInsert('rollups', ['project_id', 'dim', 'hour', 'key', 'events', 'sessions'], rows.slice(i, i + 500), {},
      'ON CONFLICT (project_id, dim, hour, key) DO UPDATE SET events = EXCLUDED.events, sessions = EXCLUDED.sessions');
    await query(sql, params);
  }
  // a recount (runRerolls) can leave keys out that an earlier count had, e.g. an hour of only development traffic
  const SEP = '\u001f';
  const kept = rows.map((r) => `${r[1]}${SEP}${r[3]}`);
  await query(`DELETE FROM rollups WHERE project_id = $1 AND hour = $2 AND NOT (dim || $4 || key = ANY($3::text[]))`, [pid, hour, kept, SEP]);
  await query(
    `INSERT INTO rollup_sketches (project_id, hour, sessions, users) VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, hour) DO UPDATE SET sessions = EXCLUDED.sessions, users = EXCLUDED.users`,
    [pid, hour, sessionHll.toBuffer(), userHll.toBuffer()],
  );
}

/** Runs `fn` over `items` with at most `n` in flight. */
export async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/**
 * Rolls up every complete hour since the watermark (a first run backfills up to 92 days), until `deadline`.
 * Returns the new watermark and whether it reached the latest complete hour.
 */
export async function runRollups(deadline: number, now = Date.now()): Promise<{ until: number; caughtUp: boolean; hours: number }> {
  const target = floorHour(now - SETTLE_MS);
  const ids = await query<{ id: string }>('SELECT id FROM projects');
  // the first day with stored events (the day's start: rolling up empty hours is cheap)
  const projects = await Promise.all(ids.map(async ({ id }) => {
    const day = await firstDay('events', id);
    return { id, first: day ? new Date(day) : null };
  }));
  const saved = await getJobState(STATE);
  // first run: start at the oldest stored event, at most BACKFILL_MS back
  const oldest = Math.min(target, ...projects.map((p) => p.first?.getTime() ?? target));
  let wm = Math.max(saved?.getTime() ?? floorHour(oldest), target - BACKFILL_MS);
  let hours = 0;
  while (wm < target && Date.now() < deadline) {
    // in steady state, roll the previous hour again too: it may have received late events since
    const catchingUp = target - wm > HOUR;
    const todo = catchingUp || !saved ? [wm] : [wm - HOUR, wm];
    const active = projects.filter((p) => p.first && p.first.getTime() < wm + HOUR);
    await pool(active, 4, async (p) => {
      for (const h of todo) await rollupHour(p.id, h);
    });
    wm += HOUR;
    hours++;
    await setJobState(STATE, new Date(wm));
  }
  return { until: wm, caughtUp: wm >= target, hours };
}

// ---------------------------------------------------------------- OpenTelemetry counts

/** Raw tables counted per hour as dim 'signal' rows, with the column that places a row in time. */
export const SIGNAL_TABLES = { spans: 'start_time', logs: 'ts', metric_points: 'ts' } as const;
export type SignalTable = keyof typeof SIGNAL_TABLES;
const SIGNAL_STATE = 'rollup:signals';
/** Hours counted per query (one project and table): a first run backfills a day at a time. */
const SIGNAL_STEP = 24 * HOUR;

/**
 * Counts the spans, log records and metric points each project stored per hour, for the Costs page: rollup rows
 * with dim 'signal'. Their own watermark (`job_state` 'rollup:signals'), so a first run backfills what raw data is
 * still stored (up to 92 days) without touching the event rollups. Each pass counts the hour before the watermark
 * again, for late batches. Returns the new watermark and whether it reached the latest complete hour.
 */
export async function runSignalCounts(deadline: number, now = Date.now()): Promise<{ until: number; caughtUp: boolean }> {
  const target = floorHour(now - SETTLE_MS);
  const ids = await query<{ id: string }>('SELECT id FROM projects');
  const tables = Object.keys(SIGNAL_TABLES) as SignalTable[];
  // each project's tables that have data, from their first stored day
  const stored = (await Promise.all(ids.flatMap(({ id }) => tables.map(async (table) => {
    const day = await firstDay(table, id);
    return day ? { pid: id, table, first: new Date(day).getTime() } : null;
  })))).filter((x) => x !== null);
  const saved = await getJobState(SIGNAL_STATE);
  const oldest = Math.min(target, ...stored.map((x) => x.first));
  let wm = Math.max(saved?.getTime() ?? floorHour(oldest), target - BACKFILL_MS);
  while (wm < target && Date.now() < deadline) {
    const w = { from: new Date(wm - HOUR), to: new Date(Math.min(target, wm + SIGNAL_STEP)) };
    await pool(stored.filter((x) => x.first < w.to.getTime()), 4, async ({ pid, table }) => {
      const col = SIGNAL_TABLES[table];
      const counts = await rawQuery<{ h: number; n: string }>(pid, w,
        `SELECT (floor(extract(epoch from ${col}) / 3600) * 3600000)::BIGINT AS h, count(*) AS n FROM ${table}
          WHERE project_id = $1 AND ${col} >= $2 AND ${col} < $3 GROUP BY 1`,
        [pid, w.from, w.to],
      );
      if (!counts.length) return;
      const { sql, params } = buildInsert('rollups', ['project_id', 'dim', 'hour', 'key', 'events', 'sessions'],
        counts.map((c) => [pid, 'signal', new Date(Number(c.h)), table, Number(c.n), 0]), {},
        'ON CONFLICT (project_id, dim, hour, key) DO UPDATE SET events = EXCLUDED.events');
      await query(sql, params);
    });
    wm = w.to.getTime();
    await setJobState(SIGNAL_STATE, new Date(wm));
  }
  return { until: wm, caughtUp: wm >= target };
}

// ---------------------------------------------------------------- readers

let wmCache: { value: number | null; exp: number } | null = null;
/** End of the last rolled hour (cached briefly per container). */
export async function watermark(): Promise<number | null> {
  if (wmCache && wmCache.exp > Date.now()) return wmCache.value;
  const at = await getJobState(STATE);
  wmCache = { value: at?.getTime() ?? null, exp: Date.now() + 60_000 };
  return wmCache.value;
}
export const resetWatermarkCache = () => { wmCache = null; };

export interface Span { from: Date; to: Date }
/** Which part of [from, to) comes from rollups (whole hours) and which from raw events. */
export interface Plan { roll: Span; raw: Span | null }

/**
 * Split a range: whole hours from floor(from) up to the watermark from rollups, the rest raw.
 * null when nothing in the range has been rolled up yet (callers then read raw events only).
 */
export async function planRange(from: Date, to: Date): Promise<Plan | null> {
  const wm = await watermark();
  if (wm === null) return null;
  const start = floorHour(from.getTime());
  const rollEnd = Math.min(wm, floorHour(to.getTime()));
  if (rollEnd <= start) return null;
  return {
    roll: { from: new Date(start), to: new Date(rollEnd) },
    raw: rollEnd < to.getTime() ? { from: new Date(rollEnd), to } : null,
  };
}

const HOUR_SQL = `to_timestamp(floor(extract(epoch from ts) / 3600) * 3600)`;

/** Event counts per hour and type. */
export async function hourlyTypes(pid: string, plan: Plan): Promise<Array<{ hour: number; type: string; n: number }>> {
  const [rolled, raw] = await Promise.all([
    query<{ hour: Date; key: string; n: string }>(
      `SELECT hour, key, events AS n FROM rollups WHERE project_id = $1 AND dim = 'type' AND hour >= $2 AND hour < $3`,
      [pid, plan.roll.from, plan.roll.to],
    ),
    plan.raw
      ? rawQuery<{ hour: Date; key: string; n: string }>(pid, plan.raw,
          `SELECT ${HOUR_SQL} AS hour, type AS key, count(*) AS n FROM events
            WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND ${HUMAN_SQL} GROUP BY 1, 2`,
          [pid, plan.raw.from, plan.raw.to],
        )
      : Promise.resolve([]),
  ]);
  return [...rolled, ...raw].map((r) => ({ hour: r.hour.getTime(), type: r.key, n: Number(r.n) }));
}

/** Session and user sketches per hour. */
export async function hourlySketches(pid: string, plan: Plan): Promise<Array<{ hour: number; sessions: Hll; users: Hll }>> {
  const [rolled, raw] = await Promise.all([
    query<{ hour: Date; sessions: Buffer; users: Buffer }>(
      `SELECT hour, sessions, users FROM rollup_sketches WHERE project_id = $1 AND hour >= $2 AND hour < $3`,
      [pid, plan.roll.from, plan.roll.to],
    ),
    plan.raw
      ? rawQuery<{ hour: Date; session_id: string | null; anon_id: string | null }>(pid, plan.raw,
          `SELECT ${HOUR_SQL} AS hour, session_id, anon_id FROM events
            WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND ${HUMAN_SQL} GROUP BY 1, 2, 3`,
          [pid, plan.raw.from, plan.raw.to],
        )
      : Promise.resolve([]),
  ]);
  const out = rolled.map((r) => ({ hour: r.hour.getTime(), sessions: Hll.from(r.sessions), users: Hll.from(r.users) }));
  const byHour = new Map<number, { hour: number; sessions: Hll; users: Hll }>();
  for (const r of raw) {
    const h = r.hour.getTime();
    let s = byHour.get(h);
    if (!s) byHour.set(h, (s = { hour: h, sessions: new Hll(), users: new Hll() }));
    if (r.session_id) s.sessions.add(r.session_id);
    if (r.anon_id) s.users.add(r.anon_id);
  }
  return out.concat([...byHour.values()]);
}

/** Summed rollup rows of one dimension over the rolled part of a plan, biggest first. */
export async function rolledDim(pid: string, dim: RollupDim, span: Span, order: 'events' | 'sessions', limit: number): Promise<Array<{ key: string; events: number; sessions: number }>> {
  const rows = await query<{ key: string; events: string; sessions: string }>(
    `SELECT key, sum(events) AS events, sum(sessions) AS sessions FROM rollups
      WHERE project_id = $1 AND dim = $2 AND hour >= $3 AND hour < $4
      GROUP BY key ORDER BY ${order === 'events' ? 2 : 3} DESC LIMIT $5`,
    [pid, dim, span.from, span.to, limit],
  );
  return rows.map((r) => ({ key: r.key, events: Number(r.events), sessions: Number(r.sessions) }));
}

/** Merge keyed rows from rollups and raw events, then keep the top `limit` by `order`. */
export function mergeKeyed<T extends { key: string; events: number; sessions: number }>(a: T[], b: T[], order: 'events' | 'sessions', limit: number): Array<{ key: string; events: number; sessions: number }> {
  const m = new Map<string, { key: string; events: number; sessions: number }>();
  for (const r of [...a, ...b]) {
    const cur = m.get(r.key);
    if (cur) {
      cur.events += r.events;
      cur.sessions += r.sessions;
    } else m.set(r.key, { key: r.key, events: r.events, sessions: r.sessions });
  }
  return [...m.values()].sort((x, y) => y[order] - x[order]).slice(0, limit);
}

// ---------------------------------------------------------------- re-rolls

/** job_state names `reroll:<project id>`: that project's rollups must be recomputed (e.g. error suppression changed). */
export const REROLL_PREFIX = 'reroll:';
/** job_state names `reroll-dev:<project id>`: recount the project's hours holding development traffic not flagged at ingest. */
export const REROLL_DEV_PREFIX = 'reroll-dev:';
/** Set once every project has been marked for REROLL_DEV_PREFIX (events stored before development traffic was flagged). */
const DEV_REROLLS_MARKED = 'dev-traffic-rerolls-marked';

/** Hours a mark recounts: those with errors (suppression rules), or with unflagged development traffic. */
const REROLL_HOURS: Array<[prefix: string, where: string]> = [
  [REROLL_PREFIX, `type = 'error'`],
  [REROLL_DEV_PREFIX, `bot IS NULL AND NOT ${HUMAN_SQL}`],
];

/** Once per install: mark every project, so hours rolled up before development traffic was left out are recounted. */
async function markDevRerollsOnce(): Promise<void> {
  if (await getJobState(DEV_REROLLS_MARKED)) return;
  for (const { id } of await query<{ id: string }>('SELECT id FROM projects')) {
    await query('INSERT INTO job_state (name, at) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [REROLL_DEV_PREFIX + id, new Date(0)]);
  }
  await setJobState(DEV_REROLLS_MARKED, new Date());
}

/**
 * Recomputes the rolled hours of marked projects that a change affects, still in raw retention: hours with errors
 * when an error suppression rule was added or deleted, hours with development traffic stored before it was flagged.
 * `at` is the last hour done (epoch 0: not started), so a run that hits its deadline continues next time. Hours older
 * than raw retention keep their counts.
 */
export async function runRerolls(deadline: number, rolledUntil: number, now = Date.now()): Promise<{ projects: number; hours: number }> {
  await markDevRerollsOnce();
  const marks = await query<{ name: string; at: Date }>(
    `SELECT name, at FROM job_state WHERE name LIKE '${REROLL_PREFIX}%' OR name LIKE '${REROLL_DEV_PREFIX}%' ORDER BY name`);
  const projects = new Set(marks.map((m) => m.name.slice(m.name.indexOf(':') + 1))).size;
  let hours = 0;
  for (const m of marks) {
    const [prefix, where] = REROLL_HOURS.find(([p]) => m.name.startsWith(p))!;
    const pid = m.name.slice(prefix.length);
    const { projectRetention } = await import('./retention');
    const from = Math.max(m.at.getTime() + HOUR, floorHour(now - (await projectRetention(pid)) * 24 * HOUR));
    let last = m.at;
    if (from < rolledUntil) {
      const todo = await rawQuery<{ h: number }>(pid, { from: new Date(from), to: new Date(rolledUntil) },
        `SELECT DISTINCT (floor(extract(epoch from ts) / 3600) * 3600000)::BIGINT AS h FROM events
          WHERE project_id = $1 AND ${where} AND ts >= $2 AND ts < $3 ORDER BY 1`,
        [pid, new Date(from), new Date(rolledUntil)],
      );
      for (const { h } of todo) {
        if (Date.now() > deadline) {
          await query('UPDATE job_state SET at = $2 WHERE name = $1 AND at = $3', [m.name, last, m.at]);
          return { projects, hours };
        }
        await rollupHour(pid, Number(h));
        last = new Date(Number(h));
        hours++;
      }
    }
    // done, unless the project was marked again meanwhile (its `at` was reset)
    await query('DELETE FROM job_state WHERE name = $1 AND at = $2', [m.name, m.at]);
  }
  return { projects, hours };
}
