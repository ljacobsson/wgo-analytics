import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, ChevronRight, Filter as FilterIcon, ListTree, Plus, Route, Target, ThumbsDown, ThumbsUp, Trash2, Workflow } from 'lucide-react';
import type { DriverDim, DriverRow, Filter, FunnelStepResult, Goal, GoalFunnel, GoalStep, JourneyRow } from '../api/contract';
import { useGoalFunnel, useGoals, usePreviousConversions, useSaveGoal } from '../api/hooks';
import { cn, fmtNum } from '../lib/format';
import { describeFilter } from '../lib/filters';
import { isKiosk } from '../lib/kiosk';
import { suggestName } from '../lib/naming';
import { useProject } from '../lib/project';
import { navigate, pageHref, useRoute } from '../lib/router';
import { useTime } from '../lib/time';
import { AddToDashboard } from '../dashboards/AddToDashboard';
import { FilterBar, FilterChips, useAddFilter } from '../ui/FilterBar';
import { InfoTip } from '../ui/InfoTip';
import { Badge, Button, Card, CardHeader, Delta, EmptyState, ErrorState, Segmented, Skeleton, useDebounced, useToast } from '../ui/kit';
import { RowsSkeleton } from './common';
import { fmtRate, goalEventsHref, previousRate } from './Goals';

const MAX_STEPS = 6;
const MIN_SESSIONS = 20; // as the server: smaller segments are never called better or worse

const DIM_LABEL: Record<DriverDim, string> = {
  entry: 'Landed on', page: 'Viewed', source: 'Came from', device: 'Device', browser: 'Browser', country: 'Country', error: 'Hit error',
};
const DIM_TAB: Record<DriverDim, string> = {
  entry: 'Entry page', page: 'Pages viewed', source: 'Source', device: 'Device', browser: 'Browser', country: 'Country', error: 'Errors',
};
const DIMS = Object.keys(DIM_TAB) as DriverDim[];

/** 42s · 3m 10s · 2h 5m · 3d 4h */
export function fmtSeconds(s: number | null): string {
  if (s == null) return '–';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) { const m = Math.floor(s / 60), r = Math.round(s % 60); return r ? `${m}m ${r}s` : `${m}m`; }
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return m ? `${h}h ${m}m` : `${h}h`; }
  const d = Math.floor(s / 86400), h = Math.round((s % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}
const fmtLift = (l: number | null) => (l == null ? '' : l >= 10 ? `${Math.round(l)}×` : `${l.toFixed(1)}×`);
const fmtImpact = (n: number) => `${n >= 0 ? '+' : '−'}${fmtNum(Math.abs(Math.round(n)))}`;

/** Session-level segments can narrow the whole page; the rest open the matching events. */
function segmentFilter(r: Pick<DriverRow, 'dim' | 'key'>): Filter | null {
  if ((r.dim === 'device' || r.dim === 'browser' || r.dim === 'country') && r.key !== 'Unknown') return { field: r.dim, op: 'eq', value: r.key };
  return null;
}
function segmentEvents(r: Pick<DriverRow, 'dim' | 'key' | 'at'>): Filter[] | null {
  switch (r.dim) {
    case 'entry': case 'page':
      return r.key.startsWith('(') ? null : [{ field: 'type', op: 'eq', value: 'pageview' }, { field: 'path', op: 'eq', value: r.key }];
    case 'source':
      return r.key.startsWith('(') ? null : [{ field: 'type', op: 'eq', value: 'pageview' }, { field: 'referrer', op: 'contains', value: r.key }];
    case 'error': {
      const http = /^([A-Z]+) (\S+) (\d{1,3})$/.exec(r.key);
      const page: Filter[] = r.at != null ? [{ field: 'path', op: 'eq', value: r.at }] : [];
      return http
        ? [{ field: 'type', op: 'eq', value: 'http_error' }, { field: 'httpMethod', op: 'eq', value: http[1] }, { field: 'httpStatus', op: 'eq', value: http[3] }, ...page]
        // the server cuts messages at 200 characters
        : [{ field: 'type', op: 'eq', value: 'error' }, { field: 'errorMessage', op: 'starts_with', value: r.key }, ...page];
    }
    default: return null;
  }
}

/** A rate on a 0..max track: the 95% interval as a band, the rate as a dot, the average as a tick. */
function RateBar({ rate, low, high, avg, max, tone }: { rate: number; low: number; high: number; avg: number; max: number; tone: 'good' | 'bad' | 'neutral' }) {
  const x = (v: number) => `${Math.min(100, (v / (max || 1)) * 100)}%`;
  const c = tone === 'good' ? 'var(--good)' : tone === 'bad' ? 'var(--bad)' : 'var(--s1)';
  return (
    <div className="relative h-3 w-full" title={`${fmtRate(rate)} (95% interval ${fmtRate(low)}–${fmtRate(high)}) vs ${fmtRate(avg)} average`}>
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />
      <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full opacity-30" style={{ left: x(low), width: `calc(${x(high)} - ${x(low)})`, background: c }} />
      <div className="absolute top-0 h-3 w-px bg-faint" style={{ left: x(avg) }} />
      <div className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: x(rate), background: c }} />
    </div>
  );
}

