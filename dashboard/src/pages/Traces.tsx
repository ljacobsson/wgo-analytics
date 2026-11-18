import { InfoTip } from '../ui/InfoTip';
import { useMemo, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, ScrollText, Search, Waypoints } from 'lucide-react';
import { useServices, useTrace, useTraces } from '../api/hooks';
import type { Span, TraceSummary } from '../api/contract';
import { useProject } from '../lib/project';
import { useTime } from '../lib/time';
import { navigate, pageHref, useRoute, useSetParams } from '../lib/router';
import { Badge, Button, Card, CardHeader, CopyButton, EmptyState, ErrorState, Mono, Skeleton, Switch, useDebounced } from '../ui/kit';
import { Scatter } from '../charts/Scatter';
import { Dl, JsonView, RowsSkeleton, TableHead } from './common';
import { fmtMs, fmtNum, fmtTime, relTime, cn } from '../lib/format';

import { FilterBar } from '../ui/FilterBar';
import { RowActions } from '../ui/RowActions';
import { spanConditions, traceConditions } from '../lib/rowFilters';
export function serviceColor(services: string[], s: string) {
  const i = [...new Set(services)].sort().indexOf(s);
  return `var(--s${(Math.max(0, i) % 8) + 1})`;
}
const KIND = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];

// ---------- list ----------
const COLS = 'grid-cols-[minmax(220px,2.2fr)_140px_120px_minmax(160px,1.5fr)_70px_70px]';
function TraceList() {
  const { project } = useProject(); const { range } = useTime(); const route = useRoute(); const set = useSetParams();
  const service = route.params.get('service') ?? '', errorsOnly = route.params.get('errors') === '1';
  const [minD, setMinD] = useState(route.params.get('min') ?? '');
  const [qIn, setQIn] = useState(route.params.get('q') ?? '');
  const minDd = useDebounced(minD, 400), q = useDebounced(qIn, 300);
  const services = useServices(project.id, range);
  const traces = useTraces(project.id, range, { service: service || undefined, minDurationMs: minDd ? Number(minDd) : undefined, errorsOnly, q: q || undefined });
  const names = useMemo(() => (services.data ?? []).map((s) => s.service), [services.data]);
  const maxD = Math.max(1, ...(traces.data ?? []).map((t) => t.durationMs));
  // `at` tells the API which day's spans to look in
  const open = (t: TraceSummary) => navigate(pageHref(project.id, `traces/${t.traceId}`, route.params, { at: t.start }));
  const dots = useMemo(() => (traces.data ?? []).map((t) => ({ id: t.traceId, t: Date.parse(t.start), v: t.durationMs, bad: t.errorCount > 0, label: `${t.rootName}` })), [traces.data]);
  if (traces.isError) return <ErrorState error={traces.error} retry={() => traces.refetch()} />;
  return (
    <div className="space-y-4">
      <FilterBar scope="spans" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card>
          <CardHeader title="Services" sub="click to filter" />
          {services.isPending ? <div className="space-y-2 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8" />)}</div> : (
            <div className="overflow-x-auto px-2 pb-2 text-[12.5px]"><div className="min-w-[400px]">
              <div className="grid grid-cols-[minmax(110px,1fr)_60px_60px_64px_64px] gap-2 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-faint"><span>Service</span><span className="text-right">Spans</span><span className="text-right">Err</span><span className="inline-flex items-center justify-end gap-1">p50<InfoTip align="end" label="What is p50?"><b className="text-fg">p50, the median.</b> Half of this service’s spans were faster than this, half slower.</InfoTip></span><span className="inline-flex items-center justify-end gap-1">p95<InfoTip align="end" label="What is p95?"><b className="text-fg">p95, the 95th percentile.</b> 95% of spans were faster than this. It shows the slow tail your unluckiest users hit, which an average hides.</InfoTip></span></div>
              {services.data!.map((s) => (
                <button key={s.service} onClick={() => set({ service: service === s.service ? null : s.service })} className={cn('grid w-full grid-cols-[minmax(110px,1fr)_60px_60px_64px_64px] items-center gap-2 rounded-md px-2 py-1.5 text-left tnum transition-colors hover:bg-[var(--hl)] cursor-pointer', service === s.service && 'bg-accent/12')}>
                  <span className="flex min-w-0 items-center gap-2 font-sans font-medium"><i className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: serviceColor(names, s.service) }} /><span className="truncate" title={s.service}>{s.service}</span></span>
                  <span className="text-right text-muted">{fmtNum(s.spans)}</span><span className={cn('text-right', s.errors ? 'text-bad' : 'text-faint')}>{fmtNum(s.errors)}</span>
                  <span className="text-right text-muted">{fmtMs(s.p50Ms)}</span><span className="text-right text-muted">{fmtMs(s.p95Ms)}</span></button>))}
            </div></div>)}
        </Card>
        <Card>
          <CardHeader title="Trace duration" sub="each dot is a trace · red has errors" />
          <div className="px-3 pb-3">{traces.isPending ? <Skeleton className="h-[150px]" /> : <Scatter dots={dots} from={dots.length ? Math.min(...dots.map((d) => d.t)) : Date.parse(range.from)} to={dots.length ? Math.max(...dots.map((d) => d.t)) + 1000 : Date.parse(range.to)} onSelect={(id) => open(traces.data!.find((t) => t.traceId === id)!)} />}</div>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select className="field !w-44" value={service} onChange={(e) => set({ service: e.target.value || null })}><option value="">All services</option>{names.map((n) => <option key={n}>{n}</option>)}</select>
        <input className="field !w-40" type="number" min={0} placeholder="Min duration (ms)" value={minD} onChange={(e) => setMinD(e.target.value)} onBlur={() => set({ min: minD || null })} />
        <Switch checked={errorsOnly} onChange={(b) => set({ errors: b ? '1' : null })} label="Errors only" />
        <div className="relative w-full sm:ml-auto sm:w-64"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" /><input className="field !pl-8" placeholder="Search root span…" value={qIn} onChange={(e) => setQIn(e.target.value)} onBlur={() => set({ q: qIn || null })} /></div>
      </div>
      <Card className="@container overflow-x-auto">
        <div className="min-w-[860px]">
          <TableHead className={COLS} cols={['Root span', 'Service', 'Started', 'Duration', ['Spans', 'text-right'], ['Errors', 'text-right']]} />
          {traces.isPending ? <RowsSkeleton /> : !traces.data.length ? <EmptyState pinned icon={<Waypoints size={22} />} title="No traces found" action={<Button onClick={() => navigate(pageHref(project.id, 'settings', route.params))}>OpenTelemetry setup</Button>}>Send OTLP traces to your ingest endpoint, or relax the filters.</EmptyState> :
            traces.data.map((t) => (
              <div key={t.traceId} role="button" tabIndex={0} onClick={() => open(t)} onKeyDown={(e) => { if (e.key === 'Enter') open(t); }} className={`group grid w-full ${COLS} cursor-pointer items-center gap-4 border-b border-line/60 px-4 py-2.5 text-left text-[13px] transition-colors hover:bg-[var(--hl)]`}>
                <div className="flex min-w-0 items-center gap-2"><div className="min-w-0 flex-1"><div className="truncate font-medium">{t.rootName}</div><Mono className="text-faint">{t.traceId.slice(0, 16)}</Mono></div><RowActions scope="spans" conditions={traceConditions(t)} /></div>
                <span className="flex items-center gap-2"><i className="h-2 w-2 rounded-[3px]" style={{ background: serviceColor(names, t.service) }} />{t.service}</span>
                <span className="text-[12px] text-faint tnum">{relTime(t.start)}</span>
                <div className="flex items-center gap-2.5"><span className="w-14 tnum font-medium">{fmtMs(t.durationMs)}</span><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--hl)]"><div className="h-full rounded-full" style={{ width: `${Math.max(2, (t.durationMs / maxD) * 100)}%`, background: t.errorCount ? 'var(--s8)' : 'var(--s1)' }} /></div></div>
                <span className="text-right tnum text-muted">{t.spanCount}</span>
                <span className="text-right">{t.errorCount ? <Badge tone="bad">{t.errorCount}</Badge> : <span className="text-faint">–</span>}</span>
              </div>))}
        </div>
      </Card>
    </div>
  );
}

