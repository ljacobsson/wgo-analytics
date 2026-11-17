import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellOff, Pause, Play, Plus, Pencil, Radio, Trash2, Zap, Eraser } from 'lucide-react';
import type { EventType, Watch } from '../api/contract';
import { useFirehose, useLive, type LiveStore } from '../live/store';
import { LIVE_PREFS, readPrefs } from '../live/LiveProvider';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Segmented, Switch, TypeBadge, TYPE_COLOR } from '../ui/kit';
import { countryName, flag } from '../lib/geo';
import { cellKey, type CalloutGroup, type CalloutMode, type GeoMapPing, type GeoMapPoint } from '../charts/geoTypes';
import { MapCallout } from '../charts/MapCallout';

const GeoMap = lazy(() => import('../charts/GeoMap'));
import { cn, fmtNum, relTime } from '../lib/format';
import { eventTitle } from '../lib/events';
import { navigate, pageHref, useRoute } from '../lib/router';
import { useProject } from '../lib/project';
import { useClickAliases } from '../api/hooks';
import { isKiosk } from '../lib/kiosk';
import { ColumnsMenu, EventCell, useEventColumns, userFilter, type EventColumn } from '../ui/EventColumns';
import { currentFilters, mergeFilters } from '../lib/filters';

/** Firehose columns until someone picks their own (saved per browser). */
const FIREHOSE_COLUMNS: EventColumn[] = ['user', 'path'];

function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(t); }, [ms]);
}

function RollingBars({ values, nowSec, color }: { values: number[]; nowSec: number; color: string }) {
  const max = Math.max(3, ...values), H = 44, bw = 100 / 60;
  return (
    <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" width="100%" height={H} aria-hidden className="overflow-hidden">
      <line x1="0" x2="100" y1={H - 0.5} y2={H - 0.5} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      {values.map((v, i) => {
        const h = v ? Math.max(3, (v / max) * (H - 4)) : 1;
        return <rect key={nowSec - 59 + i} style={{ x: i * bw + 0.15, y: H - h, height: h, transition: 'x .9s linear, y .3s, height .3s' }} width={bw - 0.3} rx="0.5" fill={v ? color : 'var(--line-strong)'} opacity={v ? 1 : 0.5} />;
      })}
    </svg>
  );
}

function WatchCard({ w, store, onEdit }: { w: Watch; store: LiveStore; onEdit: () => void }) {
  useTick(1000);
  const nowSec = Math.floor(Date.now() / 1000);
  const values = store.series(w.id);
  const last = store.lastFired[w.id];
  const rate = values.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const chips = (['selector', 'text', 'name', 'path'] as const).flatMap((k) => (w[k] ? [[k, w[k] as string] as const] : []));
  return (
    <Card className="group relative overflow-hidden p-4" hover>
      {last && <div key={last} className="flash pointer-events-none absolute inset-0 rounded-[14px] border border-transparent" />}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><div className="flex items-center gap-2"><h3 className="truncate text-[14px] font-semibold">{w.label}</h3>
          {last && Date.now() - last < 2500 && <span className="h-2 w-2 rounded-full bg-accent2 pulse-dot" />}</div>
          <div className="mt-1.5 flex flex-wrap gap-1"><Badge tone="accent">{w.type}</Badge>{chips.map(([k, v]) => <Badge key={k}><span className="text-faint">{k}</span><span className="max-w-[140px] truncate font-mono">{v}</span></Badge>)}</div></div>
        {!isKiosk() && <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button onClick={onEdit} className="rounded-md p-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="Edit"><Pencil size={14} /></button>
          <button onClick={() => store.removeWatch(w.id)} className="rounded-md p-1.5 text-muted hover:bg-bad/15 hover:text-bad cursor-pointer" title="Delete"><Trash2 size={14} /></button>
        </div>}
      </div>
      <div className="mt-3 flex items-end justify-between">
        <div className="kpi text-[38px] font-semibold leading-none tracking-tight">{fmtNum(store.counts[w.id] ?? 0)}</div>
        <div className="pb-1 text-right text-[11.5px] text-faint"><div className="tnum">{rate.toFixed(1)} /s</div><div>{last ? relTime(last) : 'no hits yet'}</div></div>
      </div>
      <div className="mt-3"><RollingBars values={values} nowSec={nowSec} color="var(--s3)" /><div className="mt-1 flex justify-between text-[10px] text-faint"><span>60s ago</span><span>now</span></div></div>
    </Card>
  );
}

