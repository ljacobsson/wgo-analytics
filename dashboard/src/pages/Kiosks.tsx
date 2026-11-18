import { useState } from 'react';
import { ArrowDown, ArrowUp, ExternalLink, KeyRound, Monitor, Plus, RefreshCw, ShieldCheck, Terminal, Trash2, Tv, X } from 'lucide-react';
import type { Filter, Kiosk, KioskConfig, KioskPage, KioskScreen } from '../api/contract';
import { getConfig } from '../api/config';
import { useCreateKiosk, useDeleteKiosk, useKiosks, useRotateKiosk, useUpdateKiosk } from '../api/hooks';
import { cn, relTime } from '../lib/format';
import { describeFilter, FILTER_PARAM } from '../lib/filters';
import { KIOSK_PAGES, kioskSetupCommand, kioskUrl, normParams } from '../lib/kiosk';
import { PAGES, useProject } from '../lib/project';
import { useRoute, useSetParams } from '../lib/router';
import { PRESETS } from '../lib/time';
import { CodeBlock } from '../ui/CodeBlock';
import { Badge, Button, Card, CopyButton, Dialog, EmptyState, Field, Segmented, Skeleton, useToast } from '../ui/kit';

const MAX_SCREENS = 12;
const ONLINE_MS = 150_000; // the screen polls every 15 s and is recorded at most once a minute
const ROTATE = [10, 15, 20, 30, 45, 60, 120, 300, 600];
const REFRESH = [15, 30, 60, 120, 300, 600];
const ZOOM = ['1', '1.25', '1.5', '2', '2.5', '3'];
const secs = (s: number) => (s < 60 ? `${s} s` : `${s / 60} min`);
export const kioskPageLabel = (p: KioskPage) => PAGES.find((x) => x.id === p)?.label ?? p;
// params that carry over when a screen switches page; anything else is specific to the old page
const SHARED_PARAMS = ['range', 'from', 'to', 'f', 'lf', 'tf'];

export const isOnline = (k: Kiosk) => !!k.lastSeenAt && Date.now() - Date.parse(k.lastSeenAt) < ONLINE_MS;

export function KioskStatus({ k }: { k: Kiosk }) {
  if (isOnline(k)) return <Badge tone="good"><i className="h-1.5 w-1.5 rounded-full bg-good" />On screen{k.display && <span className="font-normal opacity-80"> · {k.display}</span>}</Badge>;
  if (k.lastSeenAt) return <Badge>Offline · seen {relTime(k.lastSeenAt)}</Badge>;
  return <Badge tone="warn">Not set up yet</Badge>;
}

export function KiosksPage() {
  const { project } = useProject();
  const route = useRoute();
  const set = useSetParams();
  const toast = useToast();
  const kiosks = useKiosks(project.id, true);
  const create = useCreateKiosk(project.id);
  const [name, setName] = useState('');
  const setupId = route.params.get('setup');
  const setup = kiosks.data?.find((k) => k.id === setupId) ?? null;

  const add = () => create.mutate({ name: name.trim() || defaultName(kiosks.data?.length ?? 0) }, {
    onSuccess: (k) => { setName(''); set({ setup: k.id }); },
    onError: (e) => toast({ title: 'Could not create the kiosk', body: (e as Error).message, tone: 'bad' }),
  });

  return (
    <div className="mx-auto max-w-[1080px] space-y-4">
      <Card className="relative overflow-hidden p-6">
        <div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-[var(--glow1)] blur-3xl" />
        <div className="relative">
          <Badge tone="accent"><Tv size={12} />Kiosk screens</Badge>
          <h2 className="mt-3 text-[24px] font-semibold leading-tight tracking-tight">Put {project.name} <span className="grad-text">on the wall</span></h2>
          <p className="mt-2 max-w-[640px] text-[13.5px] text-muted">
            Turn a TV into a live dashboard with a Raspberry Pi and one command. The screen needs no sign-in, and you choose what it shows from
            here: pages, filters, time ranges and how often it switches. Changes reach the screen within 15 seconds.
          </p>
          <form className="mt-4 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <input className="field max-w-[260px]" value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName(kiosks.data?.length ?? 0)} maxLength={60} />
            <Button variant="primary" disabled={create.isPending}><Plus size={14} />{create.isPending ? 'Creating…' : 'New kiosk'}</Button>
          </form>
        </div>
      </Card>

      {kiosks.isPending ? <Skeleton className="h-64" />
        : !kiosks.data?.length ? (
          <Card>
            <EmptyState icon={<Monitor size={22} />} title="No kiosks yet">
              Create one above. You get a command to run on a Raspberry Pi, and it boots straight into this project's dashboard.
              Then open any page, set its filters and time range, and click <Tv size={12} className="inline" /> <b>Show on kiosk</b> in the header.
            </EmptyState>
          </Card>
        ) : kiosks.data.map((k) => <KioskCard key={k.id} k={k} onSetup={() => set({ setup: k.id })} />)}

      {kiosks.data && kiosks.data.length > 0 && (
        <p className="px-1 text-[12.5px] text-faint">
          Tip: to show a filtered view, open the page, set the filters and time range there, and click <Tv size={12} className="inline" /> <span className="text-muted">Show on kiosk</span> in the header.
        </p>
      )}

      {setup && <SetupDialog k={setup} onClose={() => set({ setup: null })} />}
    </div>
  );
}

