import { Globe } from 'lucide-react';
import { useEvents, useHttpErrors } from '../api/hooks';
import type { HttpErrorGroup } from '../api/contract';
import { useProject } from '../lib/project';
import { useTime } from '../lib/time';
import { useRoute, useSetParams } from '../lib/router';
import { Card, Drawer, EmptyState, ErrorState, Mono, MethodBadge, Skeleton, StatusPill } from '../ui/kit';
import { Dl, RowsSkeleton, TableHead, useSort } from './common';
import { fmtDateTime, fmtMs, fmtNum, relTime } from '../lib/format';
import { UserCell } from '../ui/EventColumns';

import { FilterBar } from '../ui/FilterBar';
import { RowActions } from '../ui/RowActions';
import { httpGroupConditions } from '../lib/rowFilters';
const COLS = 'grid-cols-[70px_minmax(240px,3fr)_70px_90px_80px_110px_110px]';
const gid = (g: HttpErrorGroup) => `${g.method}|${g.route}|${g.status}`;
const SORT = {
  method: (g: HttpErrorGroup) => g.method, route: (g: HttpErrorGroup) => g.route, status: (g: HttpErrorGroup) => g.status,
  count: (g: HttpErrorGroup) => g.count, sessions: (g: HttpErrorGroup) => g.sessions, avg: (g: HttpErrorGroup) => g.avgDurationMs,
  lastSeen: (g: HttpErrorGroup) => Date.parse(g.lastSeen),
};

function NetDrawer({ g, onClose }: { g: HttpErrorGroup | null; onClose: () => void }) {
  const { project } = useProject(); const { range } = useTime();
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
          <Dl rows={[['Sample URL', g.sampleUrl && <Mono className="break-all">{g.sampleUrl}</Mono>], ['Last seen', relTime(g.lastSeen)]]} />
          <div><h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-faint">Recent occurrences</h4>
            {occ.isPending ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9" />)}</div> : events.length === 0 ? <p className="text-[13px] text-muted">No recent occurrences loaded.</p> : (
              <div className="divide-y divide-line/60 rounded-xl border border-line">{events.map((e) => (
                <div key={e.id} className="flex items-center gap-3 px-3 py-2 text-[12.5px]"><span className="w-28 shrink-0 tnum text-faint">{fmtDateTime(e.ts)}</span><span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{e.httpUrl}</span>
                  <span className="tnum text-faint">{fmtMs(e.durationMs)}</span><UserCell e={e} className="w-[132px] shrink-0 justify-end" /></div>))}</div>)}</div>
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
      <FilterBar scope="events" className="mb-4" />
      <Card className="overflow-x-auto">
        <div className="min-w-[900px]">
          <TableHead className={COLS} sort={sort} onSort={(k) => onSort(k as keyof typeof SORT)}
            cols={[['Method', '', 'method'], ['Route', '', 'route'], ['Status', '', 'status'], ['Failures', 'text-right', 'count'], ['Sessions', 'text-right', 'sessions'], ['Avg duration', 'text-right', 'avg'], ['Last seen', 'text-right', 'lastSeen']]} />
          {isPending ? <RowsSkeleton /> : !data.length ? <EmptyState icon={<Globe size={22} />} title="No failing requests">4xx, 5xx and network failures from fetch / XHR are listed here.</EmptyState> :
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
