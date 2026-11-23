import { Bug, EyeOff, ExternalLink } from 'lucide-react';
import { useErrors, useEvents, useSuppressions } from '../api/hooks';
import type { Filter, ErrorGroup, ErrorSuppressionInput, StackFrame } from '../api/contract';
import { SuppressDialog, SuppressionRules, suggestRule } from './ErrorSuppressions';
import { useProject } from '../lib/project';
import { useTime } from '../lib/time';
import { useRoute, useSetParams } from '../lib/router';
import { useState } from 'react';
import { Badge, Button, Card, Drawer, EmptyState, ErrorState, Mono, Skeleton } from '../ui/kit';
import { Sparkline } from '../charts/Sparkline';
import { RowsSkeleton, TableHead, Dl } from './common';
import { fmtNum, fmtDateTime, relTime, shortId } from '../lib/format';
import { UserCell } from '../ui/EventColumns';
import { eventTitle } from '../lib/events';

import { FilterBar } from '../ui/FilterBar';
import { AddToDashboard, withFilters, type TileDraft } from '../dashboards/AddToDashboard';
import { currentFilters } from '../lib/filters';
import { BUILTIN } from '../dashboards/measures';
import { RowActions } from '../ui/RowActions';
import { errorGroupConditions } from '../lib/rowFilters';
import { SourcemapsMissing } from './SourcemapsMissing';
const COLS = 'grid-cols-[minmax(260px,3fr)_90px_70px_80px_130px_110px_110px]';

