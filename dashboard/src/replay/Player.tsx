import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Maximize2, Pause, Play, RotateCcw } from 'lucide-react';
import { cn } from '../lib/format';
import { Segmented, Switch } from '../ui/kit';
import { frameAt, skipIdle, snapshotHtml, type FrameState, type Snap, type Timeline } from './timeline';

// ---------------------------------------------------------------- the clock

export interface Marker { at: number; kind: 'error' | 'nav' | 'custom'; label: string }

/**
 * Playback position and speed. Frame consumers (the viewport) subscribe and run on every animation frame; React
 * reads a snapshot that changes at most ten times a second (controls, event list).
 */
export class Playback {
  t: number;
  playing = false;
  speed = 1;
  skip = true;
  private frame = new Set<(t: number) => void>();
  private ui = new Set<() => void>();
  private raf = 0;
  private last = 0;
  private uiAt = 0;
  private snap: { t: number; playing: boolean; speed: number; skip: boolean };

  constructor(private tl: Timeline) {
    this.t = tl.start;
    this.snap = this.read();
  }

  private read() { return { t: this.t, playing: this.playing, speed: this.speed, skip: this.skip }; }
  private notify(force = false) {
    const now = performance.now();
    if (!force && now - this.uiAt < 100) return;
    this.uiAt = now;
    this.snap = this.read();
    this.ui.forEach((f) => f());
  }
  getSnapshot = () => this.snap;
  subscribeUi = (f: () => void) => { this.ui.add(f); return () => { this.ui.delete(f); }; };
  onFrame(f: (t: number) => void) { this.frame.add(f); f(this.t); return () => { this.frame.delete(f); }; }

  private emit() { this.frame.forEach((f) => f(this.t)); }

