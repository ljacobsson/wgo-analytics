import { useMemo } from 'react';
import { LineChart, Search } from 'lucide-react';
import { useMetricSeries, useMetrics } from '../api/hooks';
import { useProject } from '../lib/project';
import { useTime } from '../lib/time';
import { useRoute, useSetParams } from '../lib/router';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Segmented, Skeleton } from '../ui/kit';
import { TimeChart } from '../charts/TimeChart';
import { cn, fmtNum, relTime } from '../lib/format';
import { useState } from 'react';

const AGGS = ['avg', 'sum', 'min', 'max', 'p95'] as const;

export function MetricsPage() {
  const { project } = useProject(); const { range } = useTime(); const route = useRoute(); const set = useSetParams();
  const metrics = useMetrics(project.id, range);
  const [filter, setFilter] = useState('');
  const sel = route.params.get('m') ?? metrics.data?.[0]?.name ?? null;
  const agg = (route.params.get('agg') ?? 'avg') as (typeof AGGS)[number];
  const [gIn, setGIn] = useState(route.params.get('groupBy') ?? '');
  const groupBy = route.params.get('groupBy') ?? '';
  const info = metrics.data?.find((m) => m.name === sel);
  const ser = useMetricSeries(project.id, range, sel, agg, groupBy);
  const list = useMemo(() => (metrics.data ?? []).filter((m) => m.name.toLowerCase().includes(filter.toLowerCase())), [metrics.data, filter]);
  const chart = useMemo(() => {
    if (!ser.data || !ser.data.series.length) return null;
    const times = ser.data.series[0].points.map((p) => Date.parse(p.t));
    const top = ser.data.series.slice(0, 8);
    return { times, series: top.map((s, i) => ({ key: s.key, label: s.key || info?.name || 'value', color: `var(--s${i + 1})`, values: s.points.map((p) => p.value) })), extra: ser.data.series.length - top.length };
  }, [ser.data, info]);
  if (metrics.isError) return <ErrorState error={metrics.error} retry={() => metrics.refetch()} />;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
      <Card className="flex max-h-[340px] flex-col overflow-hidden xl:max-h-[calc(100vh-130px)]">
        <div className="border-b border-line p-3"><div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" /><input className="field !pl-8" placeholder="Filter metrics" value={filter} onChange={(e) => setFilter(e.target.value)} /></div></div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {metrics.isPending ? <div className="space-y-2 p-2">{Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div> : list.length === 0 ? <EmptyState icon={<LineChart size={22} />} title="No metrics">Send OTLP metrics to your ingest endpoint.</EmptyState> : list.map((m) => (
            <button key={m.name + m.service} onClick={() => set({ m: m.name })} className={cn('block w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--hl)] cursor-pointer', sel === m.name && 'bg-accent/12')}>
              <div className="truncate font-mono text-[12.5px] font-medium">{m.name}</div>
              <div className="mt-1 flex items-center gap-2 text-[11.5px] text-faint"><Badge>{m.type}</Badge>{m.unit && <span>{m.unit}</span>}<span className="truncate">{m.service}</span><span className="ml-auto tnum">{fmtNum(m.points)} pts</span></div>
            </button>))}
        </div>
      </Card>
      <Card>
        <CardHeader title={<span className="font-mono">{sel ?? '–'}</span>} sub={info ? `${info.type}${info.unit ? ' · ' + info.unit : ''} · ${info.service} · last seen ${relTime(info.lastSeen)}` : undefined}
          right={<div className="flex flex-wrap items-center gap-3"><Segmented value={agg} onChange={(v) => set({ agg: v === 'avg' ? null : v })} options={AGGS.map((a) => ({ value: a, label: a }))} />
            <input className="field font-mono sm:!w-48" placeholder="Group by attribute key" value={gIn} onChange={(e) => setGIn(e.target.value)} onBlur={() => set({ groupBy: gIn || null })} onKeyDown={(e) => e.key === 'Enter' && set({ groupBy: gIn || null })} /></div>} />
        {info?.description && <p className="px-4 text-[12.5px] text-muted">{info.description}</p>}
        <div className="p-3">
          {!sel ? <EmptyState title="Select a metric" /> : ser.isPending ? <Skeleton className="h-[340px]" /> : ser.isError ? <ErrorState error={ser.error} /> : !chart ? <EmptyState icon={<LineChart size={22} />} title="No data points in this range" /> :
            <TimeChart times={chart.times} series={chart.series} mode={chart.series.length > 1 ? 'line' : 'area'} height={340} format={(n) => fmtNum(n) + (info?.unit && info.unit.length < 4 && info.unit !== '1' ? ' ' + info.unit : '')} />}
          {chart && chart.extra > 0 && <p className="px-2 pt-1 text-[11.5px] text-faint">Showing first 8 of {chart.series.length + chart.extra} groups.</p>}
        </div>
      </Card>
    </div>
  );
}
