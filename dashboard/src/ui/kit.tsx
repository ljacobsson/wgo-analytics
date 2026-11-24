import { useEffect, useRef, useState, createContext, useContext, useCallback, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, X, Inbox, AlertTriangle } from 'lucide-react';
import { cn, copy as copyText, delta, fmtPct } from '../lib/format';
import type { EventType } from '../api/contract';

export function Card({ className, children, hover, ...rest }: { className?: string; children: ReactNode; hover?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cn('glass', hover && 'glass-hover', className)}>{children}</div>;
}
export function CardHeader({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pt-3.5 pb-2">
      <div className="min-w-0"><h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>{sub && <p className="text-[11.5px] text-faint mt-0.5">{sub}</p>}</div>
      {right}
    </div>
  );
}
export function Skeleton({ className }: { className?: string }) { return <div className={cn('skeleton', className)} />; }
export function SkeletonRows({ n = 6, h = 'h-9' }: { n?: number; h?: string }) {
  return <div className="space-y-2 p-4">{Array.from({ length: n }, (_, i) => <Skeleton key={i} className={h} />)}</div>;
}

export function Button({ variant = 'secondary', size = 'md', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }) {
  const v = {
    primary: 'grad-bg text-white shadow-[0_6px_20px_-6px_rgba(124,108,240,.7)] hover:brightness-110',
    secondary: 'bg-[var(--hl)] border border-line hover:border-[var(--line-strong)] hover:bg-[var(--line)]',
    ghost: 'hover:bg-[var(--hl)] text-muted hover:text-fg',
    danger: 'bg-bad/15 text-bad border border-bad/30 hover:bg-bad/25',
  }[variant];
  return <button {...p} className={cn('inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-all duration-150 active:scale-[.98] disabled:opacity-50 disabled:pointer-events-none cursor-pointer', size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3.5 py-1.5 text-[13px]', v, className)} />;
}

const TONES = {
  neutral: 'bg-[var(--hl)] text-muted border-line',
  accent: 'bg-accent/15 text-accent border-accent/30',
  good: 'bg-good/12 text-good border-good/30',
  warn: 'bg-warn/12 text-warn border-warn/30',
  bad: 'bg-bad/12 text-bad border-bad/30',
  cyan: 'bg-accent2/12 text-accent2 border-accent2/30',
};
export function Badge({ tone = 'neutral', children, className }: { tone?: keyof typeof TONES; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-[1px] text-[11px] font-medium leading-5 whitespace-nowrap', TONES[tone], className)}>{children}</span>;
}

export const TYPE_COLOR: Record<EventType, string> = {
  pageview: 'var(--s1)', click: 'var(--s3)', error: 'var(--s8)', http_error: 'var(--s2)', custom: 'var(--s7)', vitals: 'var(--s4)', identify: 'var(--s5)',
};
export function TypeBadge({ type }: { type: EventType }) {
  const c = TYPE_COLOR[type];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border px-1.5 text-[11px] font-medium leading-5 w-[84px]" style={{ borderColor: `color-mix(in srgb, ${c} 35%, transparent)`, background: `color-mix(in srgb, ${c} 14%, transparent)` }}>
      <i className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: c }} /><span className="truncate">{type}</span>
    </span>
  );
}
export function StatusPill({ status }: { status: number }) {
  const tone = status === 0 ? 'neutral' : status >= 500 ? 'bad' : status >= 400 ? 'warn' : status >= 300 ? 'cyan' : 'good';
  return <Badge tone={tone} className="font-mono tnum min-w-[42px] justify-center">{status === 0 ? 'NET' : status}</Badge>;
}
export function MethodBadge({ method }: { method: string }) {
  return <span className="inline-block w-[52px] rounded-md bg-[var(--hl)] border border-line px-1.5 text-center font-mono text-[10.5px] font-semibold leading-5 text-muted">{method}</span>;
}
export function Delta({ cur, prev, invert }: { cur: number; prev: number; invert?: boolean }) {
  const d = delta(cur, prev);
  if (d == null) return <span className="text-[11px] text-faint">new</span>;
  const up = d > 0.05, down = d < -0.05;
  const good = invert ? down : up, bad = invert ? up : down;
  return <span className={cn('inline-flex items-center text-[11.5px] font-medium tnum', good ? 'text-good' : bad ? 'text-bad' : 'text-faint')}>{up ? '▲' : down ? '▼' : '–'}&nbsp;{fmtPct(Math.abs(d)).replace('+', '')}</span>;
}
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-[var(--hl)] px-1.5 py-[1px] font-mono text-[10.5px] text-muted">{children}</kbd>;
}
export function Mono({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cn('font-mono text-[12px]', className)}>{children}</span>;
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode }> }) {
  return (
    <div className="inline-flex max-w-full overflow-x-auto rounded-lg border border-line bg-[var(--hl)] p-0.5">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} className={cn('shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-[12px] font-medium transition-all duration-150 cursor-pointer', value === o.value ? 'bg-[var(--raised)] text-fg shadow-sm' : 'text-muted hover:text-fg')}>{o.label}</button>
      ))}
    </div>
  );
}

