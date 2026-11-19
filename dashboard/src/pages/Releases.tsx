import { useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronDown, ChevronRight, Rocket } from 'lucide-react';
import type { ReleaseHealth, ReleasesResponse, ServiceVersionHealth, Verdict } from '../api/contract';
import { useReleases, useStats } from '../api/hooks';
import { TimeChart, type ChartMarker } from '../charts/TimeChart';
import { cn, fmtDateTime, fmtMs, fmtNum, relTime } from '../lib/format';
import { useProject } from '../lib/project';
import { pageHref, useRoute } from '../lib/router';
import { useTime } from '../lib/time';
import { FilterBar } from '../ui/FilterBar';
import { Card, CardHeader, EmptyState, ErrorState, Mono, Skeleton, TYPE_COLOR } from '../ui/kit';
import { RowsSkeleton, TableHead } from './common';

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(n / d < 0.1 ? 1 : 0)}%` : '–');

/** A value coloured by how it compares with the release before (green better, red worse), with an arrow. */
function Judged({ v, children, title }: { v: Verdict | undefined; children: React.ReactNode; title?: string }) {
  const Icon = v === 'worse' ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn('inline-flex items-center justify-end gap-0.5 tnum', v === 'worse' && 'text-bad font-medium', v === 'better' && 'text-good')} title={title}>
      {children}{v && <Icon size={12} className={cn(v === 'better' && 'rotate-0')} />}
    </span>
  );
}

const verdictTitle = (v: Verdict | undefined, prev: string | null, what: string) =>
  !prev ? undefined : v === 'worse' ? `${what} is clearly worse than in ${prev}` : v === 'better' ? `${what} is clearly better than in ${prev}` : `No clear difference from ${prev}`;

const WEB_COLS = 'grid-cols-[minmax(200px,1.6fr)_90px_120px_120px_80px_80px_70px_minmax(140px,1fr)]';

function WebRow({ r, pid }: { r: ReleaseHealth; pid: string }) {
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const goal = r.goals[0];
  const t = (k: string, what: string) => verdictTitle(r.verdicts[k], r.previous, what);
  const worse = Object.values(r.verdicts).filter((v) => v === 'worse').length;
  return (
    <div className="border-b border-line/60">
      <div role="button" tabIndex={0} onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(!open); }}
        className={cn('grid w-full cursor-pointer items-center gap-4 px-4 py-2.5 text-left text-[13px] transition-colors hover:bg-[var(--hl)]', WEB_COLS)}>
        <div className="flex min-w-0 items-center gap-2">
          {open ? <ChevronDown size={14} className="shrink-0 text-faint" /> : <ChevronRight size={14} className="shrink-0 text-faint" />}
          <div className="min-w-0">
            <div className="flex items-center gap-2"><Mono className="truncate font-medium text-fg">{r.version}</Mono>{worse > 0 && <span className="text-[11.5px] text-bad">{worse} worse</span>}</div>
            <div className="truncate text-[11.5px] text-faint" title={fmtDateTime(r.firstSeen)}>First seen {relTime(r.firstSeen)}{r.previous && <> · compared with <Mono>{r.previous}</Mono></>}</div>
          </div>
        </div>
        <div className="text-right tnum">{fmtNum(r.sessions)}</div>
        <div className="text-right"><Judged v={r.verdicts.errorSessions} title={t('errorSessions', 'The share of sessions with an error')}>{pct(r.errorSessions, r.sessions)}</Judged></div>
        <div className="text-right"><Judged v={r.verdicts.failedRequestSessions} title={t('failedRequestSessions', 'The share of sessions with a failed request')}>{pct(r.failedRequestSessions, r.sessions)}</Judged></div>
        <div className="text-right"><Judged v={r.verdicts.lcp} title={t('lcp', 'LCP')}>{fmtMs(r.vitals.lcp)}</Judged></div>
        <div className="text-right"><Judged v={r.verdicts.inp} title={t('inp', 'INP')}>{fmtMs(r.vitals.inp)}</Judged></div>
        <div className="text-right"><Judged v={r.verdicts.cls} title={t('cls', 'CLS')}>{r.vitals.cls == null ? '–' : r.vitals.cls.toFixed(3)}</Judged></div>
        <div className="min-w-0 text-right">{goal ? <Judged v={r.verdicts[`goal:${goal.id}`]} title={t(`goal:${goal.id}`, `${goal.name} conversion`)}>{pct(goal.converted, r.sessions)}</Judged> : <span className="text-faint">–</span>}</div>
      </div>
      {open && (
        <div className="grid grid-cols-1 gap-5 bg-[var(--hl)]/40 px-10 pb-4 pt-1 text-[12.5px] lg:grid-cols-2">
          <div>
            <h4 className="mb-1.5 text-[12.5px] font-semibold">New errors in this release</h4>
            {!r.previous && Date.parse(r.firstSeen) < Date.now() ? <p className="text-muted">Shown for releases first seen in the selected range, which have a release before them to compare with.</p> : null}
            {r.newErrors.length === 0 ? (r.previous ? <p className="text-muted">None. Every error in this release also happened before it.</p> : null) : (
              <ul className="divide-y divide-line/60 rounded-lg border border-line bg-[var(--raised)]">{r.newErrors.map((e) => (
                <li key={e.fingerprint}><a className="flex items-center gap-3 px-3 py-2 hover:bg-[var(--hl)]" href={'#' + pageHref(pid, 'errors', route.params, { fp: e.fingerprint })}>
                  <span className="min-w-0 flex-1 truncate">{e.message}</span><span className="tnum text-muted">{fmtNum(e.count)}</span></a></li>))}</ul>)}
          </div>
          <div>
            <h4 className="mb-1.5 text-[12.5px] font-semibold">Goals</h4>
            {r.goals.length === 0 ? <p className="text-muted">No goals yet. Conversion rates per release show up here once the project has goals.</p> : (
              <ul className="space-y-1">{r.goals.map((g) => (
                <li key={g.id} className="flex items-center justify-between gap-3"><span className="truncate text-muted">{g.name}</span>
                  <Judged v={r.verdicts[`goal:${g.id}`]} title={t(`goal:${g.id}`, `${g.name} conversion`)}>{pct(g.converted, r.sessions)} <span className="ml-1 text-faint">({fmtNum(g.converted)})</span></Judged></li>))}</ul>)}
            <p className="mt-3 text-[11.5px] text-faint">{fmtNum(r.errors)} errors in total · {fmtNum(r.vitals.samples)} Web Vitals samples · last seen {relTime(r.lastSeen)}</p>
          </div>
        </div>
      )}
    </div>
  );
}

const SVC_COLS = 'grid-cols-[minmax(140px,1fr)_minmax(160px,1.2fr)_90px_110px_90px_90px]';

function ServiceRow({ s }: { s: ServiceVersionHealth }) {
  const t = (k: string, what: string) => verdictTitle(s.verdicts[k], s.previous, what);
  return (
    <div className={cn('grid items-center gap-4 border-b border-line/60 px-4 py-2.5 text-[13px]', SVC_COLS)}>
      <div className="truncate font-medium">{s.service}</div>
      <div className="min-w-0"><Mono className="truncate text-fg">{s.version}</Mono><div className="truncate text-[11.5px] text-faint" title={fmtDateTime(s.firstSeen)}>First seen {relTime(s.firstSeen)}{s.previous && <> · compared with <Mono>{s.previous}</Mono></>}</div></div>
      <div className="text-right tnum">{fmtNum(s.spans)}</div>
      <div className="text-right"><Judged v={s.verdicts.errorRate} title={t('errorRate', 'The error rate')}>{pct(s.errors, s.spans)}</Judged></div>
      <div className="text-right tnum text-muted">{fmtMs(s.p50Ms)}</div>
      <div className="text-right"><Judged v={s.verdicts.p95} title={t('p95', 'p95 latency')}>{fmtMs(s.p95Ms)}</Judged></div>
    </div>
  );
}

export const markerLabel = (m: ReleasesResponse['markers'][number]) => (m.kind === 'web' ? `Release ${m.version} first seen` : `${m.service} ${m.version} first seen`);

export function ReleasesPage() {
  const { project } = useProject(); const { range } = useTime();
  const rel = useReleases(project.id, range);
  const stats = useStats(project.id, range);
  const s = stats.data;
  const chart = useMemo(() => {
    if (!s) return null;
    const times = s.series.map((p) => Date.parse(p.t));
    return { times, series: [
      { key: 'error', label: 'Errors', color: TYPE_COLOR.error, values: s.series.map((p) => p.error) },
      { key: 'http_error', label: 'Failed requests', color: TYPE_COLOR.http_error, values: s.series.map((p) => p.http_error) },
    ] };
  }, [s]);
  const markers: ChartMarker[] = (rel.data?.markers ?? []).map((m) => ({ t: Date.parse(m.firstSeen), label: markerLabel(m), color: m.kind === 'web' ? 'var(--accent)' : 'var(--muted)' }));

  if (rel.isError) return <ErrorState error={rel.error} retry={() => rel.refetch()} />;
  const d = rel.data;
  const none = d && !d.web.length && !d.services.length;
  return (
    <div className="space-y-4">
      <FilterBar scope="events" />
      <Card>
        <CardHeader title="Errors and deploys" sub={d ? `${fmtNum(d.markers.length)} ${d.markers.length === 1 ? 'version' : 'versions'} first seen in this range` : '…'} />
        <div className="px-3 pb-3">{!chart ? <Skeleton className="h-[200px]" /> : <TimeChart times={chart.times} series={chart.series} mode="bars" height={200} markers={markers} bucketMs={(s?.bucketSeconds ?? 60) * 1000} />}</div>
      </Card>

      {none ? (
        <Card><EmptyState icon={<Rocket size={22} />} title="No versions in this range">
          Tell WGO which version is running and each release gets compared with the one before it.
          <span className="mt-3 block text-left font-mono text-[12px] text-muted">
            Web: data-release="1.4.2" on the script tag, or release: '1.4.2' in WGO.init<br />
            Backends: OTEL_RESOURCE_ATTRIBUTES=service.version=1.4.2
          </span>
        </EmptyState></Card>
      ) : (
        <>
          <Card className="@container overflow-x-auto">
            <CardHeader title="Web releases" sub="Each release compared with the one first seen before it. Red: clearly worse, green: clearly better." />
            <div className="min-w-[980px]">
              <TableHead className={WEB_COLS} cols={['Release', ['Sessions', 'text-right'], ['With errors', 'text-right'], ['Failed requests', 'text-right'], ['LCP', 'text-right'], ['INP', 'text-right'], ['CLS', 'text-right'], [d?.web[0]?.goals[0]?.name ?? 'Goal', 'text-right truncate']]} />
              {!d ? <RowsSkeleton n={4} /> : d.web.length === 0 ? <p className="px-4 py-6 text-[12.5px] text-muted">No web releases in this range. Set <Mono>data-release</Mono> on the script tag to compare them.</p>
                : d.web.map((r) => <WebRow key={r.version} r={r} pid={project.id} />)}
            </div>
          </Card>
          <Card className="@container overflow-x-auto">
            <CardHeader title="Service versions" sub="From OpenTelemetry's service.version" />
            <div className="min-w-[700px]">
              <TableHead className={SVC_COLS} cols={['Service', 'Version', ['Spans', 'text-right'], ['Errors', 'text-right'], ['p50', 'text-right'], ['p95', 'text-right']]} />
              {!d ? <RowsSkeleton n={3} /> : d.services.length === 0 ? <p className="px-4 py-6 text-[12.5px] text-muted">No service versions in this range. Set <Mono>service.version</Mono> in your OpenTelemetry resource to compare them.</p>
                : d.services.map((v) => <ServiceRow key={`${v.service}|${v.version}`} s={v} />)}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
