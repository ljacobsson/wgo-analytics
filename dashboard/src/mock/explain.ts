import type { ExplainDriver, ExplainMetric, Explanation, Filter, Goal } from '../api/contract';
import { stats, totalsFor } from './data';
import { releases } from './releases';

/**
 * Mock "why did this change?": numbers from the mock totals, drivers that fit the mock story (release 2.8.1, five
 * hours old, broke the cart on /checkout in Safari), and the same summary wording as the backend.
 */
const KEY: Record<string, 'errors' | 'httpErrors' | 'pageviews' | 'clicks'> = { error: 'errors', http_error: 'httpErrors', pageview: 'pageviews', click: 'clicks' };

const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;

export function explain(p: { metric: ExplainMetric; where: Filter[]; goalId?: string; label?: string; from: number; to: number; goals: Goal[] }): Explanation {
  const span = p.to - p.from;
  const type = p.where.find((f) => f.field === 'type')?.value;
  const now = Date.now();
  const rel = releases(p.from, p.to, p.goals, true).markers.filter((m) => m.kind === 'web').pop() ?? null;
  // the same numbers the Overview shows (stats of the range, and its previous window)
  const st = stats(p.from, p.to);
  const cur = st.totals, prev = st.previous ?? totalsFor(p.from - span, p.from);
  const s = stats(p.from - span, p.to);
  const label = p.label ?? (type === 'error' ? 'Errors' : type === 'http_error' ? 'Failed requests' : type === 'pageview' ? 'Pageviews' : type === 'click' ? 'Clicks' : 'Sessions');

  if (p.metric === 'goal') {
    const g = p.goals.find((x) => x.id === p.goalId);
    const rc = 0.031, rb = 0.044;
    const drivers: ExplainDriver[] = [
      { dim: 'release', key: '2.8.1', current: Math.round(cur.sessions * 0.3), previous: 0, share: 0.71, before: 0, rate: { current: 0.012, previous: rb } },
      { dim: 'device', key: 'mobile', current: Math.round(cur.sessions * 0.45), previous: Math.round(prev.sessions * 0.44), share: 0.52, before: 0.44, rate: { current: 0.021, previous: 0.04 } },
    ];
    return {
      metric: 'goal', label: p.label ?? `${g?.name ?? 'Goal'} conversion`, current: rc, previous: rb, ratio: rc / rb, significant: true, startedAt: null, release: rel,
      drivers, bucketSeconds: s.bucketSeconds, series: [], baseFrom: new Date(p.from - span).toISOString(), from: new Date(p.from).toISOString(),
      summary: `${p.label ?? `${g?.name ?? 'Goal'} conversion`} is down 30% (3.1% vs 4.4% before). The biggest drop is in release 2.8.1 (4.4% → 1.2%), mostly on mobile.${rel ? ` Release ${rel.version} was first seen at ${hhmm(rel.firstSeen)}, in this period.` : ''}`,
    };
  }

  const k = type ? KEY[type] : undefined;
  const c = k ? cur[k] : cur.sessions, b = k ? prev[k] : prev.sessions;
  const series = s.series.map((x) => ({ t: x.t, value: type ? (x as unknown as Record<string, number>)[type] ?? 0 : x.pageview }));
  const bad = type === 'error' || type === 'http_error';
  const significant = Math.abs(c - b) >= Math.max(5, 3 * Math.sqrt(c + b));
  const started = bad && rel && significant ? new Date(Date.parse(rel.firstSeen) + 3 * 60_000).toISOString() : null;
  const drivers: ExplainDriver[] = !significant ? [] : bad ? [
    { dim: 'release', key: '2.8.1', current: Math.round(c * 0.55), previous: 0, share: 0.9, before: 0 },
    { dim: 'path', key: '/checkout', current: Math.round(c * 0.5), previous: Math.round(b * 0.12), share: 0.78, before: 0.12 },
    { dim: 'browser', key: 'Safari', current: Math.round(c * 0.38), previous: Math.round(b * 0.18), share: 0.55, before: 0.18 },
    ...(type === 'error' ? [{ dim: 'error' as const, key: "TypeError: Cannot read properties of null (reading 'items')", current: Math.round(c * 0.45), previous: 0, share: 0.72, before: 0 }] : []),
  ] : [
    { dim: 'country', key: 'SE', current: Math.round(c * 0.2), previous: Math.round(b * 0.08), share: 0.6, before: 0.08 },
    { dim: 'path', key: '/pricing', current: Math.round(c * 0.15), previous: Math.round(b * 0.06), share: 0.42, before: 0.06 },
  ];
  const r = b ? c / b : null;
  const size = r == null ? '' : r >= 2 ? `up ${r.toFixed(1)}×` : r <= 0.5 ? `down ${Math.round((1 - r) * 100)}%` : `${c > b ? 'up' : 'down'} ${Math.round(Math.abs(r - 1) * 100)}%`;
  const how = `${label} are ${size} (${c.toLocaleString('en-US')} vs ${b.toLocaleString('en-US')} before).`;
  const summary = !significant ? `${how} That's within the normal ups and downs for numbers this size.`
    : drivers.length ? `${how} ${Math.round(drivers[0].share * 100)}% of the ${c > b ? 'increase' : 'decrease'} is ${drivers[0].dim === 'release' ? `in release ${drivers[0].key}` : drivers[0].dim === 'country' ? `from ${drivers[0].key}` : `on ${drivers[0].key}`}, mostly ${drivers[1].dim === 'path' ? `on ${drivers[1].key}` : `in ${drivers[1].key}`}.${started && rel ? ` It started around ${hhmm(started)}, 3 minutes after release ${rel.version} was first seen.` : ''}`
    : how;
  void now;
  return {
    metric: p.metric, label, current: c, previous: b, ratio: r, significant, startedAt: started, release: significant ? rel : null, drivers,
    bucketSeconds: s.bucketSeconds, series, baseFrom: new Date(p.from - span).toISOString(), from: new Date(p.from).toISOString(), summary,
  };
}
