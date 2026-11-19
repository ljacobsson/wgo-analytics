import { query } from './db';
import { listGoals, matchedEvents } from './goals';
import { getJobState, setJobState } from './jobState';
import { pool, ROLLUP_RETENTION_DAYS } from './rollups';
import { forgetFileLists } from './store/cache';
import { rawQuery } from './store/duck';
import { location } from './store/files';
import { firstDay } from './store/maintain';
import { dayOf, dayPrefix, floorDay } from './store/tables';
import { writeRows } from './store/write';

/**
 * visitor_days: one row per visitor and UTC day (bots left out), kept ROLLUP_RETENTION_DAYS. Retention cohorts need far
 * more history than raw events, and this table is a small fraction of their size. Built from the events of each
 * complete day by the maintenance job; `person` is the resolved user id, else the anonymous id.
 *
 * Watermark (`job_state` 'visitors'): the end of the last processed UTC day. A day is processed once the hourly rollups
 * are an hour past its end (the same late-event window the rollups use). Raw events of a day are never deleted before
 * it is processed (lib/retention.ts).
 */
const STATE = 'visitors';
const DAY = 86_400_000;
/** Rows per written file: a very busy day is split instead of held in one Parquet buffer. */
const FILE_ROWS = 100_000;

interface DayRow {
  person: string;
  anon_id: string | null;
  user_id: string | null;
  sessions: number;
  events: number;
  device: string | null;
  country: string | null;
  source: string | null;
  gi: Array<number | bigint> | null;
}

/**
 * (Re)builds one project-day. Idempotent: the new files are written first, then the files that were there before are
 * deleted, so readers always see the day (a reader that raced the swap may briefly see both and dedupes on the key).
 */
export async function buildVisitorDay(pid: string, day: string): Promise<number> {
  const goals = await listGoals(pid);
  const from = new Date(day);
  const to = new Date(from.getTime() + DAY);
  const params: unknown[] = [pid, from, to];
  const g = goals.length
    ? `, g AS (SELECT coalesce(user_id, anon_id) AS person, list(DISTINCT goal.i) AS gi ${matchedEvents(goals, params, ' AND bot IS NULL')} GROUP BY 1)`
    : '';
  const rows = await rawQuery<DayRow>(pid, { from, to },
    `WITH ev AS (
       SELECT ts, session_id, anon_id, user_id, device, country, type, coalesce(user_id, anon_id) AS person,
              -- external referrer host of a pageview ('' = direct; SPA navigations carry the app's own URL)
              CASE WHEN type = 'pageview' THEN
                CASE WHEN referrer IS NULL OR split_part(referrer, '/', 3) = split_part(url, '/', 3) THEN '' ELSE split_part(referrer, '/', 3) END
              END AS ref
         FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND bot IS NULL AND coalesce(user_id, anon_id) IS NOT NULL),
     b AS (
       SELECT person, max(anon_id) AS anon_id, max(user_id) AS user_id, count(DISTINCT session_id)::int AS sessions, count(*)::int AS events,
              (array_agg(device ORDER BY ts) FILTER (WHERE device IS NOT NULL))[1] AS device,
              (array_agg(country ORDER BY ts) FILTER (WHERE country IS NOT NULL))[1] AS country,
              coalesce((array_agg(ref ORDER BY ts) FILTER (WHERE ref IS NOT NULL))[1], '') AS source
         FROM ev GROUP BY person)${g}
     SELECT b.*${goals.length ? ', g.gi' : ', NULL AS gi'} FROM b${goals.length ? ' LEFT JOIN g USING (person)' : ''}`,
    params,
  );
  const old = await location().list(dayPrefix('visitor_days', pid, day));
  const out = rows.map((r) => ({
    project_id: pid, day: from, person: r.person, anon_id: r.anon_id, user_id: r.user_id, sessions: r.sessions, events: r.events,
    device: r.device, country: r.country, source: r.source, goals: (r.gi ?? []).map((i) => goals[Number(i)].id),
  }));
  for (let i = 0; i < out.length; i += FILE_ROWS) await writeRows('visitor_days', out.slice(i, i + FILE_ROWS));
  if (old.length) await location().remove(old.map((f) => f.key));
  forgetFileLists();
  return out.length;
}

/** True when the project has event files for the day (a cheap listing; most project-days of a backfill are empty). */
const hasEvents = async (pid: string, day: string) => (await location().list(dayPrefix('events', pid, day))).length > 0;

/**
 * Processes every complete day since the watermark, for every project with events that day, until `deadline`.
 * `rolledUntil` is the rollup watermark. Returns the new watermark (`until`) and whether it reached the latest complete day.
 */
export async function runVisitorDays(deadline: number, rolledUntil: number, now = Date.now()): Promise<{ until: number; caughtUp: boolean; days: number }> {
  const ids = await query<{ id: string }>('SELECT id FROM projects');
  const projects = await Promise.all(ids.map(async ({ id }) => ({ id, first: await firstDay('events', id) })));
  const saved = await getJobState(STATE);
  const bound = floorDay(now - ROLLUP_RETENTION_DAYS * DAY);
  const oldest = Math.min(floorDay(now), ...projects.map((p) => (p.first ? Date.parse(p.first) : Infinity)));
  let wm = Math.max(saved ? saved.getTime() : oldest, bound);
  let days = 0;
  // a day is complete an hour after it ends: the rollups' late-event window
  while (wm + DAY + 3600_000 <= rolledUntil && Date.now() < deadline) {
    const day = dayOf(wm);
    const active = projects.filter((p) => p.first && p.first <= day);
    // a day that was cut short by the deadline is simply built again next run (buildVisitorDay replaces its files)
    await pool(active, 4, async (p) => {
      if (await hasEvents(p.id, day)) await buildVisitorDay(p.id, day);
    });
    wm += DAY;
    days++;
    await setJobState(STATE, new Date(wm));
  }
  return { until: wm, caughtUp: wm + DAY + 3600_000 > rolledUntil, days };
}
