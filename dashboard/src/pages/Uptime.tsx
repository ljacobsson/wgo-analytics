import { useEffect, useMemo, useState } from 'react';
import { Activity, BellRing, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import type { Filter, UptimeCheck, UptimeCheckInput } from '../api/contract';
import { getConfig } from '../api/config';
import { useDeleteUptime, useRunUptime, useSaveUptime, useUptime, useUptimeResults } from '../api/hooks';
import { TimeChart } from '../charts/TimeChart';
import { cn, fmtDateTime, fmtMs, fmtTime, relTime } from '../lib/format';
import { useProject } from '../lib/project';
import { navigate, pageHref } from '../lib/router';
import { useTime, type TimeRange } from '../lib/time';
import { AddToDashboard } from '../dashboards/AddToDashboard';
import { Button, Card, Dialog, Drawer, EmptyState, ErrorState, Field, Mono, Skeleton, Switch, useToast } from '../ui/kit';

const REGION_NOTE = (region: string) => `Checks run from ${region}, where WGO is deployed.`;
// the API's address names the region WGO runs in (https://xxx.execute-api.eu-west-1.amazonaws.com)
const REGION = (() => {
  try { return getConfig().apiUrl.match(/\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com/)?.[1] ?? 'the AWS region'; } catch { return 'the AWS region'; }
})();

const INTERVALS = [{ s: 60, label: '1 minute' }, { s: 300, label: '5 minutes' }, { s: 900, label: '15 minutes' }] as const;
const EXPECTS = [{ v: '2xx', label: 'Any 2xx' }, { v: '3xx', label: 'Any 3xx (do not follow redirects)' }, { v: 'exact', label: 'An exact status code' }];

const since = (iso: string | null) => {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'less than a minute';
  if (s < 3600) return `${Math.round(s / 60)} minutes`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} hours`;
  return `${Math.floor(s / 86400)} days`;
};

function stateText(c: UptimeCheck): string {
  if (!c.enabled) return 'Paused';
  if (c.state === 'up') return `Up for ${since(c.stateSince)}`;
  if (c.state === 'down') return `Down since ${fmtTime(c.stateSince!).slice(0, 5)}${Date.now() - Date.parse(c.stateSince!) > 86400e3 ? ` on ${fmtDateTime(c.stateSince!).split(',')[0]}` : ''}`;
  return 'Waiting for the first result';
}

function Dot({ c }: { c: UptimeCheck }) {
  const color = !c.enabled || !c.state ? 'bg-[var(--line-strong)]' : c.state === 'up' ? 'bg-good' : 'bg-bad';
  return <span className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', color)} />;
}

/** 90 thin bars, oldest first: green all good, red some failures, grey no data. Hover for the bucket. */
function Strip({ values, range, height = 28 }: { values: Array<number | null>; range: TimeRange; height?: number }) {
  const from = Date.parse(range.from), span = Date.parse(range.to) - from;
  const label = (v: number | null, i: number) => {
    const t = new Date(from + (i / values.length) * span).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return v === null ? `${t}: no checks` : `${t}: ${(v * 100).toFixed(v === 1 ? 0 : 1)}% up`;
  };
  return (
    <div className="flex w-full gap-[2px]" style={{ height }}>
      {values.map((v, i) => (
        <i key={i} title={label(v, i)} className={cn('min-w-0 flex-1 rounded-[1px]', v === null ? 'bg-[var(--line-strong)] opacity-50' : v >= 1 ? 'bg-good' : v >= 0.5 ? 'bg-warn' : 'bg-bad')} />
      ))}
    </div>
  );
}

const pct = (v: number | null) => (v === null ? '–' : `${(v * 100).toFixed(v >= 0.99995 ? 0 : v >= 0.999 ? 2 : 1)}%`);

function CheckDialog({ open, initial, onClose }: { open: boolean; initial: UptimeCheck | null; onClose: () => void }) {
  const { project } = useProject();
  const save = useSaveUptime(project.id);
  const toast = useToast();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState<'GET' | 'HEAD'>('GET');
  const [expect, setExpect] = useState('2xx');
  const [exact, setExact] = useState('200');
  const [keyword, setKeyword] = useState('');
  const [interval, setIntervalS] = useState<60 | 300 | 900>(300);
  const [timeoutS, setTimeoutS] = useState(10);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setName(initial?.name ?? ''); setUrl(initial?.url ?? ''); setMethod(initial?.method ?? 'GET');
    const e = initial?.expect ?? '2xx';
    setExpect(e === '2xx' || e === '3xx' ? e : 'exact'); setExact(e === '2xx' || e === '3xx' ? '200' : e);
    setKeyword(initial?.keyword ?? ''); setIntervalS(initial?.intervalSeconds ?? 300); setTimeoutS((initial?.timeoutMs ?? 10000) / 1000);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const valid = name.trim() && /^https?:\/\//i.test(url.trim()) && (expect !== 'exact' || /^[1-5]\d\d$/.test(exact)) && timeoutS >= 1 && timeoutS <= 30;
  const submit = async () => {
    setError('');
    const input: UptimeCheckInput = {
      name: name.trim(), url: url.trim(), method, expect: expect === 'exact' ? exact : expect, keyword: method === 'GET' && keyword ? keyword : null,
      intervalSeconds: interval, timeoutMs: Math.round(timeoutS * 1000),
    };
    try {
      await save.mutateAsync({ id: initial?.id, input });
      toast({ title: initial ? 'Check updated' : 'Check added', body: input.name, tone: 'good' });
      onClose();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <Dialog open={open} onClose={onClose} width={560} title={initial ? 'Edit check' : 'Add an uptime check'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid || save.isPending} onClick={submit}>{initial ? 'Save' : 'Add check'}</Button></>}>
      <div className="space-y-3.5">
        <Field label="Name"><input autoFocus className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Marketing site" /></Field>
        <Field label="URL" hint="A public http or https address. Redirects are followed, up to 5."><input className="field font-mono text-[12.5px]" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/health" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Method">
            <select className="field" value={method} onChange={(e) => setMethod(e.target.value as 'GET' | 'HEAD')}><option value="GET">GET</option><option value="HEAD">HEAD</option></select>
          </Field>
          <Field label="Check every">
            <select className="field" value={interval} onChange={(e) => setIntervalS(Number(e.target.value) as 60 | 300 | 900)}>{INTERVALS.map((i) => <option key={i.s} value={i.s}>{i.label}</option>)}</select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Expected status">
            <select className="field" value={expect} onChange={(e) => setExpect(e.target.value)}>{EXPECTS.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}</select>
          </Field>
          <Field label="Timeout (seconds)"><input className="field" type="number" min={1} max={30} value={timeoutS} onChange={(e) => setTimeoutS(Number(e.target.value))} /></Field>
        </div>
        {expect === 'exact' && <Field label="Status code"><input className="field w-28" inputMode="numeric" value={exact} onChange={(e) => setExact(e.target.value)} placeholder="200" /></Field>}
        {method === 'GET' && <Field label="Body must contain (optional)" hint="Looked for in the first 1 MB of the response."><input className="field" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="All systems go" /></Field>}
        <p className="text-[11.5px] text-faint">{REGION_NOTE(REGION)}</p>
        {error && <p className="text-[12.5px] text-bad">{error}</p>}
      </div>
    </Dialog>
  );
}

function CheckDrawer({ check, range, onClose, onEdit }: { check: UptimeCheck | null; range: TimeRange; onClose: () => void; onEdit: (c: UptimeCheck) => void }) {
  const { project } = useProject();
  const toast = useToast();
  const results = useUptimeResults(project.id, check?.id ?? null, range);
  const run = useRunUptime(project.id);
  const del = useDeleteUptime(project.id);
  const save = useSaveUptime(project.id);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setConfirm(false), [check?.id]);

  const chart = useMemo(() => {
    const b = (results.data?.buckets ?? []).filter((x) => x.p50 !== null);
    if (!b.length) return null;
    return {
      times: b.map((x) => Date.parse(x.t)),
      series: [
        { key: 'p50', label: 'Median', color: 'var(--s1)', values: b.map((x) => x.p50 ?? 0) },
        { key: 'p95', label: '95th percentile', color: 'var(--s2)', values: b.map((x) => x.p95 ?? 0) },
      ],
    };
  }, [results.data]);

  const notify = () => {
    if (!check) return;
    const filters: Filter[] = [{ field: 'name', op: 'eq', value: 'wgo.uptime' }, { field: 'props.check', op: 'eq', value: check.name }, { field: 'props.state', op: 'eq', value: 'down' }];
    navigate(pageHref(project.id, 'triggers', {}, { new: '1', scope: 'events', pf: JSON.stringify(filters) }));
  };
  const runNow = async () => {
    if (!check) return;
    try {
      const r = await run.mutateAsync(check.id);
      toast({ title: r.ok ? `Responded ${r.status} in ${fmtMs(r.durationMs)}` : 'Check failed', body: r.error ?? undefined, tone: r.ok ? 'good' : 'bad' });
    } catch (e) { toast({ title: 'Could not run the check', body: (e as Error).message, tone: 'bad' }); }
  };

  return (
    <Drawer open={!!check} onClose={onClose} width={680} title={check ? <span className="flex items-center gap-2"><Dot c={check} />{check.name}</span> : ''}>
      {check && (
        <div className="space-y-5 p-5">
          <div>
            <a href={check.url} target="_blank" rel="noreferrer noopener" className="break-all font-mono text-[12.5px] text-accent hover:underline">{check.url}</a>
            <p className="mt-1 text-[12.5px] text-muted">
              {stateText(check)}. {check.method} every {INTERVALS.find((i) => i.s === check.intervalSeconds)?.label ?? `${check.intervalSeconds}s`}, expects {check.expect}
              {check.keyword ? <> and <Mono>{check.keyword}</Mono> in the body</> : ''}.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" disabled={run.isPending} onClick={runNow}><Play size={13} />{run.isPending ? 'Running' : 'Run now'}</Button>
            <Button size="sm" onClick={notify}><BellRing size={13} />Notify me</Button>
            <Button size="sm" onClick={() => onEdit(check)}><Pencil size={13} />Edit</Button>
            <AddToDashboard tile={() => ({ viz: 'number', measures: [{ source: 'checks', agg: 'rate', field: 'ok', filters: [{ field: 'checkId', op: 'eq', value: check.id }], label: `${check.name} uptime`, unit: 'percent', better: 'up' }] })} />
            {confirm
              ? <Button variant="danger" size="sm" disabled={del.isPending} onClick={async () => { await del.mutateAsync(check.id); onClose(); }}>Confirm delete</Button>
              : <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}><Trash2 size={13} />Delete</Button>}
            <span className="ml-auto self-center"><Switch checked={check.enabled} onChange={(b) => void save.mutateAsync({ id: check.id, input: { enabled: b } })} label="Enabled" /></span>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[['Uptime', pct(results.data?.uptime ?? null)], ['Median response', fmtMs(results.data?.p50)], ['95th percentile', fmtMs(results.data?.p95)]].map(([l, v]) => (
              <div key={l} className="rounded-lg border border-line p-3"><div className="text-[11.5px] text-muted">{l} in {range.label.toLowerCase()}</div><div className="tnum mt-1 text-[20px] font-semibold">{v}</div></div>
            ))}
          </div>

          <div>
            <h4 className="mb-2 text-[13px] font-semibold">Response time</h4>
            {results.isPending ? <Skeleton className="h-[220px]" /> : chart ? <TimeChart times={chart.times} series={chart.series} mode="line" height={220} format={fmtMs} /> : <p className="text-[12.5px] text-faint">No results in this time range yet.</p>}
          </div>

          <div>
            <h4 className="mb-2 text-[13px] font-semibold">Incidents</h4>
            {!results.data?.incidents.length ? <p className="text-[12.5px] text-faint">No incidents in this time range.</p> : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {results.data.incidents.map((i) => (
                  <li key={i.from} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2 text-[12.5px]">
                    <span>{fmtDateTime(i.from)} to {i.to ? fmtDateTime(i.to) : 'now'}{!i.to && <span className="text-bad"> (still down)</span>}</span>
                    <span className="text-muted">{i.error ?? 'failed'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {check.lastCheckedAt && <p className="text-[11.5px] text-faint">Last checked {relTime(check.lastCheckedAt)}. {REGION_NOTE(REGION)}</p>}
        </div>
      )}
    </Drawer>
  );
}

export function UptimePage() {
  const { project } = useProject();
  const { range } = useTime();
  const checks = useUptime(project.id, range);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; c: UptimeCheck | null }>({ open: false, c: null });
  const open = checks.data?.find((c) => c.id === openId) ?? null;

  if (checks.isError) return <ErrorState error={checks.error} retry={() => checks.refetch()} />;
  const add = <Button variant="primary" className="shrink-0" onClick={() => setDialog({ open: true, c: null })}><Plus size={15} />Add check</Button>;
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p className="text-[13px] text-muted">WGO fetches your URLs on a schedule and tells you when one stops answering. A check is down after two failures in a row. {REGION_NOTE(REGION)}</p>
        {add}
      </div>
      <Card className="overflow-hidden">
        {checks.isPending ? <div className="space-y-3 p-4">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>
          : checks.data.length === 0 ? (
            <EmptyState icon={<Activity size={22} />} title="No uptime checks yet" action={<Button variant="primary" onClick={() => setDialog({ open: true, c: null })}><Plus size={15} />Add a check</Button>}>
              Add your site or API health endpoint. When it stops responding, a trigger can post to Slack or call a webhook.
            </EmptyState>)
          : checks.data.map((c) => (
            <button key={c.id} onClick={() => setOpenId(c.id)} className="block w-full cursor-pointer border-b border-line px-4 py-3.5 text-left transition-colors last:border-b-0 hover:bg-[var(--hl)]">
              <div className="flex items-center gap-3">
                <Dot c={c} />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{c.name}<span className="ml-2 font-mono text-[11.5px] font-normal text-faint">{c.url}</span></span>
                <span className="hidden text-[12.5px] text-muted sm:block">{stateText(c)}</span>
                <span className="tnum w-16 text-right text-[12.5px] text-muted">{fmtMs(c.lastDurationMs)}</span>
              </div>
              <div className="mt-2.5"><Strip values={c.strip} range={range} /></div>
              {c.state === 'down' && c.lastError && <p className="mt-1.5 text-[11.5px] text-bad">{c.lastError}</p>}
            </button>
          ))}
      </Card>
      <CheckDrawer check={open} range={range} onClose={() => setOpenId(null)} onEdit={(c) => setDialog({ open: true, c })} />
      <CheckDialog open={dialog.open} initial={dialog.c} onClose={() => setDialog({ open: false, c: null })} />
    </div>
  );
}
