import { useMemo } from 'react';
import { Bug, ListTree, Play, Split, X } from 'lucide-react';
import { FLOW_OTHER, type Filter, type FlowExitPage, type FlowNode } from '../api/contract';
import { useFlows } from '../api/hooks';
import { FlowChart, NodeSummary } from '../charts/FlowChart';
import { cn, fmtNum } from '../lib/format';
import { currentFilters, FILTER_PARAM, mergeFilters } from '../lib/filters';
import { useProject } from '../lib/project';
import { navigate, pageHref, useRoute, useSetParams } from '../lib/router';
import { useTime } from '../lib/time';
import { FilterBar } from '../ui/FilterBar';
import { InfoTip } from '../ui/InfoTip';
import { Button, Card, CardHeader, EmptyState, ErrorState, Segmented, Skeleton, Switch } from '../ui/kit';
import { RowsSkeleton, TableHead } from './common';

const STEPS = ['3', '4', '5', '6', '7'] as const;
type Steps = (typeof STEPS)[number];
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');
/** "POST /api/checkout 502": a failed request (shown on Network) rather than a JavaScript error. */
const isHttpError = (key: string) => /^[A-Z]+ \S+ \d{3}$/.test(key);

/** A page in the project with extra events filters on top of the ones already set. */
function filteredHref(pid: string, params: URLSearchParams, page: string, extra: Filter[]) {
  return pageHref(pid, page, params, { [FILTER_PARAM.events]: JSON.stringify(mergeFilters(currentFilters('events'), extra)) });
}

export function FlowsPage() {
  const { project } = useProject(); const { range } = useTime();
  const route = useRoute(); const set = useSetParams();
  const start = route.params.get('start') || null;
  const steps = (STEPS as readonly string[]).includes(route.params.get('steps') ?? '') ? (route.params.get('steps') as Steps) : '5';
  const highlight = route.params.get('errors') === '1';
  const flows = useFlows(project.id, range, start, Number(steps));
  const data = flows.data;

  const startFrom = (path: string | null) => set({ start: path }, false);
  // pages to start from: the current one, the entry pages and the pages people leave on
  const startOptions = useMemo(() => {
    const s = new Set<string>();
    if (start) s.add(start);
    for (const n of data?.nodes ?? []) if (n.step === 0 && n.key !== FLOW_OTHER) s.add(n.key);
    for (const p of data?.exitPages ?? []) s.add(p.path);
    return [...s];
  }, [data, start]);

  const bounced = data?.nodes.filter((n) => n.step === 0).reduce((a, n) => a + n.exits, 0) ?? 0;
  const withErrors = useMemo(() => data?.nodes.filter((n) => n.errors > 0).reduce((a, n) => a + n.errors, 0) ?? 0, [data]);

  if (flows.isError) return <ErrorState error={flows.error} retry={() => flows.refetch()} />;

  const panel = (n: FlowNode, close: () => void) => (
    <div className="space-y-3 text-[12px]">
      <NodeSummary n={n} last={n.step === Number(steps) - 1} />
      {n.topErrors.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11.5px] font-medium text-muted">Most common errors here</div>
          {n.topErrors.map((e) => (
            <button key={e.key} className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left hover:bg-[var(--hl)] cursor-pointer"
              title={isHttpError(e.key) ? 'Show failed requests on this page' : 'Show this error'}
              onClick={() => {
                close();
                navigate(isHttpError(e.key)
                  ? filteredHref(project.id, route.params, 'network', n.key === FLOW_OTHER ? [] : [{ field: 'path', op: 'eq', value: n.key }])
                  : filteredHref(project.id, route.params, 'errors', [...(n.key === FLOW_OTHER ? [] : [{ field: 'path', op: 'eq', value: n.key } as Filter]), { field: 'errorMessage', op: 'contains', value: e.key.slice(0, 120) }]));
              }}>
              <Bug size={12} className="mt-[3px] shrink-0 text-bad" />
              <span className="min-w-0 flex-1 break-words">{e.key}</span>
              <span className="shrink-0 tnum text-muted">{fmtNum(e.sessions)}</span>
            </button>))}
        </div>)}
      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-2.5">
        {n.key !== FLOW_OTHER && <Button size="sm" variant="ghost" onClick={() => { close(); navigate(filteredHref(project.id, route.params, 'events', [{ field: 'path', op: 'eq', value: n.key }])); }}><ListTree size={13} />Events on this page</Button>}
        {n.key !== FLOW_OTHER && n.key !== start && <Button size="sm" variant="primary" onClick={() => { close(); startFrom(n.key); }}><Play size={13} />Start flow here</Button>}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <FilterBar scope="events" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-[12.5px] text-muted">
          Start from
          <select className="field !w-auto !max-w-[280px] !py-1 text-[12.5px]" value={start ?? ''} onChange={(e) => startFrom(e.target.value || null)} aria-label="Start from">
            <option value="">Any entry page</option>
            {startOptions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          {start && <button className="rounded-md p-1 text-faint hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="Start from any entry page" onClick={() => startFrom(null)}><X size={13} /></button>}
        </label>
        <div className="flex items-center gap-2 text-[12.5px] text-muted">
          Steps
          <Segmented value={steps} onChange={(v) => set({ steps: v === '5' ? null : v }, false)} options={STEPS.map((s) => ({ value: s, label: s }))} />
        </div>
        <div className="text-[12.5px]"><Switch checked={highlight} onChange={(b) => set({ errors: b ? '1' : null }, false)} label="Highlight errors" /></div>
      </div>

      <Card>
        <CardHeader
          title={<span className="inline-flex items-center gap-1.5"><Split size={14} className="text-muted" />{start ? <>Paths from <span className="font-mono text-[12.5px]">{start}</span></> : 'Paths from the entry page'}</span>}
          sub={data
            ? <>{fmtNum(data.sessions)} sessions · {pct(bounced, data.sessions)} left after the first page{withErrors > 0 && <> · <span className="text-bad">{fmtNum(withErrors)} hit an error along the way</span></>}</>
            : <span className="skeleton inline-block h-3 w-56 align-middle" />}
          right={
            <InfoTip align="end" label="How are flows counted?">
              Each column is a page view in order, with reloads of the same page counted once. Columns show their top 6 pages, the
              rest as <b className="text-fg">(other)</b>. The red part of a page is the sessions that left there. Errors are JavaScript
              errors and failed requests that happened while the session was on that page. Filters choose sessions: a session is
              included when any of its events matches, so <b className="text-fg">Event type equals error</b> shows the paths of sessions that hit an
              error. Counted from raw events, so ranges older than the project’s retention come out short.
            </InfoTip>} />
        <div className="px-4 pb-4">
          {!data ? <Skeleton className="h-[360px] w-full" />
            : data.sessions === 0 ? (
              <EmptyState icon={<Split size={22} />} title={start ? `No sessions viewed ${start}` : 'No page views in this range'}
                action={start ? <Button onClick={() => startFrom(null)}>Start from any entry page</Button> : undefined}>
                Flows are built from pageviews. Try a longer range or fewer filters.
              </EmptyState>)
            : <div className={cn('transition-opacity', flows.isFetching && 'opacity-60')}><FlowChart data={data} highlightErrors={highlight} panel={panel} /></div>}
        </div>
        {data && data.sessions > 0 && <p className="px-4 pb-3 text-[11.5px] text-faint">Click a page for its errors, or to follow the paths from there.</p>}
      </Card>

      <Card className="@container overflow-x-auto">
        <CardHeader title="Where sessions leave" sub={start ? `Pages viewed from ${start} on, by sessions that ended there` : 'By sessions that ended on the page'} />
        <div className="min-w-[760px]">
          <TableHead className={COLS} cols={['Page', ['Viewed by', 'text-right'], ['Left here', 'text-right'], 'Exit rate', ['Hit an error', 'text-right'], ['Left after an error', 'text-right']]} />
          {!data ? <RowsSkeleton n={5} />
            : data.exitPages.length === 0 ? <p className="px-4 py-6 text-center text-[12.5px] text-faint">No page views in this range.</p>
            : data.exitPages.map((p) => <ExitRow key={p.path} p={p} current={p.path === start} onStart={() => startFrom(p.path)} />)}
        </div>
      </Card>
    </div>
  );
}

