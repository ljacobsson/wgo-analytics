import { useState, type ReactNode } from 'react';
import { compact, niceMax, useSize } from '../charts/util';
import { cn } from '../lib/format';
import type { CategoryData, PieData, ScatterData } from './chart';

/**
 * Charts of results without a time axis: bars per category, a donut of shares, and numbers against numbers.
 * Marks follow the dashboard's chart specs: thin bars with a rounded data end, 2px surface gaps between touching
 * fills, 8px dots with a surface ring, hairline gridlines, a legend for two or more series, a tooltip on hover.
 */
export const seriesColor = (i: number) => `var(--s${(i % 8) + 1})`;
const BAR_MAX = 24;
const GAP = 2;
const RADIUS = 4;

interface Fmt { format: (n: number) => string; axisFormat: (n: number) => string }

// ---------------------------------------------------------------- shared pieces

export function Legend({ items, active, onHover }: { items: Array<{ label: string; color: string; sub?: string }>; active?: number | null; onHover?: (i: number | null) => void }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 pb-2">
      {items.map((it, i) => (
        <span key={i} onMouseEnter={() => onHover?.(i)} onMouseLeave={() => onHover?.(null)}
          className={cn('inline-flex min-w-0 max-w-[220px] items-center gap-1.5 text-[11.5px] text-muted transition-opacity', active != null && active !== i && 'opacity-50')}>
          <i className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: it.color }} />
          <span className="truncate" title={it.label}>{it.label}</span>
          {it.sub && <span className="shrink-0 text-faint tnum">{it.sub}</span>}
        </span>))}
    </div>
  );
}

/** `height`: the container's, so a tip in its lower half opens upwards instead of being cut off. */
function Tip({ x, y, width, height, title, rows }: { x: number; y: number; width: number; height: number; title?: string; rows: Array<{ label: string; value: string; color?: string }> }) {
  const left = Math.max(4, Math.min(x + 14, width - 220));
  const place = y > height / 2 ? { bottom: Math.max(0, height - y + 10) } : { top: y + 10 };
  return (
    <div className="pointer-events-none absolute z-10 min-w-[140px] max-w-[260px] rounded-lg border border-line bg-[var(--raised)] px-2.5 py-1.5 text-[11.5px] shadow-xl" style={{ left, ...place }}>
      {title && <div className="mb-1 truncate font-medium text-fg">{title}</div>}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          {r.color && <i className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: r.color }} />}
          <span className="min-w-0 flex-1 truncate text-muted">{r.label}</span>
          <span className="tnum text-fg">{r.value}</span>
        </div>))}
    </div>
  );
}

/** Ticks for a value axis that includes 0. */
function scale(min: number, max: number) {
  const top = niceMax(Math.max(max, 0));
  const step = top.step;
  const lo = min < 0 ? -Math.ceil(-min / step) * step : 0;
  const hi = max > 0 ? top.max : 0;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(+v.toFixed(10));
  return { lo, hi: hi === lo ? lo + step : hi, ticks };
}

/** A bar from the baseline `y0` to its data end `y1`, rounded at the data end only. */
function barPath(x: number, y0: number, y1: number, w: number, round: boolean): string {
  const h = Math.abs(y1 - y0);
  const r = round ? Math.min(RADIUS, h, w / 2) : 0;
  const d = y1 < y0 ? 1 : -1; // up or down
  return `M${x},${y0}V${y1 + d * r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + d * r}V${y0}Z`;
}

// ---------------------------------------------------------------- bars per category

