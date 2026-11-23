import { useMemo } from 'react';
import type { Filter, Goal, MeasureNames, MeasureQuery, QueryAgg, QuerySource, TileMeasure, TileUnit, TileViz, UptimeCheck } from '../api/contract';
import { useGoals, useMeasureNames, useUptime } from '../api/hooks';
import { fieldLabel } from '../lib/filters';
import { fmtMs, fmtNum } from '../lib/format';
import type { TimeRange } from '../lib/time';

/**
 * The measure catalog: everything a dashboard can show, by name. Picking "LCP p75" or "Failed API calls" is the
 * whole job for most tiles; the source/aggregation/field underneath only shows up under "Customize".
 */

export type Category = 'Traffic' | 'Engagement' | 'Goals' | 'Reliability' | 'Web Vitals' | 'Backend' | 'Metrics' | 'Uptime';
export const CATEGORIES: Category[] = ['Traffic', 'Engagement', 'Goals', 'Reliability', 'Web Vitals', 'Backend', 'Metrics', 'Uptime'];

export interface MeasureDef {
  id: string;
  label: string;
  category: Category;
  description: string;
  measure: TileMeasure; // carries label, unit and better
  viz: TileViz; // how it reads best on its own
  splits: string[]; // the "split by" fields offered first
}

const f = (field: string, value: string, op: Filter['op'] = 'eq'): Filter => ({ field, op, value });
const type = (t: string) => [f('type', t)];

const WEB_SPLITS = ['path', 'country', 'device', 'browser', 'os', 'referrer'];
const def = (id: string, category: Category, label: string, description: string, m: MeasureQuery, unit: TileUnit, better: 'up' | 'down' | undefined, viz: TileViz, splits: string[]): MeasureDef => ({
  id, category, label, description, viz, splits, measure: { ...m, label, unit, ...(better ? { better } : {}) },
});

const vital = (k: string, name: string, unit: TileUnit) =>
  def(`vital:${k}`, 'Web Vitals', `${k.toUpperCase()} p75`, `${name}, 75th percentile of real page loads`,
    { source: 'events', agg: 'p75', field: `props.${k}`, filters: type('vitals') }, unit, 'down', 'line', ['path', 'device', 'country', 'browser']);

export const BUILTIN: MeasureDef[] = [
  def('pageviews', 'Traffic', 'Pageviews', 'Page loads and SPA navigations', { source: 'events', agg: 'count', filters: type('pageview') }, 'count', 'up', 'area', WEB_SPLITS),
  def('sessions', 'Traffic', 'Sessions', 'Distinct browser sessions', { source: 'events', agg: 'sessions' }, 'count', 'up', 'area', WEB_SPLITS),
  def('visitors', 'Traffic', 'Visitors', 'Distinct anonymous visitors', { source: 'events', agg: 'users' }, 'count', 'up', 'area', WEB_SPLITS),
  def('events', 'Traffic', 'All events', 'Every captured event', { source: 'events', agg: 'count' }, 'count', undefined, 'bars', ['type', ...WEB_SPLITS]),
  def('clicks', 'Engagement', 'Clicks', 'All captured clicks', { source: 'events', agg: 'count', filters: type('click') }, 'count', 'up', 'bars', ['trackName', 'elementText', 'path', 'device']),
  def('custom', 'Engagement', 'Custom events', 'Events sent with wgo.track()', { source: 'events', agg: 'count', filters: type('custom') }, 'count', undefined, 'bars', ['name', 'path', 'country']),
  def('errors', 'Reliability', 'JS errors', 'Uncaught errors and unhandled rejections', { source: 'events', agg: 'count', filters: type('error') }, 'count', 'down', 'bars', ['errorMessage', 'path', 'browser', 'os']),
  def('error-sessions', 'Reliability', 'Sessions with errors', 'Share of sessions that hit a JS error', { source: 'events', agg: 'session_rate', filters: type('error') }, 'percent', 'down', 'line', ['path', 'browser', 'device', 'country']),
  def('http-errors', 'Reliability', 'Failed API calls', 'HTTP 4xx/5xx responses and network failures seen in the browser', { source: 'events', agg: 'count', filters: type('http_error') }, 'count', 'down', 'bars', ['httpRoute', 'httpStatus', 'httpMethod', 'path']),
  def('http-error-ms', 'Reliability', 'Failed call duration p95', 'How long failing API calls took, 95th percentile', { source: 'events', agg: 'p95', field: 'durationMs', filters: type('http_error') }, 'ms', 'down', 'line', ['httpRoute', 'httpStatus']),
  vital('lcp', 'Largest Contentful Paint', 'ms'),
  vital('inp', 'Interaction to Next Paint', 'ms'),
  vital('cls', 'Cumulative Layout Shift', 'score'),
  vital('fcp', 'First Contentful Paint', 'ms'),
  vital('ttfb', 'Time to First Byte', 'ms'),
  def('spans', 'Backend', 'Spans', 'Operations reported by your services', { source: 'spans', agg: 'count' }, 'count', undefined, 'bars', ['service', 'name']),
  def('span-p95', 'Backend', 'Span latency p95', 'Span duration, 95th percentile', { source: 'spans', agg: 'p95', field: 'durationMs' }, 'ms', 'down', 'line', ['service', 'name']),
  def('span-p50', 'Backend', 'Span latency p50', 'Span duration, median', { source: 'spans', agg: 'p50', field: 'durationMs' }, 'ms', 'down', 'line', ['service', 'name']),
  def('span-errors', 'Backend', 'Failed spans', 'Spans with error status', { source: 'spans', agg: 'count', filters: [f('statusCode', '2')] }, 'count', 'down', 'bars', ['service', 'name', 'statusMessage']),
  def('logs', 'Backend', 'Log volume', 'Log records from your services', { source: 'logs', agg: 'count' }, 'count', undefined, 'bars', ['service', 'severityText']),
  def('error-logs', 'Backend', 'Error logs', 'Log records at ERROR or above', { source: 'logs', agg: 'count', filters: [f('severityNumber', '17', 'gte')] }, 'count', 'down', 'bars', ['service', 'severityText']),
  def('uptime', 'Uptime', 'Uptime (all checks)', 'Share of check runs that succeeded', { source: 'checks', agg: 'rate', field: 'ok' }, 'percent', 'up', 'number', ['checkId', 'region']),
  def('uptime-p95', 'Uptime', 'Response time p95 (all checks)', 'Check response time, 95th percentile', { source: 'checks', agg: 'p95', field: 'durationMs' }, 'ms', 'down', 'line', ['checkId', 'region']),
];

