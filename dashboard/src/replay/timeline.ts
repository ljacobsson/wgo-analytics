import type { RecordingChunk } from '../api/contract';

/**
 * Turns a recording's chunks (see sdk/src/replay/recorder.ts for the record format) into per-tab tracks, and
 * answers "what did the screen look like at time T" for the player. Times are epoch milliseconds.
 */

export interface SnapMeta {
  w: number; h: number; sx: number; sy: number;
  u?: string; ti?: string; ch?: string;
  /** gzip + base64 of {html, css} */
  z?: string;
  /** the same, uncompressed (browsers without CompressionStream) */
  j?: Payload;
  /** the page was too large to record */
  big?: 1;
}
interface Payload { html: string; css: string[] | null }

export interface Snap { at: number; page: string; meta: SnapMeta; payload?: Promise<Payload | null>; html?: Promise<string | null> }

type P2 = [number, number, number];
interface Track {
  page: string;
  snaps: Snap[];
  /** pointer positions, moves and clicks: [at, x, y] */
  moves: P2[];
  scrolls: P2[];
  elScrolls: Array<[number, number, number, string]>;
  viewports: P2[];
  inputs: Array<[number, string, number, number]>;
  hidden: Array<[number, number]>;
}

export interface Click { at: number; x: number; y: number; page: string; touch: boolean }
export interface Nav { at: number; url: string; page: string }

export interface Timeline {
  start: number;
  end: number;
  tracks: Map<string, Track>;
  /** which tab the visitor was looking at, from each change on: [at, page] */
  active: Array<[number, string]>;
  clicks: Click[];
  navs: Nav[];
  /** stretches without activity, skipped when "skip inactivity" is on */
  idle: Array<[number, number]>;
  snaps: Snap[];
}

const IDLE_MS = 5000;

