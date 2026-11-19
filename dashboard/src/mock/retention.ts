import type { Goal, RetentionCohort, RetentionPeriod, RetentionResponse } from '../api/contract';
import { rnd } from './rng';

const DAY = 86400e3;
const CAP: Record<RetentionPeriod, number> = { day: 30, week: 26, month: 13 };
/** The mock nightly job has been running for this long. */
const DATA_DAYS = 200;

const SPLITS: Record<string, Array<[key: string, share: number, retention: number]>> = {
  device: [['desktop', 0.52, 1.18], ['mobile', 0.4, 0.78], ['tablet', 0.08, 0.9]],
  country: [['SE', 0.3, 1.25], ['DE', 0.22, 1.02], ['US', 0.2, 0.9], ['GB', 0.16, 0.95], ['Unknown', 0.12, 0.7]],
  source: [['(direct)', 0.34, 1.3], ['google.com', 0.32, 1.0], ['newsletter.acme.dev', 0.12, 1.35], ['twitter.com', 0.12, 0.68], ['news.ycombinator.com', 0.1, 0.55]],
};

export function periodStart(ms: number, p: RetentionPeriod): number {
  const d = new Date(ms);
  if (p === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const day = Math.floor(ms / DAY) * DAY;
  return p === 'day' ? day : day - ((d.getUTCDay() + 6) % 7) * DAY;
}
export function addPeriods(start: number, p: RetentionPeriod, n: number): number {
  if (p === 'month') { const d = new Date(start); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1); }
  return start + n * (p === 'week' ? 7 : 1) * DAY;
}

/** Share of a cohort active k periods later: a fast drop, then a flat tail. */
const curve = (p: RetentionPeriod, k: number, mult: number, goalReturn: boolean) => {
  if (k === 0) return goalReturn ? 0.35 * Math.min(1.3, mult) : 1;
  const first = { day: 0.32, week: 0.38, month: 0.34 }[p];
  const tail = { day: 0.07, week: 0.14, month: 0.16 }[p];
  const v = (tail + (first - tail) * Math.exp(-(k - 1) / 2.2)) * mult;
  return Math.min(0.97, goalReturn ? v * 0.45 : v);
};

const round = (x: number) => Math.round(x * 10_000) / 10_000;

export function retention(params: URLSearchParams, now: number, goals: Goal[]): RetentionResponse {
  const p = (params.get('period') ?? 'week') as RetentionPeriod;
  const to = Date.parse(params.get('to') ?? '') || now;
  const from = Date.parse(params.get('from') ?? '') || to - 84 * DAY;
  const start = params.get('start') ?? 'first_seen';
  const ret = params.get('return') ?? 'any';
  const split = params.get('split') ?? 'none';
  const goalStart = start !== 'first_seen';
  const goalIdx = (id: string) => Math.max(0, goals.findIndex((g) => `goal:${g.id}` === id));

  const last = periodStart(Math.min(to, now), p);
  const first = Math.max(periodStart(from, p), addPeriods(last, p, -(CAP[p] - 1)));
  const dataStart = periodStart(now - DATA_DAYS * DAY, 'day');
  const groups = SPLITS[split] ?? [['', 1, 1] as [string, number, number]];
  const seed = (goalStart ? 7 + goalIdx(start) : 1) * 31 + (ret === 'any' ? 0 : 5 + goalIdx(ret));

  const perGroup = groups.map(([key, share, mult]) => {
    const rows: Array<{ start: number; size: number; counts: number[] }> = [];
    for (let c = first, i = 0; c <= last; c = addPeriods(c, p, 1), i++) {
      const base = { day: 70, week: 520, month: 2100 }[p] * (goalStart ? 0.09 : 1);
      const growth = 1 + 0.015 * i;
      const wave = p === 'day' && [0, 6].includes(new Date(c).getUTCDay()) ? 0.7 : 1;
      const size = addPeriods(c, p, 1) <= dataStart ? 0 : Math.round(base * share * growth * wave * (0.85 + 0.3 * rnd(seed, c / DAY, key.length)));
      const counts: number[] = [];
      for (let k = 0; ; k++) {
        if (k > 0 && addPeriods(c, p, k + 1) > now) break;
        const v = curve(p, k, mult, ret !== 'any') * (0.9 + 0.2 * rnd(seed, c / DAY, k, key.length + 1));
        counts.push(k === 0 && ret === 'any' ? size : Math.round(size * Math.min(0.99, v)));
      }
      rows.push({ start: c, size, counts });
    }
    return { key, rows };
  });

  const weighted = (rows: Array<{ size: number; counts: number[] }>) => {
    const len = Math.max(0, ...rows.map((r) => r.counts.length));
    return Array.from({ length: len }, (_, k) => {
      let s = 0, n = 0;
      for (const r of rows) if (r.counts.length > k) { s += r.size; n += r.counts[k]; }
      return s ? round(n / s) : 0;
    });
  };

  const merged = perGroup[0].rows.map((r, i) => ({
    start: r.start,
    size: perGroup.reduce((a, g) => a + g.rows[i].size, 0),
    counts: r.counts.map((_, k) => perGroup.reduce((a, g) => a + (g.rows[i].counts[k] ?? 0), 0)),
  }));
  const cohorts: RetentionCohort[] = merged.map((r) => ({
    start: new Date(r.start).toISOString(), size: r.size, counts: r.counts, values: r.counts.map((n) => (r.size ? round(n / r.size) : 0)),
  }));
  const out: RetentionResponse = { period: p, cohorts, average: weighted(merged), dataSince: new Date(dataStart).toISOString().slice(0, 10) };
  if (split !== 'none' && SPLITS[split]) {
    out.splits = perGroup
      .map((g) => ({ key: g.key, size: g.rows.reduce((a, r) => a + r.size, 0), average: weighted(g.rows) }))
      .sort((a, b) => b.size - a.size).slice(0, 5);
  }
  return out;
}
