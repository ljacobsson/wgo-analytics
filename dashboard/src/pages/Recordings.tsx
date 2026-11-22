import { useEffect, useMemo, useState } from 'react';
import { MonitorPlay, Plus, Search, Settings2, Trash2, X } from 'lucide-react';
import type { RecordingFilters, RecordingSettings, RecordingSettingsResponse, RecordingSummary, RecordingTrigger, RecordingTriggerType } from '../api/contract';
import { useRecordings, useRecordingSettings, useSaveRecordingSettings } from '../api/hooks';
import { cn, fmtNum, fmtTime, relTime } from '../lib/format';
import { useProject } from '../lib/project';
import { navigate, pageHref, useRoute, useSetParams, type Route } from '../lib/router';
import { useTime } from '../lib/time';
import { Button, Card, Dialog, EmptyState, ErrorState, Field, Mono, Skeleton, Switch, useDebounced, useToast } from '../ui/kit';
import { fmtClock } from '../replay/Player';
import { RowsSkeleton, TableHead } from './common';

const TRIGGERS: Record<RecordingTriggerType, { label: string; placeholder: string; hint: string }> = {
  page: { label: 'Visits a page', placeholder: '/checkout*', hint: 'Path; * matches anything' },
  click: { label: 'Clicks an element', placeholder: '#buy, button.add-to-cart', hint: 'CSS selector' },
  event: { label: 'Sends a custom event', placeholder: 'signup_started', hint: 'Event name, as in WGO.track()' },
  error: { label: 'Hits an error', placeholder: 'Any error', hint: 'Text in the error or failed request (empty: any)' },
};

/** Why a session was recorded, in words. */
export function reasonText(reason: string): string {
  if (reason === 'sample') return 'Sampled';
  const [, type, ...rest] = reason.split(':');
  const v = rest.join(':');
  switch (type) {
    case 'page': return `Visited ${v}`;
    case 'click': return `Clicked ${v}`;
    case 'event': return `Event ${v}`;
    case 'error': return v ? `Error: ${v}` : 'Hit an error';
    default: return reason;
  }
}

export const visitorName = (r: Pick<RecordingSummary, 'userId' | 'anonId'>) => r.userId ?? (r.anonId ? `Visitor ${r.anonId.slice(0, 6)}` : 'Anonymous visitor');

function describe(s: RecordingSettings): string {
  const parts: string[] = [];
  if (s.samplePercent > 0) parts.push(`${s.samplePercent}% of sessions`);
  if (s.triggers.length) parts.push(`${s.samplePercent > 0 ? 'plus ' : ''}sessions that match ${s.triggers.length === 1 ? 'a trigger' : `one of ${s.triggers.length} triggers`}`);
  return parts.length ? `Recording ${parts.join(', ')}.` : 'On, but neither a share of sessions nor a trigger is set, so nothing is recorded.';
}

const limitText = (used: number, max: number | null, span: string) => (max === null ? `${fmtNum(used)} in the ${span}` : `${fmtNum(used)} of ${fmtNum(max)} in the ${span}`);

// ---------------------------------------------------------------- settings

