import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { AnalyticsEvent, Filter, FilterScope, LogRecord, SlackTemplate, Span, Trigger, TriggerCondition, TriggerDestination, TriggerInput, TriggerKind, TriggerMetric, TriggerStatus, TriggerTestResult, TriggerWebhookPayload } from '../contract';
import { TRIGGER_WINDOWS } from '../contract';
import { query } from './db';
import { matchesAll, type MatchRow } from './filterMatch';
import { filterSql, parseFilters } from './filters';
import { canPick, labelsFor, savedTarget, type Target } from './destinations';
import { HttpError } from './http';
import { isUuid } from './projects';
import { channelTarget, postToSlack, type SlackChannelConfig } from './slack';
import { sampleAggregate, sampleEvent, sampleRows, slackMessage, slackTemplateProblem } from './slackTemplate';

export { describeAggregate, slackMessage } from './slackTemplate';

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

/**
 * A trigger's destination. A saved one must be the project's or the caller's own account destination, except when it
 * is unchanged: a member may edit a trigger that uses another member's destination and keep it.
 */
async function validateDestination(pid: string, email: string, d: unknown, current?: TriggerDestination): Promise<TriggerDestination> {
  const dest = d as Partial<TriggerDestination> | undefined;
  if (dest?.type === 'saved' && typeof dest.destinationId === 'string') {
    const same = current?.type === 'saved' && current.destinationId === dest.destinationId;
    if (!same && !(await canPick(pid, email, dest.destinationId))) throw new HttpError(400, 'Pick a destination of this project or one of your own');
    return { type: 'saved', destinationId: dest.destinationId };
  }
  if (dest?.type === 'webhook' && typeof dest.url === 'string') {
    assertPublicHttpsUrl(dest.url);
    return { type: 'webhook', url: dest.url };
  }
  if (dest?.type === 'slack' && typeof dest.integrationId === 'string') {
    const rows = !isUuid(dest.integrationId) ? [] : await query('SELECT 1 FROM integrations WHERE project_id = $1 AND id = $2 AND type = $3', [pid, dest.integrationId, 'slack']);
    if (!rows.length) throw new HttpError(400, 'That Slack channel is not connected to this project');
    return { type: 'slack', integrationId: dest.integrationId };
  }
  throw new HttpError(400, 'destination must be { type: "webhook", url }, { type: "slack", integrationId } or { type: "saved", destinationId }');
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
/** A trigger's Slack message design: null clears it (the default message). */
export function validateSlackTemplate(v: unknown): SlackTemplate | null {
  if (v === null) return null;
  const problem = slackTemplateProblem(v);
  if (problem) throw new HttpError(400, problem);
  return { blocks: (v as SlackTemplate).blocks };
}
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
  slack_template: SlackTemplate | null;
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
  status: statusOf(r), destinationLabel: null, slackTemplate: r.slack_template ?? null,
});

/** Triggers as returned by the API: with the labels of the saved destinations they use. */
async function withLabels(rows: TriggerRow[]): Promise<Trigger[]> {
  const labels = await labelsFor(rows.map((r) => r.destination));
  return rows.map((r) => ({ ...toTrigger(r), destinationLabel: r.destination.type === 'saved' ? labels.get(r.destination.destinationId) ?? null : null }));
}

export async function listTriggers(pid: string): Promise<Trigger[]> {
  return withLabels(await query<TriggerRow>('SELECT * FROM triggers WHERE project_id = $1 ORDER BY created_at', [pid]));
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
                           kind, metric, condition, window_minutes, slack_template)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16::jsonb)`,
    [pid, id, triggerName(body.name), scope, JSON.stringify(validateFilters(body.filters, scope, kind)), JSON.stringify(await validateDestination(pid, email, body.destination)),
      cooldown(body.cooldownSeconds), body.enabled !== false, 'whsec_' + randomBytes(24).toString('base64url'), email, dashboardOrigin(origin),
      kind === 'match' ? null : kind, agg.metric && JSON.stringify(agg.metric), agg.condition && JSON.stringify(agg.condition), agg.windowMinutes,
      jsonOrNull(body.slackTemplate === undefined ? null : validateSlackTemplate(body.slackTemplate))],
  );
  cache.delete(pid);
  return (await withLabels([await getTrigger(pid, id)]))[0];
}

const jsonOrNull = (v: unknown) => (v == null ? null : JSON.stringify(v));

export async function updateTrigger(pid: string, email: string, id: string, body: Partial<TriggerInput>, origin?: string): Promise<Trigger> {
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
            dashboard_url = COALESCE($8, dashboard_url), metric = $9::jsonb, condition = $10::jsonb, window_minutes = $11,
            slack_template = $12::jsonb
            ${changed ? ', state = NULL, state_since = NULL, last_value = NULL, baseline = NULL' : ''}
      WHERE project_id = $1 AND id = $2`,
    [pid, id,
      body.name !== undefined ? triggerName(body.name) : cur.name,
      JSON.stringify(body.filters !== undefined ? validateFilters(body.filters, scopeOf(cur), kind) : cur.filters),
      JSON.stringify(body.destination !== undefined ? await validateDestination(pid, email, body.destination, cur.destination) : cur.destination),
      body.cooldownSeconds !== undefined ? cooldown(body.cooldownSeconds) : cur.cooldown_seconds,
      body.enabled !== undefined ? body.enabled === true : cur.enabled, dashboardOrigin(origin),
      agg.metric && JSON.stringify(agg.metric), agg.condition && JSON.stringify(agg.condition), agg.windowMinutes,
      jsonOrNull(body.slackTemplate !== undefined ? validateSlackTemplate(body.slackTemplate) : cur.slack_template)],
  );
  cache.delete(pid);
  return (await withLabels([await getTrigger(pid, id)]))[0];
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

