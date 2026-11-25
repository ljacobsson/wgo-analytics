import { useEffect, useState } from 'react';
import { PauseCircle, Pencil, Plus, Trash2, Wallet } from 'lucide-react';
import type { Budget, BudgetDestination, BudgetInput } from '../api/contract';
import { useBudgets, useDeleteBudget, useIntegrations, useResumeBudget, useSaveBudget } from '../api/hooks';
import { cn, relTime } from '../lib/format';
import { pageHref } from '../lib/router';
import { useProject } from '../lib/project';
import { Button, Card, CardHeader, Dialog, EmptyState, Field, Skeleton, useToast } from '../ui/kit';

const money = (n: number | null | undefined) => (n == null ? '–' : `$${n.toFixed(2)}`);

/** Plain statement that the numbers are estimates and the AWS bill is the user's. Shown on the Costs page. */
export function CostDisclaimer() {
  return (
    <div className="rounded-xl border border-line bg-[var(--hl)] px-4 py-3 text-[12.5px] leading-relaxed text-muted">
      <p><span className="font-medium text-fg">You're responsible for your AWS bill.</span> WGO runs in your own AWS account, and the figures, budgets and
        caps on this page are estimates provided as they are, without any warranty. The authors of WGO accept no responsibility or liability for any
        AWS charges, whatever this page shows or does.</p>
      <p className="mt-1.5">Costs come from AWS Cost Explorer, which can be a day behind. A project's cost is estimated from its share of this month's
        events and OpenTelemetry items, weighted by what taking each in cost. Stopping collection limits what WGO stores, but requests still reach AWS and stored data still costs. For alerts on your whole AWS account
        that don't depend on WGO, also set up <a className="text-accent hover:underline" href="https://console.aws.amazon.com/billing/home#/budgets" target="_blank" rel="noreferrer">AWS Budgets</a>.</p>
    </div>
  );
}

