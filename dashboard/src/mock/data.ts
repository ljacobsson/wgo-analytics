import type {
  AnalyticsEvent, BreakdownRow, ClickRow, ErrorGroup, FrustrationRow, EventType, HttpErrorGroup, LogRecord, MetricInfo, MetricSeriesResponse,
  PageRow, ServiceRow, Span, StatsResponse, Totals, TraceSummary, VitalsResponse, GeoResponse,
} from '../api/contract';
import type { BrowserRequest, ConversionsResponse, Filter, Goal, TraceResponse } from '../api/contract';
import { matches } from './filters';
import { hash, hex, pick, rate, rnd, uuidOf, weighted } from './rng';
import { BROWSERS, CLICKS, CUSTOM, DEVICES, ERRORS, HTTP_ERRORS, OSES, PAGES, PLACES, REFERRERS, SERVICES } from './universe';

const iso = (ms: number) => new Date(ms).toISOString();
const SEC = 1000;

// ---------- aggregates ----------
const MULT = { pageview: 1, click: 2.3, custom: 0.35, error: 0.035, http_error: 0.05 } as const;
function integral(from: number, to: number): number {
  const step = Math.max(60_000, (to - from) / 400);
  let sum = 0;
  for (let t = from; t < to; t += step) sum += rate(t) * Math.min(step, to - t) / SEC;
  return sum;
}
export function totalsFor(from: number, to: number): Totals {
  const base = integral(from, to) * 0.62;
  const n = (k: number, salt: number) => Math.round(base * k * (0.96 + rnd(Math.floor(from / 60000), salt) * 0.08));
  const pageviews = n(1, 1), clicks = n(MULT.click, 2), errors = n(MULT.error, 3), httpErrors = n(MULT.http_error, 4), custom = n(MULT.custom, 5);
  const sessions = Math.round(pageviews * 0.38), users = Math.round(sessions * 0.74);
  return { events: pageviews + clicks + errors + httpErrors + custom, pageviews, clicks, errors, httpErrors, sessions, users };
}
const NICE = [10, 30, 60, 300, 900, 1800, 3600, 7200, 21600, 43200, 86400];
export function stats(from: number, to: number): StatsResponse {
  const len = to - from;
  const bs = NICE.find((b) => (b * SEC * 72) >= len) ?? 86400;
  const start = Math.ceil(from / (bs * SEC)) * bs * SEC;
  const series: StatsResponse['series'] = [];
  for (let t = start; t < to; t += bs * SEC) {
    const base = integral(t, t + bs * SEC) * 0.62;
    const f = (k: number, s: number) => Math.round(base * k * (0.8 + rnd(t / 1000, s) * 0.4));
    const spike = rnd(Math.floor(t / (bs * SEC * 9))) > 0.93 ? 4 : 1;
    series.push({ t: iso(t), pageview: f(1, 1), click: f(MULT.click, 2), error: f(MULT.error, 3) * spike, http_error: f(MULT.http_error, 4) * spike, custom: f(MULT.custom, 5) });
  }
  const sum = (k: keyof StatsResponse['series'][number]) => series.reduce((a, p) => a + (p[k] as number), 0);
  const totals = totalsFor(from, to);
  totals.pageviews = sum('pageview'); totals.clicks = sum('click'); totals.errors = sum('error'); totals.httpErrors = sum('http_error');
  totals.events = totals.pageviews + totals.clicks + totals.errors + totals.httpErrors + sum('custom');
  totals.sessions = Math.round(totals.pageviews * 0.38); totals.users = Math.round(totals.sessions * 0.74);
  return { bucketSeconds: bs, totals, previous: totalsFor(from - len, from), series };
}
export function clicks(from: number, to: number, limit: number): ClickRow[] {
  const total = totalsFor(from, to).clicks;
  const tw = CLICKS.reduce((a, c) => a + c.w, 0);
  return CLICKS.map((c, i) => {
    const count = Math.round((total * c.w / tw) * (0.85 + rnd(i, Math.floor(from / 6e4)) * 0.3));
    return { selector: c.selector, elementText: c.text, trackName: c.track, elementTag: c.tag, alias: null, count, sessions: Math.round(count * 0.7), rageClicks: Math.round(count * c.rage), lastSeen: iso(to - Math.floor(rnd(i, 9) * Math.min(to - from, 3600_000))) };
  }).filter((r) => r.count > 0).sort((a, b) => b.count - a.count).slice(0, limit);
}
/** Click targets where visitors got stuck; `samples` are filled in by the mock API from the mock recordings. */
export function frustration(from: number, to: number, limit: number): FrustrationRow[] {
  return clicks(from, to, 500).map((c, i): FrustrationRow => {
    const dead = Math.round(c.count * [0.02, 0.07, 0.01, 0.015, 0.03, 0.2, 0.005, 0.05, 0.01, 0.04][i % 10] * (0.8 + rnd(i, 31) * 0.4));
    const err = Math.round(c.count * (c.selector === '#checkout-btn' ? 0.09 : c.selector.includes('coupon') ? 0.14 : rnd(i, 32) * 0.012));
    const s = (n: number, f: number) => (n ? Math.max(1, Math.round(n * f)) : 0);
    return {
      selector: c.selector, elementText: c.elementText, trackName: c.trackName, elementTag: c.elementTag, alias: null,
      clicks: c.count, rageClicks: c.rageClicks, rageSessions: s(c.rageClicks, 0.7), deadClicks: dead, deadSessions: s(dead, 0.8),
      errorClicks: err, errorSessions: s(err, 0.85), samples: [],
    };
  }).filter((r) => r.rageClicks + r.deadClicks + r.errorClicks > 0)
    .sort((a, b) => (b.rageClicks + b.deadClicks + b.errorClicks) - (a.rageClicks + a.deadClicks + a.errorClicks)).slice(0, limit);
}
export function pages(from: number, to: number, limit: number): PageRow[] {
  const total = totalsFor(from, to).pageviews, tw = PAGES.reduce((a, c) => a + c.w, 0);
  return PAGES.map((p, i) => { const views = Math.round(total * p.w / tw * (0.9 + rnd(i, 5) * 0.2)); return { path: p.path, views, sessions: Math.round(views * 0.8) }; }).sort((a, b) => b.views - a.views).slice(0, limit);
}
export function errors(from: number, to: number, limit: number): ErrorGroup[] {
  const total = totalsFor(from, to).errors, tw = ERRORS.reduce((a, c) => a + c.w, 0), len = to - from;
  return ERRORS.map((e, i) => {
    const count = Math.max(1, Math.round(total * e.w / tw));
    const series = Array.from({ length: 24 }, (_, k) => Math.round((count / 24) * (0.3 + rnd(i, k, Math.floor(from / 6e5)) * 1.5) * (i === 0 && k > 18 ? 3 : 1)));
    return { fingerprint: e.fp, message: e.msg, kind: e.kind, count, sessions: Math.max(1, Math.round(count * 0.6)), firstSeen: iso(from + len * (0.02 + rnd(i, 1) * 0.3)), lastSeen: iso(to - Math.floor(rnd(i, 2) * Math.min(len, 1800_000))), sampleStack: e.mapped?.stack ?? e.stack, minifiedStack: e.mapped ? e.stack : null, ...(e.mapped ? { stackFrames: e.mapped.frames } : {}), ...('missing' in e && e.missing ? { missingSourcemaps: e.missing } : {}), sampleUrl: 'https://shop.acme.dev' + e.url, source: e.source, series };
  }).sort((a, b) => b.count - a.count).slice(0, limit);
}
export function httpErrors(from: number, to: number, limit: number): HttpErrorGroup[] {
  const total = totalsFor(from, to).httpErrors, tw = HTTP_ERRORS.reduce((a, c) => a + c.w, 0);
  return HTTP_ERRORS.map((h, i) => { const count = Math.max(1, Math.round(total * h.w / tw)); return { method: h.method, route: h.route, status: h.status, count, sessions: Math.max(1, Math.round(count * 0.7)), avgDurationMs: h.ms * (0.8 + rnd(i, 3) * 0.4), lastSeen: iso(to - Math.floor(rnd(i, 4) * Math.min(to - from, 1200_000))), sampleUrl: h.url, sampleTraceId: h.route.startsWith('/') ? recentTrace(h.route, to) : null }; }).sort((a, b) => b.count - a.count).slice(0, limit);
}
/** The trace id of the latest mock failure of a route, from the event stream. */
function recentTrace(route: string, to: number): string | null {
  const r = events({ from: to - 6 * 3600_000, to, type: 'http_error', limit: 300 });
  const e = r.events.find((x) => x.httpRoute === route && typeof x.props.trace === 'string');
  return e ? String(e.props.trace) : null;
}
export function geo(from: number, to: number): GeoResponse {
  const total = totalsFor(from, to).sessions, tw = PLACES.reduce((a, p) => a + p.w, 0);
  const located = Math.round(total * 0.95);
  const points = PLACES.map((p, i) => {
    const sessions = Math.max(1, Math.round(located * p.w / tw * (0.85 + rnd(i, 31, Math.floor(from / 3.6e6)) * 0.3)));
    return { lat: p.lat, lon: p.lon, city: p.city, country: p.c, sessions, events: sessions * 7 };
  }).sort((a, b) => b.sessions - a.sessions);
  const byC = new Map<string, { country: string; sessions: number; events: number }>();
  for (const p of points) { const c = byC.get(p.country!) ?? { country: p.country!, sessions: 0, events: 0 }; c.sessions += p.sessions; c.events += p.events; byC.set(p.country!, c); }
  return { points, countries: [...byC.values()].sort((a, b) => b.sessions - a.sessions), located, total };
}
export function breakdown(from: number, to: number, dim: string): BreakdownRow[] {
  if (dim === 'country') return geo(from, to).countries.map((c) => ({ key: c.country, count: c.sessions }));
  const total = totalsFor(from, to).sessions;
  const src = dim === 'browser' ? BROWSERS : dim === 'os' ? OSES : dim === 'device' ? DEVICES : REFERRERS;
  const tw = src.reduce((a, c) => a + c.w, 0);
  return src.map((s, i) => ({ key: s.k, count: Math.round(total * s.w / tw * (0.9 + rnd(i, 7) * 0.2)) })).sort((a, b) => b.count - a.count);
}
export function vitals(from: number): VitalsResponse {
  const j = (b: number, s: number) => b * (0.93 + rnd(Math.floor(from / 3.6e6), s) * 0.14);
  return { samples: 4210, p75: { lcp: j(2650, 1), fcp: j(1480, 2), cls: j(0.14, 3), inp: j(184, 4), ttfb: j(910, 5) } };
}

