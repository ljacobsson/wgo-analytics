import { useMemo, useState } from 'react';
import { Repeat2 } from 'lucide-react';
import type { RetentionPeriod, RetentionResponse } from '../api/contract';
import { useGoals, useRetention } from '../api/hooks';
import { RetentionChart, type RetentionSeries } from '../charts/RetentionChart';
import { fmtNum } from '../lib/format';
import { useProject } from '../lib/project';
import { useTime } from '../lib/time';
import { Card, CardHeader, EmptyState, ErrorState, Segmented, Skeleton } from '../ui/kit';

const DAY = 86400e3;
/** A range shorter than this gives too few cohorts: the page then looks at the last FALLBACK_DAYS instead. */
const MIN_RANGE_DAYS = 56;
const FALLBACK_DAYS = 84;
/** Months need a longer look to show more than a few cohorts. */
const FALLBACK_MONTH_DAYS = 399;
const MAX_RANGE_DAYS = 399;
const SPLIT_COLORS = ['#22d3ee', '#f59e0b', '#34d399', '#f472b6', '#94a3b8'];

type SplitBy = 'none' | 'device' | 'country' | 'source';
const UNIT: Record<RetentionPeriod, string> = { day: 'day', week: 'week', month: 'month' };

const pct = (v: number) => `${+(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
const fmtCohort = (iso: string, p: RetentionPeriod) => {
  const d = new Date(iso);
  if (p === 'month') return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const s = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return p === 'week' ? `Week of ${s}` : s;
};
const fmtDay = (day: string) => new Date(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function Cell({ value, counts, size, label }: { value: number; counts: number; size: number; label: string }) {
  return (
    <td className="p-0.5">
      <div className="rounded-md px-1 py-1.5 text-center text-[12px] tnum"
        style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(Math.min(1, value) * 85)}%, transparent)`, color: value > 0.55 ? '#fff' : undefined }}
        title={`${fmtNum(counts)} of ${fmtNum(size)} ${label}`}>
        {pct(value)}
      </div>
    </td>
  );
}

