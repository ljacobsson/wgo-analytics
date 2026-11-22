import type { AnalyticsEvent, HeatmapResponse, RecordingFilters, RecordingChunk, RecordingResponse, RecordingSettings, RecordingsResponse, RecordingSummary } from '../api/contract';
import { events } from './data';
import { rnd } from './rng';

/**
 * Mock session recordings: some of the mock sessions (data.ts, 90 s blocks), replayed over a made-up shop page.
 * The page's clickable elements sit at fixed positions, so the pointer lands on the element each click event names.
 */

const BLOCK = 90_000;
const VW = 1440, VH = 900;
const X0 = (VW - 1200) / 2;

export const DEFAULT_MOCK_SETTINGS: RecordingSettings = {
  enabled: true, samplePercent: 10, triggers: [{ type: 'error', value: '' }, { type: 'page', value: '/checkout*' }], maxPerHour: 100, maxPerDay: 1000, maskAllText: false,
};

// ---------------------------------------------------------------- the page

const CSS = `*{box-sizing:border-box}body{margin:0;font:15px/1.5 Inter,system-ui,sans-serif;color:#1d1b26;background:#faf9f7}
a{color:inherit;text-decoration:none}.abs{position:absolute}.sec{position:relative;width:1200px;margin:0 auto}
.promo-banner{height:44px;background:#1d1b26;color:#f4f1ea;font-size:13px}.promo-banner .sec{height:44px;display:flex;align-items:center;justify-content:center}
.promo-banner button{background:#f5c451;color:#1d1b26;border:0;border-radius:6px;font:600 12px Inter,system-ui;cursor:pointer}
header{height:64px;border-bottom:1px solid #ece8e1;background:#fff}.logo{font:700 20px Georgia,serif;letter-spacing:-.5px}
nav a{font-size:14px;color:#55526a}.btn{display:grid;place-items:center;border-radius:10px;font-weight:600;font-size:14px;border:0}
.btn-primary{background:#2f6b55;color:#fff}.btn-ghost{background:#fff;border:1px solid #d8d3ca}
h1{font:600 52px/1.08 Georgia,serif;letter-spacing:-1.5px;margin:0}h2{font:600 28px Georgia,serif;margin:0}
.muted{color:#6c6878}.card{background:#fff;border:1px solid #ece8e1;border-radius:16px;overflow:hidden}
.img{border-radius:12px;background:linear-gradient(135deg,#e8dcc8,#c9d8cf)}.img.b{background:linear-gradient(135deg,#d9d1e8,#f0dcc8)}.img.c{background:linear-gradient(135deg,#cfe0e6,#e6e0cf)}
input.f{border:1px solid #d8d3ca;border-radius:9px;padding:0 12px;font:14px Inter,system-ui;background:#fff}
footer{background:#1d1b26;color:#b9b4c8;height:160px}.link{background:none;border:0;color:#2f6b55;font-weight:600;text-align:left}`;

