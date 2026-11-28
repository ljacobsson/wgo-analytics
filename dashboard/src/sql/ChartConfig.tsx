import { useRef, useState } from 'react';
import { AreaChart, BarChart3, BarChartBig, Check, ChevronDown, Hash, LineChart, ListOrdered, PieChart, ScatterChart, Table2 } from 'lucide-react';
import type { SqlColumn, TileUnit } from '../api/contract';
import { cn } from '../lib/format';
import { Popover } from '../ui/Popover';
import { kindOf, MAX_SERIES, MAX_SLICES, TIME_VIZ, type ChartSpec, type ChartViz } from './chart';

export const CHART_TYPES: Array<{ value: ChartViz; label: string; icon: React.ReactNode; hint: string }> = [
  { value: 'line', label: 'Line', icon: <LineChart size={14} />, hint: 'Over time' },
  { value: 'area', label: 'Area', icon: <AreaChart size={14} />, hint: 'Over time, filled' },
  { value: 'bars', label: 'Bars', icon: <BarChart3 size={14} />, hint: 'Over time, stacked when split' },
  { value: 'columns', label: 'Columns', icon: <BarChartBig size={14} />, hint: 'Bars per category: side by side for several values, stacked when split' },
  { value: 'top', label: 'Bar list', icon: <ListOrdered size={14} />, hint: 'One bar per row, in the query’s order' },
  { value: 'pie', label: 'Pie', icon: <PieChart size={14} />, hint: `Shares of a whole, up to ${MAX_SLICES} slices (the rest is “Other”)` },
  { value: 'scatter', label: 'Scatter', icon: <ScatterChart size={14} />, hint: 'One dot per row: a numeric column against another' },
  { value: 'number', label: 'Number', icon: <Hash size={14} />, hint: 'One big number: the first row, or the latest over time' },
  { value: 'table', label: 'Table', icon: <Table2 size={14} />, hint: 'The rows as they are' },
];
const UNITS: Array<{ value: TileUnit | ''; label: string }> = [
  { value: '', label: 'Number' }, { value: 'ms', label: 'Milliseconds' }, { value: 's', label: 'Seconds' }, { value: 'bytes', label: 'Bytes' },
  { value: 'percent', label: 'Share (0–1 as %)' }, { value: 'score', label: 'Score' }, { value: 'none', label: 'Plain' },
];

/**
 * How a SQL result is charted. `spec` is what was chosen, `resolved` the same with the gaps filled from the result
 * (shown as the current choice); changing anything pins it.
 */
