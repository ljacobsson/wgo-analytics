import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { AnalyticsEvent, Filter, FilterScope, LogRecord, Span, Trigger, TriggerCondition, TriggerDestination, TriggerInput, TriggerKind, TriggerMetric, TriggerStatus, TriggerTestResult, TriggerWebhookPayload } from '../contract';
import { TRIGGER_WINDOWS } from '../contract';
import { query } from './db';
import { matchesAll, type MatchRow } from './filterMatch';
import { filterSql, parseFilters } from './filters';
import { HttpError } from './http';
import { isUuid } from './projects';

// ---------------------------------------------------------------- validation

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/**
 * Whether a hostname is a public one: never loopback, link-local, private or internal names.
 * (Lambda has no VPC access here, so this mostly stops probing the runtime's own localhost services.)
 */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv = isIP(host);
  const bad =
    host === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(host) || !host.includes('.') ||
    (ipv === 4 && PRIVATE_V4.some((r) => r.test(host))) ||
    (ipv === 6 && (host === '::1' || /^(fc|fd|fe80|::ffff:)/i.test(host)));
  return !bad;
}

function assertPublicUrl(raw: string, label: string, allowHttp: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, `${label} is not a valid URL`);
  }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new HttpError(400, `${label} must use ${allowHttp ? 'http or https' : 'https'}`);
  if (u.username || u.password) throw new HttpError(400, `${label} must not contain credentials`);
  if (!isPublicHost(u.hostname)) throw new HttpError(400, `${label} must point to a public host`);
  return u;
}

/** Webhooks go to the public internet only: https, and never loopback, link-local, private or internal names. */
export function assertPublicHttpsUrl(raw: string): URL {
  return assertPublicUrl(raw, 'Webhook URL', false);
}

/** Like assertPublicHttpsUrl, but `http` is accepted too (uptime checks). `label` names the URL in error messages. */
export function assertPublicHttpUrl(raw: string, label = 'URL'): URL {
  return assertPublicUrl(raw, label, true);
}

const SCOPES: FilterScope[] = ['events', 'logs', 'spans'];

function validateScope(v: unknown): FilterScope {
  if (v === undefined || v === null) return 'events';
  if (!SCOPES.includes(v as FilterScope)) throw new HttpError(400, 'scope must be events, logs or spans');
  return v as FilterScope;
}

function validateFilters(filters: unknown, scope: FilterScope, kind: TriggerKind = 'match'): Filter[] {
  const list = parseFilters(JSON.stringify(filters ?? []));
  // a threshold/anomaly trigger may watch every row of its scope ("no pageviews in 30 minutes")
  if (!list.length && kind === 'match') throw new HttpError(400, 'A trigger needs at least one filter');
  filterSql(list, scope, []); // rejects unknown fields with a 400
  return list;
}

async function validateDestination(pid: string, d: unknown): Promise<TriggerDestination> {
  const dest = d as Partial<TriggerDestination> | undefined;
  if (dest?.type === 'webhook' && typeof dest.url === 'string') {
    assertPublicHttpsUrl(dest.url);
    return { type: 'webhook', url: dest.url };
  }
  if (dest?.type === 'slack' && typeof dest.integrationId === 'string') {
    const rows = !isUuid(dest.integrationId) ? [] : await query('SELECT 1 FROM integrations WHERE project_id = $1 AND id = $2 AND type = $3', [pid, dest.integrationId, 'slack']);
    if (!rows.length) throw new HttpError(400, 'That Slack channel is not connected to this project');
    return { type: 'slack', integrationId: dest.integrationId };
  }
  throw new HttpError(400, 'destination must be { type: "webhook", url } or { type: "slack", integrationId }');
}

/**
 * Where links in notifications point: the dashboard the trigger was saved from (its Origin header).
 * Only https origins, or http on localhost for local development.
 */
