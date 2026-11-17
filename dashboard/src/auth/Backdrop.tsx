import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { kick, push, reducedMotion, useRepel, useStep } from './antigravity';

/**
 * The animated branding behind the sign-in screens: drifting colour fields, a faint dot grid, a live-looking chart line
 * that scrolls along the bottom and the odd event ping. The dots, pings and chart lines give way to the pointer (antigravity.ts);
 * the rest is CSS animation (index.css, "Sign-in screens"). With prefers-reduced-motion everything holds still.
 */

const W = 1440;
const H = 240;
/** Horizontal distance between line points, in viewBox units. */
const STEP = 6;
/** Points in one period; the path draws two periods so the CSS scroll can wrap from -50% back to 0 unnoticed. */
const PERIOD = W / STEP;

/** One period of a chart line: sines with whole-number frequencies, so the path repeats seamlessly when tiled. */
function series(waves: Array<[freq: number, amp: number, phase: number]>, base: number) {
  const ys = new Float32Array(PERIOD);
  for (let i = 0; i < PERIOD; i++) {
    const t = (i / PERIOD) * Math.PI * 2;
    ys[i] = Math.max(4, Math.min(H - 2, base + waves.reduce((s, [f, a, p]) => s + a * Math.sin(f * t + p), 0)));
  }
  return ys;
}
const FRONT = series([[2, 26, 0.4], [3, 18, 2.1], [7, 9, 1.3], [17, 5, 0.2], [31, 3, 4.0]], 130);
const BACK = series([[1, 30, 1.9], [4, 16, 0.7], [9, 8, 2.8], [23, 4, 1.1]], 150);

function pathOf(ys: Float32Array, off: Float32Array | null) {
  let d = '';
  for (let i = 0; i <= PERIOD * 2; i++) {
    const k = i % PERIOD;
    d += `${i ? ' L' : 'M'}${i * STEP},${(ys[k] + (off ? off[k] : 0)).toFixed(1)}`;
  }
  return d;
}

/**
 * A scrolling chart line that bends away from the pointer and springs back. The bend belongs to the points, so it
 * travels with the line; both drawn periods share one set of offsets, so it survives the scroll wrapping round.
 */