/** Index of the last item with item[0] <= t, or -1. */
export function lastAt<T extends { 0: number } | { at: number }>(arr: T[], t: number): number {
  // tuples are arrays, and every array has an `at` method: test for the array first
  const at = (x: T) => (Array.isArray(x) ? (x[0] as number) : (x as { at: number }).at);
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (at(arr[mid]) <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export function buildTimeline(chunks: RecordingChunk[]): Timeline {
  const frames: Array<{ at: number; page: string; r: unknown[] }> = [];
  let end = 0;
  for (const c of chunks) {
    const base = Date.parse(c.ts);
    end = Math.max(end, base + (c.dur || 0));
    for (const r of c.r) if (Array.isArray(r) && typeof r[1] === 'number') frames.push({ at: base + r[1], page: c.page, r });
  }
  frames.sort((a, b) => a.at - b.at);
  const tracks = new Map<string, Track>();
  const track = (page: string) => {
    let t = tracks.get(page);
    if (!t) tracks.set(page, (t = { page, snaps: [], moves: [], scrolls: [], elScrolls: [], viewports: [], inputs: [], hidden: [] }));
    return t;
  };
  const active: Array<[number, string]> = [];
  const clicks: Click[] = [];
  const navs: Nav[] = [];
  const snaps: Snap[] = [];
  const busy: number[] = [];
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  for (const { at, page, r } of frames) {
    const t = track(page);
    const kind = r[0];
    const a = r.slice(2);
    if (kind === 6 && a[0] === 1) { t.hidden.push([at, 1]); continue; }
    if (!active.length || active[active.length - 1][1] !== page) active.push([at, page]);
    if (kind !== 6) busy.push(at);
    switch (kind) {
      case 0: {
        const meta = a[0] as SnapMeta;
        if (!meta || typeof meta !== 'object') break;
        const s: Snap = { at, page, meta };
        const prev = t.snaps[t.snaps.length - 1];
        if (meta.u && (!prev || prev.meta.u !== meta.u)) navs.push({ at, url: meta.u, page });
        t.snaps.push(s);
        snaps.push(s);
        break;
      }
      case 1: t.moves.push([at, n(a[0]), n(a[1])]); break;
      case 2:
        t.moves.push([at, n(a[0]), n(a[1])]);
        clicks.push({ at, x: n(a[0]), y: n(a[1]), page, touch: a[2] === 1 });
        break;
      case 3:
        if (typeof a[2] === 'string') t.elScrolls.push([at, n(a[0]), n(a[1]), a[2]]);
        else t.scrolls.push([at, n(a[0]), n(a[1])]);
        break;
      case 4: t.viewports.push([at, n(a[0]), n(a[1])]); break;
      case 5: if (typeof a[0] === 'string') t.inputs.push([at, a[0], n(a[1]), n(a[2])]); break;
      case 6: t.hidden.push([at, 0]); break;
    }
  }
  const start = frames.length ? frames[0].at : chunks.length ? Date.parse(chunks[0].ts) : 0;
  end = Math.max(end, frames.length ? frames[frames.length - 1].at : start);
  const idle: Array<[number, number]> = [];
  for (let i = 1; i < busy.length; i++) {
    if (busy[i] - busy[i - 1] > IDLE_MS) idle.push([busy[i - 1] + 1000, busy[i] - 500]);
  }
  return { start, end, tracks, active, clicks, navs, idle, snaps };
}

export interface FrameState {
  page: string | null;
  snap: Snap | null;
  vw: number;
  vh: number;
  sx: number;
  sy: number;
  /** element scroll positions recorded since the snapshot, by selector */
  elScrolls: Map<string, [number, number]>;
  /** form field states since the snapshot, by selector: [kind, value] */
  inputs: Map<string, [number, number]>;
  cursor: { x: number; y: number } | null;
  ripples: Array<{ x: number; y: number; age: number; touch: boolean }>;
  hidden: boolean;
  url: string | null;
}

const RIPPLE_MS = 650;

export function frameAt(tl: Timeline, t: number): FrameState {
  const ai = lastAt(tl.active, t);
  const page = (ai >= 0 ? tl.active[ai] : tl.active[0])?.[1] ?? null;
  const tr = page ? tl.tracks.get(page) : undefined;
  const empty: FrameState = { page, snap: null, vw: 1280, vh: 800, sx: 0, sy: 0, elScrolls: new Map(), inputs: new Map(), cursor: null, ripples: [], hidden: false, url: null };
  if (!tr) return empty;

  const si = lastAt(tr.snaps, t);
  const snap = si >= 0 ? tr.snaps[si] : tr.snaps[0] ?? null;
  const since = snap && snap.at <= t ? snap.at : -Infinity;

  const vi = lastAt(tr.viewports, t);
  const vp = vi >= 0 && (!snap || tr.viewports[vi][0] >= since) ? tr.viewports[vi] : null;
  const vw = vp?.[1] || snap?.meta.w || 1280;
  const vh = vp?.[2] || snap?.meta.h || 800;

  const sc = lastAt(tr.scrolls, t);
  const scroll = sc >= 0 && tr.scrolls[sc][0] >= since ? tr.scrolls[sc] : null;
  const sx = scroll ? scroll[1] : snap?.meta.sx ?? 0;
  const sy = scroll ? scroll[2] : snap?.meta.sy ?? 0;

  const elScrolls = new Map<string, [number, number]>();
  for (let i = lastAt(tr.elScrolls, t); i >= 0 && tr.elScrolls[i][0] >= since; i--) {
    const [, x, y, sel] = tr.elScrolls[i];
    if (!elScrolls.has(sel)) elScrolls.set(sel, [x, y]);
  }
  const inputs = new Map<string, [number, number]>();
  for (let i = lastAt(tr.inputs, t); i >= 0 && tr.inputs[i][0] >= since; i--) {
    const [, sel, kind, v] = tr.inputs[i];
    if (!inputs.has(sel)) inputs.set(sel, [kind, v]);
  }

  let cursor: FrameState['cursor'] = null;
  const mi = lastAt(tr.moves, t);
  if (mi >= 0) {
    const [a, x, y] = tr.moves[mi];
    const next = tr.moves[mi + 1];
    // glide towards the next sample when they're close together (the SDK samples every 50 ms)
    if (next && next[0] - a < 400) {
      const f = (t - a) / (next[0] - a);
      cursor = { x: x + (next[1] - x) * f, y: y + (next[2] - y) * f };
    } else cursor = { x, y };
  }

  const ripples: FrameState['ripples'] = [];
  for (let i = lastAt(tl.clicks, t); i >= 0 && t - tl.clicks[i].at < RIPPLE_MS; i--) {
    const c = tl.clicks[i];
    if (c.page === page) ripples.push({ x: c.x, y: c.y, age: (t - c.at) / RIPPLE_MS, touch: c.touch });
  }

  const hi = lastAt(tr.hidden, t);
  const hidden = hi >= 0 && tr.hidden[hi][1] === 1;
  return { page, snap, vw, vh, sx, sy, elScrolls, inputs, cursor, ripples, hidden, url: snap?.meta.u ?? null };
}

/** The next moment with activity after `t` when `t` falls in an idle stretch, else `t`. */
export function skipIdle(tl: Timeline, t: number): number {
  const i = lastAt(tl.idle, t);
  return i >= 0 && t < tl.idle[i][1] ? tl.idle[i][1] : t;
}

// ---------------------------------------------------------------- snapshot documents

async function inflate(z: string): Promise<string> {
  const bin = atob(z);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

function payload(s: Snap): Promise<Payload | null> {
  s.payload ??= (async () => {
    if (s.meta.big) return null;
    if (s.meta.j) return s.meta.j;
    if (!s.meta.z) return null;
    try { return JSON.parse(await inflate(s.meta.z)) as Payload; } catch { return null; }
  })();
  return s.payload;
}

/** Freezes the page: no transitions, animations at their end state, no smooth scrolling, no text caret. */
const PLAYER_CSS = '<style>*,*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important;caret-color:transparent!important}html{scroll-behavior:auto!important}</style>';

/**
 * The snapshot as a document for the player's iframe (srcdoc): stylesheets filled in, from an earlier snapshot
 * when the recorder didn't send them again because they hadn't changed.
 */
export function snapshotHtml(tl: Timeline, s: Snap): Promise<string | null> {
  s.html ??= (async () => {
    const p = await payload(s);
    if (!p) return null;
    let css = p.css;
    if (!css && s.meta.ch) {
      for (let i = tl.snaps.indexOf(s) - 1; i >= 0 && !css; i--) {
        const o = tl.snaps[i];
        if (o.meta.ch === s.meta.ch) css = (await payload(o))?.css ?? null;
      }
    }
    const html = p.html.replace(/<style data-wgo-c="(\d+)"([^>]*)><\/style>/g, (_, i: string, rest: string) =>
      `<style${rest}>${(css?.[Number(i)] ?? '').replace(/<\/style/gi, '<\\/style')}</style>`);
    const at = html.indexOf('</head>');
    return at >= 0 ? html.slice(0, at) + PLAYER_CSS + html.slice(at) : PLAYER_CSS + html;
  })();
  return s.html;
}
