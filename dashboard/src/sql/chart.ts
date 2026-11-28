import type { SqlColumn, SqlResult, SqlTileQuery, TileUnit } from '../api/contract';
import { isNumericType } from './ResultsGrid';

/**
 * Charts of SQL results: which columns go where, picked from the result when not chosen, and the rows turned into
 * what the chart components draw. Shared by the SQL editor and SQL tiles on dashboards.
 */
export type ChartViz = 'number' | 'line' | 'area' | 'bars' | 'top' | 'table' | 'columns' | 'pie' | 'scatter';
export interface ChartSpec extends Omit<SqlTileQuery, 'query'> { viz: ChartViz }

export const MAX_SERIES = 8; // one per categorical color, in fixed order
const MAX_BARS = 50;

export type ColumnKind = 'time' | 'number' | 'text';
export const kindOf = (c: SqlColumn): ColumnKind => (/^(TIMESTAMP|DATE)/.test(c.type) ? 'time' : isNumericType(c.type) ? 'number' : 'text');

export const TIME_VIZ: ReadonlySet<ChartViz> = new Set(['line', 'area', 'bars']);
/** Charts with a label column on one axis and values on the other */
export const CATEGORY_VIZ: ReadonlySet<ChartViz> = new Set(['top', 'columns', 'pie']);
export const MAX_SLICES = 6; // a pie past that can't be read: the rest folds into "Other"
const MAX_POINTS = 5000;

/** A chart that fits the result: one row of numbers is a number, time and numbers a line, labels and numbers a bar list. */
export function suggestChart(result: Pick<SqlResult, 'columns' | 'rows'>): ChartSpec {
  const cols = result.columns;
  const time = cols.find((c) => kindOf(c) === 'time');
  const nums = cols.filter((c) => kindOf(c) === 'number');
  const texts = cols.filter((c) => kindOf(c) === 'text');
  if (!nums.length) return { viz: 'table' };
  if (result.rows.length === 1 && !time) return { viz: 'number', y: [nums[0].name] };
  if (time) {
    // long format: time, label, value -> one series per label
    if (nums.length === 1 && texts.length >= 1) return { viz: 'line', x: time.name, y: [nums[0].name], series: texts[0].name };
    return { viz: 'line', x: time.name, y: nums.slice(0, MAX_SERIES).map((c) => c.name) };
  }
  if (texts.length >= 2 && nums.length === 1) return { viz: 'columns', x: texts[0].name, y: [nums[0].name], series: texts[1].name };
  if (texts.length) return { viz: 'top', x: texts[0].name, y: [nums[0].name] };
  if (nums.length >= 2) return { viz: 'scatter', x: nums[0].name, y: [nums[1].name] };
  return { viz: 'table' };
}

/** The spec with its gaps filled from the result; columns that aren't in the result are replaced. */
export function resolveChart(result: Pick<SqlResult, 'columns' | 'rows'>, spec: ChartSpec): ChartSpec {
  const by = new Map(result.columns.map((c) => [c.name, c]));
  const ok = (name: string | undefined, kinds: ColumnKind[]) => !!name && by.has(name) && kinds.includes(kindOf(by.get(name)!));
  const auto = suggestChart(result);
  const nums = result.columns.filter((c) => kindOf(c) === 'number').map((c) => c.name);
  const out: ChartSpec = { ...spec };
  out.y = (spec.y ?? []).filter((y) => ok(y, ['number']));
  if (!out.y.length) out.y = auto.y?.length ? auto.y : nums.slice(0, MAX_SERIES);
  if (TIME_VIZ.has(spec.viz)) {
    if (!ok(spec.x, ['time'])) out.x = result.columns.find((c) => kindOf(c) === 'time')?.name;
    // nothing pinned yet: a long-format result (time, label, value) splits by its label. Once the columns are
    // chosen (a saved tile always has them), no series means no split; '' is "don't split" while choosing
    if (out.y.length > 1 || spec.series === '') delete out.series;
    else if (spec.series !== undefined) { if (!ok(spec.series, ['text', 'number']) || spec.series === out.x) delete out.series; }
    else if (spec.y === undefined && auto.series && out.x === auto.x && out.y[0] === auto.y?.[0]) out.series = auto.series;
  } else if (spec.viz === 'scatter') {
    // x and y are both numeric columns: y one of them, x another
    if (!ok(spec.x, ['number']) || spec.x === out.y[0]) out.x = nums.find((n) => n !== out.y![0]);
    if (out.y[0] === out.x || !spec.y?.length) out.y = [nums.find((n) => n !== out.x) ?? out.y[0]];
    if (!ok(spec.series, ['text'])) delete out.series;
  } else if (CATEGORY_VIZ.has(spec.viz)) {
    if (!spec.x || !by.has(spec.x) || out.y.includes(spec.x)) {
      out.x = result.columns.find((c) => kindOf(c) === 'text')?.name ?? result.columns.find((c) => !out.y!.includes(c.name))?.name;
    }
    if (spec.viz !== 'columns') out.y = out.y.slice(0, 1);
    if (spec.viz !== 'columns' || out.y.length > 1 || spec.series === '') delete out.series;
    else if (spec.series !== undefined) { if (!ok(spec.series, ['text', 'number', 'time']) || spec.series === out.x) delete out.series; }
    else if (spec.y === undefined && auto.series && auto.viz === 'columns' && out.x === auto.x) out.series = auto.series;
  } else {
    delete out.series;
  }
  return out;
}

