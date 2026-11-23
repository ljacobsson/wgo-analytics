import { useMemo, type ReactNode } from 'react';
import { BarChart3 } from 'lucide-react';
import type { DashboardTile, QueryMeasureResult, QueryResult, QuerySpec, TileMeasure } from '../api/contract';
import { useQueryResult } from '../api/hooks';
import { BarList } from '../charts/BarList';
import { Sparkline } from '../charts/Sparkline';
import { TimeChart, type ChartSeries } from '../charts/TimeChart';
import { botsParam, fieldLabel } from '../lib/filters';
import { cn, delta } from '../lib/format';
import { resolveRange, type TimeRange } from '../lib/time';
import { CountUp, EmptyState, ErrorState, Skeleton } from '../ui/kit';
import { axisFormatter, formatter, measureLabel } from './measures';

export const ROW_H = 80;
export const GAP = 16;
export const HEADER_H = 40;
/** Pixel height of a tile `h` rows tall. */
export const tileHeight = (h: number) => h * ROW_H + (h - 1) * GAP;

const ADDITIVE = new Set(['count', 'sessions', 'users', 'sum']);
const color = (i: number) => `var(--s${(i % 8) + 1})`;

/** The query a tile runs for its chart type (the backend validates the same shapes: lib/dashboards.ts tileShape). */
export function tileSpec(t: DashboardTile): QuerySpec | null {
  if (t.viz === 'text' || !t.measures.length) return null;
  const measures = t.measures.map(({ source, agg, field, metric, filters }) => ({ source, agg, ...(field ? { field } : {}), ...(metric ? { metric } : {}), ...(filters?.length ? { filters } : {}) }));
  const groupBy = measures.length === 1 && t.groupBy ? t.groupBy : undefined;
  switch (t.viz) {
    case 'number': return { shape: 'series', measures, compare: true };
    case 'top': return groupBy ? { shape: 'top', measures: measures.slice(0, 1), groupBy, limit: t.limit ?? 10 } : null;
    case 'table': return groupBy ? { shape: 'top', measures, groupBy, limit: t.limit ?? 10 } : { shape: 'total', measures, compare: true };
    default: return { shape: 'series', measures, ...(groupBy ? { groupBy, limit: t.limit ?? 5 } : {}) };
  }
}

/**
 * A tile's own range, if it has one, ending where the dashboard's does (so refreshes move it too). Fixed dates
 * (picked, or zoomed into on a chart) apply to every tile, so the whole dashboard shows the same moment.
 */
export function tileRange(t: DashboardTile, dash: TimeRange): TimeRange {
  return t.range && dash.preset !== 'custom' ? resolveRange(new URLSearchParams({ range: t.range }), Date.parse(dash.to)) : dash;
}

/** How a group shows: the API's label for ids (uptime checks), otherwise its value. */
const keyLabel = (g: { key: string; label?: string }) => g.label ?? (g.key === '(none)' ? '(not set)' : g.key);

export interface TileData { tile: DashboardTile; range: TimeRange; result: QueryResult | undefined; pending: boolean; error: unknown; retry: () => void }

/** Runs a tile's query. `filters` are the dashboard's events filters (URL `f`). */
export function useTileData(pid: string, tile: DashboardTile, dash: TimeRange, filters: string | undefined): TileData {
  const range = tileRange(tile, dash);
  const spec = useMemo(() => tileSpec(tile), [tile]);
  const events = tile.measures.some((m) => m.source === 'events');
  const q = useQueryResult(pid, range, spec, events ? filters : undefined, events ? botsParam() : undefined);
  return { tile, range, result: q.data, pending: q.isPending && !!spec, error: q.error, retry: () => void q.refetch() };
}

