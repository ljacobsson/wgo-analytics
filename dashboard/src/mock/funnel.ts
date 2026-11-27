import type { AnalyticsEvent, DriverDim, DriverRow, Filter, FunnelStepResult, Goal, GoalFunnel, GoalStep, JourneyRow } from '../api/contract';
import { matches } from './filters';
import { rate, rnd, weighted } from './rng';
import { BROWSERS, DEVICES, OSES, PLACES, REFERRERS } from './universe';

/**
 * Mock of GET /goals/{id}/funnel. The mock's regular event stream has one page per session, which makes for dull
 * journeys, so this builds its own deterministic sessions that walk through the shop: entry page by source, a
 * Markov walk over pages, add-to-cart and checkout clicks, a checkout that fails more often on mobile Safari, and a
 * `checkout_completed` event at the end. The counting mirrors backend/src/lib/funnel.ts.
 */

const SEC = 1000;
const SLOT = 40 * SEC; // at most one session starts per slot
const MAX_SESSIONS = 4000;
const DIMS: DriverDim[] = ['entry', 'page', 'source', 'device', 'browser', 'country', 'error'];
const MIN_SESSIONS = 20;

const ENTRY = [
  { path: '/', w: 40 }, { path: '/products', w: 14 }, { path: '/pricing', w: 9 }, { path: '/blog/launch-week', w: 12 },
  { path: '/docs/getting-started', w: 10 }, { path: '/products/aurora-lamp', w: 15 },
];
// next page (or exit) from each page
const NEXT: Record<string, Array<{ path: string | null; w: number }>> = {
  '/': [{ path: '/products', w: 30 }, { path: '/pricing', w: 18 }, { path: '/blog/launch-week', w: 5 }, { path: '/docs/getting-started', w: 7 }, { path: '/login', w: 6 }, { path: null, w: 34 }],
  '/pricing': [{ path: '/products', w: 30 }, { path: '/login', w: 12 }, { path: '/cart', w: 12 }, { path: null, w: 30 }],
  '/products': [{ path: '/products/aurora-lamp', w: 34 }, { path: '/products/nimbus-chair', w: 24 }, { path: '/pricing', w: 8 }, { path: null, w: 34 }],
  '/products/aurora-lamp': [{ path: '/cart', w: 40 }, { path: '/products', w: 18 }, { path: null, w: 42 }],
  '/products/nimbus-chair': [{ path: '/cart', w: 28 }, { path: '/products', w: 24 }, { path: null, w: 48 }],
  '/cart': [{ path: '/checkout', w: 52 }, { path: '/products', w: 14 }, { path: null, w: 34 }],
  '/checkout': [{ path: null, w: 1 }],
  '/blog/launch-week': [{ path: '/', w: 12 }, { path: '/products', w: 8 }, { path: null, w: 80 }],
  '/docs/getting-started': [{ path: '/login', w: 18 }, { path: '/', w: 10 }, { path: null, w: 72 }],
  '/login': [{ path: '/account', w: 70 }, { path: null, w: 30 }],
  '/account': [{ path: '/products', w: 20 }, { path: null, w: 80 }],
};

const blank = (): AnalyticsEvent => ({
  id: '', type: 'pageview', ts: '', sessionId: null, anonId: null, userId: null, url: null, path: null, title: null, referrer: null, selector: null,
  elementText: null, elementTag: null, trackName: null, errorMessage: null, errorStack: null, errorSource: null, fingerprint: null, httpMethod: null,
  httpUrl: null, httpRoute: null, httpStatus: null, durationMs: null, name: null, props: {}, browser: null, os: null, device: null, country: null,
  region: null, city: null, lat: null, lon: null, bot: null,
});

