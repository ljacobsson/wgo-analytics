import { useEffect, useRef, useState } from 'react';
import { CalendarClock, Check, ChevronDown, ChevronLeft, ChevronRight, X, ZoomOut } from 'lucide-react';
import { zoomedOut } from '../charts/zoom';
import { PRESETS, PRESET_MS, type Preset, type TimeRange, useTime } from '../lib/time';
import { useSetParams } from '../lib/router';
import { Button, Field } from '../ui/kit';
import { cn } from '../lib/format';

const iconBtn = 'h-8 w-8 place-items-center rounded-lg border border-line bg-[var(--hl)] text-muted transition-colors hover:border-[var(--line-strong)] hover:text-fg cursor-pointer';
const stepBtn = 'grid w-7 place-items-center text-muted transition-colors hover:bg-[var(--hl)] hover:text-fg cursor-pointer disabled:cursor-default disabled:text-faint disabled:opacity-40 disabled:hover:bg-transparent';

/** "15 minutes", "2 hours", "7 days" for a window length. */
function span(ms: number): string {
  const [n, unit] = ms >= 86400e3 ? [ms / 86400e3, 'day'] : ms >= 3600e3 ? [ms / 3600e3, 'hour'] : [ms / 60e3, 'minute'];
  const r = Number.isInteger(n) ? n : Math.round(n * 10) / 10;
  return r === 1 ? unit : `${r} ${unit}s`;
}

const toLocal = (iso: string) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/** The preset the user last picked, so clearing a zoom (or a custom range) goes back to it. */
const LAST_PRESET = 'wgo-last-preset';
const lastPreset = (): Preset => { const p = sessionStorage.getItem(LAST_PRESET); return (PRESETS as readonly string[]).includes(p ?? '') ? (p as Preset) : '24h'; };

/** How close to now a window's end has to be to count as "up to now" (nothing later to step to). */
const nowSlack = (ms: number) => Math.max(60e3, ms / 50);

/**
 * The window one window-length earlier (dir -1) or later (+1). Stepping later never goes past now; a step that
 * reaches now lands on the matching "Last …" preset when the window is one, so it keeps following live data.
 */
function stepped(r: TimeRange, dir: -1 | 1): Record<string, string | null> {
  const now = Date.now();
  let a = Date.parse(r.from) + dir * r.ms, b = Date.parse(r.to) + dir * r.ms;
  if (dir > 0 && b >= now - nowSlack(r.ms)) {
    const preset = PRESETS.find((p) => Math.abs(PRESET_MS[p] - r.ms) < 1000);
    if (preset) return { range: preset === '24h' ? null : preset, from: null, to: null };
    b = now; a = now - r.ms;
  }
  return { range: 'custom', from: new Date(a).toISOString(), to: new Date(b).toISOString() };
}

export function TimePicker() {
  const { range } = useTime();
  const set = useSetParams();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(toLocal(range.from));
  const [to, setTo] = useState(toLocal(range.to));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setFrom(toLocal(range.from)); setTo(toLocal(range.to));
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const custom = range.preset === 'custom';
  useEffect(() => { if (!custom) sessionStorage.setItem(LAST_PRESET, range.preset); }, [custom, range.preset]);
  const atNow = !custom || Date.now() - Date.parse(range.to) < nowSlack(range.ms);
  const step = (dir: -1 | 1) => set(stepped(range, dir), false);
  const clear = () => { const p = lastPreset(); set({ range: p === '24h' ? null : p, from: null, to: null }, false); };
  const zoomOut = () => {
    const [a, b] = zoomedOut(Date.parse(range.from), Date.parse(range.to));
    set({ range: 'custom', from: new Date(a).toISOString(), to: new Date(b).toISOString() }, false);
  };
  return (
    <div ref={ref} className="relative flex items-center gap-1.5">
      {custom && (
        <button onClick={zoomOut} title="Zoom out: twice as long a window around the same time (drag across a chart to zoom in, Back to undo)" className={cn(iconBtn, 'hidden sm:grid')}>
          <ZoomOut size={14} />
        </button>)}
      <div className="flex h-8 items-stretch overflow-hidden rounded-lg border border-line bg-[var(--hl)] transition-colors hover:border-[var(--line-strong)]">
        <button onClick={() => step(-1)} title={`Earlier: the ${span(range.ms)} before this`} className={stepBtn}><ChevronLeft size={14} /></button>
        <button onClick={() => setOpen(!open)} className="flex items-center gap-2 whitespace-nowrap border-x border-line px-2 text-[12.5px] sm:px-3 font-medium cursor-pointer hover:bg-[var(--hl)]">
          <CalendarClock size={14} className="hidden text-muted sm:block" />{range.label}<ChevronDown size={13} className="hidden text-faint sm:block" />
        </button>
        <button onClick={() => step(1)} disabled={atNow} title={atNow ? 'Already showing up to now' : `Later: the ${span(range.ms)} after this`} className={stepBtn}><ChevronRight size={14} /></button>
      </div>
      {custom && (
        <button onClick={clear} title={`Clear zoom: back to Last ${lastPreset()}`}
          className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-[var(--hl)] px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:border-[var(--line-strong)] hover:text-fg cursor-pointer">
          <X size={14} /><span className="hidden sm:inline">Clear</span>
        </button>)}
      {open && (
        <div className="anim-pop absolute right-0 top-10 z-40 w-[300px] max-w-[calc(100vw-24px)] rounded-xl border border-line bg-[var(--raised)] p-2 shadow-2xl">
          {PRESETS.map((p) => (
            <button key={p} onClick={() => { set({ range: p === '24h' ? null : p, from: null, to: null }); setOpen(false); }}
              className={cn('flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left text-[13px] hover:bg-[var(--hl)] cursor-pointer', range.preset === p && 'text-accent')}>
              Last {p}{range.preset === p && <Check size={14} />}
            </button>
          ))}
          <div className="mt-1 space-y-2 border-t border-line p-2 pt-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-faint">Custom range</div>
            <Field label="From"><input type="datetime-local" className="field" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><input type="datetime-local" className="field" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            <Button variant="primary" className="w-full" disabled={!from || !to || from >= to}
              onClick={() => { set({ range: 'custom', from: new Date(from).toISOString(), to: new Date(to).toISOString() }); setOpen(false); }}>Apply</Button>
          </div>
        </div>
      )}
    </div>
  );
}
