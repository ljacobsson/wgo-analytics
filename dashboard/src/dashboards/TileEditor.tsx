import { useMemo, useState } from 'react';
import { AlignLeft, AreaChart, BarChart3, ChevronDown, Code2, Hash, LineChart, ListOrdered, Plus, Search, SlidersHorizontal, Table2, Type, X } from 'lucide-react';
import type { DashboardTile, QueryAgg, QuerySource, TileMeasure, TileUnit, TileViz } from '../api/contract';
import { useFields, useMeasureNames } from '../api/hooks';
import { fieldLabel } from '../lib/filters';
import { cn } from '../lib/format';
import { useProject } from '../lib/project';
import { PRESETS, type TimeRange } from '../lib/time';
import { FilterChips } from '../ui/FilterBar';
import { Button, useDebounced } from '../ui/kit';
import { aggsFor, AGG_LABEL, CATEGORIES, DEFAULT_SPLITS, findDef, measureLabel, NEEDS_FIELD, NUMERIC_FIELDS, SOURCES, useMeasureCatalog, type MeasureDef } from './measures';
import { defaultSize } from './layout';
import { tileHeight, useTileData } from './Tile';
import { TileFrame, tileTitle } from './TileFrame';
import { SqlTileEditor } from './SqlTileEditor';

const VIZ: Array<{ value: TileViz; label: string; icon: React.ReactNode; hint: string }> = [
  { value: 'number', label: 'Number', icon: <Hash size={16} />, hint: 'One big number with its change' },
  { value: 'line', label: 'Line', icon: <LineChart size={16} />, hint: 'Over time' },
  { value: 'area', label: 'Area', icon: <AreaChart size={16} />, hint: 'Over time, filled' },
  { value: 'bars', label: 'Bars', icon: <BarChart3 size={16} />, hint: 'Over time, stacked when split' },
  { value: 'top', label: 'Top list', icon: <ListOrdered size={16} />, hint: 'Biggest values of a field' },
  { value: 'table', label: 'Table', icon: <Table2 size={16} />, hint: 'Values side by side' },
  { value: 'text', label: 'Note', icon: <Type size={16} />, hint: 'Text for context' },
];
const UNITS: Array<{ value: TileUnit; label: string }> = [
  { value: 'count', label: 'Number' }, { value: 'ms', label: 'Milliseconds' }, { value: 's', label: 'Seconds' },
  { value: 'bytes', label: 'Bytes' }, { value: 'percent', label: 'Share (0–1 as %)' }, { value: 'score', label: 'Score' }, { value: 'none', label: 'Plain' },
];

interface EditorProps {
  initial: DashboardTile | null; // null: a new tile
  range: TimeRange;
  filters: string | undefined;
  onSave: (t: DashboardTile) => void;
  onClose: () => void;
}

/** Add or edit one tile: a measure, or a SQL query (a new tile can be either). Every change shows in the preview right away. */
export function TileEditor(props: EditorProps) {
  const [sql, setSql] = useState(!!props.initial?.sql);
  if (sql) return <SqlTileEditor initial={props.initial} range={props.range} onSave={props.onSave} onClose={props.onClose} onBack={props.initial ? undefined : () => setSql(false)} />;
  return <MeasureTileEditor {...props} onUseSql={props.initial ? undefined : () => setSql(true)} />;
}