const toneOf = (r: { sessions: number; low: number; high: number }, avg: number): 'good' | 'bad' | 'neutral' =>
  r.sessions < MIN_SESSIONS || avg <= 0 ? 'neutral' : r.low > avg ? 'good' : r.high < avg ? 'bad' : 'neutral';

function SegmentActions({ r }: { r: Pick<DriverRow, 'dim' | 'key' | 'at'> }) {
  const { project } = useProject(); const route = useRoute();
  const add = useAddFilter('events');
  const f = segmentFilter(r), ev = segmentEvents(r);
  return (
    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
      {f && <button onClick={() => add(f)} title={`Only ${describeFilter(f)}`} className="rounded-md p-1 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer"><FilterIcon size={13} /></button>}
      {ev && <button onClick={() => navigate(goalEventsHref(project.id, route.params, ev))} title="Show these events" className="rounded-md p-1 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer"><ListTree size={13} /></button>}
    </span>
  );
}

/** "vs 6.7%", or for errors "vs 78% for others on /checkout" */
const versus = (r: DriverRow) => `vs ${fmtRate(r.baseline)}${r.at != null && r.dim === 'error' ? ` for others on ${r.at}` : ''}`;

function DriverList({ rows, avg, kind }: { rows: DriverRow[]; avg: number; kind: 'best' | 'worst' }) {
  const max = Math.max(avg * 1.5, ...rows.map((r) => Math.max(r.high, r.baseline)));
  if (!rows.length) {
    return (
      <p className="px-4 pb-5 pt-2 text-[12.5px] text-faint">
        {kind === 'best' ? 'No segment converts clearly better than average yet.' : 'No segment converts clearly worse than average.'}
        {' '}Segments need {MIN_SESSIONS}+ sessions and a difference larger than chance.
      </p>
    );
  }
  return (
    <div className="pb-2">
      {rows.map((r) => (
        <div key={r.dim + r.key + (r.at ?? '')} className="group grid grid-cols-[minmax(0,1fr)_110px_72px] items-center gap-3 px-4 py-2 text-[12.5px] hover:bg-[var(--hl)]">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 text-faint">{DIM_LABEL[r.dim]}</span>
              <span className="truncate font-medium" title={r.key}>{r.key}</span>
              <SegmentActions r={r} />
            </div>
            <div className="mt-0.5 truncate text-[11.5px] text-muted tnum">
              {fmtRate(r.rate)} {versus(r)} · {fmtNum(r.sessions)} sessions{r.lift != null && <> · {fmtLift(r.lift)}</>}
            </div>
          </div>
          <RateBar rate={r.rate} low={r.low} high={r.high} avg={r.baseline} max={max} tone={kind === 'best' ? 'good' : 'bad'} />
          <div className={cn('text-right text-[12px] font-semibold tnum', kind === 'best' ? 'text-good' : 'text-bad')} title={kind === 'best' ? 'Conversions above what the baseline rate would give' : 'Conversions missed against the baseline rate'}>
            {fmtImpact(r.impact)}
          </div>
        </div>
      ))}
    </div>
  );
}