export function dashboardOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    const local = u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
    return u.protocol === 'https:' || local ? u.origin : null;
  } catch {
    return null;
  }
}

const KINDS: TriggerKind[] = ['match', 'threshold', 'anomaly'];
const AGGS = ['count', 'sessions', 'session_rate', 'avg', 'p75', 'p95'] as const;

function validateKind(v: unknown): TriggerKind {
  if (v === undefined || v === null) return 'match';
  if (!KINDS.includes(v as TriggerKind)) throw new HttpError(400, 'kind must be match, threshold or anomaly');
  return v as TriggerKind;
}

/** Metric, condition and window of a threshold/anomaly trigger (all null for match triggers). */
export function validateAggregate(kind: TriggerKind, scope: FilterScope, body: Partial<TriggerInput>): { metric: TriggerMetric | null; condition: TriggerCondition | null; windowMinutes: number | null } {
  if (kind === 'match') return { metric: null, condition: null, windowMinutes: null };
  const m = body.metric as Partial<TriggerMetric> | undefined;
  if (!m || !AGGS.includes(m.agg as never)) throw new HttpError(400, `metric.agg must be one of ${AGGS.join(', ')}`);
  if ((m.agg === 'sessions' || m.agg === 'session_rate') && scope !== 'events') throw new HttpError(400, 'Sessions can only be counted for product events');
  const metric: TriggerMetric = { agg: m.agg! };
  if (m.agg === 'avg' || m.agg === 'p75' || m.agg === 'p95') {
    if (typeof m.field !== 'string' || !m.field) throw new HttpError(400, `metric.field is required for ${m.agg}`);
    filterSql([{ field: m.field, op: 'set' }], scope, []); // rejects unknown fields
    metric.field = m.field;
  }
  const w = Number(body.windowMinutes);
  if (!(TRIGGER_WINDOWS as readonly number[]).includes(w)) throw new HttpError(400, `windowMinutes must be one of ${TRIGGER_WINDOWS.join(', ')}`);
  const c = (body.condition ?? {}) as Record<string, unknown>;
  let condition: TriggerCondition;
  if (kind === 'threshold') {
    const value = Number(c.value);
    if ((c.op !== 'above' && c.op !== 'below') || !Number.isFinite(value)) throw new HttpError(400, 'condition must be { op: "above" | "below", value: number }');
    condition = { op: c.op, value };
  } else {
    if (!['up', 'down', 'either'].includes(c.direction as string) || !['low', 'medium', 'high'].includes(c.sensitivity as string)) {
      throw new HttpError(400, 'condition must be { direction: "up" | "down" | "either", sensitivity: "low" | "medium" | "high" }');
    }
    condition = { direction: c.direction as 'up', sensitivity: c.sensitivity as 'low' };
  }
  return { metric, condition, windowMinutes: w };
}

const cooldown = (v: unknown) => {
  const n = v === undefined ? 300 : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 86400) throw new HttpError(400, 'cooldownSeconds must be 0-86400');
  return n;
};
const triggerName = (v: unknown) => {
  const n = typeof v === 'string' ? v.trim() : '';
  if (!n || n.length > 120) throw new HttpError(400, 'Trigger name must be 1-120 characters');
  return n;
};

// ---------------------------------------------------------------- storage

interface TriggerRow {
  project_id: string; id: string; name: string; scope: FilterScope | null; filters: Filter[]; destination: TriggerDestination; cooldown_seconds: number;
  enabled: boolean; signing_secret: string; created_by: string; created_at: Date; last_fired_at: Date | null; fire_count: number;
  suppressed: number; last_status: string | null; dashboard_url: string | null;
  kind: TriggerKind | null; metric: TriggerMetric | null; condition: TriggerCondition | null; window_minutes: number | null;
  state: 'ok' | 'firing' | null; state_since: Date | null; last_value: number | null; last_evaluated_at: Date | null;
  baseline: { median: number; low: number; high: number; days: number; hour?: number; at?: string } | null;
}
export type { TriggerRow };

