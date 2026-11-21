import { useMemo, useState } from 'react';
import { LineChart, Search } from 'lucide-react';
import { useMetricSeries, useMetrics } from '../api/hooks';
import type { MetricInfo } from '../api/contract';
import { useProject } from '../lib/project';
import { useTime } from '../lib/time';
import { useRoute, useSetParams } from '../lib/router';
import { Card, CardHeader, EmptyState, ErrorState, Segmented, Skeleton } from '../ui/kit';
import { TimeChart } from '../charts/TimeChart';
import { cn, fmtNum, relTime } from '../lib/format';

const AGGS = ['avg', 'sum', 'min', 'max', 'p95'] as const;
const SERVICE_KEY = 'service.name'; // groupBy value the API reads as "split by reporting service"
const MAX_SHOWN = 8;

/** What one plotted point is, in words, for the metric's OTel type and the chosen aggregation. */
function explain(type: MetricInfo['type'], agg: string): string {
  const per = `${agg === 'p95' ? 'the 95th percentile' : agg === 'avg' ? 'the average' : `the ${agg}`} of the reported values in each interval`;
  if (type === 'gauge') return `Gauge: a reading taken at a point in time. Each point is ${per}.`;
  if (type === 'sum') return `Counter: each reported value is a running or per-export total, depending on the exporter's temporality. Each point is ${per}; a steadily rising line is a cumulative counter.`;
  return `Histogram: each reported value is the mean of one export's observations. Each point is ${per}.`;
}