const defaultName = (n: number) => (n === 0 ? 'Office TV' : `Screen ${n + 1}`);

function KioskCard({ k, onSetup }: { k: Kiosk; onSetup: () => void }) {
  const { project } = useProject();
  const toast = useToast();
  const update = useUpdateKiosk(project.id);
  const rotate = useRotateKiosk(project.id);
  const del = useDeleteKiosk(project.id);
  const [confirm, setConfirm] = useState<'rotate' | 'delete' | null>(null);

  // edits are a local draft until applied; if nobody is editing, follow changes made elsewhere (e.g. Show on kiosk)
  const [base, setBase] = useState(k);
  const [draft, setDraft] = useState<KioskConfig>(k.config);
  const [name, setName] = useState(k.name);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base.config) || name !== base.name;
  if (k.updatedAt !== base.updatedAt && !dirty) { setBase(k); setDraft(k.config); setName(k.name); }

  const patch = (p: Partial<KioskConfig>) => setDraft((d) => ({ ...d, ...p }));
  const setScreen = (i: number, s: KioskScreen) => patch({ screens: draft.screens.map((x, j) => (j === i ? s : x)) });
  const move = (i: number, by: number) => {
    const s = [...draft.screens];
    [s[i], s[i + by]] = [s[i + by], s[i]];
    patch({ screens: s });
  };
  const fail = (title: string) => (e: unknown) => toast({ title, body: (e as Error).message, tone: 'bad' });
  const apply = () => update.mutate({ id: k.id, name: name.trim() || k.name, config: draft }, {
    onSuccess: (saved) => { setBase(saved); setDraft(saved.config); setName(saved.name); toast({ title: `Sent to ${saved.name}`, body: isOnline(saved) ? 'The screen updates within 15 seconds.' : 'The screen shows it as soon as it’s on.', tone: 'good' }); },
    onError: fail('Could not save the kiosk'),
  });

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--hl)] text-muted"><Tv size={16} /></span>
        <input className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 text-[15px] font-semibold tracking-tight outline-none hover:bg-[var(--hl)] focus:bg-[var(--hl)]"
          value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Kiosk name" />
        <KioskStatus k={k} />
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onSetup} title="Commands and link to set up the screen"><Terminal size={13} />Set up</Button>
          <a href={kioskUrl(k.token)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] font-medium text-muted hover:bg-[var(--hl)] hover:text-fg" title="Open the kiosk view in a new tab"><ExternalLink size={13} />Open</a>
          <Button size="sm" variant="ghost" disabled={update.isPending} title="Reload the page on the screen"
            onClick={() => update.mutate({ id: k.id, reload: true }, { onSuccess: () => toast({ title: 'Reloading the screen', body: 'Within 15 seconds, if it’s on.', tone: 'accent' }), onError: fail('Could not reload') })}>
            <RefreshCw size={13} />Reload
          </Button>
          <button onClick={() => setConfirm('rotate')} className="rounded-md p-1.5 text-faint hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="Replace the link (if it leaked)"><KeyRound size={14} /></button>
          <button onClick={() => setConfirm('delete')} className="rounded-md p-1.5 text-faint hover:bg-bad/15 hover:text-bad cursor-pointer" title="Delete kiosk"><Trash2 size={14} /></button>
        </div>
      </div>

      <div className="space-y-2 p-4">
        <div className="flex items-baseline justify-between">
          <h4 className="text-[12px] font-semibold uppercase tracking-wider text-faint">Screens{draft.screens.length > 1 && <span className="ml-1.5 normal-case tracking-normal">· shown in turn</span>}</h4>
        </div>
        {draft.screens.map((s, i) => (
          <ScreenRow key={i} n={i + 1} s={s} onChange={(x) => setScreen(i, x)}
            onUp={i > 0 ? () => move(i, -1) : undefined} onDown={i < draft.screens.length - 1 ? () => move(i, 1) : undefined}
            onRemove={draft.screens.length > 1 ? () => patch({ screens: draft.screens.filter((_, j) => j !== i) }) : undefined} />
        ))}
        {draft.screens.length < MAX_SCREENS && (
          <button onClick={() => patch({ screens: [...draft.screens, { page: 'overview', params: 'range=24h' }] })}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line py-2 text-[12.5px] text-muted hover:border-[var(--line-strong)] hover:text-fg cursor-pointer">
            <Plus size={13} />Add a screen
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 border-t border-line px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Switch screens every">
          <select className="field" value={draft.rotateSeconds} disabled={draft.screens.length < 2} onChange={(e) => patch({ rotateSeconds: Number(e.target.value) })}>
            {withCurrent(ROTATE, draft.rotateSeconds).map((s) => <option key={s} value={s}>{secs(s)}</option>)}
          </select>
        </Field>
        <Field label="Refresh data every">
          <select className="field" value={draft.refreshSeconds} onChange={(e) => patch({ refreshSeconds: Number(e.target.value) })}>
            {withCurrent(REFRESH, draft.refreshSeconds).map((s) => <option key={s} value={s}>{secs(s)}</option>)}
          </select>
        </Field>
        <Field label="Theme">
          <Segmented value={draft.theme} onChange={(theme) => patch({ theme })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
        </Field>
        <Field label="Zoom" hint="200% suits a 4K TV">
          <select className="field" value={String(draft.zoom)} onChange={(e) => patch({ zoom: Number(e.target.value) })}>
            {withCurrent(ZOOM, String(draft.zoom)).map((z) => <option key={z} value={z}>{Math.round(Number(z) * 100)}%</option>)}
          </select>
        </Field>
      </div>

      {dirty && (
        <div className="flex items-center justify-end gap-2 border-t border-line bg-accent/5 px-4 py-2.5">
          <span className="mr-auto text-[12.5px] text-muted">Unsaved changes</span>
          <Button size="sm" variant="ghost" onClick={() => { setDraft(base.config); setName(base.name); }}>Discard</Button>
          <Button size="sm" variant="primary" disabled={update.isPending} onClick={apply}><Tv size={13} />{update.isPending ? 'Sending…' : 'Show on screen'}</Button>
        </div>
      )}

      <Dialog open={confirm === 'rotate'} onClose={() => setConfirm(null)} title="Replace the link?"
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => { rotate.mutate(k.id, { onSuccess: onSetup, onError: fail('Could not replace the link') }); setConfirm(null); }}>Replace link</Button></>}>
        <p className="text-[13px] text-muted">The current link stops working within a minute, and the screen shows <i>This kiosk link no longer works</i>. Run the setup command with the new link on the Pi again.</p>
      </Dialog>
      <Dialog open={confirm === 'delete'} onClose={() => setConfirm(null)} title={`Delete ${k.name}?`}
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => { del.mutate(k.id, { onError: fail('Could not delete') }); setConfirm(null); }}>Delete</Button></>}>
        <p className="text-[13px] text-muted">Its link stops working within a minute. The Pi keeps running and shows that the link no longer works; to undo the setup, run the setup script with <code className="font-mono">--uninstall</code>.</p>
      </Dialog>
    </Card>
  );
}