// ---------- events (walk backwards through 1-second slots) ----------
const TYPE_W: Array<{ t: EventType; w: number }> = [{ t: 'pageview', w: 32 }, { t: 'click', w: 50 }, { t: 'custom', w: 6 }, { t: 'error', w: 3 }, { t: 'http_error', w: 4 }, { t: 'vitals', w: 5 }];
const empty = (): AnalyticsEvent => ({ id: '', type: 'pageview', ts: '', sessionId: null, anonId: null, userId: null, url: null, path: null, title: null, referrer: null, selector: null, elementText: null, elementTag: null, trackName: null, errorMessage: null, errorStack: null, errorSource: null, fingerprint: null, httpMethod: null, httpUrl: null, httpRoute: null, httpStatus: null, durationMs: null, name: null, props: {}, browser: null, os: null, device: null, country: null, region: null, city: null, lat: null, lon: null, bot: null });
const BLOCK = 90;
export function eventAt(s: number, k = 0): AnalyticsEvent | null {
  if (rnd(s, k, 11) > Math.min(0.9, rate(s * SEC) * 2.2)) return null;
  const type = weighted(TYPE_W, s, k, 12).t;
  const e = empty();
  const block = Math.floor(s / BLOCK), sk = Math.floor(rnd(s, k, 13) * 4);
  e.id = `ev_${s.toString(36)}${k}`; e.type = type; e.ts = iso(s * SEC + Math.floor(rnd(s, k, 14) * 999));
  e.sessionId = `s${block.toString(36)}${sk}`; e.anonId = uuidOf(block, sk, 98); e.userId = rnd(block, sk, 15) > 0.8 ? `user_${hash(block, sk) % 900}` : null;
  const page = weighted(PAGES, block, sk, 16).path;
  e.path = page; e.url = 'https://shop.acme.dev' + page;
  e.browser = weighted(BROWSERS.map((b) => ({ ...b })), block, sk, 17).k; e.os = weighted(OSES, block, sk, 18).k; e.device = weighted(DEVICES, block, sk, 19).k;
  e.title = page === '/' ? 'Acme: lighting for humans' : 'Acme · ' + page.slice(1);
  if (rnd(block, sk, 27) < 0.95) { const pl = weighted(PLACES, block, sk, 28); Object.assign(e, { country: pl.c, region: pl.r, city: pl.city, lat: pl.lat, lon: pl.lon }); }
  e.referrer = rnd(block, sk, 20) > 0.5 ? 'https://' + weighted(REFERRERS, block, sk, 21).k : null;
  if (type === 'click') { const c = weighted(CLICKS, s, k, 22); e.selector = c.selector; e.elementText = c.text; e.elementTag = c.tag; e.trackName = c.track; e.path = c.path; e.url = 'https://shop.acme.dev' + c.path; e.props = { x: Math.round(rnd(s, 1) * 1400), y: Math.round(rnd(s, 2) * 800), rage: rnd(s, k, 23) < c.rage }; }
  else if (type === 'error') { const x = weighted(ERRORS, s, k, 24); e.errorMessage = x.msg; e.errorStack = x.mapped?.stack ?? x.stack; e.errorSource = x.source; e.fingerprint = x.fp; e.props = { kind: x.kind }; if ('missing' in x && x.missing) e.missingSourcemaps = x.missing; }
  else if (type === 'http_error') { const h = weighted(HTTP_ERRORS, s, k, 25); e.httpMethod = h.method; e.httpUrl = h.url; e.httpRoute = h.route; e.httpStatus = h.status; e.durationMs = Math.round(h.ms * (0.7 + rnd(s, 3) * 0.6)); e.props = { status: h.status, ...(h.route.startsWith('/') ? { trace: browserTraceId(s, k), span: hex(16, s, 98) } : {}) }; }
  else if (type === 'custom') { e.name = pick(CUSTOM, s, k, 26); e.props = { plan: pick(['free', 'pro', 'team'], s, 1), value: Math.round(rnd(s, 2) * 90) }; }
  else if (type === 'vitals') { e.name = pick(['LCP', 'FCP', 'CLS', 'INP', 'TTFB'], s, 5); e.props = { name: e.name, value: Math.round(rnd(s, 6) * 3000) / (e.name === 'CLS' ? 10000 : 1) }; }
  return e;
}
export interface EventQuery { from: number; to: number; before?: number; type?: string; q?: string; sessionId?: string; fingerprint?: string; limit: number; located?: boolean; lat?: number; lon?: number; filters?: Filter[] }
export function events(p: EventQuery): { events: AnalyticsEvent[]; nextBefore: string | null } {
  const out: AnalyticsEvent[] = [];
  const q = p.q?.toLowerCase();
  const match = (e: AnalyticsEvent) => (!p.type || e.type === p.type) && (!p.fingerprint || e.fingerprint === p.fingerprint) && (!p.sessionId || e.sessionId === p.sessionId)
    && (!p.located || e.lat != null) && (p.lat == null || (e.lat === p.lat && e.lon === p.lon))
    && (!p.filters?.length || matches('events', e, p.filters))
    && (!q || [e.path, e.selector, e.elementText, e.errorMessage, e.httpUrl, e.name].some((x) => x?.toLowerCase().includes(q)));
  let hi = Math.floor(Math.min(p.before ?? p.to, p.to) / SEC), lo = Math.floor(p.from / SEC);
  if (p.sessionId) { const b = parseInt(p.sessionId.slice(1, -1), 36); if (!Number.isNaN(b)) { hi = Math.min(hi, (b + 1) * BLOCK); lo = Math.max(lo, b * BLOCK - 1); if (p.before == null) hi = (b + 1) * BLOCK; } }
  let last: number | null = null, iter = 0;
  for (let s = hi; s >= lo && iter < 400_000; s--, iter++) {
    for (let k = 1; k >= 0; k--) {
      const e = eventAt(s, k);
      if (e && Date.parse(e.ts) < (p.before ?? Infinity) && Date.parse(e.ts) <= p.to && Date.parse(e.ts) >= p.from && match(e)) { out.push(e); }
    }
    if (out.length >= p.limit) { last = s; break; }
  }
  out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const cut = out.slice(0, p.limit);
  return { events: cut, nextBefore: out.length >= p.limit && last !== null ? cut[cut.length - 1].ts : null };
}

