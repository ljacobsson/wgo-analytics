import type { MeasureNames, MeasureQuery, QueryAgg, QueryMeasureResult, QueryResult, QuerySource, QuerySpec } from '../contract';
import { bucketStarts, parseRange, pickBucket, type Range } from './analytics';
import { fieldInfo, filterSql, filtersFrom, parseFilters, type QueryScope } from './filters';
import { HttpError } from './http';
import { query as sql } from './db';
import { isUuid } from './projects';
import { rawQuery } from './store/duck';
import type { RawTable } from './store/tables';
import { suppressedSql } from './suppressions';

/**
 * The generic query behind custom dashboards: one or more measures (an aggregation over the rows of a source,
 * narrowed by filters) as a total, a series over time or the top values of a field. Each measure is one scan:
 * GROUPING SETS return the per-bucket series, the total of each group and the overall total together.
 *
 * Everything user-supplied goes through the filter compiler (lib/filters.ts): fields resolve to registry columns
 * or bound JSON paths, values are bound. Nothing from the request is interpolated.
 */

type Params = Record<string, string | undefined>;

const SOURCES: Record<QuerySource, { table: RawTable; time: string }> = {
  events: { table: 'events', time: 'ts' },
  logs: { table: 'logs', time: 'ts' },
  spans: { table: 'spans', time: 'start_time' },
  metrics: { table: 'metric_points', time: 'ts' },
  checks: { table: 'checks', time: 'ts' },
};
const AGGS: readonly QueryAgg[] = ['count', 'sessions', 'users', 'session_rate', 'sum', 'avg', 'min', 'max', 'p50', 'p75', 'p95', 'p99', 'rate'];
const EVENTS_ONLY: readonly QueryAgg[] = ['sessions', 'users', 'session_rate'];
const QUANTILE: Partial<Record<QueryAgg, number>> = { p50: 0.5, p75: 0.75, p95: 0.95, p99: 0.99 };
/** Sums of the parts: an empty bucket is 0 and groups rank by their value. Everything else is null when empty. */
const ADDITIVE: readonly QueryAgg[] = ['count', 'sessions', 'users', 'sum'];
const SHAPES = ['series', 'total', 'top'] as const;

export const MAX_MEASURES = 4;
const LIMITS = { series: { def: 5, max: 10 }, top: { def: 10, max: 50 } } as const;

export const isAdditive = (agg: QueryAgg) => ADDITIVE.includes(agg);

const scopeOf = (s: QuerySource): QueryScope => s;

/** Field of a numeric agg, with the per-source defaults. */
function valueField(m: MeasureQuery): string | null {
  if (m.field) return m.field;
  if (m.source === 'metrics') return 'value';
  if (m.source === 'checks') return m.agg === 'rate' ? 'ok' : 'durationMs';
  return null;
}

/** Check one measure's shape and compile its fields and filters (so bad ones fail here, with a 400). */
export function validateMeasure(raw: unknown): MeasureQuery {
  const m = (raw ?? {}) as Record<string, unknown>;
  const source = m.source as QuerySource;
  if (!Object.hasOwn(SOURCES, source)) throw new HttpError(400, `Unknown source: ${String(m.source)}`);
  const agg = m.agg as QueryAgg;
  if (!AGGS.includes(agg)) throw new HttpError(400, `Unknown aggregation: ${String(m.agg)}`);
  if (EVENTS_ONLY.includes(agg) && source !== 'events') throw new HttpError(400, `${agg} only applies to events`);
  const out: MeasureQuery = { source, agg };
  if (m.field !== undefined && m.field !== '') {
    if (typeof m.field !== 'string' || m.field.length > 200) throw new HttpError(400, 'field must be a field name');
    out.field = m.field;
  }
  if (source === 'metrics') {
    if (typeof m.metric !== 'string' || !m.metric || m.metric.length > 200) throw new HttpError(400, 'A metrics measure needs a metric name');
    out.metric = m.metric;
  }
  if (m.filters !== undefined) {
    if (!Array.isArray(m.filters)) throw new HttpError(400, 'filters must be an array');
    out.filters = parseFilters(JSON.stringify(m.filters));
  }
  const numeric = agg !== 'count' && !EVENTS_ONLY.includes(agg);
  if (numeric && !valueField(out)) throw new HttpError(400, `${agg} needs a numeric field`);
  // compile once against throwaway params: unknown fields throw
  const params: unknown[] = [];
  if (numeric) fieldInfo(scopeOf(source), valueField(out)!, params);
  filterSql(out.filters ?? [], scopeOf(source), params);
  return out;
}

