import type { CostsResponse, UptimeBucket, UptimeCheck, UptimeIncident, UptimeResults } from '../api/contract';
import { hash, rnd } from './rng';

/** Mock uptime checks: results are generated from the check's id and the clock, so they look the same on every load. */
const MIN = 60_000;

export interface MockCheck extends UptimeCheck {
  /** the demo check that had a recent outage (minutes ago: start, end) */
  incidentAgo?: [number, number];
}

export function seedChecks(now: number): MockCheck[] {
  const base = { method: 'GET' as const, expect: '2xx', keyword: null, intervalSeconds: 300 as const, timeoutMs: 10000, enabled: true, createdBy: 'demo@acme.dev', failStreak: 0, strip: [] };
  const mk = (id: string, name: string, url: string, over: Partial<MockCheck> = {}): MockCheck => ({
    ...base, id, name, url, state: 'up', stateSince: new Date(now - 6 * 86400e3).toISOString(), lastCheckedAt: null, lastStatus: 200, lastError: null,
    lastDurationMs: 180, createdAt: new Date(now - 20 * 86400e3).toISOString(), ...over,
  });
  return [
    mk('chk_site', 'Marketing site', 'https://acme.dev/'),
    mk('chk_api', 'API health', 'https://api.acme.dev/health', { intervalSeconds: 60, incidentAgo: [215, 190], stateSince: new Date(now - 190 * MIN).toISOString(), lastDurationMs: 92 }),
    mk('chk_shop', 'Checkout page', 'https://shop.acme.dev/checkout', { keyword: 'Place order', intervalSeconds: 900, lastDurationMs: 410 }),
  ];
}

const seed = (c: { id: string }) => hash(...[...c.id].map((ch) => ch.charCodeAt(0)));
const baseMs = (c: { id: string }) => 80 + (seed(c) % 300);

const downAt = (c: MockCheck, t: number, now: number) => !!c.incidentAgo && t >= now - c.incidentAgo[0] * MIN && t < now - c.incidentAgo[1] * MIN;

/** The 12th bucket of one check: the share of successful runs and the response times. */
function bucketOf(c: MockCheck, t0: number, seconds: number, now: number): UptimeBucket | null {
  if (t0 + seconds * 1000 <= Date.parse(c.createdAt) || t0 > now) return null;
  const n = Math.max(1, Math.min(40, Math.round(seconds / c.intervalSeconds)));
  const times: number[] = [];
  let failures = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + (i / n) * seconds * 1000;
    if (t > now) break;
    if (downAt(c, t, now)) failures++;
    else times.push(baseMs(c) * (0.8 + rnd(seed(c), Math.floor(t / MIN)) * 0.5) * (rnd(seed(c), Math.floor(t / MIN), 9) > 0.97 ? 3 : 1));
  }
  const total = failures + times.length;
  if (!total) return null;
  times.sort((a, b) => a - b);
  const q = (p: number) => (times.length ? times[Math.min(times.length - 1, Math.floor(p * times.length))] : null);
  return { t: new Date(t0).toISOString(), checks: total, failures, uptime: (total - failures) / total, p50: q(0.5), p95: q(0.95) };
}

const bucketSize = (from: number, to: number, count: number) => Math.max(60, Math.ceil((to - from) / 1000 / count));
const buckets = (c: MockCheck, from: number, to: number, count: number, now: number): UptimeBucket[] => {
  const s = bucketSize(from, to, count);
  const first = Math.floor(from / 1000 / s) * s * 1000;
  const out: UptimeBucket[] = [];
  for (let t = first; t < to; t += s * 1000) {
    const b = bucketOf(c, t, s, now);
    out.push(b ?? { t: new Date(t).toISOString(), checks: 0, failures: 0, uptime: null, p50: null, p95: null });
  }
  return out;
};

/** The check as the API returns it: live state and the 90-bucket strip over the range. */
export function present(c: MockCheck, from: number, to: number, now: number): UptimeCheck {
  const bs = buckets(c, from, to, 90, now);
  const strip = Array.from({ length: 90 }, (_, i) => bs[i]?.uptime ?? null);
  return { ...c, incidentAgo: undefined, strip, lastCheckedAt: c.enabled ? new Date(now - ((hash(seed(c)) % 50) + 5) * 1000).toISOString() : c.lastCheckedAt } as UptimeCheck;
}

export function resultsFor(c: MockCheck, from: number, to: number, now: number): UptimeResults {
  const bs = buckets(c, from, to, 90, now).filter((b) => b.checks > 0);
  const checks = bs.reduce((a, b) => a + b.checks, 0);
  const failures = bs.reduce((a, b) => a + b.failures, 0);
  const weighted = (k: 'p50' | 'p95') => {
    const v = bs.filter((b) => b[k] !== null).map((b) => b[k]!).sort((a, b) => a - b);
    return v.length ? v[Math.floor((k === 'p50' ? 0.5 : 0.95) * (v.length - 1))] : null;
  };
  const incidents: UptimeIncident[] = [];
  if (c.incidentAgo) {
    const s = now - c.incidentAgo[0] * MIN, e = now - c.incidentAgo[1] * MIN;
    if (e > from && s < to) incidents.push({ from: new Date(s).toISOString(), to: new Date(e).toISOString(), error: 'expected 2xx, got 503' });
  }
  return { buckets: bs, incidents, uptime: checks ? (checks - failures) / checks : null, p50: weighted('p50'), p95: weighted('p95') };
}

/** A believable small install: about 1.2M events this month. */
export function mockCosts(pid: string, now: number, setup: boolean): CostsResponse {
  const fetchedAt = new Date(now - 3 * 3600e3).toISOString();
  if (setup) {
    return { setup: true, reason: 'Cost Explorer returned no costs for this stack yet.', currency: 'USD', monthToDate: 0, lastMonth: 0, daily: [], services: [], usage: { eventsThisMonth: 0, dataBucketBytes: null, dsqlStorageBytes: null }, fetchedAt };
  }
  const d = new Date(now);
  const dom = d.getUTCDate();
  const daily = Array.from({ length: 30 }, (_, i) => {
    const t = now - (29 - i) * 86400e3;
    return { day: new Date(t).toISOString().slice(0, 10), amount: Math.round((0.085 + rnd(7, Math.floor(t / 86400e3)) * 0.03 + ([0, 6].includes(new Date(t).getUTCDay()) ? -0.02 : 0)) * 1000) / 1000 };
  });
  const monthPrefix = new Date(now).toISOString().slice(0, 7);
  const monthToDate = Math.round(daily.filter((x) => x.day.startsWith(monthPrefix)).reduce((a, b) => a + b.amount, 0) * 100) / 100;
  const parts: Array<[string, number]> = [['Amazon Aurora DSQL', 0.38], ['AWS Lambda', 0.22], ['Amazon CloudFront', 0.14], ['Amazon S3', 0.1], ['Amazon API Gateway', 0.08], ['Amazon SQS', 0.05], ['Other', 0.03]];
  const eventsThisMonth = 1_240_000;
  const projectEvents = pid === 'prj_demo' ? 472_000 : 150_000;
  return {
    setup: false, currency: 'USD', monthToDate, lastMonth: 3.12,
    forecast: Math.round((monthToDate / Math.max(1, dom)) * new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() * 100) / 100,
    daily, services: parts.map(([service, share]) => ({ service, amount: Math.round(monthToDate * share * 100) / 100 })),
    usage: { eventsThisMonth, projectEventsThisMonth: projectEvents, dataBucketBytes: 3.4e9, dsqlStorageBytes: 0.21e9 }, fetchedAt,
  };
}