/**
 * Goal conversions over the generated events. Long ranges are sampled (every `stride` seconds) and scaled back up:
 * event counts by the stride, sessions by how many 90 s session blocks were skipped.
 */
export function conversions(from: number, to: number, goals: Goal[], filters: Filter[], withSeries: boolean): ConversionsResponse {
  const lo = Math.floor(from / SEC), hi = Math.ceil(to / SEC);
  const stride = Math.max(1, Math.ceil((hi - lo) / 40_000));
  const sessionScale = Math.max(1, stride / BLOCK);
  const sessions = new Set<string>(), users = new Set<string>();
  const per = goals.map(() => ({ conversions: 0, sessions: new Set<string>(), users: new Set<string>(), series: new Array<number>(24).fill(0) }));
  for (let s = lo; s < hi; s += stride) {
    for (let k = 0; k < 2; k++) {
      const e = eventAt(s, k);
      if (!e) continue;
      const t = Date.parse(e.ts);
      if (t < from || t >= to || (filters.length && !matches('events', e, filters))) continue;
      sessions.add(e.sessionId!); users.add(e.anonId!);
      goals.forEach((g, i) => {
        if (!matches('events', e, g.filters)) return;
        const p = per[i];
        p.conversions += stride; p.sessions.add(e.sessionId!); p.users.add(e.anonId!);
        p.series[Math.min(23, Math.floor(((t - from) / (to - from)) * 24))] += stride;
      });
    }
  }
  const n = (set: Set<string>) => Math.round(set.size * sessionScale);
  return {
    sessions: n(sessions), users: n(users),
    goals: goals.map((g, i) => ({ id: g.id, name: g.name, filters: g.filters, conversions: per[i].conversions, sessions: n(per[i].sessions), users: n(per[i].users), series: withSeries ? per[i].series : [] })),
  };
}

