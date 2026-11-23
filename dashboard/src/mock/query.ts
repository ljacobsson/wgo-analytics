import type { MeasureNames, MeasureQuery, QueryMeasureResult, QueryResult, QuerySpec } from '../api/contract';
import { CLICKS, CUSTOM, SERVICES } from './universe';
import { metricList } from './data';
import { rate, rnd } from './rng';

/**
 * Mock of GET /query: believable, deterministic numbers for any measure. Counts follow the same day/week curve as
 * the rest of the mock; averages and percentiles wobble around a level that suits the field; shares stay in 0..1.
 */

const BUCKETS = [60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400];
const pickBucket = (from: number, to: number) => BUCKETS.find((b) => (to - from) / 1000 / b <= 120) ?? 86400;

const strHash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return h >>> 0; };

const GROUPS: Record<string, string[]> = {
  country: ['US', 'DE', 'SE', 'GB', 'FR', 'NL', 'IN', 'BR', 'CA', 'JP'],
  path: ['/', '/pricing', '/docs', '/signup', '/blog', '/checkout', '/product/42', '/about'],
  browser: ['Chrome', 'Safari', 'Firefox', 'Edge', 'Samsung Internet'],
  os: ['Windows', 'macOS', 'iOS', 'Android', 'Linux'],
  device: ['desktop', 'mobile', 'tablet'],
  referrer: ['(direct)', 'google.com', 'news.ycombinator.com', 't.co', 'github.com'],
  type: ['click', 'pageview', 'vitals', 'custom', 'http_error', 'error'],
  service: SERVICES,
  name: [...CUSTOM, 'GET /api/products', 'POST /api/cart'],
  trackName: CLICKS.map((c) => c.track).filter((x): x is string => !!x),
  severityText: ['INFO', 'WARN', 'ERROR', 'DEBUG'],
  httpRoute: ['/api/cart', '/api/products/:id', '/api/checkout', '/api/search'],
  httpStatus: ['500', '404', '502', '401', '0'],
  errorMessage: ["TypeError: Cannot read properties of undefined (reading 'price')", 'ResizeObserver loop limit exceeded', 'ChunkLoadError: Loading chunk 7 failed'],
  region: ['eu-north-1', 'us-east-1', 'ap-southeast-2'],
  statusCode: ['0', '1', '2'],
};
const groupsFor = (field: string, checks: string[]) =>
  field === 'checkId' ? checks : GROUPS[field] ?? GROUPS[field.split('.').pop() ?? ''] ?? ['alpha', 'beta', 'gamma', 'delta'];

const COUNT = { count: 1, sessions: 0.32, users: 0.24, sum: 1 } as Record<string, number>;
/** Level of a non-additive measure, by field. */
function level(m: MeasureQuery): number {
  const f = m.field ?? (m.source === 'checks' ? (m.agg === 'rate' ? 'ok' : 'durationMs') : 'value');
  if (m.agg === 'session_rate') return 0.04 + 0.1 * rnd(strHash(JSON.stringify(m.filters ?? [])));
  if (m.agg === 'rate') return 0.996;
  const q = m.agg === 'p99' ? 2.4 : m.agg === 'p95' ? 1.8 : m.agg === 'p75' ? 1.25 : m.agg === 'p50' ? 0.85 : m.agg === 'max' ? 3 : m.agg === 'min' ? 0.2 : 1;
  if (m.source === 'metrics') return (metricList(Date.now()).find((x) => x.name === m.metric) ? 1 : 0.5) * (m.metric?.includes('cpu') ? 0.3 : m.metric?.includes('memory') ? 400 : 80) * q;
  const base: Record<string, number> = { 'props.lcp': 2100, 'props.inp': 170, 'props.cls': 0.07, 'props.fcp': 1200, 'props.ttfb': 380, durationMs: m.source === 'checks' ? 190 : m.source === 'spans' ? 85 : 640, severityNumber: 11, httpStatus: 470 };
  return (base[f] ?? 50) * q;
}