function FunnelBars({ data, onDefine }: { data: GoalFunnel; onDefine?: () => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const total = data.sessions;
  const rows: Array<{ name: ReactNode; filters: Filter[]; sessions: number; step?: FunnelStepResult; goal?: boolean }> = [
    { name: 'All sessions', filters: [], sessions: total },
    ...data.steps.map((s, i) => ({ name: s.name, filters: s.filters, sessions: s.sessions, step: s, goal: i === data.steps.length - 1 })),
  ];
  const last = data.steps[data.steps.length - 1];
  const outside = data.converted - (last?.sessions ?? 0);
  return (
    <div className="px-4 pb-4">
      {rows.map((r, i) => {
        const prev = i ? rows[i - 1] : null;
        const lost = prev ? prev.sessions - r.sessions : 0;
        const exits = i >= 2 ? rows[i - 1].step?.exits ?? [] : [];
        return (
          <div key={i}>
            {prev && (
              <div className="flex items-center gap-2 py-1 pl-3 text-[11.5px] text-muted">
                <ArrowDown size={12} className="text-faint" />
                {lost > 0 ? (
                  exits.length ? (
                    <button onClick={() => setOpen(open === i ? null : i)} className="inline-flex items-center gap-1 rounded px-1 hover:bg-[var(--hl)] hover:text-fg cursor-pointer">
                      {open === i ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <span className="text-bad tnum">{fmtNum(lost)} dropped</span> ({fmtRate(prev.sessions ? lost / prev.sessions : null)}) · where they left
                    </button>
                  ) : <span><span className="text-bad tnum">{fmtNum(lost)} dropped</span> ({fmtRate(prev.sessions ? lost / prev.sessions : null)})</span>
                ) : <span>no drop-off</span>}
                {r.step?.medianSeconds != null && i >= 2 && <span className="text-faint">· median {fmtSeconds(r.step.medianSeconds)} after the step before</span>}
              </div>
            )}
            {open === i && exits.length > 0 && (
              <div className="mb-1 ml-8 rounded-lg border border-line bg-[var(--hl)] px-3 py-2 text-[12px]">
                <div className="mb-1 text-[11px] text-faint">Last page of the sessions that stopped after “{rows[i - 1].name}”</div>
                {exits.map((x) => (
                  <div key={x.key} className="flex justify-between gap-4 py-0.5"><span className="truncate font-mono text-[11.5px]">{x.key}</span><span className="tnum text-muted">{fmtNum(x.sessions)}</span></div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-[minmax(160px,240px)_1fr_150px] items-center gap-4 py-1.5">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[13px] font-medium">
                  {r.goal ? <Target size={13} className="shrink-0 text-good" /> : i > 0 && <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[var(--hl)] text-[10px] text-muted">{i}</span>}
                  <span className="truncate" title={typeof r.name === 'string' ? r.name : undefined}>{r.name}</span>
                </div>
                {r.filters.length > 0 && <div className="mt-0.5 truncate text-[11px] text-faint" title={r.filters.map(describeFilter).join(' · ')}>{r.filters.map(describeFilter).join(' · ')}</div>}
              </div>
              <div className="h-7 rounded-md bg-[var(--hl)]">
                <div className="h-7 rounded-md transition-[width] duration-500" style={{ width: `${total ? Math.max(0.5, (r.sessions / total) * 100) : 0}%`, background: r.goal ? 'color-mix(in srgb, var(--good) 70%, transparent)' : 'color-mix(in srgb, var(--s1) 65%, transparent)' }} />
              </div>
              <div className="text-right">
                <span className="text-[14px] font-semibold tnum">{fmtNum(r.sessions)}</span>
                {i > 0 && <span className="ml-2 text-[12px] text-muted tnum">{fmtRate(total ? r.sessions / total : null)}</span>}
              </div>
            </div>
          </div>
        );
      })}
      {data.steps.length === 1 && onDefine && (
        <div className="mt-3 flex items-center justify-between gap-4 rounded-lg border border-dashed border-line px-3 py-2.5 text-[12.5px] text-muted">
          <span>Add the steps you expect people to take, e.g. Pricing → Signup form, to see where they drop off.</span>
          <Button size="sm" onClick={onDefine}><Workflow size={14} />Define steps</Button>
        </div>
      )}
      {data.steps.length > 1 && outside > 0 && (
        <p className="mt-2 text-[11.5px] text-faint">{fmtNum(outside)} more sessions reached the goal without going through these steps in order, so {fmtNum(data.converted)} converted in all.</p>
      )}
    </div>
  );
}

function Journeys({ rows, avg }: { rows: JourneyRow[]; avg: number }) {
  const max = Math.max(avg * 1.5, ...rows.map((r) => r.high));
  if (!rows.length) return <p className="px-4 pb-5 pt-2 text-[12.5px] text-faint">No pageviews in this range.</p>;
  return (
    <div className="pb-2">
      {rows.map((j) => {
        const tone = toneOf(j, avg);
        return (
          <div key={j.pages.join('>')} className="grid grid-cols-[minmax(0,1fr)_80px_70px_110px_110px] items-center gap-3 px-4 py-2 text-[12.5px] hover:bg-[var(--hl)]">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {j.pages.map((p, i) => (
                <span key={i} className="inline-flex min-w-0 items-center gap-1">
                  {i > 0 && <span className="text-faint">→</span>}
                  <span className="max-w-[220px] truncate rounded-md border border-line bg-[var(--hl)] px-1.5 font-mono text-[11.5px]" title={p}>{p}</span>
                </span>
              ))}
            </div>
            <div className="text-right tnum text-muted">{fmtNum(j.sessions)}</div>
            <div className="text-right tnum">{fmtNum(j.converted)}</div>
            <div className="flex items-center justify-end gap-2">
              <span className={cn('tnum font-semibold', tone === 'good' && 'text-good', tone === 'bad' && 'text-bad')}>{fmtRate(j.rate)}</span>
              {tone === 'good' && <Badge tone="good">works</Badge>}
              {tone === 'bad' && <Badge tone="bad">leaks</Badge>}
            </div>
            <RateBar rate={j.rate} low={j.low} high={j.high} avg={avg} max={max} tone={tone} />
          </div>
        );
      })}
    </div>
  );
}

function DimTable({ data, avg }: { data: GoalFunnel; avg: number }) {
  const [dim, setDim] = useState<DriverDim>('entry');
  const rows = data.dims[dim] ?? [];
  const max = Math.max(avg * 1.5, ...rows.map((r) => Math.max(r.high, r.baseline)));
  return (
    <Card>
      <CardHeader title="By segment" sub="Every segment of one kind, by sessions" right={<Segmented value={dim} onChange={setDim} options={DIMS.map((d) => ({ value: d, label: DIM_TAB[d] }))} />} />
      <div className="grid grid-cols-[minmax(0,1fr)_90px_90px_90px_70px_140px] gap-3 border-b border-line px-4 pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
        <span>{DIM_TAB[dim]}</span><span className="text-right">Sessions</span><span className="text-right">Converted</span><span className="text-right">Rate</span><span className="text-right">Lift</span><span />
      </div>
      {!rows.length ? <p className="px-4 py-5 text-[12.5px] text-faint">Nothing in this range.</p> : rows.map((r) => {
        const tone = toneOf(r, r.baseline);
        return (
          <div key={r.key + (r.at ?? '')} className="group grid grid-cols-[minmax(0,1fr)_90px_90px_90px_70px_140px] items-center gap-3 border-b border-line/60 px-4 py-2 text-[12.5px] hover:bg-[var(--hl)]">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate" title={r.key}>{r.key}</span>
              {r.at != null && <span className="shrink-0 font-mono text-[11px] text-faint">on {r.at}</span>}
              <SegmentActions r={r} />
            </div>
            <span className="text-right tnum text-muted">{fmtNum(r.sessions)}</span>
            <span className="text-right tnum">{fmtNum(r.converted)}</span>
            <span className={cn('text-right tnum font-semibold', tone === 'good' && 'text-good', tone === 'bad' && 'text-bad')}>{fmtRate(r.rate)}</span>
            <span className="text-right tnum text-muted">{fmtLift(r.lift)}</span>
            <RateBar rate={r.rate} low={r.low} high={r.high} avg={r.baseline} max={max} tone={tone} />
          </div>
        );
      })}
      {dim === 'error' && rows.length > 0 && <p className="px-4 py-2.5 text-[11.5px] text-faint">Errors compare with the other sessions that viewed the same page: only sessions that get that far can hit them.</p>}
    </Card>
  );
}

type DraftStep = GoalStep & { auto: boolean };
const ready = (steps: DraftStep[]) => steps.filter((s) => s.filters.length > 0).map((s) => ({ name: s.name.trim() || 'Step', filters: s.filters }));

function StepsEditor({ goal, draft, setDraft, onClose }: { goal: Goal; draft: DraftStep[]; setDraft: (d: DraftStep[]) => void; onClose: () => void }) {
  const { project } = useProject();
  const save = useSaveGoal(project.id);
  const toast = useToast();
  const [error, setError] = useState('');
  const update = (i: number, patch: Partial<DraftStep>) => setDraft(draft.map((s, j) => {
    if (j !== i) return s;
    const next = { ...s, ...patch };
    // the name follows the conditions until it's typed by hand
    if (patch.filters && next.auto) next.name = patch.filters.length ? suggestName('events', patch.filters) : '';
    return next;
  }));
  const move = (i: number, by: number) => {
    const d = [...draft];
    [d[i], d[i + by]] = [d[i + by], d[i]];
    setDraft(d);
  };
  const incomplete = draft.some((s) => !s.filters.length || !s.name.trim());
  const submit = async () => {
    setError('');
    try {
      await save.mutateAsync({ id: goal.id, input: { steps: draft.map((s) => ({ name: s.name.trim(), filters: s.filters })) } });
      toast({ title: 'Funnel saved', body: goal.name, tone: 'good' });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div>
          <h3 className="text-[14px] font-semibold">Funnel steps</h3>
          <p className="text-[12px] text-muted">A session reaches a step with a matching event at or after the step before. The funnel below previews your changes.</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={incomplete || save.isPending} onClick={submit}>Save steps</Button>
        </div>
      </div>
      <div className="space-y-2">
        {draft.map((s, i) => (
          <div key={i} className="flex items-start gap-2 rounded-lg border border-line p-2.5">
            <span className="mt-1.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--hl)] text-[11px] text-muted">{i + 1}</span>
            <div className="min-w-0 flex-1 space-y-1.5">
              <input className="field h-8 text-[13px]" value={s.name} placeholder="Step name, e.g. Viewed pricing" onChange={(e) => update(i, { name: e.target.value, auto: false })} />
              <FilterChips scope="events" value={s.filters} onChange={(filters) => update(i, { filters })} />
              {!s.filters.length && <p className="text-[11.5px] text-faint">Add a condition, e.g. Path equals /pricing.</p>}
            </div>
            <div className="flex shrink-0 flex-col gap-0.5">
              <button disabled={i === 0} onClick={() => move(i, -1)} className="rounded-md p-1 text-muted hover:bg-[var(--hl)] hover:text-fg disabled:opacity-30 cursor-pointer" title="Move up"><ArrowUp size={13} /></button>
              <button disabled={i === draft.length - 1} onClick={() => move(i, 1)} className="rounded-md p-1 text-muted hover:bg-[var(--hl)] hover:text-fg disabled:opacity-30 cursor-pointer" title="Move down"><ArrowDown size={13} /></button>
              <button onClick={() => setDraft(draft.filter((_, j) => j !== i))} className="rounded-md p-1 text-muted hover:bg-bad/15 hover:text-bad cursor-pointer" title="Remove"><Trash2 size={13} /></button>
            </div>
          </div>
        ))}
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-line p-2.5 text-[12.5px] text-muted">
          <Target size={14} className="shrink-0 text-good" />
          <span>Last step: the goal, <b className="text-fg">{goal.name}</b></span>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <Button size="sm" disabled={draft.length >= MAX_STEPS} onClick={() => setDraft([...draft, { name: '', filters: [], auto: true }])}><Plus size={14} />Add step</Button>
        {draft.length >= MAX_STEPS && <span className="text-[11.5px] text-faint">At most {MAX_STEPS} steps</span>}
      </div>
      {error && <p className="mt-3 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{error}</p>}
    </Card>
  );
}

export function GoalFunnelPage({ goalId }: { goalId: string }) {
  const { project } = useProject(); const { range } = useTime(); const route = useRoute();
  const goals = useGoals(project.id);
  const goal = goals.data?.find((g) => g.id === goalId);
  const [draft, setDraft] = useState<DraftStep[] | null>(null);
  const preview = useDebounced(useMemo(() => (draft ? JSON.stringify(ready(draft)) : null), [draft]), 400);
  const funnel = useGoalFunnel(project.id, goalId, range, preview ? (JSON.parse(preview) as GoalStep[]) : undefined);
  const prev = usePreviousConversions(project.id, range);
  useEffect(() => { setDraft(null); }, [goalId]);

  const back = pageHref(project.id, 'goals', route.params);
  if (goals.data && !goal) {
    return (
      <EmptyState icon={<Target size={22} />} title="Goal not found" action={<Button onClick={() => navigate(back)}><ArrowLeft size={14} />All goals</Button>}>
        It may have been deleted.
      </EmptyState>
    );
  }
  if (funnel.isError) return <ErrorState error={funnel.error} retry={() => funnel.refetch()} />;
  const data = funnel.data?.goal.id === goalId ? funnel.data : undefined;
  const avg = data && data.sessions ? data.converted / data.sessions : 0;
  const before = previousRate(prev.data, goalId);
  const editing = draft !== null;
  const startEditing = () => goal && setDraft(goal.steps?.length ? goal.steps.map((s) => ({ ...s, auto: false })) : [{ name: '', filters: [], auto: true }]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <button onClick={() => navigate(back)} className="mb-1 inline-flex items-center gap-1 text-[12px] text-muted hover:text-fg cursor-pointer"><ArrowLeft size={13} />Goals</button>
          <h2 className="flex items-center gap-2 text-[18px] font-semibold"><Target size={18} className="text-good" />{goal?.name ?? <Skeleton className="h-6 w-48" />}</h2>
          {goal && <div className="mt-1 flex flex-wrap gap-1">{goal.filters.map((f, i) => <Badge key={i}><span className="max-w-[300px] truncate">{describeFilter(f)}</span></Badge>)}</div>}
        </div>
        <div className="flex shrink-0 gap-2">
          {goal && <Button onClick={() => navigate(goalEventsHref(project.id, route.params, goal.filters))}><ListTree size={14} />Show events</Button>}
          {goal && <AddToDashboard tile={() => ({ viz: 'number', measures: [{ source: 'events', agg: 'session_rate', filters: goal.filters, label: `${goal.name} conversion`, unit: 'percent', better: 'up' }] })} />}
          {goal && !isKiosk() && !editing && <Button onClick={startEditing}><Workflow size={14} />{goal.steps?.length ? 'Edit steps' : 'Define steps'}</Button>}
        </div>
      </div>
      <FilterBar scope="events" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="px-4 py-3">
          <div className="text-[12px] text-muted">Conversion rate</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-[24px] font-semibold tnum">{data ? fmtRate(data.sessions ? avg : null) : '–'}</span>
            {data && data.sessions > 0 && before != null && <Delta cur={avg} prev={before} />}
          </div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-[12px] text-muted">Converting sessions</div>
          <div className="mt-1 text-[24px] font-semibold tnum">{data ? fmtNum(data.converted) : '–'}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-[12px] text-muted">All sessions</div>
          <div className="mt-1 text-[24px] font-semibold tnum">{data ? fmtNum(data.sessions) : '–'}</div>
        </Card>
      </div>

      {editing && goal && <StepsEditor goal={goal} draft={draft} setDraft={setDraft} onClose={() => setDraft(null)} />}

      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-1.5"><Workflow size={15} />Funnel{editing && <Badge tone="accent">preview</Badge>}</span>}
          sub="Sessions that reach each step, in order" />
        {!data ? <div className="px-4 pb-4"><RowsSkeleton n={3} /></div> : <FunnelBars data={data} onDefine={!isKiosk() && !editing ? startEditing : undefined} />}
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={<span className="inline-flex items-center gap-1.5"><ThumbsUp size={15} className="text-good" />Best ways to convert</span>}
            sub="Segments that convert clearly above average, by conversions gained"
            right={<InfoTip label="How is this decided?">
              Sessions are split by the page they landed on, pages viewed before converting, where they came from, device, browser and
              country. A segment is listed when its conversion rate is above the average even at the low end of its 95% interval, and it
              has at least {MIN_SESSIONS} sessions. The number on the right is how many more conversions it brought than the average rate
              would have. These are correlations: a page that converts well may simply be where people who already decided go.
            </InfoTip>} />
          {!data ? <div className="px-4 pb-4"><RowsSkeleton n={4} /></div> : <DriverList rows={data.best} avg={avg} kind="best" />}
        </Card>
        <Card>
          <CardHeader title={<span className="inline-flex items-center gap-1.5"><ThumbsDown size={15} className="text-bad" />Where it goes wrong</span>}
            sub="Segments that convert clearly below average, by conversions missed"
            right={<InfoTip label="How is this decided?">
              The same segments, plus the errors and failed requests sessions hit before converting. A segment is listed when its
              conversion rate is below the average even at the high end of its 95% interval. An error is compared with the other
              sessions that viewed the page it happened on rather than with everyone, since only sessions that get that far can hit
              it. The number on the right is how many conversions the segment would have brought at that rate but didn’t.
            </InfoTip>} />
          {!data ? <div className="px-4 pb-4"><RowsSkeleton n={4} /></div> : <DriverList rows={data.worst} avg={avg} kind="worst" />}
        </Card>
      </div>

      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-1.5"><Route size={15} />Journeys</span>}
          sub="The first pages of each session (repeats collapsed), up to the conversion" />
        <div className="grid grid-cols-[minmax(0,1fr)_80px_70px_110px_110px] gap-3 border-b border-line px-4 pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
          <span>Pages</span><span className="text-right">Sessions</span><span className="text-right">Conv.</span><span className="text-right">Rate</span><span />
        </div>
        {!data ? <div className="px-4 py-3"><RowsSkeleton n={5} /></div> : <Journeys rows={data.journeys} avg={avg} />}
      </Card>

      {data && <DimTable data={data} avg={avg} />}

      <p className="text-[11.5px] text-faint">
        Counted from raw events, so ranges older than the project’s retention come out short. Filters on this page narrow every number, the average included.
      </p>
    </div>
  );
}