function Destination({ value, onChange }: { value: BudgetDestination | null; onChange: (d: BudgetDestination | null) => void }) {
  const { projects } = useProject();
  const owned = projects.filter((p) => p.role === 'owner');
  const [kind, setKind] = useState<'none' | 'slack' | 'webhook'>(value?.type ?? 'none');
  const [pid, setPid] = useState(value?.type === 'slack' ? value.projectId : owned[0]?.id ?? '');
  const [url, setUrl] = useState(value?.type === 'webhook' ? value.url : '');
  const integrations = useIntegrations(pid);
  const [integrationId, setIntegrationId] = useState(value?.type === 'slack' ? value.integrationId : '');
  useEffect(() => { if (kind === 'slack' && !integrationId && integrations.data?.[0]) setIntegrationId(integrations.data[0].id); }, [integrations.data, kind, integrationId]);
  useEffect(() => {
    onChange(kind === 'webhook' && url.trim() ? { type: 'webhook', url: url.trim() } : kind === 'slack' && pid && integrationId ? { type: 'slack', projectId: pid, integrationId } : null);
  }, [kind, url, pid, integrationId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-2">
      <select className="field" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
        <option value="none">Only show it here</option><option value="slack">A Slack channel</option><option value="webhook">A webhook</option>
      </select>
      {kind === 'slack' && (
        <div className="grid grid-cols-2 gap-2">
          <select className="field" value={pid} onChange={(e) => { setPid(e.target.value); setIntegrationId(''); }}>{owned.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          {integrations.data?.length
            ? <select className="field" value={integrationId} onChange={(e) => setIntegrationId(e.target.value)}>{integrations.data.map((i) => <option key={i.id} value={i.id}>{i.channel}</option>)}</select>
            : <p className="self-center text-[12px] text-faint">No Slack channel in this project yet. Connect one on its Triggers page.</p>}
        </div>
      )}
      {kind === 'webhook' && <input className="field font-mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/wgo" />}
    </div>
  );
}

function BudgetDialog({ open, initial, onClose }: { open: boolean; initial: Budget | null; onClose: () => void }) {
  const { projects, project } = useProject();
  const owned = projects.filter((p) => p.role === 'owner');
  const save = useSaveBudget();
  const toast = useToast();
  const [scope, setScope] = useState<string>('install'); // 'install' or a project id
  const [limit, setLimit] = useState('20');
  const [alertAt, setAlertAt] = useState('50, 80, 100');
  const [forecast, setForecast] = useState(true);
  const [pause, setPause] = useState(false);
  const [dest, setDest] = useState<BudgetDestination | null>(null);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setScope(initial ? (initial.scope === 'install' ? 'install' : initial.projectId!) : owned.some((p) => p.id === project.id) ? 'install' : 'install');
    setLimit(String(initial?.monthlyLimit ?? 20));
    setAlertAt((initial?.alertAt ?? [50, 80, 100]).join(', '));
    setForecast(initial?.alertOnForecast ?? true);
    setPause(initial?.pauseAtLimit ?? false);
    setDest(initial?.destination ?? null);
    setAck(!!initial);
    setError('');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const percents = alertAt.split(/[\s,]+/).filter(Boolean).map(Number);
  const valid = Number(limit) > 0 && percents.every((n) => Number.isInteger(n) && n > 0) && ack;
  const submit = async () => {
    setError('');
    const input: Partial<BudgetInput> = {
      ...(initial ? {} : { scope: scope === 'install' ? 'install' : 'project', projectId: scope === 'install' ? null : scope, acknowledged: ack }),
      monthlyLimit: Number(limit), alertAt: percents, alertOnForecast: forecast, pauseAtLimit: pause, destination: dest,
    };
    try {
      await save.mutateAsync({ id: initial?.id, input });
      toast({ title: initial ? 'Budget saved' : 'Budget created', tone: 'good' });
      onClose();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <Dialog open={open} onClose={onClose} width={580} title={initial ? 'Edit budget' : 'New budget'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid || save.isPending} onClick={() => void submit()}>{initial ? 'Save' : 'Create budget'}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Applies to">
            <select className="field" value={scope} disabled={!!initial} onChange={(e) => setScope(e.target.value)}>
              <option value="install">The whole WGO install</option>
              {owned.map((p) => <option key={p.id} value={p.id}>Project: {p.name}</option>)}
            </select>
          </Field>
          <Field label="Monthly limit (USD)"><input className="field tnum" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>
        </div>
        <Field label="Alert at (% of the limit)" hint="Each alerts once a month, e.g. 50, 80, 100">
          <input className="field tnum" value={alertAt} onChange={(e) => setAlertAt(e.target.value)} />
        </Field>
        <label className="flex items-start gap-2.5 text-[13px]"><input type="checkbox" className="mt-0.5" checked={forecast} onChange={(e) => setForecast(e.target.checked)} />
          <span>Alert when the month's forecast passes the limit<span className="block text-[12px] text-muted">A straight-line projection of this month's spend so far.</span></span></label>
        <label className="flex items-start gap-2.5 text-[13px]"><input type="checkbox" className="mt-0.5" checked={pause} onChange={(e) => setPause(e.target.checked)} />
          <span>Stop collecting data when the limit is reached
            <span className="block text-[12px] text-muted">WGO stops storing events, recordings, traces, logs and metrics for {scope === 'install' ? 'every project' : 'this project'} until next month, or until you raise the limit or resume. Data sent meanwhile is lost. Checked every 15 minutes, on Cost Explorer numbers that can be a day behind, so spend can go past the limit.</span></span></label>
        <Field label="Notify"><Destination key={String(open)} value={dest} onChange={setDest} /></Field>
        {!initial && (
          <label className="flex items-start gap-2.5 rounded-lg border border-line p-3 text-[12.5px]"><input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>I understand that these figures are estimates, that this budget may not prevent charges, and that I'm responsible for my AWS bill. The authors of WGO accept no liability for it.</span></label>
        )}
        {error && <p className="rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{error}</p>}
      </div>
    </Dialog>
  );
}

function BudgetRow({ b, onEdit }: { b: Budget; onEdit: () => void }) {
  const del = useDeleteBudget();
  const resume = useResumeBudget();
  const s = b.status;
  const pct = s.spent == null ? null : Math.min(100, (s.spent / b.monthlyLimit) * 100);
  const tone = s.paused || (pct ?? 0) >= 100 ? 'var(--bad)' : (pct ?? 0) >= 80 ? 'var(--warn)' : 'var(--good)';
  return (
    <div className="space-y-2 border-b border-line/60 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[13.5px] font-semibold">{b.scope === 'install' ? 'Whole install' : `Project: ${b.projectName ?? 'deleted'}`}</span>
        <span className="text-[12.5px] text-muted">{money(b.monthlyLimit)} a month{b.pauseAtLimit && ', stops collecting at the limit'}</span>
        <span className="ml-auto flex items-center gap-1">
          <button onClick={onEdit} className="rounded-md p-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="Edit"><Pencil size={14} /></button>
          <button onClick={() => { if (confirm('Delete this budget?')) del.mutate(b.id); }} className="rounded-md p-1.5 text-muted hover:bg-bad/15 hover:text-bad cursor-pointer" title="Delete"><Trash2 size={14} /></button>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--hl)]"><div className="h-full rounded-full transition-all" style={{ width: `${pct ?? 0}%`, background: tone }} /></div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
        <span className="tnum">{s.spent == null ? 'No spend data yet' : <>{money(s.spent)} spent this month{s.estimated && ' (estimated)'}</>}</span>
        {s.forecast != null && <span className="tnum">forecast {money(s.forecast)}</span>}
        {s.alerted.length > 0 && <span>alerted at {s.alerted.join(', ')}%</span>}
        {s.checkedAt && <span className="text-faint">checked {relTime(s.checkedAt)}{s.lastStatus && ` · last alert: ${s.lastStatus}`}</span>}
      </div>
      {s.paused && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">
          <PauseCircle size={15} /><span className="flex-1">Collection stopped {s.pausedAt && relTime(s.pausedAt)}. New data for {b.scope === 'install' ? 'every project' : 'this project'} is dropped until next month.</span>
          <Button size="sm" disabled={resume.isPending} onClick={() => { if (confirm('Collect data again for the rest of the month, even past the limit?')) resume.mutate(b.id); }}>Resume collecting</Button>
        </div>
      )}
      {s.resumed && !s.paused && <p className="text-[12px] text-faint">Resumed by hand this month: it won't stop collecting again until next month.</p>}
    </div>
  );
}

export function BudgetsCard() {
  const budgets = useBudgets();
  const [dialog, setDialog] = useState<{ open: boolean; b: Budget | null }>({ open: false, b: null });
  return (
    <Card>
      <CardHeader title="Budgets" sub="Alerts, and optionally a stop on collection, when a month's spend reaches a limit"
        right={<Button size="sm" onClick={() => setDialog({ open: true, b: null })}><Plus size={13} />Budget</Button>} />
      {budgets.isPending ? <div className="space-y-2 p-4"><Skeleton className="h-16" /></div>
        : !budgets.data?.length ? <EmptyState icon={<Wallet size={22} />} title="No budgets yet">Set a monthly limit for the whole install or for one project, and get alerted as it fills up.</EmptyState>
        : <div className="border-t border-line/60">{budgets.data.map((b) => <BudgetRow key={b.id} b={b} onEdit={() => setDialog({ open: true, b })} />)}</div>}
      <BudgetDialog open={dialog.open} initial={dialog.b} onClose={() => setDialog({ open: false, b: null })} />
    </Card>
  );
}

/** Shown on every page of a project whose data collection a budget stopped. */
export function CollectionPausedBanner({ pid, paused }: { pid: string; paused: boolean }) {
  if (!paused) return null;
  return (
    <div className={cn('mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-bad/30 bg-bad/10 px-4 py-2.5 text-[13px]')}>
      <PauseCircle size={16} className="text-bad" />
      <span className="flex-1">A cost budget stopped data collection for this project. New events, recordings, traces, logs and metrics aren't stored.</span>
      <a className="text-accent hover:underline" href={'#' + pageHref(pid, 'costs', new URLSearchParams())}>See budgets</a>
    </div>
  );
}
