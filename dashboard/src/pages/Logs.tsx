import { useEffect, useMemo, useState } from 'react';
import { LogFix } from './FixAgent';
import { ChevronRight, Radio, ScrollText, Search, X } from 'lucide-react';
import { useLogs, useServices } from '../api/hooks';
import type { LogRecord } from '../api/contract';
import { useProject } from '../lib/project';
import { useTime, type TimeRange } from '../lib/time';
import { navigate, pageHref, useRoute, useSetParams } from '../lib/router';
import { Badge, Card, EmptyState, ErrorState, Mono, Skeleton, Switch, useDebounced } from '../ui/kit';
import { useSentinel } from '../ui/useSentinel';
import { RowsSkeleton } from './common';
import { cn, fmtTime } from '../lib/format';

import { FilterBar } from '../ui/FilterBar';
import { AddToDashboard, withFilters } from '../dashboards/AddToDashboard';
import { currentFilters } from '../lib/filters';
import type { Filter } from '../api/contract';
import { RowActions } from '../ui/RowActions';
import { logConditions } from '../lib/rowFilters';
import { AttributeTable } from './EventAttributes';
import { Linkified } from '../ui/ExternalUrl';
const SEV = [
  { label: 'All', min: 0 }, { label: 'Debug+', min: 5 }, { label: 'Info+', min: 9 }, { label: 'Warn+', min: 13 }, { label: 'Error+', min: 17 },
];
export function sevInfo(n: number): { name: string; color: string } {
  if (n >= 21) return { name: 'FATAL', color: 'var(--s5)' };
  if (n >= 17) return { name: 'ERROR', color: 'var(--s8)' };
  if (n >= 13) return { name: 'WARN', color: 'var(--warn)' };
  if (n >= 9) return { name: 'INFO', color: 'var(--s1)' };
  if (n >= 5) return { name: 'DEBUG', color: 'var(--faint)' };
  return { name: 'TRACE', color: 'var(--faint)' };
}

function LogRow({ l, open, toggle, traceHref }: { l: LogRecord; open: boolean; toggle: () => void; traceHref: (id: string, at: string) => void }) {
  const s = sevInfo(l.severityNumber);
  const conditions = useMemo(() => logConditions(l), [l]);
  return (
    <div className={cn('border-b border-line/50', open && 'bg-[var(--hl)]')}>
      <div onClick={toggle} className="group flex min-h-[28px] cursor-pointer flex-wrap items-start gap-x-2.5 gap-y-0.5 px-3 py-[5px] md:flex-nowrap hover:bg-[var(--hl)]" style={{ boxShadow: `inset 2px 0 0 ${s.color}` }}>
        <ChevronRight size={12} className={cn('mt-[3px] shrink-0 text-faint transition-transform', open && 'rotate-90')} />
        <span className="w-[60px] shrink-0 font-mono text-[11.5px] text-faint tnum md:w-[84px]">{fmtTime(l.ts)}</span>
        <span className="w-[50px] shrink-0 font-mono text-[11px] font-semibold" style={{ color: s.color }}>{s.name}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted md:w-[110px] md:flex-none md:shrink-0">{l.service}</span>
        <span className={cn('order-last min-w-0 basis-full pl-[22px] font-mono text-[12px] leading-[1.5] md:order-none md:basis-auto md:flex-1 md:pl-0', open ? 'whitespace-pre-wrap break-words' : 'truncate')}><Linkified text={l.body} /></span>
        {l.traceId && <button onClick={(e) => { e.stopPropagation(); traceHref(l.traceId!, l.ts); }} className="hidden shrink-0 font-mono text-[11px] text-faint hover:text-accent cursor-pointer sm:block" title="Open trace">{l.traceId.slice(0, 8)}</button>}
        <RowActions scope="logs" conditions={conditions} className="-my-0.5" />
      </div>
      {open && (
        <div className="grid grid-cols-1 gap-3 px-3 pb-3 pt-1 md:px-9 lg:grid-cols-2">
          <div><h4 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">Attributes</h4><AttributeTable scope="logs" rows={Object.entries(l.attributes).map(([k, v]) => [`attributes.${k}`, typeof v === 'object' ? JSON.stringify(v) : String(v)])} /></div>
          <div><h4 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">Resource</h4><AttributeTable scope="logs" rows={Object.entries(l.resource).map(([k, v]) => [`resource.${k}`, typeof v === 'object' ? JSON.stringify(v) : String(v)])} />
            {(l.traceId || l.spanId) && <div className="mt-2 font-mono text-[11px] text-faint">trace {l.traceId} · span {l.spanId}</div>}</div>
          {l.severityNumber >= 17 && <div className="lg:col-span-2"><LogFix log={l} /></div>}
        </div>
      )}
    </div>
  );
}