/** The chart, number or list inside a tile. `height` is the body's pixel height. */
export function TileBody({ data, height }: { data: TileData; height: number }) {
  const { tile, result, pending, error } = data;
  if (tile.viz === 'text') return <div className="h-full overflow-y-auto whitespace-pre-wrap px-4 pb-3 text-[13px] leading-relaxed text-muted">{tile.text}</div>;
  if (!tile.measures.length) return <div className="grid h-full place-items-center text-[12.5px] text-faint">Pick a measure</div>;
  if (!tileSpec(tile)) return <div className="grid h-full place-items-center px-4 text-center text-[12.5px] text-faint">Pick a field to split by to list its top values</div>;
  if (error && !result) return <div className="grid h-full place-items-center"><ErrorState error={error} retry={data.retry} /></div>;
  if (pending || !result) return <div className="h-full px-4 pb-4"><Skeleton className="h-full" /></div>;
  switch (tile.viz) {
    case 'number': return <NumberBody tile={tile} result={result} height={height} />;
    case 'top': return <TopBody tile={tile} result={result} />;
    case 'table': return <TableBody tile={tile} result={result} />;
    default: return <ChartBody tile={tile} result={result} height={height} />;
  }
}

function Change({ cur, prev, m }: { cur: number | null; prev: number | null | undefined; m: TileMeasure }) {
  if (cur == null || prev == null) return null;
  // shares compare in points, everything else in percent
  if (m.unit === 'percent') {
    const pts = (cur - prev) * 100;
    if (Math.abs(pts) < 0.05) return <span className="text-[11.5px] text-faint">no change</span>;
    return <Arrow up={pts > 0} m={m} text={`${Math.abs(pts).toFixed(1)} pts`} />;
  }
  const d = delta(cur, prev);
  if (d == null) return <span className="text-[11.5px] text-faint">none before</span>;
  if (Math.abs(d) < 0.5) return <span className="text-[11.5px] text-faint">no change</span>;
  return <Arrow up={d > 0} m={m} text={`${Math.abs(d) >= 100 ? Math.round(Math.abs(d)) : Math.abs(d).toFixed(1)}%`} />;
}
function Arrow({ up, m, text }: { up: boolean; m: TileMeasure; text: string }) {
  const good = m.better ? (m.better === 'up') === up : null;
  return <span className={cn('inline-flex items-center gap-1 text-[11.5px] font-medium tnum', good === null ? 'text-muted' : good ? 'text-good' : 'text-bad')}>{up ? '▲' : '▼'} {text}</span>;
}

function NumberBody({ tile, result, height }: { tile: DashboardTile; result: QueryResult; height: number }) {
  const many = tile.measures.length > 1;
  const big = height >= 120 && !many ? 'text-[34px]' : height >= 90 ? 'text-[26px]' : 'text-[20px]';
  const spark = height >= 100;
  return (
    <div className={cn('grid h-full gap-x-6 px-4 pb-3', many ? 'grid-flow-col auto-cols-fr' : '')}>
      {tile.measures.map((m, i) => {
        const r = result.measures[i];
        const fmt = formatter(m.unit);
        const pts = (r?.series?.[0]?.points ?? []).map((p) => p.value).filter((v): v is number => v != null);
        return (
          <div key={i} className="flex min-w-0 flex-col justify-end">
            {many && <div className="truncate text-[12px] text-muted" title={measureLabel(m)}>{measureLabel(m)}</div>}
            <div className={cn('font-semibold tracking-tight tnum leading-tight', big)}>{r?.total == null ? '–' : <CountUp value={r.total} format={fmt} />}</div>
            <div className="mt-0.5 flex items-center gap-2"><Change cur={r?.total ?? null} prev={r?.previous} m={m} /><span className="text-[11px] text-faint">vs previous</span></div>
            {spark && pts.length > 1 && <Sparkline data={pts} color={color(i)} height={Math.min(44, height - 80)} className="mt-2" />}
          </div>
        );
      })}
    </div>
  );
}