function MeasureTileEditor({ initial, range, filters, onSave, onClose, onUseSql }: EditorProps & { onUseSql?: () => void }) {
  const { project } = useProject();
  const catalog = useMeasureCatalog(project.id, range);
  const isNew = !initial;
  const [draft, setDraft] = useState<DashboardTile>(() => initial ?? { id: Math.random().toString(36).slice(2, 10), viz: 'line', measures: [], layout: { x: 0, y: 0, ...defaultSize('line') } });
  const [active, setActive] = useState(0);
  const [picking, setPicking] = useState<number | null>(initial ? null : 0); // measure slot being picked
  const [vizTouched, setVizTouched] = useState(!!initial);
  const [custom, setCustom] = useState(false);
  const patch = (p: Partial<DashboardTile>) => setDraft((d) => ({ ...d, ...p }));
  const setMeasure = (i: number, m: TileMeasure) => setDraft((d) => ({ ...d, measures: d.measures.map((x, k) => (k === i ? m : x)) }));

  const pick = (def: MeasureDef) => {
    const slot = picking ?? 0;
    setDraft((d) => {
      const measures = [...d.measures];
      measures[slot] = { ...def.measure };
      const sameSource = d.measures[0]?.source === def.measure.source;
      const viz = !vizTouched && slot === 0 && d.viz !== 'text' ? def.viz : d.viz;
      return {
        ...d, measures, viz,
        // a split only survives a measure from the same source, and only with one measure
        groupBy: measures.length === 1 && sameSource ? d.groupBy : undefined,
        layout: isNew && !vizTouched ? { ...d.layout, ...defaultSize(viz) } : d.layout,
      };
    });
    setActive(slot);
    setPicking(null);
  };
  const setViz = (viz: TileViz) => {
    setVizTouched(true);
    setDraft((d) => ({ ...d, viz, measures: viz === 'top' ? d.measures.slice(0, 1) : d.measures, layout: isNew ? { ...d.layout, ...defaultSize(viz) } : d.layout }));
    if (viz === 'text') setPicking(null);
  };

  const preview = useDebounced(draft, 250);
  const data = useTileData(project.id, preview, range, filters);
  const m = draft.measures[active];
  const valid = draft.viz === 'text' ? !!draft.text?.trim() : draft.measures.length > 0 && (draft.viz !== 'top' || !!draft.groupBy);
  const splittable = draft.viz !== 'number' && draft.viz !== 'text' && draft.measures.length === 1;

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 border-b border-line bg-[var(--raised)] p-4">
        <div style={{ height: tileHeight(draft.viz === 'number' ? 2 : 3) }}>
          <TileFrame data={data} height={tileHeight(draft.viz === 'number' ? 2 : 3)} readOnly filtered={!!filters} />
        </div>
      </div>

      <div className="flex-1 space-y-6 p-5">
        {draft.viz !== 'text' && (
          <Section title={draft.measures.length > 1 ? 'Measures' : 'What do you want to see?'}>
            <div className="space-y-2">
              {draft.measures.map((x, i) => picking === i ? null : (
                <div key={i} className={cn('flex items-center gap-2 rounded-xl border px-3 py-2', i === active && draft.measures.length > 1 ? 'border-accent/50' : 'border-line')}>
                  <button className="min-w-0 flex-1 text-left cursor-pointer" onClick={() => setActive(i)}>
                    <div className="truncate text-[13px] font-medium">{measureLabel(x)}</div>
                    <div className="truncate text-[11.5px] text-faint">{findDef(catalog.list, x)?.description ?? 'Custom measure'}</div>
                  </button>
                  <Button size="sm" variant="ghost" onClick={() => setPicking(i)}>Change</Button>
                  {draft.measures.length > 1 && <button onClick={() => { setDraft((d) => ({ ...d, measures: d.measures.filter((_, k) => k !== i) })); setActive(0); }} className="rounded-md p-1 text-faint hover:text-fg cursor-pointer" title="Remove"><X size={14} /></button>}
                </div>
              ))}
              {picking !== null && (
                <MeasurePicker list={catalog.list} loading={catalog.loading} onPick={pick}
                  onCustom={() => { pick({ id: 'custom', label: '', category: 'Traffic', description: '', viz: 'line', splits: [], measure: { source: 'events', agg: 'count', unit: 'count' } }); setCustom(true); }}
                  onCancel={draft.measures[picking] || picking > 0 ? () => setPicking(null) : undefined} />
              )}
              {picking === null && draft.measures.length > 0 && draft.measures.length < 4 && draft.viz !== 'top' && (
                <button onClick={() => setPicking(draft.measures.length)} className="inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-[12.5px] text-muted hover:text-fg cursor-pointer"
                  title="Show another measure in the same tile">
                  <Plus size={13} />Compare with another measure
                </button>)}
            </div>
          </Section>
        )}

        <Section title="Show as">
          <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
            {VIZ.map((v) => (
              <button key={v.value} onClick={() => setViz(v.value)} title={v.hint}
                className={cn('flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11.5px] transition-colors cursor-pointer',
                  draft.viz === v.value ? 'border-accent/60 bg-accent/12 text-fg' : 'border-line text-muted hover:text-fg')}>
                {v.icon}{v.label}
              </button>))}
          </div>
        </Section>

        {draft.viz === 'text' && (
          <Section title="Note">
            <textarea className="field min-h-[120px]" value={draft.text ?? ''} maxLength={2000} placeholder="What to look at, links to runbooks, what changed…" onChange={(e) => patch({ text: e.target.value })} />
          </Section>
        )}

        {splittable && m && (
          <SplitBy measure={m} catalog={catalog.list} range={range} value={draft.groupBy} limit={draft.limit} viz={draft.viz}
            onChange={(groupBy, limit) => patch({ groupBy, limit })} />
        )}
        {draft.viz !== 'text' && draft.measures.length > 1 && <p className="-mt-3 text-[11.5px] text-faint">Splitting by a field works with one measure.</p>}

        {m && draft.viz !== 'text' && (
          <Section title={draft.measures.length > 1 ? `Only count rows of “${measureLabel(m)}” where` : 'Only count rows where'}>
            <FilterChips scope={m.source} metric={m.metric} value={m.filters ?? []} onChange={(f) => setMeasure(active, { ...m, filters: f })} />
          </Section>
        )}

        {m && draft.viz !== 'text' && (
          <div>
            <button onClick={() => setCustom(!custom)} className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted hover:text-fg cursor-pointer">
              <SlidersHorizontal size={13} />Customize {draft.measures.length > 1 ? `“${measureLabel(m)}”` : 'the measure'}<ChevronDown size={13} className={cn('transition-transform', custom && 'rotate-180')} />
            </button>
            {custom && <Customize m={m} range={range} catalogLabel={findDef(catalog.list, m)?.label} onChange={(x) => setMeasure(active, x)} />}
          </div>
        )}

        <Section title="Title and time range">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px]">
            <input className="field" value={draft.title ?? ''} maxLength={120} placeholder={tileTitle({ ...draft, title: undefined })} onChange={(e) => patch({ title: e.target.value || undefined })} />
            <select className="field" value={draft.range ?? ''} onChange={(e) => patch({ range: e.target.value || undefined })} aria-label="Time range">
              <option value="">Dashboard’s range</option>
              {PRESETS.map((p) => <option key={p} value={p}>Always last {p}</option>)}
            </select>
          </div>
        </Section>
      </div>

      <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-line bg-[var(--raised)] px-5 py-3">
        {draft.viz === 'top' && !draft.groupBy && <span className="mr-auto text-[12px] text-faint">Pick a field to split by</span>}
        {onUseSql && <Button variant="ghost" className="mr-auto" onClick={onUseSql} title="Chart the result of a DuckDB SQL query"><Code2 size={13} />Write a SQL query instead</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!valid} onClick={() => onSave(clean(draft))}>{isNew ? 'Add tile' : 'Save tile'}</Button>
      </div>
    </div>
  );
}