/** One synthetic session, its events in time order. */
function session(slot: number): AnalyticsEvent[] {
  const r = (n: number) => rnd(slot, 7100 + n);
  const device = weighted(DEVICES, slot, 7001).k;
  const browser = device === 'mobile' ? (r(1) < 0.55 ? 'Safari' : 'Chrome') : weighted(BROWSERS, slot, 7002).k;
  const os = device === 'mobile' ? (browser === 'Safari' ? 'iOS' : 'Android') : weighted(OSES.filter((o) => o.k !== 'iOS' && o.k !== 'Android'), slot, 7003).k;
  const place = weighted(PLACES, slot, 7004);
  const source = weighted(REFERRERS, slot, 7005).k;
  const social = source === 't.co' || source === 'reddit.com';
  const keen = source === 'google.com' || source === 'github.com';
  const sid = `fs${slot.toString(36)}`;
  const out: AnalyticsEvent[] = [];
  let t = slot * SLOT + Math.floor(r(2) * SLOT * 0.5);
  const push = (patch: Partial<AnalyticsEvent>) => {
    t += Math.floor((4 + r(10 + out.length) * 40) * SEC);
    const e = { ...blank(), ...patch };
    e.id = `${sid}_${out.length}`; e.ts = new Date(t).toISOString(); e.sessionId = sid; e.anonId = `a${sid}`;
    e.browser = browser; e.os = os; e.device = device;
    Object.assign(e, { country: place.c, region: place.r, city: place.city, lat: place.lat, lon: place.lon });
    if (e.path) e.url = 'https://shop.acme.dev' + e.path;
    out.push(e);
  };

  // where they land depends a little on where they come from
  let page: string | null = social && r(3) < 0.5 ? '/blog/launch-week' : weighted(ENTRY, slot, 7006).path;
  let prev: string | null = null;
  let pricing = false;
  for (let i = 0; page && i < 8; i++) {
    push({ type: 'pageview', path: page, title: page === '/' ? 'Acme: lighting for humans' : 'Acme · ' + page.slice(1),
      referrer: prev ? 'https://shop.acme.dev' + prev : source === '(direct)' ? null : `https://${source}/` });
    if (page === '/pricing') pricing = true;
    if (page === '/' && r(20 + i) < 0.18) push({ type: 'click', path: '/', selector: '#signup-cta', elementText: 'Start free trial', elementTag: 'button', trackName: 'signup-cta' });
    if (page === '/products' && r(30 + i) < 0.3) push({ type: 'custom', path: page, name: 'search', props: { q: 'lamp' } });
    if (page === '/blog/launch-week' && r(40 + i) < 0.15) push({ type: 'custom', path: page, name: 'newsletter_signup', props: {} });
    if (page === '/checkout') {
      const failing = device === 'mobile' && browser === 'Safari' ? 0.45 : 0.07;
      const failed = r(50) < failing;
      if (failed) {
        push({ type: 'http_error', path: page, httpMethod: 'POST', httpUrl: '/api/checkout', httpRoute: '/api/checkout', httpStatus: 502, durationMs: 4200 });
        push({ type: 'error', path: page, errorMessage: 'Unhandled promise rejection: NetworkError when attempting to fetch resource', fingerprint: '7bd20e41c9a8', props: { kind: 'rejection' } });
      }
      if (r(51) < (failed ? 0.18 : 0.78)) push({ type: 'custom', path: page, name: 'checkout_completed', props: { plan: r(52) < 0.3 ? 'pro' : 'free', value: Math.round(r(53) * 90) } });
      break;
    }
    // keen visitors stay longer, social ones bounce; seeing the pricing makes checking out likelier
    const options: Array<{ path: string | null; w: number }> = NEXT[page].map((o) => ({
      ...o,
      w: o.path === null ? o.w * (keen ? 0.75 : social ? 1.5 : 1) * (device === 'mobile' ? 1.15 : 1) : o.path === '/checkout' && pricing ? o.w * 1.6 : o.w,
    }));
    const next: string | null = weighted(options, slot, 7200 + i).path;
    if (next === '/cart') push({ type: 'click', path: page, selector: 'button.add-to-cart', elementText: 'Add to cart', elementTag: 'button', trackName: 'add-to-cart' });
    if (next === '/checkout') push({ type: 'click', path: page, selector: '#checkout-btn', elementText: 'Checkout', elementTag: 'button', trackName: 'checkout' });
    prev = page;
    page = next;
  }
  return out;
}

