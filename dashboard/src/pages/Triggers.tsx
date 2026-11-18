import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BellRing, Check, Copy, Hash, Pencil, Plus, Send, Slack, Trash2, Webhook } from 'lucide-react';
import type { Filter, FilterScope, Trigger, TriggerDestination, TriggerInput } from '../api/contract';
import { startSlackInstall, useDeleteIntegration, useDeleteTrigger, useIntegrations, useSaveTrigger, useSlackSetup, useTestTrigger, useTriggers } from '../api/hooks';
import { SlackConnect } from './SlackConnect';
import { cn, relTime } from '../lib/format';
import { describeFilter, FILTER_PARAM, SCOPE_LABEL } from '../lib/filters';
import { suggestName } from '../lib/naming';
import { useProject } from '../lib/project';
import { useRoute, useSetParams } from '../lib/router';
import { FilterChips } from '../ui/FilterBar';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, Mono, Skeleton, Switch, useToast } from '../ui/kit';

const COOLDOWNS = [
  { s: 0, label: 'Every match' }, { s: 60, label: '1 minute' }, { s: 300, label: '5 minutes' },
  { s: 900, label: '15 minutes' }, { s: 3600, label: '1 hour' }, { s: 86400, label: '1 day' },
];
const cooldownLabel = (s: number) => COOLDOWNS.find((c) => c.s === s)?.label ?? `${s}s`;