/** Validate a whole spec (the `q` param, or a dashboard tile's query). */
export function validateSpec(raw: unknown): QuerySpec {
  const s = (raw ?? {}) as Record<string, unknown>;
  if (!SHAPES.includes(s.shape as QuerySpec['shape'])) throw new HttpError(400, 'shape must be series, total or top');
  const shape = s.shape as QuerySpec['shape'];
  if (!Array.isArray(s.measures) || !s.measures.length) throw new HttpError(400, 'At least one measure');
  if (s.measures.length > MAX_MEASURES) throw new HttpError(400, `At most ${MAX_MEASURES} measures`);
  const measures = s.measures.map(validateMeasure);
  const spec: QuerySpec = { shape, measures };
  if (s.groupBy !== undefined && s.groupBy !== '') {
    if (typeof s.groupBy !== 'string' || s.groupBy.length > 200) throw new HttpError(400, 'groupBy must be a field name');
    if (measures.length > 1) throw new HttpError(400, 'groupBy works with one measure');
    fieldInfo(scopeOf(measures[0].source), s.groupBy, []);
    spec.groupBy = s.groupBy;
  }
  if (shape === 'top' && !spec.groupBy) throw new HttpError(400, 'top needs a groupBy field');
  if (s.limit !== undefined) {
    const n = Number(s.limit);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'limit must be a positive whole number');
    spec.limit = n;
  }
  if (s.compare) spec.compare = true;
  return spec;
}

export function parseSpec(raw: string | undefined): QuerySpec {
  if (!raw) throw new HttpError(400, 'q is required');
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'q must be JSON');
  }
  return validateSpec(v);
}

interface Built { sql: string; params: unknown[] }

/**
 * One measure's SQL over a window. Rows: gk/gt (GROUPING of key and bucket), k, t, v (the value) and n (rows,
 * to rank non-additive groups).
 */
async function build(pid: string, m: MeasureQuery, spec: QuerySpec, w: Range, p: Params, opts: { bucket: number; totalOnly: boolean; limit: number }): Promise<Built> {
  const { table, time } = SOURCES[m.source];
  const scope = scopeOf(m.source);
  const params: unknown[] = [pid, w.from, w.to];
  let where = `project_id = $1 AND ${time} >= $2 AND ${time} < $3`;
  if (m.source === 'metrics') where += ` AND name = $${params.push(m.metric)}`;
  if (m.source === 'events') where += filtersFrom(p, 'events', params) + await suppressedSql(pid, params);

  let value: string;
  if (m.agg === 'session_rate') {
    // the measure's filters pick the converting events; the base is every session in the window
    const cond = m.filters?.length ? filterSql(m.filters, 'events', params).slice(' AND '.length) : 'true';
    where += ' AND session_id IS NOT NULL';
    value = `count(DISTINCT CASE WHEN COALESCE((${cond}), false) THEN session_id END)::double / NULLIF(count(DISTINCT session_id), 0)`;
  } else {
    where += filterSql(m.filters ?? [], scope, params);
    if (m.agg === 'count') value = 'count(*)::double';
    else if (m.agg === 'sessions') value = 'count(DISTINCT session_id)::double';
    else if (m.agg === 'users') value = 'count(DISTINCT anon_id)::double';
    else {
      const f = fieldInfo(scope, valueField(m)!, params);
      const x = f.type === 'number' ? `(${f.sql})::double` : `TRY_CAST((${f.sql}) AS DOUBLE)`;
      const q = QUANTILE[m.agg];
      value = q !== undefined ? `quantile_cont(${x}, ${q})` : m.agg === 'rate' ? `avg(${x})` : `${m.agg}(${x})`;
    }
  }

  const grouped = !!spec.groupBy && !opts.totalOnly;
  let key = `''`;
  if (grouped) {
    const g = fieldInfo(scope, spec.groupBy!, params);
    key = `COALESCE(NULLIF((${g.sql})::text, ''), '(none)')`;
  }
  const series = spec.shape === 'series' && !opts.totalOnly;
  const t = series ? `to_timestamp(floor(extract(epoch from ${time}) / $${params.push(opts.bucket)}::double) * $${params.length}::double)` : 'NULL';
  const sets = series ? '((k, t), (k), ())' : '((k), ())';
  const gt = series ? 'GROUPING(t)' : '1';
  const rank = isAdditive(m.agg) || spec.shape === 'top' ? 'v DESC NULLS LAST, n DESC' : 'n DESC, v DESC NULLS LAST';
  const sql =
    `WITH g AS (
       SELECT GROUPING(k) AS gk, ${gt} AS gt, k, ${series ? 't' : 'NULL::timestamp AS t'}, (${value})::double AS v, count(*)::int AS n
         FROM (SELECT *, ${key} AS k, ${t} AS t FROM ${table} WHERE ${where}) s
        GROUP BY GROUPING SETS ${sets}
     ), ranked AS (SELECT k FROM g WHERE gk = 0 AND gt = 1 ORDER BY ${rank}, k LIMIT ${opts.limit})
     SELECT gk::int AS gk, gt::int AS gt, k, t, v FROM g WHERE gk = 1 OR k IN (SELECT k FROM ranked)`;
  return { sql, params };
}

interface Row { gk: number; gt: number; k: string | null; t: Date | string | null; v: number | null }

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