const TYPES: EventType[] = ['click', 'pageview', 'custom', 'error', 'http_error', 'identify', 'vitals'];
export function WatchDialog({ open, initial, onClose, onSave }: { open: boolean; initial: Watch | null; onClose: () => void; onSave: (w: Omit<Watch, 'id'>, id?: string) => void }) {
  const [f, setF] = useState({ label: '', type: 'click' as EventType, selector: '', text: '', name: '', path: '' });
  useEffect(() => { if (open) setF({ label: initial?.label ?? '', type: initial?.type ?? 'click', selector: initial?.selector ?? '', text: initial?.text ?? '', name: initial?.name ?? '', path: initial?.path ?? '' }); }, [open, initial]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    const w: Omit<Watch, 'id'> = { label: f.label.trim() || 'Untitled watch', type: f.type };
    for (const k of ['selector', 'text', 'name', 'path'] as const) if (f[k].trim()) w[k] = f[k].trim();
    onSave(w, initial?.id); onClose();
  };
  return (
    <Dialog open={open} onClose={onClose} title={initial ? 'Edit watch' : 'New watch'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>{initial ? 'Save' : 'Create watch'}</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="grid grid-cols-[1fr_130px] gap-3"><Field label="Label"><input autoFocus className="field" value={f.label} onChange={set('label')} placeholder="Signup button" /></Field>
          <Field label="Type"><select className="field" value={f.type} onChange={set('type')}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field></div>
        <p className="text-[11.5px] text-faint">All provided fields must match (case-insensitive substring). Leave blank to match anything.</p>
        <Field label="Selector"><input className="field font-mono" value={f.selector} onChange={set('selector')} placeholder="#signup-cta" /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Element text"><input className="field" value={f.text} onChange={set('text')} placeholder="Start free trial" /></Field>
          <Field label="Name" hint="trackName / custom event"><input className="field" value={f.name} onChange={set('name')} placeholder="signup-cta" /></Field></div>
        <Field label="Path"><input className="field font-mono" value={f.path} onChange={set('path')} placeholder="/pricing" /></Field>
        <button className="hidden" />
      </form>
    </Dialog>
  );
}

const PING_MS = 4000;
// live callouts: an event stays for 5 s, and at most the last 5 per dot are shown
const CALLOUT_MS = 5000;
const CALLOUT_MAX = 5;

function LiveMap({ store }: { store: LiveStore }) {
  useTick(500);
  const now = Date.now();
  const [mode, setMode] = useState<CalloutMode>(() => (localStorage.getItem('wgo.liveCallouts') as CalloutMode) || 'all');
  const changeMode = (m: CalloutMode) => { setMode(m); localStorage.setItem('wgo.liveCallouts', m); };
  // newest first; pings fade out by themselves, we only need the last few seconds
  const recent = [];
  for (const it of store.feed) {
    if (now - it.at > PING_MS) break;
    if (it.ev.lat != null && it.ev.lon != null) recent.push(it);
  }
  const pings: GeoMapPing[] = recent.slice(0, 80).map(({ ev, at }) => ({
    id: ev.id, lat: ev.lat!, lon: ev.lon!, life: Math.max(0, 1 - (now - at) / PING_MS),
    color: ev.matches?.length ? 'var(--accent2)' : TYPE_COLOR[ev.type], strong: ev.matches?.length > 0,
  }));
  // places active this session become dots, so they can be selected and keep their callouts anchored
  const feed = store.feed;
  const points = useMemo(() => {
    const cells = new Map<string, GeoMapPoint>();
    for (const { ev } of feed) {
      if (ev.lat == null || ev.lon == null) continue;
      const k = cellKey(ev.lat, ev.lon);
      const c = cells.get(k);
      if (c) c.value++;
      else cells.set(k, { lat: ev.lat, lon: ev.lon, value: 1, label: [ev.city, ev.country && countryName(ev.country)].filter(Boolean).join(', ') || 'Unknown place' });
    }
    return [...cells.values()].map((p) => ({ ...p, sub: 'this session' }));
  }, [feed]);
  const renderCallout = (g: CalloutGroup) => {
    const cells = new Set(g.cells);
    const events = [];
    for (const { ev, at } of feed) {
      if (now - at > CALLOUT_MS || events.length >= CALLOUT_MAX) break;
      if (ev.lat != null && ev.lon != null && cells.has(cellKey(ev.lat, ev.lon))) events.push(ev);
    }
    if (!events.length && mode === 'all') return null; // quiet dots stay clean
    return <MapCallout title={g.label} events={events} now={now} compact={mode === 'all'} empty="Nothing in the last 5 s" />;
  };
  const last = recent[0]?.ev;
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Live map" sub="events ping where they happen · watch hits glow cyan · callouts keep 5 s / last 5"
        right={<div className="flex items-center gap-3">
          {last && <span className="hidden truncate text-[12px] text-muted 2xl:inline">{last.country && flag(last.country)} {last.city}</span>}
          <Segmented value={mode} onChange={changeMode} options={[{ value: 'off', label: 'Off' }, { value: 'selected', label: 'Selected' }, { value: 'all', label: 'All' }]} />
        </div>} />
      <div className="px-3 pb-3"><Suspense fallback={<div className="h-[440px] rounded-xl bg-[var(--hl)]" />}>
        <GeoMap points={points} pings={pings} height={440} fit={false} unit="events" callouts={mode} renderCallout={renderCallout} />
      </Suspense></div>
    </Card>
  );
}