type Box = [x: number, y: number, w: number, h: number];
const at = ([x, y, w, h]: Box) => `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;

/** clickable elements per path, in page coordinates (relative to the 1200 px container, y from the page top) */
const TARGETS: Record<string, Record<string, Box>> = {
  '*': { '.promo-banner button': [1000, -100, 110, 28], 'nav a[href="/pricing"]': [480, -46, 60, 24], '#theme-toggle': [1150, -50, 32, 32] },
  '/': { '.hero .btn-primary': [0, 330, 150, 48], '#signup-cta': [170, 330, 180, 48], 'button.add-to-cart': [24, 984, 332, 42] },
  '/products/aurora-lamp': { 'main > div.product > button.buy': [660, 420, 220, 52], 'button.add-to-cart': [900, 420, 220, 52] },
  '/products/nimbus-chair': { 'main > div.product > button.buy': [660, 420, 220, 52], 'button.add-to-cart': [900, 420, 220, 52] },
  '/products/halo-mug': { 'main > div.product > button.buy': [660, 420, 220, 52] },
  '/products': { 'button.add-to-cart': [24, 534, 332, 42] },
  '/cart': { '#checkout-btn': [860, 380, 300, 52] },
  '/checkout': { 'input#coupon + button': [1060, 470, 100, 44] },
  '/docs/getting-started': { 'a.docs-link': [0, 300, 180, 24] },
  '/blog/launch-week': { 'button.newsletter-submit': [760, 1460, 140, 46] },
};
const HEADER = 108; // promo + header

function body(path: string): string {
  const t = TARGETS[path] ?? {};
  const b = (sel: string, cls: string, label: string, extra = '') => {
    const box = t[sel];
    return box ? `<button class="abs ${cls}" style="${at(box)}" ${extra}>${label}</button>` : '';
  };
  const products = (y: number) => ['Aurora lamp', 'Nimbus chair', 'Halo mug'].map((n, i) =>
    `<div class="abs card" style="${at([i * 404, y, 380, 470])}"><div class="img ${['', 'b', 'c'][i]}" style="height:300px;margin:12px;border-radius:10px"></div>
     <div style="padding:4px 24px"><div style="font-weight:600">${n}</div><div class="muted">$${[129, 349, 39][i]}</div></div>
     <button class="abs btn btn-primary add-to-cart" style="left:24px;bottom:24px;width:332px;height:42px">Add to cart</button></div>`).join('');
  switch (path) {
    case '/': return `<section class="sec hero" style="height:900px"><div class="abs" style="top:90px;width:620px"><h1>Lighting for the way you actually live</h1>
      <p class="muted" style="font-size:18px;margin-top:20px">Warm, dimmable lamps and furniture made to last. Free returns for 100 days.</p></div>
      ${b('.hero .btn-primary', 'btn btn-primary', 'Get started')}${b('#signup-cta', 'btn btn-ghost', 'Start free trial', 'id="signup-cta"')}
      <div class="abs img" style="${at([680, 40, 520, 420])}"></div><h2 class="abs" style="top:520px">Bestsellers</h2>${products(580 - 0)}</section>`;
    case '/products/aurora-lamp': case '/products/nimbus-chair': case '/products/halo-mug':
      return `<main class="sec" style="height:820px"><div class="product"><div class="abs img" style="${at([0, 40, 600, 600])}"></div>
        <div class="abs" style="left:660px;top:60px;width:540px"><div class="muted">Acme Home</div><h1 style="font-size:44px">${path.split('/').pop()!.replace('-', ' ').replace(/^./, (c) => c.toUpperCase())}</h1>
        <p style="font-size:24px;margin:16px 0">$${path.includes('chair') ? 349 : path.includes('mug') ? 39 : 129}</p><p class="muted">Hand-finished, shipped in recycled packaging. Two-year warranty.</p></div>
        ${b('main > div.product > button.buy', 'btn btn-primary buy', 'Buy now')}${b('button.add-to-cart', 'btn btn-ghost add-to-cart', 'Add to cart')}</div></main>`;
    case '/products': return `<main class="sec" style="height:1100px"><h1 class="abs" style="top:30px;font-size:40px">All products</h1>${products(130)}</main>`;
    case '/cart': return `<main class="sec" style="height:700px"><h1 class="abs" style="top:30px;font-size:40px">Your cart</h1>
      <div class="abs card" style="${at([0, 130, 780, 140])}"><div class="img" style="width:110px;height:110px;margin:15px;display:inline-block"></div><span style="position:absolute;left:150px;top:40px;font-weight:600">Aurora lamp</span><span class="muted" style="position:absolute;right:24px;top:40px">$129</span></div>
      <div class="abs card" style="${at([840, 130, 360, 320])};padding:24px"><div style="font-weight:600;margin-bottom:12px">Summary</div><div class="muted">Subtotal $129<br>Shipping free</div></div>
      ${b('#checkout-btn', 'btn btn-primary', 'Checkout', 'id="checkout-btn"')}</main>`;
    case '/checkout': return `<main class="sec" style="height:760px"><h1 class="abs" style="top:30px;font-size:40px">Checkout</h1>
      <input class="abs f" id="email" placeholder="Email" style="${at([0, 140, 560, 46])}"><input class="abs f" id="name" placeholder="Name on card" style="${at([0, 206, 560, 46])}">
      <input class="abs f" id="card" placeholder="Card number" style="${at([0, 272, 560, 46])}"><input class="abs f" id="coupon" placeholder="Coupon" style="${at([860, 470, 190, 44])}">
      ${b('input#coupon + button', 'btn btn-ghost', 'Apply')}<button class="abs btn btn-primary" style="${at([0, 360, 560, 52])}">Pay $129</button></main>`;
    case '/blog/launch-week': return `<main class="sec" style="height:1640px"><article class="abs" style="left:200px;top:40px;width:800px"><h1 style="font-size:44px">Launch week: five new lamps</h1>
      ${'<p class="muted" style="font-size:17px;line-height:1.8">We spent a year on the warmest light we could make. Every lamp in the new range dims down to candlelight and up to a reading light, without a flicker in between. Here is what went into them, and what we learned along the way.</p>'.repeat(8)}</article>
      <div class="abs card" style="${at([200, 1420, 800, 130])};padding:24px"><div style="font-weight:600">Get the next post by email</div><input class="f" style="width:520px;height:46px;margin-top:10px" placeholder="you@example.com"></div>
      ${b('button.newsletter-submit', 'btn btn-primary newsletter-submit', 'Subscribe')}</main>`;
    case '/docs/getting-started': return `<main class="sec" style="height:900px"><h1 class="abs" style="top:40px;font-size:40px">Getting started</h1>
      <p class="abs muted" style="top:130px;width:700px">Set up your Acme account, connect your lamps and create your first scene.</p>${b('a.docs-link', 'docs-link link', 'Read the docs →')}</main>`;
    case '/pricing': return `<main class="sec" style="height:760px"><h1 class="abs" style="top:40px;font-size:44px">Simple pricing</h1>${['Basic', 'Plus', 'Studio'].map((n, i) =>
      `<div class="abs card" style="${at([i * 404, 170, 380, 460])};padding:28px"><div style="font-weight:600">${n}</div><div style="font:600 40px Georgia,serif;margin:16px 0">$${[0, 9, 29][i]}</div><div class="muted">${['One room', 'Your whole home', 'Homes and studios'][i]}</div></div>`).join('')}</main>`;
    default: return `<main class="sec" style="height:700px"><h1 class="abs" style="top:40px;font-size:40px">${path === '/login' ? 'Sign in' : path === '/account' ? 'Your account' : path}</h1>
      <input class="abs f" placeholder="Email" style="${at([0, 150, 420, 46])}"><input class="abs f" type="password" placeholder="Password" style="${at([0, 216, 420, 46])}"></main>`;
  }
}

function html(path: string): string {
  const g = TARGETS['*'];
  const nav = ['Products', 'Pricing', 'Docs', 'Blog'].map((n, i) => `<a class="abs" href="/${n.toLowerCase()}" style="left:${400 + i * 80}px;top:20px">${n}</a>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><base href="https://shop.acme.dev${path}"><title>Acme</title><style data-wgo-c="0"></style></head><body>