/**
 * The synthetic sessions with events in [from, to), sampled down to MAX_SESSIONS; `weight` is how many sessions
 * each one stands for. Shared with the user flows mock.
 */
export function* mockSessions(from: number, to: number): Generator<{ events: AnalyticsEvent[]; weight: number }> {
  const lo = Math.ceil(from / SLOT), hi = Math.floor(to / SLOT);
  const stride = Math.max(1, Math.ceil((hi - lo) / MAX_SESSIONS));
  for (let slot = lo; slot < hi; slot += stride) {
    if (rnd(slot, 7000) > Math.min(0.95, rate(slot * SLOT) * 1.4)) continue;
    const events = session(slot).filter((e) => { const t = Date.parse(e.ts); return t >= from && t < to; });
    if (events.length) yield { events, weight: stride };
  }
}

const host = (u: string | null) => (u ? u.split('/')[2] ?? '' : '');
export const errKey = (e: AnalyticsEvent) =>
  e.type === 'error' ? (e.errorMessage ?? '').slice(0, 200)
  : e.type === 'http_error' ? [e.httpMethod, e.httpRoute ?? (e.httpUrl ?? '').split('?')[0], e.httpStatus].filter((x) => x != null && x !== '').join(' ')
  : null;

// ---------- ranking (a copy of backend/src/lib/funnel.ts) ----------
function wilson(c: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 1];
  const p = c / n, z2 = z * z, d = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
function driverRow(dim: DriverDim, key: string, sessions: number, converted: number, baseline: number, at: string | null = null): DriverRow {
  const rate = sessions ? converted / sessions : 0;
  const [low, high] = wilson(converted, sessions);
  return { dim, key, at, sessions, converted, rate, baseline, lift: baseline > 0 ? rate / baseline : null, low, high, impact: converted - sessions * baseline };
}
function errorRow(key: string, at: string | null, sessions: number, converted: number, pages: Map<string, DriverRow>, overall: number): DriverRow {
  const page = at != null ? pages.get(at) : undefined;
  const others = page ? page.sessions - sessions : 0;
  const baseline = page && others > 0 ? Math.max(0, page.converted - converted) / others : overall;
  return driverRow('error', key, sessions, converted, Math.min(1, baseline), at);
}
function collapse(pages: string[]): string[] {
  const out: string[] = [];
  for (const p of pages) { if (out[out.length - 1] !== p) out.push(p); if (out.length === 3) break; }
  return out;
}
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};