function CohortTable({ data, who, back }: { data: RetentionResponse; who: string; back: string }) {
  const cols = Math.max(0, ...data.cohorts.map((c) => c.values.length));
  const unit = UNIT[data.period];
  const rows = data.cohorts; // oldest first: the triangle narrows downwards
  return (
    <div className="overflow-x-auto px-3 pb-3">
      <table className="w-full min-w-[560px] border-collapse text-[12.5px]">
        <thead>
          <tr className="text-left text-[11.5px] font-medium text-faint" title={`${unit}s since the cohort's start`}>
            <th className="px-2 pb-1.5 font-medium">Cohort</th>
            <th className="px-2 pb-1.5 text-right font-medium">Size</th>
            {Array.from({ length: cols }, (_, k) => <th key={k} className="px-1 pb-1.5 text-center font-medium tnum">{k}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.average.length > 0 && (
            <tr className="border-b border-line">
              <td className="px-2 py-1 font-medium">Average</td>
              <td className="px-2 py-1 text-right text-faint tnum">{fmtNum(data.cohorts.reduce((a, c) => a + c.size, 0))}</td>
              {Array.from({ length: cols }, (_, k) => (k < data.average.length
                ? <td key={k} className="p-0.5"><div className="rounded-md px-1 py-1.5 text-center text-[12px] font-medium tnum">{pct(data.average[k])}</div></td>
                : <td key={k} />))}
            </tr>
          )}
          {rows.map((c) => (
            <tr key={c.start}>
              <td className="whitespace-nowrap px-2 py-0.5 text-muted">{fmtCohort(c.start, data.period)}</td>
              <td className="px-2 py-0.5 text-right tnum text-muted">{fmtNum(c.size)}</td>
              {Array.from({ length: cols }, (_, k) => (k < c.values.length && c.size > 0
                ? <Cell key={k} value={c.values[k]} counts={c.counts[k]} size={c.size} label={k === 0 && back === 'any' ? who : `${who} came back (${back === 'any' ? 'any visit' : back}) in ${unit} ${k}`} />
                : <td key={k} />))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RetentionPage() {
  const { project } = useProject();
  const { range } = useTime();
  const goals = useGoals(project.id);
  const [period, setPeriod] = useState<RetentionPeriod>('week');
  const [start, setStart] = useState('first_seen');
  const [ret, setRet] = useState('any');
  const [split, setSplit] = useState<SplitBy>('none');

  // the global range drives the window, unless it is too short to hold more than a cohort or two
  const short = range.ms < MIN_RANGE_DAYS * DAY;
  const win = useMemo(() => {
    const to = Math.floor(Date.parse(range.to) / 60_000) * 60_000;
    const from = short ? to - (period === 'month' ? FALLBACK_MONTH_DAYS : FALLBACK_DAYS) * DAY : Math.max(Date.parse(range.from), to - MAX_RANGE_DAYS * DAY);
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  }, [range.from, range.to, short, period]);
  const q = useRetention(project.id, { ...win, period, start, return: ret, split });

  const goalName = (v: string) => goals.data?.find((g) => `goal:${g.id}` === v)?.name ?? 'the goal';
  const who = start === 'first_seen' ? 'new visitors' : `visitors who first reached “${goalName(start)}”`;
  const back = ret === 'any' ? 'any' : `“${goalName(ret)}”`;

  const series = useMemo<RetentionSeries[]>(() => {
    if (!q.data) return [];
    const out: RetentionSeries[] = [{ key: 'average', label: 'Average', color: 'var(--accent)', values: q.data.average }];
    q.data.splits?.forEach((s, i) => out.push({ key: s.key, label: s.key, color: SPLIT_COLORS[i % SPLIT_COLORS.length], values: s.average }));
    return out;
  }, [q.data]);

  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const data = q.data;
  const total = data?.cohorts.reduce((a, c) => a + c.size, 0) ?? 0;
  const goalOptions = (goals.data ?? []).map((g) => ({ id: `goal:${g.id}`, name: g.name }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        <Segmented value={period} onChange={setPeriod} options={[{ value: 'day', label: 'Days' }, { value: 'week', label: 'Weeks' }, { value: 'month', label: 'Months' }]} />
        <label className="flex items-center gap-2 text-[12.5px] text-muted">Who
          <select className="field !w-auto" value={start} onChange={(e) => setStart(e.target.value)}>
            <option value="first_seen">New visitors</option>
            {goalOptions.map((g) => <option key={g.id} value={g.id}>Reached goal: {g.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[12.5px] text-muted">Came back to
          <select className="field !w-auto" value={ret} onChange={(e) => setRet(e.target.value)}>
            <option value="any">Anything</option>
            {goalOptions.map((g) => <option key={g.id} value={g.id}>Goal: {g.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[12.5px] text-muted">Split by
          <select className="field !w-auto" value={split} onChange={(e) => setSplit(e.target.value as SplitBy)}>
            <option value="none">None</option><option value="device">Device</option><option value="country">Country</option><option value="source">Source</option>
          </select>
        </label>
      </div>

      <p className="text-[13px] text-muted">
        Of {who}, the share that came back to {back === 'any' ? 'the site' : back} in each {UNIT[period]} after the one they started in.
        {short
          ? ` The time range above is shorter than ${MIN_RANGE_DAYS / 7} weeks, so this page looks at the last ${period === 'month' ? '13 months' : `${FALLBACK_DAYS / 7} weeks`}. Pick a longer range (up to 400 days) to change that.`
          : ' The time range above sets which cohorts are shown.'}
        {' '}Days, weeks (starting Monday) and months are UTC.
      </p>

      {!data ? (
        <Card className="p-4"><Skeleton className="h-64 w-full" /></Card>
      ) : data.dataSince === null || total === 0 ? (
        <Card>
          <EmptyState icon={<Repeat2 size={22} />} title={data.dataSince === null ? 'No retention data yet' : 'No visitors in these cohorts'}>
            {data.dataSince === null
              ? 'Retention is built each night from the previous day’s visits; the first numbers show up after the first full day.'
              : <>Nobody started in this range{start !== 'first_seen' ? ' by reaching that goal' : ''}. Data goes back to {fmtDay(data.dataSince)}; try a longer range or another goal.</>}
          </EmptyState>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader title="Retention curve" sub={`Share of each cohort that came back, by ${UNIT[period]}s since the start. ${fmtNum(total)} people in ${data.cohorts.length} cohorts.`} />
            <div className="px-3 pb-3"><RetentionChart series={series} unit={UNIT[period]} /></div>
          </Card>
          <Card>
            <CardHeader title="Cohorts" sub={`Columns are ${UNIT[period]}s since the cohort's start. Hover a cell for the number of people; only periods that are over are shown.`} />
            <CohortTable data={data} who={who} back={ret} />
          </Card>
          <p className="text-[11.5px] text-faint">
            Data goes back to {fmtDay(data.dataSince)}; people first seen before that count as new on that day. Retention is built each night from the previous day’s visits and kept for 400 days, longer than raw events.
            Bots are left out. A visitor who logs in is counted as one person from then on (user id), so a first visit before login can show up as a separate, earlier visitor.
            {data.splits ? ' A visitor is split by their first visit in the cohort; the five biggest groups are shown.' : ''}
          </p>
        </>
      )}
    </div>
  );
}