export function MetricsPage() {
  const { project } = useProject(); const { range } = useTime(); const route = useRoute(); const set = useSetParams();
  const metrics = useMetrics(project.id, range);
  const [filter, setFilter] = useState('');
  const first = metrics.data?.[0];
  const routeName = route.params.get('m');
  const sel = routeName ?? first?.name ?? null;
  // a metric named in the URL without a service means all services; the default selection is the first row
  const service = routeName ? route.params.get('service') ?? '' : first?.service ?? '';
  const agg = (route.params.get('agg') ?? 'avg') as (typeof AGGS)[number];
  const groupBy = route.params.get('groupBy') ?? '';
  const reporters = useMemo(() => (metrics.data ?? []).filter((m) => m.name === sel), [metrics.data, sel]);
  const info = reporters.find((m) => m.service === service) ?? reporters[0];
  const ser = useMetricSeries(project.id, range, sel, service, agg, groupBy);
  const list = useMemo(() => {
    const f = filter.toLowerCase();
    return (metrics.data ?? []).filter((m) => m.name.toLowerCase().includes(f) || m.service.toLowerCase().includes(f));
  }, [metrics.data, filter]);
  const unit = info?.unit && info.unit.length < 6 && info.unit !== '1' ? ' ' + info.unit : '';
  const fmt = (n: number) => fmtNum(n) + unit;

  const chart = useMemo(() => {
    if (!ser.data || !ser.data.series.length) return null;
    const times = ser.data.series[0].points.map((p) => Date.parse(p.t));
    const top = ser.data.series.slice(0, MAX_SHOWN);
    const series = top.map((s, i) => {
      // series can miss buckets; align them on the first series' times
      const at = new Map(s.points.map((p) => [Date.parse(p.t), p.value]));
      return { key: s.key, label: s.key || sel || 'value', color: `var(--s${i + 1})`, values: times.map((t) => at.get(t) ?? 0) };
    });
    const stats = top.map((s, i) => {
      const v = s.points.map((p) => p.value);
      return { key: s.key, label: series[i].label, color: series[i].color, latest: v[v.length - 1], min: Math.min(...v), avg: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v) };
    });
    return { times, series, stats, extra: ser.data.series.length - top.length };
  }, [ser.data, sel]);

  const groupOptions = useMemo(() => {
    const keys = ser.data?.attributeKeys ?? [];
    const opts = [...(!service && reporters.length > 1 ? [{ value: SERVICE_KEY, label: 'Service' }] : []), ...keys.map((k) => ({ value: k, label: k }))];
    if (groupBy && !opts.some((o) => o.value === groupBy)) opts.push({ value: groupBy, label: groupBy });
    return opts;
  }, [ser.data, service, reporters.length, groupBy]);

  if (metrics.isError) return <ErrorState error={metrics.error} retry={() => metrics.refetch()} />;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
      <Card className="flex max-h-[340px] flex-col overflow-hidden xl:max-h-[calc(100vh-130px)]">
        <div className="border-b border-line p-3"><div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" /><input className="field !pl-8" placeholder="Filter metrics or services" value={filter} onChange={(e) => setFilter(e.target.value)} /></div></div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {metrics.isPending ? <div className="space-y-2 p-2">{Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div> : list.length === 0 ? <EmptyState icon={<LineChart size={22} />} title="No metrics">Send OTLP metrics to your ingest endpoint.</EmptyState> : list.map((m) => {
            const active = sel === m.name && (service === m.service || !service);
            return (
              <button key={m.name + '\0' + m.service} onClick={() => set({ m: m.name, service: m.service, groupBy: m.name === sel ? groupBy || null : null })}
                className={cn('block w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--hl)] cursor-pointer', active && (service ? 'bg-accent/12' : 'bg-accent/6'))}>
                <div className="truncate font-mono text-[12.5px] font-medium">{m.name}</div>
                <div className="mt-1 flex items-center gap-2 text-[11.5px] text-faint"><span className="truncate text-muted">{m.service}</span><span>{m.type}{m.unit && m.unit !== '1' ? ` · ${m.unit}` : ''}</span><span className="ml-auto tnum">{fmtNum(m.points)} pts</span></div>
              </button>
            );
          })}
        </div>
      </Card>
      <Card>
        <CardHeader title={<span className="font-mono">{sel ?? '–'}</span>}
          sub={info ? `${info.type}${info.unit ? ' · ' + info.unit : ''} · ${service || `${reporters.length} services`} · last seen ${relTime(info.lastSeen)}` : undefined}
          right={<div className="flex flex-wrap items-center gap-2">
            {reporters.length > 1 && (
              <select className="field !w-44" aria-label="Service" value={service} onChange={(e) => set({ m: sel, service: e.target.value || null, groupBy: groupBy === SERVICE_KEY && e.target.value ? null : groupBy || null })}>
                <option value="">All services</option>{reporters.map((r) => <option key={r.service} value={r.service}>{r.service}</option>)}
              </select>)}
            <select className="field !w-52" aria-label="Split by" value={groupBy} onChange={(e) => set({ groupBy: e.target.value || null })}>
              <option value="">No split</option>{groupOptions.map((o) => <option key={o.value} value={o.value}>Split by {o.label}</option>)}
            </select>
            <Segmented value={agg} onChange={(v) => set({ agg: v === 'avg' ? null : v })} options={AGGS.map((a) => ({ value: a, label: a }))} />
          </div>} />
        {info && <p className="px-4 text-[12.5px] text-muted">{info.description ? info.description + ' ' : ''}<span className="text-faint">{explain(info.type, agg)}{!service && reporters.length > 1 && !groupBy ? ' Points from all services are combined; split by service to compare them.' : ''}</span></p>}
        <div className="p-3">
          {!sel ? <EmptyState title="Select a metric" /> : ser.isPending ? <Skeleton className="h-[340px]" /> : ser.isError ? <ErrorState error={ser.error} /> : !chart ? <EmptyState icon={<LineChart size={22} />} title="No data points in this range" /> :
            <TimeChart times={chart.times} series={chart.series} mode={chart.series.length > 1 ? 'line' : 'area'} height={340} format={fmt} bucketMs={(ser.data?.bucketSeconds ?? 0) * 1000 || undefined} />}
          {chart && (
            <table className="mt-3 w-full text-[12.5px]">
              <thead><tr className="text-left text-faint">
                <th className="px-2 py-1.5 font-medium">{chart.stats.length > 1 ? groupOptions.find((o) => o.value === groupBy)?.label ?? groupBy : 'Series'}</th>
                {['Latest', 'Min', 'Avg', 'Max'].map((h) => <th key={h} className="px-2 py-1.5 text-right font-medium">{h}</th>)}
              </tr></thead>
              <tbody>{chart.stats.map((s) => (
                <tr key={s.key} className={cn('border-t border-line', groupBy === SERVICE_KEY && 'cursor-pointer hover:bg-[var(--hl)]')} onClick={groupBy === SERVICE_KEY ? () => set({ m: sel, service: s.key, groupBy: null }) : undefined}>
                  <td className="px-2 py-1.5"><span className="flex items-center gap-2 font-mono"><i className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} /><span className="truncate">{s.label}</span></span></td>
                  {[s.latest, s.min, s.avg, s.max].map((v, i) => <td key={i} className="px-2 py-1.5 text-right tnum">{fmt(v)}</td>)}
                </tr>))}
              </tbody>
            </table>)}
          {chart && chart.extra > 0 && <p className="px-2 pt-1 text-[11.5px] text-faint">Showing the {MAX_SHOWN} series with the most data of {chart.series.length + chart.extra}.</p>}
        </div>
      </Card>
    </div>
  );
}