function ChartBody({ tile, result, height }: { tile: DashboardTile; result: QueryResult; height: number }) {
  const first = result.measures[0]?.series?.[0];
  if (!first?.points.length) return <Empty />;
  const times = first.points.map((p) => Date.parse(p.t));
  const units = new Set(tile.measures.map((m) => m.unit ?? 'count'));
  const bucketMs = result.bucketSeconds * 1000 || undefined;

  const seriesOf = (r: QueryMeasureResult, m: TileMeasure, k: number): ChartSeries[] =>
    (r.series ?? []).map((s, j) => ({
      key: `${k}:${s.key}`,
      label: tile.groupBy && tile.measures.length === 1 ? keyLabel(s) : measureLabel(m),
      color: color(k + j),
      values: s.points.map((p) => p.value),
    }));
  const mode = (ms: TileMeasure[]): 'bars' | 'area' | 'line' =>
    // stacking only adds up for counts and sums
    tile.viz === 'bars' && ms.every((m) => ADDITIVE.has(m.agg)) ? 'bars' : tile.viz === 'area' ? 'area' : 'line';

  // different units never share an axis: one small chart per measure
  if (units.size > 1) {
    const each = Math.max(60, Math.floor((height - 8) / tile.measures.length) - 22);
    return (
      <div className="h-full space-y-1 overflow-y-auto px-3 pb-2">
        {tile.measures.map((m, k) => (
          <div key={k}>
            <div className="flex items-center gap-1.5 px-1 text-[11.5px] text-muted"><i className="h-2 w-2 rounded-[3px]" style={{ background: color(k) }} />{measureLabel(m)}</div>
            <TimeChart times={times} series={seriesOf(result.measures[k], m, k)} mode={mode([m])} height={each} legend={false}
              format={formatter(m.unit)} axisFormat={axisFormatter(m.unit)} bucketMs={bucketMs} />
          </div>
        ))}
      </div>
    );
  }
  const series = tile.measures.flatMap((m, k) => seriesOf(result.measures[k], m, k));
  const legend = series.length > 1;
  const unit = tile.measures[0].unit;
  return (
    <div className="h-full px-3 pb-2">
      <TimeChart times={times} series={series} mode={mode(tile.measures)} height={Math.max(60, height - 8 - (legend ? 22 : 0))} legend={legend}
        format={formatter(unit)} axisFormat={axisFormatter(unit)} bucketMs={bucketMs} />
    </div>
  );
}

function TopBody({ tile, result }: { tile: DashboardTile; result: QueryResult }) {
  const groups = result.measures[0]?.groups ?? [];
  if (!groups.length) return <Empty />;
  const m = tile.measures[0];
  return (
    <div className="h-full overflow-y-auto">
      <BarList rows={groups.map((g) => ({ key: g.key, label: keyLabel(g), value: g.value ?? 0 }))} format={formatter(m.unit)} />
    </div>
  );
}

function TableBody({ tile, result }: { tile: DashboardTile; result: QueryResult }) {
  const th = 'px-3 py-1.5 font-medium';
  if (tile.groupBy) {
    const m = tile.measures[0];
    const groups = result.measures[0]?.groups ?? [];
    if (!groups.length) return <Empty />;
    const fmt = formatter(m.unit);
    return (
      <div className="h-full overflow-y-auto px-1 pb-2">
        <table className="w-full text-[12.5px]">
          <thead><tr className="text-left text-faint"><th className={th}>{fieldLabel(tile.groupBy)}</th><th className={cn(th, 'text-right')}>{measureLabel(m)}</th></tr></thead>
          <tbody>{groups.map((g) => (
            <tr key={g.key} className="border-t border-line"><td className="max-w-0 truncate px-3 py-1.5" title={g.key}>{keyLabel(g)}</td><td className="px-3 py-1.5 text-right tnum">{g.value == null ? '–' : fmt(g.value)}</td></tr>))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto px-1 pb-2">
      <table className="w-full text-[12.5px]">
        <thead><tr className="text-left text-faint"><th className={th}>Measure</th><th className={cn(th, 'text-right')}>Value</th><th className={cn(th, 'text-right')}>Change</th></tr></thead>
        <tbody>{tile.measures.map((m, i) => {
          const r = result.measures[i];
          return (
            <tr key={i} className="border-t border-line">
              <td className="max-w-0 truncate px-3 py-1.5" title={measureLabel(m)}>{measureLabel(m)}</td>
              <td className="px-3 py-1.5 text-right tnum">{r?.total == null ? '–' : formatter(m.unit)(r.total)}</td>
              <td className="px-3 py-1.5 text-right"><Change cur={r?.total ?? null} prev={r?.previous} m={m} /></td>
            </tr>);
        })}</tbody>
      </table>
    </div>
  );
}

function Empty(): ReactNode {
  return <div className="grid h-full place-items-center"><EmptyState icon={<BarChart3 size={20} />} title="No data in this range" /></div>;
}
