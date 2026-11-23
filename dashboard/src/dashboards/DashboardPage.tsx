import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, LayoutGrid, Move, MoreHorizontal, Pin, Plus, Trash2 } from 'lucide-react';
import type { DashboardConfig, DashboardTile } from '../api/contract';
import { useDashboard, useDashboards, useDeleteDashboard, useDuplicateDashboard, useUpdateDashboard } from '../api/hooks';
import { cn, relTime } from '../lib/format';
import { currentFilters, filtersParam, useFilters } from '../lib/filters';
import { isKiosk } from '../lib/kiosk';
import { useProject } from '../lib/project';
import { navigate, pageHref, useRoute, useSetParams } from '../lib/router';
import { useTime } from '../lib/time';
import { FilterChips, ReadOnlyFilters } from '../ui/FilterBar';
import { Popover } from '../ui/Popover';
import { Button, Card, Dialog, Drawer, EmptyState, ErrorState, Skeleton, useToast } from '../ui/kit';
import { NewDashboardDialog } from './DashboardsPage';
import { Grid } from './Grid';
import { defaultSize, freeSpot } from './layout';
import { BUILTIN, type MeasureDef } from './measures';
import { useTileData } from './Tile';
import { TileEditor } from './TileEditor';
import { TileFrame } from './TileFrame';

const SAVE_DELAY = 600;
/** One click to a first tile, on an empty dashboard. */
const STARTERS = ['pageviews', 'sessions', 'errors', 'vital:lcp', 'span-p95', 'error-logs', 'uptime'];

const newId = () => Math.random().toString(36).slice(2, 10);