export function ColumnChart({ data, height, format, axisFormat }: { data: CategoryData; height: number } & Fmt) {
  const [ref, width] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const legend = data.series.length > 1;
  const h = Math.max(80, height - (legend ? 26 : 0));
  const M = { l: 48, r: 8, t: 8, b: 24 };
  const pw = Math.max(10, width - M.l - M.r), ph = Math.max(10, h - M.t - M.b);
  const n = data.categories.length;

  // the value range: stacks add up per category (positives and negatives apart)
  let min = 0, max = 0;
  for (let c = 0; c < n; c++) {
    if (data.stacked) {
      let pos = 0, neg = 0;
      for (const s of data.series) { const v = s.values[c] ?? 0; if (v >= 0) pos += v; else neg += v; }
      max = Math.max(max, pos); min = Math.min(min, neg);
    } else for (const s of data.series) { const v = s.values[c] ?? 0; max = Math.max(max, v); min = Math.min(min, v); }
  }
  const { lo, hi, ticks } = scale(min, max);
  const y = (v: number) => M.t + ph - ((v - lo) / (hi - lo)) * ph;
  const band = pw / Math.max(1, n);
  const groups = data.stacked ? 1 : data.series.length;
  const barW = Math.max(2, Math.min(BAR_MAX, (band * 0.72 - GAP * (groups - 1)) / groups));
  const groupW = barW * groups + GAP * (groups - 1);
  const labelEvery = Math.max(1, Math.ceil(56 / band));
  const maxChars = Math.max(3, Math.floor((band * labelEvery) / 6.4));

  const bars: ReactNode[] = [];
  for (let c = 0; c < n; c++) {
    const x0 = M.l + c * band + (band - groupW) / 2;
    if (data.stacked) {
      let pos = 0, neg = 0;
      const segs = data.series.map((s, k) => ({ k, v: s.values[c] ?? 0 })).filter((s) => s.v !== 0);
      const lastPos = segs.filter((s) => s.v > 0).at(-1)?.k, lastNeg = segs.filter((s) => s.v < 0).at(-1)?.k;
      for (const s of segs) {
        const from = s.v > 0 ? pos : neg;
        const to = from + s.v;
        if (s.v > 0) pos = to; else neg = to;
        const end = s.k === (s.v > 0 ? lastPos : lastNeg);
        // the surface gap sits between segments, at each segment's data end except the outermost
        const y0 = y(from), y1 = y(to) + (end ? 0 : s.v > 0 ? GAP : -GAP);
        if (Math.abs(y1 - y0) < 0.5) continue;
        bars.push(<path key={`${c}-${s.k}`} d={barPath(x0, y0, y1, barW, end)} fill={seriesColor(s.k)} opacity={hover && hover.i !== c ? 0.55 : 1} />);
      }
    } else {
      data.series.forEach((s, k) => {
        const v = s.values[c];
        if (v === null || v === 0) return;
        bars.push(<path key={`${c}-${k}`} d={barPath(x0 + k * (barW + GAP), y(0), y(v), barW, true)} fill={seriesColor(k)} opacity={hover && hover.i !== c ? 0.55 : 1} />);
      });
    }
  }

  return (
    <div className="flex h-full flex-col">
      {legend && <Legend items={data.series.map((s, i) => ({ label: s.label, color: seriesColor(i) }))} />}
      <div ref={ref} className="relative min-h-0 flex-1"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const i = Math.floor((e.clientX - r.left - M.l) / band);
          setHover(i >= 0 && i < n ? { i, x: e.clientX - r.left, y: e.clientY - r.top } : null);
        }}
        onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={h} className="block overflow-visible">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={M.l} x2={M.l + pw} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
                <text x={M.l - 8} y={y(t)} dy=".32em" textAnchor="end" fontSize="10.5" className="fill-faint tnum">{axisFormat(t)}</text>
              </g>))}
            {hover && <rect x={M.l + hover.i * band} y={M.t} width={band} height={ph} fill="var(--hl)" />}
            {bars}
            {data.categories.map((c, i) => i % labelEvery === 0 && (
              <text key={i} x={M.l + i * band + band / 2} y={M.t + ph + 16} textAnchor="middle" fontSize="10.5" className="fill-faint">
                {c.length > maxChars ? c.slice(0, maxChars - 1) + '…' : c}
              </text>))}
          </svg>)}
        {hover && (
          <Tip x={hover.x} y={hover.y} width={width} height={h} title={data.categories[hover.i]}
            rows={[
              ...data.series.map((s, k) => ({ label: s.label, value: s.values[hover.i] === null ? '–' : format(s.values[hover.i]!), color: seriesColor(k) })),
              ...(data.stacked && data.series.length > 1 ? [{ label: 'Total', value: format(data.series.reduce((a, s) => a + (s.values[hover.i] ?? 0), 0)) }] : []),
            ]} />)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- donut

export function Donut({ data, height, format }: { data: PieData; height: number } & Pick<Fmt, 'format'>) {
  const [ref, width] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  // the legend goes beside the donut or below it, whichever leaves the bigger donut
  const legendH = data.slices.length * 22 + (data.dropped ? 20 : 0) + 12;
  const beside = Math.min(height - 12, width * 0.45, 260), below = Math.min(height - legendH - 8, width - 24, 260);
  const side = width >= 300 && beside >= below;
  const size = Math.max(60, side ? beside : below);
  const R = size / 2, r = R * 0.62, cx = R, cy = R;
  const pad = GAP / R; // the surface gap between slices, as an angle
  let a0 = -Math.PI / 2;
  const arcs = data.slices.map((s, i) => {
    const sweep = (s.value / data.total) * Math.PI * 2;
    const start = a0 + (data.slices.length > 1 ? pad / 2 : 0), end = a0 + sweep - (data.slices.length > 1 ? pad / 2 : 0);
    a0 += sweep;
    const big = end - start > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
    // a single slice is a whole ring: two half arcs
    const d = data.slices.length === 1
      ? `M${p(R, -Math.PI / 2)}A${R},${R} 0 1 1 ${p(R, Math.PI / 2)}A${R},${R} 0 1 1 ${p(R, -Math.PI / 2)}M${p(r, -Math.PI / 2)}A${r},${r} 0 1 0 ${p(r, Math.PI / 2)}A${r},${r} 0 1 0 ${p(r, -Math.PI / 2)}Z`
      : `M${p(R, start)}A${R},${R} 0 ${big} 1 ${p(R, end)}L${p(r, end)}A${r},${r} 0 ${big} 0 ${p(r, start)}Z`;
    return { d, color: s.other ? 'var(--faint)' : seriesColor(i), i };
  });
  const pct = (v: number) => `${((v / data.total) * 100).toFixed(v / data.total >= 0.1 ? 0 : 1)}%`;
  const shown = hover ?? null;
  return (
    <div ref={ref} className={cn('relative flex h-full items-center gap-5 px-3 pb-2', side ? 'flex-row justify-center' : 'flex-col justify-center gap-2')}
      onMouseMove={(e) => { const b = e.currentTarget.getBoundingClientRect(); setTip({ x: e.clientX - b.left, y: e.clientY - b.top }); }}
      onMouseLeave={() => { setHover(null); setTip(null); }}>
      {width > 0 && (
        <svg width={size} height={size} className="shrink-0" role="img" aria-label={data.slices.map((s) => `${s.label} ${pct(s.value)}`).join(', ')}>
          {arcs.map((a) => (
            <path key={a.i} d={a.d} fill={a.color} fillRule="evenodd" opacity={shown !== null && shown !== a.i ? 0.45 : 1}
              onMouseEnter={() => setHover(a.i)} onMouseLeave={() => setHover(null)} className="transition-opacity" />))}
          <text x={cx} y={cy - 4} textAnchor="middle" fontSize={Math.max(13, R * 0.22)} fontWeight={600} className="fill-[var(--fg)] tnum">
            {format(shown !== null ? data.slices[shown].value : data.total)}
          </text>
          <text x={cx} y={cy + Math.max(13, R * 0.2)} textAnchor="middle" fontSize="11" className="fill-[var(--muted)]">
            {shown !== null ? pct(data.slices[shown].value) : 'total'}
          </text>
        </svg>)}
      <ul className={cn('min-w-0 space-y-1', side ? 'max-w-[55%]' : 'w-full')}>
        {data.slices.map((s, i) => (
          <li key={s.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            className={cn('flex items-center gap-2 text-[12px] transition-opacity', shown !== null && shown !== i && 'opacity-50')}>
            <i className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: arcs[i].color }} />
            <span className="min-w-0 flex-1 truncate text-muted" title={s.other ? `${s.other} more, together` : s.label}>{s.label}</span>
            <span className="shrink-0 tnum text-fg">{pct(s.value)}</span>
            <span className="w-[64px] shrink-0 text-right tnum text-faint">{format(s.value)}</span>
          </li>))}
        {data.dropped > 0 && <li className="pt-1 text-[11px] text-faint">{data.dropped} negative value{data.dropped === 1 ? '' : 's'} left out</li>}
      </ul>
      {shown !== null && tip && <Tip x={tip.x} y={tip.y} width={width} height={height} title={data.slices[shown].other ? `Other: ${data.slices[shown].other} more` : data.slices[shown].label} rows={[{ label: 'Share', value: pct(data.slices[shown].value) }, { label: 'Value', value: format(data.slices[shown].value) }]} />}
    </div>
  );
}