const COLS = 'grid-cols-[minmax(200px,2fr)_90px_90px_minmax(140px,1fr)_100px_130px]';

function ExitRow({ p, current, onStart }: { p: FlowExitPage; current: boolean; onStart: () => void }) {
  const errRate = p.errorViews ? p.errorExits / p.errorViews : null;
  // clearly worse: an error makes leaving at least 1.5× and 10 points likelier than on this page overall
  const worse = errRate != null && p.errorViews >= 5 && errRate >= p.rate * 1.5 && errRate - p.rate >= 0.1;
  return (
    <div className={cn('grid items-center gap-4 border-b border-line/60 px-4 py-2.5 text-[13px] transition-colors hover:bg-[var(--hl)]', COLS)}>
        <button onClick={onStart} disabled={current} className="min-w-0 truncate text-left font-mono text-[12.5px] hover:text-accent hover:underline cursor-pointer disabled:cursor-default disabled:no-underline disabled:text-fg" title={current ? 'The flow starts here' : `Follow the paths from ${p.path}`}>{p.path}</button>
        <div className="text-right tnum text-muted">{fmtNum(p.views)}</div>
        <div className="text-right tnum">{fmtNum(p.exits)}</div>
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--hl)]"><div className="h-full rounded-full bg-bad/70" style={{ width: `${Math.round(p.rate * 100)}%` }} /></div>
          <span className="w-10 text-right tnum">{pct(p.exits, p.views)}</span>
        </div>
        <div className={cn('text-right tnum', p.errorViews ? 'text-bad' : 'text-faint')}>{p.errorViews ? fmtNum(p.errorViews) : '–'}</div>
        <div className={cn('text-right tnum', worse ? 'font-semibold text-bad' : 'text-muted')} title={worse ? 'Sessions that hit an error here leave clearly more often' : undefined}>
          {errRate == null ? '–' : pct(p.errorExits, p.errorViews)}
        </div>
    </div>
  );
}
