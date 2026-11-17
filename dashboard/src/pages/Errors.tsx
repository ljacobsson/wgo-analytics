import { Bug, ExternalLink } from 'lucide-react';
import { useErrors, useEvents } from '../api/hooks';
import type { ErrorGroup } from '../api/contract';
import { useProject } from '../lib/project';
import { useTime } from '../lib/time';
import { useRoute, useSetParams } from '../lib/router';
import { Badge, Card, Drawer, EmptyState, ErrorState, Mono, Skeleton } from '../ui/kit';
import { Sparkline } from '../charts/Sparkline';
import { RowsSkeleton, TableHead, Dl } from './common';
import { fmtNum, fmtDateTime, relTime, shortId } from '../lib/format';
import { UserCell } from '../ui/EventColumns';
import { eventTitle } from '../lib/events';

import { FilterBar } from '../ui/FilterBar';
import { RowActions } from '../ui/RowActions';
import { errorGroupConditions } from '../lib/rowFilters';
const COLS = 'grid-cols-[minmax(260px,3fr)_90px_70px_80px_130px_110px_110px]';

export function Stack({ stack }: { stack: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-line bg-[color-mix(in_srgb,var(--bg)_60%,black)] p-3 font-mono text-[11.5px] leading-[1.7]">
      {stack.split('\n').map((line, i) => {
        const m = line.match(/^(\s*at\s+)(.*?)(?:\s+\()?((?:https?:\/\/|\/|file:|webpack:)[^)\s]*?)(?::(\d+)(?::(\d+))?)?\)?\s*$/);
        if (!m) return <div key={i} className={i === 0 ? 'text-bad font-semibold' : 'text-muted'}>{line}</div>;
        const lib = /node_modules|vendor|chunk-/.test(m[3]);
        return (
          <div key={i} className={lib ? 'opacity-55' : ''}>
            <span className="text-faint">{m[1]}</span><span className="tok-t">{m[2] || '<anonymous>'}</span>
            <span className="text-faint"> (</span><span className="tok-a">{m[3]}</span>{m[4] && <><span className="text-faint">:</span><span className="tok-n">{m[4]}</span></>}{m[5] && <><span className="text-faint">:</span><span className="tok-n">{m[5]}</span></>}<span className="text-faint">)</span>
          </div>
        );
      })}
    </pre>
  );
}

function ErrorDrawer({ g, onClose }: { g: ErrorGroup | null; onClose: () => void }) {
  const { project } = useProject(); const { range } = useTime();
  const occ = useEvents(project.id, range, { type: 'error', fingerprint: g?.fingerprint }, !!g, 20);
  const events = occ.data?.pages[0]?.events ?? [];
  return (
    <Drawer open={!!g} onClose={onClose} width={720} title={<span className="flex items-center gap-2"><Bug size={16} className="text-bad" />Error details</span>}>
      {g && (
        <div className="space-y-5 p-5">
          <div><h2 className="break-words text-[15px] font-semibold leading-snug">{g.message}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">{g.kind && <Badge tone="bad">{g.kind}</Badge>}<Mono className="text-faint">{shortId(g.fingerprint, 12)}</Mono></div></div>
          <div className="grid grid-cols-4 gap-3">{[['Events', fmtNum(g.count)], ['Sessions', fmtNum(g.sessions)], ['First seen', relTime(g.firstSeen)], ['Last seen', relTime(g.lastSeen)]].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-line bg-[var(--hl)] p-3"><div className="text-[11px] text-faint">{k}</div><div className="mt-0.5 text-[16px] font-semibold tnum">{v}</div></div>))}</div>
          <div><h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-faint">Stack trace</h4>{g.sampleStack ? <Stack stack={g.sampleStack} /> : <p className="text-[13px] text-muted">No stack captured.</p>}</div>
          <Dl rows={[['Sample URL', g.sampleUrl && <a className="inline-flex items-center gap-1 font-mono text-[12px] text-accent hover:underline" href={g.sampleUrl} target="_blank" rel="noreferrer">{g.sampleUrl}<ExternalLink size={11} /></a>], ['Source', g.source && <Mono>{g.source}</Mono>]]} />
          <div><h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-faint">Recent occurrences</h4>
            {occ.isPending ? <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}</div> : (
              <div className="divide-y divide-line/60 rounded-xl border border-line">{events.map((e) => (
                <div key={e.id} className="flex items-center gap-3 px-3 py-2 text-[12.5px]"><span className="w-28 shrink-0 tnum text-faint">{fmtDateTime(e.ts)}</span><span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{e.path ?? eventTitle(e)}</span>
                  <span className="text-faint">{e.browser}</span><UserCell e={e} className="w-[132px] shrink-0 justify-end" /></div>))}</div>)}</div>
        </div>
      )}
    </Drawer>
  );
}

export function ErrorsPage() {
  const { project } = useProject(); const { range } = useTime(); const route = useRoute(); const set = useSetParams();
  const { data, isPending, isError, error, refetch } = useErrors(project.id, range);
  const sel = data?.find((g) => g.fingerprint === route.params.get('fp')) ?? null;
  if (isError) return <ErrorState error={error} retry={() => refetch()} />;
  return (
    <>
      <FilterBar scope="events" className="mb-4" />
      <Card className="overflow-x-auto">
        <div className="min-w-[960px]">
          <TableHead className={COLS} cols={['Error', 'Kind', ['Events', 'text-right'], ['Sessions', 'text-right'], 'Trend', ['First seen', 'text-right'], ['Last seen', 'text-right']]} />
          {isPending ? <RowsSkeleton /> : !data.length ? <EmptyState icon={<Bug size={22} />} title="No errors in this range">Nothing broke. Enjoy it. Uncaught exceptions, rejections and failed resources show up here.</EmptyState> :
            data.map((g) => (
              <div key={g.fingerprint} role="button" tabIndex={0} onClick={() => set({ fp: g.fingerprint }, false)} onKeyDown={(e) => { if (e.key === 'Enter') set({ fp: g.fingerprint }, false); }} className={`group grid w-full ${COLS} cursor-pointer items-center gap-4 border-b border-line/60 px-4 py-3 text-left text-[13px] transition-colors hover:bg-[var(--hl)]`}>
                <div className="flex min-w-0 items-center gap-2"><div className="min-w-0 flex-1"><div className="truncate font-medium">{g.message}</div><div className="truncate font-mono text-[11.5px] text-faint">{g.source ?? g.sampleUrl}</div></div><RowActions scope="events" conditions={errorGroupConditions(g)} /></div>
                <div>{g.kind && <Badge tone={g.kind === 'rejection' ? 'warn' : 'bad'}>{g.kind}</Badge>}</div>
                <div className="text-right tnum font-medium">{fmtNum(g.count)}</div>
                <div className="text-right tnum text-muted">{fmtNum(g.sessions)}</div>
                <div className="w-[110px]"><Sparkline data={g.series} color="var(--s8)" height={26} /></div>
                <div className="text-right text-[12px] text-faint">{relTime(g.firstSeen)}</div>
                <div className="text-right text-[12px] text-faint">{relTime(g.lastSeen)}</div>
              </div>))}
        </div>
      </Card>
      <ErrorDrawer g={sel} onClose={() => set({ fp: null }, false)} />
    </>
  );
}
