import { lazy, Suspense, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { MapCallout } from '../charts/MapCallout';
import { cellKey, type CalloutGroup, type CalloutMode } from '../charts/geoTypes';
import { MousePointerClick, Bug, Globe, Eye, Users, Layers, Download, MapPin, Target } from 'lucide-react';
import { useBreakdown, useClicks, useConversions, useGeo, usePages, usePreviousConversions, usePreviousTotals, useReleaseMarkers, useStats, useVitals } from '../api/hooks';
import { markerLabel } from './Releases';
import { conversionRate, fmtRate, goalEventsHref, previousRate } from './Goals';
import { countryName, flag } from '../lib/geo';
import { clickLabel } from '../lib/events';

const GeoMap = lazy(() => import('../charts/GeoMap'));
import { useProject } from '../lib/project';
import { navigate, pageHref, useRoute } from '../lib/router';
import { useTime } from '../lib/time';
import { Card, CardHeader, CountUp, Delta, EmptyState, ErrorState, Segmented, Skeleton, TYPE_COLOR, Button } from '../ui/kit';
import { Sparkline } from '../charts/Sparkline';
import { TimeChart } from '../charts/TimeChart';
import { BarList } from '../charts/BarList';
import { RowActions } from '../ui/RowActions';
import { clickConditions, type RowCondition } from '../lib/rowFilters';
import { fmtNum } from '../lib/format';
import type { AnalyticsEvent, EventsResponse, Totals } from '../api/contract';
import type { TimeRange } from '../lib/time';

import { FilterBar } from '../ui/FilterBar';
import { InfoTip } from '../ui/InfoTip';
import { ExplainDrawer, worthExplaining, type ExplainSpec } from '../ui/ExplainDrawer';
/** "Why?": opens the explanation of a change; only offered when the change is beyond noise. */
function WhyButton({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={(e) => { e.stopPropagation(); onClick(); }} className="cursor-pointer text-[11.5px] font-medium text-muted underline decoration-dotted underline-offset-2 hover:text-fg" title="See what this change comes from">Why?</button>;
}

function Kpi({ label, icon, cur, prev, spark, color, invert, note, onWhy }: { label: string; icon: React.ReactNode; cur?: number; prev?: number; spark?: number[]; color: string; invert?: boolean; note?: string; onWhy?: () => void }) {
  return (
    <Card className="relative overflow-hidden p-4" hover>
      <div className="flex items-center justify-between text-muted"><span className="flex items-center gap-2 text-[12px] font-medium">{icon}{label}</span>
        {cur != null && prev != null && <Delta cur={cur} prev={prev} invert={invert} />}</div>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <div className="kpi text-[28px] font-semibold leading-none tracking-tight">{cur == null ? <Skeleton className="h-7 w-24" /> : <CountUp value={cur} format={fmtNum} />}</div>
        {onWhy && worthExplaining(cur, prev) && <WhyButton onClick={onWhy} />}
      </div>
      <div className="mt-3 h-8">{spark ? <Sparkline data={spark} color={color} height={32} /> : <div className="pt-2 text-[11.5px] text-faint">{note}</div>}</div>
    </Card>
  );
}

// What each Web Vital measures; thresholds are added from RATINGS so the text always matches the bars.
const VITAL_INFO: Record<string, { name: string; what: string }> = {
  lcp: { name: 'Largest Contentful Paint', what: 'How long until the main content (the largest image or text block) has rendered. The best single measure of perceived load speed.' },
  fcp: { name: 'First Contentful Paint', what: 'How long until anything (text, an image) first appears, so the visitor sees the page is loading.' },
  cls: { name: 'Cumulative Layout Shift', what: 'How much the content jumps around while it loads, as a score (lower is better). Unexpected shifts make people click the wrong thing.' },
  inp: { name: 'Interaction to Next Paint', what: 'How quickly the page visibly responds to clicks, taps and key presses, measured over the visit.' },
  ttfb: { name: 'Time to First Byte', what: 'How long until the first byte of the page arrives from the server: network plus server time.' },
};
const fmtThreshold = (v: number, unit: string) => (unit === 'ms' ? (v >= 1000 ? `${v / 1000} s` : `${v} ms`) : String(v));

const RATINGS: Record<string, { good: number; poor: number; unit: string; label: string }> = {
  lcp: { good: 2500, poor: 4000, unit: 'ms', label: 'LCP' }, fcp: { good: 1800, poor: 3000, unit: 'ms', label: 'FCP' },
  cls: { good: 0.1, poor: 0.25, unit: '', label: 'CLS' }, inp: { good: 200, poor: 500, unit: 'ms', label: 'INP' }, ttfb: { good: 800, poor: 1800, unit: 'ms', label: 'TTFB' },
};
function VitalsCard() {
  const { project } = useProject(); const { range } = useTime();
  const v = useVitals(project.id, range);
  return (
    <Card>
      <CardHeader title="Web Vitals" sub={<span className="inline-flex items-center gap-1">
        p75
        <InfoTip label="What is p75?">
          <b className="text-fg">p75, the 75th percentile.</b> 3 out of 4 page loads were this fast or faster. It’s how Google rates
          Web Vitals: typical-but-not-best experience, without a few extreme visits skewing it.
        </InfoTip>
        {v.data && <> · {fmtNum(v.data.samples)} samples</>}
      </span>} />
      <div className="space-y-3 px-4 pb-4">
        {v.isPending && Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-9" />)}
        {v.data && Object.entries(RATINGS).map(([k, r]) => {
          const val = v.data.p75[k as keyof typeof v.data.p75];
          const rating = val == null ? null : val <= r.good ? 'good' : val <= r.poor ? 'needs improvement' : 'poor';
          const tone = rating === 'good' ? 'var(--good)' : rating === 'poor' ? 'var(--bad)' : 'var(--warn)';
          const pos = val == null ? 0 : Math.min(1, val / (r.poor * 1.5));
          return (
            <div key={k}>
              <div className="flex items-baseline justify-between">
                <span className="inline-flex items-center gap-1 text-[12px] font-medium text-muted">{r.label}
                  <InfoTip label={`What is ${r.label}?`}>
                    <b className="text-fg">{r.label}: {VITAL_INFO[k].name}.</b> {VITAL_INFO[k].what}
                    <span className="mt-1.5 block text-[11.5px]">
                      <span className="text-good">Good</span> ≤ {fmtThreshold(r.good, r.unit)} · <span className="text-bad">poor</span> &gt; {fmtThreshold(r.poor, r.unit)}
                    </span>
                  </InfoTip>
                </span>
                <span className="flex items-center gap-2"><span className="tnum text-[15px] font-semibold">{val == null ? '–' : k === 'cls' ? val.toFixed(3) : Math.round(val)}<span className="ml-0.5 text-[11px] font-normal text-faint">{r.unit}</span></span>
                  {rating && <span className="rounded-md px-1.5 text-[10.5px] font-medium leading-5" style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}>{rating}</span>}</span>
              </div>
              <div className="relative mt-1.5 flex h-1.5 gap-[2px] overflow-visible">
                <i className="rounded-l-full" style={{ flex: `${r.good * 1000} 1 0`, background: 'color-mix(in srgb, var(--good) 45%, transparent)' }} />
                <i style={{ flex: `${(r.poor - r.good) * 1000} 1 0`, background: 'color-mix(in srgb, var(--warn) 45%, transparent)' }} />
                <i className="rounded-r-full" style={{ flex: `${r.poor * 500} 1 0`, background: 'color-mix(in srgb, var(--bad) 45%, transparent)' }} />
                {val != null && <b className="absolute -top-[3px] h-3 w-[3px] rounded bg-fg shadow transition-all duration-500" style={{ left: `calc(${pos * 100}% - 1.5px)` }} />}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const GOAL_TILES = 6;

/** Conversion rate per goal, as tiles under the KPIs. Hidden until the project has goals. */
function GoalTiles({ onWhy }: { onWhy: (s: ExplainSpec) => void }) {
  const { project } = useProject(); const { range } = useTime(); const route = useRoute();
  const conv = useConversions(project.id, range);
  const prev = usePreviousConversions(project.id, range);
  const d = conv.data;
  if (!d?.goals.length) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted"><Target size={13} />Goals · conversion rate of {fmtNum(d.sessions)} sessions</span>
        <button className="text-[12px] text-accent hover:underline cursor-pointer" onClick={() => navigate(pageHref(project.id, 'goals', route.params))}>{d.goals.length > GOAL_TILES ? `All ${d.goals.length} goals` : 'View goals'}</button>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        {d.goals.slice(0, GOAL_TILES).map((g) => {
          const rate = conversionRate(g, d), before = previousRate(prev.data, g.id);
          return (
            <Card key={g.id} className="cursor-pointer p-4" hover onClick={() => navigate(goalEventsHref(project.id, route.params, g.filters))}>
              <div className="flex items-center justify-between gap-2 text-muted">
                <span className="truncate text-[12px] font-medium" title={g.name}>{g.name}</span>
                <span className="flex items-center gap-2">{rate != null && before != null && Math.abs(rate - before) >= 0.1 * before && g.sessions >= 20 && <WhyButton onClick={() => onWhy({ metric: 'goal', goalId: g.id, label: `${g.name} conversion` })} />}
                  {rate != null && before != null && <Delta cur={rate} prev={before} />}</span>
              </div>
              <div className="kpi mt-2 text-[28px] font-semibold leading-none tracking-tight">{fmtRate(rate)}</div>
              <div className="mt-2 truncate text-[11.5px] text-faint">{fmtNum(g.sessions)} sessions · {fmtNum(g.conversions)} conversions</div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/** A breakdown row as a condition: browser = Chrome; the empty referrer is direct traffic (no referrer). */
const dimConditions = (field: string, key: string): RowCondition[] =>
  [{ filter: key ? { field, op: 'eq', value: key } : { field, op: 'not_set' }, checked: true }];

function Breakdowns() {
  const { project } = useProject(); const { range } = useTime();
  const [dim, setDim] = useState<'browser' | 'os' | 'device' | 'referrer' | 'country'>('browser');
  const b = useBreakdown(project.id, range, dim);
  const label = (key: string) => (dim === 'country' && /^[A-Z]{2}$/.test(key) ? `${flag(key)}  ${countryName(key)}` : key || '(direct)');
  return (
    <Card>
      <CardHeader title="Breakdowns" sub="by sessions" right={<Segmented value={dim} onChange={setDim} options={[{ value: 'browser', label: 'Browser' }, { value: 'os', label: 'OS' }, { value: 'device', label: 'Device' }, { value: 'referrer', label: 'Referrer' }, { value: 'country', label: 'Country' }]} />} />
      {b.isPending ? <div className="space-y-2 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-7" />)}</div>
        : b.data?.length ? <BarList color="var(--s7)" rows={b.data.slice(0, 8).map((r) => ({ key: r.key, label: label(r.key), value: r.count, actions: <RowActions scope="events" conditions={dimConditions(dim, r.key)} /> }))} />
        : <EmptyState title="No data yet" />}
    </Card>
  );
}

const CALLOUT_EVENTS = 3;

/** Callout for a dot on the historical map: the latest events from its place(s). */
function HistoryCallout({ pid, range, group, byCell, compact }: { pid: string; range: TimeRange; group: CalloutGroup; byCell: Map<string, AnalyticsEvent[]>; compact: boolean }) {
  const known = group.cells.flatMap((c) => byCell.get(c) ?? []).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, CALLOUT_EVENTS);
  // a quiet place may not be among the most recent located events: ask for that cell directly
  // (only for a selected dot: in 'all' mode that would be one request per dot on screen)
  const single = !compact && group.cells.length === 1 && known.length < CALLOUT_EVENTS ? group.cells[0].split(',') : null;
  const cell = useQuery({
    queryKey: ['cell-events', pid, range.from, range.to, single?.join(',')],
    queryFn: () => api<EventsResponse>(`/api/projects/${pid}/events`, { params: { from: range.from, to: range.to, lat: single![0], lon: single![1], limit: CALLOUT_EVENTS } }),
    enabled: !!single, staleTime: 20_000,
  });
  const events = single && cell.data ? cell.data.events : known;
  if (compact && !events.length) return null;
  return <MapCallout title={group.label} events={events} now={Date.now()} compact={compact} empty={single && cell.isPending ? 'Loading…' : undefined} />;
}

function Visitors() {
  const { project } = useProject(); const { range } = useTime();
  const g = useGeo(project.id, range);
  const [mode, setMode] = useState<CalloutMode>(() => (localStorage.getItem('wgo.mapCallouts') as CalloutMode) || 'off');
  const changeMode = (m: CalloutMode) => { setMode(m); localStorage.setItem('wgo.mapCallouts', m); };
  // most recent located events, grouped per map cell, feed the callouts
  const recent = useQuery({
    queryKey: ['located-events', project.id, range.from, range.to],
    queryFn: () => api<EventsResponse>(`/api/projects/${project.id}/events`, { params: { from: range.from, to: range.to, located: 1, limit: 500 } }),
    enabled: mode !== 'off', staleTime: 20_000,
  });
  const byCell = useMemo(() => {
    const m = new Map<string, AnalyticsEvent[]>();
    for (const e of recent.data?.events ?? []) {
      if (e.lat == null || e.lon == null) continue;
      const k = cellKey(e.lat, e.lon);
      (m.get(k) ?? m.set(k, []).get(k)!).push(e);
    }
    return m;
  }, [recent.data]);
  const points = useMemo(() => (g.data?.points ?? []).map((p) => ({
    key: `${p.lat},${p.lon}`, lat: p.lat, lon: p.lon, value: p.sessions,
    label: [p.city, p.country && countryName(p.country)].filter(Boolean).join(', ') || 'Unknown place',
    sub: `${fmtNum(p.events)} events`,
  })), [g.data]);
  const d = g.data;
  const coverage = d && d.total ? Math.round((d.located / d.total) * 100) : null;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <Card className="overflow-hidden xl:col-span-2">
        <CardHeader title="Where visitors are" sub={d ? `${fmtNum(d.points.length)} places · approximate, from IP at the edge` : 'approximate, from IP at the edge'}
          right={<div className="flex items-center gap-3">
            {coverage != null && <span className="tnum hidden text-[12px] text-muted 2xl:inline">{coverage}% located</span>}
            <span className="text-[11.5px] text-faint">Callouts</span>
            <Segmented value={mode} onChange={changeMode} options={[{ value: 'off', label: 'Off' }, { value: 'selected', label: 'Selected' }, { value: 'all', label: 'All' }]} />
          </div>} />
        <div className="px-3 pb-3">
          <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
            <div className="relative">
              <GeoMap points={points} height={400} callouts={mode}
                renderCallout={(grp) => <HistoryCallout pid={project.id} range={range} group={grp} byCell={byCell} compact={mode === 'all'} />} />
              {mode === 'selected' && d && d.points.length > 0 && <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-raised/80 px-2 py-1 text-[11px] text-muted">Click a dot to see its latest events · double-click to zoom</div>}
              {d && d.points.length === 0 && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center bg-bg/40"><EmptyState icon={<MapPin size={22} />} title="No locations yet">Locations come from CloudFront. Point the snippet's data-endpoint at your ingest URL.</EmptyState></div>
              )}
            </div>
          </Suspense>
        </div>
      </Card>
      <Card>
        <CardHeader title="Countries" sub="by sessions" />
        {g.isPending ? <div className="space-y-2 p-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-7" />)}</div>
          : d?.countries.length ? <BarList color="var(--accent2)" rows={d.countries.slice(0, 10).map((c) => ({ key: c.country, label: `${flag(c.country)}  ${countryName(c.country)}`, value: c.sessions, sub: `${fmtNum(c.events)} ev`, actions: <RowActions scope="events" conditions={dimConditions('country', c.country)} /> }))} />
          : <EmptyState title="No countries yet" />}
      </Card>
    </div>
  );
}

export function Overview() {
  const { project } = useProject(); const { range } = useTime(); const route = useRoute();
  const stats = useStats(project.id, range);
  const prev = usePreviousTotals(project.id, range);
  const pages = usePages(project.id, range);
  const clicks = useClicks(project.id, range);
  const deploys = useReleaseMarkers(project.id, range);
  const [why, setWhy] = useState<ExplainSpec | null>(null);
  const type = (value: string) => [{ field: 'type', op: 'eq' as const, value }];
  const s = stats.data;
  const markers = useMemo(() => (deploys.data ?? []).map((m) => ({ t: Date.parse(m.firstSeen), label: markerLabel(m), color: m.kind === 'web' ? 'var(--accent)' : 'var(--muted)' })), [deploys.data]);
  const chart = useMemo(() => {
    if (!s) return null;
    const times = s.series.map((p) => Date.parse(p.t));
    const mk = (key: 'pageview' | 'click' | 'custom' | 'http_error' | 'error', label: string) => ({ key, label, color: TYPE_COLOR[key], values: s.series.map((p) => p[key]) });
    return { times, series: [mk('pageview', 'Pageviews'), mk('click', 'Clicks'), mk('custom', 'Custom'), mk('http_error', 'HTTP errors'), mk('error', 'Errors')] };
  }, [s]);
  const T = (k: keyof Totals) => s?.totals[k];
  const P = (k: keyof Totals) => prev.data?.[k];
  const sp = (k: 'pageview' | 'click' | 'error' | 'http_error') => s?.series.map((p) => p[k]);
  const empty = s && s.totals.events === 0;

  if (stats.isError) return <ErrorState error={stats.error} retry={() => stats.refetch()} />;
  return (
    <div className="space-y-4">
      <FilterBar scope="events" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Pageviews" icon={<Eye size={14} />} onWhy={() => setWhy({ metric: 'events', where: type('pageview'), label: 'Pageviews' })} cur={T('pageviews')} prev={P('pageviews')} spark={sp('pageview')} color="var(--s1)" />
        <Kpi label="Sessions" icon={<Layers size={14} />} onWhy={() => setWhy({ metric: 'sessions', label: 'Sessions' })} cur={T('sessions')} prev={P('sessions')} color="var(--s7)" note={s && s.totals.sessions ? `${(s.totals.pageviews / s.totals.sessions).toFixed(1)} pages / session${s.botSessions ? ` · ${fmtNum(s.botSessions)} bot sessions hidden` : ''}` : s?.botSessions ? `${fmtNum(s.botSessions)} bot sessions hidden` : ''} />
        <Kpi label="Users" icon={<Users size={14} />} cur={T('users')} prev={P('users')} color="var(--s7)" note={s && s.totals.users ? `${(s.totals.sessions / s.totals.users).toFixed(2)} sessions / user` : ''} />
        <Kpi label="Clicks" icon={<MousePointerClick size={14} />} onWhy={() => setWhy({ metric: 'events', where: type('click'), label: 'Clicks' })} cur={T('clicks')} prev={P('clicks')} spark={sp('click')} color="var(--s3)" />
        <Kpi label="Errors" icon={<Bug size={14} />} onWhy={() => setWhy({ metric: 'events', where: type('error'), label: 'Errors' })} cur={T('errors')} prev={P('errors')} spark={sp('error')} color="var(--s8)" invert />
        <Kpi label="HTTP errors" icon={<Globe size={14} />} onWhy={() => setWhy({ metric: 'events', where: type('http_error'), label: 'Failed requests' })} cur={T('httpErrors')} prev={P('httpErrors')} spark={sp('http_error')} color="var(--s2)" invert />
      </div>

      <GoalTiles onWhy={setWhy} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="Events over time" sub={`${range.label} · ${s ? Math.round(s.bucketSeconds / 60) || 1 : '…'} min buckets`} right={s && <span className="tnum text-[12px] text-muted">{fmtNum(s.totals.events)} events</span>} />
        <div className="px-3 pb-3">
          {!chart ? <Skeleton className="h-[280px]" /> : empty ? (
            <EmptyState icon={<Download size={22} />} title="No events in this range" action={<Button variant="primary" onClick={() => navigate(pageHref(project.id, 'settings', route.params))}>Install the snippet</Button>}>Add the snippet to your site and events will show up here within seconds.</EmptyState>
          ) : <TimeChart times={chart.times} series={chart.series} mode="bars" height={280} markers={markers} bucketMs={s!.bucketSeconds * 1000} />}
        </div>
      </Card>
      <VitalsCard />
      </div>

      <Visitors />
      <ExplainDrawer spec={why} onClose={() => setWhy(null)} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader title="Top pages" sub="by views" />
          {pages.isPending ? <div className="space-y-2 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-7" />)}</div>
            : pages.data?.length ? <BarList mono color="var(--s1)" rows={pages.data.slice(0, 8).map((p) => ({ key: p.path, label: p.path, value: p.views, sub: `${fmtNum(p.sessions)} sess`, actions: <RowActions scope="events" conditions={[{ filter: { field: 'type', op: 'eq', value: 'pageview' }, checked: false }, { filter: { field: 'path', op: 'eq', value: p.path }, checked: true }]} /> }))} /> : <EmptyState title="No pageviews yet" />}
        </Card>
        <Card>
          <CardHeader title="Top clicks" right={<button className="text-[12px] text-accent hover:underline cursor-pointer" onClick={() => navigate(pageHref(project.id, 'clicks', route.params))}>View all</button>} />
          {clicks.isPending ? <div className="space-y-2 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-7" />)}</div>
            : clicks.data?.length ? <BarList color="var(--s3)" rows={clicks.data.slice(0, 8).map((c) => ({ key: c.selector, label: clickLabel(c), value: c.count, actions: <RowActions scope="events" conditions={clickConditions(c)} /> }))} /> : <EmptyState title="No clicks yet" />}
        </Card>
        <Breakdowns />
      </div>
    </div>
  );
}
