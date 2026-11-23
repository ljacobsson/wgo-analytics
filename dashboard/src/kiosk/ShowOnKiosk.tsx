import { useState } from 'react';
import { Plus, Replace, Tv } from 'lucide-react';
import type { FilterScope, Kiosk, KioskScreen } from '../api/contract';
import { useCreateKiosk, useDashboard, useKiosks, useUpdateKiosk } from '../api/hooks';
import { FILTER_PARAM } from '../lib/filters';
import { isKioskPage, normParams, rangeLabel } from '../lib/kiosk';
import { useProject } from '../lib/project';
import { navigate, pageHref, useRoute } from '../lib/router';
import { useLive } from '../live/store';
import { KioskStatus, kioskPageLabel } from '../pages/Kiosks';
import { ReadOnlyFilters } from '../ui/FilterBar';
import { Button, Dialog, Skeleton, useToast } from '../ui/kit';

const MAX_SCREENS = 12;

/** Header button on pages a kiosk can show: sends the current view (page, range, filters, options) to a screen. */
export function ShowOnKioskButton({ page }: { page: string }) {
  const [open, setOpen] = useState(false);
  const route = useRoute();
  // a custom dashboard (#/p/…/dashboards/<id>) is a 'dashboard' screen
  if (!isKioskPage(page) && !(page === 'dashboards' && route.segments[3])) return null;
  return (
    <>
      <button onClick={() => setOpen(true)} title="Show this view on a kiosk screen"
        className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-[var(--hl)] px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:border-[var(--line-strong)] hover:text-fg cursor-pointer">
        <Tv size={14} /><span className="hidden lg:inline">Show on kiosk</span>
      </button>
      {open && <ShowOnKioskDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function ShowOnKioskDialog({ onClose }: { onClose: () => void }) {
  const { project } = useProject();
  const route = useRoute();
  const live = useLive();
  const toast = useToast();
  const kiosks = useKiosks(project.id);
  const update = useUpdateKiosk(project.id);
  const create = useCreateKiosk(project.id);
  const [name, setName] = useState('');

  const seg = route.segments[2] ?? 'overview';
  const dashboardId = seg === 'dashboards' ? route.segments[3] : undefined;
  const page = dashboardId ? 'dashboard' : seg;
  const dashboard = useDashboard(project.id, dashboardId ?? '', undefined, !!dashboardId);
  if (!isKioskPage(page)) return null;
  const params = new URLSearchParams(route.params);
  if (dashboardId) params.set('id', dashboardId);
  const screen: KioskScreen = { page, params: normParams(params.toString()) };
  // the Live page counts this browser's watches; the kiosk gets a copy
  if (page === 'live' && live.watches.length) screen.watches = live.watches;
  const filters = (Object.keys(FILTER_PARAM) as FilterScope[]).flatMap((s) => {
    try { return JSON.parse(route.params.get(FILTER_PARAM[s]) ?? '[]'); } catch { return []; }
  });

  const sent = (k: Kiosk) => {
    toast({ title: `Sent to ${k.name}`, body: 'The screen updates within 15 seconds.', tone: 'good' });
    onClose();
  };
  const fail = (e: unknown) => toast({ title: 'Could not update the kiosk', body: (e as Error).message, tone: 'bad' });
  const addTo = (k: Kiosk) => update.mutate({ id: k.id, config: { screens: [...k.config.screens, screen] } }, { onSuccess: sent, onError: fail });
  const replace = (k: Kiosk) => update.mutate({ id: k.id, config: { screens: [screen] } }, { onSuccess: sent, onError: fail });
  const createWith = () => create.mutate({ name: name.trim() || 'Office TV', config: { screens: [screen] } }, {
    onSuccess: (k) => { onClose(); navigate(pageHref(project.id, 'kiosks', {}, { setup: k.id })); },
    onError: fail,
  });
  const busy = update.isPending || create.isPending;

  return (
    <Dialog open onClose={onClose} width={560} title={<span className="inline-flex items-center gap-2"><Tv size={16} />Show on a kiosk</span>}>
      <div className="rounded-xl border border-line bg-[var(--hl)]/40 p-3">
        <div className="text-[13.5px] font-semibold">{dashboard.data?.name ?? kioskPageLabel(page)} <span className="font-normal text-muted">· {rangeLabel(route.params)}</span></div>
        {filters.length > 0 && <ReadOnlyFilters filters={filters} className="mt-2" />}
        {screen.watches && <div className="mt-1.5 text-[12px] text-muted">With your {screen.watches.length} watch{screen.watches.length === 1 ? '' : 'es'}: {screen.watches.map((w) => w.label).join(', ')}</div>}
        <p className="mt-2 text-[11.5px] text-faint">The screen shows this page exactly as you see it now, and keeps it up to date.</p>
      </div>

      <div className="mt-4 space-y-2">
        {kiosks.isPending ? <Skeleton className="h-12" /> : kiosks.data?.map((k) => (
          <div key={k.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{k.name}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-faint"><KioskStatus k={k} />{k.config.screens.length} screen{k.config.screens.length === 1 ? '' : 's'}</div>
            </div>
            <Button size="sm" disabled={busy || k.config.screens.length >= MAX_SCREENS} onClick={() => addTo(k)} title="Add as one more screen in its rotation"><Plus size={13} />Add</Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => replace(k)} title="Show only this view"><Replace size={13} />Show only this</Button>
          </div>
        ))}
        <form className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2" onSubmit={(e) => { e.preventDefault(); createWith(); }}>
          <span className="text-[12.5px] text-muted">{kiosks.data?.length ? 'Or a new kiosk:' : 'No kiosks yet. Create one:'}</span>
          <input className="field min-w-[140px] flex-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Office TV" maxLength={60} />
          <Button size="sm" variant={kiosks.data?.length ? 'secondary' : 'primary'} disabled={busy}><Plus size={13} />Create</Button>
        </form>
      </div>
    </Dialog>
  );
}