function Line({ ys, cls, fill, strength }: { ys: Float32Array; cls: string; fill: boolean; strength: number }) {
  const id = useId();
  const svg = useRef<SVGSVGElement>(null);
  const stroke = useRef<SVGPathElement>(null);
  const area = useRef<SVGPathElement>(null);
  const st = useRef({ off: new Float32Array(PERIOD), v: new Float32Array(PERIOD), bent: false });
  const d0 = pathOf(ys, null);

  useStep((p, n) => {
    const el = svg.current;
    if (!el) return false;
    const { off, v } = st.current;
    const r = el.getBoundingClientRect();
    const sx = r.width / (W * 2), sy = r.height / H;
    const R = 190;
    // in reach: the line keeps scrolling under a still pointer, so keep bending it every frame
    const near = !!p && p.y > r.top - R && p.y < r.bottom + R;
    const px = near ? (p!.x - r.left) / sx : 0, py = near ? (p!.y - r.top) / sy : 0;
    const damp = 0.85 ** n;
    let moving = false, bent = false;
    for (let k = 0; k < PERIOD; k++) {
      let f = 0;
      if (near) {
        // whichever of the two drawn copies of this point is closer to the pointer
        const x = k * STEP, dxa = (x - px) * sx, dxb = (x + W - px) * sx;
        const dx = Math.abs(dxa) < Math.abs(dxb) ? dxa : dxb;
        if (dx < R && dx > -R) {
          const dy = (ys[k] + off[k] - py) * sy;
          const g = push(Math.hypot(dx, dy), R, strength);
          // straight up or down, away from the pointer
          if (g) f = (dy < 0 ? -g : g) / sy;
        }
      }
      if (!f && !off[k] && !v[k]) continue;
      v[k] = (v[k] + (f - off[k] * 0.04) * n) * damp;
      off[k] += v[k] * n;
      if (Math.abs(v[k]) > 0.01) moving = true;
      else if (!f && Math.abs(off[k]) < 0.2) { off[k] = v[k] = 0; continue; }
      bent = true;
    }
    if (bent || st.current.bent) {
      const d = bent ? pathOf(ys, off) : d0;
      stroke.current?.setAttribute('d', d);
      area.current?.setAttribute('d', `${d} L${W * 2},${H} L0,${H} Z`);
    }
    st.current.bent = bent;
    return moving || near;
  }, !reducedMotion());

  return (
    <svg ref={svg} className={cls} viewBox={`0 0 ${W * 2} ${H}`} preserveAspectRatio="none" overflow="visible" aria-hidden>
      <defs>
        <linearGradient id={`${id}s`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="var(--accent)" /><stop offset=".5" stopColor="var(--accent2)" /><stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
        <linearGradient id={`${id}f`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity=".22" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path ref={area} d={`${d0} L${W * 2},${H} L0,${H} Z`} fill={`url(#${id}f)`} />}
      <path ref={stroke} d={d0} fill="none" stroke={`url(#${id}s)`} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A dot grid on a canvas whose dots are pushed away by the pointer and spring back, lighting up while displaced. */
function DotField() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const f = useRef({ w: 0, h: 0, dpr: 1, n: 0, hx: new Float32Array(), hy: new Float32Array(), base: new Float32Array(),
    ox: new Float32Array(), oy: new Float32Array(), vx: new Float32Array(), vy: new Float32Array(), fg: '#fff', hot: '#22d3ee' });

  const draw = (p: { x: number; y: number } | null) => {
    const c = canvas.current, ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const { w, h, dpr, n, hx, hy, base, ox, oy, fg, hot } = f.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = fg;
    for (let i = 0; i < n; i++) {
      const x = hx[i] + ox[i], y = hy[i] + oy[i];
      // a soft light around the pointer shows the grid even where it fades out
      const a = base[i] + (p ? push(Math.hypot(x - p.x, y - p.y), 240, 0.22) : 0);
      if (a < 0.01) continue;
      ctx.globalAlpha = Math.min(1, a);
      ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
    }
    ctx.fillStyle = hot;
    for (let i = 0; i < n; i++) {
      const m = Math.abs(ox[i]) + Math.abs(oy[i]);
      if (m < 1) continue;
      ctx.globalAlpha = Math.min(0.85, m / 18);
      ctx.fillRect(hx[i] + ox[i] - 1, hy[i] + oy[i] - 1, 2, 2);
    }
    ctx.globalAlpha = 1;
  };

  // Lay the grid out again whenever the canvas changes size.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const layout = () => {
      const w = c.clientWidth, h = c.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      const gap = 28, cols = Math.ceil(w / gap) + 1, rows = Math.ceil(h / gap) + 1, n = cols * rows;
      const x0 = (w - (cols - 1) * gap) / 2, y0 = (h - (rows - 1) * gap) / 2;
      const hx = new Float32Array(n), hy = new Float32Array(n), base = new Float32Array(n);
      for (let r = 0, i = 0; r < rows; r++) for (let q = 0; q < cols; q++, i++) {
        hx[i] = x0 + q * gap; hy[i] = y0 + r * gap;
        // fade towards the edges: an ellipse around the upper middle, like a spotlight on the sign-in card
        const e = Math.hypot((hx[i] - w / 2) / (w * 0.7), (hy[i] - h * 0.42) / (h * 0.6));
        base[i] = 0.1 * Math.max(0, Math.min(1, (0.75 - e) / 0.55));
      }
      const css = getComputedStyle(document.documentElement);
      Object.assign(f.current, { w, h, dpr, n, hx, hy, base, ox: new Float32Array(n), oy: new Float32Array(n), vx: new Float32Array(n), vy: new Float32Array(n),
        fg: css.getPropertyValue('--fg').trim() || '#fff', hot: css.getPropertyValue('--accent2').trim() || '#22d3ee' });
      draw(null);
      kick();
    };
    const ro = new ResizeObserver(layout);
    ro.observe(c);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useStep((p, steps) => {
    const c = canvas.current;
    if (!c) return false;
    const { n, hx, hy, ox, oy, vx, vy } = f.current;
    const r = c.getBoundingClientRect();
    const px = p ? p.x - r.left : 0, py = p ? p.y - r.top : 0;
    const R = 130, spring = 0.05, damp = 0.86 ** steps;
    let moving = false;
    for (let i = 0; i < n; i++) {
      let fx = 0, fy = 0;
      if (p) {
        const dx = hx[i] + ox[i] - px, dy = hy[i] + oy[i] - py;
        if (dx < R && dx > -R && dy < R && dy > -R) {
          const d = Math.hypot(dx, dy), k = push(d, R, 1.5);
          if (k && d > 0.01) { fx = (dx / d) * k; fy = (dy / d) * k; }
        }
      }
      if (!fx && !fy && !ox[i] && !oy[i] && !vx[i] && !vy[i]) continue;
      vx[i] = (vx[i] + (fx - ox[i] * spring) * steps) * damp;
      vy[i] = (vy[i] + (fy - oy[i] * spring) * steps) * damp;
      ox[i] += vx[i] * steps; oy[i] += vy[i] * steps;
      if (Math.abs(vx[i]) + Math.abs(vy[i]) > 0.01) moving = true;
      else if (!fx && !fy && Math.abs(ox[i]) + Math.abs(oy[i]) < 0.2) { ox[i] = oy[i] = vx[i] = vy[i] = 0; }
    }
    draw(p ? { x: px, y: py } : null);
    return moving;
  }, !reducedMotion());

  return <canvas ref={canvas} className="absolute inset-0 h-full w-full" />;
}

/** Wraps something so it drifts away from the pointer. */
export function Float({ children, className, style, ...o }: Parameters<typeof useRepel>[1] & { children?: ReactNode; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  useRepel(ref, o);
  return <span ref={ref} className={className ?? 'inline-block will-change-transform'} style={style}>{children}</span>;
}

/** Where events "arrive": left/top in %, delay in s. */
const PINGS: Array<[number, number, number]> = [
  [14, 22, 0], [82, 16, 2.6], [70, 64, 5.1], [24, 70, 1.4], [90, 44, 3.9], [8, 48, 6.3], [56, 12, 4.6],
];

export function Backdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden>
      <div className="brand-orb brand-orb-1" />
      <div className="brand-orb brand-orb-2" />
      <div className="brand-orb brand-orb-3" />
      <DotField />
      {PINGS.map(([l, t, d], i) => (
        <Float key={i} className="absolute will-change-transform" style={{ left: `${l}%`, top: `${t}%` }} radius={170} strength={3.2} spring={0.04} damping={0.88} tilt={0}>
          <span className="brand-ping" style={{ animationDelay: `${d}s`, color: i % 2 ? 'var(--accent2)' : 'var(--accent)' }} />
        </Float>
      ))}
      <div className="brand-chart absolute inset-x-0 bottom-0 h-[46vh] min-h-[240px]">
        <Line ys={BACK} cls="brand-line brand-line-back" fill={false} strength={2.6} />
        <Line ys={FRONT} cls="brand-line brand-line-front" fill strength={4} />
      </div>
    </div>
  );
}

/** The logo mark at hero size: the line draws itself in, then the live dot keeps a slow pulse. */
export function BrandMark({ size = 64 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="brand-mark overflow-visible" aria-hidden>
      <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#8b7cf6" /><stop offset="1" stopColor="#22d3ee" /></linearGradient></defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id})`} opacity=".16" />
      <rect x=".5" y=".5" width="31" height="31" rx="8.5" fill="none" stroke={`url(#${id})`} opacity=".6" />
      <path className="brand-mark-line" pathLength={1} d="M7 21.5 12.5 14l5 4.2L25 9" fill="none" stroke={`url(#${id})`} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle className="brand-mark-halo" cx="25" cy="9" r="2.2" fill="none" stroke="#22d3ee" strokeWidth=".8" />
      <circle className="brand-mark-dot" cx="25" cy="9" r="2.2" fill="#22d3ee" />
    </svg>
  );
}
