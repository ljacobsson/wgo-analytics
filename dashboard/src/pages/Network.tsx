import { Globe, MonitorPlay, Waypoints } from 'lucide-react';
import { useEvents, useHttpErrors } from '../api/hooks';
import type { AnalyticsEvent, HttpErrorGroup } from '../api/contract';
import { useProject } from '../lib/project';
import { useTime } from '../lib/time';
import { pageHref, useRoute, useSetParams } from '../lib/router';
import { Card, Drawer, EmptyState, ErrorState, Mono, MethodBadge, Skeleton, StatusPill } from '../ui/kit';
import { Dl, RowsSkeleton, TableHead, useSort } from './common';
import { fmtDateTime, fmtMs, fmtNum, relTime } from '../lib/format';
import { UserCell } from '../ui/EventColumns';

import { FilterBar } from '../ui/FilterBar';
import { AddToDashboard, withFilters } from '../dashboards/AddToDashboard';
import { currentFilters } from '../lib/filters';
import { BUILTIN } from '../dashboards/measures';
import { RowActions } from '../ui/RowActions';
import { httpGroupConditions } from '../lib/rowFilters';
const COLS = 'grid-cols-[70px_minmax(240px,3fr)_70px_90px_80px_110px_110px]';
const gid = (g: HttpErrorGroup) => `${g.method}|${g.route}|${g.status}`;
const SORT = {
  method: (g: HttpErrorGroup) => g.method, route: (g: HttpErrorGroup) => g.route, status: (g: HttpErrorGroup) => g.status,
  count: (g: HttpErrorGroup) => g.count, sessions: (g: HttpErrorGroup) => g.sessions, avg: (g: HttpErrorGroup) => g.avgDurationMs,
  lastSeen: (g: HttpErrorGroup) => Date.parse(g.lastSeen),
};

/** Links from one failed request to its backend trace (the SDK sent a traceparent) and its session's replay. */
function OccurrenceLinks({ e }: { e: AnalyticsEvent }) {
  const { project } = useProject(); const route = useRoute();
  const trace = typeof e.props.trace === 'string' ? e.props.trace : null;
  return (
    <span className="flex shrink-0 items-center gap-2.5 text-[11.5px]">
      {trace && <a className="inline-flex items-center gap-1 text-muted hover:text-fg" title="Open the backend trace" href={'#' + pageHref(project.id, `traces/${trace}`, route.params, { at: e.ts })}><Waypoints size={12} />Trace</a>}
      {e.sessionId && <a className="inline-flex items-center gap-1 text-muted hover:text-fg" title="Watch the session at this moment, if it was recorded" href={'#' + pageHref(project.id, `recordings/${encodeURIComponent(e.sessionId)}`, route.params, { t: String(Date.parse(e.ts)) })}><MonitorPlay size={12} />Replay</a>}
    </span>
  );
}

