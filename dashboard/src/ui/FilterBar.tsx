import { useEffect, useMemo, useRef, useState } from 'react';
import { BellPlus, Bookmark, BookmarkCheck, Filter as FilterIcon, Flame, History, Plus, Trash2, X, Bot } from 'lucide-react';
import type { Filter, FilterOp, FilterScope, SavedView } from '../api/contract';
import { useDeleteView, useFields, useFieldValues, useSaveView, useViews } from '../api/hooks';
import { cn, fmtNum } from '../lib/format';
import { describeFilter, fieldLabel, filterSetKey, needsValue, OP_LABEL, OPS, pageFilters, sameView, useFilters, valueHint, viewParamsOf, type FieldScope } from '../lib/filters';
import { forgetFilterUse, recordFilterUse, useFilterHistory, type FilterUse } from '../lib/filterHistory';
import { suggestName, suggestViewName } from '../lib/naming';
import { PAGES, useProject } from '../lib/project';
import { navigate, useRoute, useSetParams } from '../lib/router';
import { useTime } from '../lib/time';
import { isKiosk } from '../lib/kiosk';
import { Button, useDebounced, useToast } from './kit';
import { Popover } from './Popover';
import { newTriggerHref } from './RowActions';

/** Prefixes that address JSON properties/attributes, per scope (typed paths are accepted as-is). */
const JSON_PREFIX: Record<FieldScope, string[]> = { events: ['props.'], logs: ['attributes.', 'resource.'], spans: ['attributes.', 'resource.'], metrics: ['attributes.'], checks: [] };

