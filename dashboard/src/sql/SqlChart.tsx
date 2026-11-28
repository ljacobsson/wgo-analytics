import { useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import type { SqlResult } from '../api/contract';
import { BarList } from '../charts/BarList';
import { Sparkline } from '../charts/Sparkline';
import { TimeChart } from '../charts/TimeChart';
import { axisFormatter, formatter } from '../dashboards/measures';
import { CountUp, EmptyState } from '../ui/kit';
import { barData, categoryData, numberData, pieData, resolveChart, scatterData, timeData, TIME_VIZ, type ChartSpec } from './chart';
import { ColumnChart, Donut, XYScatter } from './CategoryCharts';
import { ResultsGrid } from './ResultsGrid';

/** Categorical colors in their fixed order: series n always gets color n. */
const color = (i: number) => `var(--s${(i % 8) + 1})`;

/** A SQL result drawn as `spec` says (gaps filled from the result). `height` is the pixel height available. */
export function SqlChart({ result, spec, height }: { result: SqlResult; spec: ChartSpec; height: number }) {
  const s = useMemo(() => resolveChart(result, spec), [result, spec]);
  const [selected, setSelected] = useState<number | null>(null);
  if (!result.rows.length) return <Centered><EmptyState icon={<BarChart3 size={20} />} title="No rows in this range" /></Centered>;
  const fmt = formatter(s.unit), axis = axisFormatter(s.unit);

  if (s.viz === 'table') return <div className="flex h-full min-h-0 flex-col"><ResultsGrid columns={result.columns} rows={result.rows} selected={selected} onSelect={setSelected} /></div>;

  if (s.viz === 'number') {
    const d = numberData(result, s);
    if ('problem' in d) return <Problem text={d.problem} />;
    const big = height >= 150 ? 'text-[40px]' : height >= 90 ? 'text-[30px]' : 'text-[22px]';
    return (
      <div className="flex h-full flex-col justify-end px-4 pb-3">
        <div className="text-[12px] text-muted">{s.y?.[0]}</div>
        <div className={`font-semibold leading-tight tracking-tight tnum ${big}`}>{d.value === null ? '–' : <CountUp value={d.value} format={fmt} />}</div>
        {d.trend.length > 1 && height >= 110 && <Sparkline data={d.trend} color={color(0)} height={Math.min(48, height - 90)} className="mt-2" />}
      </div>
    );
  }

  if (s.viz === 'top') {
    const d = barData(result, s);
    if ('problem' in d) return <Problem text={d.problem} />;
    return (
      <div className="h-full overflow-y-auto pt-1">
        <BarList rows={d.rows} format={fmt} color={color(0)} />
        {d.hidden > 0 && <Note>{d.hidden} more row{d.hidden === 1 ? '' : 's'} not shown</Note>}
      </div>
    );
  }

  if (s.viz === 'columns') {
    const d = categoryData(result, s);
    if ('problem' in d) return <Problem text={d.problem} />;
    return (
      <div className="flex h-full flex-col px-3 pb-1">
        <div className="min-h-0 flex-1"><ColumnChart data={d} height={height - 6 - (d.hidden ? 18 : 0)} format={fmt} axisFormat={axis} /></div>
        {d.hidden > 0 && <Note>Showing {d.categories.length} categories and {d.series.length} series; the rest aren’t shown</Note>}
      </div>
    );
  }

  if (s.viz === 'pie') {
    const d = pieData(result, s);
    if ('problem' in d) return <Problem text={d.problem} />;
    return <Donut data={d} height={height} format={fmt} />;
  }

  if (s.viz === 'scatter') {
    const d = scatterData(result, s);
    if ('problem' in d) return <Problem text={d.problem} />;
    return (
      <div className="flex h-full flex-col px-3 pb-1">
        <div className="min-h-0 flex-1"><XYScatter data={d} height={height - 6 - (d.hidden ? 18 : 0)} xLabel={s.x ?? ''} yLabel={s.y?.[0] ?? ''} format={fmt} axisFormat={axis} /></div>
        {d.hidden > 0 && <Note>The first {d.points.length} rows; {d.hidden} more not shown</Note>}
      </div>
    );
  }

  if (TIME_VIZ.has(s.viz)) {
    const d = timeData(result, s);
    if ('problem' in d) return <Problem text={d.problem} />;
    const legend = d.series.length > 1;
    const series = d.series.map((x, i) => ({ ...x, color: color(i) }));
    return (
      <div className="flex h-full flex-col px-3 pb-2">
        <TimeChart times={d.times} series={series} mode={s.viz as 'line' | 'area' | 'bars'} legend={legend} bucketMs={d.bucketMs}
          height={Math.max(60, height - 8 - (legend ? 22 : 0) - (d.hidden ? 18 : 0))} format={fmt} axisFormat={axis} zoom={false} />
        {d.hidden > 0 && <Note>The {series.length} biggest of {series.length + d.hidden} series</Note>}
      </div>
    );
  }
  return null;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center">{children}</div>;
}
function Problem({ text }: { text: string }) {
  return <Centered><p className="max-w-sm px-4 text-center text-[12.5px] text-muted">{text}</p></Centered>;
}
function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-3 pt-1 text-[11px] text-faint">{children}</p>;
}
