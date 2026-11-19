import { useMemo } from 'react';
import type { CostsResponse } from '../api/contract';
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
  const events = d.usage.eventsThisMonth;
  const perMillion = events > 0 ? (d.monthToDate / events) * 1e6 : null;
  const share = d.usage.projectEventsThisMonth !== undefined && events > 0 ? d.usage.projectEventsThisMonth / events : null;
  const chart = useMemo(() => ({
    times: d.daily.map((x) => Date.parse(x.day + 'T12:00:00Z')),
    series: [{ key: 'cost', label: 'Cost', color: 'var(--s1)', values: d.daily.map((x) => x.amount) }],
  }), [d.daily]);

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-[20px] font-semibold leading-snug">
          WGO cost {money(d.monthToDate)} so far this month{events > 0 ? <> for {fmtNum(events)} events</> : null}
        </h2>
        <p className="mt-1 text-[13px] text-muted">
          {perMillion !== null ? <>About {money(perMillion)} per million events. </> : null}
          Last month: {money(d.lastMonth)}.{d.forecast !== undefined && <> At this pace the month ends near {money(d.forecast)}.</>}
        </p>
        {share !== null && (
          <p className="mt-3 text-[13px]">
            <b>{project.name}</b> is about {Math.round(share * 100)}% of the events, so about {money(d.monthToDate * share)} of the cost.
          </p>
        )}
      </Card>

      <Card>
        <CardHeader title="Cost per day" sub="Last 30 days" />
        <div className="px-3 pb-3"><TimeChart times={chart.times} series={chart.series} mode="bars" height={220} format={money} legend={false} /></div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="By AWS service" sub="This month" />
          <BarList rows={d.services.map((s) => ({ key: s.service, label: s.service, value: s.amount }))} format={money} />
        </Card>
        <Card>
          <CardHeader title="Usage" sub="This month" />
          <dl className="space-y-2.5 px-4 pb-4 text-[13px]">
            <div className="flex justify-between gap-4"><dt className="text-muted">Events, whole install</dt><dd className="tnum font-medium">{fmtNum(events)}</dd></div>
            {d.usage.projectEventsThisMonth !== undefined && <div className="flex justify-between gap-4"><dt className="text-muted">Events, {project.name}</dt><dd className="tnum font-medium">{fmtNum(d.usage.projectEventsThisMonth)}</dd></div>}
            <div className="flex justify-between gap-4"><dt className="text-muted">Data bucket size</dt><dd className="tnum font-medium">{bytes(d.usage.dataBucketBytes)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Database storage</dt><dd className="tnum font-medium">{bytes(d.usage.dsqlStorageBytes)}</dd></div>
          </dl>
        </Card>
      </div>
      <p className="text-[11.5px] text-faint">
        From AWS Cost Explorer, for the resources of this stack. Updated {relTime(d.fetchedAt)}; WGO asks at most twice a day, since each request costs $0.01. Recent days can still change.
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
      return <div className="space-y-4"><CostDisclaimer /><EmptyState title="Only project owners can see costs">The cost of the install covers every project in it, so WGO shows it to people who own at least one project. Ask an owner to open this page.</EmptyState></div>;
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
