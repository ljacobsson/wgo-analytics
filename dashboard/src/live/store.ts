import { useContext, createContext, useSyncExternalStore, useEffect, useId } from 'react';
import type { LiveEvent, ServerMessage, Watch } from '../api/contract';
import { getConfig } from '../api/config';
import { getIdToken } from '../auth/cognito';
import { KIOSK_TOKEN } from '../lib/kiosk';

export type LiveStatus = 'connecting' | 'connected' | 'reconnecting';
export interface FeedItem { ev: LiveEvent; at: number }
const FEED_CAP = 500;
// The latest firehose events are kept per project in localStorage, so a page opened right after them (the
// overview after onboarding, a reload) can show what arrived before the warehouse has it.
const RECENT_CAP = 100;
const RECENT_MAX_AGE = 60 * 60_000;
const recentKey = (pid: string) => `wgo.recent.${pid}`;
function loadRecent(pid: string): FeedItem[] {
  try {
    const items = JSON.parse(localStorage.getItem(recentKey(pid)) ?? '[]') as FeedItem[];
    return Array.isArray(items) ? items.filter((it) => it?.ev && Date.now() - it.at < RECENT_MAX_AGE) : [];
  } catch { return []; }
}
/** Keeps what the overview shows; stacks and payloads would only fill up the storage. */
const slim = (ev: LiveEvent): LiveEvent => ({ ...ev, errorStack: null, props: {} });

export class LiveStore {
  pid: string;
  status: LiveStatus = 'connecting';
  watches: Watch[];
  counts: Record<string, number> = {};
  lastFired: Record<string, number> = {};
  perSec: Record<string, Map<number, number>> = {};
  feed: FeedItem[] = [];
  frozen: FeedItem[] | null = null;
  /** Latest firehose events, newest first, kept across page loads (see loadRecent). */
  recent: FeedItem[];
  eventsSeen = 0;
  onFire: ((w: Watch, e: LiveEvent) => void) | null = null;

