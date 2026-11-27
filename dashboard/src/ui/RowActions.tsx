import { useRef, useState } from 'react';
import { BellPlus, ListFilter, Target } from 'lucide-react';
import type { Filter, FilterScope } from '../api/contract';
import { cn } from '../lib/format';
import { FILTER_PARAM, fieldLabel, mergeFilters, needsValue, OP_LABEL, useFilters, valueHint } from '../lib/filters';
import { isKiosk } from '../lib/kiosk';
import { suggestName } from '../lib/naming';
import { useProject } from '../lib/project';
import type { RowCondition } from '../lib/rowFilters';
import { navigate, pageHref, useRoute } from '../lib/router';
import { Button } from './kit';
import { Popover } from './Popover';

/** Link to the Triggers page that opens "New trigger" for these conditions (`name`: start with this name instead of one made from them). */
export function newTriggerHref(pid: string, params: URLSearchParams, scope: FilterScope, filters: Filter[], name?: string) {
  const p = new URLSearchParams();
  for (const k of ['range', 'from', 'to']) { const v = params.get(k); if (v) p.set(k, v); }
  p.set('new', '1');
  p.set('scope', scope);
  p.set('pf', JSON.stringify(filters));
  if (name) p.set('name', name);
  return `/p/${pid}/triggers?${p}`;
}

/** Link to the Goals page that opens "New goal" for these (events) conditions. */
export function newGoalHref(pid: string, params: URLSearchParams, filters: Filter[]) {
  const p = new URLSearchParams();
  for (const k of ['range', 'from', 'to']) { const v = params.get(k); if (v) p.set(k, v); }
  p.set('new', '1');
  p.set('pf', JSON.stringify(filters));
  return `/p/${pid}/goals?${p}`;
}

type Mode = 'filter' | 'trigger' | 'goal';

/**
 * Per-row "filter by this" and "trigger on this": pick which of the row's values matter, then either narrow the
 * page to rows like it, get notified when new ones arrive, or (events) count them as a conversion goal. Shows on row hover (rows need the `group` class)
 * unless `labels` is set. `filterPage`: filter that page instead of the current one (e.g. a span → traces list).
 */
export function RowActions({ scope, conditions, className, labels, filterPage }: {
  scope: FilterScope; conditions: RowCondition[]; className?: string; labels?: boolean; filterPage?: string;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  if (isKiosk() || !conditions.length) return null;
  const open = (m: Mode) => (e: React.MouseEvent) => { e.stopPropagation(); setMode(mode === m ? null : m); };
  const btn = cn('inline-flex items-center gap-1 rounded-md p-1 text-faint transition-colors hover:bg-[var(--hl)] hover:text-accent cursor-pointer', labels && 'px-2 text-[12px] text-muted');
  return (
    <div ref={anchor} onClick={(e) => e.stopPropagation()}
      className={cn('flex shrink-0 items-center gap-0.5 transition-opacity', labels || mode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100', className)}>
      <button className={cn(btn, mode === 'filter' && 'text-accent')} onClick={open('filter')} title="Filter by values from this row"><ListFilter size={13} />{labels && 'Filter by this'}</button>
      <button className={cn(btn, mode === 'trigger' && 'text-accent')} onClick={open('trigger')} title="Create a trigger for rows like this"><BellPlus size={13} />{labels && 'Create trigger'}</button>
      {scope === 'events' && <button className={cn(btn, mode === 'goal' && 'text-accent')} onClick={open('goal')} title="Make events like this a conversion goal"><Target size={13} />{labels && 'Make goal'}</button>}
      <Popover anchor={anchor} open={!!mode} onClose={() => setMode(null)} width={400}>
        {mode && <ConditionPicker scope={scope} conditions={conditions} mode={mode} filterPage={filterPage} onDone={() => setMode(null)} />}
      </Popover>
    </div>
  );
}

function ConditionPicker({ scope, conditions, mode, filterPage, onDone }: {
  scope: FilterScope; conditions: RowCondition[]; mode: Mode; filterPage?: string; onDone: () => void;
}) {
  const { project } = useProject();
  const route = useRoute();
  const [filters, setFilters] = useFilters(scope);
  const [on, setOn] = useState<boolean[]>(() => conditions.map((c) => c.checked));
  const chosen = conditions.filter((_, i) => on[i]).map((c) => c.filter);
  // one condition per field: e.g. message "begins with" and "equals" are alternatives
  const toggle = (i: number) => setOn((cur) => {
    const turnOn = !cur[i];
    return cur.map((v, j) => (j === i ? turnOn : turnOn && conditions[j].filter.field === conditions[i].filter.field ? false : v));
  });

  const apply = () => {
    const next = mergeFilters(filters, chosen);
    if (filterPage) navigate(pageHref(project.id, filterPage, route.params, { [FILTER_PARAM[scope]]: JSON.stringify(next) }));
    else setFilters(next);
    onDone();
  };
  const trigger = () => { navigate(newTriggerHref(project.id, route.params, scope, chosen)); onDone(); };
  const goal = () => { navigate(newGoalHref(project.id, route.params, chosen)); onDone(); };
  const HEADING: Record<Mode, string> = { filter: 'Show rows where', trigger: 'Notify me when a new row has', goal: 'Count a conversion when an event has' };

  return (
    <div className="space-y-2.5">
      <div className="text-[12px] font-medium text-muted">{HEADING[mode]}</div>
      <div className="max-h-[300px] space-y-0.5 overflow-y-auto">
        {conditions.map((c, i) => (
          <label key={i} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-[12px] hover:bg-[var(--hl)]">
            <input type="checkbox" className="mt-[3px] accent-[var(--accent)]" checked={!!on[i]} onChange={() => toggle(i)} />
            <span className="min-w-0 break-words">
              <span className="font-medium">{fieldLabel(c.filter.field)}</span> <span className="text-muted">{OP_LABEL[c.filter.op]}</span>
              {needsValue(c.filter.op) && <> <span className="font-mono text-[11.5px]">{c.filter.value}</span></>}
              {valueHint(c.filter.field, c.filter.op, c.filter.value) && <span className="text-faint"> ({valueHint(c.filter.field, c.filter.op, c.filter.value)})</span>}
            </span>
          </label>))}
      </div>
      {chosen.length > 0 && <div className="truncate text-[11.5px] text-faint" title={suggestName(scope, chosen)}>{suggestName(scope, chosen)}</div>}
      <div className="flex items-center justify-end gap-2">
        {mode === 'filter'
          ? <><Button size="sm" variant="ghost" disabled={!chosen.length} onClick={trigger}><BellPlus size={13} />Trigger</Button>
            <Button size="sm" variant="primary" disabled={!chosen.length} onClick={apply}><ListFilter size={13} />Filter</Button></>
          : mode === 'trigger'
          ? <><Button size="sm" variant="ghost" disabled={!chosen.length} onClick={apply}><ListFilter size={13} />Filter</Button>
            <Button size="sm" variant="primary" disabled={!chosen.length} onClick={trigger}><BellPlus size={13} />Create trigger</Button></>
          : <><Button size="sm" variant="ghost" disabled={!chosen.length} onClick={apply}><ListFilter size={13} />Filter</Button>
            <Button size="sm" variant="primary" disabled={!chosen.length} onClick={goal}><Target size={13} />Create goal</Button></>}
      </div>
    </div>
  );
}