/** Drop what the chosen chart type doesn't use. */
function clean(t: DashboardTile): DashboardTile {
  const out: DashboardTile = { ...t };
  if (t.viz === 'text') { out.measures = []; delete out.groupBy; delete out.limit; return out; }
  delete out.text;
  if (t.viz === 'number' || t.measures.length > 1) { delete out.groupBy; delete out.limit; }
  if (!out.groupBy) delete out.limit;
  out.measures = t.measures.map((m) => {
    const x = { ...m };
    if (!x.filters?.length) delete x.filters;
    if (!x.field) delete x.field;
    if (x.source !== 'metrics') delete x.metric;
    return x;
  });
  return out;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h4 className="mb-2 text-[12.5px] font-semibold text-muted">{title}</h4>{children}</section>;
}

/** Search the catalog, grouped by category. */
function MeasurePicker({ list, loading, onPick, onCustom, onCancel }: { list: MeasureDef[]; loading: boolean; onPick: (d: MeasureDef) => void; onCustom: () => void; onCancel?: () => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (d: MeasureDef) => terms.every((t) => `${d.label} ${d.description} ${d.category}`.toLowerCase().includes(t));
    return CATEGORIES.map((c) => ({ c, items: list.filter((d) => d.category === c && hit(d)) })).filter((g) => g.items.length);
  }, [list, q]);
  const LIMIT = 6;
  return (
    <div className="rounded-xl border border-line">
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Search size={14} className="text-faint" />
        <input autoFocus className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none" placeholder="Search pageviews, errors, LCP, a metric, a goal…" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && groups[0]) onPick(groups[0].items[0]); if (e.key === 'Escape' && onCancel) { e.stopPropagation(); onCancel(); } }} />
        {onCancel && <button onClick={onCancel} className="text-[12px] text-faint hover:text-fg cursor-pointer">Cancel</button>}
      </div>
      <div className="max-h-[340px] overflow-y-auto p-1.5">
        {groups.map(({ c, items }) => {
          const all = q || open === c || items.length <= LIMIT + 1;
          return (
            <div key={c} className="mb-1">
              <div className="px-2 pb-0.5 pt-2 text-[11.5px] font-semibold text-faint">{c}</div>
              {(all ? items : items.slice(0, LIMIT)).map((d) => (
                <button key={d.id} onClick={() => onPick(d)} className="flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-[var(--hl)] cursor-pointer">
                  <span className={cn('shrink-0 text-[13px]', d.category === 'Metrics' && 'font-mono text-[12px]')}>{d.label}</span>
                  <span className="min-w-0 truncate text-[11.5px] text-faint">{d.description}</span>
                </button>))}
              {!all && <button onClick={() => setOpen(c)} className="px-2 py-1 text-[12px] text-muted hover:text-fg cursor-pointer">Show all {items.length}</button>}
            </div>
          );
        })}
        {loading && <div className="px-2 py-2 text-[12px] text-faint">Looking for your events, goals and metrics…</div>}
        {!groups.length && !loading && <div className="px-2 py-3 text-[12.5px] text-faint">Nothing matches “{q}”.</div>}
        <button onClick={onCustom} className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-line px-2 py-2 text-left text-[12.5px] text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer">
          <AlignLeft size={13} />Build your own from any field…
        </button>
      </div>
    </div>
  );
}

