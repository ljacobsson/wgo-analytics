import { useCallback, useRef, useState } from 'react';
import { isKiosk } from '../lib/kiosk';
import { useSetParams } from '../lib/router';
import { fmtTipTime } from './util';

/**
 * Drag across a time chart to zoom in: the selected window becomes the page's time range (a custom range in the
 * URL, so every chart on the page follows and the browser's back button zooms out again).
 */

/** Narrower than this is a click, not a selection. */
const MIN_PX = 6;
/** The API's finest bucket is a minute; a few of them is as close as zooming gets. */
export const MIN_ZOOM_MS = 3 * 60_000;
const MAX_RANGE_MS = 92 * 86400e3;

/** Sets the page's range to [from, to) as a new history entry. Null on kiosks (nobody to zoom). */
export function useZoom(): ((from: number, to: number) => void) | null {
  const set = useSetParams();
  const zoom = useCallback((from: number, to: number) => {
    let a = Math.round(from), b = Math.min(Math.round(to), Date.now());
    if (b - a < MIN_ZOOM_MS) { const mid = (a + b) / 2; a = mid - MIN_ZOOM_MS / 2; b = mid + MIN_ZOOM_MS / 2; }
    set({ range: 'custom', from: new Date(a).toISOString(), to: new Date(b).toISOString() }, false);
  }, [set]);
  return isKiosk() ? null : zoom;
}

/** The window twice as long around the same middle (not past now, at most the API's 92 days). */
export function zoomedOut(from: number, to: number): [number, number] {
  const span = Math.min(MAX_RANGE_MS, (to - from) * 2);
  let b = Math.min(Date.now(), (from + to) / 2 + span / 2);
  const a = b - span;
  b = Math.max(b, a + 1);
  return [a, b];
}

/**
 * Pointer handling for a brush over a plot area that starts `left` px into the element. `toTime` maps a plot x
 * (px) to a time. Pointer capture only starts once the pointer has moved, so clicks on marks still work.
 */
export function useBrush(left: number, width: number, toTime: (px: number) => number, onZoom: ((from: number, to: number) => void) | null) {
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const start = useRef<{ x: number; id: number } | null>(null);
  const px = (e: React.PointerEvent) => Math.max(0, Math.min(width, e.clientX - e.currentTarget.getBoundingClientRect().left - left));
  const handlers = onZoom ? {
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.button !== 0) return;
      start.current = { x: px(e), id: e.pointerId };
    },
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => {
      const s = start.current;
      if (!s) return;
      const x = px(e);
      if (!sel && Math.abs(x - s.x) < MIN_PX) return;
      if (!sel) e.currentTarget.setPointerCapture(s.id);
      setSel({ a: s.x, b: x });
    },
    onPointerUp: () => {
      const s = sel;
      start.current = null;
      setSel(null);
      if (!s || Math.abs(s.b - s.a) < MIN_PX) return;
      const [a, b] = s.a < s.b ? [s.a, s.b] : [s.b, s.a];
      onZoom(toTime(a), toTime(b));
    },
    onPointerCancel: () => { start.current = null; setSel(null); },
  } : {};
  return { sel, handlers, enabled: !!onZoom };
}

/** The selection while dragging: a shaded band with its start and end time. */
export function BrushBand({ sel, height, toTime, span }: { sel: { a: number; b: number }; height: number; toTime: (px: number) => number; span: number }) {
  const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b);
  return (
    <g className="pointer-events-none">
      <rect x={a} y={0} width={b - a} height={height} fill="var(--accent)" fillOpacity={0.14} />
      <line x1={a} x2={a} y1={0} y2={height} stroke="var(--accent)" strokeWidth={1.5} />
      <line x1={b} x2={b} y1={0} y2={height} stroke="var(--accent)" strokeWidth={1.5} />
      <text x={(a + b) / 2} y={12} textAnchor="middle" fontSize="11" className="fill-fg tnum" style={{ paintOrder: 'stroke', stroke: 'var(--raised)', strokeWidth: 3 }}>
        {fmtTipTime(toTime(a), span)} – {fmtTipTime(toTime(b), span)}
      </text>
    </g>
  );
}
