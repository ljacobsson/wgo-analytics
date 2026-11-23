import { useMemo, useState } from 'react';
import { compact, fmtTick, niceMax, useSize } from './util';
import { cn, fmtMs } from '../lib/format';
import { BrushBand, useBrush, useZoom } from './zoom';

export interface Dot { id: string; t: number; v: number; bad: boolean; label: string }
const M = { l: 46, r: 10, t: 8, b: 22 };

export function Scatter({ dots, from, to, height = 150, onSelect, selected, zoom = true }: { dots: Dot[]; from: number; to: number; height?: number; onSelect?: (id: string) => void; selected?: string | null; zoom?: boolean }) {
  const [ref, w] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<Dot | null>(null);
  const pw = Math.max(10, w - M.l - M.r), ph = height - M.t - M.b;
  const { max, step } = useMemo(() => niceMax(Math.max(1, ...dots.map((d) => d.v)), 3), [dots]);
  const x = (t: number) => ((t - from) / (to - from || 1)) * pw;
  const y = (v: number) => ph - (v / max) * ph;
  const ticks: number[] = []; for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
  const timeAt = (px: number) => from + (px / pw) * (to - from);
  const zoomTo = useZoom();
  const brush = useBrush(M.l, pw, timeAt, zoom && to > from ? zoomTo : null);
  return (
    <div ref={ref} className="relative" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} {...brush.handlers} className={cn('block select-none', brush.enabled && 'cursor-crosshair touch-pan-y')}>
          <g transform={`translate(${M.l},${M.t})`}>
            {ticks.map((v) => (<g key={v}><line x1={0} x2={pw} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeDasharray={v ? '2 4' : undefined} /><text x={-8} y={y(v)} dy=".32em" textAnchor="end" fontSize="10.5" className="fill-faint tnum">{v >= 1000 ? compact(v / 1000) + 's' : v + 'ms'}</text></g>))}
            {[0, 1, 2, 3, 4].map((k) => { const t = from + ((to - from) * k) / 4; return <text key={k} x={x(t)} y={ph + 16} fontSize="10.5" textAnchor={k === 0 ? 'start' : k === 4 ? 'end' : 'middle'} className="fill-faint tnum">{fmtTick(t, to - from)}</text>; })}
            {dots.map((d) => (
              <circle key={d.id} cx={x(d.t)} cy={y(d.v)} r={d.id === selected || hover?.id === d.id ? 5 : 3.2} fill={d.bad ? 'var(--s8)' : 'var(--s1)'} fillOpacity={d.id === selected ? 1 : 0.65}
                stroke={d.id === selected ? 'var(--fg)' : 'var(--raised)'} strokeWidth={d.id === selected ? 1.5 : 1}
                onMouseEnter={() => setHover(d)} onMouseLeave={() => setHover(null)} onClick={() => onSelect?.(d.id)} className="cursor-pointer" />
            ))}
            {brush.sel && <BrushBand sel={brush.sel} height={ph} toTime={timeAt} span={to - from} />}
          </g>
        </svg>
      )}
      {hover && !brush.sel && <div className="pointer-events-none absolute z-10 rounded-lg border border-line bg-[var(--raised)] px-2.5 py-1.5 text-[11.5px] shadow-xl" style={{ left: Math.min(w - 190, M.l + x(hover.t) + 10), top: 0 }}>
        <div className="font-medium">{hover.label}</div><div className="tnum text-muted">{fmtMs(hover.v)}{hover.bad ? ' · error' : ''}</div></div>}
    </div>
  );
}
