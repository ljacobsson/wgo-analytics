import { randomUUID } from 'node:crypto';
import type { ConversionsResponse, Filter, Goal, GoalInput, GoalStep } from '../contract';
import { parseRange } from './analytics';
import { query } from './db';
import { filterSql, filtersFrom, parseFilters } from './filters';
import { HttpError } from './http';
import { isUuid } from './projects';
import { rawQuery } from './store/duck';

/**
 * Conversion goals: any kind of event, described with filters, counted as a conversion. A session converts when it
 * has at least one matching event; the conversion rate compares those sessions with all sessions in the range.
 */

export const MAX_GOALS = 50;
export const MAX_STEPS = 6;
const SPARK_BUCKETS = 24;

interface GoalRow { project_id: string; id: string; name: string; filters: Filter[]; steps: GoalStep[] | null; created_by: string; created_at: Date }

const toGoal = (r: GoalRow): Goal =>
  ({ id: r.id, name: r.name, filters: r.filters, steps: r.steps ?? [], createdBy: r.created_by, createdAt: r.created_at.toISOString() });

const goalName = (v: unknown) => {
  const n = typeof v === 'string' ? v.trim() : '';
  if (!n || n.length > 120) throw new HttpError(400, 'Goal name must be 1-120 characters');
  return n;
};

function goalFilters(v: unknown): Filter[] {
  const list = parseFilters(JSON.stringify(v ?? []));
  if (!list.length) throw new HttpError(400, 'A goal needs at least one filter');
  filterSql(list, 'events', []); // rejects unknown fields with a 400
  return list;
}

/** Funnel steps: at most MAX_STEPS, each with a name and at least one valid events filter. */
export function goalSteps(v: unknown): GoalStep[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, 'steps must be an array');
  if (v.length > MAX_STEPS) throw new HttpError(400, `A goal can have at most ${MAX_STEPS} funnel steps`);
  return v.map((raw, i) => {
    const step = (raw ?? {}) as Record<string, unknown>;
    const name = typeof step.name === 'string' ? step.name.trim() : '';
    if (!name || name.length > 80) throw new HttpError(400, `Step ${i + 1} needs a name of 1-80 characters`);
    const filters = parseFilters(JSON.stringify(step.filters ?? []));
    if (!filters.length) throw new HttpError(400, `Step ${i + 1} needs at least one filter`);
    filterSql(filters, 'events', []);
    return { name, filters };
  });
}

export async function listGoals(pid: string): Promise<Goal[]> {
  const rows = await query<GoalRow>('SELECT * FROM goals WHERE project_id = $1 ORDER BY created_at, id LIMIT $2', [pid, MAX_GOALS]);
  return rows.map(toGoal);
}

async function getGoal(pid: string, id: string): Promise<GoalRow> {
  if (!isUuid(id)) throw new HttpError(404, 'Goal not found');
  const [row] = await query<GoalRow>('SELECT * FROM goals WHERE project_id = $1 AND id = $2', [pid, id]);
  if (!row) throw new HttpError(404, 'Goal not found');
  return row;
}

export const findGoal = async (pid: string, id: string): Promise<Goal> => toGoal(await getGoal(pid, id));

export async function createGoal(pid: string, email: string, body: Partial<GoalInput>): Promise<Goal> {
  const name = goalName(body.name);
  const filters = goalFilters(body.filters);
  const steps = goalSteps(body.steps);
  const [{ n }] = await query<{ n: number }>('SELECT count(*)::int AS n FROM goals WHERE project_id = $1', [pid]);
  if (n >= MAX_GOALS) throw new HttpError(400, `A project can have at most ${MAX_GOALS} goals`);
  const id = randomUUID();
  await query('INSERT INTO goals (project_id, id, name, filters, steps, created_by) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)',
    [pid, id, name, JSON.stringify(filters), JSON.stringify(steps), email]);
  return toGoal(await getGoal(pid, id));
}