/** OpenTelemetry unit → how to show it. */
export function otelUnit(u: string | null): TileUnit {
  if (!u) return 'none';
  if (u === 'ms') return 'ms';
  if (u === 's') return 's';
  if (u === 'By') return 'bytes';
  if (u === '1') return 'none';
  return 'none';
}

function dynamic(names: MeasureNames | undefined, goals: Goal[] | undefined, checks: UptimeCheck[] | undefined): MeasureDef[] {
  const out: MeasureDef[] = [];
  for (const g of goals ?? []) {
    out.push(def(`goal:${g.id}`, 'Goals', `${g.name} conversion`, 'Share of sessions that converted', { source: 'events', agg: 'session_rate', filters: g.filters }, 'percent', 'up', 'number', ['device', 'country', 'browser', 'referrer']));
    out.push(def(`goal-n:${g.id}`, 'Goals', `${g.name} conversions`, 'Sessions that converted', { source: 'events', agg: 'sessions', filters: g.filters }, 'count', 'up', 'bars', ['device', 'country', 'path', 'referrer']));
  }
  for (const n of names?.trackedClicks ?? []) {
    out.push(def(`track:${n}`, 'Engagement', n, `Clicks on data-track="${n}"`, { source: 'events', agg: 'count', filters: [f('trackName', n)] }, 'count', 'up', 'bars', ['path', 'device', 'country']));
  }
  for (const n of names?.customEvents ?? []) {
    out.push(def(`event:${n}`, 'Engagement', n, 'Custom event', { source: 'events', agg: 'count', filters: [f('type', 'custom'), f('name', n)] }, 'count', undefined, 'bars', ['path', 'device', 'country']));
  }
  for (const m of names?.metrics ?? []) {
    out.push(def(`metric:${m.name}`, 'Metrics', m.name, m.description || `OpenTelemetry ${m.type}${m.unit ? ` in ${m.unit}` : ''}`,
      { source: 'metrics', agg: 'avg', metric: m.name }, otelUnit(m.unit), undefined, 'line', ['service']));
  }
  for (const c of checks ?? []) {
    out.push(def(`check:${c.id}`, 'Uptime', `${c.name} uptime`, `Share of runs of ${c.url} that succeeded`, { source: 'checks', agg: 'rate', field: 'ok', filters: [f('checkId', c.id)] }, 'percent', 'up', 'number', ['region']));
    out.push(def(`check-ms:${c.id}`, 'Uptime', `${c.name} response time p95`, `Response time of ${c.url}, 95th percentile`, { source: 'checks', agg: 'p95', field: 'durationMs', filters: [f('checkId', c.id)] }, 'ms', 'down', 'line', ['region']));
  }
  return out;
}

/** The whole catalog for a project, built-ins first. */
export function useMeasureCatalog(pid: string, range: TimeRange) {
  const names = useMeasureNames(pid);
  const goals = useGoals(pid);
  const checks = useUptime(pid, range);
  const list = useMemo(() => [...BUILTIN, ...dynamic(names.data, goals.data, checks.data)], [names.data, goals.data, checks.data]);
  return { list, loading: names.isPending || goals.isPending };
}

