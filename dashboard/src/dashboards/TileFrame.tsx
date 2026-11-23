import { Copy, GripVertical, Pencil, Trash2 } from 'lucide-react';
import type { DashboardTile } from '../api/contract';
import { fieldLabel } from '../lib/filters';
import { cn } from '../lib/format';
import { Card } from '../ui/kit';
import { measureLabel } from './measures';
import { HEADER_H, TileBody, type TileData } from './Tile';

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** The title a tile shows when it has none of its own: what it measures, and how it's split. */
export function tileTitle(t: DashboardTile): string {
  if (t.title) return t.title;
  if (t.viz === 'text') return 'Note';
  if (!t.measures.length) return 'New tile';
  const names = t.measures.map(measureLabel);
  // two lines on one chart compare; a row of numbers or a table lists
  const what = names.length === 2 && t.viz !== 'number' && t.viz !== 'table' ? names.join(' vs ') : LIST.format(names);
  return t.groupBy && t.measures.length === 1 ? `${what} by ${fieldLabel(t.groupBy).toLowerCase()}` : what;
}

/** A tile on the dashboard: header (the drag handle while arranging) and its chart. */
export function TileFrame({ data, height, editing, readOnly, filtered, onEdit, onDuplicate, onRemove }: {
  data: TileData;
  height: number;
  editing?: boolean;
  readOnly?: boolean;
  filtered?: boolean; // the dashboard has filters (they apply to web events measures only)
  onEdit?: () => void;
  onDuplicate?: () => void;
  onRemove?: () => void;
}) {
  const { tile } = data;
  const text = tile.viz === 'text';
  const notes: string[] = [];
  if (tile.range && data.range.preset !== 'custom') notes.push(`Last ${tile.range}`);
  if (filtered && !text && tile.measures.length && !tile.measures.some((m) => m.source === 'events')) notes.push('Dashboard filters don’t apply');
  else if (filtered && tile.measures.some((m) => m.source !== 'events') && tile.measures.some((m) => m.source === 'events')) notes.push('Filters apply to web measures only');
  const btn = 'grid h-7 w-7 place-items-center rounded-md text-faint hover:bg-[var(--hl)] hover:text-fg cursor-pointer';
  return (
    <Card className="group/tile flex h-full flex-col overflow-hidden">
      <div data-drag-handle className={cn('flex shrink-0 items-center gap-1.5 pl-4 pr-2', editing && 'cursor-grab touch-none select-none active:cursor-grabbing')} style={{ height: HEADER_H }}>
        {editing && <GripVertical size={14} className="-ml-2 shrink-0 text-faint" />}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-semibold tracking-tight" title={tileTitle(tile)}>{tileTitle(tile)}</h3>
        </div>
        {notes.length > 0 && <span className="hidden shrink-0 truncate text-[11px] text-faint sm:inline">{notes.join(' · ')}</span>}
        {!readOnly && (
          <div className={cn('flex shrink-0 items-center', !editing && 'opacity-0 transition-opacity group-hover/tile:opacity-100 focus-within:opacity-100')}>
            {onEdit && <button className={btn} onClick={onEdit} title="Edit tile"><Pencil size={13} /></button>}
            {editing && onDuplicate && <button className={btn} onClick={onDuplicate} title="Duplicate tile"><Copy size={13} /></button>}
            {editing && onRemove && <button className={cn(btn, 'hover:text-bad')} onClick={onRemove} title="Remove tile"><Trash2 size={13} /></button>}
          </div>)}
      </div>
      <div className="min-h-0 flex-1">
        <TileBody data={data} height={height - HEADER_H} />
      </div>
    </Card>
  );
}
