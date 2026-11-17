import type { AnalyticsEvent, LiveEvent, Watch } from '../api/contract';
import { CLICKS, ERRORS, HTTP_ERRORS, PAGES, CUSTOM, BROWSERS, OSES, DEVICES, PLACES } from './universe';
import { weighted, pick, hex, hash, uuidOf } from './rng';

const sub = (hay: string | null, needle?: string) => !needle || (hay ?? '').toLowerCase().includes(needle.toLowerCase());
function matches(w: Watch, e: AnalyticsEvent): boolean {
  if (w.type !== e.type) return false;
  if (w.selector && !sub(e.selector, w.selector)) return false;
  if (w.text && !sub(e.elementText, w.text)) return false;
  if (w.name && !sub(e.type === 'custom' ? e.name : e.trackName, w.name)) return false;
  if (w.path && !sub(e.path, w.path)) return false;
  return true;
}
const TYPES = [{ t: 'click', w: 48 }, { t: 'pageview', w: 30 }, { t: 'custom', w: 8 }, { t: 'error', w: 4 }, { t: 'http_error', w: 6 }, { t: 'vitals', w: 4 }] as const;
let seq = 0;
const sessions = Array.from({ length: 24 }, (_, i) => { const pl = weighted(PLACES, i, 97); return { sessionId: 's' + hex(7, i, 99), anonId: uuidOf(i, 98), userId: i % 3 === 0 ? `user_${hash(i, 96) % 900}` : null, browser: pick(BROWSERS, i).k, os: pick(OSES, i + 3).k, device: weighted(DEVICES, i, 5).k, country: pl.c, region: pl.r, city: pl.city, lat: pl.lat, lon: pl.lon }; });

function makeEvent(): AnalyticsEvent {
  seq++;
  const type = weighted(TYPES.map((t) => ({ ...t })), seq, Date.now()).t;
  const s = pick(sessions, seq, 3);
  const base: AnalyticsEvent = { id: 'live_' + hex(10, seq, Date.now()), type, ts: new Date().toISOString(), sessionId: s.sessionId, anonId: s.anonId, userId: s.userId, url: null, path: weighted(PAGES, seq, 4).path, title: null, referrer: null,
    selector: null, elementText: null, elementTag: null, trackName: null, errorMessage: null, errorStack: null, errorSource: null, fingerprint: null, httpMethod: null, httpUrl: null, httpRoute: null, httpStatus: null, durationMs: null, name: null, props: {}, browser: s.browser, os: s.os, device: s.device, country: s.country, region: s.region, city: s.city, lat: s.lat, lon: s.lon, bot: null };
  base.url = 'https://shop.acme.dev' + base.path;
  if (type === 'click') { const c = weighted(CLICKS, seq, 5); Object.assign(base, { selector: c.selector, elementText: c.text, elementTag: c.tag, trackName: c.track, path: c.path }); }
  else if (type === 'error') { const e = weighted(ERRORS, seq, 6); Object.assign(base, { errorMessage: e.msg, errorStack: e.stack, errorSource: e.source, fingerprint: e.fp }); }
  else if (type === 'http_error') { const h = weighted(HTTP_ERRORS, seq, 7); Object.assign(base, { httpMethod: h.method, httpUrl: h.url, httpRoute: h.route, httpStatus: h.status, durationMs: h.ms }); }
  else if (type === 'custom') base.name = pick(CUSTOM, seq, 8);
  else if (type === 'vitals') base.name = pick(['LCP', 'FCP', 'CLS', 'INP'], seq, 9);
  return base;
}

export class MockWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private watches: Watch[] = [];
  private firehose = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(public url: string) { setTimeout(() => { if (this.readyState !== 0) return; this.readyState = 1; this.onopen?.(new Event('open')); this.loop(); }, 250); }
  private emit(m: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(m) })); }
  private loop = () => {
    if (this.readyState !== 1) return;
    const batch: LiveEvent[] = [];
    const n = Math.random() < 0.25 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const e = makeEvent();
      const m = this.watches.filter((w) => matches(w, e)).map((w) => w.id);
      if (this.firehose || m.length) batch.push({ ...e, matches: m });
    }
    if (batch.length) this.emit({ type: 'events', events: batch });
    this.timer = setTimeout(this.loop, 150 + Math.random() * 350);
  };
  send(data: string) {
    const m = JSON.parse(data);
    if (m.action === 'subscribe') { this.watches = m.watches ?? []; this.firehose = !!m.firehose; setTimeout(() => this.emit({ type: 'subscribed', watches: this.watches.length, firehose: this.firehose }), 20); }
    else if (m.action === 'ping') setTimeout(() => this.emit({ type: 'pong' }), 20);
  }
  close() { this.readyState = 3; clearTimeout(this.timer); setTimeout(() => this.onclose?.(new CloseEvent('close')), 0); }
}
