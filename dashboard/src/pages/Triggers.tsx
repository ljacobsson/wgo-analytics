import { useEffect, useMemo, useState } from 'react';
import { SlackAppCard } from './InstallAdmin';
import { useQueryClient } from '@tanstack/react-query';
import { BellRing, Check, Copy, Hash, MessageSquareText, Pencil, Plus, Send, Slack, Trash2, Webhook } from 'lucide-react';
import { SLACK_BOT_SCOPES } from '../api/contract';
import type { Destination, DestinationLevel, Filter, FilterScope, SlackTemplate, Trigger, TriggerAgg, TriggerCondition, TriggerDestination, TriggerInput, TriggerKind, TriggerMetric } from '../api/contract';
import { useDeleteDestination, useDeleteTrigger, useDestinations, useDisconnectSlackWorkspace, useSaveDestination, useSaveTrigger, useSlackSetup, useTestDestination, useTestTrigger, useTriggerPreview, useTriggers } from '../api/hooks';
import { SlackChannelDialog } from './SlackConnect';
import { SlackMessageEditor } from './SlackMessageEditor';
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

/** A destination as a <select> value: "url" (a one-off webhook URL), "slack:<id>" or "saved:<id>". */
const keyOf = (d: TriggerDestination) => (d.type === 'webhook' ? 'url' : d.type === 'slack' ? `slack:${d.integrationId}` : `saved:${d.destinationId}`);
const destinationOf = (key: string, url: string): TriggerDestination | null =>
  key === 'url' ? (url.trim() ? { type: 'webhook', url: url.trim() } : null)
    : key.startsWith('slack:') ? { type: 'slack', integrationId: key.slice(6) }
    : { type: 'saved', destinationId: key.slice(6) };
/** Whether a destination gets a Slack message: a Slack channel, or a webhook URL on hooks.slack.com. */
function isSlackUrl(url: string): boolean {
  try { return new URL(url.trim()).hostname === 'hooks.slack.com'; } catch { return false; }
}
const optionLabel = (d: Pick<Destination, 'type' | 'name' | 'detail'>) => `${d.type === 'slack' ? 'Slack ' : ''}${d.name}${d.detail ? ` · ${d.detail}` : ''}`;

interface Prefill { scope: FilterScope; filters: Filter[]; name?: string }
const NO_PREFILL: Prefill = { scope: 'events', filters: [] };
const SCOPES: FilterScope[] = ['events', 'logs', 'spans'];
const SCOPE_HINT: Record<FilterScope, string> = {
  events: 'e.g. Event type equals error.', logs: 'e.g. Severity number ≥ 17 and Service equals checkout.', spans: 'e.g. Status code equals 2 (error) or Duration (ms) ≥ 2000.',
};
const SCOPE_ROWS: Record<FilterScope, string> = { events: 'event', logs: 'log record', spans: 'span' };

const WINDOWS = [{ m: 5, label: '5 minutes' }, { m: 15, label: '15 minutes' }, { m: 30, label: '30 minutes' }, { m: 60, label: '1 hour' }, { m: 360, label: '6 hours' }, { m: 1440, label: '24 hours' }];
const windowLabel = (m: number | null) => WINDOWS.find((w) => w.m === m)?.label ?? `${m} minutes`;
/** Numeric fields that can be averaged or taken a percentile of, per scope. */
const NUMERIC: Record<FilterScope, Array<{ field: string; label: string }>> = {
  events: [{ field: 'durationMs', label: 'Request duration (failed requests)' }, { field: 'props.lcp', label: 'LCP (Web Vitals)' }, { field: 'props.inp', label: 'INP (Web Vitals)' }, { field: 'props.cls', label: 'CLS (Web Vitals)' }, { field: 'props.ttfb', label: 'TTFB (Web Vitals)' }],
  logs: [{ field: 'severityNumber', label: 'Severity number' }],
  spans: [{ field: 'durationMs', label: 'Duration (ms)' }],
};
const AGG_LABEL: Record<TriggerAgg, (rows: string) => string> = {
  count: (r) => `Number of matching ${r}s`, sessions: () => 'Sessions with a match', session_rate: () => 'Share of sessions with a match',
  avg: () => 'Average of a field', p75: () => 'p75 of a field', p95: () => 'p95 of a field',
};
const SENSITIVITY = [{ v: 'low', label: 'Only big surprises' }, { v: 'medium', label: 'Clear changes' }, { v: 'high', label: 'Smaller changes too' }] as const;