function SplitBy({ measure, catalog, range, value, limit, viz, onChange }: {
  measure: TileMeasure; catalog: MeasureDef[]; range: TimeRange; value: string | undefined; limit: number | undefined; viz: TileViz;
  onChange: (groupBy: string | undefined, limit: number | undefined) => void;
}) {
  const { project } = useProject();
  const fields = useFields(project.id, range, measure.source, true, measure.metric);
  const suggested = findDef(catalog, measure)?.splits ?? DEFAULT_SPLITS[measure.source];
  const more = [...(fields.data?.builtin ?? []).filter((f) => f.type !== 'number' || ['httpStatus', 'statusCode', 'status', 'severityNumber'].includes(f.field)).map((f) => f.field),
    ...(fields.data?.discovered ?? []).slice(0, 40).map((f) => f.field)].filter((f) => !suggested.includes(f) && !['sessionId', 'anonId', 'traceId', 'spanId', 'url', 'lat', 'lon'].includes(f));
  const series = viz === 'line' || viz === 'area' || viz === 'bars';
  const limits = series ? [3, 5, 8] : [5, 10, 20, 50];
  const lim = limit ?? (series ? 5 : 10);
  return (
    <Section title={viz === 'top' || viz === 'table' ? 'List the top values of' : 'Split by'}>
      <div className="flex flex-wrap gap-2">
        <select className="field !w-auto min-w-[200px] flex-1" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined, limit)} aria-label="Split by">
          {viz !== 'top' && <option value="">{viz === 'table' ? 'Nothing (one row per measure)' : 'Nothing'}</option>}
          {viz === 'top' && !value && <option value="">Pick a field…</option>}
          <optgroup label="Suggested">{suggested.map((f) => <option key={f} value={f}>{fieldLabel(f)}</option>)}</optgroup>
          {more.length > 0 && <optgroup label="All fields">{more.map((f) => <option key={f} value={f}>{fieldLabel(f)}</option>)}</optgroup>}
          {value && !suggested.includes(value) && !more.includes(value) && <option value={value}>{fieldLabel(value)}</option>}
        </select>
        {value && (
          <select className="field !w-[150px]" value={lim} onChange={(e) => onChange(value, Number(e.target.value))} aria-label="How many">
            {limits.map((n) => <option key={n} value={n}>{series ? `Top ${n} lines` : `Top ${n}`}</option>)}
          </select>)}
      </div>
    </Section>
  );
}