function FilterEditor({ scope, metric, fields: only, initial, onSave, onCancel }: { scope: FieldScope; metric?: string; fields?: readonly string[]; initial?: Filter; onSave: (f: Filter) => void; onCancel: () => void }) {
  const { project } = useProject(); const { range } = useTime();
  const [field, setField] = useState(initial?.field ?? '');
  const [fieldQ, setFieldQ] = useState('');
  const [op, setOp] = useState<FilterOp>(initial?.op ?? 'eq');
  const [value, setValue] = useState(initial?.value ?? '');
  const fields = useFields(project.id, range, scope, true, metric);
  const dq = useDebounced(value, 200);
  const values = useFieldValues(project.id, range, scope, field, dq, needsValue(op), metric);
  const valueRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => {
    const q = fieldQ.toLowerCase();
    const match = (f: string) => !q || f.toLowerCase().includes(q) || fieldLabel(f).toLowerCase().includes(q);
    return {
      builtin: (fields.data?.builtin ?? []).filter((f) => match(f.field) && (!only || only.includes(f.field))),
      discovered: (fields.data?.discovered ?? []).filter((f) => match(f.field)).slice(0, 60),
    };
  }, [fields.data, fieldQ, only]);
  const typedPath = JSON_PREFIX[scope].some((p) => fieldQ.startsWith(p) && fieldQ.length > p.length) ? fieldQ.trim() : null;

  const pick = (f: string) => { setField(f); setFieldQ(''); setTimeout(() => valueRef.current?.focus(), 0); };
  const valid = !!field && (!needsValue(op) || value.trim() !== '');
  const save = () => { if (valid) onSave({ field, op, ...(needsValue(op) ? { value: value.trim() } : {}) }); };

  if (!field) {
    return (
      <div className="w-[360px]">
        <input autoFocus className="field" placeholder={JSON_PREFIX[scope].length ? `Search fields, or type a path like ${JSON_PREFIX[scope][0]}plan` : 'Search fields'} value={fieldQ}
          onChange={(e) => setFieldQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && typedPath) pick(typedPath); if (e.key === 'Escape') onCancel(); }} />
        <div className="mt-2 max-h-[320px] overflow-y-auto">
          {typedPath && <button onClick={() => pick(typedPath)} className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--hl)] cursor-pointer">Use <span className="ml-1.5 font-mono text-accent">{typedPath}</span></button>}
          {options.builtin.length > 0 && <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-faint">Fields</div>}
          {options.builtin.map((f) => (
            <button key={f.field} onClick={() => pick(f.field)} className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--hl)] cursor-pointer">
              <span>{fieldLabel(f.field)}</span><span className="font-mono text-[11px] text-faint">{f.type === 'number' ? '123' : 'abc'}</span>
            </button>))}
          {options.discovered.length > 0 && <div className="px-2.5 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-faint">{scope === 'events' ? 'Properties' : 'Attributes'} seen recently</div>}
          {options.discovered.map((f) => (
            <button key={f.field} onClick={() => pick(f.field)} className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left hover:bg-[var(--hl)] cursor-pointer">
              <span className="truncate font-mono text-[12px]">{f.field}</span><span className="tnum text-[11px] text-faint">{fmtNum(f.count ?? 0)}</span>
            </button>))}
          {fields.isPending && <div className="px-2.5 py-2 text-[12px] text-faint">Loading fields…</div>}
          {!fields.isPending && !typedPath && !options.builtin.length && !options.discovered.length && <div className="px-2.5 py-2 text-[12px] text-faint">No matching fields.{JSON_PREFIX[scope].length > 0 && <> Type a path like <span className="font-mono">{JSON_PREFIX[scope][0]}name</span>.</>}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="w-[380px] space-y-3">
      <div className="flex items-center justify-between">
        <button onClick={() => setField('')} className="truncate text-[13px] font-semibold hover:text-accent cursor-pointer" title="Change field">{fieldLabel(field)}</button>
        {fieldLabel(field) !== field && <span className="font-mono text-[11px] text-faint">{field}</span>}
      </div>
      <div className="grid grid-cols-4 gap-1">
        {OPS.map((o) => (
          <button key={o} onClick={() => setOp(o)} className={cn('rounded-md border px-1.5 py-1 text-[11.5px] transition-colors cursor-pointer', op === o ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-muted hover:text-fg')}>{OP_LABEL[o]}</button>))}
      </div>
      {needsValue(op) && (
        <div>
          <input ref={valueRef} autoFocus className="field" placeholder={/^(gt|gte|lt|lte)$/.test(op) ? 'Number, or text/date to compare' : 'Value'} value={value}
            onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onCancel(); }} />
          {(values.data?.values.length ?? 0) > 0 && (
            <div className="mt-1.5 max-h-[180px] overflow-y-auto rounded-lg border border-line">
              {values.data!.values.map((v) => (
                <button key={v.value} onClick={() => setValue(v.value)} className="flex w-full items-center justify-between gap-3 px-2.5 py-1 text-left text-[12px] hover:bg-[var(--hl)] cursor-pointer">
                  <span className="truncate">{v.value}</span><span className="tnum text-[11px] text-faint">{fmtNum(v.count)}</span>
                </button>))}
            </div>)}
        </div>)}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" disabled={!valid} onClick={save}>{initial ? 'Update' : 'Add filter'}</Button>
      </div>
    </div>
  );
}

/**
 * Editable filter chips (controlled). Used by the page filter bar and the trigger editor. `fields` limits the built-in
 * fields offered (JSON properties stay available), e.g. to those the browser SDK can check.
 */
export function FilterChips({ scope, metric, fields, value: filters, onChange: setFilters, className, children }: {
  scope: FieldScope; metric?: string; fields?: readonly string[]; value: Filter[]; onChange: (f: Filter[]) => void; className?: string; children?: React.ReactNode;
}) {
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editing === null) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setEditing(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [editing]);

  const save = (f: Filter) => {
    setFilters(editing === 'new' || editing === null ? [...filters, f] : filters.map((x, i) => (i === editing ? f : x)));
    setEditing(null);
  };

  return (
    <div ref={ref} className={cn('relative z-20 flex flex-wrap items-center gap-2', className)}>
      <FilterIcon size={14} className="text-faint" />
      {filters.map((f, i) => (
        <span key={i} className={cn('inline-flex max-w-full sm:max-w-[420px] items-center gap-1 rounded-full border py-0.5 pl-3 pr-1 text-[12px]', editing === i ? 'border-accent/60 bg-accent/15' : 'border-line bg-[var(--hl)]')}>
          <button onClick={() => setEditing(editing === i ? null : i)} className="truncate cursor-pointer" title={describeFilter(f)}>
            <span className="font-medium">{fieldLabel(f.field)}</span> <span className="text-muted">{OP_LABEL[f.op]}</span>{needsValue(f.op) && <> <span className="font-mono">{f.value}</span></>}
            {valueHint(f.field, f.op, f.value) && <span className="text-faint"> ({valueHint(f.field, f.op, f.value)})</span>}
          </button>
          <button onClick={() => setFilters(filters.filter((_, j) => j !== i))} className="rounded-full p-0.5 text-faint hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="Remove filter"><X size={12} /></button>
        </span>))}
      <button onClick={() => setEditing(editing === 'new' ? null : 'new')} className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2.5 py-0.5 text-[12px] text-muted hover:border-[var(--line-strong)] hover:text-fg cursor-pointer">
        <Plus size={12} />{filters.length ? 'Add' : 'Add filter'}
      </button>
      {filters.length > 1 && <button onClick={() => setFilters([])} className="text-[12px] text-faint hover:text-fg cursor-pointer">Clear all</button>}
      {children}
      {editing !== null && (
        <div className="anim-pop absolute left-0 top-full z-40 mt-2 rounded-xl border border-line bg-[var(--raised)] p-3 shadow-2xl">
          <FilterEditor scope={scope} metric={metric} fields={fields} initial={typeof editing === 'number' ? filters[editing] : undefined} onSave={save} onCancel={() => setEditing(null)} />
        </div>)}
    </div>
  );
}

/** Records a filter set in the history once it has stayed applied for a moment (not the one the page opened with). */
function useRecordFilterUse(pid: string, scope: FilterScope, filters: Filter[]) {
  const key = filterSetKey(filters);
  const last = useRef(key);
  useEffect(() => {
    if (!filters.length) { last.current = key; return; } // cleared: applying the same set again counts as another use
    if (key === last.current) return;
    const t = setTimeout(() => { recordFilterUse(pid, scope, filters); last.current = key; }, 1500);
    return () => clearTimeout(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Chips for the active filters of a scope; filters live in the URL. Also: one-click recent and most used filter
 * sets, saved views, and turning what the page shows into a trigger.
 */
/** Bot traffic (scrapers, crawlers, automation) is left out of the numbers unless shown here. */
function BotsToggle() {
  const route = useRoute();
  const set = useSetParams();
  const shown = route.params.get('bots') === '1';
  return (
    <button onClick={() => set({ bots: shown ? null : '1' })}
      className={cn('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[12px] cursor-pointer',
        shown ? 'border-warn/50 bg-warn/10 text-warn' : 'border-line text-muted hover:border-[var(--line-strong)] hover:text-fg')}
      title={shown ? 'Bot traffic is included in every number. Click to leave it out again.' : 'Scrapers, crawlers and automated browsers are left out of the numbers. Click to include them.'}>
      <Bot size={12} />{shown ? 'Bots included' : 'Bots hidden'}
    </button>
  );
}

export function FilterBar({ scope, className }: { scope: FilterScope; className?: string }) {
  const [filters, setFilters] = useFilters(scope);
  const { project } = useProject();
  const route = useRoute();
  const page = route.segments[2] ?? '';
  useRecordFilterUse(project.id, scope, filters);
  if (isKiosk()) return <ReadOnlyFilters filters={filters} className={className} />;
  const triggerFilters = [...pageFilters(page, route.params), ...filters];
  return (
    <FilterChips scope={scope} value={filters} onChange={setFilters} className={className}>
      {!filters.length && <QuickFilters scope={scope} onPick={setFilters} />}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {scope === 'events' && <BotsToggle />}
        {triggerFilters.length > 0 && (
          <button onClick={() => navigate(newTriggerHref(project.id, route.params, scope, triggerFilters))}
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-line px-2.5 py-0.5 text-[12px] text-muted hover:border-[var(--line-strong)] hover:text-fg cursor-pointer"
            title={`Get notified in Slack or by webhook when new ${scope === 'events' ? 'events' : scope} match what this page shows`}>
            <BellPlus size={12} />Create trigger
          </button>)}
        <ViewsMenu scope={scope} page={page} onPick={setFilters} />
      </div>
    </FilterChips>
  );
}

function HistoryChip({ scope, use, onPick, onForget }: { scope: FilterScope; use: FilterUse; onPick: () => void; onForget: () => void }) {
  const name = suggestName(scope, use.filters);
  return (
    <span className="group/chip inline-flex max-w-[260px] items-center rounded-full border border-dashed border-line text-[12px] text-muted hover:border-[var(--line-strong)] hover:text-fg">
      <button onClick={onPick} className="truncate py-0.5 pl-2.5 pr-1 cursor-pointer"
        title={`${use.filters.map(describeFilter).join(' AND ')}\nUsed ${use.count}×`}>{name}</button>
      <button onClick={onForget} className="mr-1 rounded-full p-0.5 text-faint opacity-0 hover:text-fg group-hover/chip:opacity-100 cursor-pointer" title="Remove from history"><X size={10} /></button>
    </span>
  );
}

/** The last 3 and most used 3 filter sets, inline while no filters are set. */
function QuickFilters({ scope, onPick }: { scope: FilterScope; onPick: (f: Filter[]) => void }) {
  const { project } = useProject();
  const { recent, frequent } = useFilterHistory(project.id, scope);
  if (!recent.length && !frequent.length) return null;
  const label = 'inline-flex items-center gap-1 text-[11px] text-faint';
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {recent.length > 0 && <span className={label}><History size={11} />Recent</span>}
      {recent.map((u) => <HistoryChip key={u.key} scope={scope} use={u} onPick={() => onPick(u.filters)} onForget={() => forgetFilterUse(project.id, scope, u.key)} />)}
      {frequent.length > 0 && <span className={cn(label, recent.length > 0 && 'ml-1.5')}><Flame size={11} />Most used</span>}
      {frequent.map((u) => <HistoryChip key={u.key} scope={scope} use={u} onPick={() => onPick(u.filters)} onForget={() => forgetFilterUse(project.id, scope, u.key)} />)}
    </div>
  );
}

/** Href for a saved view, keeping the time range you're looking at. */
export function viewHref(pid: string, v: Pick<SavedView, 'page' | 'params'>, current: URLSearchParams) {
  const p = new URLSearchParams(v.params);
  for (const k of ['range', 'from', 'to']) { const x = current.get(k); if (x) p.set(k, x); }
  const q = p.toString();
  return `/p/${pid}/${v.page}${q ? '?' + q : ''}`;
}

const pageLabel = (id: string) => PAGES.find((p) => p.id === id)?.label ?? id;

/** Saved views (save this one with a generated name, open others) plus recent / most used filters. */
function ViewsMenu({ scope, page, onPick }: { scope: FilterScope; page: string; onPick: (f: Filter[]) => void }) {
  const { project } = useProject();
  const route = useRoute();
  const toast = useToast();
  const views = useViews(project.id);
  const saveView = useSaveView(project.id);
  const delView = useDeleteView(project.id);
  const { recent, frequent } = useFilterHistory(project.id, scope);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const anchor = useRef<HTMLButtonElement>(null);

  const params = viewParamsOf(route.params, scope);
  const current = { page, params };
  const active = views.data?.find((v) => sameView(v, current));
  const [filters] = useFilters(scope);
  const suggested = suggestViewName(page, scope, [...pageFilters(page, route.params), ...filters]);
  useEffect(() => { if (open) setName(suggested); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const here = views.data?.filter((v) => v.page === page) ?? [];
  const elsewhere = views.data?.filter((v) => v.page !== page) ?? [];
  const go = (v: SavedView) => { setOpen(false); navigate(viewHref(project.id, v, route.params)); };
  const save = async () => {
    if (!name.trim()) return;
    try {
      await saveView.mutateAsync({ input: { name: name.trim(), page, params } });
      toast({ title: 'View saved', body: name.trim(), tone: 'good' });
      setOpen(false);
    } catch (e) {
      toast({ title: 'Could not save the view', body: (e as Error).message, tone: 'bad' });
    }
  };
  const head = 'px-1 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-faint';
  const row = (v: SavedView) => (
    <div key={v.id} className={cn('group/view flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] hover:bg-[var(--hl)]', active?.id === v.id && 'bg-accent/12')}>
      <button onClick={() => go(v)} className="min-w-0 flex-1 truncate text-left cursor-pointer" title={`${v.name} · saved by ${v.createdBy}`}>{v.name}</button>
      {v.page !== page && <span className="shrink-0 text-[11px] text-faint">{pageLabel(v.page)}</span>}
      <button onClick={() => { if (confirm(`Delete the saved view “${v.name}” for everyone in this project?`)) delView.mutate(v.id); }}
        className="shrink-0 rounded p-0.5 text-faint opacity-0 hover:text-bad group-hover/view:opacity-100 cursor-pointer" title="Delete view"><Trash2 size={12} /></button>
    </div>);

  return (
    <>
      <button ref={anchor} onClick={() => setOpen(!open)}
        className={cn('inline-flex max-w-[240px] shrink-0 items-center whitespace-nowrap gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] cursor-pointer',
          active ? 'border-accent/50 bg-accent/12 text-fg' : 'border-line text-muted hover:border-[var(--line-strong)] hover:text-fg')}
        title={active ? `Saved view: ${active.name}` : 'Saved views, recent and most used filters'}>
        {active ? <BookmarkCheck size={12} className="shrink-0" /> : <Bookmark size={12} className="shrink-0" />}
        <span className="truncate">{active ? active.name : 'Views'}</span>
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={360}>
        <div className="space-y-1">
          {active ? (
            <p className="px-1 text-[12px] text-muted">This is the saved view <b className="text-fg">{active.name}</b>.</p>
          ) : params ? (
            <div>
              <div className="mb-1.5 px-1 text-[12px] font-medium text-muted">Save this view</div>
              <div className="flex gap-2">
                <input autoFocus className="field" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
                <Button size="sm" variant="primary" disabled={!name.trim() || saveView.isPending} onClick={() => void save()}>Save</Button>
              </div>
              <p className="mt-1 px-1 text-[11px] text-faint">Shared with everyone in this project. Keeps filters and page options, not the time range.</p>
            </div>
          ) : (
            <p className="px-1 text-[12px] text-faint">Set filters on this page to save it as a view.</p>
          )}
          {here.length > 0 && <><div className={head}>Saved views</div>{here.map(row)}</>}
          {elsewhere.length > 0 && <><div className={head}>{here.length ? 'Other pages' : 'Saved views'}</div>{elsewhere.map(row)}</>}
          {recent.length > 0 && <div className={head}>Recent filters</div>}
          {recent.map((u) => <HistoryRow key={u.key} scope={scope} use={u} onPick={() => { onPick(u.filters); setOpen(false); }} />)}
          {frequent.length > 0 && <div className={head}>Most used filters</div>}
          {frequent.map((u) => <HistoryRow key={u.key} scope={scope} use={u} onPick={() => { onPick(u.filters); setOpen(false); }} />)}
        </div>
      </Popover>
    </>
  );
}

function HistoryRow({ scope, use, onPick }: { scope: FilterScope; use: FilterUse; onPick: () => void }) {
  return (
    <button onClick={onPick} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--hl)] cursor-pointer"
      title={use.filters.map(describeFilter).join(' AND ')}>
      <span className="min-w-0 flex-1 truncate">{suggestName(scope, use.filters)}</span>
      <span className="shrink-0 text-[11px] text-faint tnum">{use.count}×</span>
    </button>
  );
}

/** Kiosk screens: the filters a member chose, for the people watching; nothing to click. */
export function ReadOnlyFilters({ filters, className }: { filters: Filter[]; className?: string }) {
  if (!filters.length) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <FilterIcon size={14} className="text-faint" />
      {filters.map((f, i) => (
        <span key={i} className="inline-flex max-w-[420px] items-center truncate rounded-full border border-line bg-[var(--hl)] px-3 py-0.5 text-[12px]" title={describeFilter(f)}>
          <span className="font-medium">{fieldLabel(f.field)}</span>&nbsp;<span className="text-muted">{OP_LABEL[f.op]}</span>{needsValue(f.op) && <>&nbsp;<span className="font-mono">{f.value}</span></>}
        </span>))}
    </div>
  );
}

/** "Filter by this" for attribute rows: adds field = value to the scope's filters. */
export function useAddFilter(scope: FilterScope) {
  const [filters, setFilters] = useFilters(scope);
  return (f: Filter) => setFilters([...filters.filter((x) => !(x.field === f.field && x.op === f.op)), f]);
}
