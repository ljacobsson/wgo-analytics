import { useEffect, useMemo, useRef } from 'react';
import { ArrowLeft, ListTree, MonitorPlay } from 'lucide-react';
import type { AnalyticsEvent } from '../api/contract';
import { useEvents, useRecording } from '../api/hooks';
import { cn, fmtDateTime } from '../lib/format';
import { useProject } from '../lib/project';
import { pageHref, useRoute } from '../lib/router';
import type { TimeRange } from '../lib/time';
import { Card, EmptyState, ErrorState, Kbd, Skeleton } from '../ui/kit';
import { Controls, fmtClock, FullscreenButton, usePlayback, Viewport, type Marker } from '../replay/Player';
import { buildTimeline } from '../replay/timeline';
import { reasonText, visitorName } from './Recordings';

const SHOWN = new Set(['pageview', 'click', 'error', 'http_error', 'custom', 'identify']);
const DOT: Record<string, string> = { pageview: 'var(--s1)', click: 'var(--s3)', error: 'var(--bad)', http_error: 'var(--s2)', custom: 'var(--s7)', identify: 'var(--s5)' };

function eventText(e: AnalyticsEvent): string {
  switch (e.type) {
    case 'pageview': return e.path ?? e.url ?? 'Page view';
    case 'click': return `Clicked ${e.trackName ?? e.elementText ?? e.selector ?? 'an element'}`;
    case 'error': return e.errorMessage ?? 'Error';
    case 'http_error': return `${e.httpMethod} ${e.httpStatus || 'network error'} ${e.httpRoute ?? e.httpUrl ?? ''}`;
    case 'custom': return e.name ?? 'Custom event';
    case 'identify': return `Signed in as ${e.userId ?? 'a user'}`;
    default: return e.type;
  }
}