function SettingsDialog({ open, onClose, data }: { open: boolean; onClose: () => void; data: RecordingSettingsResponse }) {
  const { project } = useProject();
  const owner = project.role === 'owner';
  const save = useSaveRecordingSettings(project.id);
  const toast = useToast();
  const [s, setS] = useState<RecordingSettings>(data.settings);
  const [pct, setPct] = useState('');
  const [perHour, setPerHour] = useState('');
  const [perDay, setPerDay] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setS(data.settings);
    setPct(String(data.settings.samplePercent));
    setPerHour(data.settings.maxPerHour?.toString() ?? '');
    setPerDay(data.settings.maxPerDay?.toString() ?? '');
    setError('');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTrigger = (i: number, t: Partial<RecordingTrigger>) => setS((x) => ({ ...x, triggers: x.triggers.map((g, j) => (j === i ? { ...g, ...t } : g)) }));
  const num = (v: string) => (v.trim() === '' ? null : Number(v));

  const submit = () => {
    setError('');
    const next: RecordingSettings = { ...s, samplePercent: Number(pct || 0), maxPerHour: num(perHour), maxPerDay: num(perDay), triggers: s.triggers.map((t) => ({ ...t, value: t.value.trim() })) };
    save.mutate(next, {
      onSuccess: () => { toast({ title: 'Recording settings saved', body: next.enabled ? describe(next) : 'Recording is off', tone: 'good' }); onClose(); },
      onError: (e) => setError((e as Error).message),
    });
  };

  return (
    <Dialog open={open} onClose={onClose} title="Session recording" width={620}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!owner || save.isPending} onClick={submit}>{save.isPending ? 'Saving…' : 'Save'}</Button></>}>
      <div className="space-y-5 text-[13px]">
        {!owner && <p className="rounded-lg border border-line bg-[var(--hl)] px-3 py-2 text-[12.5px] text-muted">Only project owners can change what is recorded.</p>}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium">Record sessions</div>
            <p className="mt-0.5 text-[12px] text-muted">The SDK on your site starts recording within a minute. Nothing changes in your snippet.</p>
          </div>
          <span className={cn(!owner && 'pointer-events-none opacity-60')}><Switch checked={s.enabled} onChange={(b) => setS({ ...s, enabled: b })} /></span>
        </div>

        <fieldset disabled={!owner} className={cn('space-y-5', !s.enabled && 'opacity-60')}>
          <Field label="Share of sessions to record" hint="Picked at random per session. Set 0 to record only sessions that match a trigger.">
            <div className="flex items-center gap-2"><input className="field !w-28 tnum" type="number" min={0} max={100} step={0.1} value={pct} onChange={(e) => setPct(e.target.value)} /><span className="text-muted">%</span></div>
          </Field>

          <div>
            <div className="mb-1 text-[11.5px] font-medium text-muted">Also record a session when the visitor…</div>
            <div className="space-y-2">
              {s.triggers.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select className="field !w-48 shrink-0" value={t.type} onChange={(e) => setTrigger(i, { type: e.target.value as RecordingTriggerType })}>
                    {(Object.keys(TRIGGERS) as RecordingTriggerType[]).map((k) => <option key={k} value={k}>{TRIGGERS[k].label}</option>)}
                  </select>
                  <input className="field font-mono !text-[12px]" placeholder={TRIGGERS[t.type].placeholder} title={TRIGGERS[t.type].hint} value={t.value} onChange={(e) => setTrigger(i, { value: e.target.value })} />
                  <button type="button" onClick={() => setS({ ...s, triggers: s.triggers.filter((_, j) => j !== i) })} title="Remove" className="rounded-md p-1.5 text-faint hover:bg-[var(--hl)] hover:text-bad cursor-pointer"><Trash2 size={14} /></button>
                </div>
              ))}
              {s.triggers.length < 20 && <Button size="sm" type="button" onClick={() => setS({ ...s, triggers: [...s.triggers, { type: 'page', value: '' }] })}><Plus size={13} />Add trigger</Button>}
            </div>
            <p className="mt-1.5 text-[11px] text-faint">A matching session is recorded even if the sample didn't pick it, starting up to a minute before the match.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="At most, per hour" hint={`${fmtNum(data.usage.lastHour)} in the last 60 minutes. Empty: no limit.`}>
              <input className="field tnum" type="number" min={1} step={1} placeholder="No limit" value={perHour} onChange={(e) => setPerHour(e.target.value)} />
            </Field>
            <Field label="At most, per day" hint={`${fmtNum(data.usage.lastDay)} in the last 24 hours. Empty: no limit.`}>
              <input className="field tnum" type="number" min={1} step={1} placeholder="No limit" value={perDay} onChange={(e) => setPerDay(e.target.value)} />
            </Field>
          </div>

          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-medium">Mask all text</div>
              <p className="mt-0.5 text-[12px] text-muted">Every letter on the page becomes an asterisk. Use it when pages show personal data.</p>
            </div>
            <span className={cn(!owner && 'pointer-events-none opacity-60')}><Switch checked={s.maskAllText} onChange={(b) => setS({ ...s, maskAllText: b })} /></span>
          </div>
        </fieldset>

        <div className="rounded-lg border border-line bg-[var(--hl)] px-3.5 py-3 text-[12px] leading-relaxed text-muted">
          What visitors type is never recorded: fields show one dot per character. Add <Mono className="text-fg">data-wgo-mask</Mono> to an element
          to hide its text, or <Mono className="text-fg">data-wgo-block</Mono> to hide it completely. Recordings are kept for {data.retentionDays} days.
          A site can opt out in code with <Mono className="text-fg">data-record="false"</Mono>.
        </div>
        {error && <p className="text-[12.5px] text-bad">{error}</p>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- filters

/** URL parameter of each filter (the page's own; time range and project filters are separate). */
const P = { len: 'len', page: 'page', device: 'device', why: 'why', errors: 'errors', rage: 'rage', users: 'users', inactive: 'inactive', q: 'q' } as const;
const LENGTHS = [['', 'Any length'], ['10', '10 s or longer'], ['30', '30 s or longer'], ['60', '1 min or longer'], ['300', '5 min or longer']] as const;

function filtersFrom(params: Route['params']): RecordingFilters {
  const get = (k: string) => params.get(k) || undefined;
  const why = get(P.why);
  return {
    minDuration: get(P.len) ? Number(get(P.len)) : undefined,
    page: get(P.page),
    device: get(P.device),
    reason: why === 'sample' || why === 'trigger' ? why : undefined,
    errors: get(P.errors) === '1' || undefined,
    rage: get(P.rage) === '1' || undefined,
    identified: get(P.users) === '1' || undefined,
    inactive: get(P.inactive) === '1' || undefined,
    q: get(P.q),
  };
}

/** A text filter that updates the URL a moment after typing stops. */
function TextFilter({ param, value, placeholder, icon, className }: { param: string; value: string; placeholder: string; icon?: boolean; className?: string }) {
  const set = useSetParams();
  const [v, setV] = useState(value);
  const d = useDebounced(v, 350);
  useEffect(() => { setV(value); }, [value]);
  useEffect(() => { if (d !== value) set({ [param]: d.trim() || null }); }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className={cn('relative', className)}>
      {icon && <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />}
      <input className={cn('field !py-1.5 !text-[12.5px]', icon && '!pl-8')} placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} />
    </label>
  );
}