/** Ready-made aggregate triggers. */
const PRESETS: Array<{ label: string; scope: FilterScope; kind: TriggerKind; filters: Filter[]; metric: TriggerMetric; windowMinutes: number; condition: TriggerCondition; name: string }> = [
  { label: 'Nothing received', name: 'No pageviews for 30 minutes', scope: 'events', kind: 'threshold', filters: [{ field: 'type', op: 'eq', value: 'pageview' }], metric: { agg: 'count' }, windowMinutes: 30, condition: { op: 'below', value: 1 } },
  { label: 'Error spike', name: 'Unusually many errors', scope: 'events', kind: 'anomaly', filters: [{ field: 'type', op: 'eq', value: 'error' }], metric: { agg: 'count' }, windowMinutes: 15, condition: { direction: 'up', sensitivity: 'medium' } },
  { label: 'Slow endpoint', name: 'p95 above 1 second', scope: 'spans', kind: 'threshold', filters: [{ field: 'kind', op: 'eq', value: '2' }], metric: { agg: 'p95', field: 'durationMs' }, windowMinutes: 15, condition: { op: 'above', value: 1000 } },
  { label: 'Failing sessions', name: 'More than 5% of sessions hit an error', scope: 'events', kind: 'threshold', filters: [{ field: 'type', op: 'eq', value: 'error' }], metric: { agg: 'session_rate' }, windowMinutes: 60, condition: { op: 'above', value: 0.05 } },
];

/** One line describing an aggregate trigger: "p95 of durationMs over 15 minutes is above 1000". */
export function describeAggregate(t: Pick<Trigger, 'metric' | 'condition' | 'windowMinutes' | 'scope'>): string {
  if (!t.metric || !t.condition) return '';
  const m = t.metric;
  const what = m.agg === 'count' ? `matching ${SCOPE_ROWS[t.scope]}s` : m.agg === 'sessions' ? 'sessions with a match' : m.agg === 'session_rate' ? 'share of sessions with a match' : `${m.agg} of ${m.field}`;
  const c = t.condition;
  const v = (n: number) => (m.agg === 'session_rate' ? `${+(n * 100).toFixed(2)}%` : String(n));
  const cond = 'op' in c ? `${c.op} ${v(c.value)}` : `unusually ${c.direction === 'up' ? 'high' : c.direction === 'down' ? 'low' : 'high or low'}`;
  return `Fires when the ${what} over ${windowLabel(t.windowMinutes)} is ${cond}`;
}