export async function updateGoal(pid: string, id: string, body: Partial<GoalInput>): Promise<Goal> {
  const cur = await getGoal(pid, id);
  await query('UPDATE goals SET name = $3, filters = $4::jsonb, steps = $5::jsonb WHERE project_id = $1 AND id = $2', [
    pid, id,
    body.name !== undefined ? goalName(body.name) : cur.name,
    JSON.stringify(body.filters !== undefined ? goalFilters(body.filters) : cur.filters),
    JSON.stringify(body.steps !== undefined ? goalSteps(body.steps) : cur.steps ?? []),
  ]);
  return toGoal(await getGoal(pid, id));
}

export async function deleteGoal(pid: string, id: string): Promise<void> {
  await getGoal(pid, id);
  await query('DELETE FROM goals WHERE project_id = $1 AND id = $2', [pid, id]);
}

/**
 * SQL that pairs each event in the range with every goal it matches, as `goal` (the goal's index). One scan of the
 * range for all goals: the OR of all goals narrows the events first, then a VALUES list fans them out per goal.
 * `F` is the page filter SQL, bound into the same params.
 */
export function matchedEvents(goals: Goal[], params: unknown[], F: string): string {
  const cond = (g: Goal) => filterSql(g.filters, 'events', params).slice(' AND '.length);
  const any = goals.map((g) => `(${cond(g)})`).join(' OR ');
  const which = goals.map((g, i) => `WHEN ${i} THEN (${cond(g)})`).join(' ');
  const ids = goals.map((_, i) => `(${i})`).join(', ');
  return `FROM events CROSS JOIN (VALUES ${ids}) AS goal(i)
          WHERE project_id = $1 AND ts >= $2 AND ts < $3${F} AND (${any}) AND (CASE goal.i ${which} ELSE false END)`;
}

/** GET /conversions: every goal's conversions in the range, and the sessions they're compared with. */
export async function conversions(pid: string, p: Record<string, string | undefined>): Promise<ConversionsResponse> {
  const r = parseRange(p);
  const goals = await listGoals(pid);
  const withSeries = p.series !== '0' && p.series !== 'false';

  const allParams: unknown[] = [pid, r.from, r.to];
  const all = rawQuery<{ sessions: number; users: number }>(pid, r,
    `SELECT count(DISTINCT session_id)::int AS sessions, count(DISTINCT anon_id)::int AS users
       FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3${filtersFrom(p, 'events', allParams)}`,
    allParams,
  );
  if (!goals.length) {
    const [t] = await all;
    return { sessions: t?.sessions ?? 0, users: t?.users ?? 0, goals: [] };
  }

  const totParams: unknown[] = [pid, r.from, r.to];
  const totals = rawQuery<{ i: number; conversions: number; sessions: number; users: number }>(pid, r,
    `SELECT goal.i AS i, count(*)::int AS conversions, count(DISTINCT session_id)::int AS sessions, count(DISTINCT anon_id)::int AS users
       ${matchedEvents(goals, totParams, filtersFrom(p, 'events', totParams))}
      GROUP BY goal.i`,
    totParams,
  );
  const step = (r.to.getTime() - r.from.getTime()) / 1000 / SPARK_BUCKETS;
  const sparkParams: unknown[] = [pid, r.from, r.to, step];
  const spark = withSeries
    ? rawQuery<{ i: number; b: number; n: number }>(pid, r,
      `SELECT goal.i AS i, floor(extract(epoch from (ts - $2::TIMESTAMP)) / $4::double)::int AS b, count(*)::int AS n
         ${matchedEvents(goals, sparkParams, filtersFrom(p, 'events', sparkParams))}
        GROUP BY 1, 2`,
      sparkParams,
    )
    : Promise.resolve([]);

  const [[t], tot, sp] = await Promise.all([all, totals, spark]);
  const out = goals.map((g) => ({
    id: g.id, name: g.name, filters: g.filters, conversions: 0, sessions: 0, users: 0,
    series: withSeries ? new Array<number>(SPARK_BUCKETS).fill(0) : [],
  }));
  for (const row of tot) Object.assign(out[row.i], { conversions: row.conversions, sessions: row.sessions, users: row.users });
  for (const s of sp) if (s.b >= 0 && s.b < SPARK_BUCKETS) out[s.i].series[s.b] += s.n;
  return { sessions: t?.sessions ?? 0, users: t?.users ?? 0, goals: out };
}