const scopeOf = (r: { scope: FilterScope | null }): FilterScope => r.scope ?? 'events'; // NULL: created before scopes existed
export const kindOf = (r: { kind?: TriggerKind | null }): TriggerKind => r.kind ?? 'match'; // NULL: created before kinds existed

const statusOf = (r: TriggerRow): TriggerStatus | null => kindOf(r) === 'match' ? null : {
  state: r.state, since: r.state_since?.toISOString() ?? null, lastValue: r.last_value, lastEvaluatedAt: r.last_evaluated_at?.toISOString() ?? null,
  baseline: r.baseline ? { median: r.baseline.median, low: r.baseline.low, high: r.baseline.high, days: r.baseline.days } : null,
};

const toTrigger = (r: TriggerRow): Trigger => ({
  id: r.id, name: r.name, scope: scopeOf(r), filters: r.filters, destination: r.destination, cooldownSeconds: r.cooldown_seconds, enabled: r.enabled,
  signingSecret: r.signing_secret, createdBy: r.created_by, createdAt: r.created_at.toISOString(),
  lastFiredAt: r.last_fired_at?.toISOString() ?? null, fireCount: r.fire_count, lastStatus: r.last_status,
  kind: kindOf(r), metric: r.metric, condition: r.condition, windowMinutes: r.window_minutes,
  status: statusOf(r),
});

export async function listTriggers(pid: string): Promise<Trigger[]> {
  const rows = await query<TriggerRow>('SELECT * FROM triggers WHERE project_id = $1 ORDER BY created_at', [pid]);
  return rows.map(toTrigger);
}

async function getTrigger(pid: string, id: string): Promise<TriggerRow> {
  if (!isUuid(id)) throw new HttpError(404, 'Trigger not found');
  const [row] = await query<TriggerRow>('SELECT * FROM triggers WHERE project_id = $1 AND id = $2', [pid, id]);
  if (!row) throw new HttpError(404, 'Trigger not found');
  return row;
}

export async function createTrigger(pid: string, email: string, body: Partial<TriggerInput>, origin?: string): Promise<Trigger> {
  const id = randomUUID();
  const scope = validateScope(body.scope);
  const kind = validateKind(body.kind);
  const agg = validateAggregate(kind, scope, body);
  await query(
    `INSERT INTO triggers (project_id, id, name, scope, filters, destination, cooldown_seconds, enabled, signing_secret, created_by, dashboard_url,
                           kind, metric, condition, window_minutes)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15)`,
    [pid, id, triggerName(body.name), scope, JSON.stringify(validateFilters(body.filters, scope, kind)), JSON.stringify(await validateDestination(pid, body.destination)),
      cooldown(body.cooldownSeconds), body.enabled !== false, 'whsec_' + randomBytes(24).toString('base64url'), email, dashboardOrigin(origin),
      kind === 'match' ? null : kind, agg.metric && JSON.stringify(agg.metric), agg.condition && JSON.stringify(agg.condition), agg.windowMinutes],
  );
  cache.delete(pid);
  return toTrigger(await getTrigger(pid, id));
}

