import type { TileLayout, TileViz } from '../api/contract';

/** The dashboard grid: 12 columns, rows of fixed height. Pure layout maths, used by Grid.tsx. */
export const COLS = 12;
export const MAX_H = 12;

export interface Placed { id: string; layout: TileLayout }

export const overlaps = (a: TileLayout, b: TileLayout) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function clamp(l: TileLayout): TileLayout {
  const w = Math.max(1, Math.min(COLS, Math.round(l.w)));
  const h = Math.max(1, Math.min(MAX_H, Math.round(l.h)));
  return { w, h, x: Math.max(0, Math.min(COLS - w, Math.round(l.x))), y: Math.max(0, Math.round(l.y)) };
}

const byPosition = (a: Placed, b: Placed) => a.layout.y - b.layout.y || a.layout.x - b.layout.x;

/**
 * Resolve overlaps and float everything up (gravity). `fixedId`, the tile being dragged, keeps its place and the
 * others move out of its way; the rest keep their order, top to bottom.
 */
export function settle(items: Placed[], fixedId?: string): Placed[] {
  const fixed = fixedId ? items.find((t) => t.id === fixedId) : undefined;
  const placed: Placed[] = fixed ? [{ id: fixed.id, layout: clamp(fixed.layout) }] : [];
  for (const t of [...items].filter((x) => x !== fixed).sort(byPosition)) {
    const l = clamp(t.layout);
    const hit = (y: number) => placed.some((p) => overlaps({ ...l, y }, p.layout));
    let y = l.y;
    while (y > 0 && !hit(y - 1)) y--;
    while (hit(y)) y++;
    placed.push({ id: t.id, layout: { ...l, y } });
  }
  // back in the caller's order, so tile order in the config stays stable
  const at = new Map(placed.map((p) => [p.id, p.layout]));
  return items.map((t) => ({ id: t.id, layout: at.get(t.id)! }));
}

/** First free spot for a new w×h tile, scanning rows top to bottom (fills gaps before growing the dashboard). */
export function freeSpot(items: Placed[], w: number, h: number): TileLayout {
  const width = Math.min(COLS, w);
  for (let y = 0; ; y++) {
    for (let x = 0; x + width <= COLS; x++) {
      const l = { x, y, w: width, h };
      if (!items.some((t) => overlaps(l, t.layout))) return l;
    }
  }
}

export const bottom = (items: Placed[]) => items.reduce((m, t) => Math.max(m, t.layout.y + t.layout.h), 0);

const SIZES: Record<TileViz, { w: number; h: number }> = {
  number: { w: 3, h: 2 }, line: { w: 6, h: 4 }, area: { w: 6, h: 4 }, bars: { w: 6, h: 4 }, top: { w: 4, h: 4 }, table: { w: 6, h: 4 }, text: { w: 6, h: 2 },
  columns: { w: 6, h: 4 }, pie: { w: 4, h: 4 }, scatter: { w: 6, h: 4 },
};
/** The size a new tile of a chart type starts at. */
export const defaultSize = (viz: TileViz) => SIZES[viz];