/** Where a trigger sends, or why it can't (returned as its delivery status). */
async function targetFor(t: TriggerRow): Promise<Target | string> {
  const d = t.destination;
  if (d.type === 'slack') {
    const [row] = await query<{ config: SlackChannelConfig }>('SELECT config FROM integrations WHERE project_id = $1 AND id = $2', [t.project_id, d.integrationId]);
    return row ? channelTarget(row.config, null) : 'slack: channel disconnected';
  }
  if (d.type === 'saved') return savedTarget(t.project_id, d.destinationId);
  return { url: d.url, slack: false, secret: t.signing_secret, id: null };
}

async function send(t: TriggerRow, payload: TriggerWebhookPayload): Promise<string> {
  const target = await targetFor(t);
  return typeof target === 'string' ? target : postNotification(target, payload, t.id, t.slack_template);
}

/** Slack refused a trigger's own design: what to call it in the delivery status, or null for other failures. */
const rejectedDesign = (status: string): string | null => {
  const m = /^(?:slack: (invalid_blocks\w*|invalid_arguments|msg_too_long)|400(?: (.*))?)$/.exec(status);
  return m ? m[1] ?? m[2] ?? 'invalid_blocks' : null;
};

/** Whether a target gets a Slack message: a Slack channel, or an incoming webhook on hooks.slack.com. */
function isSlack(target: Target): boolean {
  if ('token' in target || target.slack) return true;
  try {
    return new URL(target.url).hostname === 'hooks.slack.com';
  } catch {
    return false;
  }
}

/** POST a body to a webhook URL (public https unless it's a Slack channel's own webhook). Returns the delivery status. */
async function post(target: Extract<Target, { url: string }>, body: string, headers: Record<string, string> = {}): Promise<string> {
  let url: string;
  try {
    url = target.slack ? target.url : assertPublicHttpsUrl(target.url).toString();
  } catch (err) {
    return `error: ${(err as Error).message}`.slice(0, 120);
  }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'WGO-Webhook/1', ...headers }, body, signal: AbortSignal.timeout(8000), redirect: 'manual' });
    const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 80);
    return res.ok ? String(res.status) : `${res.status}${text ? ' ' + text : ''}`;
  } catch (err) {
    return (err as Error).name === 'TimeoutError' ? 'timeout' : `error: ${(err as Error).message}`.slice(0, 120);
  }
}

const postSlack = (target: Target, message: object): Promise<string> =>
  'token' in target ? postToSlack(target, message) : post(target, JSON.stringify(message));

/**
 * Send a notification. Slack channels, and webhook URLs on hooks.slack.com, get a Slack message (the trigger's own
 * design when it has one); other webhooks the documented JSON payload, signed with the target's secret. When Slack
 * rejects a trigger's design, the default message is sent instead and the status says so. Returns the delivery status.
 */
export async function postNotification(target: Target, payload: TriggerWebhookPayload, triggerId?: string, template?: SlackTemplate | null): Promise<string> {
  if ('token' in target || isSlack(target)) {
    if (!template) return postSlack(target, slackMessage(payload));
    const status = await postSlack(target, slackMessage(payload, template));
    const why = rejectedDesign(status);
    if (!why) return status;
    const fallback = await postSlack(target, slackMessage(payload));
    return /^2\d\d$/.test(fallback) ? `${fallback} (custom message rejected: ${why})`.slice(0, 200) : fallback;
  }
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {};
  if (target.secret) headers['x-wgo-signature'] = sign(target.secret, body);
  if (triggerId) headers['x-wgo-trigger'] = triggerId;
  if (target.id) headers['x-wgo-destination'] = target.id;
  return post(target, body, headers);
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

/** The payload of a destination's "Send test": one example click, marked as a test. */
export function samplePayload(pid: string, projectName: string | null): TriggerWebhookPayload {
  return {
    trigger: { id: 'test', name: 'Test notification' }, project: { id: pid, name: projectName ?? '' }, firedAt: new Date().toISOString(),
    scope: 'events', matches: 1, events: [sampleEvent()], url: '', test: true,
  };
}

/**
 * "Send test": a sample notification right now, bypassing the cooldown and leaving the counters alone. `body` may
 * carry a Slack message design to try before saving it (the designer's "Send test").
 */
export async function testTrigger(pid: string, id: string, body?: { slackTemplate?: unknown }): Promise<TriggerTestResult> {
  const t = await getTrigger(pid, id);
  const draft = body?.slackTemplate !== undefined ? validateSlackTemplate(body.slackTemplate) : t.slack_template;
  const scope = scopeOf(t);
  let payload = await payloadFor(t, sampleRows(scope), 1, true);
  if (kindOf(t) !== 'match') payload = { ...payload, ...sampleAggregate({ kind: kindOf(t), scope, metric: t.metric, condition: t.condition, windowMinutes: t.window_minutes }) };
  const status = await send({ ...t, slack_template: draft }, payload);
  await query('UPDATE triggers SET last_status = $3 WHERE project_id = $1 AND id = $2', [pid, id, `test: ${status}`]);
  return { ok: /^2\d\d$/.test(status), status };
}
