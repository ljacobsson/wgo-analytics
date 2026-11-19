import { useMemo, useState } from 'react';
import { niceMax, useSize } from './util';

export interface RetentionSeries { key: string; label: string; color: string; /** share 0..1 per period */ values: number[] }
interface Props {
  series: RetentionSeries[];
  /** "day", "week" or "month": names the x axis and the tooltip */
  unit: string;
  height?: number;
}

const M = { l: 42, r: 12, t: 10, b: 36 };
const pct = (v: number) => `${+(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;

/** Lines of retention by periods since the cohort's start (not a time axis, so TimeChart doesn't fit). */
export function RetentionChart({ series, unit, height = 260 }: Props) {
  const [ref, w] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = Math.max(0, ...series.map((s) => s.values.length));

  const { yMax, step } = useMemo(() => {
    const mx = Math.max(0, ...series.flatMap((s) => s.values)) * 100;
    const r = niceMax(Math.min(100, mx), 4);
    return { yMax: Math.min(100, r.max), step: r.step };
  }, [series]);

  const pw = Math.max(10, w - M.l - M.r), ph = height - M.t - M.b;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * pw : pw / 2);
  const y = (v: number) => ph - ((v * 100) / yMax) * ph;
  const yTicks: number[] = [];
  for (let v = 0; v <= yMax + 1e-9; v += step) yTicks.push(v);
  const xTicks = useMemo(() => {
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 48))));
    return Array.from({ length: n }, (_, i) => i).filter((i) => i % every === 0);
  }, [n, pw]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - M.l) / pw) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };

  return (
    <div>
      {series.length > 1 && (
        <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11.5px] text-muted">
          {series.map((s) => <span key={s.key} className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-[3px]" style={{ background: s.color }} />{s.label}</span>)}
        </div>
      )}
      <div ref={ref} className="relative" style={{ height }}>
        {w > 0 && n > 0 && (
          <svg width={w} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} className="block select-none">
            <g transform={`translate(${M.l},${M.t})`}>
              {yTicks.map((v) => (
                <g key={v}>
                  <line x1={0} x2={pw} y1={y(v / 100)} y2={y(v / 100)} stroke="var(--line)" strokeDasharray={v === 0 ? undefined : '2 4'} />
                  <text x={-8} y={y(v / 100)} dy="0.32em" textAnchor="end" className="fill-faint tnum" fontSize="10.5">{v}%</text>
                </g>
              ))}
              {xTicks.map((i) => (
                <text key={i} x={x(i)} y={ph + 16} textAnchor="middle" className="fill-faint tnum" fontSize="10.5">{i}</text>
              ))}
              <text x={pw / 2} y={ph + 31} textAnchor="middle" className="fill-faint" fontSize="10.5">{unit}s since the start</text>
              {series.map((s) => {
                const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
                return <path key={s.key} d={d} fill="none" stroke={s.color} strokeWidth={s.key === 'average' ? 2.5 : 2} strokeLinejoin="round" strokeLinecap="round" />;
              })}
              {hover != null && (
                <g>
                  <line x1={x(hover)} x2={x(hover)} y1={0} y2={ph} stroke="var(--line-strong)" />
                  {series.filter((s) => hover < s.values.length).map((s) => <circle key={s.key} cx={x(hover)} cy={y(s.values[hover])} r={4} fill={s.color} stroke="var(--raised)" strokeWidth={2} />)}
                </g>
              )}
            </g>
          </svg>
        )}
        {hover != null && w > 0 && (() => {
          const px = M.l + x(hover);
          const left = px > w * 0.62;
          return (
            <div className="pointer-events-none absolute top-2 z-10 min-w-[150px] rounded-lg border border-line bg-[var(--raised)] px-3 py-2 text-[12px] shadow-xl" style={{ left: left ? undefined : px + 14, right: left ? w - px + 14 : undefined }}>
              <div className="mb-1 font-medium text-fg tnum">{unit[0].toUpperCase() + unit.slice(1)} {hover}</div>
              {series.filter((s) => hover < s.values.length).map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-4 py-[1px]">
                  <span className="inline-flex items-center gap-1.5 text-muted"><i className="h-2 w-2 rounded-[3px]" style={{ background: s.color }} />{s.label}</span>
                  <span className="tnum font-medium">{pct(s.values[hover])}</span>
                </div>
              ))}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
