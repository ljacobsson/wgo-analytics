import { useEffect, useRef, useState } from 'react';
import { CalendarClock, Check, ChevronDown } from 'lucide-react';
import { PRESETS, useTime } from '../lib/time';
import { useSetParams } from '../lib/router';
import { Button, Field } from '../ui/kit';
import { cn } from '../lib/format';

const toLocal = (iso: string) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

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
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="flex h-8 items-center gap-2 whitespace-nowrap rounded-lg border border-line bg-[var(--hl)] px-3 text-[12.5px] font-medium transition-colors hover:border-[var(--line-strong)] cursor-pointer">
        <CalendarClock size={14} className="text-muted" />{range.preset === 'custom' ? 'Custom' : range.label}<ChevronDown size={13} className="text-faint" />
      </button>
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