<div class="promo-banner"><div class="sec">Spring sale: 20% off every lamp, this week only<button class="abs" style="${at([g['.promo-banner button'][0], 8, 110, 28])}">Claim offer</button></div></div>
<header><div class="sec" style="height:64px"><a class="abs logo" href="/" style="top:16px">acme</a><nav>${nav}</nav><button id="theme-toggle" class="abs btn btn-ghost" style="left:1150px;top:16px;width:32px;height:32px">◐</button></div></header>
${body(path)}
<footer><div class="sec" style="height:160px"><div class="abs" style="top:40px">© Acme Home</div><a class="abs twitter" href="#" style="left:1100px;top:40px">Twitter</a></div></footer>
</body></html>`;
}

/** page height, from the section heights in body() */
function pageHeight(path: string): number {
  const m = /^\s*<(?:section|main)[^>]*?style="height:(\d+)px/.exec(body(path));
  return HEADER + 160 + (m ? Number(m[1]) : 700);
}

// ---------------------------------------------------------------- sessions

function sessionEvents(block: number, sk: number): AnalyticsEvent[] {
  return events({ from: block * BLOCK - 1000, to: (block + 1) * BLOCK + 1000, sessionId: `s${block.toString(36)}${sk}`, limit: 200 }).events
    .filter((e) => e.type !== 'vitals').sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

const recorded = (block: number, sk: number) => rnd(block, sk, 77) < 0.14;

function summary(block: number, sk: number, evs: AnalyticsEvent[]): RecordingSummary {
  const first = Date.parse(evs[0].ts) - 2500, last = Date.parse(evs[evs.length - 1].ts) + 4000;
  const e = evs[0];
  const errors = evs.filter((x) => x.type === 'error' || x.type === 'http_error').length;
  const checkout = evs.some((x) => x.path?.startsWith('/checkout'));
  return {
    sessionId: e.sessionId!, startedAt: new Date(first).toISOString(), endedAt: new Date(last).toISOString(), durationMs: last - first,
    reason: errors && rnd(block, sk, 78) < 0.6 ? 'trigger:error' : checkout && rnd(block, sk, 79) < 0.5 ? 'trigger:page:/checkout*' : 'sample',
    anonId: e.anonId, userId: evs.find((x) => x.userId)?.userId ?? null, entryPath: evs.find((x) => x.type === 'pageview')?.path ?? e.path,
    pages: evs.filter((x) => x.type === 'pageview').length, clicks: evs.filter((x) => x.type === 'click').length, errors,
    events: evs.filter((x) => x.type !== 'pageview').length,
    active: evs.some((x) => x.type === 'click') || evs.filter((x) => x.type === 'pageview').length > 1,
    rageClicks: evs.filter((x) => x.type === 'click' && x.props?.rage).length * 3,
    paths: [...new Set(evs.map((x) => x.path).filter((p): p is string => !!p))].slice(0, 20),
    browser: e.browser, os: e.os, device: e.device, country: e.country, city: e.city,
  };
}

/** The backend's filter rules (backend/src/lib/recordings.ts matchesFilters), for mock mode. */
function matches(r: RecordingSummary, f: RecordingFilters): boolean {
  if (!r.endedAt || r.durationMs < 3000) return false;
  if (!r.active && !f.inactive && !f.errors) return false;
  if (f.minDuration && r.durationMs < f.minDuration * 1000) return false;
  if (f.errors && !r.errors) return false;
  if (f.rage && !r.rageClicks) return false;
  if (f.identified && !r.userId) return false;
  if (f.device && r.device !== f.device) return false;
  if (f.reason === 'sample' && r.reason !== 'sample') return false;
  if (f.reason === 'trigger' && !r.reason.startsWith('trigger:')) return false;
  if (f.page) {
    const p = f.page.toLowerCase();
    const re = p.includes('*') ? new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$') : null;
    if (![r.entryPath, ...r.paths].some((x) => x && (re ? re.test(x.toLowerCase()) : x.toLowerCase().includes(p)))) return false;
  }
  const q = f.q?.toLowerCase();
  if (q && ![r.userId, r.anonId, ...r.paths, r.country, r.city, r.browser, r.os, r.device].some((v) => v?.toLowerCase().includes(q))) return false;
  return true;
}

export function listRecordings(from: number, to: number, before: number | undefined, limit = 50, f: RecordingFilters = {}): RecordingsResponse {
  const out: RecordingSummary[] = [];
  let b = Math.floor(Math.min(to, before ?? Infinity, Date.now()) / BLOCK);
  const lo = Math.floor(from / BLOCK);
  for (; b >= lo && out.length < limit; b--) {
    for (let sk = 3; sk >= 0 && out.length < limit; sk--) {
      if (!recorded(b, sk)) continue;
      const evs = sessionEvents(b, sk);
      if (evs.length < 2) continue;
      const s = summary(b, sk, evs);
      if (Date.parse(s.startedAt) < (before ?? Infinity) && matches(s, f)) out.push(s);
    }
  }
  return { recordings: out, nextBefore: out.length >= limit ? out[out.length - 1].startedAt : null };
}

/** The recording of a mock session, built from its events: pointer paths to each click, scrolling, page changes. */
export function getRecording(sessionId: string): RecordingResponse | null {
  const block = parseInt(sessionId.slice(1, -1), 36), sk = Number(sessionId.slice(-1));
  if (Number.isNaN(block) || !recorded(block, sk)) return null;
  const evs = sessionEvents(block, sk);
  if (evs.length < 2) return null;
  const rec = summary(block, sk, evs);
  const frames: Array<[number, ...unknown[]]> = [];
  const t0 = Date.parse(rec.startedAt);
  let path = evs.find((e) => e.type === 'pageview')?.path ?? evs[0].path ?? '/';
  let x = VW / 2, y = VH / 2, sy = 0, n = 0;
  const r = (...k: number[]) => rnd(block, sk, n++, ...k);
  const snap = (t: number, p: string, first = false) => {
    frames.push([t, 0, { w: VW, h: VH, sx: 0, sy: 0, u: `https://shop.acme.dev${p}`, ti: 'Acme', ch: 'css1', j: { html: html(p), css: first ? [CSS] : null } }]);
    sy = 0;
  };
  const moveTo = (tx: number, ty: number, end: number, ms = 900) => {
    const sx0 = x, sy0 = y, steps = Math.max(4, Math.round(ms / 50));
    const bend = (r() - 0.5) * 160;
    for (let i = 1; i <= steps; i++) {
      const f = i / steps, e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
      frames.push([end - ms + i * (ms / steps), 1, Math.round(sx0 + (tx - sx0) * e + Math.sin(f * Math.PI) * bend), Math.round(sy0 + (ty - sy0) * e + Math.sin(f * Math.PI) * bend * 0.4)]);
    }
    x = tx; y = ty;
  };
  const scrollTo = (target: number, end: number, ms = 700) => {
    const max = Math.max(0, pageHeight(path) - VH);
    target = Math.max(0, Math.min(max, target));
    const from = sy, steps = 8;
    for (let i = 1; i <= steps; i++) frames.push([end - ms + i * (ms / steps), 3, 0, Math.round(from + (target - from) * (i / steps))]);
    sy = target;
  };
  const go = (p: string, t: number) => { if (p !== path) { path = p; snap(t, p); } };

  frames.push([t0, 4, VW, VH]);
  snap(t0 + 100, path, true);
  let prev = t0 + 400;
  for (const e of evs) {
    const at = Date.parse(e.ts);
    if (at - prev > 2500) {
      // reading: drift the pointer, maybe scroll a bit
      moveTo(Math.round(X0 + r() * 1100), Math.round(150 + r() * 600), prev + 1500, 1100);
      if (r() < 0.6) scrollTo(sy + 200 + r() * 500, Math.min(at - 400, prev + 2600));
    }
    if (e.type === 'pageview') go(e.path ?? '/', at);
    else if (e.type === 'click') {
      go(e.path ?? path, at - 1300);
      const box = TARGETS[path]?.[e.selector ?? ''] ?? TARGETS['*'][e.selector ?? ''];
      let px: number, py: number;
      if (box) {
        px = X0 + box[0] + box[2] / 2;
        py = (box[1] < 0 ? HEADER + box[1] : HEADER + box[1]) + box[3] / 2;
        if (box[1] < 0) { if (sy) scrollTo(0, at - 950, 450); py = HEADER + box[1] + box[3] / 2; }
        else if (py - sy > VH - 60 || py - sy < 60) scrollTo(py - VH / 2, at - 950, 500);
      } else { px = X0 + 100 + r() * 1000; py = sy + 200 + r() * 500; }
      moveTo(Math.round(px), Math.round(py - sy), at - 40, 800);
      frames.push([at, 2, Math.round(px), Math.round(py - sy)]);
      if (e.props?.rage) for (let i = 1; i <= 3; i++) frames.push([at + i * 180, 2, Math.round(px), Math.round(py - sy)]);
    } else if (path === '/checkout' && r() < 0.7) {
      // typing into the form: lengths only
      const field = ['#email', '#name', '#card'][Math.floor(r() * 3)];
      for (let i = 1; i <= 12; i++) frames.push([at - 1400 + i * 110, 5, field, 0, i]);
    }
    prev = at;
  }
  moveTo(Math.round(X0 + r() * 1000), Math.round(200 + r() * 400), Date.parse(rec.endedAt!) - 200, 1200);
  frames.sort((a, b) => a[0] - b[0]);

  // into chunks of up to 5 s, as the SDK sends them
  const chunks: RecordingChunk[] = [];
  let cur: RecordingChunk | null = null;
  for (const [t, ...rest] of frames) {
    if (!cur || t - Date.parse(cur.ts) > 5000) {
      cur = { ts: new Date(t).toISOString(), page: 'page-1', seq: chunks.length, dur: 0, url: null, r: [] };
      chunks.push(cur);
    }
    const off = t - Date.parse(cur.ts);
    cur.r.push([rest[0], off, ...rest.slice(1)]);
    cur.dur = off;
  }
  return { recording: rec, chunks, nextAfter: null };
}