// ---------------------------------------------------------------- values

/** Milliseconds of a timestamp as the API sends it: 'YYYY-MM-DD[ HH:MM:SS[.fff]][+00]' in UTC. */
export function parseTime(v: unknown): number | null {
  if (typeof v !== 'string') return typeof v === 'number' ? v : null;
  let s = v.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00';
  if (/[+-]\d{2}$/.test(s)) s += ':00';
  else if (!/(Z|[+-]\d{2}:\d{2})$/.test(s)) s += 'Z';
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

export interface TimeData {
  times: number[];
  series: Array<{ key: string; label: string; values: Array<number | null> }>;
  hidden: number; // series left out past MAX_SERIES
  bucketMs?: number;
}

/** Rows as series over time: one per y column, or one per value of the series column. Biggest series first. */
export function timeData(result: SqlResult, spec: ChartSpec): TimeData | { problem: string } {
  const idx = (name?: string) => (name ? result.columns.findIndex((c) => c.name === name) : -1);
  const xi = idx(spec.x);
  if (xi < 0) return { problem: 'This chart needs a time column (TIMESTAMP or DATE) on the x axis. Try date_trunc(\'hour\', ts) AS hour.' };
  const ys = (spec.y ?? []).map(idx).filter((i) => i >= 0);
  if (!ys.length) return { problem: 'Pick a numeric column to plot.' };
  const si = spec.series && ys.length === 1 ? idx(spec.series) : -1;

  const timeSet = new Set<number>();
  const cells = new Map<string, Map<number, number | null>>(); // series -> time -> value
  for (const row of result.rows) {
    const t = parseTime(row[xi]);
    if (t === null) continue;
    timeSet.add(t);
    if (si >= 0) {
      const key = row[si] === null || row[si] === undefined ? '(null)' : String(row[si]);
      const m = cells.get(key) ?? new Map();
      m.set(t, (m.get(t) ?? 0) + (num(row[ys[0]]) ?? 0));
      cells.set(key, m);
    } else {
      for (const y of ys) {
        const key = result.columns[y].name;
        const m = cells.get(key) ?? new Map();
        m.set(t, num(row[y]));
        cells.set(key, m);
      }
    }
  }
  const times = [...timeSet].sort((a, b) => a - b);
  if (!times.length) return { problem: 'No rows to plot.' };
  let keys = [...cells.keys()];
  if (si >= 0) {
    const total = (k: string) => [...cells.get(k)!.values()].reduce<number>((s, v) => s + Math.abs(v ?? 0), 0);
    keys.sort((a, b) => total(b) - total(a));
  }
  const hidden = Math.max(0, keys.length - MAX_SERIES);
  keys = keys.slice(0, MAX_SERIES);
  let step = Infinity;
  for (let i = 1; i < times.length; i++) step = Math.min(step, times[i] - times[i - 1]);
  return {
    times,
    series: keys.map((k) => ({ key: k, label: k, values: times.map((t) => cells.get(k)!.get(t) ?? null) })),
    hidden,
    bucketMs: Number.isFinite(step) ? step : undefined,
  };
}

/** Rows as labelled bars, in the query's order. */
export function barData(result: SqlResult, spec: ChartSpec): { rows: Array<{ key: string; label: string; value: number }>; hidden: number } | { problem: string } {
  const xi = result.columns.findIndex((c) => c.name === spec.x);
  const yi = result.columns.findIndex((c) => c.name === spec.y?.[0]);
  if (yi < 0) return { problem: 'Pick a numeric column for the bars.' };
  if (xi < 0) return { problem: 'Pick a column for the labels.' };
  const rows = result.rows.slice(0, MAX_BARS).map((r, i) => ({ key: `${i}`, label: r[xi] === null || r[xi] === undefined ? '(null)' : String(r[xi]), value: num(r[yi]) ?? 0 }));
  return { rows, hidden: Math.max(0, result.rows.length - MAX_BARS) };
}

/** One number: the first row's value, or for rows over time the latest one with the values before it. */
export function numberData(result: SqlResult, spec: ChartSpec): { value: number | null; trend: number[] } | { problem: string } {
  const yi = result.columns.findIndex((c) => c.name === spec.y?.[0]);
  if (yi < 0) return { problem: 'Pick a numeric column to show.' };
  const ti = result.columns.findIndex((c) => kindOf(c) === 'time');
  if (ti >= 0 && result.rows.length > 1) {
    const pts = result.rows.map((r) => [parseTime(r[ti]), num(r[yi])] as const).filter((p): p is readonly [number, number] => p[0] !== null && p[1] !== null).sort((a, b) => a[0] - b[0]);
    return { value: pts.at(-1)?.[1] ?? null, trend: pts.map((p) => p[1]) };
  }
  return { value: num(result.rows[0]?.[yi]), trend: [] };
}

/** The spec as a tile saves it: only what was chosen. */
export function tileSql(query: string, spec: ChartSpec): SqlTileQuery {
  const out: SqlTileQuery = { query };
  if (spec.x) out.x = spec.x;
  if (spec.y?.length) out.y = spec.y;
  if (spec.series && (TIME_VIZ.has(spec.viz) || spec.viz === 'columns' || spec.viz === 'scatter')) out.series = spec.series;
  if (spec.unit) out.unit = spec.unit as TileUnit;
  return out;
}

const label = (v: unknown) => (v === null || v === undefined ? '(null)' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export interface CategoryData {
  categories: string[];
  series: Array<{ key: string; label: string; values: Array<number | null> }>;
  hidden: number; // categories past MAX_BARS, or series past MAX_SERIES
  stacked: boolean;
}

/** Rows as bars per category (in the query's order): one series per y column, or per value of the series column (stacked). */
export function categoryData(result: SqlResult, spec: ChartSpec): CategoryData | { problem: string } {
  const idx = (name?: string) => (name ? result.columns.findIndex((c) => c.name === name) : -1);
  const xi = idx(spec.x);
  const ys = (spec.y ?? []).map(idx).filter((i) => i >= 0);
  if (!ys.length) return { problem: 'Pick a numeric column for the bars.' };
  if (xi < 0) return { problem: 'Pick a column for the categories.' };
  const si = spec.series && ys.length === 1 ? idx(spec.series) : -1;
  const cats: string[] = [];
  const at = new Map<string, number>();
  const cells = new Map<string, Map<number, number>>();
  let hiddenCats = 0;
  for (const row of result.rows) {
    const c = label(row[xi]);
    if (!at.has(c)) {
      if (cats.length >= MAX_BARS) { hiddenCats++; continue; }
      at.set(c, cats.length);
      cats.push(c);
    }
    const ci = at.get(c)!;
    const add = (key: string, v: number | null) => {
      if (v === null) return;
      const m = cells.get(key) ?? new Map<number, number>();
      m.set(ci, (m.get(ci) ?? 0) + v);
      cells.set(key, m);
    };
    if (si >= 0) add(label(row[si]), num(row[ys[0]]));
    else for (const y of ys) add(result.columns[y].name, num(row[y]));
  }
  let keys = si >= 0 ? [...cells.keys()] : ys.map((y) => result.columns[y].name);
  if (si >= 0) {
    const total = (k: string) => [...cells.get(k)!.values()].reduce((a, b) => a + Math.abs(b), 0);
    keys.sort((a, b) => total(b) - total(a));
  }
  const hiddenSeries = Math.max(0, keys.length - MAX_SERIES);
  keys = keys.slice(0, MAX_SERIES);
  return {
    categories: cats,
    series: keys.map((k) => ({ key: k, label: k, values: cats.map((_, i) => cells.get(k)?.get(i) ?? null) })),
    hidden: hiddenCats + hiddenSeries,
    stacked: si >= 0,
  };
}

export interface PieData { slices: Array<{ key: string; label: string; value: number; other?: number }>; total: number; dropped: number } // other: how many values it folds

/** Shares of a whole: the biggest MAX_SLICES - 1 values and "Other" for the rest. Negative values can't be shares. */
export function pieData(result: SqlResult, spec: ChartSpec): PieData | { problem: string } {
  const xi = result.columns.findIndex((c) => c.name === spec.x);
  const yi = result.columns.findIndex((c) => c.name === spec.y?.[0]);
  if (yi < 0) return { problem: 'Pick a numeric column for the size of the slices.' };
  if (xi < 0) return { problem: 'Pick a column for the slice names.' };
  const by = new Map<string, number>();
  let dropped = 0;
  for (const r of result.rows) {
    const v = num(r[yi]);
    if (v === null || v < 0) { if (v !== null) dropped++; continue; }
    const k = label(r[xi]);
    by.set(k, (by.get(k) ?? 0) + v);
  }
  const all = [...by].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!all.length) return { problem: dropped ? 'A pie shows shares, and every value is negative.' : 'Nothing to show: every value is 0.' };
  const keep = all.length > MAX_SLICES ? all.slice(0, MAX_SLICES - 1) : all;
  const rest = all.slice(keep.length);
  const slices: PieData['slices'] = keep.map(([k, v]) => ({ key: k, label: k, value: v }));
  if (rest.length) slices.push({ key: '\u0000other', label: 'Other', value: rest.reduce((a, [, v]) => a + v, 0), other: rest.length });
  return { slices, total: all.reduce((a, [, v]) => a + v, 0), dropped };
}

export interface ScatterData {
  points: Array<{ x: number; y: number; group: number; label: string }>;
  groups: string[]; // color groups (empty without a color column)
  hidden: number;
}

/** One dot per row: a numeric column against another, colored by a category column. */
export function scatterData(result: SqlResult, spec: ChartSpec): ScatterData | { problem: string } {
  const xi = result.columns.findIndex((c) => c.name === spec.x);
  const yi = result.columns.findIndex((c) => c.name === spec.y?.[0]);
  if (xi < 0 || yi < 0 || xi === yi) return { problem: 'A scatter plot needs two numeric columns, one for each axis.' };
  const gi = spec.series ? result.columns.findIndex((c) => c.name === spec.series) : -1;
  // the label of a dot: the first text column that isn't the color
  const li = result.columns.findIndex((c, i) => kindOf(c) === 'text' && i !== gi);
  const counts = new Map<string, number>();
  if (gi >= 0) for (const r of result.rows) counts.set(label(r[gi]), (counts.get(label(r[gi])) ?? 0) + 1);
  let groups = [...counts].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const folded = groups.length > MAX_SERIES;
  if (folded) groups = [...groups.slice(0, MAX_SERIES - 1), 'Other'];
  const gIndex = new Map(groups.map((g, i) => [g, i]));
  const points: ScatterData['points'] = [];
  let hidden = 0;
  for (const r of result.rows) {
    const x = num(r[xi]), y = num(r[yi]);
    if (x === null || y === null) continue;
    if (points.length >= MAX_POINTS) { hidden++; continue; }
    const g = gi >= 0 ? gIndex.get(label(r[gi])) ?? groups.length - 1 : 0;
    points.push({ x, y, group: g, label: li >= 0 ? label(r[li]) : gi >= 0 ? label(r[gi]) : '' });
  }
  if (!points.length) return { problem: 'No rows with numbers in both columns.' };
  return { points, groups, hidden };
}