export function funnel(from: number, to: number, goal: Goal, stepsOverride: GoalStep[] | null, filters: Filter[]): GoalFunnel {
  const all: Array<{ name: string; filters: Filter[] }> = [...(stepsOverride ?? goal.steps ?? []), { name: goal.name, filters: goal.filters }];
  const lo = Math.ceil(from / SLOT), hi = Math.floor(to / SLOT);
  const stride = Math.max(1, Math.ceil((hi - lo) / MAX_SESSIONS));
  const reached = all.map(() => 0);
  const gaps: number[][] = all.map(() => []);
  const exits: Array<Map<string, number>> = all.map(() => new Map());
  const seg = new Map<string, { dim: DriverDim; key: string; at: string | null; n: number; c: number }>();
  const journeys = new Map<string, JourneyRow>();
  let sessions = 0, converted = 0;
  const count = (dim: DriverDim, key: string, conv: boolean, at: string | null = null) => {
    const k = dim + '\u0000' + key + '\u0000' + (at ?? '');
    const x = seg.get(k) ?? { dim, key, at, n: 0, c: 0 };
    x.n += stride; if (conv) x.c += stride;
    seg.set(k, x);
  };

  for (let slot = lo; slot < hi; slot += stride) {
    if (rnd(slot, 7000) > Math.min(0.95, rate(slot * SLOT) * 1.4)) continue;
    const evs = session(slot).filter((e) => { const t = Date.parse(e.ts); return t >= from && t < to && (!filters.length || matches('events', e, filters)); });
    if (!evs.length) continue;
    const ts = (e: AnalyticsEvent) => Date.parse(e.ts);
    const goalAt = evs.find((e) => matches('events', e, goal.filters));
    const g = goalAt ? ts(goalAt) : null;
    const conv = g != null;
    sessions += stride; if (conv) converted += stride;

    const views = evs.filter((e) => e.type === 'pageview');
    count('entry', views[0]?.path ?? '(no pageview)', conv);
    const ref = views[0] ? (views[0].referrer && host(views[0].referrer) !== host(views[0].url) ? host(views[0].referrer) : '(direct)') : '(no pageview)';
    count('source', ref, conv);
    count('device', evs[0].device ?? 'Unknown', conv);
    count('browser', evs[0].browser ?? 'Unknown', conv);
    count('country', evs[0].country ?? 'Unknown', conv);
    const before = evs.filter((e) => g == null || ts(e) < g);
    for (const p of new Set(before.filter((e) => e.type === 'pageview' && e.path).map((e) => e.path!))) count('page', p, conv);
    const errs = new Map(before.filter((e) => errKey(e)).map((e) => [errKey(e)! + '\u0000' + (e.path ?? ''), e]));
    for (const e of errs.values()) count('error', errKey(e)!, conv, e.path);

    const pages = collapse(views.filter((e) => g == null || ts(e) <= g).map((e) => e.path!).filter(Boolean).slice(0, 8));
    if (pages.length) {
      const k = pages.join('\u0000');
      const j = journeys.get(k) ?? { pages, sessions: 0, converted: 0, rate: 0, low: 0, high: 1 };
      j.sessions += stride; if (conv) j.converted += stride;
      journeys.set(k, j);
    }

    // ordered steps: each one at or after the previous
    let at: number | null = null;
    for (let i = 0; i < all.length; i++) {
      const hit = evs.find((e) => (at == null || ts(e) >= at) && matches('events', e, all[i].filters));
      if (!hit) {
        if (i > 0) { const last = views[views.length - 1]?.path ?? '(no pageview)'; exits[i - 1].set(last, (exits[i - 1].get(last) ?? 0) + stride); }
        break;
      }
      if (at != null) gaps[i].push((ts(hit) - at) / SEC);
      at = ts(hit);
      reached[i] += stride;
    }
  }

  const overall = sessions ? converted / sessions : 0;
  const rows = [...seg.values()].filter((x) => x.dim !== 'error').map((x) => driverRow(x.dim, x.key, x.n, x.c, overall));
  const pageRows = new Map(rows.filter((r) => r.dim === 'page').map((r) => [r.key, r]));
  for (const x of seg.values()) if (x.dim === 'error') rows.push(errorRow(x.key, x.at, x.n, x.c, pageRows, overall));
  const big = rows.filter((r) => r.sessions >= MIN_SESSIONS);
  const dims = Object.fromEntries(DIMS.map((d) => [d, rows.filter((r) => r.dim === d).sort((a, b) => b.sessions - a.sessions).slice(0, 25)])) as Record<DriverDim, DriverRow[]>;
  const steps: FunnelStepResult[] = all.map((s, i) => ({
    name: s.name, filters: s.filters, sessions: reached[i], medianSeconds: i ? median(gaps[i]) : null,
    exits: [...exits[i].entries()].map(([key, n]) => ({ key, sessions: n })).sort((a, b) => b.sessions - a.sessions).slice(0, 5),
  }));
  return {
    goal: { id: goal.id, name: goal.name, filters: goal.filters },
    sessions, converted, steps,
    best: big.filter((r) => r.dim !== 'error' && r.low > r.baseline).sort((a, b) => b.impact - a.impact).slice(0, 8),
    worst: big.filter((r) => r.high < r.baseline).sort((a, b) => a.impact - b.impact).slice(0, 8),
    dims,
    journeys: [...journeys.values()].map((j) => { const [low, high] = wilson(j.converted, j.sessions); return { ...j, rate: j.sessions ? j.converted / j.sessions : 0, low, high }; })
      .sort((a, b) => b.sessions - a.sessions || b.converted - a.converted).slice(0, 15),
  };
}