function Firehose({ store }: { store: LiveStore }) {
  const { project } = useProject(); const route = useRoute();
  const aliases = useClickAliases(project.id).data;
  useTick(1000);
  const feed = store.viewFeed;
  const boxRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const RH = 38, VH = 520;
  const start = Math.max(0, Math.floor(scroll / RH) - 4), end = Math.min(feed.length, Math.ceil((scroll + VH) / RH) + 4);
  const now = Date.now();
  const slice = useMemo(() => feed.slice(start, end), [feed, start, end]);
  const pending = store.paused ? store.feed.length - store.frozen!.length : 0;
  const [cols, setCols] = useEventColumns('firehose', FIREHOSE_COLUMNS);
  const toEvents = (extra: Record<string, string>) => navigate(pageHref(project.id, 'events', route.params, extra));
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-3"><h3 className="text-[13px] font-semibold">Firehose</h3>
          <span className="text-[12px] text-faint tnum">{fmtNum(feed.length)} / 500 events{pending > 0 && <span className="ml-2 text-warn">+{pending} held</span>}</span></div>
        {!isKiosk() && <div className="flex items-center gap-2">
          <ColumnsMenu value={cols} onChange={setCols} defaults={FIREHOSE_COLUMNS} />
          <Button size="sm" onClick={() => store.clearFeed()}><Eraser size={13} />Clear</Button>
          <Button size="sm" variant={store.paused ? 'primary' : 'secondary'} onClick={() => store.setPaused(!store.paused)}>{store.paused ? <><Play size={13} />Resume</> : <><Pause size={13} />Pause</>}</Button>
        </div>}
      </div>
      {feed.length === 0 ? <EmptyState icon={<Radio size={22} />} title="Waiting for events…">New events from your site will stream in here the moment they are ingested.</EmptyState> : (
        <div ref={boxRef} onScroll={(e) => setScroll(e.currentTarget.scrollTop)} className="relative overflow-y-auto" style={{ height: VH }}>
          <div style={{ height: feed.length * RH, position: 'relative' }}>
            {slice.map((it, i) => {
              const e = it.ev, y = (start + i) * RH;
              return (
                <div key={e.id} className="absolute inset-x-0" style={{ top: y, height: RH }}>
                  <div className={cn('flex h-full items-center gap-3 border-b border-line/60 px-4 text-[12.5px] hover:bg-[var(--hl)]', now - it.at < 700 && 'row-new')}>
                    <TypeBadge type={e.type} />
                    <span className="min-w-[140px] flex-1 truncate">{eventTitle(e, aliases)}</span>
                    {e.matches?.length > 0 && <Badge tone="cyan"><Zap size={10} />{e.matches.length}</Badge>}
                    {cols.map((c) => <EventCell key={c} col={c} e={e}
                      onUser={() => { const f = userFilter(e); if (f) toEvents({ f: JSON.stringify(mergeFilters(currentFilters('events'), [f])) }); }}
                      onSession={(sid) => toEvents({ sessionId: sid })} />)}
                    <span className="w-16 shrink-0 whitespace-nowrap text-right tnum text-[11.5px] text-faint">{relTime(it.at, now)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

export function LivePage() {
  const store = useLive();
  const [prefs, setPrefs] = useState(readPrefs);
  const [firehose, setFirehose] = useState(true);
  const [dlg, setDlg] = useState<{ open: boolean; w: Watch | null }>({ open: false, w: null });
  useFirehose(firehose);
  useTick(1000);
  const savePrefs = (p: typeof prefs) => { setPrefs(p); localStorage.setItem(LIVE_PREFS, JSON.stringify(p)); };
  const toggleNotify = async (on: boolean) => {
    if (on && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    savePrefs({ ...prefs, notify: on && 'Notification' in window && Notification.permission === 'granted' });
  };
  const connected = store.status === 'connected';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[12px] font-medium', connected ? 'border-good/40 bg-good/10 text-good' : 'border-warn/40 bg-warn/10 text-warn')}>
            <i className={cn('h-2 w-2 rounded-full', connected ? 'bg-good' : 'bg-warn pulse-dot')} />{connected ? 'Connected' : store.status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>
          <span className="text-[12.5px] text-muted tnum">{fmtNum(store.eventsSeen)} events received this session</span>
        </div>
        {!isKiosk() && <div className="flex items-center gap-4">
          <Switch checked={prefs.toasts} onChange={(b) => savePrefs({ ...prefs, toasts: b })} label="Toasts" />
          <Switch checked={prefs.notify} onChange={toggleNotify} label={<span className="inline-flex items-center gap-1">{prefs.notify ? <Bell size={13} /> : <BellOff size={13} />}Notifications</span>} />
          <Switch checked={firehose} onChange={setFirehose} label="Firehose stream" />
          <Button variant="primary" onClick={() => setDlg({ open: true, w: null })}><Plus size={15} />New watch</Button>
        </div>}
      </div>

      {store.watches.length === 0 ? isKiosk() ? null : (
        <Card><EmptyState icon={<Zap size={22} />} title="Watch anything, live" action={<Button variant="primary" onClick={() => setDlg({ open: true, w: null })}><Plus size={15} />Create your first watch</Button>}>A watch counts matching events in real time, for example every click on your signup button. Or start from the Clicks page with “Watch live”.</EmptyState></Card>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
          {store.watches.map((w) => <WatchCard key={w.id} w={w} store={store} onEdit={() => setDlg({ open: true, w })} />)}
        </div>
      )}

      {firehose ? <div className="grid items-start gap-4 2xl:grid-cols-2"><LiveMap store={store} /><Firehose store={store} /></div> : <Card><EmptyState icon={<Radio size={22} />} title="Firehose is off" action={<Button onClick={() => setFirehose(true)}>Start stream</Button>}>Stream every incoming event, not just watch matches.</EmptyState></Card>}
      <WatchDialog open={dlg.open} initial={dlg.w} onClose={() => setDlg({ open: false, w: null })} onSave={(w, id) => (id ? store.updateWatch({ ...w, id }) : store.addWatch(w))} />
    </div>
  );
}