export function LogsPage() {
  const { project } = useProject(); const { range } = useTime(); const route = useRoute(); const set = useSetParams();
  const sev = Number(route.params.get('sev') ?? 0), service = route.params.get('service') ?? '', traceId = route.params.get('traceId') ?? '';
  const [qIn, setQIn] = useState(route.params.get('q') ?? '');
  const q = useDebounced(qIn, 300);
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(Date.now());
  useEffect(() => { if (!live) return; const t = setInterval(() => setTick(Date.now()), 3000); return () => clearInterval(t); }, [live]);
  const eff: TimeRange = useMemo(() => live ? { ...range, from: new Date(tick - range.ms).toISOString(), to: new Date(tick + 1000).toISOString() } : range, [live, tick, range]);
  const services = useServices(project.id, range);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const logs = useLogs(project.id, eff, { severity: sev || undefined, service: service || undefined, traceId: traceId || undefined, q: q || undefined }, false);
  const rows = useMemo(() => logs.data?.pages.flatMap((p) => p.logs) ?? [], [logs.data]);
  const sentinel = useSentinel(() => { if (logs.hasNextPage && !logs.isFetchingNextPage) void logs.fetchNextPage(); }, !!logs.hasNextPage);
  if (logs.isError) return <ErrorState error={logs.error} retry={() => logs.refetch()} />;
  return (
    <div className="space-y-3">
      <FilterBar scope="logs" />
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-line bg-[var(--hl)] p-0.5">{SEV.map((s) => (
          <button key={s.label} onClick={() => set({ sev: s.min ? String(s.min) : null })} className={cn('rounded-md px-2.5 py-1 text-[12px] font-medium transition-all cursor-pointer', sev === s.min ? 'bg-[var(--raised)] text-fg shadow-sm' : 'text-muted hover:text-fg')}>{s.label}</button>))}</div>
        <select className="field !w-44" value={service} onChange={(e) => set({ service: e.target.value || null })}><option value="">All services</option>{services.data?.map((s) => <option key={s.service}>{s.service}</option>)}</select>
        <div className="relative w-full sm:w-72"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" /><input className="field !pl-8" placeholder="Search log body…" value={qIn} onChange={(e) => setQIn(e.target.value)} onBlur={() => set({ q: qIn || null })} /></div>
        {traceId && <Badge tone="accent" className="!py-1 !text-[12px]">trace <Mono>{traceId.slice(0, 12)}</Mono><button onClick={() => set({ traceId: null })} className="cursor-pointer"><X size={12} /></button></Badge>}
        <div className="ml-auto flex items-center gap-2"><AddToDashboard label={false} tile={() => {
          const filters: Filter[] = [...currentFilters('logs'), ...(sev ? [{ field: 'severityNumber', op: 'gte' as const, value: String(sev) }] : []), ...(service ? [{ field: 'service', op: 'eq' as const, value: service }] : [])];
          return { viz: 'bars', measures: [withFilters({ source: 'logs', agg: 'count', label: sev >= 17 ? 'Error logs' : 'Logs', unit: 'count', ...(sev >= 17 ? { better: 'down' as const } : {}) }, filters)] };
        }} />{live && <i className="h-2 w-2 rounded-full bg-good pulse-dot" />}<Switch checked={live} onChange={setLive} label={<span className="inline-flex items-center gap-1"><Radio size={13} />Live tail</span>} /></div>
      </div>
      <Card className="overflow-hidden">
        {logs.isPending ? <RowsSkeleton n={14} /> : rows.length === 0 ? <EmptyState icon={<ScrollText size={22} />} title="No logs match">Send OTLP logs to your ingest endpoint, or loosen the filters.</EmptyState> : (
          <div>{rows.map((l) => <LogRow key={l.id} l={l} open={open.has(l.id)} toggle={() => setOpen((o) => { const n = new Set(o); n.has(l.id) ? n.delete(l.id) : n.add(l.id); return n; })} traceHref={(id, at) => navigate(pageHref(project.id, `traces/${id}`, route.params, { at }))} />)}
            <div ref={sentinel} className="p-3 text-center text-[12px] text-faint">{logs.isFetchingNextPage ? <Skeleton className="mx-auto h-4 w-32" /> : logs.hasNextPage ? '' : 'End of logs'}</div></div>)}
      </Card>
    </div>
  );
}