function one(m: MeasureQuery, spec: QuerySpec, from: number, to: number, bucket: number, checks: string[], filtered: boolean): QueryMeasureResult {
  const seed = strHash(JSON.stringify(m));
  const additive = m.agg in COUNT;
  // events per hour of this measure at peak
  const scale = (m.source === 'events' ? (m.filters?.some((x) => x.value === 'error' || x.value === 'http_error') ? 6 : m.filters?.length ? 120 : 420)
    : m.source === 'spans' ? (m.filters?.length ? 14 : 900) : m.source === 'logs' ? (m.filters?.length ? 9 : 260) : m.source === 'checks' ? 12 : 60)
    * (COUNT[m.agg] ?? 1) * (filtered && m.source === 'events' ? 0.3 : 1) * (0.7 + 0.6 * rnd(seed));
  const valueAt = (t: number, k: number, groupShare: number): number | null => {
    if (additive) return Math.round(scale * groupShare * (rate(t) / 0.25) * (bucket / 3600) * (0.8 + 0.4 * rnd(seed, k, t / 1000)));
    if (m.agg === 'session_rate' || m.agg === 'rate') return Math.min(1, level(m) * (0.85 + 0.3 * rnd(seed, k, t / 1000)) * (m.agg === 'rate' ? 1 : 1 + 0.4 * (groupShare - 0.2)));
    if (rnd(seed, 7, t / 1000) < 0.03) return null;
    return level(m) * (0.8 + 0.4 * rnd(seed, k, t / 1000)) * (1 + 0.5 * (k % 3) * 0.3);
  };
  const keys = spec.groupBy ? groupsFor(spec.groupBy, checks) : [''];
  const shares = keys.map((_, i) => (spec.groupBy ? Math.pow(0.62, i) * (0.8 + 0.4 * rnd(seed, i)) : 1));
  const norm = shares.reduce((a, b) => a + b, 0);
  const starts: number[] = [];
  for (let t = Math.floor(from / 1000 / bucket) * bucket * 1000; t < to; t += bucket * 1000) starts.push(t);
  const per = keys.map((_, i) => starts.map((t) => valueAt(t, i, shares[i] / norm)));
  const agg = (vals: Array<number | null>) => {
    const v = vals.filter((x): x is number => x != null);
    if (!v.length) return additive ? 0 : null;
    return additive ? v.reduce((a, b) => a + b, 0) : v.reduce((a, b) => a + b, 0) / v.length;
  };
  const totals = per.map(agg);
  const total = additive ? totals.reduce<number>((a, b) => a + (b ?? 0), 0) : agg(per.flat());
  const lim = Math.min(spec.limit ?? (spec.shape === 'top' ? 10 : 5), spec.shape === 'top' ? 50 : 10);
  const order = keys.map((k, i) => ({ k, i, v: totals[i] })).sort((a, b) => (b.v ?? -1) - (a.v ?? -1)).slice(0, lim);
  const out: QueryMeasureResult = { total };
  if (spec.compare) out.previous = total == null ? null : additive ? Math.round(total * (0.82 + 0.3 * rnd(seed, 99))) : total * (0.9 + 0.2 * rnd(seed, 98));
  if (spec.groupBy) out.groups = order.map((o) => ({ key: o.k, value: o.v }));
  if (spec.shape === 'series') {
    out.series = (spec.groupBy ? order : [{ k: '', i: 0 }]).map((o) => ({ key: o.k, points: starts.map((t, j) => ({ t: new Date(t).toISOString(), value: per[o.i][j] })) }));
  }
  return out;
}

export function query(spec: QuerySpec, from: number, to: number, checks: Array<{ id: string; name: string }>, filtered: boolean): QueryResult {
  const bucket = pickBucket(from, to);
  const measures = spec.measures.map((m) => one(m, spec, from, to, bucket, checks.map((c) => c.id), filtered));
  // like the API: uptime checks are named
  if (spec.groupBy === 'checkId') {
    const names = new Map(checks.map((c) => [c.id, c.name]));
    for (const m of measures) for (const g of [...(m.groups ?? []), ...(m.series ?? [])]) if (names.has(g.key)) g.label = names.get(g.key);
  }
  return { bucketSeconds: spec.shape === 'series' ? bucket : 0, measures };
}

export function measureNames(): MeasureNames {
  const metrics = new Map<string, MeasureNames['metrics'][number]>();
  for (const m of metricList(Date.now())) if (!metrics.has(m.name)) metrics.set(m.name, { name: m.name, type: m.type, unit: m.unit, description: m.description });
  return {
    trackedClicks: [...new Set(CLICKS.map((c) => c.track).filter((x): x is string => !!x))],
    customEvents: [...CUSTOM],
    metrics: [...metrics.values()],
  };
}