  seek(t: number) {
    this.t = Math.min(Math.max(t, this.tl.start), this.tl.end);
    this.emit();
    this.notify(true);
  }
  play() {
    if (this.playing) return;
    if (this.t >= this.tl.end) this.t = this.tl.start;
    this.playing = true;
    this.last = performance.now();
    const step = (now: number) => {
      if (!this.playing) return;
      let t = this.t + (now - this.last) * this.speed;
      this.last = now;
      if (this.skip) t = skipIdle(this.tl, t);
      if (t >= this.tl.end) { this.t = this.tl.end; this.playing = false; this.emit(); this.notify(true); return; }
      this.t = t;
      this.emit();
      this.notify();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
    this.notify(true);
  }
  pause() { this.playing = false; cancelAnimationFrame(this.raf); this.notify(true); }
  toggle() { if (this.playing) this.pause(); else this.play(); }
  setSpeed(s: number) { this.speed = s; this.notify(true); }
  setSkip(b: boolean) { this.skip = b; this.notify(true); }
  dispose() { this.pause(); this.frame.clear(); this.ui.clear(); }
}

export function usePlayback(tl: Timeline | null) {
  const pb = useMemo(() => (tl ? new Playback(tl) : null), [tl]);
  useEffect(() => () => pb?.dispose(), [pb]);
  const noop = useCallback(() => () => {}, []);
  const state = useSyncExternalStore(pb?.subscribeUi ?? noop, pb?.getSnapshot ?? (() => null));
  return { pb, state };
}

// ---------------------------------------------------------------- the viewport

const PLACEHOLDER = (msg: string) =>
  `<!DOCTYPE html><html><body style="margin:0;display:grid;place-items:center;height:100vh;font:14px system-ui;color:#888;background:repeating-linear-gradient(45deg,#8881 0 10px,transparent 10px 20px)">${msg}</body></html>`;

const q = (doc: Document, sel: string): Element | null => { try { return doc.querySelector(sel); } catch { return null; } };

interface Frame { el: HTMLIFrameElement; snap: Snap | null | undefined; ready: boolean; inputs: Map<string, string>; scrolls: Map<string, string> }

/** Puts form state and element scroll positions on the document, undoing what no longer applies (seeking back). */
function applyState(f: Frame, st: FrameState) {
  const doc = f.el.contentDocument;
  const win = f.el.contentWindow;
  if (!doc || !win) return;
  if (Math.round(win.scrollX) !== st.sx || Math.round(win.scrollY) !== st.sy) win.scrollTo(st.sx, st.sy);

  for (const [sel] of f.scrolls) {
    if (st.elScrolls.has(sel)) continue;
    const el = q(doc, sel);
    const [x, y] = (el?.getAttribute('data-wgo-sc') ?? '0,0').split(',').map(Number);
    if (el) { el.scrollLeft = x; el.scrollTop = y; }
    f.scrolls.delete(sel);
  }
  for (const [sel, [x, y]] of st.elScrolls) {
    const key = `${x},${y}`;
    if (f.scrolls.get(sel) === key) continue;
    const el = q(doc, sel);
    if (el) { el.scrollLeft = x; el.scrollTop = y; }
    f.scrolls.set(sel, key);
  }

  for (const [sel] of f.inputs) {
    if (st.inputs.has(sel)) continue;
    const el = q(doc, sel);
    if (el instanceof HTMLInputElement) { el.value = el.defaultValue; el.checked = el.defaultChecked; }
    else if (el instanceof HTMLTextAreaElement) el.value = el.defaultValue;
    else if (el instanceof HTMLSelectElement) el.selectedIndex = Math.max(0, Array.from(el.options).findIndex((o) => o.defaultSelected));
    f.inputs.delete(sel);
  }
  for (const [sel, [kind, v]] of st.inputs) {
    const key = `${kind}:${v}`;
    if (f.inputs.get(sel) === key) continue;
    const el = q(doc, sel);
    if (kind === 0 && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.value = '•'.repeat(v);
    else if (kind === 1 && el instanceof HTMLInputElement) el.checked = v === 1;
    else if (kind === 2 && el instanceof HTMLSelectElement) el.selectedIndex = v;
    f.inputs.set(sel, key);
  }
}

/**
 * The recorded page in a sandboxed iframe (no scripts, no forms, no navigation), scaled to fit, with the visitor's
 * pointer and clicks drawn on top. Two iframes take turns: a new snapshot loads in the hidden one and is shown
 * once ready, so page changes don't flash.
 */
export function Viewport({ tl, pb, className }: { tl: Timeline; pb: Playback; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const ifr = [useRef<HTMLIFrameElement>(null), useRef<HTMLIFrameElement>(null)];
  const cursor = useRef<HTMLDivElement>(null);
  const ripples = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLSpanElement>(null);
  const sizeRef = useRef<HTMLSpanElement>(null);
  const awayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frames: Frame[] = ifr.map((r) => ({ el: r.current!, snap: undefined, ready: false, inputs: new Map(), scrolls: new Map() }));
    let shown = 0;
    let want: Snap | null | undefined;
    let last: FrameState | null = null;
    let fit = { w: 0, h: 0 };
    let size = { w: 0, h: 0, s: 1 };
    let token = 0;

    const layout = (vw: number, vh: number) => {
      const s = Math.min(fit.w / vw, fit.h / vh) || 1;
      if (vw === size.w && vh === size.h && s === size.s) return;
      size = { w: vw, h: vh, s };
      stage.current!.style.width = `${vw * s}px`;
      stage.current!.style.height = `${vh * s}px`;
      for (const f of frames) { f.el.style.width = `${vw}px`; f.el.style.height = `${vh}px`; f.el.style.transform = `scale(${s})`; }
      sizeRef.current!.textContent = `${vw} × ${vh}`;
    };

    const load = (snap: Snap | null) => {
      want = snap;
      const my = ++token;
      const back = frames[1 - shown];
      void (snap ? snapshotHtml(tl, snap) : Promise.resolve(null)).then((html) => {
        if (my !== token) return;
        back.ready = false;
        back.snap = snap;
        back.inputs.clear();
        back.scrolls.clear();
        back.el.onload = () => {
          if (my !== token) return;
          const doc = back.el.contentDocument;
          doc?.querySelectorAll('[data-wgo-sc]').forEach((el) => {
            const [x, y] = el.getAttribute('data-wgo-sc')!.split(',').map(Number);
            el.scrollLeft = x; el.scrollTop = y;
          });
          back.ready = true;
          if (last) applyState(back, last);
          frames[shown].el.style.visibility = 'hidden';
          back.el.style.visibility = 'visible';
          shown = 1 - shown;
        };
        back.el.srcdoc = html ?? PLACEHOLDER(snap?.meta.big ? 'This page was too large to record' : 'Waiting for the first snapshot of this page');
      });
    };

    const render = (t: number) => {
      const st = (last = frameAt(tl, t));
      layout(st.vw, st.vh);
      if (st.snap !== want) load(st.snap);
      const f = frames[shown];
      if (f.ready && f.snap === want) applyState(f, st);
      const c = cursor.current!;
      if (st.cursor) { c.style.display = 'block'; c.style.transform = `translate(${st.cursor.x * size.s}px, ${st.cursor.y * size.s}px)`; }
      else c.style.display = 'none';
      const rp = ripples.current!;
      while (rp.children.length < st.ripples.length) rp.appendChild(document.createElement('i'));
      Array.from(rp.children).forEach((el, i) => {
        const r = st.ripples[i];
        const e = el as HTMLElement;
        if (!r) { e.style.display = 'none'; return; }
        const d = (r.touch ? 34 : 26) * (0.6 + r.age);
        Object.assign(e.style, { display: 'block', left: `${r.x * size.s - d / 2}px`, top: `${r.y * size.s - d / 2}px`, width: `${d}px`, height: `${d}px`, opacity: String(1 - r.age) });
      });
      urlRef.current!.textContent = st.url ?? '';
      awayRef.current!.style.display = st.hidden ? 'grid' : 'none';
    };

    const ro = new ResizeObserver(([e]) => {
      fit = { w: e.contentRect.width, h: e.contentRect.height };
      size = { w: 0, h: 0, s: 1 };
      render(pb.t);
    });
    ro.observe(box.current!);
    const off = pb.onFrame(render);
    return () => { off(); ro.disconnect(); token++; };
  }, [tl, pb]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-[var(--hl)]', className)}>
      <div className="flex items-center gap-3 border-b border-line px-3 py-2 text-[12px]">
        <span className="flex gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-[var(--line-strong)]" /><i className="h-2.5 w-2.5 rounded-full bg-[var(--line-strong)]" /><i className="h-2.5 w-2.5 rounded-full bg-[var(--line-strong)]" /></span>
        <span ref={urlRef} className="min-w-0 flex-1 truncate rounded-md bg-[var(--bg)] px-2.5 py-1 font-mono text-[11.5px] text-muted" />
        <span ref={sizeRef} className="tnum text-faint" />
      </div>
      <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
        <div className="absolute inset-0 grid place-items-center">
          <div ref={stage} className="relative overflow-hidden bg-white shadow-lg">
            {ifr.map((r, i) => (
              <iframe key={i} ref={r} title="Recorded page" sandbox="allow-same-origin" tabIndex={-1}
                className="pointer-events-none absolute left-0 top-0 origin-top-left border-0 bg-white" style={{ visibility: 'hidden' }} />
            ))}
            <div className="absolute inset-0" />
            <div ref={ripples} className="pointer-events-none absolute inset-0 [&>i]:absolute [&>i]:rounded-full [&>i]:border-2 [&>i]:border-accent [&>i]:bg-accent/25" />
            <div ref={cursor} className="pointer-events-none absolute left-0 top-0" style={{ display: 'none' }}>
              <svg width="18" height="22" viewBox="0 0 18 22" className="drop-shadow-[0_1px_2px_rgba(0,0,0,.45)]">
                <path d="M1 1 L1 17 L5.2 13.2 L8 20 L11 18.7 L8.3 12.2 L14 12.2 Z" fill="#111" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
              </svg>
            </div>
            <div ref={awayRef} className="absolute inset-0 place-items-center bg-black/55 text-[13px] font-medium text-white" style={{ display: 'none' }}>
              The visitor switched to another tab
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- controls

export const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(sec).padStart(2, '0')}`;
};

const SPEEDS = ['1', '2', '4', '8'] as const;

export function Controls({ tl, pb, state, markers, extra }: {
  tl: Timeline; pb: Playback; state: { t: number; playing: boolean; speed: number; skip: boolean };
  markers: Marker[]; extra?: ReactNode;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const len = Math.max(1, tl.end - tl.start);
  const pct = (at: number) => `${((at - tl.start) / len) * 100}%`;
  const timeAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return tl.start + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * len;
  };
  const drag = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    pb.seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => pb.seek(timeAt(ev.clientX));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const ended = state.t >= tl.end && !state.playing;

  return (
    <div className="space-y-2.5">
      <div ref={bar} className="group relative h-7 cursor-pointer touch-none select-none" onPointerDown={drag}
        onPointerMove={(e) => setHover(timeAt(e.clientX))} onPointerLeave={() => setHover(null)}>
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-[var(--line)]">
          {tl.idle.map(([a, b]) => <i key={a} className="absolute inset-y-0 bg-[repeating-linear-gradient(90deg,var(--line-strong)_0_2px,transparent_2px_5px)]" style={{ left: pct(a), width: `${((b - a) / len) * 100}%` }} />)}
          <i className="absolute inset-y-0 left-0 grad-bg" style={{ width: pct(state.t) }} />
        </div>
        {tl.clicks.map((c) => <i key={`c${c.at}`} className="absolute top-[3px] h-1.5 w-px bg-[var(--s3)]" style={{ left: pct(c.at) }} />)}
        {markers.map((m) => (
          <i key={`${m.kind}${m.at}`} title={m.label}
            className={cn('absolute bottom-[2px] h-2 w-[3px] -translate-x-1/2 rounded-sm', m.kind === 'error' ? 'bg-bad' : m.kind === 'nav' ? 'bg-[var(--s1)]' : 'bg-[var(--s7)]')} style={{ left: pct(m.at) }} />
        ))}
        <i className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-accent shadow transition-transform group-hover:scale-110" style={{ left: pct(state.t) }} />
        {hover !== null && (
          <span className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded bg-[var(--raised)] px-1.5 py-0.5 font-mono text-[11px] text-muted shadow" style={{ left: pct(hover) }}>{fmtClock(hover - tl.start)}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => pb.toggle()} title={state.playing ? 'Pause (space)' : 'Play (space)'}
          className="grid h-9 w-9 place-items-center rounded-full grad-bg text-white shadow-[0_6px_18px_-6px_rgba(124,108,240,.8)] cursor-pointer hover:brightness-110">
          {state.playing ? <Pause size={16} fill="currentColor" /> : ended ? <RotateCcw size={16} /> : <Play size={16} fill="currentColor" className="ml-0.5" />}
        </button>
        <span className="font-mono text-[12.5px] tnum text-muted">{fmtClock(state.t - tl.start)} <span className="text-faint">/ {fmtClock(len)}</span></span>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {extra}
          <Switch checked={state.skip} onChange={(b) => pb.setSkip(b)} label="Skip inactivity" />
          <Segmented value={String(state.speed) as (typeof SPEEDS)[number]} onChange={(v) => pb.setSpeed(Number(v))} options={SPEEDS.map((s) => ({ value: s, label: `${s}×` }))} />
        </div>
      </div>
    </div>
  );
}

export function FullscreenButton({ target }: { target: React.RefObject<HTMLElement | null> }) {
  return (
    <button title="Full screen" onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : target.current?.requestFullscreen())}
      className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-[var(--hl)] text-muted hover:text-fg cursor-pointer"><Maximize2 size={14} /></button>
  );
}