function TriggerDialog({ open, initial, prefill, onClose }: { open: boolean; initial: Trigger | null; prefill: Prefill; onClose: () => void }) {
  const { project } = useProject();
  const destinations = useDestinations(project.id);
  const save = useSaveTrigger(project.id);
  const toast = useToast();
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [scope, setScope] = useState<FilterScope>('events');
  const [filters, setFilters] = useState<Filter[]>([]);
  const [destKey, setDestKey] = useState('url');
  const [url, setUrl] = useState('');
  const [cooldown, setCooldown] = useState(300);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<TriggerKind>('match');
  const [agg, setAgg] = useState<TriggerAgg>('count');
  const [field, setField] = useState('');
  const [windowMinutes, setWindow] = useState(15);
  const [op, setOp] = useState<'above' | 'below'>('above');
  const [value, setValue] = useState('10');
  const [direction, setDirection] = useState<'up' | 'down' | 'either'>('up');
  const [sensitivity, setSensitivity] = useState<'low' | 'medium' | 'high'>('medium');
  const [slackTemplate, setSlackTemplate] = useState<SlackTemplate | null>(null);
  const [designing, setDesigning] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    setName(initial?.name ?? prefill.name ?? (prefill.filters.length ? suggestName(prefill.scope, prefill.filters) : ''));
    setNameTouched(!!initial || !!prefill.name);
    setScope(initial?.scope ?? prefill.scope);
    setFilters(initial?.filters ?? prefill.filters);
    const d = initial?.destination;
    const first = destinations.data?.[0];
    setDestKey(d ? keyOf(d) : first ? keyOf(first.ref) : 'url');
    setUrl(d?.type === 'webhook' ? d.url : '');
    setCooldown(initial?.cooldownSeconds ?? 300);
    setSlackTemplate(initial?.slackTemplate ?? null);
    setKind(initial?.kind ?? 'match');
    setAgg(initial?.metric?.agg ?? 'count');
    setField(initial?.metric?.field ?? '');
    setWindow(initial?.windowMinutes ?? 15);
    const c = initial?.condition;
    if (c && 'op' in c) { setOp(c.op); setValue(String(initial?.metric?.agg === 'session_rate' ? +(c.value * 100).toFixed(4) : c.value)); } else { setOp('above'); setValue('10'); }
    if (c && 'direction' in c) { setDirection(c.direction); setSensitivity(c.sensitivity); } else { setDirection('up'); setSensitivity('medium'); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // a new trigger defaults to the first saved destination once they've loaded
  useEffect(() => { if (open && !initial && destKey === 'url' && !url && destinations.data?.[0]) setDestKey(keyOf(destinations.data[0].ref)); }, [destinations.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // the name follows the conditions until you type one yourself
  useEffect(() => { if (open && !nameTouched) setName(filters.length ? suggestName(scope, filters) : ''); }, [filters, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const changeScope = (s: FilterScope) => {
    if (s === scope) return;
    setScope(s); setFilters([]);
    if (s !== 'events' && (agg === 'sessions' || agg === 'session_rate')) setAgg('count');
    if (field && !NUMERIC[s].some((f) => f.field === field)) setField('');
  };
  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setScope(p.scope); setFilters(p.filters); setKind(p.kind); setAgg(p.metric.agg); setField(p.metric.field ?? ''); setWindow(p.windowMinutes);
    const c = p.condition;
    if ('op' in c) { setOp(c.op); setValue(String(p.metric.agg === 'session_rate' ? c.value * 100 : c.value)); } else { setDirection(c.direction); setSensitivity(c.sensitivity); }
    setName(p.name); setNameTouched(true);
  };
  const needsField = agg === 'avg' || agg === 'p75' || agg === 'p95';
  const numValue = Number(value);
  const aggregate: Pick<TriggerInput, 'metric' | 'condition' | 'windowMinutes'> | null = kind === 'match' ? null : {
    metric: { agg, ...(needsField && field ? { field } : {}) },
    windowMinutes,
    condition: kind === 'threshold' ? { op, value: agg === 'session_rate' ? numValue / 100 : numValue } : { direction, sensitivity },
  };
  const aggregateValid = kind === 'match' || ((!needsField || !!field) && (kind === 'anomaly' || (value.trim() !== '' && Number.isFinite(numValue))));
  const preview = useTriggerPreview(project.id, open && kind !== 'match' && aggregateValid ? { kind, scope, filters, ...aggregate! } : null);

  const destination = destinationOf(destKey, url);
  const projectDests = destinations.data?.filter((d) => d.level === 'project') ?? [];
  const myDests = destinations.data?.filter((d) => d.level === 'account') ?? [];
  // editing a trigger that uses another member's destination: it isn't among the ones you can pick, but can be kept
  const keptKey = initial?.destination.type === 'saved' && !destinations.data?.some((d) => keyOf(d.ref) === keyOf(initial.destination)) ? keyOf(initial.destination) : null;
  const kept = keptKey ? initial?.destinationLabel ?? null : null;
  const valid = name.trim() && (filters.length || kind !== 'match') && destination && aggregateValid;
  const slackBound = (key: string) =>
    key === 'url' ? isSlackUrl(url)
      : key.startsWith('slack:') ? true
      : (destinations.data?.find((d) => keyOf(d.ref) === key)?.type ?? (key === keptKey ? kept?.type : undefined)) === 'slack';
  const toSlack = slackBound(destKey);
  // "Send test" in the designer goes through the saved trigger, so only when that already posts to Slack
  const savedToSlack = !!initial && slackBound(keyOf(initial.destination));
  const submit = async () => {
    if (!valid) return;
    setError('');
    const input: TriggerInput = { name: name.trim(), ...(initial ? {} : { scope, kind }), filters, destination: destination!, cooldownSeconds: cooldown, enabled: initial?.enabled ?? true, ...(aggregate ?? {}), slackTemplate };
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
          <div className="mb-1.5 text-[12px] font-medium text-muted">Fire</div>
          <div className="inline-flex rounded-lg border border-line bg-[var(--hl)] p-0.5" title={initial ? 'A trigger’s kind can’t be changed' : undefined}>
            {([['match', 'On each match'], ['threshold', 'When a number crosses a value'], ['anomaly', 'When a number is unusual']] as const).map(([k, label]) => (
              <button key={k} disabled={!!initial && k !== kind} onClick={() => setKind(k)}
                className={cn('rounded-md px-3 py-1 text-[12.5px] font-medium', kind === k ? 'bg-[var(--raised)] text-fg shadow-sm' : 'text-muted enabled:hover:text-fg enabled:cursor-pointer disabled:opacity-40')}>{label}</button>))}
          </div>
          {!initial && kind !== 'match' && (
            <p className="mt-2 text-[12px] text-muted">Start from: {PRESETS.map((p, i) => (
              <span key={p.label}>{i > 0 && ', '}<button className="cursor-pointer text-accent hover:underline" onClick={() => applyPreset(p)}>{p.label.toLowerCase()}</button></span>))}</p>
          )}
        </div>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-muted">{kind === 'match' ? `When a new ${SCOPE_ROWS[scope]} matches all of` : `Look at ${SCOPE_ROWS[scope]}s matching (leave empty for all)`}</div>
          <div className="rounded-lg border border-line p-2.5">
            <FilterChips key={scope} scope={scope} value={filters} onChange={setFilters} />
            {!filters.length && kind === 'match' && <p className="mt-1.5 text-[11.5px] text-faint">Add at least one condition, {SCOPE_HINT[scope]}</p>}
          </div>
        </div>
        {kind !== 'match' && (
          <div className="space-y-3 rounded-lg border border-line p-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Measure">
                <select className="field" value={agg} onChange={(e) => setAgg(e.target.value as TriggerAgg)}>
                  {(Object.keys(AGG_LABEL) as TriggerAgg[]).filter((a) => scope === 'events' || (a !== 'sessions' && a !== 'session_rate')).map((a) => <option key={a} value={a}>{AGG_LABEL[a](SCOPE_ROWS[scope])}</option>)}
                </select>
              </Field>
              <Field label="Over the last">
                <select className="field" value={windowMinutes} onChange={(e) => setWindow(Number(e.target.value))}>
                  {WINDOWS.map((w) => <option key={w.m} value={w.m}>{w.label}</option>)}
                </select>
              </Field>
            </div>
            {needsField && (
              <Field label="Field">
                <select className="field" value={field} onChange={(e) => setField(e.target.value)}>
                  <option value="">Choose a field…</option>
                  {NUMERIC[scope].map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
                </select>
              </Field>
            )}
            {kind === 'threshold' ? (
              <div className="flex items-end gap-2">
                <Field label="Is"><select className="field" value={op} onChange={(e) => setOp(e.target.value as 'above' | 'below')}><option value="above">above</option><option value="below">below</option></select></Field>
                <Field label={agg === 'session_rate' ? 'Percent' : 'Value'}><input className="field w-32 tnum" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Unusually"><select className="field" value={direction} onChange={(e) => setDirection(e.target.value as 'up')}><option value="up">high</option><option value="down">low</option><option value="either">high or low</option></select></Field>
                <Field label="Sensitivity"><select className="field" value={sensitivity} onChange={(e) => setSensitivity(e.target.value as 'medium')}>{SENSITIVITY.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}</select></Field>
              </div>
            )}
            <p className="text-[12px] text-muted">
              {preview.isFetching && !preview.data ? 'Checking the current value…'
                : preview.data ? <>Right now: <span className="font-medium text-fg tnum">{preview.data.value == null ? 'no data' : agg === 'session_rate' ? `${(preview.data.value * 100).toFixed(1)}%` : +preview.data.value.toFixed(2)}</span>
                  {preview.data.baseline && <>, usually {+preview.data.baseline.low.toFixed(1)} to {+preview.data.baseline.high.toFixed(1)}</>}
                  {' · '}{preview.data.fires ? <span className="text-bad">it would fire</span> : 'it wouldn’t fire'}{preview.data.note && <span className="mt-1 block text-faint">{preview.data.note}</span>}</>
                : preview.isError ? <span className="text-bad">{(preview.error as Error).message}</span> : null}
            </p>
            <p className="text-[11.5px] text-faint">Checked every minute{windowMinutes > 60 ? ' (every 15 minutes for windows over an hour)' : ''}. You're notified when it starts firing and when it's back to normal.{kind === 'anomaly' && ' “Usual” is the same time window on each of the last 7 days.'}</p>
          </div>
        )}
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-muted">Notify</div>
          <select className="field" value={destKey} onChange={(e) => setDestKey(e.target.value)}>
            {projectDests.length > 0 && <optgroup label="This project">{projectDests.map((d) => <option key={d.id} value={keyOf(d.ref)}>{optionLabel(d)}</option>)}</optgroup>}
            {myDests.length > 0 && <optgroup label="Yours, in all your projects">{myDests.map((d) => <option key={d.id} value={keyOf(d.ref)}>{optionLabel(d)}</option>)}</optgroup>}
            {keptKey && <option value={keptKey}>{kept ? `${optionLabel(kept)}${kept.owner ? ` (${kept.owner}’s)` : ''}` : 'A deleted destination'}</option>}
            <option value="url">One-off webhook URL…</option>
          </select>
          {destKey === 'url' ? (
            <div className="mt-2.5">
              <Field label="HTTPS URL" hint="JSON POST, signed with X-WGO-Signature using this trigger's secret; hooks.slack.com URLs get a Slack message">
                <input className="field font-mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/wgo" />
              </Field>
            </div>
          ) : destKey === keptKey && kept ? (
            <p className="mt-1.5 text-[11.5px] text-faint">{kept.owner ?? 'Another member'} saved this destination. You can keep it, or pick another.</p>
          ) : null}
          {destinations.data && !destinations.data.length && (
            <p className="mt-1.5 text-[11.5px] text-faint">Connect Slack channels and save webhooks under Destinations on this page to reuse them in any trigger.</p>
          )}
          {toSlack && (
            <div className="mt-2.5 flex items-center gap-3 rounded-lg border border-line px-3 py-2.5">
              <MessageSquareText size={16} className="shrink-0 text-faint" />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium">{slackTemplate ? 'Your own Slack message' : 'Default Slack message'}</div>
                <div className="text-[11.5px] text-faint">
                  {slackTemplate ? `${slackTemplate.blocks.length} block${slackTemplate.blocks.length === 1 ? '' : 's'}, with the trigger’s details filled in` : 'Trigger name, a summary, the latest matches and a link to WGO'}
                </div>
              </div>
              <Button size="sm" onClick={() => setDesigning(true)}><Pencil size={12} />{slackTemplate ? 'Edit message' : 'Design message'}</Button>
            </div>
          )}
        </div>
        <Field label="At most once per" hint={kind === 'match' ? 'Matches in between are counted and reported with the next notification' : 'If it keeps flapping, it notifies about firing at most this often'}>
          <select className="field" value={cooldown} onChange={(e) => setCooldown(Number(e.target.value))}>
            {COOLDOWNS.map((c) => <option key={c.s} value={c.s}>{c.label}</option>)}
          </select>
        </Field>
        {error && <p className="rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{error}</p>}
      </div>
      <SlackMessageEditor open={designing} value={slackTemplate} onClose={() => setDesigning(false)} onSave={setSlackTemplate}
        ctx={{ name, kind, scope, metric: aggregate?.metric ?? null, condition: aggregate?.condition ?? null, windowMinutes: aggregate?.windowMinutes ?? null, testTriggerId: savedToSlack ? initial!.id : undefined }} />
    </Dialog>
  );
}

/** Where a trigger sends, for its row: a Slack channel, a saved destination's name or a one-off webhook's host. */
function DestinationLabel({ t }: { t: Trigger }) {
  const { project, email } = useProject();
  const destinations = useDestinations(project.id);
  const d = t.destination;
  if (d.type === 'webhook') {
    let host = d.url;
    try { host = new URL(d.url).host; } catch { /* shown as typed */ }
    return <span className="inline-flex items-center gap-1 font-mono text-[11.5px]"><Webhook size={12} />{host}</span>;
  }
  if (d.type === 'slack') {
    return <span className="inline-flex items-center gap-1"><Slack size={12} />{destinations.data?.find((x) => x.id === d.integrationId)?.name ?? 'Slack'}</span>;
  }
  const l = t.destinationLabel;
  if (!l) return <span className="text-bad">deleted destination</span>;
  return (
    <span className="inline-flex items-center gap-1" title={l.detail ?? undefined}>
      {l.type === 'slack' ? <Slack size={12} /> : <Webhook size={12} />}{l.name}
      {l.owner && l.owner !== email && <span className="text-faint">({l.owner}’s)</span>}
    </span>
  );
}

function TriggerRow({ t, onEdit }: { t: Trigger; onEdit: () => void }) {
  const { project } = useProject();
  const save = useSaveTrigger(project.id);
  const del = useDeleteTrigger(project.id);
  const test = useTestTrigger(project.id);
  const toast = useToast();
  const [copied, setCopied] = useState(false);
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
          <span className="text-[12px] text-muted"><DestinationLabel t={t} />{t.slackTemplate && <span className="text-faint">, own message</span>}</span>
          <span className="text-[11.5px] text-faint">at most every {cooldownLabel(t.cooldownSeconds).toLowerCase().replace('every match', 'match')}</span>
        </div>
        {t.kind !== 'match' && <div className="text-[12.5px] text-muted">{describeAggregate(t)}</div>}
        {t.filters.length > 0 && <div className="text-[12px] text-muted">{t.kind !== 'match' && 'Counting rows where '}{t.filters.map(describeFilter).join(' and ')}</div>}
        {t.status && t.enabled && (
          <div className="flex items-center gap-2 text-[12px]">
            <i className={cn('h-2 w-2 rounded-full', t.status.state === 'firing' ? 'bg-bad' : t.status.state === 'ok' ? 'bg-good' : 'bg-faint')} />
            <span className={t.status.state === 'firing' ? 'font-medium text-bad' : 'text-muted'}>
              {t.status.state === 'firing' ? `Firing since ${relTime(t.status.since!)}` : t.status.state === 'ok' ? 'OK' : 'Not checked yet'}
            </span>
            {t.status.lastValue != null && <span className="tnum text-faint">last value {+t.status.lastValue.toFixed(3)}{t.status.baseline && `, usually ${+t.status.baseline.low.toFixed(1)} to ${+t.status.baseline.high.toFixed(1)}`}</span>}
          </div>
        )}
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

function DestinationDialog({ open, level, initial, onClose }: { open: boolean; level: DestinationLevel; initial: Destination | null; onClose: () => void }) {
  const { project } = useProject();
  const save = useSaveDestination(project.id);
  const toast = useToast();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? ''); setUrl(initial?.url ?? ''); setError('');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = name.trim() && url.trim();
  const submit = async () => {
    if (!valid) return;
    try {
      await save.mutateAsync({ id: initial?.id, level, input: { name: name.trim(), url: url.trim() } });
      toast({ title: initial ? 'Webhook updated' : 'Webhook saved', body: name.trim(), tone: 'good' });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={initial ? 'Edit webhook' : level === 'account' ? 'New webhook of your own' : 'New webhook for this project'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid || save.isPending} onClick={submit}>{initial ? 'Save' : 'Save webhook'}</Button></>}>
      <div className="space-y-4">
        <p className="text-[12.5px] text-muted">
          {level === 'account'
            ? 'Only you can use and change it. You can pick it in triggers of every project you’re a member of; other members see its name.'
            : 'Every member of this project can pick it in a trigger.'}
        </p>
        <Field label="Name"><input autoFocus className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ops pager" /></Field>
        <Field label="HTTPS URL" hint="JSON POST, signed with X-WGO-Signature using this webhook's own secret; hooks.slack.com URLs get a Slack message">
          <input className="field font-mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/wgo" />
        </Field>
        {error && <p className="rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{error}</p>}
      </div>
    </Dialog>
  );
}

function DestinationRow({ d, onEdit }: { d: Destination; onEdit: () => void }) {
  const { project } = useProject();
  const del = useDeleteDestination(project.id);
  const test = useTestDestination(project.id);
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const runTest = async () => {
    const r = await test.mutateAsync({ id: d.id, level: d.level });
    toast({ title: r.ok ? 'Test notification sent' : 'Test notification failed', body: r.status, tone: r.ok ? 'good' : 'bad' });
  };
  const remove = async () => {
    if (!confirm(`Remove “${d.name}”?`)) return;
    try {
      await del.mutateAsync({ id: d.id, level: d.level });
    } catch (e) {
      toast({ title: 'Cannot remove it', body: (e as Error).message, tone: 'bad' });
    }
  };
  return (
    <div className="group flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line/60 py-2 text-[12.5px] first:border-t-0">
      {d.type === 'slack' ? <Hash size={13} className="text-faint" /> : <Webhook size={13} className="text-faint" />}
      <span className="font-medium">{d.type === 'slack' ? d.name.replace(/^#/, '') : d.name}</span>
      {d.detail && <span className={cn('text-faint', d.type === 'webhook' && 'font-mono text-[11.5px]')}>· {d.detail}</span>}
      <span className="ml-auto flex items-center gap-1">
        {d.signingSecret && (
          <button onClick={() => { void navigator.clipboard.writeText(d.signingSecret!); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            className="inline-flex items-center gap-1 px-1 text-[11.5px] text-faint hover:text-fg cursor-pointer" title="Verify X-WGO-Signature (HMAC-SHA256 of the body) with this secret">
            {copied ? <Check size={11} /> : <Copy size={11} />}signing secret
          </button>)}
        <Button size="sm" onClick={() => void runTest()} disabled={test.isPending} title="Send a sample notification now"><Send size={13} />Test</Button>
        {d.type === 'webhook' && d.editable && <button onClick={onEdit} className="rounded-md p-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="Edit"><Pencil size={13} /></button>}
        <button onClick={() => void remove()} className="rounded-md p-1.5 text-muted hover:bg-bad/15 hover:text-bad cursor-pointer" title="Remove"><Trash2 size={13} /></button>
      </span>
    </div>
  );
}

/**
 * The project's destinations and the user's own, each with ways to add more. `slackDialog` is the level the Slack
 * channel picker is open for (also opened by the page when the user comes back from connecting a workspace).
 */
function Destinations({ slackDialog, setSlackDialog }: { slackDialog: DestinationLevel | null; setSlackDialog: (l: DestinationLevel | null) => void }) {
  const { project } = useProject();
  const destinations = useDestinations(project.id);
  const setup = useSlackSetup(project.id);
  const disconnect = useDisconnectSlackWorkspace(project.id);
  const toast = useToast();
  const workspacesAt = (level: DestinationLevel) => setup.data?.workspaces.filter((w) => w.level === level) ?? [];
  const forgetWorkspace = async (id: string, name: string | null) => {
    if (!confirm(`Disconnect ${name ?? 'this Slack workspace'}? WGO stays installed in Slack until you remove it there.`)) return;
    try {
      await disconnect.mutateAsync(id);
      toast({ title: 'Slack workspace disconnected', tone: 'accent' });
    } catch (e) {
      toast({ title: 'Cannot disconnect it', body: (e as Error).message, tone: 'bad' });
    }
  };
  const [dialog, setDialog] = useState<{ open: boolean; level: DestinationLevel; d: Destination | null }>({ open: false, level: 'project', d: null });
  const section = (level: DestinationLevel, title: string, sub: string, empty: string) => {
    const list = destinations.data?.filter((d) => d.level === level) ?? [];
    return (
      <div className="px-4 pb-3 pt-1">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-1.5">
          <div>
            <div className="text-[12.5px] font-semibold">{title}</div>
            <div className="text-[11.5px] text-faint">{sub}</div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" onClick={() => setDialog({ open: true, level, d: null })}><Plus size={13} />Webhook</Button>
            <Button size="sm" onClick={() => setSlackDialog(level)}><Slack size={13} />Slack channel</Button>
          </div>
        </div>
        {destinations.isPending ? <Skeleton className="h-8" />
          : list.length ? list.map((d) => <DestinationRow key={d.id} d={d} onEdit={() => setDialog({ open: true, level, d })} />)
          : <p className="py-1 text-[12.5px] text-faint">{empty}</p>}
        {workspacesAt(level).map((w) => (
          <p key={w.id} className="pt-2 text-[11.5px] text-faint">
            Slack workspace {w.teamName ?? ''}{level === 'project' ? `, connected by ${w.createdBy}` : ''}.{' '}
            <button className="cursor-pointer text-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => void forgetWorkspace(w.id, w.teamName)}>Disconnect</button>
          </p>
        ))}
      </div>
    );
  };
  return (
    <Card>
      <CardHeader title="Destinations" sub="Slack channels and webhooks your triggers can notify. Save one once, pick it in any trigger." />
      {section('project', 'This project', 'Every member can use them in this project’s triggers', 'None yet.')}
      <div className="border-t border-line/60" />
      {section('account', 'Yours', 'Only you manage them, and you can use them in every project you’re a member of', 'None yet. Save a webhook or Slack channel here to reuse it across your projects.')}
      <SlackChannelDialog level={slackDialog} onClose={() => setSlackDialog(null)} />
      <DestinationDialog open={dialog.open} level={dialog.level} initial={dialog.d} onClose={() => setDialog((x) => ({ ...x, open: false, d: null }))} />
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

  // "Create trigger" from a filter bar, a table row or a goal lands here with ?new=1&scope=…&pf=<filters JSON>[&name=…]
  // (older links: the events filters in ?f=)
  const wantsNew = route.params.get('new') === '1';
  const prefill = useMemo((): Prefill => {
    const raw = route.params.get('scope');
    const scope: FilterScope = raw === 'logs' || raw === 'spans' ? raw : 'events';
    return { scope, filters: decodeFilters(route.params.get('pf') ?? route.params.get(FILTER_PARAM.events)), name: route.params.get('name') || undefined };
  }, [route.params]);
  useEffect(() => {
    if (!wantsNew) return;
    setDialog({ open: true, t: null, prefill });
    set({ new: null, pf: null, scope: null, name: null });
  }, [wantsNew]); // eslint-disable-line react-hooks/exhaustive-deps

  // back from Slack's consent screen: a workspace was connected, so pick a channel of it
  const [slackDialog, setSlackDialog] = useState<DestinationLevel | null>(null);
  const slack = route.params.get('slack');
  useEffect(() => {
    if (!slack) return;
    void qc.invalidateQueries({ queryKey: ['slack-setup'] });
    if (slack === 'connected') {
      toast({ title: 'Slack workspace connected', body: 'Now pick a channel.', tone: 'good' });
      setSlackDialog(route.params.get('slack_level') === 'account' ? 'account' : 'project');
    } else if (slack === 'cancelled') toast({ title: 'Slack connection cancelled', tone: 'accent' });
    else if (slack === 'scopes') toast({ title: 'The Slack app needs more permissions', body: `Open the WGO app at api.slack.com/apps, add the bot token scopes ${SLACK_BOT_SCOPES.join(', ')} under OAuth & Permissions, then connect again.`, tone: 'bad' });
    else toast({ title: 'Could not connect Slack', body: 'Please try again.', tone: 'bad' });
    set({ slack: null, slack_level: null });
  }, [slack]); // eslint-disable-line react-hooks/exhaustive-deps

  if (triggers.isError) return <ErrorState error={triggers.error} retry={() => triggers.refetch()} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p className="text-[13px] text-muted">Get a Slack message or webhook call when new events, logs or spans match your filters, when a number crosses a value (no pageviews in 30 minutes, p95 over a second) or when a number is unusual for the time of day.</p>
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
      <Destinations slackDialog={slackDialog} setSlackDialog={setSlackDialog} />
      <SlackAppCard />
      <p className="text-[11.5px] text-faint">
        Webhooks receive a JSON POST (<Mono>trigger</Mono>, <Mono>project</Mono>, <Mono>scope</Mono>, <Mono>matches</Mono>, <Mono>events</Mono> / <Mono>logs</Mono> / <Mono>spans</Mono>, <Mono>url</Mono>) with an
        <Mono> X-WGO-Signature: sha256=…</Mono> header: the HMAC-SHA256 of the raw body keyed with the signing secret of the saved webhook (also named in <Mono>X-WGO-Destination</Mono>), or of the trigger for a one-off URL.
      </p>
      <TriggerDialog open={dialog.open} initial={dialog.t} prefill={dialog.prefill} onClose={() => setDialog({ open: false, t: null, prefill: NO_PREFILL })} />
    </div>
  );
}
