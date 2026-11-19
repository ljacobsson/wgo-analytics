import type { Filter, FilterScope, TriggerCondition, TriggerInput, TriggerMetric, TriggerPreview, TriggerStatus } from '../contract';
import { query } from './db';
import { explain } from './explain';
import { fieldExpression, filterSql, filtersFrom } from './filters';
import { HttpError } from './http';
import { pool } from './rollups';
import { firstDay } from './store/maintain';
import { rawQuery } from './store/duck';
import type { RawTable } from './store/tables';
import { kindOf, notifyAggregate, validateAggregate, type TriggerRow } from './triggers';

/**
 * Threshold and anomaly triggers, evaluated every minute by the monitor function (handlers/monitor.ts):
 * - the window ends a little in the past (the event writer buffers for WriteBufferSeconds), so rows still on their
 *   way don't make "nothing arrived" fire;
 * - anomaly baselines are the same window on each of the previous 7 days, computed at most once an hour;
 * - a trigger notifies when it starts firing and when it resolves (lib/triggers.ts notifyAggregate).
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** How far behind real time windows end: the write buffer plus a minute for in-flight batches. */
export const lagMs = () => (Number(process.env.WRITE_BUFFER_SECONDS) || 30) * 1000 + MIN;
const Z = { low: 4, medium: 3, high: 2 } as const;
const MIN_COUNT_CHANGE = 5;
const BASELINE_DAYS = 7;
const MIN_BASELINE_DAYS = 3;

const TABLE: Record<FilterScope, { table: RawTable; time: string }> = {
  events: { table: 'events', time: 'ts' }, logs: { table: 'logs', time: 'ts' }, spans: { table: 'spans', time: 'start_time' },
};

const isCount = (m: TriggerMetric) => m.agg === 'count' || m.agg === 'sessions';

export interface Definition { scope: FilterScope; filters: Filter[]; metric: TriggerMetric }

/** The metric over one window, or null when there's nothing to average. */
export async function metricValue(pid: string, d: Definition, w: { from: Date; to: Date }): Promise<number | null> {
  const { table, time } = TABLE[d.scope];
  const params: unknown[] = [pid, w.from, w.to];
  const range = `project_id = $1 AND ${time} >= $2 AND ${time} < $3`;
  const m = d.metric;
  if (m.agg === 'session_rate') {
    // sessions with a matching event, out of all (human) sessions in the window
    const base = filtersFrom({}, 'events', params);
    const cond = d.filters.length ? filterSql(d.filters, 'events', params).slice(' AND '.length) : 'true';
    const [r] = await rawQuery<{ hit: number; all: number }>(pid, w,
      `SELECT count(DISTINCT CASE WHEN COALESCE((${cond}), false) THEN session_id END)::int AS hit, count(DISTINCT session_id)::int AS "all"
         FROM events WHERE ${range}${base} AND session_id IS NOT NULL`, params);
    return r && r.all ? r.hit / r.all : null;
  }
  const F = (d.scope === 'events' ? filtersFrom({}, 'events', params) : '') + filterSql(d.filters, d.scope, params);
  let agg: string;
  if (m.agg === 'count') agg = 'count(*)::double';
  else if (m.agg === 'sessions') agg = 'count(DISTINCT session_id)::double';
  else {
    const x = `TRY_CAST((${fieldExpression(d.scope, m.field!, params)}) AS DOUBLE)`;
    agg = m.agg === 'avg' ? `avg(${x})` : `quantile_cont(${x}, ${m.agg === 'p75' ? 0.75 : 0.95})`;
  }
  const [r] = await rawQuery<{ v: number | null }>(pid, w, `SELECT ${agg} AS v FROM ${table} WHERE ${range}${F}`, params);
  return r?.v ?? (isCount(m) ? 0 : null);
}

export interface Baseline { median: number; low: number; high: number; days: number; hour: number; at: string }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Usual range from past values: median ± z·σ, σ from the MAD (robust to one odd day), at least √median for counts. */
export function usualRange(values: number[], count: boolean, sensitivity: keyof typeof Z): Omit<Baseline, 'hour' | 'at'> | null {
  if (values.length < MIN_BASELINE_DAYS) return null;
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  const sigma = Math.max(1.4826 * mad, count ? Math.sqrt(Math.max(med, 1)) : Math.abs(med) * 0.05, 1e-9);
  const z = Z[sensitivity];
  return { median: med, low: Math.max(0, med - z * sigma), high: med + z * sigma, days: values.length };
}

/** The same window on each of the previous days that have data (never before the scope's first stored day). */
async function baselineValues(pid: string, d: Definition, w: { from: Date; to: Date }): Promise<number[]> {
  const first = await firstDay(TABLE[d.scope].table, pid);
  const firstMs = first ? Date.parse(first) : Infinity;
  const out: number[] = [];
  for (let k = 1; k <= BASELINE_DAYS; k++) {
    const from = new Date(w.from.getTime() - k * DAY), to = new Date(w.to.getTime() - k * DAY);
    if (from.getTime() < firstMs) break;
    const v = await metricValue(pid, d, { from, to });
    if (v !== null) out.push(v);
  }
  return out;
}