function decodeFilters(raw: string | null): Filter[] {
  try {
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function StatusPill({ status }: { status: string | null }) {
  if (!status) return <span className="text-faint">never fired</span>;
  const ok = /(^|: )2\d\d$/.test(status);
  return <span className={cn('rounded-md px-1.5 font-mono text-[11px]', ok ? 'bg-good/15 text-good' : 'bg-bad/15 text-bad')} title={status}>{status.length > 28 ? status.slice(0, 27) + '…' : status}</span>;
}

interface Prefill { scope: FilterScope; filters: Filter[] }
const NO_PREFILL: Prefill = { scope: 'events', filters: [] };
const SCOPES: FilterScope[] = ['events', 'logs', 'spans'];
const SCOPE_HINT: Record<FilterScope, string> = {
  events: 'e.g. Event type equals error.', logs: 'e.g. Severity number ≥ 17 and Service equals checkout.', spans: 'e.g. Status code equals 2 (error) or Duration (ms) ≥ 2000.',
};
const SCOPE_ROWS: Record<FilterScope, string> = { events: 'event', logs: 'log record', spans: 'span' };

function TriggerDialog({ open, initial, prefill, onClose }: { open: boolean; initial: Trigger | null; prefill: Prefill; onClose: () => void }) {
  const { project } = useProject();
  const integrations = useIntegrations(project.id);
  const save = useSaveTrigger(project.id);
  const toast = useToast();
  const slackReady = !!useSlackSetup(project.id).data?.configured;
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [scope, setScope] = useState<FilterScope>('events');
  const [filters, setFilters] = useState<Filter[]>([]);
  const [kind, setKind] = useState<'slack' | 'webhook'>('slack');
  const [integrationId, setIntegrationId] = useState('');
  const [url, setUrl] = useState('');
  const [cooldown, setCooldown] = useState(300);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setName(initial?.name ?? (prefill.filters.length ? suggestName(prefill.scope, prefill.filters) : ''));
    setNameTouched(!!initial);
    setScope(initial?.scope ?? prefill.scope);
    setFilters(initial?.filters ?? prefill.filters);
    const d = initial?.destination;
    setKind(d?.type ?? 'slack');
    setIntegrationId(d?.type === 'slack' ? d.integrationId : integrations.data?.[0]?.id ?? '');
    setUrl(d?.type === 'webhook' ? d.url : '');
    setCooldown(initial?.cooldownSeconds ?? 300);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!integrationId && integrations.data?.[0]) setIntegrationId(integrations.data[0].id); }, [integrations.data, integrationId]);
  // the name follows the conditions until you type one yourself
  useEffect(() => { if (open && !nameTouched) setName(filters.length ? suggestName(scope, filters) : ''); }, [filters, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const changeScope = (s: FilterScope) => { if (s !== scope) { setScope(s); setFilters([]); } };

  const destination: TriggerDestination | null =
    kind === 'slack' ? (integrationId ? { type: 'slack', integrationId } : null) : url.trim() ? { type: 'webhook', url: url.trim() } : null;
  const valid = name.trim() && filters.length && destination;
  const submit = async () => {
    if (!valid) return;
    setError('');
    const input: TriggerInput = { name: name.trim(), ...(initial ? {} : { scope }), filters, destination: destination!, cooldownSeconds: cooldown, enabled: initial?.enabled ?? true };
    try {
      await save.mutateAsync({ id: initial?.id, input });
      toast({ title: initial ? 'Trigger updated' : 'Trigger created', body: name.trim(), tone: 'good' });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} width={600} title={initial ? 'Edit trigger' : 'New trigger'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid || save.isPending} onClick={submit}>{initial ? 'Save' : 'Create trigger'}</Button></>}>
      <div className="space-y-4">
        <Field label="Name"><input autoFocus className="field" value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} placeholder="Checkout API failing" /></Field>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-muted">Watch</div>
          <div className="inline-flex rounded-lg border border-line bg-[var(--hl)] p-0.5" title={initial ? 'A trigger’s scope can’t be changed' : undefined}>
            {SCOPES.map((s) => (
              <button key={s} disabled={!!initial && s !== scope} onClick={() => changeScope(s)}
                className={cn('rounded-md px-3 py-1 text-[12.5px] font-medium', scope === s ? 'bg-[var(--raised)] text-fg shadow-sm' : 'text-muted enabled:hover:text-fg enabled:cursor-pointer disabled:opacity-40')}>
                {SCOPE_LABEL[s]}
              </button>))}
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-muted">When a new {SCOPE_ROWS[scope]} matches all of</div>
          <div className="rounded-lg border border-line p-2.5">
            <FilterChips key={scope} scope={scope} value={filters} onChange={setFilters} />
            {!filters.length && <p className="mt-1.5 text-[11.5px] text-faint">Add at least one condition, {SCOPE_HINT[scope]}</p>}
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-muted">Notify</div>
          <div className="mb-2.5 inline-flex rounded-lg border border-line bg-[var(--hl)] p-0.5">
            {(['slack', 'webhook'] as const).map((k) => (
              <button key={k} onClick={() => setKind(k)} className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[12.5px] font-medium cursor-pointer', kind === k ? 'bg-[var(--raised)] text-fg shadow-sm' : 'text-muted hover:text-fg')}>
                {k === 'slack' ? <><Slack size={13} />Slack</> : <><Webhook size={13} />Webhook</>}
              </button>))}
          </div>
          {kind === 'slack' ? (
            integrations.data?.length ? (
              <div className="flex items-center gap-2">
                <select className="field" value={integrationId} onChange={(e) => setIntegrationId(e.target.value)}>
                  {integrations.data.map((i) => <option key={i.id} value={i.id}>{i.channel}{i.teamName ? ` · ${i.teamName}` : ''}</option>)}
                </select>
                {slackReady && <Button size="sm" onClick={() => void startSlackInstall(project.id)} title="Connect another channel"><Plus size={13} />Channel</Button>}
              </div>
            ) : slackReady ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-line p-3">
                <span className="text-[12.5px] text-muted">Slack asks which workspace and channel, then brings you back here.</span>
                <SlackConnect compact />
              </div>
            ) : (
              <SlackConnect compact />
            )
          ) : (
            <Field label="HTTPS URL" hint="JSON POST, signed with X-WGO-Signature; hooks.slack.com URLs get a Slack message">
              <input className="field font-mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/wgo" />
            </Field>
          )}
        </div>
        <Field label="At most once per" hint="Matches in between are counted and reported with the next notification">
          <select className="field" value={cooldown} onChange={(e) => setCooldown(Number(e.target.value))}>
            {COOLDOWNS.map((c) => <option key={c.s} value={c.s}>{c.label}</option>)}
          </select>
        </Field>
        {error && <p className="rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{error}</p>}
      </div>
    </Dialog>
  );
}