/** Source, aggregation and field, for anything the catalog doesn't cover. */
function Customize({ m: cur, range, catalogLabel, onChange: set }: { m: TileMeasure; range: TimeRange; catalogLabel?: string; onChange: (m: TileMeasure) => void }) {
  // a name the catalog gave ("Pageviews") stops being true once the measure changes; one you typed stays
  const m = catalogLabel && cur.label === catalogLabel ? { ...cur, label: undefined } : cur;
  const onChange = (x: TileMeasure) => set(x);
  const { project } = useProject();
  const names = useMeasureNames(project.id);
  const fields = useFields(project.id, range, m.source, true, m.metric);
  const numeric = [...NUMERIC_FIELDS[m.source], ...(fields.data?.discovered ?? []).map((f) => f.field)];
  const setSource = (source: QuerySource) => {
    const aggs = aggsFor(source);
    onChange({
      source, agg: aggs.includes(m.agg) ? m.agg : 'count', unit: m.unit, better: m.better, label: m.label,
      ...(source === 'metrics' ? { metric: names.data?.metrics[0]?.name ?? '' } : {}),
    });
  };
  const setAgg = (agg: QueryAgg) => {
    const unit: TileUnit | undefined = agg === 'session_rate' || agg === 'rate' ? 'percent' : m.unit === 'percent' ? 'count' : m.unit;
    onChange({ ...m, agg, unit, ...(agg === 'rate' && m.source === 'checks' ? { field: 'ok' } : {}) });
  };
  const needsField = NEEDS_FIELD(m.agg, m.source);
  return (
    <div className="mt-3 grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-2">
      <label className="block"><span className="mb-1 block text-[11.5px] font-medium text-muted">Data</span>
        <select className="field" value={m.source} onChange={(e) => setSource(e.target.value as QuerySource)}>
          {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label} ({s.hint})</option>)}
        </select>
      </label>
      {m.source === 'metrics' && (
        <label className="block"><span className="mb-1 block text-[11.5px] font-medium text-muted">Metric</span>
          <select className="field font-mono" value={m.metric ?? ''} onChange={(e) => onChange({ ...m, metric: e.target.value, filters: [] })}>
            {!m.metric && <option value="">Pick a metric…</option>}
            {(names.data?.metrics ?? []).map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
            {m.metric && !names.data?.metrics.some((x) => x.name === m.metric) && <option value={m.metric}>{m.metric}</option>}
          </select>
        </label>)}
      <label className="block"><span className="mb-1 block text-[11.5px] font-medium text-muted">Calculate</span>
        <select className="field" value={m.agg} onChange={(e) => setAgg(e.target.value as QueryAgg)}>
          {aggsFor(m.source).map((a) => <option key={a} value={a}>{AGG_LABEL[a]}</option>)}
        </select>
      </label>
      {(needsField || (m.source === 'checks' && m.agg !== 'count')) && (
        <label className="block"><span className="mb-1 block text-[11.5px] font-medium text-muted">Of the field</span>
          <input className="field font-mono" list="dash-numeric-fields" value={m.field ?? ''} placeholder={m.source === 'checks' ? 'durationMs' : 'durationMs, props.amount…'}
            onChange={(e) => onChange({ ...m, field: e.target.value.trim() || undefined })} />
          <datalist id="dash-numeric-fields">{numeric.map((f) => <option key={f} value={f}>{fieldLabel(f)}</option>)}</datalist>
        </label>)}
      <label className="block"><span className="mb-1 block text-[11.5px] font-medium text-muted">Show values as</span>
        <select className="field" value={m.unit ?? 'count'} onChange={(e) => onChange({ ...m, unit: e.target.value as TileUnit })}>
          {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
        </select>
      </label>
      <label className="block"><span className="mb-1 block text-[11.5px] font-medium text-muted">A rise is</span>
        <select className="field" value={m.better ?? ''} onChange={(e) => onChange({ ...m, better: (e.target.value || undefined) as TileMeasure['better'] })}>
          <option value="">Neither good nor bad</option><option value="up">Good</option><option value="down">Bad</option>
        </select>
      </label>
      <label className="block sm:col-span-2"><span className="mb-1 block text-[11.5px] font-medium text-muted">Name</span>
        <input className="field" value={cur.label ?? ''} maxLength={80} placeholder="e.g. Checkout revenue" onChange={(e) => onChange({ ...m, label: e.target.value || undefined })} />
      </label>
    </div>
  );
}