/** Whether a value meets the condition. */
export function fires(value: number | null, c: TriggerCondition, metric: TriggerMetric, b: Omit<Baseline, 'hour' | 'at'> | null): boolean {
  if (value === null) return false;
  if ('op' in c) return c.op === 'above' ? value > c.value : value < c.value;
  if (!b) return false;
  const high = value > b.high, low = value < b.low;
  const hit = c.direction === 'up' ? high : c.direction === 'down' ? low : high || low;
  return hit && (!isCount(metric) || Math.abs(value - b.median) >= MIN_COUNT_CHANGE);
}

const windowOf = (minutes: number, now: number) => {
  const to = new Date(Math.floor((now - lagMs()) / MIN) * MIN);
  return { from: new Date(to.getTime() - minutes * MIN), to };
};

const publicBaseline = (b: Baseline | null): TriggerStatus['baseline'] => (b ? { median: b.median, low: b.low, high: b.high, days: b.days } : null);

/** Evaluates one trigger; notifies on a change of state. Returns the new state. */
export async function evaluate(t: TriggerRow, now = Date.now()): Promise<'ok' | 'firing'> {
  const d: Definition = { scope: t.scope ?? 'events', filters: t.filters, metric: t.metric! };
  const w = windowOf(t.window_minutes!, now);
  const value = await metricValue(t.project_id, d, w);
  let baseline = t.baseline as Baseline | null;
  const c = t.condition!;
  if (!('op' in c)) {
    const hour = Math.floor(w.to.getTime() / HOUR);
    if (!baseline || baseline.hour !== hour) {
      const range = usualRange(await baselineValues(t.project_id, d, w), isCount(d.metric), c.sensitivity);
      baseline = range ? { ...range, hour, at: new Date(now).toISOString() } : null;
    }
  }
  const state = fires(value, c, d.metric, baseline) ? 'firing' : 'ok';
  const changed = state !== (t.state ?? 'ok');
  await query(
    `UPDATE triggers SET state = $3, last_value = $4, last_evaluated_at = $5, baseline = $6::jsonb${changed || !t.state ? ', state_since = $5' : ''}
      WHERE project_id = $1 AND id = $2`,
    [t.project_id, t.id, state, value, new Date(now), baseline && JSON.stringify(baseline)],
  );
  if (changed) {
    let explanation: string | undefined;
    if (state === 'firing' && d.scope === 'events' && isCount(d.metric)) {
      explanation = await explain(t.project_id, {
        metric: d.metric.agg === 'sessions' ? 'sessions' : 'events', where: JSON.stringify(d.filters),
        from: w.from.toISOString(), to: w.to.toISOString(),
      }).then((x) => (x.significant && (x.drivers.length || x.startedAt || x.release) ? x.summary : undefined)).catch((err) => {
        console.warn('explaining a firing trigger failed', err);
        return undefined;
      });
    }
    await notifyAggregate(t, state === 'firing' ? 'firing' : 'resolved', value, publicBaseline(baseline), explanation);
  }
  return state;
}

/** Every enabled threshold/anomaly trigger that is due: windows up to an hour every minute, longer ones every 15. */
export async function runMonitor(now = Date.now(), deadline = Date.now() + 50_000): Promise<{ evaluated: number; firing: number; failed: number }> {
  const all = await query<TriggerRow>(`SELECT * FROM triggers WHERE enabled AND kind IN ('threshold', 'anomaly')`);
  const due = all.filter((t) => (t.window_minutes ?? 60) <= 60 || !t.last_evaluated_at || now - t.last_evaluated_at.getTime() >= 15 * MIN - 5000);
  let firing = 0, failed = 0, evaluated = 0;
  await pool(due, 4, async (t) => {
    if (Date.now() > deadline) return;
    try {
      if ((await evaluate(t, now)) === 'firing') firing++;
      evaluated++;
    } catch (err) {
      failed++;
      console.warn(JSON.stringify({ msg: 'evaluating trigger failed', trigger: t.id, error: String(err) }));
    }
  });
  return { evaluated, firing, failed };
}

/** POST /triggers/preview: the number right now for an unsaved definition, and whether it would fire. */
export async function previewTrigger(pid: string, body: Partial<TriggerInput>, now = Date.now()): Promise<TriggerPreview> {
  const kind = kindOf({ kind: body.kind ?? null });
  if (kind === 'match') throw new HttpError(400, 'Only threshold and anomaly triggers have a preview');
  const scope = body.scope ?? 'events';
  const agg = validateAggregate(kind, scope, body);
  const filters = Array.isArray(body.filters) ? body.filters : [];
  filterSql(filters, scope, []); // rejects unknown fields
  const d: Definition = { scope, filters, metric: agg.metric! };
  const w = windowOf(agg.windowMinutes!, now);
  const c = agg.condition!;
  const [value, past] = await Promise.all([metricValue(pid, d, w), 'op' in c ? Promise.resolve(null) : baselineValues(pid, d, w)]);
  const range = past && !('op' in c) ? usualRange(past, isCount(d.metric), c.sensitivity) : null;
  return {
    value, fires: fires(value, c, d.metric, range), baseline: range ? { median: range.median, low: range.low, high: range.high, days: range.days } : null,
    window: { from: w.from.toISOString(), to: w.to.toISOString() },
    ...(past && !range ? { note: `Not enough history yet: unusual values need the same window on at least ${MIN_BASELINE_DAYS} earlier days (${past.length} so far).` } : {}),
  };
}