export async function updateTrigger(pid: string, id: string, body: Partial<TriggerInput>, origin?: string): Promise<Trigger> {
  const cur = await getTrigger(pid, id);
  if (body.scope !== undefined && validateScope(body.scope) !== scopeOf(cur)) throw new HttpError(400, 'A trigger’s scope can’t be changed; create a new trigger instead');
  const kind = kindOf(cur);
  if (body.kind !== undefined && validateKind(body.kind) !== kind) throw new HttpError(400, 'A trigger’s kind can’t be changed; create a new trigger instead');
  const agg = validateAggregate(kind, scopeOf(cur), {
    metric: body.metric ?? cur.metric ?? undefined, condition: body.condition ?? cur.condition ?? undefined, windowMinutes: body.windowMinutes ?? cur.window_minutes ?? undefined,
  });
  // a changed definition starts over: state, last value and the anomaly baseline no longer apply
  const changed = kind !== 'match' && (body.metric !== undefined || body.condition !== undefined || body.windowMinutes !== undefined || body.filters !== undefined);
  await query(
    `UPDATE triggers SET name = $3, filters = $4::jsonb, destination = $5::jsonb, cooldown_seconds = $6, enabled = $7,
            dashboard_url = COALESCE($8, dashboard_url), metric = $9::jsonb, condition = $10::jsonb, window_minutes = $11
            ${changed ? ', state = NULL, state_since = NULL, last_value = NULL, baseline = NULL' : ''}
      WHERE project_id = $1 AND id = $2`,
    [pid, id,
      body.name !== undefined ? triggerName(body.name) : cur.name,
      JSON.stringify(body.filters !== undefined ? validateFilters(body.filters, scopeOf(cur), kind) : cur.filters),
      JSON.stringify(body.destination !== undefined ? await validateDestination(pid, body.destination) : cur.destination),
      body.cooldownSeconds !== undefined ? cooldown(body.cooldownSeconds) : cur.cooldown_seconds,
      body.enabled !== undefined ? body.enabled === true : cur.enabled, dashboardOrigin(origin),
      agg.metric && JSON.stringify(agg.metric), agg.condition && JSON.stringify(agg.condition), agg.windowMinutes],
  );
  cache.delete(pid);
  return toTrigger(await getTrigger(pid, id));
}

export async function deleteTrigger(pid: string, id: string): Promise<void> {
  await getTrigger(pid, id);
  await query('DELETE FROM triggers WHERE project_id = $1 AND id = $2', [pid, id]);
  cache.delete(pid);
}

// ---------------------------------------------------------------- evaluation (ingest path)

/** Enabled triggers per project, cached briefly per container: ingest runs on every SDK batch. */
type ActiveTrigger = { id: string; scope: FilterScope | null; filters: Filter[] };
const cache = new Map<string, { triggers: ActiveTrigger[]; exp: number }>();
const CACHE_MS = 30_000;

async function activeTriggers(pid: string) {
  const hit = cache.get(pid);
  if (hit && hit.exp > Date.now()) return hit.triggers;
  // threshold/anomaly triggers are evaluated on a schedule (lib/monitor.ts), not per row
  const triggers = await query<ActiveTrigger>(`SELECT id, scope, filters FROM triggers WHERE project_id = $1 AND enabled AND (kind IS NULL OR kind = 'match')`, [pid]);
  cache.set(pid, { triggers, exp: Date.now() + CACHE_MS });
  return triggers;
}

export interface DeliveryRequest {
  projectId: string;
  triggerId: string;
  events: AnalyticsEvent[]; // events scope
  logs?: LogRecord[];
  spans?: Span[];
  matches: number;
}

const MAX_EVENTS = 10;
const cut = (s: string | null, n: number) => (s && s.length > n ? s.slice(0, n) : s);
const slim = (e: AnalyticsEvent): AnalyticsEvent => ({ ...e, errorStack: cut(e.errorStack, 1000) });
// async Lambda payloads are capped at 256 KB: keep bodies and span events small
const slimLog = (l: LogRecord): LogRecord => ({ ...l, body: cut(l.body, 2000)! });
const slimSpan = (s: Span): Span => ({ ...s, events: s.events.slice(0, 5) });

let lambda: LambdaClient | undefined;

/**
 * Match a batch of new rows (events, or OTel logs/spans) against the project's triggers of that scope and hand
 * matches to the delivery function (async, never blocks ingest).
 */