export function Stack({ stack }: { stack: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-line bg-[color-mix(in_srgb,var(--bg)_60%,black)] p-3 font-mono text-[11.5px] leading-[1.7]">
      {stack.split('\n').map((line, i) => {
        const m = line.match(/^(\s*at\s+)(.*?)(?:\s+\()?((?:https?:\/\/|\/|file:|webpack:|[\w@.~-]+\/)[^)\s]*?)(?::(\d+)(?::(\d+))?)?\)?\s*$/);
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

/** Source lines around a mapped frame, the failing line highlighted. */
function CodeContext({ frame }: { frame: StackFrame }) {
  const c = frame.context;
  if (!c) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="border-b border-line bg-[var(--hl)] px-3 py-1.5 font-mono text-[11.5px] text-muted">{frame.file}:{frame.line}</div>
      <pre className="overflow-x-auto py-1.5 font-mono text-[11.5px] leading-[1.7]">
        {c.lines.map((text, i) => {
          const n = c.start + i, hit = n === frame.line;
          return (
            <div key={n} className={hit ? 'flex bg-bad/10' : 'flex'}>
              <span className={'w-12 shrink-0 select-none pr-3 text-right tnum ' + (hit ? 'text-bad' : 'text-faint')}>{n}</span>
              <span className={hit ? 'text-fg' : 'text-muted'}>{text || ' '}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function StackSection({ g }: { g: ErrorGroup }) {
  const [minified, setMinified] = useState(false);
  const heading = <h4 className="text-[12px] font-semibold uppercase tracking-wider text-faint">Stack trace</h4>;
  if (!g.sampleStack) return <div><div className="mb-2">{heading}</div><p className="text-[13px] text-muted">No stack captured.</p></div>;
  const code = !minified ? (g.stackFrames ?? []).filter((f) => f.mapped && f.context && !/node_modules/.test(f.file)).slice(0, 3) : [];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        {heading}
        {g.minifiedStack && <Button size="sm" variant="ghost" onClick={() => setMinified(!minified)}>{minified ? 'Show original' : 'Show minified'}</Button>}
      </div>
      <Stack stack={minified && g.minifiedStack ? g.minifiedStack : g.sampleStack} />
      {g.missingSourcemaps && <SourcemapsMissing missing={g.missingSourcemaps} />}
      {code.map((f, i) => <CodeContext key={i} frame={f} />)}
    </div>
  );
}

function ErrorDrawer({ g, onClose, onSuppress }: { g: ErrorGroup | null; onClose: () => void; onSuppress: (g: ErrorGroup) => void }) {
  const { project } = useProject(); const { range } = useTime();
  const occ = useEvents(project.id, range, { type: 'error', fingerprint: g?.fingerprint }, !!g, 20);
  const events = occ.data?.pages[0]?.events ?? [];
  return (
    <Drawer open={!!g} onClose={onClose} width={720} title={<span className="flex items-center gap-2"><Bug size={16} className="text-bad" />Error details</span>}>
      {g && (
        <div className="space-y-5 p-5">
          <div><h2 className="break-words text-[15px] font-semibold leading-snug">{g.message}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">{g.kind && <Badge tone="bad">{g.kind}</Badge>}<Mono className="text-faint">{shortId(g.fingerprint, 12)}</Mono>
              <span className="ml-auto">{g.suppressedBy ? <span className="inline-flex items-center gap-1.5 text-[12px] text-muted"><EyeOff size={13} />Suppressed: new ones are dropped</span>
                : <Button size="sm" onClick={() => onSuppress(g)} title="Drop errors like this one when they arrive"><EyeOff size={13} />Suppress errors like this</Button>}</span></div></div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[['Events', fmtNum(g.count)], ['Sessions', fmtNum(g.sessions)], ['First seen', relTime(g.firstSeen)], ['Last seen', relTime(g.lastSeen)]].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-line bg-[var(--hl)] p-3"><div className="text-[11px] text-faint">{k}</div><div className="mt-0.5 text-[16px] font-semibold tnum">{v}</div></div>))}</div>
          <StackSection g={g} />
          <div className="flex justify-end"><AddToDashboard tile={() => errorsTile(currentFilters('events'), g)} /></div>
          <Dl rows={[['Sample URL', g.sampleUrl && <a className="inline-flex items-center gap-1 font-mono text-[12px] text-accent hover:underline" href={g.sampleUrl} target="_blank" rel="noreferrer">{g.sampleUrl}<ExternalLink size={11} /></a>], ['Source', g.source && <Mono>{g.source}</Mono>]]} />
          <div><h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-faint">Recent occurrences</h4>
            {occ.isPending ? <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}</div> : (
              <div className="divide-y divide-line/60 rounded-xl border border-line">{events.map((e) => (
                <div key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-[12.5px] sm:flex-nowrap"><span className="w-28 shrink-0 tnum text-faint">{fmtDateTime(e.ts)}</span><span className="order-last min-w-0 basis-full truncate font-mono text-[11.5px] text-muted sm:order-none sm:basis-auto sm:flex-1">{e.path ?? eventTitle(e)}</span>
                  <span className="text-faint">{e.browser}</span><UserCell e={e} className="ml-auto w-[132px] shrink-0 justify-end sm:ml-0" /></div>))}</div>)}</div>
        </div>
      )}
    </Drawer>
  );
}

/** The built-in JS errors measure, narrowed by the page's filters (and one error group's fingerprint, if given). */
function errorsTile(pageFilters: Filter[], g?: ErrorGroup): TileDraft {
  const m = BUILTIN.find((d) => d.id === 'errors')!.measure;
  const filters = [...(m.filters ?? []), ...pageFilters, ...(g ? [{ field: 'fingerprint', op: 'eq' as const, value: g.fingerprint }] : [])];
  const label = g ? (g.message.length > 80 ? `${g.message.slice(0, 79)}…` : g.message) : 'JS errors';
  return { viz: 'bars', measures: [withFilters({ ...m, label, unit: 'count', better: 'down' }, filters)] };
}

export function ErrorsPage() {
  const { project } = useProject(); const { range } = useTime(); const route = useRoute(); const set = useSetParams();
  const { data: all, isPending, isError, error, refetch } = useErrors(project.id, range);
  const rules = useSuppressions(project.id);
  const showSuppressed = route.params.get('suppressed') === '1';
  const hidden = all?.filter((g) => g.suppressedBy).length ?? 0;
  const data = all && (showSuppressed ? all : all.filter((g) => !g.suppressedBy));
  const sel = all?.find((g) => g.fingerprint === route.params.get('fp')) ?? null;
  const [suppress, setSuppress] = useState<ErrorSuppressionInput | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  if (isError) return <ErrorState error={error} retry={() => refetch()} />;
  return (
    <>
      <FilterBar scope="events" className="mb-3" />
      <div className="mb-3 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-[12.5px] text-muted">
        <AddToDashboard tile={() => errorsTile(currentFilters('events'))} />
        {hidden > 0 && <span>{hidden === 1 ? '1 suppressed group' : `${fmtNum(hidden)} suppressed groups`} {showSuppressed ? 'shown' : 'hidden'} ·{' '}
          <button className="cursor-pointer text-accent hover:underline" onClick={() => set({ suppressed: showSuppressed ? null : '1' }, false)}>{showSuppressed ? 'Hide' : 'Show'}</button></span>}
        <button className="inline-flex cursor-pointer items-center gap-1.5 hover:text-fg" onClick={() => setRulesOpen(true)}><EyeOff size={13} />Suppressed errors{rules.data?.length ? ` (${rules.data.length})` : ''}</button>
      </div>
      <Card className="@container overflow-x-auto">
        <div className="min-w-[960px]">
          <TableHead className={COLS} cols={['Error', 'Kind', ['Events', 'text-right'], ['Sessions', 'text-right'], 'Trend', ['First seen', 'text-right'], ['Last seen', 'text-right']]} />
          {isPending || !data ? <RowsSkeleton /> : !data.length ? <EmptyState pinned icon={<Bug size={22} />} title="No errors in this range">Nothing broke. Enjoy it. Uncaught exceptions, rejections and failed resources show up here.</EmptyState> :
            data.map((g) => (
              <div key={g.fingerprint} role="button" tabIndex={0} onClick={() => set({ fp: g.fingerprint }, false)} onKeyDown={(e) => { if (e.key === 'Enter') set({ fp: g.fingerprint }, false); }} className={`group grid w-full ${COLS} cursor-pointer items-center gap-4 border-b border-line/60 px-4 py-3 text-left text-[13px] transition-colors hover:bg-[var(--hl)] ${g.suppressedBy ? 'opacity-50' : ''}`}>
                <div className="flex min-w-0 items-center gap-2"><div className="min-w-0 flex-1"><div className="flex items-center gap-1.5 truncate font-medium">{g.suppressedBy && <EyeOff size={12} className="shrink-0 text-faint" aria-label="Suppressed" />}<span className="truncate">{g.message}</span></div><div className="truncate font-mono text-[11.5px] text-faint">{g.source ?? g.sampleUrl}</div></div><RowActions scope="events" conditions={errorGroupConditions(g)} /></div>
                <div>{g.kind && <Badge tone={g.kind === 'rejection' ? 'warn' : 'bad'}>{g.kind}</Badge>}</div>
                <div className="text-right tnum font-medium">{fmtNum(g.count)}</div>
                <div className="text-right tnum text-muted">{fmtNum(g.sessions)}</div>
                <div className="w-[110px]"><Sparkline data={g.series} color="var(--s8)" height={26} /></div>
                <div className="text-right text-[12px] text-faint">{relTime(g.firstSeen)}</div>
                <div className="text-right text-[12px] text-faint">{relTime(g.lastSeen)}</div>
              </div>))}
        </div>
      </Card>
      <ErrorDrawer g={sel} onClose={() => set({ fp: null }, false)} onSuppress={(g) => setSuppress(suggestRule(g))} />
      <SuppressionRules open={rulesOpen} onClose={() => setRulesOpen(false)} onAdd={() => { setRulesOpen(false); setSuppress({}); }} />
      <SuppressDialog open={!!suppress} initial={suppress} groups={all ?? []} onClose={() => setSuppress(null)} />
    </>
  );
}