  private ws: WebSocket | null = null;
  private fh = new Set<string>();
  private listeners = new Set<() => void>();
  private version = 0;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private retry = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(pid: string) {
    this.pid = pid;
    this.recent = KIOSK_TOKEN ? [] : loadRecent(pid);
    // a kiosk gets its watches from its configuration (setWatches), not from this browser's storage
    try { this.watches = KIOSK_TOKEN ? [] : JSON.parse(localStorage.getItem(`wgo.watches.${pid}`) ?? '[]'); } catch { this.watches = []; }
  }

  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => this.listeners.delete(cb); };
  getVersion = () => this.version;
  private bump() {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => { this.notifyTimer = undefined; this.version++; this.listeners.forEach((l) => l()); }, 80);
  }

  get paused() { return this.frozen !== null; }
  get viewFeed() { return this.frozen ?? this.feed; }
  setPaused(p: boolean) { this.frozen = p ? this.feed : null; this.version++; this.listeners.forEach((l) => l()); }
  clearFeed() { this.feed = []; if (this.frozen) this.frozen = []; this.bump(); }

  // ---- watches ----
  private persist() { localStorage.setItem(`wgo.watches.${this.pid}`, JSON.stringify(this.watches)); this.resubscribe(); this.bump(); }
  addWatch(w: Omit<Watch, 'id'>): Watch {
    const full = { ...w, id: 'w_' + Math.random().toString(36).slice(2, 10) };
    this.watches = [...this.watches, full]; this.persist(); return full;
  }
  updateWatch(w: Watch) { this.watches = this.watches.map((x) => (x.id === w.id ? w : x)); this.persist(); }
  removeWatch(id: string) { this.watches = this.watches.filter((x) => x.id !== id); this.persist(); }
  /** Kiosk: replace the watches without saving them in this browser. */
  setWatches(watches: Watch[]) {
    if (JSON.stringify(watches) === JSON.stringify(this.watches)) return;
    this.watches = watches; this.resubscribe(); this.bump();
  }

  /** Components that need the firehose register a token; subscription follows the set. */
  wantFirehose(token: string, on: boolean) {
    const had = this.fh.size > 0;
    if (on) this.fh.add(token); else this.fh.delete(token);
    if (had !== this.fh.size > 0) this.resubscribe();
  }

  series(id: string, now = Date.now()): number[] {
    const sec = Math.floor(now / 1000), m = this.perSec[id];
    return Array.from({ length: 60 }, (_, i) => m?.get(sec - 59 + i) ?? 0);
  }

  // ---- connection ----
  start() {
    this.stopped = false;
    // read again: the store this one replaces (onboarding's, say) saves its last events when it stops,
    // which happens after this one was created
    if (!KIOSK_TOKEN && this.eventsSeen === 0) this.recent = loadRecent(this.pid);
    void this.connect();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer); clearInterval(this.pingTimer); clearTimeout(this.notifyTimer);
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = undefined; this.saveRecent(); }
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onclose = null; ws.close(); }
  }
  private async connect() {
    if (this.stopped) return;
    const token = KIOSK_TOKEN ? null : await getIdToken();
    if (this.stopped || (!token && !KIOSK_TOKEN)) return;
    const url = KIOSK_TOKEN
      ? `${getConfig().wsUrl}?kiosk=${encodeURIComponent(KIOSK_TOKEN)}`
      : `${getConfig().wsUrl}?token=${encodeURIComponent(token!)}&projectId=${encodeURIComponent(this.pid)}`;
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0; this.status = 'connected';
      this.resubscribe();
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ action: 'ping' }), 4 * 60_000);
      this.bump();
    };
    ws.onmessage = (m) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      if (msg.type === 'events') this.ingest(msg.events);
    };
    ws.onclose = () => { clearInterval(this.pingTimer); this.ws = null; this.scheduleReconnect(); };
    ws.onerror = () => ws.close();
  }
  private scheduleReconnect() {
    if (this.stopped) return;
    this.status = 'reconnecting'; this.bump();
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++) * (0.8 + Math.random() * 0.4);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }
  private send(o: unknown) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o)); }
  private resubscribe() { this.send({ action: 'subscribe', watches: this.watches, firehose: this.fh.size > 0 }); }

  private ingest(events: LiveEvent[]) {
    const now = Date.now(), sec = Math.floor(now / 1000);
    this.eventsSeen += events.length;
    for (const ev of events) {
      for (const id of ev.matches ?? []) {
        const w = this.watches.find((x) => x.id === id);
        if (!w) continue;
        this.counts[id] = (this.counts[id] ?? 0) + 1;
        this.lastFired[id] = now;
        const m = (this.perSec[id] ??= new Map());
        m.set(sec, (m.get(sec) ?? 0) + 1);
        for (const k of m.keys()) if (k < sec - 62) m.delete(k);
        this.onFire?.(w, ev);
      }
    }
    if (this.fh.size > 0) {
      const items = events.map((ev) => ({ ev, at: now })).reverse();
      this.feed = [...items, ...this.feed].slice(0, FEED_CAP);
      this.recent = [...items.map((it) => ({ ev: slim(it.ev), at: it.at })), ...this.recent].slice(0, RECENT_CAP);
      if (!KIOSK_TOKEN) this.persistTimer ??= setTimeout(() => { this.persistTimer = undefined; this.saveRecent(); }, 1000);
    }
    this.bump();
  }
  private saveRecent() {
    try { localStorage.setItem(recentKey(this.pid), JSON.stringify(this.recent)); } catch { /* full or unavailable: memory only */ }
  }
}

export const LiveCtx = createContext<LiveStore>(null as never);
export function useLive(): LiveStore {
  const s = useContext(LiveCtx);
  useSyncExternalStore(s.subscribe, s.getVersion);
  return s;
}
export function useFirehose(on: boolean) {
  const s = useContext(LiveCtx);
  const token = useId();
  useEffect(() => { s.wantFirehose(token, on); return () => s.wantFirehose(token, false); }, [s, token, on]);
}