export async function evaluateTriggers(projectId: string, rows: AnalyticsEvent[]): Promise<number>;
export async function evaluateTriggers(projectId: string, rows: MatchRow[], scope: FilterScope): Promise<number>;
export async function evaluateTriggers(projectId: string, rows: MatchRow[], scope: FilterScope = 'events'): Promise<number> {
  if (!rows.length) return 0;
  const triggers = (await activeTriggers(projectId)).filter((t) => scopeOf(t) === scope);
  let fired = 0;
  await Promise.all(
    triggers.map(async (t) => {
      const hits = rows.filter((r) => matchesAll(r, t.filters, scope));
      if (!hits.length) return;
      fired++;
      const recent = hits.slice(-MAX_EVENTS);
      const req: DeliveryRequest = {
        projectId, triggerId: t.id, matches: hits.length,
        events: scope === 'events' ? (recent as AnalyticsEvent[]).map(slim) : [],
        ...(scope === 'logs' ? { logs: (recent as LogRecord[]).map(slimLog) } : {}),
        ...(scope === 'spans' ? { spans: (recent as Span[]).map(slimSpan) } : {}),
      };
      const fn = process.env.TRIGGER_FUNCTION;
      if (!fn) {
        void deliver(req).catch((err) => console.warn('trigger delivery failed', err)); // local dev: no Lambda
        return;
      }
      lambda ??= new LambdaClient({});
      await lambda.send(new InvokeCommand({ FunctionName: fn, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(req)) }));
    }),
  );
  return fired;
}

// ---------------------------------------------------------------- delivery

const LINK: Record<FilterScope, { page: string; param: string }> = {
  events: { page: 'events', param: 'f' }, logs: { page: 'logs', param: 'lf' }, spans: { page: 'traces', param: 'tf' },
};

/** Dashboard link to the rows a trigger matches: the scope's page with the trigger's filters applied. */
export function matchesLink(dashboard: string | null, pid: string, filters: Filter[], scope: FilterScope = 'events'): string {
  const { page, param } = LINK[scope];
  return dashboard ? `${dashboard}/#/p/${pid}/${page}?range=24h&${param}=${encodeURIComponent(JSON.stringify(filters))}` : '';
}

export const sign = (secret: string, body: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

function describe(e: AnalyticsEvent): string {
  const where = [e.path, e.city && e.country ? `${e.city}, ${e.country}` : e.country].filter(Boolean).join(' · ');
  const what =
    e.type === 'click' ? `click “${e.trackName || e.elementText || e.selector || '?'}”`
    : e.type === 'error' ? `error: ${e.errorMessage ?? ''}`
    : e.type === 'http_error' ? `${e.httpMethod} ${e.httpRoute ?? e.httpUrl} → ${e.httpStatus}`
    : e.type === 'custom' ? `${e.name}`
    : e.type === 'pageview' ? `pageview ${e.path ?? ''}`
    : e.type;
  return where ? `${what}  (${where})` : what;
}

const SEVERITY: Array<[number, string]> = [[21, 'FATAL'], [17, 'ERROR'], [13, 'WARN'], [9, 'INFO'], [5, 'DEBUG'], [0, 'TRACE']];
const severityName = (n: number) => SEVERITY.find(([min]) => n >= min)![1];

function describeLog(l: LogRecord): string {
  return `[${l.severityText || severityName(l.severityNumber)}] ${l.service}: ${l.body.replace(/\s+/g, ' ')}`;
}

function describeSpan(s: Span): string {
  const ms = s.durationMs >= 1000 ? `${(s.durationMs / 1000).toFixed(2)} s` : `${Math.round(s.durationMs)} ms`;
  return `${s.service}: ${s.name} · ${ms}${s.statusCode === 2 ? ` · error${s.statusMessage ? `: ${s.statusMessage}` : ''}` : ''}`;
}

const NOUN: Record<FilterScope, string> = { events: 'event', logs: 'log record', spans: 'span' };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const AGG_LABEL: Record<TriggerMetric['agg'], string> = {
  count: 'Count', sessions: 'Sessions', session_rate: 'Share of sessions', avg: 'Average', p75: 'p75', p95: 'p95',
};
const fmtValue = (v: number | null | undefined, m?: TriggerMetric) => {
  if (v == null) return 'no data';
  if (m?.agg === 'session_rate') return `${(v * 100).toFixed(1)}%`;
  if (m?.field && /duration|ms$|lcp|inp|fcp|ttfb/i.test(m.field)) return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
  return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2);
};
const windowText = (min?: number) => (!min ? '' : min < 60 ? `${min} minutes` : min === 60 ? 'hour' : min < 1440 ? `${min / 60} hours` : '24 hours');