/**
 * Mock click heatmap of a page: clusters on the page's clickable elements (page coordinates, 8 px buckets) plus a
 * few stray clicks on text, with the newest recorded desktop session that viewed the page as the snapshot.
 * Mobile has no mock snapshots (the mock recordings are all desktop pages).
 */
export function heatmap(path: string, from: number, to: number, device: 'desktop' | 'mobile'): HeatmapResponse {
  const hours = Math.max(1, (to - from) / 3_600_000);
  const mobile = device === 'mobile';
  const vw = mobile ? 390 : VW;
  const cells = new Map<string, { x: number; y: number; n: number }>();
  const add = (x: number, y: number, n: number) => {
    const bx = Math.floor(x / 8) * 8, by = Math.floor(y / 8) * 8;
    if (bx < 0 || by < 0 || bx >= vw) return;
    const k = `${bx},${by}`;
    const c = cells.get(k) ?? { x: bx, y: by, n: 0 };
    c.n += n; cells.set(k, c);
  };
  const boxes = Object.entries({ ...TARGETS['*'], ...TARGETS[path] });
  let i = 0;
  for (const [, [bx, by, bw, bh]] of boxes) {
    const w = 0.5 + rnd(i, 61, path.length) * 1.5;
    const cx = mobile ? 40 + rnd(i, 62) * 300 : X0 + bx + bw / 2, cy = (mobile ? 200 + i * 160 : HEADER + by + bh / 2);
    const count = Math.round(70 * w * Math.min(8, hours));
    for (let k = 0; k < count; k++) {
      const a = rnd(i, k, 63) * Math.PI * 2, d = Math.sqrt(rnd(i, k, 64));
      add(cx + Math.cos(a) * d * (mobile ? 30 : bw / 2 + 6), cy + Math.sin(a) * d * (mobile ? 20 : bh / 2 + 6), 1 + Math.floor(rnd(i, k, 65) * 2));
    }
    i++;
  }
  const h = pageHeight(path);
  for (let k = 0; k < 18 * Math.min(8, hours); k++) add((mobile ? 10 : X0) + rnd(k, 66) * (mobile ? 370 : 1200), HEADER + rnd(k, 67, path.length) ** 1.6 * (h - HEADER - 160), 1);
  const points = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 5000);
  let snapshot: HeatmapResponse['snapshot'] = null;
  if (!mobile) {
    const rec = listRecordings(from, to, undefined, 60, {}).recordings.find((r) => r.device === 'desktop' && r.paths.includes(path));
    if (rec) snapshot = { sessionId: rec.sessionId, at: Date.parse(rec.startedAt) + 3000 };
  }
  return { vw, points, total: points.reduce((a, p) => a + p.n, 0), snapshot };
}