export function ChartConfig({ columns, spec, resolved, onChange, compact }: {
  columns: SqlColumn[];
  spec: ChartSpec;
  resolved: ChartSpec;
  onChange: (s: ChartSpec) => void;
  compact?: boolean;
}) {
  const set = (p: Partial<ChartSpec>) => onChange({ ...spec, ...p });
  const nums = columns.filter((c) => kindOf(c) === 'number');
  const times = columns.filter((c) => kindOf(c) === 'time');
  const timeViz = TIME_VIZ.has(resolved.viz);
  const y = resolved.y ?? [];
  const label = 'flex items-center gap-1.5 text-[12px] text-muted';
  const select = 'field !h-7 !w-auto max-w-[180px] !py-0 !pl-2 !pr-7 !text-[12px]';
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', compact ? '' : 'px-3 py-2')}>
      <div className="inline-flex rounded-lg border border-line bg-[var(--hl)] p-0.5" role="radiogroup" aria-label="Chart type">
        {CHART_TYPES.map((t) => (
          <button key={t.value} role="radio" aria-checked={resolved.viz === t.value} title={`${t.label}: ${t.hint}`} onClick={() => set({ viz: t.value })}
            className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors cursor-pointer',
              resolved.viz === t.value ? 'bg-[var(--raised)] text-fg shadow-sm' : 'text-muted hover:text-fg')}>
            {t.icon}<span className={compact ? 'hidden xl:inline' : 'hidden md:inline'}>{t.label}</span>
          </button>))}
      </div>

      {timeViz && (
        <label className={label}>X axis
          <select className={select} value={resolved.x ?? ''} onChange={(e) => set({ x: e.target.value || undefined })}>
            {!times.length && <option value="">No time column</option>}
            {times.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </label>)}
      {(resolved.viz === 'top' || resolved.viz === 'columns' || resolved.viz === 'pie') && (
        <label className={label}>{resolved.viz === 'pie' ? 'Slices' : resolved.viz === 'columns' ? 'Categories' : 'Labels'}
          <select className={select} value={resolved.x ?? ''} onChange={(e) => set({ x: e.target.value || undefined })}>
            {columns.filter((c) => !y.includes(c.name)).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </label>)}
      {resolved.viz === 'scatter' && (
        <label className={label}>X axis
          <select className={select} value={resolved.x ?? ''} onChange={(e) => set({ x: e.target.value || undefined })}>
            {nums.length < 2 && <option value="">Needs two numeric columns</option>}
            {nums.filter((c) => c.name !== y[0]).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </label>)}

      {resolved.viz !== 'table' && ((timeViz || resolved.viz === 'columns') && !resolved.series
        ? <ColumnsPicker label="Values" options={nums} value={y} onChange={(v) => set({ y: v })} />
        : (
          <label className={label}>{resolved.viz === 'top' ? 'Bar length' : resolved.viz === 'pie' ? 'Size' : resolved.viz === 'scatter' ? 'Y axis' : 'Value'}
            <select className={select} value={y[0] ?? ''} onChange={(e) => set({ y: e.target.value ? [e.target.value] : undefined })}>
              {!nums.length && <option value="">No numeric column</option>}
              {nums.filter((c) => resolved.viz !== 'scatter' || c.name !== resolved.x).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </label>))}

      {(timeViz || resolved.viz === 'columns') && y.length <= 1 && (
        <label className={label} title="One series per value of this column (long-format results: label, label, value)">{resolved.viz === 'columns' ? 'Stack by' : 'Split by'}
          <select className={select} value={resolved.series ?? ''} onChange={(e) => set({ series: e.target.value })}>
            <option value="">{resolved.viz === 'columns' ? 'Don’t stack' : 'Don’t split'}</option>
            {columns.filter((c) => c.name !== resolved.x && !y.includes(c.name) && kindOf(c) !== 'time').map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </label>)}
      {resolved.viz === 'scatter' && (
        <label className={label}>Color by
          <select className={select} value={resolved.series ?? ''} onChange={(e) => set({ series: e.target.value })}>
            <option value="">One color</option>
            {columns.filter((c) => kindOf(c) === 'text').map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </label>)}

      {resolved.viz !== 'table' && (
        <label className={label}>Unit
          <select className={select} value={resolved.unit ?? ''} onChange={(e) => set({ unit: (e.target.value || undefined) as TileUnit | undefined })}>
            {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
          </select>
        </label>)}
    </div>
  );
}

/** Several numeric columns, one line each (up to one per color). */
function ColumnsPicker({ label, options, value, onChange }: { label: string; options: SqlColumn[]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const toggle = (name: string) => {
    const next = value.includes(name) ? value.filter((x) => x !== name) : [...value, name].slice(0, MAX_SERIES);
    // keep the result's column order, so colors don't move around
    onChange(options.map((o) => o.name).filter((n) => next.includes(n)));
  };
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-muted">{label}
      <button ref={anchor} onClick={() => setOpen(!open)} disabled={!options.length}
        className="field !flex !h-7 !w-auto max-w-[240px] items-center gap-1 !py-0 !pl-2 !pr-1.5 text-left !text-[12px] text-fg disabled:opacity-60 cursor-pointer">
        <span className="truncate">{value.length ? value.join(', ') : options.length ? 'Pick columns' : 'No numeric column'}</span><ChevronDown size={13} className="shrink-0 text-faint" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="start" width={240}>
        <div className="max-h-[280px] overflow-y-auto p-1.5">
          {options.map((o) => {
            const on = value.includes(o.name);
            return (
              <button key={o.name} onClick={() => toggle(o.name)} disabled={!on && value.length >= MAX_SERIES}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--hl)] disabled:opacity-40 cursor-pointer">
                <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded border', on ? 'border-accent bg-accent text-white' : 'border-[var(--line-strong)]')}>{on && <Check size={11} />}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{o.name}</span>
                <span className="font-mono text-[10.5px] text-faint">{o.type.toLowerCase()}</span>
              </button>);
          })}
          {value.length >= MAX_SERIES && <p className="px-2 pt-1 text-[11px] text-faint">Up to {MAX_SERIES} lines on one chart.</p>}
        </div>
      </Popover>
    </span>
  );
}