function withCurrent<T extends string | number>(list: T[], cur: T): T[] {
  return list.includes(cur) ? list : [...list, cur].sort((a, b) => Number(a) - Number(b));
}

function parseFilters(raw: string | null): Filter[] {
  try { const v = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** One screen: page, caption, time range, and the filters and options it was saved with (removable). */
function ScreenRow({ n, s, onChange, onUp, onDown, onRemove }: {
  n: number; s: KioskScreen; onChange: (s: KioskScreen) => void; onUp?: () => void; onDown?: () => void; onRemove?: () => void;
}) {
  const params = new URLSearchParams(s.params);
  const setParams = (p: URLSearchParams) => onChange({ ...s, params: normParams(p.toString()) });
  const range = params.get('range') ?? '24h';
  const setRange = (r: string) => { const p = new URLSearchParams(params); p.set('range', r); p.delete('from'); p.delete('to'); setParams(p); };
  const setPage = (page: KioskPage) => {
    const p = new URLSearchParams();
    for (const k of SHARED_PARAMS) if (params.get(k)) p.set(k, params.get(k)!);
    onChange({ page, params: normParams(p.toString()), ...(s.title ? { title: s.title } : {}) });
  };
  const filters = (Object.values(FILTER_PARAM)).flatMap((key) => parseFilters(params.get(key)).map((f, i) => ({ key, i, f })));
  const removeFilter = (key: string, i: number) => {
    const p = new URLSearchParams(params);
    const rest = parseFilters(p.get(key)).filter((_, j) => j !== i);
    if (rest.length) p.set(key, JSON.stringify(rest)); else p.delete(key);
    setParams(p);
  };
  const options = [...params.entries()].filter(([k]) => !SHARED_PARAMS.includes(k));
  const removeOption = (k: string) => { const p = new URLSearchParams(params); p.delete(k); setParams(p); };
  const chip = 'inline-flex max-w-[360px] items-center gap-1 rounded-full border border-line bg-[var(--hl)] py-0.5 pl-2.5 pr-1 text-[11.5px]';

  return (
    <div className="rounded-xl border border-line bg-[var(--hl)]/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 text-[11.5px] font-bold text-accent">{n}</span>
        <select className="field !w-[150px]" value={s.page} onChange={(e) => setPage(e.target.value as KioskPage)} aria-label="Page">
          {KIOSK_PAGES.map((p) => <option key={p} value={p}>{kioskPageLabel(p)}</option>)}
        </select>
        <select className="field !w-[140px]" value={range} onChange={(e) => setRange(e.target.value)} aria-label="Time range">
          {range === 'custom' && <option value="custom">Fixed dates</option>}
          {PRESETS.map((p) => <option key={p} value={p}>Last {p}</option>)}
        </select>
        <input className="field min-w-[160px] flex-1" value={s.title ?? ''} placeholder={`Caption (default: ${kioskPageLabel(s.page)})`} maxLength={80}
          onChange={(e) => onChange({ ...s, title: e.target.value || undefined })} />
        <div className="flex items-center">
          <IconBtn title="Move up" onClick={onUp}><ArrowUp size={14} /></IconBtn>
          <IconBtn title="Move down" onClick={onDown}><ArrowDown size={14} /></IconBtn>
          <IconBtn title="Remove screen" onClick={onRemove} danger><Trash2 size={14} /></IconBtn>
        </div>
      </div>
      {(filters.length > 0 || options.length > 0 || (s.page === 'live' && s.watches?.length)) && (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-8">
          {filters.map(({ key, i, f }) => (
            <span key={`${key}${i}`} className={chip} title={describeFilter(f)}>
              <span className="truncate">{describeFilter(f)}</span>
              <button onClick={() => removeFilter(key, i)} className="rounded-full p-0.5 text-faint hover:text-fg cursor-pointer" title="Remove filter"><X size={11} /></button>
            </span>
          ))}
          {options.map(([k, v]) => (
            <span key={k} className={cn(chip, 'font-mono')} title={`${k}=${v}`}>
              <span className="truncate"><span className="text-faint">{k}=</span>{v}</span>
              <button onClick={() => removeOption(k)} className="rounded-full p-0.5 text-faint hover:text-fg cursor-pointer" title="Remove"><X size={11} /></button>
            </span>
          ))}
          {s.page === 'live' && !!s.watches?.length && (
            <span className={chip} title={s.watches.map((w) => w.label).join(', ')}>
              <span className="truncate">{s.watches.length} watch{s.watches.length === 1 ? '' : 'es'}: {s.watches.map((w) => w.label).join(', ')}</span>
              <button onClick={() => onChange({ ...s, watches: undefined })} className="rounded-full p-0.5 text-faint hover:text-fg cursor-pointer" title="Remove watches"><X size={11} /></button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick?: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick} disabled={!onClick}
      className={cn('rounded-md p-1.5 text-faint transition-colors enabled:cursor-pointer disabled:opacity-30', danger ? 'enabled:hover:bg-bad/15 enabled:hover:text-bad' : 'enabled:hover:bg-[var(--hl)] enabled:hover:text-fg')}>
      {children}
    </button>
  );
}

function SetupDialog({ k, onClose }: { k: Kiosk; onClose: () => void }) {
  const { project } = useProject();
  const url = kioskUrl(k.token);
  const isLocal = /^http:\/\/(localhost|127\.|\[::1\])/.test(url) || /^http:\/\/(localhost|127\.|\[::1\])/.test(getConfig().apiUrl);
  const step = (n: number, title: string, body: React.ReactNode) => (
    <li className="flex gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full grad-bg text-[12px] font-bold text-white">{n}</span>
      <div className="min-w-0 flex-1"><div className="text-[13.5px] font-semibold">{title}</div><div className="mt-1 text-[12.5px] text-muted">{body}</div></div>
    </li>
  );
  return (
    <Dialog open onClose={onClose} width={680} title={<span className="inline-flex items-center gap-2"><Tv size={16} />Set up {k.name}</span>}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <ol className="space-y-4">
        {step(1, 'Prepare a Raspberry Pi', <>
          Any Pi 3, 4 or 5, or Zero 2 W. Install <b>Raspberry Pi OS</b> (Bookworm or newer, Lite or Desktop) with Raspberry Pi Imager. In its settings, set up Wi-Fi and turn on SSH. Plug it into the TV.
        </>)}
        {step(2, 'Run this on the Pi', <>
          <span>Over SSH, or with a keyboard. It installs a browser that opens full screen at every boot and keeps the screen on. On a Pi with a desktop it reboots once; on Lite the kiosk starts right away.</span>
          <div className="mt-2"><CodeBlock lang="sh" code={kioskSetupCommand(k.token)} /></div>
        </>)}
        {step(3, 'Control it from here', <>
          Pick pages and filters on this page, or use <Tv size={12} className="inline" /> <b>Show on kiosk</b> on any page. You don't need to touch the Pi again.
          Status: <KioskStatus k={k} />
        </>)}
      </ol>
      <div className="mt-5 space-y-2 rounded-xl border border-line bg-[var(--hl)]/40 p-3">
        <div className="text-[12.5px] font-medium">Another screen? Open this link full screen in any browser (a smart TV, a spare laptop):</div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-[var(--hl)] px-2.5 py-1.5 font-mono text-[11.5px]">{url}</code>
          <CopyButton text={url} />
        </div>
        <p className="flex items-start gap-1.5 text-[12px] text-warn"><ShieldCheck size={14} className="mt-[1px] shrink-0" /><span>Anyone with this link can see {project.name}'s analytics without signing in, but nothing else. If it leaks, replace it with the <KeyRound size={11} className="inline" /> button.</span></p>
        {isLocal && <p className="text-[12px] text-warn">This dashboard runs on localhost, which a Raspberry Pi can't reach. Set up kiosks against a deployed stack.</p>}
      </div>
    </Dialog>
  );
}