// ---------------------------------------------------------------- scatter

export function XYScatter({ data, height, xLabel, yLabel, format, axisFormat }: { data: ScatterData; height: number; xLabel: string; yLabel: string } & Fmt) {
  const [ref, width] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ p: number; x: number; y: number } | null>(null);
  const legend = data.groups.length > 1;
  const h = Math.max(80, height - (legend ? 26 : 0));
  const M = { l: 48, r: 12, t: 20, b: 30 };
  const pw = Math.max(10, width - M.l - M.r), ph = Math.max(10, h - M.t - M.b);
  const xs = data.points.map((p) => p.x), ys = data.points.map((p) => p.y);
  const xr = scale(Math.min(0, ...xs), Math.max(...xs)), yr = scale(Math.min(0, ...ys), Math.max(...ys));
  const sx = (v: number) => M.l + ((v - xr.lo) / (xr.hi - xr.lo)) * pw;
  const sy = (v: number) => M.t + ph - ((v - yr.lo) / (yr.hi - yr.lo)) * ph;
  return (
    <div className="flex h-full flex-col">
      {legend && <Legend items={data.groups.map((g, i) => ({ label: g, color: g === 'Other' && i === data.groups.length - 1 && data.groups.length > 7 ? 'var(--faint)' : seriesColor(i) }))} />}
      <div ref={ref} className="relative min-h-0 flex-1"
        onMouseMove={(e) => {
          const b = e.currentTarget.getBoundingClientRect();
          const mx = e.clientX - b.left, my = e.clientY - b.top;
          // the nearest dot within reach (a bigger target than the dot)
          let best = -1, bd = 14 * 14;
          data.points.forEach((p, i) => { const d = (sx(p.x) - mx) ** 2 + (sy(p.y) - my) ** 2; if (d < bd) { bd = d; best = i; } });
          setHover(best >= 0 ? { p: best, x: mx, y: my } : null);
        }}
        onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={h} className="block">
            {yr.ticks.map((t) => (
              <g key={`y${t}`}>
                <line x1={M.l} x2={M.l + pw} y1={sy(t)} y2={sy(t)} stroke="var(--line)" />
                <text x={M.l - 8} y={sy(t)} dy=".32em" textAnchor="end" fontSize="10.5" className="fill-faint tnum">{axisFormat(t)}</text>
              </g>))}
            {xr.ticks.map((t) => (
              <text key={`x${t}`} x={sx(t)} y={M.t + ph + 15} textAnchor="middle" fontSize="10.5" className="fill-faint tnum">{compact(t)}</text>))}
            <text x={M.l + pw} y={M.t + ph + 28} textAnchor="end" fontSize="10.5" className="fill-[var(--muted)]">{xLabel} →</text>
            <text x={M.l - 8} y={9} textAnchor="start" fontSize="10.5" className="fill-[var(--muted)]">↑ {yLabel}</text>
            {data.points.map((p, i) => (
              <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={hover?.p === i ? 5.5 : 4}
                fill={data.groups.length > 7 && p.group === data.groups.length - 1 ? 'var(--faint)' : seriesColor(p.group)}
                fillOpacity={hover && hover.p !== i ? 0.5 : 0.9} stroke="var(--raised)" strokeWidth={2} />))}
          </svg>)}
        {hover && (() => {
          const p = data.points[hover.p];
          return <Tip x={hover.x} y={hover.y} width={width} height={h} title={p.label || undefined}
            rows={[{ label: xLabel, value: compact(p.x) }, { label: yLabel, value: format(p.y) }, ...(legend ? [{ label: 'Group', value: data.groups[p.group] }] : [])]} />;
        })()}
      </div>
    </div>
  );
}
