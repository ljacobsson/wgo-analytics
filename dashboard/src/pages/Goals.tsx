import { useEffect, useMemo, useState } from 'react';
import { ListTree, Pencil, Plus, Target, Trash2, Workflow } from 'lucide-react';
import type { ConversionsResponse, Filter, Goal, GoalConversions } from '../api/contract';
import { useConversions, useDeleteGoal, useGoals, usePreviousConversions, useSaveGoal } from '../api/hooks';
import { Sparkline } from '../charts/Sparkline';
import { fmtNum } from '../lib/format';
import { currentFilters, describeFilter, FILTER_PARAM, mergeFilters } from '../lib/filters';
import { isKiosk } from '../lib/kiosk';
import { suggestName } from '../lib/naming';
import { useProject } from '../lib/project';
import { navigate, pageHref, useRoute, useSetParams } from '../lib/router';
import { useTime } from '../lib/time';
import { AddToDashboard } from '../dashboards/AddToDashboard';
import { FilterBar, FilterChips } from '../ui/FilterBar';
import { Badge, Button, Card, Delta, Dialog, EmptyState, ErrorState, Field, useToast } from '../ui/kit';
import { InfoTip } from '../ui/InfoTip';
import { RowsSkeleton, TableHead } from './common';

/** Converting sessions / all sessions, or null when there were no sessions to compare with. */
export const conversionRate = (g: { sessions: number }, all: { sessions: number }) => (all.sessions ? g.sessions / all.sessions : null);
export const fmtRate = (r: number | null) => (r == null ? '–' : r === 0 ? '0%' : r < 0.001 ? '<0.1%' : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`);

/** A goal's rate in the window before, for the delta (null while loading or when that window had no sessions). */
export function previousRate(prev: ConversionsResponse | undefined, id: string): number | null {
  const g = prev?.goals.find((x) => x.id === id);
  return g && prev ? conversionRate(g, prev) : null;
}

/** Link to the Events page showing a goal's events, on top of the filters already set. */
export const goalEventsHref = (pid: string, params: URLSearchParams, filters: Filter[]) =>
  pageHref(pid, 'events', params, { [FILTER_PARAM.events]: JSON.stringify(mergeFilters(currentFilters('events'), filters)) });

function decodeFilters(raw: string | null): Filter[] {
  try {
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function GoalDialog({ open, initial, prefill, onClose }: { open: boolean; initial: Goal | null; prefill: Filter[]; onClose: () => void }) {
  const { project } = useProject();
  const save = useSaveGoal(project.id);
  const toast = useToast();
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setFilters(initial?.filters ?? prefill);
    setName(initial?.name ?? (prefill.length ? suggestName('events', prefill) : ''));
    setNameTouched(!!initial);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // the name follows the conditions until you type one yourself
  useEffect(() => { if (open && !nameTouched) setName(filters.length ? suggestName('events', filters) : ''); }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  const valid = !!name.trim() && filters.length > 0;
  const submit = async () => {
    if (!valid) return;
    setError('');
    try {
      await save.mutateAsync({ id: initial?.id, input: { name: name.trim(), filters } });
      toast({ title: initial ? 'Goal updated' : 'Goal created', body: name.trim(), tone: 'good' });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} width={600} title={initial ? 'Edit goal' : 'New conversion goal'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid || save.isPending} onClick={submit}>{initial ? 'Save' : 'Create goal'}</Button></>}>
      <div className="space-y-4">
        <Field label="Name"><input autoFocus className="field" value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} placeholder="Signed up" /></Field>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-muted">A session converts when it has an event matching all of</div>
          <div className="rounded-lg border border-line p-2.5">
            <FilterChips scope="events" value={filters} onChange={setFilters} />
            {!filters.length && <p className="mt-1.5 text-[11.5px] text-faint">Add at least one condition, e.g. Event type equals custom and Name equals checkout_completed, or Path equals /thank-you.</p>}
          </div>
        </div>
        <p className="text-[11.5px] text-faint">Goals count past events too: the numbers cover everything still within the project’s data retention.</p>
        {error && <p className="rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{error}</p>}
      </div>
    </Dialog>
  );
}

const COLS = 'grid-cols-[minmax(220px,2fr)_100px_110px_130px_minmax(120px,1fr)_124px]';

function GoalRow({ g, all, prevRate, goal, onEdit }: { g: GoalConversions; all: ConversionsResponse; prevRate: number | null; goal: Goal | undefined; onEdit: (g: Goal) => void }) {
  const { project } = useProject(); const route = useRoute();
  const del = useDeleteGoal(project.id);
  const rate = conversionRate(g, all);
  const kiosk = isKiosk();
  return (
    <div className={`group grid ${COLS} items-center gap-4 border-b border-line/60 px-4 py-3 text-[13px] transition-colors hover:bg-[var(--hl)]`}>
      <div className="min-w-0 space-y-1">
        <button onClick={() => navigate(pageHref(project.id, `goals/${g.id}`, route.params))} className="block max-w-full truncate text-left font-medium hover:text-accent hover:underline cursor-pointer" title={`${g.name}: funnel and what drives it`}>{g.name}</button>
        <div className="flex flex-wrap gap-1">{g.filters.map((f, i) => <Badge key={i}><span className="max-w-[300px] truncate">{describeFilter(f)}</span></Badge>)}</div>
      </div>
      <div className="text-right tnum">{fmtNum(g.conversions)}</div>
      <div className="text-right tnum text-muted">{fmtNum(g.sessions)}</div>
      <div className="flex items-baseline justify-end gap-2">
        <span className="tnum text-[15px] font-semibold">{fmtRate(rate)}</span>
        {rate != null && prevRate != null && <Delta cur={rate} prev={prevRate} />}
      </div>
      <div className="h-8"><Sparkline data={g.series} color="var(--s5)" height={32} /></div>
      <div className="flex items-center justify-end gap-0.5">
        <button onClick={() => navigate(pageHref(project.id, `goals/${g.id}`, route.params))} className="rounded-md p-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="Funnel: how sessions reach this goal"><Workflow size={14} /></button>
        <button onClick={() => navigate(goalEventsHref(project.id, route.params, g.filters))} className="rounded-md p-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="Show this goal’s events"><ListTree size={14} /></button>
        <AddToDashboard label={false} className="!h-auto !border-transparent !px-1.5 !py-1.5 hover:!bg-[var(--hl)]" tile={() => ({ viz: 'number', measures: [{ source: 'events', agg: 'session_rate', filters: g.filters, label: `${g.name} conversion`, unit: 'percent', better: 'up' }] })} />
        {!kiosk && goal && <>
          <button onClick={() => onEdit(goal)} className="rounded-md p-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="Edit"><Pencil size={14} /></button>
          <button onClick={() => { if (confirm(`Delete goal “${g.name}”?`)) del.mutate(g.id); }} className="rounded-md p-1.5 text-muted hover:bg-bad/15 hover:text-bad cursor-pointer" title="Delete"><Trash2 size={14} /></button>
        </>}
      </div>
    </div>
  );
}

export function GoalsPage() {
  const { project } = useProject(); const { range } = useTime();
  const route = useRoute(); const set = useSetParams();
  const goals = useGoals(project.id);
  const conv = useConversions(project.id, range);
  const prev = usePreviousConversions(project.id, range);
  const [dialog, setDialog] = useState<{ open: boolean; goal: Goal | null; prefill: Filter[] }>({ open: false, goal: null, prefill: [] });
  const byId = useMemo(() => new Map((goals.data ?? []).map((g) => [g.id, g])), [goals.data]);

  // "Make goal" from an event row lands here with ?new=1&pf=<filters JSON>
  const wantsNew = route.params.get('new') === '1';
  useEffect(() => {
    if (!wantsNew) return;
    setDialog({ open: true, goal: null, prefill: decodeFilters(route.params.get('pf')) });
    set({ new: null, pf: null });
  }, [wantsNew]); // eslint-disable-line react-hooks/exhaustive-deps

  const openNew = () => setDialog({ open: true, goal: null, prefill: [] });
  if (conv.isError) return <ErrorState error={conv.error} retry={() => conv.refetch()} />;
  const data = conv.data;
  return (
    <div className="space-y-4">
      <FilterBar scope="events" />
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p className="text-[13px] text-muted">
          Any event can be a conversion: a signup click, a visit to /thank-you, a custom <code>checkout_completed</code> event. Hover a row in Events, Clicks or the Overview and click <Target size={12} className="inline -mt-0.5" /> to make it one.
        </p>
        {!isKiosk() && <Button variant="primary" className="shrink-0" onClick={openNew}><Plus size={15} />New goal</Button>}
      </div>
      <Card className="@container overflow-x-auto">
        <div className="min-w-[860px]">
          <TableHead className={COLS} cols={['Goal', ['Conversions', 'text-right'], ['Sessions', 'text-right'], ['Conversion rate', 'text-right'], 'Conversions over time', '']} />
          {!data ? <RowsSkeleton n={4} />
            : data.goals.length === 0 ? (
              <EmptyState pinned icon={<Target size={22} />} title="No goals yet"
                action={!isKiosk() && <Button variant="primary" onClick={openNew}><Plus size={15} />Create a goal</Button>}>
                Track how many sessions sign up, buy or reach any page. Open <b>Events</b>, expand an event and click <b>Make this a goal</b>, or hover any row and click its target.
              </EmptyState>)
            : data.goals.map((g) => <GoalRow key={g.id} g={g} all={data} prevRate={previousRate(prev.data, g.id)} goal={byId.get(g.id)} onEdit={(goal) => setDialog({ open: true, goal, prefill: [] })} />)}
        </div>
      </Card>
      {data && data.goals.length > 0 && (
        <p className="inline-flex items-center gap-1 text-[11.5px] text-faint">
          Conversion rate = converting sessions ÷ all {fmtNum(data.sessions)} sessions in this range.
          <InfoTip label="How are conversions counted?">
            A session converts when it has at least one event matching the goal; <b className="text-fg">Conversions</b> counts every matching
            event. Filters on this page narrow both the goal’s events and the sessions it’s compared with. The change compares with the
            same-length window before. Goals are counted from raw events, so ranges older than the project’s retention come out short.
          </InfoTip>
        </p>)}
      <GoalDialog open={dialog.open} initial={dialog.goal} prefill={dialog.prefill} onClose={() => setDialog({ open: false, goal: null, prefill: [] })} />
    </div>
  );
}
