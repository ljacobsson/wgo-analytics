import { useState } from 'react';
import { fmtNum } from '../lib/format';

interface Props {
  /** 24 values, hour 0-23 */
  values: number[];
  /** what a value counts, for the readout ("pageviews") */
  unit: string;
  color?: string;
}

const C = 100; // centre of the 200×200 viewBox
const R_IN = 34, R_OUT = 70, R_NUM = 81, R_RIM = 97;

const polar = (r: number, turn: number): [number, number] => [C + r * Math.sin(turn * 2 * Math.PI), C - r * Math.cos(turn * 2 * Math.PI)];
const hh = (h: number) => String(h % 24).padStart(2, '0') + ':00';

/** Annular wedge for position i (0-11) on the dial. */
function wedge(i: number): string {
  const a = i / 12, b = (i + 1) / 12;
  const [x1, y1] = polar(R_OUT, a), [x2, y2] = polar(R_OUT, b), [x3, y3] = polar(R_IN, b), [x4, y4] = polar(R_IN, a);
  return `M${x1} ${y1}A${R_OUT} ${R_OUT} 0 0 1 ${x2} ${y2}L${x3} ${y3}A${R_IN} ${R_IN} 0 0 0 ${x4} ${y4}Z`;
}

/** One sequential hue: share of the busiest hour → mix of the hue into the card surface. */
const fill = (v: number, max: number, color: string) =>
  v <= 0 || max <= 0 ? 'color-mix(in srgb, var(--fg) 5%, transparent)' : `color-mix(in oklab, ${color} ${Math.round(12 + (v / max) * 88)}%, var(--raised))`;

function Face({ start, values, max, total, unit, color, hover, setHover }: {
  start: 0 | 12; values: number[]; max: number; total: number; unit: string; color: string;
  hover: number | null; setHover: (h: number | null) => void;
}) {
  const now = new Date();
  const nowH = now.getHours() + now.getMinutes() / 60;
  const showNow = nowH >= start && nowH < start + 12;
  const share = total ? values.slice(start, start + 12).reduce((a, b) => a + b, 0) / total : 0;
  const active = hover != null && hover >= start && hover < start + 12 ? hover : null;
  return (
    <svg viewBox="0 0 200 200" className="block w-full max-w-[240px] select-none" role="img"
      aria-label={`${start === 0 ? 'Midnight to noon' : 'Noon to midnight'}: ${Math.round(share * 100)}% of ${unit}`}>
      <circle cx={C} cy={C} r={R_RIM} fill="none" stroke="var(--line-strong)" strokeWidth={1.5} />
      {Array.from({ length: 60 }, (_, m) => {
        const major = m % 5 === 0;
        const [x1, y1] = polar(R_RIM - (major ? 5 : 3), m / 60), [x2, y2] = polar(R_RIM - 1, m / 60);
        return <line key={m} x1={x1} y1={y1} x2={x2} y2={y2} stroke={major ? 'var(--muted)' : 'var(--line-strong)'} strokeWidth={major ? 1.4 : 0.8} />;
      })}
      {Array.from({ length: 12 }, (_, i) => {
        const h = start + i;
        return (
          <path key={h} d={wedge(i)} fill={fill(values[h], max, color)} stroke="var(--raised)" strokeWidth={2} strokeLinejoin="round"
            className="cursor-default outline-none transition-[fill] duration-500" tabIndex={0}
            opacity={active != null && active !== h ? 0.55 : 1}
            onMouseEnter={() => setHover(h)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(h)} onBlur={() => setHover(null)}>
            <title>{`${hh(h)}–${hh(h + 1)}: ${fmtNum(values[h])} ${unit}`}</title>
          </path>
        );
      })}
      {Array.from({ length: 12 }, (_, i) => {
        const [x, y] = polar(R_NUM, i / 12);
        const h = start + i;
        return <text key={i} x={x} y={y} dy="0.35em" textAnchor="middle" fontSize={11} className={`tnum ${active === h ? 'fill-fg font-semibold' : 'fill-muted'}`}>{h}</text>;
      })}
      {showNow && (() => {
        const [x1, y1] = polar(R_OUT + 3, (nowH - start) / 12), [x2, y2] = polar(R_RIM - 1, (nowH - start) / 12);
        return <g><line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--fg)" strokeWidth={2} strokeLinecap="round" /><title>Now</title></g>;
      })()}
      {active != null ? (
        <g textAnchor="middle" className="pointer-events-none">
          <text x={C} y={C - 11} fontSize={10} className="tnum fill-muted">{hh(active)}–{hh(active + 1)}</text>
          <text x={C} y={C + 5} fontSize={15} fontWeight={600} className="tnum fill-fg">{fmtNum(values[active])}</text>
          <text x={C} y={C + 19} fontSize={9.5} className="tnum fill-faint">{total ? Math.round((values[active] / total) * 100) : 0}%</text>
        </g>
      ) : (
        <g textAnchor="middle" className="pointer-events-none">
          <text x={C} y={C - 3} fontSize={13} fontWeight={600} className="fill-fg">{start === 0 ? 'AM' : 'PM'}</text>
          <text x={C} y={C + 13} fontSize={10} className="tnum fill-faint">{Math.round(share * 100)}%</text>
        </g>
      )}
    </svg>
  );
}

/** Traffic by hour of the day as two clock faces, midnight to noon and noon to midnight, on one shared scale. */
export function ClockHeatmap({ values, unit, color = 'var(--s1)' }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  const peak = values.indexOf(max);
  const low = values.indexOf(Math.min(...values));
  return (
    <div>
      <div className="grid grid-cols-2 place-items-center gap-3">
        <Face start={0} values={values} max={max} total={total} unit={unit} color={color} hover={hover} setHover={setHover} />
        <Face start={12} values={values} max={max} total={total} unit={unit} color={color} hover={hover} setHover={setHover} />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-[11.5px] text-muted">
        <span className="tnum">Busiest {hh(peak)}–{hh(peak + 1)} · quietest {hh(low)}–{hh(low + 1)}</span>
        <span className="flex items-center gap-2 text-faint">
          <span className="tnum">0</span>
          <i className="h-2 w-24 rounded-full" style={{ background: `linear-gradient(90deg, ${fill(1, 100, color)}, ${color})` }} />
          <span className="tnum">{fmtNum(max)}</span>
        </span>
      </div>
    </div>
  );
}