// ---------- traces ----------
const TSLOT = 25;
const ROOTS = [
  { name: 'GET /api/products', route: '/api/products', method: 'GET', w: 36 }, { name: 'POST /api/checkout', route: '/api/checkout', method: 'POST', w: 16 },
  { name: 'GET /api/cart', route: '/api/cart', method: 'GET', w: 24 }, { name: 'GET /api/search', route: '/api/search', method: 'GET', w: 16 }, { name: 'POST /api/login', route: '/api/login', method: 'POST', w: 8 },
];
const traceExists = (k: number) => rnd(k, 31) < 0.85;
export const traceIdFor = (k: number) => k.toString(16).padStart(8, '0') + hex(24, k, 32);
export const slotOf = (id: string) => parseInt(id.slice(0, 8), 16);
export function genTrace(k: number, force?: { method: string; route: string; status: number }): Span[] {
  const traceId = traceIdFor(k), t0 = k * TSLOT * SEC + Math.floor(rnd(k, 33) * TSLOT * SEC * 0.8);
  const root = force ? { ...(ROOTS.find((r) => force.route.startsWith(r.route)) ?? ROOTS[0]), name: `${force.method} ${force.route}` } : weighted(ROOTS, k, 34);
  const spans: Span[] = [];
  let n = 0;
  const bad = force ? force.status >= 500 : root.route === '/api/checkout' && rnd(k, 35) < 0.12;
  const slow = rnd(k, 36) > 0.92 ? 3.5 : 1;
  const add = (service: string, name: string, parent: string | null, start: number, dur: number, kind: number, attrs: Record<string, unknown>, err = false): string => {
    const spanId = hex(16, k, 40 + n++);
    spans.push({ traceId, spanId, parentSpanId: parent, name, kind, service, start: iso(t0 + start), end: iso(t0 + start + dur), durationMs: Math.round(dur * 10) / 10, statusCode: err ? 2 : 1, statusMessage: err ? 'upstream request failed' : null,
      attributes: attrs, resource: { 'service.name': service, 'service.version': '1.14.2', 'host.name': `${service}-${1 + (k % 3)}`, 'telemetry.sdk.language': service === 'payment-service' ? 'python' : 'nodejs' },
      events: err ? [{ name: 'exception', ts: iso(t0 + start + dur * 0.9), attributes: { 'exception.type': 'PaymentGatewayError', 'exception.message': 'card_declined: issuer unavailable' } }] : [] });
    return spanId;
  };
  const r = (a: number, b: number, s: number) => a + rnd(k, 50 + s) * (b - a);
  const total = (root.route === '/api/checkout' ? r(380, 900, 1) : root.route === '/api/search' ? r(120, 420, 1) : r(40, 190, 1)) * slow;
  const rootId = add('api-gateway', root.name, null, 0, total, 2, { 'http.method': root.method, 'http.route': root.route, 'http.status_code': bad ? 502 : 200 }, bad);
  const auth = add('auth-service', 'verify_token', rootId, 2, r(4, 14, 2), 3, { 'rpc.system': 'grpc' });
  add('postgres', 'SELECT sessions', auth, 4, r(1, 5, 3), 3, { 'db.system': 'postgresql', 'db.statement': 'SELECT * FROM sessions WHERE token = $1', 'db.operation': 'SELECT' });
  let cur = 20 + r(0, 6, 4);
  if (root.route === '/api/products' || root.route === '/api/search') {
    const c = add('catalog-service', root.route === '/api/search' ? 'search_products' : 'list_products', rootId, cur, total - cur - 6, 2, { 'catalog.query': root.route === '/api/search' ? 'lamp' : 'all' });
    add('postgres', 'SELECT products', c, cur + 3, (total - cur) * 0.55, 3, { 'db.system': 'postgresql', 'db.statement': 'SELECT id, name, price FROM products WHERE active ORDER BY popularity LIMIT 48', 'db.operation': 'SELECT' });
  } else if (root.route === '/api/cart') {
    const c = add('cart-service', 'get_cart', rootId, cur, total - cur - 4, 2, { 'cart.items': Math.floor(r(1, 6, 5)) });
    add('postgres', 'SELECT cart_items', c, cur + 2, (total - cur) * 0.4, 3, { 'db.system': 'postgresql', 'db.statement': 'SELECT * FROM cart_items WHERE cart_id = $1' });
  } else if (root.route === '/api/checkout') {
    const c = add('cart-service', 'lock_cart', rootId, cur, 30, 3, {}); add('postgres', 'UPDATE carts', c, cur + 4, 12, 3, { 'db.system': 'postgresql', 'db.statement': "UPDATE carts SET status = 'locked' WHERE id = $1" });
    cur += 40;
    const p = add('payment-service', 'charge_card', rootId, cur, total - cur - 10, 3, { 'payment.provider': 'stripe', 'payment.amount': 4900 }, bad);
    add('payment-service', 'POST api.stripe.com/v1/charges', p, cur + 10, (total - cur) * 0.75, 3, { 'http.method': 'POST', 'http.url': 'https://api.stripe.com/v1/charges', 'http.status_code': bad ? 402 : 200 }, bad);
    const i = add('postgres', 'INSERT orders', rootId, total - 9, 7, 3, { 'db.system': 'postgresql', 'db.statement': 'INSERT INTO orders (cart_id, total) VALUES ($1, $2)' });
    void i;
  } else {
    add('postgres', 'SELECT users', rootId, cur, r(3, 9, 6), 3, { 'db.system': 'postgresql', 'db.statement': 'SELECT id, password_hash FROM users WHERE email = $1' });
  }
  return spans.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
/**
 * Trace ids of failed browser requests: 'b7' + the event's second and slot, so the mock trace endpoint can rebuild
 * the request (browserTrace) and give the trace its browser root span, like the backend does.
 */
export const browserTraceId = (s: number, k: number) => 'b7' + s.toString(16).padStart(12, '0') + k.toString(16) + hex(17, s, 99);

export function browserTrace(id: string): TraceResponse | null {
  if (!/^b7[0-9a-f]{30}$/.test(id)) return null;
  const s = parseInt(id.slice(2, 14), 16), k = parseInt(id[14], 16);
  const e = eventAt(s, k);
  if (!e || e.type !== 'http_error' || e.props.trace !== id) return null;
  const end = Date.parse(e.ts), dur = e.durationMs ?? 0, spanId = String(e.props.span);
  const backend = genTrace(Math.floor(s / TSLOT), { method: e.httpMethod!, route: e.httpRoute!, status: e.httpStatus! });
  // the backend answered within the browser's request: start a few ms after it, end before it
  const scale = Math.min(1, Math.max(0.05, (dur - 30) / Math.max(1, backend[0].durationMs)));
  const t0 = Date.parse(backend[0].start), start = end - dur + 15;
  const at = (t: string) => iso(start + (Date.parse(t) - t0) * scale);
  const spans: Span[] = backend.map((x) => ({ ...x, traceId: id, start: at(x.start), end: at(x.end), durationMs: Math.round(x.durationMs * scale * 10) / 10, parentSpanId: x.parentSpanId ?? spanId }));
  const browser: BrowserRequest = {
    eventId: e.id, ts: e.ts, spanId, method: e.httpMethod!, url: e.httpUrl, route: e.httpRoute, status: e.httpStatus ?? 0, durationMs: dur,
    sessionId: e.sessionId, anonId: e.anonId, userId: e.userId, path: e.path, browser: e.browser, os: e.os, country: e.country, city: e.city,
  };
  const root: Span = {
    traceId: id, spanId, parentSpanId: null, name: `${browser.method} ${browser.route}`, kind: 3, service: 'browser', start: iso(end - dur), end: e.ts, durationMs: dur,
    statusCode: 2, statusMessage: browser.status ? `HTTP ${browser.status}` : 'Network error',
    attributes: { 'http.request.method': browser.method, 'url.full': browser.url, 'http.response.status_code': browser.status, 'url.path': browser.path },
    resource: { 'service.name': 'browser', 'browser.name': browser.browser, 'os.name': browser.os }, events: [],
  };
  return { spans: [root, ...spans], browser: [browser] };
}

export function summarize(spans: Span[]): TraceSummary {
  const root = spans.find((s) => !s.parentSpanId) ?? spans[0];
  return { traceId: root.traceId, rootName: root.name, service: root.service, start: root.start, durationMs: root.durationMs, spanCount: spans.length, errorCount: spans.filter((s) => s.statusCode === 2).length, services: [...new Set(spans.map((s) => s.service))] };
}
export function traces(p: { from: number; to: number; service?: string; minDurationMs?: number; errorsOnly?: boolean; q?: string; limit: number }): TraceSummary[] {
  const out: TraceSummary[] = [];
  const q = p.q?.toLowerCase();
  const hi = Math.floor(p.to / (TSLOT * SEC)), lo = Math.floor(p.from / (TSLOT * SEC));
  for (let k = hi, i = 0; k >= lo && out.length < p.limit && i < 60_000; k--, i++) {
    if (!traceExists(k)) continue;
    const t = summarize(genTrace(k));
    const ts = Date.parse(t.start);
    if (ts < p.from || ts > p.to) continue;
    if (p.service && !t.services.includes(p.service)) continue;
    if (p.minDurationMs && t.durationMs < p.minDurationMs) continue;
    if (p.errorsOnly && !t.errorCount) continue;
    if (q && !t.rootName.toLowerCase().includes(q)) continue;
    out.push(t);
  }
  return out;
}
export function services(from: number, to: number): ServiceRow[] {
  const n = (to - from) / (TSLOT * SEC) * 0.85;
  const per: Record<string, [number, number, number, number]> = { 'api-gateway': [1, 0.012, 82, 640], 'auth-service': [1, 0.002, 9, 22], 'catalog-service': [0.52, 0.004, 48, 160], 'cart-service': [0.4, 0.006, 31, 96], 'payment-service': [0.32, 0.09, 310, 780], postgres: [2.4, 0.001, 3, 18] };
  return SERVICES.map((s) => { const [m, e, p50, p95] = per[s]; const spans = Math.round(n * m * (0.97 + rnd(Math.floor(from / 6e4), 61) * 0.06)); return { service: s, spans, errors: Math.round(spans * e), p50Ms: p50, p95Ms: p95 }; });
}

// ---------- logs ----------
const SEV = [{ n: 9, t: 'INFO', w: 58 }, { n: 5, t: 'DEBUG', w: 16 }, { n: 13, t: 'WARN', w: 13 }, { n: 17, t: 'ERROR', w: 11 }, { n: 21, t: 'FATAL', w: 0.4 }, { n: 1, t: 'TRACE', w: 1.6 }];
const BODIES: Record<string, string[]> = {
  INFO: ['request completed status=200 duration_ms=%d', 'cart updated items=%d', 'user session refreshed', 'cache hit key=products:list ttl=%d', 'order accepted id=ord_%d'],
  DEBUG: ['sql query executed rows=%d', 'feature flag evaluated flag=new-checkout value=true', 'retry scheduled attempt=%d'],
  WARN: ['slow query detected duration_ms=%d', 'rate limit approaching client=web remaining=%d', 'deprecated endpoint /api/v1/cart called'],
  ERROR: ['payment provider returned 402 card_declined', 'failed to connect to redis: ETIMEDOUT after %d ms', 'unhandled exception in request handler: TypeError: x is undefined', 'upstream catalog-service returned 503'],
  FATAL: ['out of memory: cannot allocate %d bytes, shutting down'], TRACE: ['entering handler span=%d'],
};
export function logAt(s: number, k: number, forceTrace?: string): LogRecord | null {
  if (!forceTrace && rnd(s, k, 71) > 0.55) return null;
  const sev = weighted(SEV, s, k, 72), service = forceTrace ? pick(SERVICES, s, k, 73) : pick(SERVICES, s, k, 73);
  const body = pick(BODIES[sev.t], s, k, 74).replace('%d', String(Math.floor(rnd(s, k, 75) * 900) + 5));
  const slot = Math.floor(s / TSLOT), traced = forceTrace ? true : traceExists(slot) && rnd(s, k, 76) < 0.5;
  const traceId = forceTrace ?? (traced ? traceIdFor(slot) : null);
  return { id: `lg_${s.toString(36)}${k}`, ts: iso(s * SEC + Math.floor(rnd(s, k, 77) * 999)), severityNumber: sev.n, severityText: sev.t, body, service, traceId, spanId: traceId ? hex(16, slotOf(traceId), 40 + (s % 5)) : null,
    attributes: { 'log.logger': service + '.http', 'http.route': pick(ROOTS, s, 78).route, 'user.id': `user_${hash(s) % 900}` }, resource: { 'service.name': service, 'host.name': `${service}-${1 + (s % 3)}`, 'deployment.environment': 'production' } };
}
export function logs(p: { from: number; to: number; before?: number; severity?: number; service?: string; traceId?: string; q?: string; limit: number; filters?: Filter[] }): { logs: LogRecord[]; nextBefore: string | null } {
  const out: LogRecord[] = [], q = p.q?.toLowerCase();
  const ok = (l: LogRecord) => (!p.severity || l.severityNumber >= p.severity) && (!p.service || l.service === p.service) && (!p.traceId || l.traceId === p.traceId) && (!q || l.body.toLowerCase().includes(q)) && (!p.filters?.length || matches('logs', l, p.filters));
  const hi = Math.floor(Math.min(p.before ?? p.to, p.to) / SEC), lo = Math.floor(p.from / SEC);
  if (p.traceId) {
    const k = slotOf(p.traceId), base = k * TSLOT;
    for (let i = 0; i < 9; i++) { const l = logAt(base + i * 2 + 1, 0, p.traceId); if (l && ok(l)) out.push(l); }
    out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return { logs: out, nextBefore: null };
  }
  let iter = 0;
  for (let s = hi; s >= lo && out.length < p.limit && iter < 200_000; s--, iter++) {
    for (let k = 1; k >= 0; k--) { const l = logAt(s, k); if (l && ok(l) && Date.parse(l.ts) < (p.before ?? Infinity) && Date.parse(l.ts) >= p.from) out.push(l); }
  }
  out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const cut = out.slice(0, p.limit);
  return { logs: cut, nextBefore: out.length >= p.limit ? cut[cut.length - 1].ts : null };
}

// ---------- metrics ----------
const METRICS: Array<MetricInfo & { base: number; amp: number; keys: string[] }> = [
  { name: 'http.server.request.duration', type: 'histogram', unit: 'ms', description: 'Duration of inbound HTTP requests (mean per interval).', service: 'api-gateway', points: 48210, lastSeen: '', base: 118, amp: 40, keys: ['http.request.method', 'http.response.status_code', 'http.route'] },
  { name: 'http.server.request.duration', type: 'histogram', unit: 'ms', description: 'Duration of inbound HTTP requests (mean per interval).', service: 'catalog-service', points: 22140, lastSeen: '', base: 46, amp: 18, keys: ['http.request.method', 'http.response.status_code', 'http.route'] },
  { name: 'http.server.request.duration', type: 'histogram', unit: 'ms', description: 'Duration of inbound HTTP requests (mean per interval).', service: 'cart-service', points: 19876, lastSeen: '', base: 74, amp: 30, keys: ['http.request.method', 'http.response.status_code', 'http.route'] },
  { name: 'process.cpu.utilization', type: 'gauge', unit: '1', description: 'Fraction of CPU used by the process.', service: 'catalog-service', points: 31002, lastSeen: '', base: 0.38, amp: 0.18, keys: ['host.name'] },
  { name: 'process.cpu.utilization', type: 'gauge', unit: '1', description: 'Fraction of CPU used by the process.', service: 'payment-service', points: 30544, lastSeen: '', base: 0.12, amp: 0.06, keys: ['host.name'] },
  { name: 'process.runtime.memory.rss', type: 'gauge', unit: 'MB', description: 'Resident set size.', service: 'cart-service', points: 30211, lastSeen: '', base: 412, amp: 60, keys: ['host.name'] },
  { name: 'db.client.connections.usage', type: 'gauge', unit: 'conns', description: 'Open connections in the pool.', service: 'postgres', points: 29980, lastSeen: '', base: 22, amp: 9, keys: ['db.client.connections.state', 'pool.name'] },
  { name: 'http.server.active_requests', type: 'sum', unit: 'req', description: 'In-flight HTTP requests.', service: 'api-gateway', points: 41002, lastSeen: '', base: 14, amp: 8, keys: ['http.request.method'] },
  { name: 'cart.items.added', type: 'sum', unit: 'items', description: 'Items added to carts.', service: 'cart-service', points: 8120, lastSeen: '', base: 36, amp: 24, keys: ['product.category'] },
  { name: 'payment.charge.latency', type: 'histogram', unit: 'ms', description: 'Latency of payment provider calls.', service: 'payment-service', points: 6901, lastSeen: '', base: 310, amp: 90, keys: ['payment.provider'] },
];
export function metricList(to: number): MetricInfo[] { return METRICS.map(({ base: _b, amp: _a, keys: _k, ...m }) => ({ ...m, lastSeen: iso(to - 12_000) })); }
const MOCK_GROUPS: Record<string, string[]> = {
  'host.name': ['web-1', 'web-2', 'web-3'], 'http.route': ['/api/products', '/api/cart', '/api/checkout'], 'http.request.method': ['GET', 'POST'],
  'http.response.status_code': ['200', '304', '500'], 'payment.provider': ['stripe', 'adyen'], 'product.category': ['shoes', 'shirts', 'bags'],
  'db.client.connections.state': ['used', 'idle'], 'pool.name': ['primary', 'replica'],
};
export function metricSeries(from: number, to: number, name: string, service: string | undefined, agg: string, groupBy?: string): MetricSeriesResponse {
  const all = METRICS.filter((x) => x.name === name);
  const scoped = (service ? all.filter((x) => x.service === service) : all);
  const ms = scoped.length ? scoped : [METRICS[0]];
  const bs = NICE.find((b) => b * SEC * 60 >= to - from) ?? 86400;
  const start = Math.ceil(from / (bs * SEC)) * bs * SEC;
  const mul = agg === 'sum' ? 12 * ms.length : agg === 'max' ? 1.6 : agg === 'min' ? 0.55 : agg === 'p95' ? 1.9 : 1;
  const gen = (m: (typeof METRICS)[number], gi: number, k: number) => {
    const points: Array<{ t: string; value: number }> = [];
    for (let t = start; t < to; t += bs * SEC) {
      const wave = Math.sin(t / 3.6e6 / 2.2 + gi) * 0.5 + Math.sin(t / 3.6e5 + gi * 2) * 0.15;
      const v = (m.base * k + m.amp * wave + m.amp * 0.3 * (rnd(t / 1000, gi, 81) - 0.5)) * mul;
      points.push({ t: iso(t), value: Math.max(0, Math.round(v * 1000) / 1000) });
    }
    return points;
  };
  const avgBase = { ...ms[0], base: ms.reduce((a, m) => a + m.base, 0) / ms.length };
  const series = groupBy === 'service.name'
    ? ms.map((m, gi) => ({ key: m.service, points: gen(m, gi, 1) }))
    : (groupBy ? (MOCK_GROUPS[groupBy] ?? ['(none)']) : ['']).map((key, gi) => ({ key, points: gen(avgBase, gi + ms.length, 1 + gi * 0.18) }));
  return { bucketSeconds: bs, series, attributeKeys: [...new Set(ms.flatMap((m) => m.keys))].sort() };
}
