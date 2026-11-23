import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { DashboardTile, TileLayout } from '../api/contract';
import { useSize } from '../charts/util';
import { cn } from '../lib/format';
import { bottom, clamp, COLS, settle } from './layout';
import { GAP, ROW_H, tileHeight } from './Tile';

/** Below this width tiles stack in one column, in reading order, and can't be dragged. */
const STACK_BELOW = 720;

interface Drag {
  id: string;
  mode: 'move' | 'resize';
  px: number; // pointer at start
  py: number;
  orig: TileLayout;
  dx: number; // pointer travel so far
  dy: number;
  live: Map<string, TileLayout>; // everyone's layout with the dragged tile at its snapped spot
}

/**
 * The dashboard grid: 12 columns, drag a tile by its header to move it and by its corner to resize it (edit mode
 * only). Others move out of the way and everything floats up. Changes are reported once, on release.
 */
export function Grid({ tiles, editing, onChange, render }: {
  tiles: DashboardTile[];
  editing: boolean;
  onChange: (tiles: DashboardTile[]) => void;
  render: (tile: DashboardTile, bodyHeight: number) => ReactNode;
}) {
  const [ref, width] = useSize<HTMLDivElement>();
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const stacked = width > 0 && width < STACK_BELOW;
  const colW = (width - GAP * (COLS - 1)) / COLS;
  const px = {
    x: (x: number) => x * (colW + GAP),
    y: (y: number) => y * (ROW_H + GAP),
    w: (w: number) => w * colW + (w - 1) * GAP,
    h: tileHeight,
  };

  // stored layouts can overlap (an API or MCP edit): shown resolved, saved that way on the next arrangement
  const placed = useMemo(() => new Map(settle(tiles.map((t) => ({ id: t.id, layout: t.layout }))).map((p) => [p.id, p.layout])), [tiles]);
  const base = (t: DashboardTile) => placed.get(t.id) ?? t.layout;
  const layoutOf = (t: DashboardTile) => drag?.live.get(t.id) ?? base(t);

  const start = (e: React.PointerEvent, t: DashboardTile, mode: Drag['mode']) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const d: Drag = { id: t.id, mode, px: e.clientX, py: e.clientY, orig: base(t), dx: 0, dy: 0, live: new Map(tiles.map((x) => [x.id, base(x)])) };
    dragRef.current = d;
    setDrag(d);
  };
  const move = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.px, dy = e.clientY - d.py;
    const cx = Math.round(dx / (colW + GAP)), cy = Math.round(dy / (ROW_H + GAP));
    const want = clamp(d.mode === 'move'
      ? { ...d.orig, x: d.orig.x + cx, y: d.orig.y + cy }
      : { ...d.orig, w: Math.min(COLS - d.orig.x, d.orig.w + cx), h: d.orig.h + cy });
    const next = settle(tiles.map((t) => ({ id: t.id, layout: t.id === d.id ? want : base(t) })), d.id);
    const nd = { ...d, dx, dy, live: new Map(next.map((p) => [p.id, p.layout])) };
    dragRef.current = nd;
    setDrag(nd);
  };
  const end = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d || (d.dx === 0 && d.dy === 0)) return;
    const final = new Map(settle(tiles.map((t) => ({ id: t.id, layout: d.live.get(t.id) ?? base(t) }))).map((p) => [p.id, p.layout]));
    if (tiles.some((t) => JSON.stringify(final.get(t.id)) !== JSON.stringify(t.layout))) {
      onChange(tiles.map((t) => ({ ...t, layout: final.get(t.id)! })));
    }
  };

  if (stacked) {
    const ordered = [...tiles].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
    return (
      <div ref={ref} className="space-y-3">
        {ordered.map((t) => {
          const h = t.viz === 'number' ? tileHeight(Math.min(2, t.layout.h)) : Math.max(tileHeight(3), Math.min(tileHeight(t.layout.h), 360));
          return <div key={t.id} style={{ height: h }}>{render(t, h)}</div>;
        })}
      </div>
    );
  }

  const rows = Math.max(bottom(tiles.map((t) => ({ id: t.id, layout: layoutOf(t) }))), 1) + (editing ? 2 : 0);
  return (
    <div ref={ref} className="relative" style={{ height: width ? px.y(rows) - GAP : undefined }} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      {editing && width > 0 && (
        // faint column guides while arranging
        <div className="pointer-events-none absolute inset-0 grid gap-4" style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` }}>
          {Array.from({ length: COLS }, (_, i) => <div key={i} className="rounded-md bg-[var(--hl)] opacity-40" />)}
        </div>)}
      {width > 0 && drag && (() => {
        const l = drag.live.get(drag.id)!;
        return <div className="absolute rounded-2xl border-2 border-dashed border-accent/50 bg-accent/5" style={{ left: px.x(l.x), top: px.y(l.y), width: px.w(l.w), height: px.h(l.h) }} />;
      })()}
      {width > 0 && tiles.map((t) => {
        const l = layoutOf(t);
        const active = drag?.id === t.id;
        // the dragged tile follows the pointer; the placeholder shows where it will land
        const box = active
          ? drag.mode === 'move'
            ? { left: px.x(drag.orig.x) + drag.dx, top: px.y(drag.orig.y) + drag.dy, width: px.w(drag.orig.w), height: px.h(drag.orig.h) }
            : { left: px.x(drag.orig.x), top: px.y(drag.orig.y), width: Math.max(colW, px.w(drag.orig.w) + drag.dx), height: Math.max(ROW_H, px.h(drag.orig.h) + drag.dy) }
          : { left: px.x(l.x), top: px.y(l.y), width: px.w(l.w), height: px.h(l.h) };
        return (
          <div key={t.id} className={cn('absolute', active ? 'z-20 opacity-90 shadow-2xl' : 'transition-[left,top,width,height] duration-200 ease-out')} style={box}
            onPointerDown={editing ? (e) => {
              const el = e.target as HTMLElement;
              if (el.closest('[data-drag-handle]') && !el.closest('button,a,input,select,textarea')) start(e, t, 'move');
            } : undefined}>
            {render(t, box.height)}
            {editing && (
              <div onPointerDown={(e) => start(e, t, 'resize')} title="Drag to resize"
                className="absolute bottom-0 right-0 z-10 h-5 w-5 cursor-se-resize touch-none">
                <svg viewBox="0 0 10 10" className="absolute bottom-1.5 right-1.5 h-2.5 w-2.5 text-faint"><path d="M9 1 L1 9 M9 5 L5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
              </div>)}
          </div>
        );
      })}
    </div>
  );
}