const sameFilters = (a: Filter[] = [], b: Filter[] = []) => JSON.stringify(a) === JSON.stringify(b);
/** The catalog entry a measure came from, if it still matches one exactly. */
export const findDef = (list: MeasureDef[], m: MeasureQuery) =>
  list.find((d) => d.measure.source === m.source && d.measure.agg === m.agg && (d.measure.field ?? '') === (m.field ?? '')
    && (d.measure.metric ?? '') === (m.metric ?? '') && sameFilters(d.measure.filters, m.filters));

// ---------------------------------------------------------------- the vocabulary under "Customize"

export const SOURCES: Array<{ value: QuerySource; label: string; hint: string }> = [
  { value: 'events', label: 'Web events', hint: 'pageviews, clicks, errors, vitals, custom events' },
  { value: 'spans', label: 'Spans', hint: 'OpenTelemetry traces' },
  { value: 'logs', label: 'Logs', hint: 'OpenTelemetry logs' },
  { value: 'metrics', label: 'Metric', hint: 'one OpenTelemetry metric' },
  { value: 'checks', label: 'Uptime checks', hint: 'check runs' },
];
export const AGG_LABEL: Record<QueryAgg, string> = {
  count: 'Count', sessions: 'Sessions', users: 'Visitors', session_rate: 'Share of sessions', sum: 'Sum', avg: 'Average',
  min: 'Minimum', max: 'Maximum', p50: 'Median (p50)', p75: 'p75', p95: 'p95', p99: 'p99', rate: 'Rate (of a 1/0 field)',
};
export const NEEDS_FIELD = (agg: QueryAgg, source: QuerySource) =>
  !['count', 'sessions', 'users', 'session_rate'].includes(agg) && source !== 'metrics' && !(source === 'checks');
export const aggsFor = (source: QuerySource): QueryAgg[] =>
  source === 'events' ? ['count', 'sessions', 'users', 'session_rate', 'sum', 'avg', 'min', 'max', 'p50', 'p75', 'p95', 'p99']
    : source === 'checks' ? ['count', 'rate', 'avg', 'min', 'max', 'p50', 'p95', 'p99']
      : ['count', 'sum', 'avg', 'min', 'max', 'p50', 'p75', 'p95', 'p99'];
/** Numeric fields to aggregate, per source (JSON properties can be typed). */
export const NUMERIC_FIELDS: Record<QuerySource, string[]> = {
  events: ['durationMs', 'httpStatus', 'props.lcp', 'props.inp', 'props.cls', 'props.fcp', 'props.ttfb'],
  spans: ['durationMs'],
  logs: ['severityNumber'],
  metrics: ['value'],
  checks: ['durationMs', 'ok', 'status'],
};
/** What the split-by picker offers when the catalog entry has no suggestions. */
export const DEFAULT_SPLITS: Record<QuerySource, string[]> = {
  events: ['type', ...WEB_SPLITS, 'name', 'trackName'],
  spans: ['service', 'name', 'statusCode'],
  logs: ['service', 'severityText'],
  metrics: ['service'],
  checks: ['checkId', 'region'],
};

/** A readable name for a measure that isn't (or is no longer) a catalog entry. */
export function describeMeasure(m: MeasureQuery): string {
  const src = m.source === 'metrics' ? m.metric ?? 'metric' : SOURCES.find((s) => s.value === m.source)?.label ?? m.source;
  const field = m.field && m.source !== 'metrics' ? ` of ${fieldLabel(m.field)}` : '';
  const agg = m.agg === 'count' ? '' : `${AGG_LABEL[m.agg]}${field} · `;
  const where = m.filters?.length ? ` where ${m.filters.map((x) => `${fieldLabel(x.field)} ${x.op === 'eq' ? '=' : x.op} ${x.value ?? ''}`.trim()).join(', ')}` : '';
  return `${agg}${src}${where}`;
}

export const measureLabel = (m: TileMeasure) => m.label || describeMeasure(m);

// ---------------------------------------------------------------- formatting values

export function fmtBytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
export function formatter(unit: TileUnit | undefined): (n: number) => string {
  switch (unit) {
    case 'ms': return fmtMs;
    case 's': return (n) => fmtMs(n * 1000);
    case 'bytes': return fmtBytes;
    case 'percent': return (n) => `${(n * 100).toFixed(n >= 0.995 || n === 0 ? 0 : n < 0.1 ? 2 : 1)}%`;
    case 'score': return (n) => n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    default: return fmtNum;
  }
}
/** Axis labels: short, and percent as 0-100. */
export function axisFormatter(unit: TileUnit | undefined): (n: number) => string {
  if (unit === 'percent') return (n) => `${Math.round(n * 100)}%`;
  if (unit === 'ms' || unit === 's' || unit === 'bytes') return formatter(unit);
  if (unit === 'score') return (n) => String(Math.round(n * 100) / 100);
  return fmtNum;
}
