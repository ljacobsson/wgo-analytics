import { useMemo } from 'react';
import type { CostCategory, CostsResponse, IngestionPaths, SignalCounts } from '../api/contract';
import { ApiError } from '../api/client';
import { useCosts } from '../api/hooks';
import { BarList } from '../charts/BarList';
import { TimeChart } from '../charts/TimeChart';
import { fmtNum, relTime } from '../lib/format';
import { useProject } from '../lib/project';
import { Card, CardHeader, EmptyState, ErrorState, Skeleton } from '../ui/kit';
import { BudgetsCard, CostDisclaimer } from './Budgets';

const bytes = (n: number | null) => {
  if (n === null) return 'not available';
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.round(n / 1e3)} kB`;
};

const CATEGORY: Record<CostCategory, { label: string; color: string; about: string }> = {
  storage: { label: 'Storage', color: 'var(--s1)', about: 'Keeping events, recordings and logs: S3, the database and log storage.' },
  ingestion: { label: 'Ingestion', color: 'var(--s3)', about: 'Taking events in and writing them: the intake API, queues and writers.' },
  querying: { label: 'Querying', color: 'var(--s2)', about: 'Reading them back: the dashboard, MCP, widgets, kiosks and the live view.' },
  other: { label: 'Other', color: 'var(--faint)', about: 'Background jobs, uptime checks, notifications, sign-in and logging.' },
};

const SIGNALS: Array<{ key: keyof SignalCounts; label: string; plural: string }> = [
  { key: 'events', label: 'Events', plural: 'events' },
  { key: 'spans', label: 'Spans', plural: 'spans' },
  { key: 'logs', label: 'Log records', plural: 'log records' },
  { key: 'metricPoints', label: 'Metric points', plural: 'metric points' },
];
const allOf = (c: SignalCounts) => c.events + c.spans + c.logs + c.metricPoints;
const listed = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? '');

/** What came in this month, and the kinds to show: browser events always, the others once any came in. */
function takenIn(d: CostsResponse) {
  const month = d.usage.signalsThisMonth ?? { events: d.usage.eventsThisMonth, spans: 0, logs: 0, metricPoints: 0 };
  const kinds = SIGNALS.filter((s) => s.key === 'events' || month[s.key] > 0 || d.daily.some((x) => (x.signals?.[s.key] ?? 0) > 0));
  return { month, kinds, total: allOf(month), rates: rates(d.ingestionPaths, month) };
}

/**
 * What taking in a million browser events, and a million OpenTelemetry items (spans, log records and metric points
 * together), cost. They go through different functions and queues, so each has its own rate; null: nothing to divide.
 */
function rates(ingestion: IngestionPaths | undefined, c: SignalCounts | undefined) {
  const otel = c ? c.spans + c.logs + c.metricPoints : 0;
  return {
    events: ingestion && c && ingestion.events > 0 && c.events > 0 ? (ingestion.events / c.events) * 1e6 : null,
    otel: ingestion && ingestion.otel > 0 && otel > 0 ? (ingestion.otel / otel) * 1e6 : null,
  };
}

/** "$0.21 per million events and $0.08 per million OpenTelemetry items", or null. */
function ratesText(r: ReturnType<typeof rates>, money: (n: number) => string, otelLabel = 'OpenTelemetry items') {
  const parts = [r.events !== null && `${money(r.events)} per million events`, r.otel !== null && `${money(r.otel)} per million ${otelLabel}`].filter((x): x is string => !!x);
  return parts.length ? listed(parts) : null;
}

/** Shorter AWS service names for the per-category lists. */
const shortService = (s: string) => s.replace(/^(Amazon|AWS)\s*/, '').replace('Simple Storage Service', 'S3').replace('Simple Queue Service', 'SQS');

function Categories({ d, money }: { d: CostsResponse; money: (n: number) => string }) {
  const total = d.categories.reduce((a, c) => a + c.amount, 0);
  const perMillion = ratesText(takenIn(d).rates, money, 'OTel items');
  const stored = (d.usage.dataBucketBytes ?? 0) + (d.usage.dsqlStorageBytes ?? 0);
  const unit = (c: CostsResponse['categories'][number]) => {
    if (c.category === 'ingestion' && perMillion) return <>About {perMillion}</>;
    if (c.category === 'storage' && stored > 0) return <>For {bytes(stored)} stored</>;
    return null;
  };
  return (
    <Card>
      <CardHeader title="Storage, ingestion and querying" sub="This month" />
      <div className="grid gap-x-6 gap-y-5 px-4 pb-4 pt-1 sm:grid-cols-2 xl:grid-cols-4">
        {d.categories.map((c) => {
          const meta = CATEGORY[c.category];
          return (
            <div key={c.category} className="min-w-0">
              <div className="flex items-center gap-2 text-[12.5px] font-medium">
                <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: meta.color }} />
                {meta.label}
              </div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="tnum text-[20px] font-semibold leading-none">{money(c.amount)}</span>
                {total > 0 && <span className="tnum text-[12px] text-muted">{Math.round((c.amount / total) * 100)}%</span>}
              </div>
              {/* a blank line keeps the service lists level when the columns sit side by side */}
              <p className={`mt-1.5 text-[12px] text-muted ${unit(c) ? '' : 'hidden sm:block'}`}>{unit(c) ?? '\u00a0'}</p>
              <p className="mt-1 text-[11.5px] leading-snug text-faint">{meta.about}</p>
              {c.services.length > 0 && (
                <dl className="mt-2.5 space-y-1 text-[12px]">
                  {c.services.slice(0, 4).map((s) => (
                    <div key={s.service} className="flex justify-between gap-3"><dt className="truncate text-muted">{shortService(s.service)}</dt><dd className="tnum">{money(s.amount)}</dd></div>
                  ))}
                </dl>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Setup({ reason }: { reason?: string }) {
  return (
    <Card className="p-5">
      <h2 className="text-[15px] font-semibold">Turn on cost reporting</h2>
      <p className="mt-1 text-[13px] text-muted">WGO reads what this install costs from AWS Cost Explorer. It needs one setting in your AWS account, once:</p>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[13px]">
        <li>In the AWS Billing console, open <b>Cost allocation tags</b>.</li>
        <li>Find <code className="font-mono text-[12px]">aws:cloudformation:stack-name</code> under <b>AWS-generated tags</b> and activate it.</li>
        <li>Costs show up here about a day later.</li>
      </ol>
      <p className="mt-4 text-[12.5px] text-muted">Cost Explorer charges $0.01 per request. WGO asks at most twice a day and keeps the answer in between.</p>
      {reason && <p className="mt-3 text-[11.5px] text-faint">Last answer from AWS: {reason}</p>}
    </Card>
  );
}

function Report({ d }: { d: CostsResponse }) {
  const { project } = useProject();
  const money = useMemo(() => {
    const f = new Intl.NumberFormat('en-US', { style: 'currency', currency: d.currency });
    const small = new Intl.NumberFormat('en-US', { style: 'currency', currency: d.currency, minimumFractionDigits: 2, maximumFractionDigits: 3 });
    return (n: number) => (Math.abs(n) < 0.1 && n !== 0 ? small.format(n) : f.format(n));
  }, [d.currency]);
  const { month, kinds, total, rates: monthRates } = takenIn(d);
  const perMillion = ratesText(monthRates, money);
  const projectTaken = d.usage.projectSignalsThisMonth ? allOf(d.usage.projectSignalsThisMonth) : d.usage.projectEventsThisMonth;
  const share = d.usage.projectShare ?? (projectTaken !== undefined && total > 0 ? projectTaken / total : null);
  // "12% of the events and 90% of the OpenTelemetry items" (the share of the cost weighs them by what taking each in cost)
  const projectParts = (() => {
    const p = d.usage.projectSignalsThisMonth;
    if (!p) return null;
    const otel = (c: SignalCounts) => c.spans + c.logs + c.metricPoints;
    const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`;
    return listed([
      month.events > 0 && `${pct(p.events, month.events)} of the events`,
      otel(month) > 0 && `${pct(otel(p), otel(month))} of the OpenTelemetry items`,
    ].filter((x): x is string => !!x)) || null;
  })();
  const chart = useMemo(() => ({
    times: d.daily.map((x) => Date.parse(x.day + 'T12:00:00Z')),
    series: d.daily.every((x) => x.byCategory)
      ? (Object.keys(CATEGORY) as CostCategory[]).map((c) => ({ key: c, label: CATEGORY[c].label, color: CATEGORY[c].color, values: d.daily.map((x) => x.byCategory[c]) }))
      : [{ key: 'cost', label: 'Cost', color: 'var(--s1)', values: d.daily.map((x) => x.amount) }],
  }), [d.daily]);
  // what came in each day, and what taking a million of each kind in cost that day
  const dayRows = (i: number) => {
    const c = d.daily[i]?.signals;
    if (!c) return [];
    const r = rates(d.daily[i].ingestion, c);
    const fmt = (n: number | null) => (n === null ? '–' : money(n));
    return [
      ...kinds.map((k) => ({ label: k.label, value: fmtNum(c[k.key]) })),
      ...(d.daily[i].ingestion ? [
        { label: 'Ingestion per million events', value: fmt(r.events) },
        ...(kinds.length > 1 ? [{ label: 'Ingestion per million OTel items', value: fmt(r.otel) }] : []),
      ] : []),
    ];
  };

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-[20px] font-semibold leading-snug">
          WGO cost {money(d.monthToDate)} so far this month{total > 0 ? <> for {fmtNum(total)} {kinds.length > 1 ? 'items taken in' : 'events'}</> : null}
        </h2>
        <p className="mt-1 text-[13px] text-muted">
          {kinds.length > 1 && total > 0 ? <>That is {listed(kinds.map((k) => `${fmtNum(month[k.key])} ${k.plural}`))}. </> : null}
          {perMillion ? <>Taking {kinds.length > 1 ? 'them' : 'events'} in cost about {perMillion}. </> : null}
          Last month: {money(d.lastMonth)}.{d.forecast !== undefined && <> At this pace the month ends near {money(d.forecast)}.</>}
        </p>
        {share !== null && (
          <p className="mt-3 text-[13px]">
            <b>{project.name}</b> {projectParts ? <>sent about {projectParts}</> : <>is about {Math.round(share * 100)}% of what came in</>}, so about {money(d.monthToDate * share)} of the cost.
          </p>
        )}
      </Card>

      {d.categories?.length > 0 && <Categories d={d} money={money} />}

      <Card>
        <CardHeader title="Cost per day" sub="Last 30 days" />
        <div className="px-3 pb-3"><TimeChart zoom={false} times={chart.times} series={chart.series} mode="bars" height={kinds.length > 1 ? 290 : 220} format={money} legend={chart.series.length > 1} tipRows={dayRows} /></div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="By AWS service" sub="This month" />
          <BarList rows={d.services.map((s) => ({ key: s.service, label: s.service, value: s.amount }))} format={money} />
        </Card>
        <Card>
          <CardHeader title="Usage" sub="This month" />
          <dl className="space-y-2.5 px-4 pb-4 text-[13px]">
            {kinds.map((k) => <div key={k.key} className="flex justify-between gap-4"><dt className="text-muted">{k.label}, whole install</dt><dd className="tnum font-medium">{fmtNum(month[k.key])}</dd></div>)}
            {projectTaken !== undefined && <div className="flex justify-between gap-4"><dt className="text-muted">{kinds.length > 1 ? 'Everything' : 'Events'}, {project.name}</dt><dd className="tnum font-medium">{fmtNum(projectTaken)}</dd></div>}
            <div className="flex justify-between gap-4"><dt className="text-muted">Data bucket size</dt><dd className="tnum font-medium">{bytes(d.usage.dataBucketBytes)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Database storage</dt><dd className="tnum font-medium">{bytes(d.usage.dsqlStorageBytes)}</dd></div>
          </dl>
        </Card>
      </div>
      <p className="text-[11.5px] text-faint">
        From AWS Cost Explorer, for the resources of this stack. Updated {relTime(d.fetchedAt)}; WGO asks at most twice a day, since each request costs $0.01. Recent days can still change.
        {' '}Lambda and database compute serve several jobs at once, so WGO divides them by each function's compute time and the database's read and write units.
        {' '}Ingestion is divided between browser events and OpenTelemetry (spans, log records and metric points together) by the compute time of the functions that take each in and the messages on their queues; the shared intake, CloudFront and storage writes by requests. Recordings and source maps are in neither. Those parts are estimates.
      </p>
    </div>
  );
}

export function CostsPage() {
  const { project } = useProject();
  const costs = useCosts(project.id);
  if (costs.isPending) return <div className="space-y-4"><Skeleton className="h-28" /><Skeleton className="h-64" /></div>;
  if (costs.isError) {
    if (costs.error instanceof ApiError && costs.error.status === 403) {
      return <div className="space-y-4"><CostDisclaimer /><EmptyState title="Only admins can see costs">The cost of the install covers every project in it, so WGO shows it only to admins: the emails in the ADMIN_EMAILS deploy setting, or, without it, the owners of the first project. Ask one of them to open this page.</EmptyState></div>;
    }
    return <ErrorState error={costs.error} retry={() => costs.refetch()} />;
  }
  return (
    <div className="space-y-4">
      <CostDisclaimer />
      {costs.data.setup ? <Setup reason={costs.data.reason} /> : <Report d={costs.data} />}
      <BudgetsCard />
    </div>
  );
}