function TriggerRow({ t, onEdit }: { t: Trigger; onEdit: () => void }) {
  const { project } = useProject();
  const integrations = useIntegrations(project.id);
  const save = useSaveTrigger(project.id);
  const del = useDeleteTrigger(project.id);
  const test = useTestTrigger(project.id);
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const dest = t.destination.type === 'slack'
    ? <span className="inline-flex items-center gap-1"><Slack size={12} />{integrations.data?.find((i) => i.id === (t.destination as { integrationId: string }).integrationId)?.channel ?? 'Slack'}</span>
    : <span className="inline-flex items-center gap-1 font-mono text-[11.5px]"><Webhook size={12} />{(() => { try { return new URL(t.destination.url).host; } catch { return t.destination.url; } })()}</span>;
  const runTest = async () => {
    const r = await test.mutateAsync(t.id);
    toast({ title: r.ok ? 'Test notification sent' : 'Test notification failed', body: r.status, tone: r.ok ? 'good' : 'bad' });
  };
  return (
    <div className={cn('group grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-4 border-b border-line/60 px-4 py-3.5', !t.enabled && 'opacity-60')}>
      <div className="pt-0.5"><Switch checked={t.enabled} onChange={(b) => save.mutate({ id: t.id, input: { enabled: b } })} /></div>
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[13.5px] font-semibold">{t.name}</span>
          {t.scope !== 'events' && <Badge tone="accent">{SCOPE_LABEL[t.scope]}</Badge>}
          <span className="text-[12px] text-muted">{dest}</span>
          <span className="text-[11.5px] text-faint">at most every {cooldownLabel(t.cooldownSeconds).toLowerCase().replace('every match', 'match')}</span>
        </div>
        <div className="flex flex-wrap gap-1">{t.filters.map((f, i) => <Badge key={i}><span className="max-w-[340px] truncate">{describeFilter(f)}</span></Badge>)}</div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-faint">
          <span>{t.fireCount ? `fired ${t.fireCount}× · last ${relTime(t.lastFiredAt!)}` : 'not fired yet'}</span>
          <StatusPill status={t.lastStatus} />
          {t.destination.type === 'webhook' && (
            <button onClick={() => { void navigator.clipboard.writeText(t.signingSecret); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="inline-flex items-center gap-1 hover:text-fg cursor-pointer" title="Verify X-WGO-Signature (HMAC-SHA256 of the body) with this secret">
              {copied ? <Check size={11} /> : <Copy size={11} />}signing secret
            </button>)}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button size="sm" onClick={() => void runTest()} disabled={test.isPending} title="Send a sample notification now"><Send size={13} />Test</Button>
        <button onClick={onEdit} className="rounded-md p-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="Edit"><Pencil size={14} /></button>
        <button onClick={() => { if (confirm(`Delete trigger “${t.name}”?`)) del.mutate(t.id); }} className="rounded-md p-1.5 text-muted hover:bg-bad/15 hover:text-bad cursor-pointer" title="Delete"><Trash2 size={14} /></button>
      </div>
    </div>
  );
}

function SlackChannels() {
  const { project } = useProject();
  const integrations = useIntegrations(project.id);
  const del = useDeleteIntegration(project.id);
  const toast = useToast();
  const setup = useSlackSetup(project.id);
  const ready = !!setup.data?.configured;
  return (
    <Card>
      <CardHeader title="Slack channels" sub="Connected with “Add to Slack”, usable by every trigger in this project"
        right={ready && <SlackConnect compact />} />
      <div className="px-4 pb-3">
        {integrations.isPending ? <Skeleton className="h-8" />
          : integrations.data?.length ? integrations.data.map((i) => (
            <div key={i.id} className="group flex items-center gap-2 border-t border-line/60 py-2 text-[12.5px] first:border-t-0">
              <Hash size={13} className="text-faint" /><span className="font-medium">{i.channel.replace(/^#/, '')}</span>
              {i.teamName && <span className="text-faint">· {i.teamName}</span>}
              <span className="ml-auto text-[11.5px] text-faint">added by {i.createdBy} {relTime(i.createdAt)}</span>
              <button onClick={async () => { try { await del.mutateAsync(i.id); } catch (e) { toast({ title: 'Cannot remove channel', body: (e as Error).message, tone: 'bad' }); } }}
                className="rounded-md p-1 text-faint opacity-0 hover:bg-bad/15 hover:text-bad group-hover:opacity-100 cursor-pointer" title="Disconnect"><Trash2 size={13} /></button>
            </div>))
          : ready ? <p className="text-[12.5px] text-faint">No channels yet. Click Add to Slack to connect one.</p> : <SlackConnect />}
      </div>
    </Card>
  );
}

export function TriggersPage() {
  const { project } = useProject();
  const route = useRoute(); const set = useSetParams();
  const toast = useToast();
  const qc = useQueryClient();
  const triggers = useTriggers(project.id);
  const [dialog, setDialog] = useState<{ open: boolean; t: Trigger | null; prefill: Prefill }>({ open: false, t: null, prefill: NO_PREFILL });

  // "Create trigger" from a filter bar or a table row lands here with ?new=1&scope=…&pf=<filters JSON>
  // (older links: the events filters in ?f=)
  const wantsNew = route.params.get('new') === '1';
  const prefill = useMemo((): Prefill => {
    const raw = route.params.get('scope');
    const scope: FilterScope = raw === 'logs' || raw === 'spans' ? raw : 'events';
    return { scope, filters: decodeFilters(route.params.get('pf') ?? route.params.get(FILTER_PARAM.events)) };
  }, [route.params]);
  useEffect(() => {
    if (!wantsNew) return;
    setDialog({ open: true, t: null, prefill });
    set({ new: null, pf: null, scope: null });
  }, [wantsNew]); // eslint-disable-line react-hooks/exhaustive-deps

  // back from Slack's consent screen
  const slack = route.params.get('slack');
  useEffect(() => {
    if (!slack) return;
    void qc.invalidateQueries({ queryKey: ['integrations', project.id] });
    if (slack === 'connected') toast({ title: 'Slack channel connected', body: 'Pick it as the destination of any trigger.', tone: 'good' });
    else if (slack === 'cancelled') toast({ title: 'Slack connection cancelled', tone: 'accent' });
    else toast({ title: 'Could not connect Slack', body: 'Please try again.', tone: 'bad' });
    set({ slack: null });
  }, [slack]); // eslint-disable-line react-hooks/exhaustive-deps

  if (triggers.isError) return <ErrorState error={triggers.error} retry={() => triggers.refetch()} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p className="text-[13px] text-muted">Get a Slack message or webhook call when new events, logs or spans match your filters: errors on checkout, a click on your pricing CTA, an ERROR log from the payment service.</p>
        <Button variant="primary" className="shrink-0" onClick={() => setDialog({ open: true, t: null, prefill: NO_PREFILL })}><Plus size={15} />New trigger</Button>
      </div>
      <Card className="overflow-hidden">
        {triggers.isPending ? <div className="space-y-3 p-4">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
          : triggers.data.length === 0 ? (
            <EmptyState icon={<BellRing size={22} />} title="No triggers yet"
              action={<Button variant="primary" onClick={() => setDialog({ open: true, t: null, prefill: NO_PREFILL })}><Plus size={15} />Create a trigger</Button>}>
              Tip: set filters on any page and click <b>Create trigger</b>, or hover a row in Logs, Events or any table and click its bell.
            </EmptyState>)
          : triggers.data.map((t) => <TriggerRow key={t.id} t={t} onEdit={() => setDialog({ open: true, t, prefill: NO_PREFILL })} />)}
      </Card>
      <SlackChannels />
      <p className="text-[11.5px] text-faint">
        Webhooks receive a JSON POST (<Mono>trigger</Mono>, <Mono>project</Mono>, <Mono>scope</Mono>, <Mono>matches</Mono>, <Mono>events</Mono> / <Mono>logs</Mono> / <Mono>spans</Mono>, <Mono>url</Mono>) with an
        <Mono> X-WGO-Signature: sha256=…</Mono> header: the HMAC-SHA256 of the raw body keyed with the trigger's signing secret.
      </p>
      <TriggerDialog open={dialog.open} initial={dialog.t} prefill={dialog.prefill} onClose={() => setDialog({ open: false, t: null, prefill: NO_PREFILL })} />
    </div>
  );
}
