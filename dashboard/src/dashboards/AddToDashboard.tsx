import { useRef, useState } from 'react';
import { PanelsTopLeft, Plus } from 'lucide-react';
import type { DashboardTile, Filter, MeasureQuery } from '../api/contract';
import { useAddTile, useCreateDashboard, useDashboards } from '../api/hooks';
import { cn } from '../lib/format';
import { isKiosk } from '../lib/kiosk';
import { useProject } from '../lib/project';
import { navigate, pageHref, useRoute } from '../lib/router';
import { Popover } from '../ui/Popover';
import { useToast } from '../ui/kit';
import { defaultSize } from './layout';

/** A tile to add: everything but its id and place, which the dashboard picks. */
export type TileDraft = Omit<DashboardTile, 'id' | 'layout'> & { layout?: Pick<DashboardTile['layout'], 'w' | 'h'> };

/** Filters as they're kept in a measure: none is no key at all. */
export const withFilters = <T extends MeasureQuery>(m: T, filters: Filter[]): T => (filters.length ? { ...m, filters } : m);

/**
 * "Add to dashboard": saves what a chart shows as a tile on a dashboard of the project (or a new one). `tile` is
 * read when clicked, so it reflects the page's current filters and options.
 */
export function AddToDashboard({ tile, className, label = true }: { tile: () => TileDraft; className?: string; label?: boolean }) {
  const { project } = useProject();
  const route = useRoute();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const anchor = useRef<HTMLButtonElement>(null);
  const list = useDashboards(project.id, open);
  const add = useAddTile(project.id);
  const create = useCreateDashboard(project.id);
  if (isKiosk()) return null;

  const build = (): Omit<DashboardTile, 'id'> & { id?: string } => {
    const t = tile();
    return { ...t, layout: { x: 0, y: 0, ...defaultSize(t.viz), ...t.layout } };
  };
  const done = (dashName: string) => {
    setOpen(false);
    toast({ title: `Added to ${dashName}`, body: 'Open it under Dashboards to move or resize the tile.', tone: 'good' });
  };
  const fail = (e: unknown) => toast({ title: 'Could not add the tile', body: (e as Error).message, tone: 'bad' });
  const addTo = (id: string, n: string) => add.mutate({ id, tile: build() }, { onSuccess: () => done(n), onError: fail });
  const createWith = () => {
    const n = name.trim() || 'My dashboard';
    const t = build();
    create.mutate({ name: n, config: { tiles: [{ ...t, id: Math.random().toString(36).slice(2, 10) }] } }, {
      onSuccess: (d) => { setOpen(false); navigate(pageHref(project.id, `dashboards/${d.id}`, route.params)); },
      onError: fail,
    });
  };
  const busy = add.isPending || create.isPending;
  return (
    <>
      <button ref={anchor} onClick={() => setOpen(!open)} title="Add this chart to a dashboard"
        className={cn('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12px] font-medium text-muted transition-colors hover:border-[var(--line-strong)] hover:text-fg cursor-pointer', className)}>
        <PanelsTopLeft size={13} />{label && <span className="hidden sm:inline">Add to dashboard</span>}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={280}>
        <div className="p-1.5">
          {list.isPending ? <div className="px-2.5 py-2 text-[12px] text-faint">Loading dashboards…</div> : (
            <div className="max-h-[260px] overflow-y-auto">
              {list.data?.map((d) => (
                <button key={d.id} disabled={busy} onClick={() => addTo(d.id, d.name)}
                  className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--hl)] disabled:opacity-50 cursor-pointer">
                  <span className="truncate">{d.name}</span><span className="shrink-0 text-[11px] text-faint">{d.tiles} tile{d.tiles === 1 ? '' : 's'}</span>
                </button>))}
            </div>)}
          <form className={cn('flex items-center gap-1.5 px-1 pb-0.5', list.data?.length ? 'mt-1 border-t border-line pt-1.5' : '')} onSubmit={(e) => { e.preventDefault(); createWith(); }}>
            <input className="field !h-8 min-w-0 flex-1 !text-[12.5px]" value={name} onChange={(e) => setName(e.target.value)} placeholder="New dashboard" maxLength={120} />
            <button disabled={busy} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line text-muted hover:text-fg disabled:opacity-50 cursor-pointer" title="Create a dashboard with this tile"><Plus size={14} /></button>
          </form>
        </div>
      </Popover>
    </>
  );
}