// ---------- waterfall ----------
interface Node { span: Span; depth: number; children: Node[] }
function buildTree(spans: Span[]): Node[] {
  const byId = new Map(spans.map((s) => [s.spanId, { span: s, depth: 0, children: [] as Node[] }]));
  const roots: Node[] = [];
  for (const n of byId.values()) {
    const p = n.span.parentSpanId ? byId.get(n.span.parentSpanId) : undefined;
    (p ? p.children : roots).push(n);
  }
  const sortRec = (list: Node[], d: number) => { list.sort((a, b) => Date.parse(a.span.start) - Date.parse(b.span.start)); list.forEach((n) => { n.depth = d; sortRec(n.children, d + 1); }); };
  sortRec(roots, 0);
  return roots;
}

function Waterfall({ spans }: { spans: Span[] }) {
  const { project } = useProject(); const route = useRoute();
  const [selId, setSelId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const t0 = Math.min(...spans.map((s) => Date.parse(s.start))), t1 = Math.max(...spans.map((s) => Date.parse(s.end)));
  const total = Math.max(1, t1 - t0);
  const svc = useMemo(() => [...new Set(spans.map((s) => s.service))].sort(), [spans]);
  const rows = useMemo(() => {
    const out: Node[] = [];
    const walk = (l: Node[]) => l.forEach((n) => { out.push(n); if (!collapsed.has(n.span.spanId)) walk(n.children); });
    walk(buildTree(spans)); return out;
  }, [spans, collapsed]);
  const sel = spans.find((s) => s.spanId === selId) ?? rows[0]?.span;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
      <Card className="flex max-h-[calc(100dvh-180px)] min-h-[320px] flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-2.5"><div className="flex flex-wrap gap-x-4 gap-y-1">{svc.map((s) => <span key={s} className="inline-flex items-center gap-1.5 text-[12px] text-muted"><i className="h-2 w-2 rounded-[3px]" style={{ background: serviceColor(svc, s) }} />{s}</span>)}</div>
          <span className="shrink-0 whitespace-nowrap tnum text-[12px] text-muted">{spans.length} spans · {fmtMs(total)}</span></div>
        <div className="grid shrink-0 grid-cols-[minmax(130px,38%)_1fr] border-b border-line md:grid-cols-[300px_1fr] text-[10.5px] text-faint">
          <div className="px-4 py-1.5 font-semibold uppercase tracking-wider">Span</div>
          <div className="relative h-7 mr-4">{ticks.map((k) => <span key={k} className={cn('absolute top-1.5 tnum', (k === 0.25 || k === 0.75) && 'hidden md:inline')} style={{ left: `${k * 100}%`, transform: k === 1 ? 'translateX(-100%)' : k === 0 ? undefined : 'translateX(-50%)' }}>{fmtMs(total * k)}</span>)}</div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((n) => {
            const s = n.span, left = ((Date.parse(s.start) - t0) / total) * 100, width = Math.max(0.35, (s.durationMs / total) * 100), err = s.statusCode === 2;
            const color = err ? 'var(--s8)' : serviceColor(svc, s.service), active = sel?.spanId === s.spanId;
            const labelInside = width > 22;
            return (
              <div key={s.spanId} onClick={() => setSelId(s.spanId)} className={cn('grid h-8 cursor-pointer grid-cols-[minmax(130px,38%)_1fr] items-center md:grid-cols-[300px_1fr] transition-colors hover:bg-[var(--hl)]', active && 'bg-accent/10')}>
                <div className="flex min-w-0 items-center gap-1 px-4" style={{ paddingLeft: 16 + n.depth * 14 }}>
                  {n.children.length ? <button onClick={(e) => { e.stopPropagation(); setCollapsed((c) => { const x = new Set(c); x.has(s.spanId) ? x.delete(s.spanId) : x.add(s.spanId); return x; }); }} className="text-faint hover:text-fg cursor-pointer">{collapsed.has(s.spanId) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button> : <i className="w-[13px]" />}
                  <span className="truncate text-[12.5px]" title={s.name}>{s.name}</span>
                </div>
                <div className="relative mr-4 h-full">
                  {ticks.map((k) => <i key={k} className="absolute inset-y-0 w-px bg-line/60" style={{ left: `${k * 100}%` }} />)}
                  <div className="absolute top-1/2 h-4 -translate-y-1/2 rounded-[4px]" style={{ left: `${left}%`, width: `${width}%`, background: color, boxShadow: active ? '0 0 0 2px var(--fg)' : undefined, opacity: active ? 1 : 0.9 }}>
                    {labelInside && <span className="absolute inset-y-0 left-1.5 flex items-center text-[10.5px] font-medium text-white tnum">{fmtMs(s.durationMs)}</span>}
                  </div>
                  {!labelInside && <span className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[10.5px] text-muted tnum" style={left > 70 ? { right: `${100 - left + 0.8}%` } : { left: `${left + width + 0.8}%` }}>{fmtMs(s.durationMs)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      {sel && (
        <Card className="h-fit max-h-[calc(100dvh-180px)] overflow-y-auto p-4">
          <div className="flex items-start justify-between gap-2"><h3 className="break-words text-[14px] font-semibold">{sel.name}</h3>{sel.statusCode === 2 ? <Badge tone="bad">error</Badge> : sel.statusCode === 1 ? <Badge tone="good">ok</Badge> : <Badge>unset</Badge>}</div>
          <div className="mt-3"><Dl rows={[['Service', <span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-[3px]" style={{ background: serviceColor(svc, sel.service) }} />{sel.service}</span>], ['Duration', fmtMs(sel.durationMs)], ['Offset', '+' + fmtMs(Date.parse(sel.start) - t0)], ['Kind', KIND[sel.kind] ?? sel.kind], ['Span ID', <Mono>{sel.spanId}</Mono>], ['Parent', sel.parentSpanId && <Mono>{sel.parentSpanId}</Mono>], ['Status', sel.statusMessage]]} /></div>
          <Button className="mt-4 w-full" onClick={() => navigate(pageHref(project.id, 'logs', route.params, { traceId: sel.traceId }))}><ScrollText size={14} />View logs for this trace</Button>
          <RowActions key={sel.spanId} scope="spans" conditions={spanConditions(sel)} labels filterPage="traces" className="mt-2 justify-center" />
          {Object.keys(sel.attributes).length > 0 && <div className="mt-5"><h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Attributes</h4><JsonView value={sel.attributes} /></div>}
          {Object.keys(sel.resource).length > 0 && <div className="mt-5"><h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Resource</h4><JsonView value={sel.resource} /></div>}
          {sel.events.length > 0 && <div className="mt-5"><h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Events</h4><div className="space-y-2">{sel.events.map((e, i) => (
            <div key={i} className="rounded-lg border border-line p-2.5"><div className="flex justify-between text-[12.5px]"><span className="font-medium">{e.name}</span><span className="tnum text-faint">{fmtTime(e.ts)}</span></div>{Object.keys(e.attributes).length > 0 && <div className="mt-1.5"><JsonView value={e.attributes} /></div>}</div>))}</div></div>}
        </Card>
      )}
    </div>
  );
}

function TraceDetail({ traceId }: { traceId: string }) {
  const { project } = useProject(); const route = useRoute();
  const t = useTrace(project.id, traceId, route.params.get('at'));
  const root = t.data?.spans.find((s) => !s.parentSpanId) ?? t.data?.spans[0];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => navigate(pageHref(project.id, 'traces', route.params))}><ArrowLeft size={14} />Traces</Button>
        <div className="min-w-0 flex-1"><div className="truncate text-[15px] font-semibold">{root?.name ?? 'Trace'}</div><div className="flex min-w-0 items-center gap-2"><Mono className="min-w-0 truncate text-faint">{traceId}</Mono><CopyButton text={traceId} className="shrink-0" /></div></div>
      </div>
      {t.isPending ? <Skeleton className="h-[420px]" /> : t.isError ? <ErrorState error={t.error} retry={() => t.refetch()} /> : t.data.spans.length === 0 ? <EmptyState title="Trace not found" /> : <Waterfall spans={t.data.spans} />}
    </div>
  );
}

export function TracesPage({ traceId }: { traceId: string | null }) {
  return traceId ? <TraceDetail traceId={traceId} /> : <TraceList />;
}
