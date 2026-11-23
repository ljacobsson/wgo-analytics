import { useId, useMemo, useState } from 'react';
import { compact, fmtTick, fmtTipTime, niceMax, useSize } from './util';
import { BrushBand, useBrush, useZoom } from './zoom';
import { cn } from '../lib/format';

/** `null` is a bucket without a value (an average over nothing): lines break there. */
export interface ChartSeries { key: string; label: string; color: string; values: Array<number | null> }
/** A moment to mark on the chart, e.g. a deploy (a release first seen). */
export interface ChartMarker { t: number; label: string; color?: string }
interface Props {
  times: number[];
  series: ChartSeries[];
  mode: 'bars' | 'area' | 'line';
  height?: number;
  format?: (n: number) => string;
  legend?: boolean;
  markers?: ChartMarker[];
  /** bucket length in ms (bars: where inside a bucket a marker falls) */
  bucketMs?: number;
  /** y-axis labels (default: compact numbers) */
  axisFormat?: (n: number) => string;
  /** drag across the chart to zoom the page's time range to the selection (default on; off for charts not on the page's range) */
  zoom?: boolean;
}

const M = { l: 42, r: 10, t: 10, b: 22 };

export function TimeChart({ times, series, mode, height = 260, format = compact, legend = true, markers, bucketMs, axisFormat = compact, zoom = true }: Props) {
  const [ref, w] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId();
  const n = times.length;
  const stacked = mode === 'bars';
  const span = n > 1 ? times[n - 1] - times[0] : 1;

  const { yMax, step } = useMemo(() => {
    let mx = 0;
    for (let i = 0; i < n; i++) {
      if (stacked) mx = Math.max(mx, series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
      else for (const s of series) mx = Math.max(mx, s.values[i] ?? 0);
    }
    const r = niceMax(mx, 4);
    return { yMax: r.max, step: r.step };
  }, [series, n, stacked]);

  const pw = Math.max(10, w - M.l - M.r), ph = height - M.t - M.b;
  const x = (i: number) => (stacked ? ((i + 0.5) / n) * pw : n > 1 ? (i / (n - 1)) * pw : pw / 2);
  const y = (v: number) => ph - (v / yMax) * ph;
  const yTicks: number[] = []; for (let v = 0; v <= yMax + 1e-9; v += step) yTicks.push(v);
  const xTickIdx = useMemo(() => {
    const c = Math.max(2, Math.min(7, Math.floor(pw / 110)));
    return Array.from({ length: c }, (_, k) => Math.round((k / (c - 1)) * (n - 1)));
  }, [pw, n]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left - M.l;
    const i = stacked ? Math.floor((px / pw) * n) : Math.round((px / pw) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };

  // plot x → time: bars cover whole buckets, lines run from the first point to the last
  const bucketStep = bucketMs ?? (n > 1 ? (times[n - 1] - times[0]) / (n - 1) : 60_000);
  const timeAt = (px: number) => (stacked ? times[0] + (px / pw) * n * bucketStep : px >= pw - 1 ? times[n - 1] + bucketStep : times[0] + (px / pw) * span);
  const zoomTo = useZoom();
  const brush = useBrush(M.l, pw, timeAt, zoom && n > 1 ? zoomTo : null);

  const bw = Math.max(1, pw / n - (pw / n > 6 ? 2 : 1));
  const singleArea = mode !== 'bars' && series.length === 1;

  return (
    <div>
      {legend && series.length > 1 && (
        <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11.5px] text-muted">
          {series.map((s) => <span key={s.key} className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-[3px]" style={{ background: s.color }} />{s.label}</span>)}
        </div>
      )}
      <div ref={ref} className="relative" style={{ height }}>
        {w > 0 && n > 0 && (
          <svg width={w} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} {...brush.handlers}
            className={cn('block select-none', brush.enabled && 'cursor-crosshair touch-pan-y')}>
            <defs>{series.map((s, k) => (
              <linearGradient key={s.key} id={`${gid}${k}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={s.color} stopOpacity=".28" /><stop offset="1" stopColor={s.color} stopOpacity="0" /></linearGradient>))}</defs>
            <g transform={`translate(${M.l},${M.t})`}>
              {yTicks.map((v) => (
                <g key={v}>
                  <line x1={0} x2={pw} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeDasharray={v === 0 ? undefined : '2 4'} />
                  <text x={-8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-faint tnum" fontSize="10.5">{axisFormat(v)}</text>
                </g>
              ))}
              {xTickIdx.map((i, k) => (
                <text key={i} x={x(i)} y={ph + 16} textAnchor={k === 0 ? 'start' : k === xTickIdx.length - 1 ? 'end' : 'middle'} className="fill-faint tnum" fontSize="10.5">{fmtTick(times[i], span)}</text>
              ))}
              {markers?.map((m, k) => {
                const step = bucketMs ?? (n > 1 ? (times[n - 1] - times[0]) / (n - 1) : 1);
                const f = stacked ? (m.t - times[0]) / step / n : n > 1 ? (m.t - times[0]) / span : 0.5;
                if (!(f >= 0 && f <= 1)) return null;
                const mx = f * pw, color = m.color ?? 'var(--muted)';
                return (
                  <g key={k} className="pointer-events-auto">
                    <title>{m.label}</title>
                    <line x1={mx} x2={mx} y1={0} y2={ph} stroke={color} strokeDasharray="3 3" strokeWidth={1.25} opacity={0.8} />
                    <rect x={mx - 6} y={0} width={12} height={ph} fill="transparent" />
                    <path d={`M${mx - 4} 0 L${mx + 4} 0 L${mx} 6 Z`} fill={color} />
                  </g>
                );
              })}
              {hover != null && stacked && <rect x={(hover / n) * pw} y={0} width={pw / n} height={ph} fill="var(--hl)" />}
              {stacked && times.map((_, i) => {
                let acc = 0;
                const topIdx = series.reduce((t, s, k) => ((s.values[i] ?? 0) > 0 ? k : t), -1);
                return series.map((s, k) => {
                  const v = s.values[i] ?? 0;
                  if (!v) return null;
                  const y1 = y(acc + v), h = Math.max(0, y(acc) - y1 - (acc ? 1.5 : 0));
                  acc += v;
                  return <rect key={s.key + i} x={x(i) - bw / 2} y={y1} width={bw} height={h} rx={k === topIdx ? Math.min(3, bw / 2) : 0} fill={s.color} opacity={hover == null || hover === i ? 1 : 0.55} />;
                });
              })}
              {!stacked && series.map((s, k) => {
                const gaps = s.values.some((v) => v == null);
                // a lone value between gaps still shows, as a dot
                const d = s.values.map((v, i) => (v == null ? '' : `${i && s.values[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}${s.values[i - 1] == null && s.values[i + 1] == null ? 'h0' : ''}`)).join(' ');
                return (
                  <g key={s.key}>
                    {singleArea && !gaps && <path d={`${d} L${x(n - 1)} ${ph} L${x(0)} ${ph} Z`} fill={`url(#${gid}${k})`} />}
                    <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  </g>
                );
              })}
              {hover != null && !stacked && (
                <g>
                  <line x1={x(hover)} x2={x(hover)} y1={0} y2={ph} stroke="var(--line-strong)" />
                  {series.map((s) => s.values[hover] != null && <circle key={s.key} cx={x(hover)} cy={y(s.values[hover]!)} r={4} fill={s.color} stroke="var(--raised)" strokeWidth={2} />)}
                </g>
              )}
              {brush.sel && <BrushBand sel={brush.sel} height={ph} toTime={timeAt} span={span} />}
            </g>
          </svg>
        )}
        {hover != null && w > 0 && !brush.sel && (() => {
          const px = M.l + x(hover);
          const left = px > w * 0.62;
          const total = series.reduce((s, k) => s + (k.values[hover] ?? 0), 0);
          return (
            <div className="pointer-events-none absolute top-2 z-10 min-w-[150px] rounded-lg border border-line bg-[var(--raised)] px-3 py-2 text-[12px] shadow-xl" style={{ left: left ? undefined : px + 14, right: left ? w - px + 14 : undefined }}>
              <div className="mb-1 font-medium text-fg tnum">{fmtTipTime(times[hover], span)}</div>
              {series.map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-4 py-[1px]">
                  <span className="inline-flex items-center gap-1.5 text-muted"><i className="h-2 w-2 rounded-[3px]" style={{ background: s.color }} />{s.label}</span>
                  <span className="tnum font-medium">{s.values[hover] == null ? '–' : format(s.values[hover]!)}</span>
                </div>
              ))}
              {stacked && series.length > 1 && <div className="mt-1 flex justify-between border-t border-line pt-1 text-muted"><span>Total</span><span className="tnum text-fg">{format(total)}</span></div>}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