function NetDrawer({ g, onClose }: { g: HttpErrorGroup | null; onClose: () => void }) {
  const { project } = useProject(); const { range } = useTime(); const route = useRoute();
  const prefix = g ? g.route.split(/\/:/)[0] : undefined;
  const occ = useEvents(project.id, range, { type: 'http_error', q: prefix || undefined }, !!g, 100);
  const events = (occ.data?.pages[0]?.events ?? []).filter((e) => g && e.httpRoute === g.route && e.httpMethod === g.method && e.httpStatus === g.status).slice(0, 25);
  return (
    <Drawer open={!!g} onClose={onClose} width={640} title={<span className="flex items-center gap-2"><Globe size={16} className="text-s2" />Failing request</span>}>
      {g && (
        <div className="space-y-5 p-5">
          <div className="flex items-center gap-3"><MethodBadge method={g.method} /><Mono className="break-all text-[14px]">{g.route}</Mono><StatusPill status={g.status} /></div>
          <div className="grid grid-cols-3 gap-3">{[['Failures', fmtNum(g.count)], ['Sessions', fmtNum(g.sessions)], ['Avg duration', fmtMs(g.avgDurationMs)]].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-line bg-[var(--hl)] p-3"><div className="text-[11px] text-faint">{k}</div><div className="mt-0.5 text-[16px] font-semibold tnum">{v}</div></div>))}</div>
          <Dl rows={[['Sample URL', g.sampleUrl && <Mono className="break-all">{g.sampleUrl}</Mono>], ['Last seen', relTime(g.lastSeen)],
            ['Backend trace', g.sampleTraceId ? <a className="inline-flex items-center gap-1 text-accent hover:underline" href={'#' + pageHref(project.id, `traces/${g.sampleTraceId}`, route.params, { at: g.lastSeen })}><Waypoints size={12} />Latest failure's trace</a>
              : <span className="text-faint">None. <a className="text-accent hover:underline" href="#/docs?s=trace-linking">How to link requests to backend traces</a></span>]]} />
          <div><h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-faint">Recent occurrences</h4>
            {occ.isPending ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9" />)}</div> : events.length === 0 ? <p className="text-[13px] text-muted">No recent occurrences loaded.</p> : (
              <div className="divide-y divide-line/60 rounded-xl border border-line">{events.map((e) => (
                <div key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-[12.5px] sm:flex-nowrap"><span className="w-28 shrink-0 tnum text-faint">{fmtDateTime(e.ts)}</span><span className="order-last min-w-0 basis-full truncate font-mono text-[11.5px] text-muted sm:order-none sm:basis-auto sm:flex-1">{e.httpUrl}</span>
                  <span className="tnum text-faint">{fmtMs(e.durationMs)}</span><UserCell e={e} className="ml-auto w-[132px] shrink-0 justify-end sm:ml-0" />
                  <OccurrenceLinks e={e} /></div>))}</div>)}</div>
        </div>
      )}
    </Drawer>
  );
}

export function NetworkPage() {
  const { project } = useProject(); const { range } = useTime(); const route = useRoute(); const set = useSetParams();
  const { data, isPending, isError, error, refetch } = useHttpErrors(project.id, range);
  const sel = data?.find((g) => gid(g) === route.params.get('g')) ?? null;
  const { sorted, sort, onSort } = useSort(data, SORT, { key: 'count', dir: 'desc' });
  if (isError) return <ErrorState error={error} retry={() => refetch()} />;
  return (
    <>
      <FilterBar scope="events" className="mb-3" />
      <div className="mb-3 flex justify-end"><AddToDashboard tile={() => {
        const m = BUILTIN.find((d) => d.id === 'http-errors')!.measure;
        return { viz: 'bars', measures: [withFilters(m, [...(m.filters ?? []), ...currentFilters('events')])], groupBy: 'httpRoute', limit: 5 };
      }} /></div>
      <Card className="@container overflow-x-auto">
        <div className="min-w-[900px]">
          <TableHead className={COLS} sort={sort} onSort={(k) => onSort(k as keyof typeof SORT)}
            cols={[['Method', '', 'method'], ['Route', '', 'route'], ['Status', '', 'status'], ['Failures', 'text-right', 'count'], ['Sessions', 'text-right', 'sessions'], ['Avg duration', 'text-right', 'avg'], ['Last seen', 'text-right', 'lastSeen']]} />
          {isPending ? <RowsSkeleton /> : !data.length ? <EmptyState pinned icon={<Globe size={22} />} title="No failing requests">4xx, 5xx and network failures from fetch / XHR are listed here.</EmptyState> :
            sorted!.map((g) => (
              <div key={gid(g)} role="button" tabIndex={0} onClick={() => set({ g: gid(g) }, false)} onKeyDown={(e) => { if (e.key === 'Enter') set({ g: gid(g) }, false); }} className={`group grid w-full ${COLS} cursor-pointer items-center gap-4 border-b border-line/60 px-4 py-2.5 text-left text-[13px] transition-colors hover:bg-[var(--hl)]`}>
                <MethodBadge method={g.method} /><div className="flex min-w-0 items-center gap-2"><Mono className="min-w-0 flex-1 truncate">{g.route}</Mono><RowActions scope="events" conditions={httpGroupConditions(g)} /></div><StatusPill status={g.status} />
                <div className="text-right tnum font-medium">{fmtNum(g.count)}</div><div className="text-right tnum text-muted">{fmtNum(g.sessions)}</div>
                <div className="text-right tnum text-muted">{fmtMs(g.avgDurationMs)}</div><div className="text-right text-[12px] text-faint">{relTime(g.lastSeen)}</div>
              </div>))}
        </div>
      </Card>
      <NetDrawer g={sel} onClose={() => set({ g: null }, false)} />
    </>
  );
}