async function runMeasure(pid: string, m: MeasureQuery, spec: QuerySpec, r: Range, p: Params, bucket: number): Promise<QueryMeasureResult> {
  const lim = spec.shape === 'total' ? { def: 1, max: 1 } : LIMITS[spec.shape];
  const limit = Math.min(spec.limit ?? lim.def, lim.max);
  const prev = { from: new Date(r.from.getTime() - (r.to.getTime() - r.from.getTime())), to: r.from };
  const cur = await build(pid, m, spec, r, p, { bucket, totalOnly: false, limit });
  const [rows, before] = await Promise.all([
    rawQuery<Row>(pid, r, cur.sql, cur.params),
    spec.compare
      ? build(pid, m, spec, prev, p, { bucket, totalOnly: true, limit: 1 }).then((b) => rawQuery<Row>(pid, prev, b.sql, b.params))
      : Promise.resolve(null),
  ]);
  const zero = isAdditive(m.agg) ? 0 : null;
  const out: QueryMeasureResult = { total: num(rows.find((x) => Number(x.gk) === 1)?.v) ?? zero };
  if (before) out.previous = num(before.find((x) => Number(x.gk) === 1)?.v) ?? zero;

  const groupRows = rows.filter((x) => Number(x.gk) === 0 && Number(x.gt) === 1);
  const order = new Map<string, number>();
  if (spec.groupBy) {
    // biggest first (non-additive series groups were picked by row count, but read best by value)
    const ranked = [...groupRows].sort((a, b) => (num(b.v) ?? -Infinity) - (num(a.v) ?? -Infinity) || String(a.k).localeCompare(String(b.k)));
    ranked.forEach((x, i) => order.set(String(x.k), i));
    out.groups = ranked.map((x) => ({ key: String(x.k), value: num(x.v) }));
  }
  if (spec.shape === 'series') {
    const starts = bucketStarts(r, bucket);
    const byKey = new Map<string, Map<number, number | null>>();
    for (const x of rows) {
      if (Number(x.gk) !== 0 || Number(x.gt) !== 0 || x.t === null) continue;
      const k = String(x.k);
      if (!byKey.has(k)) byKey.set(k, new Map());
      byKey.get(k)!.set(new Date(x.t).getTime(), num(x.v));
    }
    const keys = spec.groupBy ? [...order.keys()] : [''];
    out.series = keys.map((k) => {
      const at = byKey.get(k) ?? new Map();
      return { key: k, points: starts.map((s) => ({ t: new Date(s).toISOString(), value: at.has(s) ? at.get(s)! : zero })) };
    });
  }
  return out;
}

/** Names for group keys that are ids: uptime checks split by checkId show the check's name. */
async function labelKeys(pid: string, spec: QuerySpec, measures: QueryMeasureResult[]): Promise<void> {
  if (spec.groupBy !== 'checkId' || spec.measures[0]?.source !== 'checks') return;
  const ids = [...new Set(measures.flatMap((m) => [...(m.groups ?? []), ...(m.series ?? [])].map((g) => g.key)))].filter(isUuid);
  if (!ids.length) return;
  const rows = await sql<{ id: string; name: string }>('SELECT id, name FROM uptime_checks WHERE project_id = $1 AND id = ANY($2::uuid[])', [pid, ids]);
  const names = new Map(rows.map((x) => [x.id, x.name]));
  for (const m of measures) for (const g of [...(m.groups ?? []), ...(m.series ?? [])]) if (names.has(g.key)) g.label = names.get(g.key);
}

/** GET /query */
export async function query(pid: string, p: Params): Promise<QueryResult> {
  const spec = parseSpec(p.q);
  const r = parseRange(p);
  const bucket = pickBucket(r);
  const measures = await Promise.all(spec.measures.map((m) => runMeasure(pid, m, spec, r, p, bucket)));
  await labelKeys(pid, spec, measures);
  return { bucketSeconds: spec.shape === 'series' ? bucket : 0, measures };
}

/** GET /measures: names seen in the last 7 days, for the dashboard's measure picker. */
export async function measureNames(pid: string): Promise<MeasureNames> {
  const since = new Date(Date.now() - 7 * 86400e3);
  const w = { from: since, to: new Date(Date.now() + 60_000) };
  const [tracks, events, metrics] = await Promise.all([
    rawQuery<{ name: string }>(pid, w,
      `SELECT track_name AS name FROM events WHERE project_id = $1 AND type = 'click' AND ts >= $2 AND track_name IS NOT NULL
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 100`, [pid, since]),
    rawQuery<{ name: string }>(pid, w,
      `SELECT name FROM events WHERE project_id = $1 AND type = 'custom' AND ts >= $2 AND name IS NOT NULL
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 100`, [pid, since]),
    rawQuery<{ name: string; type: string; unit: string | null; description: string | null }>(pid, w,
      `SELECT name, max(type) AS type, max(unit) AS unit, max(description) AS description FROM metric_points
        WHERE project_id = $1 AND ts >= $2 GROUP BY 1 ORDER BY 1 LIMIT 300`, [pid, since]),
  ]);
  return {
    trackedClicks: tracks.map((x) => x.name),
    customEvents: events.map((x) => x.name),
    metrics: metrics.map((x) => ({ name: x.name, type: x.type as MeasureNames['metrics'][number]['type'], unit: x.unit || null, description: x.description || null })),
  };
}
