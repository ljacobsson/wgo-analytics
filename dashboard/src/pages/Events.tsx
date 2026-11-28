import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUp, BellPlus, ChevronRight, ListTree, Search, Target, X } from 'lucide-react';
import { eventConditions } from '../lib/rowFilters';
import { newGoalHref, newTriggerHref, RowActions } from '../ui/RowActions';
import { useClickAliases, useEvents } from '../api/hooks';
import type { AnalyticsEvent, EventType, Filter } from '../api/contract';
import { useProject } from '../lib/project';
import { useTime } from '../lib/time';
import { navigate, pageHref, useRoute, useSetParams } from '../lib/router';
import { Badge, Card, EmptyState, ErrorState, Mono, Skeleton, TypeBadge, useDebounced } from '../ui/kit';
import { FilterBar } from '../ui/FilterBar';
import { AddToDashboard, withFilters } from '../dashboards/AddToDashboard';
import { AttributeTable, eventAttributeRows } from './EventAttributes';
import { useSentinel } from '../ui/useSentinel';
import { ColumnsMenu, EventCell, eventRowMinWidth, useEventColumns, userFilter, type EventColumn } from '../ui/EventColumns';
import { currentFilters, filtersParam, mergeFilters, trafficShown, useFilters } from '../lib/filters';
import { matches, matchesEventSearch } from '../lib/filterMatch';
import { FEED_CAP, LiveCtx, useFirehose } from '../live/store';
import { RowsSkeleton } from './common';
import { Stack } from './Errors';
import { SourcemapsMissing } from './SourcemapsMissing';
import { eventTitle } from '../lib/events';
import { fmtDateTime, fmtTime, shortId } from '../lib/format';

/** Columns shown until someone picks their own (saved per browser). */
const DEFAULT_COLUMNS: EventColumn[] = ['user', 'path', 'browser'];

const TYPES: Array<EventType | ''> = ['', 'pageview', 'click', 'error', 'http_error', 'custom', 'vitals', 'identify'];

/** Conditions that describe "events like this one" for a new trigger (the preselected row conditions). */
export const triggerFiltersFor = (e: AnalyticsEvent): Filter[] => eventConditions(e).filter((c) => c.checked).map((c) => c.filter);