/** A custom dashboard. On a kiosk (`readOnly`) it only shows, and picks up members' edits by polling. */
export function DashboardPage({ id, readOnly = isKiosk(), pollMs }: { id: string; readOnly?: boolean; pollMs?: number }) {
  const { project } = useProject();
  const { range } = useTime();
  const route = useRoute();
  const set = useSetParams();
  const toast = useToast();
  const dash = useDashboard(project.id, id, readOnly ? pollMs ?? 30_000 : undefined);
  const update = useUpdateDashboard(project.id);
  const [filters, setFilters] = useFilters('events');
  const filtersKey = filtersParam('events');

  // local copy of the config: edits show at once and are saved shortly after
  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { if (dash.data && !dirty.current) setConfig(dash.data.config); }, [dash.data]);
  const flush = useCallback((next: DashboardConfig) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    update.mutate({ id, input: { config: next } }, {
      onSettled: () => { if (!timer.current) dirty.current = false; },
      onError: (e) => { toast({ title: 'Could not save the dashboard', body: (e as Error).message, tone: 'bad' }); void dash.refetch(); },
    });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = useRef<DashboardConfig | null>(null);
  const change = (next: DashboardConfig) => {
    setConfig(next);
    dirty.current = true;
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; flush(next); }, SAVE_DELAY);
  };
  // leaving the page saves right away
  useEffect(() => () => { if (timer.current && pending.current) flush(pending.current); }, [flush]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (timer.current) e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // the dashboard's default range and filters apply when the link doesn't say otherwise
  const applied = useRef(false);
  useEffect(() => {
    if (!dash.data || applied.current) return;
    applied.current = true;
    const c = dash.data.config;
    const patch: Record<string, string | null> = {};
    if (c.range && !route.params.get('range') && !route.params.get('from')) patch.range = c.range;
    if (c.filters?.length && !currentFilters('events').length) patch.f = JSON.stringify(c.filters);
    if (Object.keys(patch).length) set(patch);
  }, [dash.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const [editing, setEditing] = useState(false);
  const [editor, setEditor] = useState<{ tile: DashboardTile | null } | null>(() => (route.params.get('add') === '1' ? { tile: null } : null));
  useEffect(() => { if (route.params.get('add')) set({ add: null }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (dash.isError) return <ErrorState error={dash.error} retry={() => dash.refetch()} />;
  if (!dash.data || !config) return <div className="space-y-4"><Skeleton className="h-9 w-72" /><Skeleton className="h-[320px]" /></div>;

  const tiles = config.tiles;
  const place = (t: DashboardTile, others = tiles) => ({ ...t, layout: { ...freeSpot(others, Math.min(t.layout.w, 12), t.layout.h) } });
  const saveTile = (t: DashboardTile) => {
    const exists = tiles.some((x) => x.id === t.id);
    change({ ...config, tiles: exists ? tiles.map((x) => (x.id === t.id ? t : x)) : [...tiles, place(t)] });
    setEditor(null);
    if (!exists) setTimeout(() => document.getElementById(`tile-${t.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 300);
  };
  const quickAdd = (d: MeasureDef) => saveTile({ id: newId(), viz: d.viz, measures: [d.measure], layout: { x: 0, y: 0, ...defaultSize(d.viz) } });

  return (
    <>
      <div className="space-y-3">
        <Header name={dash.data.name} id={id} readOnly={readOnly} editing={editing} saving={update.isPending || !!timer.current}
          updatedAt={dash.data.updatedAt} onEdit={() => setEditing(!editing)} onAdd={() => setEditor({ tile: null })}
          onSaveDefaults={() => {
            const r = route.params.get('range');
            change({ ...config, filters: filters.length ? filters : undefined, range: r && r !== 'custom' ? r : undefined });
            toast({ title: 'Saved as the dashboard’s default', body: 'Anyone opening it starts with this range and these filters.', tone: 'good' });
          }} />
        {readOnly ? (filters.length > 0 && <ReadOnlyFilters filters={filters} />) : (
          <FilterChips scope="events" value={filters} onChange={setFilters}>
            {filters.length > 0 && <span className="text-[11.5px] text-faint">Apply to web measures (events)</span>}
          </FilterChips>
        )}

        {!tiles.length ? (
          <Card className="p-6">
            <EmptyState icon={<LayoutGrid size={22} />} title="Add your first tile"
              action={!readOnly && <Button variant="primary" onClick={() => setEditor({ tile: null })}><Plus size={14} />Add tile</Button>}>
              {readOnly ? 'This dashboard is empty.' : 'Pick anything WGO measures. Or start with one of these:'}
            </EmptyState>
            {!readOnly && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {STARTERS.map((sid) => BUILTIN.find((d) => d.id === sid)!).map((d) => (
                  <Button key={d.id} size="sm" onClick={() => quickAdd(d)}><Plus size={12} />{d.label}</Button>))}
              </div>)}
          </Card>
        ) : (
          <Grid tiles={tiles} editing={editing && !readOnly} onChange={(next) => change({ ...config, tiles: next })}
            render={(t, h) => (
              <div id={`tile-${t.id}`} className="h-full">
                <LiveTile tile={t} height={h} editing={editing} readOnly={readOnly} filters={filtersKey}
                  onEdit={() => setEditor({ tile: t })}
                  onDuplicate={() => { const c = { ...t, id: newId() }; change({ ...config, tiles: [...tiles, place(c)] }); }}
                  onRemove={() => change({ ...config, tiles: tiles.filter((x) => x.id !== t.id) })} />
              </div>)} />
        )}
        {!readOnly && tiles.length > 0 && !editing && (
          <button onClick={() => setEditor({ tile: null })} className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed border-line py-4 text-[12.5px] text-muted transition-colors hover:border-[var(--line-strong)] hover:text-fg cursor-pointer">
            <Plus size={14} />Add tile
          </button>)}
      </div>
      <Drawer open={!!editor} onClose={() => setEditor(null)} width={720} title={editor?.tile ? 'Edit tile' : 'Add a tile'}>
        {editor && <TileEditor initial={editor.tile} range={range} filters={filtersKey} onSave={saveTile} onClose={() => setEditor(null)} />}
      </Drawer>
    </>
  );
}

function LiveTile({ tile, height, filters, ...rest }: { tile: DashboardTile; height: number; filters: string | undefined; editing: boolean; readOnly: boolean; onEdit: () => void; onDuplicate: () => void; onRemove: () => void }) {
  const { project } = useProject();
  const { range } = useTime();
  const data = useTileData(project.id, tile, range, filters);
  return <TileFrame data={data} height={height} filtered={!!filters} {...rest} />;
}

function Header({ name, id, readOnly, editing, saving, updatedAt, onEdit, onAdd, onSaveDefaults }: {
  name: string; id: string; readOnly: boolean; editing: boolean; saving: boolean; updatedAt: string;
  onEdit: () => void; onAdd: () => void; onSaveDefaults: () => void;
}) {
  const { project } = useProject();
  const route = useRoute();
  const toast = useToast();
  const update = useUpdateDashboard(project.id);
  const duplicate = useDuplicateDashboard(project.id);
  const del = useDeleteDashboard(project.id);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const [menu, setMenu] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [creating, setCreating] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const switchRef = useRef<HTMLButtonElement>(null);
  const rename = () => {
    const n = draft.trim();
    if (!n) { setDraft(name); return; }
    if (n !== name) update.mutate({ id, input: { name: n } }, { onError: (e) => toast({ title: 'Could not rename', body: (e as Error).message, tone: 'bad' }) });
  };

  if (readOnly) return null; // a kiosk shows the name in its own header
  const item = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--hl)] cursor-pointer';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {editing ? (
          <input className="field !h-9 max-w-[420px] !text-[16px] font-semibold" value={draft} maxLength={120} aria-label="Dashboard name"
            onChange={(e) => setDraft(e.target.value)} onBlur={rename} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        ) : (
          <button ref={switchRef} onClick={() => setSwitcher(!switcher)} className="flex min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 hover:bg-[var(--hl)] cursor-pointer" title="Switch dashboard">
            <h2 className="truncate text-[18px] font-semibold tracking-tight">{name}</h2><ChevronDown size={16} className="shrink-0 text-faint" />
          </button>)}
        <span className="ml-2 hidden shrink-0 text-[11.5px] text-faint sm:inline">{saving ? 'Saving…' : `Saved ${relTime(updatedAt)}`}</span>
      </div>
      <Button onClick={onEdit} variant={editing ? 'primary' : 'secondary'} title={editing ? 'Done arranging' : 'Move, resize, duplicate and remove tiles'}>
        {editing ? <><Check size={14} />Done</> : <><Move size={14} />Arrange</>}
      </Button>
      {!editing && <Button variant="primary" onClick={onAdd}><Plus size={14} />Add tile</Button>}
      <button ref={menuRef} onClick={() => setMenu(!menu)} className="grid h-9 w-9 place-items-center rounded-lg border border-line text-muted hover:text-fg cursor-pointer" title="More"><MoreHorizontal size={16} /></button>

      <Popover anchor={switchRef} open={switcher} onClose={() => setSwitcher(false)} align="start" width={300}>
        <DashboardSwitcher current={id} onPick={() => setSwitcher(false)} onNew={() => { setSwitcher(false); setCreating(true); }} />
      </Popover>
      <Popover anchor={menuRef} open={menu} onClose={() => setMenu(false)} width={290}>
        <div className="p-1.5">
          <button className={item} onClick={() => { setMenu(false); onSaveDefaults(); }}><Pin size={14} />Save range and filters as default</button>
          <button className={item} onClick={() => { setMenu(false); duplicate.mutate(id, { onSuccess: (d) => navigate(pageHref(project.id, `dashboards/${d.id}`, route.params)) }); }}><Copy size={14} />Duplicate dashboard</button>
          <button className={cn(item, 'text-bad')} onClick={() => { setMenu(false); setConfirm(true); }}><Trash2 size={14} />Delete dashboard</button>
        </div>
      </Popover>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={`Delete “${name}”?`}
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => del.mutate(id, { onSuccess: () => navigate(pageHref(project.id, 'dashboards', route.params)) })}>Delete</Button></>}>
        <p className="text-[13px] text-muted">The dashboard is removed for everyone in {project.name}, and kiosk screens showing it go blank. The data it shows is not affected.</p>
      </Dialog>
      {creating && <NewDashboardDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function DashboardSwitcher({ current, onPick, onNew }: { current: string; onPick: () => void; onNew: () => void }) {
  const { project } = useProject();
  const route = useRoute();
  const list = useDashboards(project.id);
  const go = (to: string) => { onPick(); navigate(pageHref(project.id, to, route.params)); };
  return (
    <div className="p-1.5">
      <div className="max-h-[300px] overflow-y-auto">
        {list.data?.map((d) => (
          <button key={d.id} onClick={() => go(`dashboards/${d.id}`)} className={cn('flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--hl)] cursor-pointer', d.id === current && 'text-accent')}>
            <span className="truncate">{d.name}</span><span className="shrink-0 text-[11px] text-faint">{d.tiles}</span>
          </button>))}
      </div>
      <div className="mt-1 border-t border-line pt-1">
        <button onClick={onNew} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--hl)] cursor-pointer"><Plus size={13} />New dashboard</button>
        <button onClick={() => go('dashboards')} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--hl)] cursor-pointer"><LayoutGrid size={13} />All dashboards</button>
      </div>
    </div>
  );
}