function FilterBar({ params }: { params: Route['params'] }) {
  const set = useSetParams();
  const select = 'field !w-auto !py-1.5 !pr-7 !text-[12.5px]';
  const toggle = (k: string, label: string) => <Switch checked={params.get(k) === '1'} onChange={(b) => set({ [k]: b ? '1' : null })} label={label} />;
  const active = Object.values(P).some((k) => params.get(k));
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
      <TextFilter param={P.q} value={params.get(P.q) ?? ''} placeholder="Visitor, page, country…" icon className="w-full sm:w-56" />
      <select className={select} value={params.get(P.len) ?? ''} onChange={(e) => set({ [P.len]: e.target.value || null })} aria-label="Length">
        {LENGTHS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <TextFilter param={P.page} value={params.get(P.page) ?? ''} placeholder="Visited page, e.g. /checkout*" className="w-full sm:w-56" />
      <select className={select} value={params.get(P.device) ?? ''} onChange={(e) => set({ [P.device]: e.target.value || null })} aria-label="Device">
        <option value="">All devices</option><option value="desktop">Desktop</option><option value="mobile">Mobile</option><option value="tablet">Tablet</option>
      </select>
      <select className={select} value={params.get(P.why) ?? ''} onChange={(e) => set({ [P.why]: e.target.value || null })} aria-label="Recorded because">
        <option value="">Any reason</option><option value="sample">Sampled</option><option value="trigger">Started by a trigger</option>
      </select>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {toggle(P.errors, 'With errors')}
        {toggle(P.rage, 'With rage clicks')}
        {toggle(P.users, 'Logged-in users')}
        <span title="Recordings in which the visitor never clicked, tapped, scrolled, typed or hovered anything: mostly tabs left open">{toggle(P.inactive, 'Include inactive')}</span>
      </div>
      {active && (
        <button onClick={() => set(Object.fromEntries(Object.values(P).map((k) => [k, null])))} className="ml-auto inline-flex items-center gap-1 text-[12px] text-muted hover:text-fg cursor-pointer">
          <X size={13} />Clear filters
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- list

const COLS = 'grid-cols-[120px_80px_minmax(150px,1.2fr)_minmax(140px,1.4fr)_56px_56px_56px_minmax(120px,1fr)_minmax(110px,1fr)]';

export function RecordingsPage() {
  const { project } = useProject();
  const { range } = useTime();
  const route = useRoute();
  const settings = useRecordingSettings(project.id);
  const paramsKey = route.params.toString();
  const filters = useMemo(() => filtersFrom(route.params), [paramsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = Object.values(filters).some((v) => v !== undefined);
  const list = useRecordings(project.id, range, filters);
  const [open, setOpen] = useState(route.params.get('setup') === '1');
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.recordings) ?? [], [list.data]);

  const s = settings.data;
  const watch = (sid: string) => navigate(pageHref(project.id, `recordings/${encodeURIComponent(sid)}`, route.params));

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-4 px-4 py-4 sm:px-5">
        <div className="hidden h-10 w-10 shrink-0 sm:grid place-items-center rounded-xl border border-line bg-[var(--raised)] text-accent"><MonitorPlay size={19} /></div>
        <div className="min-w-[220px] flex-1">
          {!s ? <><Skeleton className="h-4 w-72" /><Skeleton className="mt-2 h-3 w-96" /></> : s.settings.enabled ? (<>
            <div className="text-[13.5px] font-medium">{describe(s.settings)}</div>
            <div className="mt-0.5 text-[12px] text-muted">
              {limitText(s.usage.lastHour, s.settings.maxPerHour, 'last hour')} · {limitText(s.usage.lastDay, s.settings.maxPerDay, 'last 24 hours')} · kept {s.retentionDays} days
            </div>
          </>) : (<>
            <div className="text-[13.5px] font-medium">Session recording is off</div>
            <div className="mt-0.5 max-w-2xl text-[12px] text-muted">
              Watch what visitors do: their pointer, clicks, scrolling and page changes, replayed over snapshots of the page.
              No video is recorded, and nothing typed into forms. Record a share of sessions, or only sessions that hit an error or reach a page you care about.
            </div>
          </>)}
        </div>
        {s && <Button variant={s.settings.enabled ? 'secondary' : 'primary'} onClick={() => setOpen(true)}><Settings2 size={14} />{s.settings.enabled ? 'Settings' : project.role === 'owner' ? 'Set up recording' : 'View settings'}</Button>}
      </Card>
      {s && <SettingsDialog open={open} onClose={() => setOpen(false)} data={s} />}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
          <div className="whitespace-nowrap text-[13px] font-semibold">Recordings <span className="font-normal text-faint">· {range.label}</span></div>
          <span className="text-[11.5px] text-faint">Recordings shorter than 3 seconds aren't listed</span>
        </div>
        <FilterBar params={route.params} />
        <div className="@container overflow-x-auto">
          <div className="min-w-[1080px]">
            <TableHead className={COLS} cols={['Started', ['Length', 'text-right'], 'Visitor', 'Entry page', ['Pages', 'text-right'], ['Clicks', 'text-right'], ['Errors', 'text-right'], 'Device', 'Recorded because']} />
            {list.isLoading ? <RowsSkeleton n={6} /> : list.isError ? <ErrorState error={list.error} retry={() => list.refetch()} /> : !rows.length ? (
              <EmptyState pinned icon={<MonitorPlay size={22} />} title={filtered ? 'No recordings match these filters' : 'No recordings in this time range'}>
                {filtered ? (list.hasNextPage ? 'None among the newest recordings; load older ones below, or widen the filters.' : 'Try other filters or a longer time range.') : s?.settings.enabled ? 'Recordings show up here within a minute of a recorded session starting. Recordings in which the visitor did nothing are hidden unless you include inactive ones.' : 'Turn on session recording to start collecting them.'}
              </EmptyState>
            ) : rows.map((r) => (
              <button key={r.sessionId} onClick={() => watch(r.sessionId)}
                className={cn('grid w-full items-center gap-4 border-b border-line px-4 py-2.5 text-left text-[12.5px] transition-colors hover:bg-[var(--hl)] cursor-pointer', COLS)}>
                <span className="tnum" title={new Date(r.startedAt).toLocaleString()}>{fmtTime(r.startedAt, range.ms > 86_400_000)}<span className="block text-[11px] text-faint">{relTime(r.startedAt)}</span></span>
                <span className="text-right font-mono tnum">{r.endedAt ? fmtClock(r.durationMs) : <span className="text-faint">…</span>}</span>
                <span className="min-w-0 truncate" title={r.userId ?? r.anonId ?? ''}>{visitorName(r)}<span className="block truncate text-[11px] text-faint">{[r.city, r.country].filter(Boolean).join(', ') || 'Unknown location'}</span></span>
                <span className="min-w-0 truncate font-mono text-[12px] text-muted">{r.entryPath ?? '–'}</span>
                <span className="text-right tnum">{r.pages}</span>
                <span className="text-right tnum">{r.clicks}{r.rageClicks > 0 && <span className="block text-[11px] text-warn" title="Clicks in rage-click bursts">{r.rageClicks} rage</span>}</span>
                <span className={cn('text-right tnum', r.errors ? 'text-bad' : 'text-faint')}>{r.errors}</span>
                <span className="min-w-0 truncate text-muted">{[r.browser, r.os].filter(Boolean).join(' · ') || '–'}<span className="block text-[11px] capitalize text-faint">{r.device ?? ''}</span></span>
                <span className="min-w-0 truncate text-muted" title={reasonText(r.reason)}>{reasonText(r.reason)}</span>
              </button>
            ))}
          </div>
        </div>
        {list.hasNextPage && (
          <div className="flex justify-center border-t border-line p-3">
            <Button size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Load older recordings'}</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