/** `pinned`: inside a sideways-scrolling table, stay as wide as the visible card (needs an `@container` scroller). */
export function EmptyState({ icon, title, children, action, pinned }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; pinned?: boolean }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center py-14 px-6 anim-fade', pinned && 'sticky left-0 w-[100cqw]')}>
      <div className="relative mb-4">
        <div className="absolute inset-0 -m-3 rounded-full blur-xl opacity-60" style={{ background: 'radial-gradient(circle, var(--glow1), transparent 70%)' }} />
        <div className="relative grid h-12 w-12 place-items-center rounded-2xl border border-line bg-[var(--raised)] text-accent">{icon ?? <Inbox size={22} />}</div>
      </div>
      <h4 className="text-[14px] font-semibold">{title}</h4>
      {children && <p className="mt-1 max-w-sm text-[12.5px] text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return <EmptyState icon={<AlertTriangle size={22} className="text-bad" />} title="Could not load data" action={retry && <Button onClick={retry}>Retry</Button>}>{(error as Error)?.message}</EmptyState>;
}

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button onClick={() => { void copyText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}
      className={cn('inline-flex items-center gap-1.5 rounded-md border border-line bg-[var(--hl)] px-2 py-1 text-[11.5px] font-medium text-muted hover:text-fg hover:border-[var(--line-strong)] transition-all cursor-pointer', done && 'text-good border-good/40', className)}>
      {done ? <Check size={13} /> : <Copy size={13} />}{done ? 'Copied!' : label ?? 'Copy'}
    </button>
  );
}

// ---------- Drawer & Dialog ----------
/** Open dialogs and drawers, innermost last: Escape closes only the one on top (e.g. a dialog opened from a dialog). */
const escStack: Array<{ current: () => void }> = [];
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !escStack.length) return;
    e.stopPropagation();
    escStack[escStack.length - 1].current();
  }, true);
}
export function useEsc(fn: () => void, active: boolean) {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; });
  useEffect(() => {
    if (!active) return;
    escStack.push(ref);
    return () => { const i = escStack.lastIndexOf(ref); if (i >= 0) escStack.splice(i, 1); };
  }, [active]);
}
export function Drawer({ open, onClose, title, children, width = 640 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number }) {
  useEsc(onClose, open);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px] anim-fade" onClick={onClose} />
      <aside className="anim-drawer absolute right-0 top-0 flex h-full max-w-full flex-col border-l border-line bg-[var(--raised)] shadow-2xl" style={{ width }}>
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0 text-[14px] font-semibold">{title}</div>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer"><X size={18} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>, document.body);
}
export function Dialog({ open, onClose, title, children, footer, width = 460 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEsc(onClose, open);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] overflow-y-auto">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm anim-fade" />
      {/* Tall dialogs scroll with the page instead of being cut off at the top and bottom. */}
      <div className="relative flex min-h-full items-center justify-center p-3 sm:p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="anim-pop relative w-full rounded-2xl border border-line bg-[var(--raised)] shadow-2xl" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between px-5 pt-4"><h3 className="text-[15px] font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-[var(--hl)] cursor-pointer"><X size={17} /></button></div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
      </div>
    </div>, document.body);
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="block"><span className="mb-1 block text-[11.5px] font-medium text-muted">{label}</span>{children}{hint && <span className="mt-1 block text-[11px] text-faint">{hint}</span>}</label>;
}

// ---------- Toasts ----------
interface Toast { id: number; title: string; body?: string; tone?: 'accent' | 'good' | 'bad' }
const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++idRef.current;
    setList((l) => [...l.slice(-3), { ...t, id }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), 3800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex flex-col gap-2">
        {list.map((t) => (
          <div key={t.id} className="anim-pop pointer-events-auto flex min-w-[260px] max-w-sm items-start gap-3 rounded-xl border border-line bg-[var(--raised)] px-3.5 py-2.5 shadow-2xl">
            <i className={cn('mt-1.5 h-2 w-2 rounded-full', t.tone === 'bad' ? 'bg-bad' : t.tone === 'good' ? 'bg-good' : 'bg-accent2')} />
            <div className="min-w-0"><div className="text-[13px] font-medium">{t.title}</div>{t.body && <div className="truncate text-[12px] text-muted">{t.body}</div>}</div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- CountUp ----------
export function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const [v, setV] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setV(value); from.current = value; return; }
    const start = performance.now(), a = from.current, dur = 700;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / dur), e = 1 - Math.pow(1 - p, 3);
      const cur = a + (value - a) * e;
      setV(cur); from.current = cur;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format(v)}</>;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (b: boolean) => void; label?: ReactNode }) {
  return (
    <button role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap text-[12px] text-muted hover:text-fg cursor-pointer">
      <span className={cn('relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-200', checked ? 'grad-bg' : 'bg-[var(--line-strong)]')}>
        <span className={cn('absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-all duration-200', checked ? 'left-[16px]' : 'left-[2px]')} />
      </span>{label}
    </button>
  );
}
export function useDebounced<T>(v: T, ms = 250): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}