function EventDetails({ e, onSession }: { e: AnalyticsEvent; onSession: (s: string) => void }) {
  const rows = eventAttributeRows(e);
  const { project } = useProject(); const route = useRoute();
  return (
    <div className="sticky left-0 w-[100cqw] space-y-4 border-b border-line/60 bg-[color-mix(in_srgb,var(--bg)_50%,transparent)] px-4 py-4 sm:px-5" onClick={(x) => x.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-faint">
        <span className="tnum">{fmtDateTime(e.ts)}</span><Mono>{e.id}</Mono>
        {e.sessionId && <button className="text-accent hover:underline cursor-pointer" onClick={() => onSession(e.sessionId!)}>Session timeline →</button>}
        {e.sessionId && <a className="text-accent hover:underline" href={'#' + pageHref(project.id, `recordings/${encodeURIComponent(e.sessionId)}`, route.params)}>Watch recording →</a>}
        <span>{rows.length} attributes · hover a row to filter by it</span>
        <button className="ml-auto inline-flex items-center gap-1 text-accent hover:underline cursor-pointer"
          onClick={() => navigate(newTriggerHref(project.id, route.params, 'events', triggerFiltersFor(e)))}>
          <BellPlus size={12} />Create trigger from this event
        </button>
        <button className="inline-flex items-center gap-1 text-accent hover:underline cursor-pointer"
          onClick={() => navigate(newGoalHref(project.id, route.params, triggerFiltersFor(e)))}>
          <Target size={12} />Make this a goal
        </button>
      </div>
      {e.errorStack && <div className="space-y-2"><Stack stack={e.errorStack} />{e.missingSourcemaps && <SourcemapsMissing missing={e.missingSourcemaps} />}</div>}
      <AttributeTable rows={rows} scope="events" />
    </div>
  );
}

function EventRowActions({ e }: { e: AnalyticsEvent }) {
  const conditions = useMemo(() => eventConditions(e), [e]);
  return <RowActions scope="events" conditions={conditions} />;
}

/** How long the arrival animation of revealed rows lasts, glow included (see .row-arrive in index.css). */
const ARRIVE_MS = 2400;
/** Revealed rows open up one after another, top first; after this many the rest open together. */
const STAGGER_ROWS = 12;

/**
 * "N new events" above the list: live events that match the list's filters and arrived after it was loaded (or
 * last revealed). Lives in its own component so that only it re-renders as events stream in. Remounted (key) when
 * the filters change, which restarts the count.
 */
function NewEventsBar({ match, known, onShow }: {
  match: (e: AnalyticsEvent) => boolean; known: Set<string>; onShow: (events: AnalyticsEvent[], truncated: boolean) => void;
}) {
  const store = useContext(LiveCtx);
  useFirehose(true);
  const feed = useSyncExternalStore(store.subscribe, () => store.feed);
  const [since, setSince] = useState(() => Date.now());
  const pending = useMemo(() => feed.filter((it) => it.at > since && !known.has(it.ev.id) && match(it.ev)), [feed, since, known, match]);
  // the feed keeps the latest FEED_CAP events: when it no longer reaches back to `since`, some new ones are gone
  const truncated = feed.length >= FEED_CAP && feed[feed.length - 1].at > since;
  const n = pending.length;
  // keep the last count while the bar closes, so it doesn't read "0 new events" on the way out
  const shownN = useRef(n); if (n > 0) shownN.current = n;
  const show = () => {
    if (!n) return;
    setSince(pending[0].at);
    onShow(pending.map((it) => it.ev), truncated);
  };
  return (
    <div className={`sticky left-0 grid w-[100cqw] transition-[grid-template-rows] duration-300 ease-out ${n ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`} aria-live="polite">
      <div className="overflow-hidden">
        <button onClick={show} tabIndex={n ? 0 : -1}
          className="flex h-9 w-full cursor-pointer items-center justify-center gap-2 border-b border-line/60 bg-accent/10 text-[12.5px] font-medium text-accent transition-colors hover:bg-accent/15">
          <ArrowUp size={13} />
          <span className="tnum">{truncated ? `${FEED_CAP}+` : shownN.current} new {shownN.current === 1 && !truncated ? 'event' : 'events'}</span>
        </button>
      </div>
    </div>
  );
}

export function EventsPage() {
  const { project } = useProject(); const { range, refresh } = useTime(); const route = useRoute(); const set = useSetParams();
  const aliases = useClickAliases(project.id).data;
  const type = route.params.get('type') ?? '', sessionId = route.params.get('sessionId') ?? '';
  const [qIn, setQIn] = useState(route.params.get('q') ?? '');
  const q = useDebounced(qIn, 300);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [cols, setCols] = useEventColumns('events', DEFAULT_COLUMNS);
  const [pageFilters, setPageFilters] = useFilters('events');
  const showUser = (e: AnalyticsEvent) => { const f = userFilter(e); if (f) setPageFilters(mergeFilters(pageFilters, [f])); };
  const toggle = (id: string) => setOpen((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const filters = useMemo(() => ({ type: type || undefined, q: q || undefined, sessionId: sessionId || undefined }), [type, q, sessionId]);
  const ev = useEvents(project.id, range, filters);
  const fetched = useMemo(() => ev.data?.pages.flatMap((p) => p.events) ?? [], [ev.data]);

  // live events: only for a range that ends now, and only with the filters they were matched against
  const fRaw = filtersParam('events'), bots = route.params.get('bots') === '1', dev = route.params.get('dev') === '1';
  const liveOn = range.preset !== 'custom';
  const liveKey = JSON.stringify([project.id, range.preset, type, q, sessionId, fRaw, bots, dev]);
  const match = useMemo(() => {
    const f = fRaw ? (JSON.parse(fRaw) as Filter[]) : [];
    return (e: AnalyticsEvent) => trafficShown(e, bots, dev) && (!type || e.type === type) && (!sessionId || e.sessionId === sessionId)
      && (!q || matchesEventSearch(e, q)) && matches('events', e, f);
  }, [fRaw, bots, dev, type, sessionId, q]);
  const [revealed, setRevealed] = useState<{ key: string; events: AnalyticsEvent[] }>({ key: liveKey, events: [] });
  const [arriving, setArriving] = useState<Map<string, number>>(() => new Map());
  const arriveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(arriveTimer.current), []);
  // revealed rows stay on top until the warehouse returns them too
  const events = useMemo(() => {
    const extra = revealed.key === liveKey ? revealed.events : [];
    if (!extra.length) return fetched;
    const have = new Set(fetched.map((e) => e.id));
    return [...extra.filter((e) => !have.has(e.id)), ...fetched].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  }, [fetched, revealed, liveKey]);
  const known = useMemo(() => new Set(events.map((e) => e.id)), [events]);
  const showNew = (fresh: AnalyticsEvent[], truncated: boolean) => {
    setRevealed((cur) => ({ key: liveKey, events: [...fresh, ...(cur.key === liveKey ? cur.events : [])].slice(0, FEED_CAP * 2) }));
    setArriving(new Map(fresh.map((e, i) => [e.id, Math.min(i, STAGGER_ROWS)])));
    clearTimeout(arriveTimer.current);
    arriveTimer.current = setTimeout(() => setArriving(new Map()), ARRIVE_MS + STAGGER_ROWS * 35);
    // some new events fell out of the live feed: re-query up to now so the warehouse fills in what it has
    if (truncated) refresh();
  };
  const sentinel = useSentinel(() => { if (ev.hasNextPage && !ev.isFetchingNextPage) void ev.fetchNextPage(); }, !!ev.hasNextPage);
  if (ev.isError) return <ErrorState error={ev.error} retry={() => ev.refetch()} />;
  return (
    <div className="space-y-4">
      <FilterBar scope="events" />
      <div className="flex flex-wrap items-center gap-3">
        <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 sm:mx-0 sm:flex-wrap sm:px-0">{TYPES.map((t) => (
          <button key={t || 'all'} onClick={() => set({ type: t || null })} className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-[12px] font-medium transition-all cursor-pointer ${type === t ? 'border-accent/50 bg-accent/15 text-fg' : 'border-line text-muted hover:text-fg hover:border-[var(--line-strong)]'}`}>{t || 'All'}</button>))}</div>
        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto"><AddToDashboard label={false} tile={() => ({ viz: 'bars', measures: [withFilters({ source: 'events', agg: 'count', label: type ? `${type} events` : 'Events', unit: 'count' }, [...currentFilters('events'), ...(type ? [{ field: 'type', op: 'eq' as const, value: type }] : [])])] })} /><ColumnsMenu value={cols} onChange={setCols} defaults={DEFAULT_COLUMNS} />
          <div className="relative min-w-0 flex-1 sm:w-72 sm:flex-none"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" /><input className="field !pl-8" placeholder="Search path, selector, message…" value={qIn} onChange={(e) => { setQIn(e.target.value); }} onBlur={() => set({ q: qIn || null })} /></div></div>
      </div>
      {sessionId && <div className="flex flex-wrap items-center gap-2 text-[13px]"><Badge tone="accent" className="!py-1 !text-[12px]">Session timeline <Mono>{shortId(sessionId, 12)}</Mono><button onClick={() => set({ sessionId: null })} className="cursor-pointer"><X size={12} /></button></Badge><span className="text-muted">Showing every event from this session, newest first.</span></div>}
      <Card className="@container overflow-x-auto">
        {liveOn && !ev.isPending && <NewEventsBar key={liveKey} match={match} known={known} onShow={showNew} />}
        {ev.isPending ? <RowsSkeleton n={10} /> : events.length === 0 ? <EmptyState pinned icon={<ListTree size={22} />} title="No events match">Try a wider time range or clear the filters.</EmptyState> : (
          <div style={{ minWidth: eventRowMinWidth(cols, 32 + 13 + 68 + 84 + 160 + 52 + 48) }}>{events.map((e) => (
            <div key={e.id}>
            <div onClick={() => toggle(e.id)} style={arriving.has(e.id) ? { animationDelay: `${arriving.get(e.id)! * 35}ms` } : undefined}
              className={`group flex h-10 cursor-pointer items-center gap-3 border-b border-line/60 px-4 text-[12.5px] transition-colors hover:bg-[var(--hl)] ${open.has(e.id) ? 'bg-[var(--hl)]' : ''} ${arriving.has(e.id) ? 'row-arrive' : ''}`}>
              <ChevronRight size={13} className={`shrink-0 text-faint transition-transform ${open.has(e.id) ? 'rotate-90' : ''}`} />
              <span className="w-[68px] shrink-0 tnum text-faint">{fmtTime(e.ts)}</span><TypeBadge type={e.type} />
              <span className="min-w-[160px] flex-1 truncate">{eventTitle(e, aliases)}</span>
              {cols.map((c) => <EventCell key={c} col={c} e={e} onUser={() => showUser(e)} onSession={(sid) => set({ sessionId: sid })} />)}
              <EventRowActions e={e} />
            </div>
            {open.has(e.id) && <EventDetails e={e} onSession={(sid) => set({ sessionId: sid })} />}
            </div>))}
            <div ref={sentinel} className="p-3 text-center text-[12px] text-faint">{ev.isFetchingNextPage ? <Skeleton className="mx-auto h-4 w-32" /> : ev.hasNextPage ? '' : 'End of results'}</div>
          </div>)}
      </Card>
    </div>
  );
}