/** "Count in the last 15 minutes is 34, above 20" / "… is 3, unusually low (usually 9–15)" / "… is back to normal: 12". */
export function describeAggregate(p: Pick<TriggerWebhookPayload, 'kind' | 'state' | 'value' | 'metric' | 'condition' | 'windowMinutes' | 'baseline'>): string {
  const m = p.metric;
  const what = `${m ? AGG_LABEL[m.agg] : 'Value'}${m?.field ? ` of ${m.field}` : ''} in the last ${windowText(p.windowMinutes)}`;
  const v = fmtValue(p.value, m);
  if (p.state === 'resolved') return `${what} is back to normal: ${v}.`;
  const c = p.condition;
  if (c && 'op' in c) return `${what} is ${v}, ${c.op} ${fmtValue(c.value, m)}.`;
  const b = p.baseline;
  const usual = b ? ` (usually ${fmtValue(b.low, m)} to ${fmtValue(b.high, m)})` : '';
  const dir = b && p.value != null && p.value < b.median ? 'low' : 'high';
  return `${what} is ${v}, unusually ${dir}${usual}.`;
}

/** Slack Block Kit message for a notification (incoming webhooks accept blocks plus a text fallback). */
export function slackMessage(p: TriggerWebhookPayload): object {
  if (p.kind && p.kind !== 'match') {
    const head = `${p.test ? '[test] ' : ''}${p.state === 'resolved' ? '✅ Resolved' : '🔔'} ${p.trigger.name}`;
    const line = describeAggregate(p);
    return {
      text: `${head}: ${line}`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: head.slice(0, 150), emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `${esc(line)} Project *${esc(p.project.name)}*.` } },
        ...(p.explanation && p.state !== 'resolved' ? [{ type: 'section', text: { type: 'mrkdwn', text: esc(p.explanation).slice(0, 2900) } }] : []),
        ...(p.url.startsWith('http') ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in WGO' }, url: p.url }] }] : []),
      ],
    };
  }
  const head = `${p.test ? '[test] ' : ''}${p.trigger.name}`;
  const what = `${p.matches} matching ${NOUN[p.scope ?? 'events']}${p.matches === 1 ? '' : 's'}`;
  const summary = `${what} in *${esc(p.project.name)}*`;
  const described = p.logs ? p.logs.map(describeLog) : p.spans ? p.spans.map(describeSpan) : p.events.map(describe);
  const lines = described.slice(-5).reverse().map((d) => `• ${esc(d).slice(0, 180)}`);
  return {
    text: `🔔 ${head}: ${what}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `🔔 ${head}`.slice(0, 150), emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: summary } },
      ...(lines.length ? [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) } }] : []),
      ...(p.url.startsWith('http') ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in WGO' }, url: p.url }] }] : []),
    ],
  };
}

async function send(t: TriggerRow, payload: TriggerWebhookPayload): Promise<string> {
  let url: string;
  let body: string;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'WGO-Webhook/1' };
  if (t.destination.type === 'slack') {
    const [row] = await query<{ config: { webhookUrl: string } }>('SELECT config FROM integrations WHERE project_id = $1 AND id = $2', [t.project_id, t.destination.integrationId]);
    if (!row) return 'slack: channel disconnected';
    url = row.config.webhookUrl;
    body = JSON.stringify(slackMessage(payload));
  } else {
    url = assertPublicHttpsUrl(t.destination.url).toString();
    // a pasted Slack incoming-webhook URL gets a Slack message; anything else the documented JSON payload
    if (new URL(url).hostname === 'hooks.slack.com') body = JSON.stringify(slackMessage(payload));
    else {
      body = JSON.stringify(payload);
      headers['x-wgo-signature'] = sign(t.signing_secret, body);
      headers['x-wgo-trigger'] = t.id;
    }
  }
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000), redirect: 'manual' });
    const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 80);
    return res.ok ? String(res.status) : `${res.status}${text ? ' ' + text : ''}`;
  } catch (err) {
    return (err as Error).name === 'TimeoutError' ? 'timeout' : `error: ${(err as Error).message}`.slice(0, 120);
  }
}

type Matched = Pick<DeliveryRequest, 'events' | 'logs' | 'spans'>;

async function payloadFor(t: TriggerRow, rows: Matched, matches: number, test = false): Promise<TriggerWebhookPayload> {
  const [proj] = await query<{ name: string }>('SELECT name FROM projects WHERE id = $1', [t.project_id]);
  const scope = scopeOf(t);
  return {
    trigger: { id: t.id, name: t.name },
    project: { id: t.project_id, name: proj?.name ?? '' },
    firedAt: new Date().toISOString(),
    scope,
    matches,
    events: rows.events ?? [],
    ...(scope === 'logs' ? { logs: rows.logs ?? [] } : {}),
    ...(scope === 'spans' ? { spans: rows.spans ?? [] } : {}),
    url: matchesLink(t.dashboard_url, t.project_id, t.filters, scope),
    ...(test ? { test: true } : {}),
  };
}

/**
 * Deliver one batch of matches, honouring the cooldown: inside it, matches are only counted; the next
 * notification reports them. The fire claim is optimistic (conditional on fire_count), so concurrent
 * ingest invocations can't both notify for the same window.
 */
export async function deliver(req: DeliveryRequest): Promise<'sent' | 'cooldown' | 'skipped'> {
  const [t] = await query<TriggerRow>('SELECT * FROM triggers WHERE project_id = $1 AND id = $2', [req.projectId, req.triggerId]);
  if (!t || !t.enabled) return 'skipped';
  const now = Date.now();
  if (t.last_fired_at && now - t.last_fired_at.getTime() < t.cooldown_seconds * 1000) {
    await query('UPDATE triggers SET suppressed = suppressed + $3 WHERE project_id = $1 AND id = $2', [t.project_id, t.id, req.matches]);
    return 'cooldown';
  }
  // fire_count is the version: exact, unlike timestamps (JS Dates drop the microseconds Postgres keeps)
  const claimed = await query(
    `UPDATE triggers SET last_fired_at = now(), fire_count = fire_count + 1, suppressed = 0
      WHERE project_id = $1 AND id = $2 AND fire_count = $3 RETURNING id`,
    [t.project_id, t.id, t.fire_count],
  );
  if (!claimed.length) {
    await query('UPDATE triggers SET suppressed = suppressed + $3 WHERE project_id = $1 AND id = $2', [t.project_id, t.id, req.matches]);
    return 'cooldown';
  }
  const status = await send(t, await payloadFor(t, req, req.matches + t.suppressed));
  await query('UPDATE triggers SET last_status = $3 WHERE project_id = $1 AND id = $2', [t.project_id, t.id, status]);
  return 'sent';
}

/**
 * A threshold/anomaly trigger started firing or resolved (lib/monitor.ts). Firing honours the cooldown (at most one
 * "firing" notification per period, against flapping); resolving always notifies when firing was notified.
 */
export async function notifyAggregate(t: TriggerRow, state: 'firing' | 'resolved', value: number | null, baseline: TriggerStatus['baseline'], explanation?: string): Promise<'sent' | 'cooldown'> {
  if (state === 'firing') {
    if (t.last_fired_at && Date.now() - t.last_fired_at.getTime() < t.cooldown_seconds * 1000) {
      await query('UPDATE triggers SET suppressed = suppressed + 1 WHERE project_id = $1 AND id = $2', [t.project_id, t.id]);
      return 'cooldown';
    }
    await query('UPDATE triggers SET last_fired_at = now(), fire_count = fire_count + 1, suppressed = 0 WHERE project_id = $1 AND id = $2', [t.project_id, t.id]);
  }
  const base = await payloadFor(t, { events: [] }, 0);
  const minutes = t.window_minutes ?? 60;
  const payload: TriggerWebhookPayload = {
    ...base, kind: kindOf(t), state, value, metric: t.metric ?? undefined, condition: t.condition ?? undefined, windowMinutes: minutes,
    baseline, ...(explanation ? { explanation } : {}),
    url: base.url.replace('range=24h', `range=${minutes >= 1440 ? '7d' : minutes >= 360 ? '24h' : '6h'}`),
  };
  const status = await send(t, payload);
  await query('UPDATE triggers SET last_status = $3 WHERE project_id = $1 AND id = $2', [t.project_id, t.id, status]);
  return 'sent';
}

/** "Send test": a sample notification right now, bypassing the cooldown and leaving the counters alone. */
export async function testTrigger(pid: string, id: string): Promise<TriggerTestResult> {
  const t = await getTrigger(pid, id);
  const sample: AnalyticsEvent = {
    id: randomUUID(), type: 'click', ts: new Date().toISOString(), sessionId: 'test', anonId: null, userId: null, url: null, path: '/example',
    title: null, referrer: null, selector: 'button#example', elementText: 'Example button', elementTag: 'button', trackName: 'example',
    errorMessage: null, errorStack: null, errorSource: null, fingerprint: null, httpMethod: null, httpUrl: null, httpRoute: null, httpStatus: null,
    durationMs: null, name: null, props: {}, browser: 'Chrome', os: 'macOS', device: 'desktop', country: 'SE', region: null, city: 'Stockholm', lat: null, lon: null, bot: null,
  };
  const now = new Date().toISOString();
  const scope = scopeOf(t);
  const rows: Matched =
    scope === 'logs' ? { events: [], logs: [{ id: randomUUID(), ts: now, severityNumber: 17, severityText: 'ERROR', body: 'Example log message', service: 'example-service', traceId: null, spanId: null, attributes: {}, resource: {} }] }
    : scope === 'spans' ? { events: [], spans: [{ traceId: '0'.repeat(32), spanId: '0'.repeat(16), parentSpanId: null, name: 'GET /example', kind: 2, service: 'example-service', start: now, end: now, durationMs: 1234, statusCode: 2, statusMessage: 'Example failure', attributes: {}, resource: {}, events: [] }] }
    : { events: [sample] };
  let payload = await payloadFor(t, rows, 1, true);
  if (kindOf(t) !== 'match') {
    const c = t.condition;
    const value = c && 'op' in c ? (c.op === 'above' ? c.value * 1.5 || 1 : 0) : 42;
    payload = { ...payload, events: [], logs: undefined, spans: undefined, kind: kindOf(t), state: 'firing', value, metric: t.metric ?? undefined, condition: c ?? undefined,
      windowMinutes: t.window_minutes ?? 60, baseline: c && 'op' in c ? null : { median: 12, low: 8, high: 17, days: 7 },
      ...(scopeOf(t) === 'events' ? { explanation: 'Example: 80% of the increase is on /checkout, which was 10% of the total before. It started around 14:05 UTC, 2 minutes after release 1.4.2 was first seen.' } : {}) };
  }
  const status = await send(t, payload);
  await query('UPDATE triggers SET last_status = $3 WHERE project_id = $1 AND id = $2', [pid, id, `test: ${status}`]);
  return { ok: /^2\d\d$/.test(status), status };
}