export function RecordingPlayerPage({ sessionId }: { sessionId: string }) {
  const { project } = useProject();
  const route = useRoute();
  const rec = useRecording(project.id, sessionId);
  const tl = useMemo(() => (rec.data?.chunks.length ? buildTimeline(rec.data.chunks) : null), [rec.data]);
  const { pb, state } = usePlayback(tl);
  const shell = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // the session's events, over the stretch the recording covers
  const window_: TimeRange = useMemo(() => {
    const from = tl ? tl.start - 120_000 : Date.now() - 86_400_000;
    const to = tl ? tl.end + 120_000 : Date.now();
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), label: '', preset: 'custom', ms: to - from };
  }, [tl]);
  const ev = useEvents(project.id, window_, { sessionId }, !!tl, 500);
  const events = useMemo(() => (ev.data?.pages.flatMap((p) => p.events) ?? []).filter((e) => SHOWN.has(e.type)).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)), [ev.data]);
  const markers = useMemo<Marker[]>(() => [
    ...events.filter((e) => e.type === 'error' || e.type === 'http_error').map((e) => ({ at: Date.parse(e.ts), kind: 'error' as const, label: eventText(e) })),
    ...events.filter((e) => e.type === 'custom').map((e) => ({ at: Date.parse(e.ts), kind: 'custom' as const, label: eventText(e) })),
    ...(tl?.navs.slice(1).map((n) => ({ at: n.at, kind: 'nav' as const, label: n.url })) ?? []),
  ], [events, tl]);

  const t = state?.t ?? 0;
  const current = useMemo(() => {
    let i = -1;
    for (let k = 0; k < events.length && Date.parse(events[k].ts) <= t + 50; k++) i = k;
    return i;
  }, [events, t]);
  useEffect(() => {
    if (!state?.playing || current < 0) return;
    list.current?.querySelector(`[data-i="${current}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [current, state?.playing]);

  // keyboard: space plays and pauses, arrows skip 5 s
  useEffect(() => {
    if (!pb) return;
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ') { e.preventDefault(); pb.toggle(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); pb.seek(pb.t + 5000); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); pb.seek(pb.t - 5000); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [pb]);
  // start playing once loaded
  useEffect(() => { pb?.play(); }, [pb]);

  const back = '#' + pageHref(project.id, 'recordings', route.params);
  const r = rec.data?.recording;
  const status = (rec.error as { status?: number } | null)?.status;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <a href={back} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted hover:text-fg"><ArrowLeft size={14} />All recordings</a>
        {r && (
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 text-[12.5px] text-muted">
            <span className="text-[14px] font-semibold text-fg">{visitorName(r)}</span>
            <span>{fmtDateTime(r.startedAt)}</span>
            <span>{[r.browser, r.os, r.device].filter(Boolean).join(' · ')}</span>
            <span>{[r.city, r.country].filter(Boolean).join(', ')}</span>
            <span>Recorded because: {reasonText(r.reason).replace(/^./, (c) => c.toLowerCase())}</span>
          </div>
        )}
      </div>

      {rec.isLoading ? <Skeleton className="h-[560px] rounded-xl" /> : status === 404 ? (
        <Card><EmptyState icon={<MonitorPlay size={22} />} title="This session wasn't recorded"
          action={<a className="text-[12.5px] text-accent hover:underline" href={'#' + pageHref(project.id, 'events', route.params, { sessionId })}>See its events instead →</a>}>
          Only sessions picked by your recording settings are recorded.
        </EmptyState></Card>
      ) : rec.isError ? <Card><ErrorState error={rec.error} retry={() => rec.refetch()} /></Card> : !tl || !pb || !state ? (
        <Card><EmptyState icon={<MonitorPlay size={22} />} title="Nothing recorded yet">The first part of a recording arrives within a minute of the session starting.</EmptyState></Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div ref={shell} className="flex flex-col gap-3 rounded-2xl bg-[var(--bg)] [&:fullscreen]:p-4">
            <Viewport tl={tl} pb={pb} className="h-[calc(100vh-300px)] min-h-[420px] [:fullscreen_&]:h-auto [:fullscreen_&]:flex-1" />
            <Controls tl={tl} pb={pb} state={state} markers={markers} extra={<FullscreenButton target={shell} />} />
            <p className="text-[11.5px] text-faint"><Kbd>space</Kbd> play or pause · <Kbd>←</Kbd> <Kbd>→</Kbd> 5 seconds · the page is rebuilt from snapshots, so animations and video don't play</p>
          </div>

          <Card className="flex max-h-[calc(100vh-180px)] min-h-[420px] flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="text-[13px] font-semibold">Events</span>
              <a href={'#' + pageHref(project.id, 'events', route.params, { sessionId })} className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-fg"><ListTree size={13} />Open in Events</a>
            </div>
            <div ref={list} className="min-h-0 flex-1 overflow-y-auto py-1">
              {ev.isLoading ? <div className="space-y-2 p-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8" />)}</div> : !events.length ? (
                <p className="px-4 py-6 text-center text-[12.5px] text-faint">No events from this session.</p>
              ) : events.map((e, i) => {
                const at = Date.parse(e.ts);
                return (
                  <button key={e.id} data-i={i} onClick={() => pb.seek(at - 1500)}
                    className={cn('flex w-full items-start gap-3 px-4 py-2 text-left text-[12.5px] transition-colors hover:bg-[var(--hl)] cursor-pointer', i === current && 'bg-accent/10', at > t + 50 && 'opacity-55')}>
                    <span className="w-10 shrink-0 pt-px text-right font-mono text-[11px] tnum text-faint">{fmtClock(Math.max(0, at - tl.start))}</span>
                    <i className="mt-[5px] h-2 w-2 shrink-0 rounded-full" style={{ background: DOT[e.type] }} />
                    <span className={cn('min-w-0 break-words', (e.type === 'error' || e.type === 'http_error') && 'text-bad')}>{eventText(e)}</span>
                  </button>
                );
              })}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
