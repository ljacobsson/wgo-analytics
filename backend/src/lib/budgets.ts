import { randomBytes, randomUUID } from 'node:crypto';
import type { Budget, BudgetDestination, BudgetInput, BudgetStatus, CostsResponse } from '../contract';
import { eventsThisMonth, getCosts } from './costs';
import { query } from './db';
import { HttpError } from './http';
import * as P from './projects';
import { assertPublicHttpsUrl, sign } from './triggers';

/**
 * Monthly cost budgets for the whole install or one project. Spend comes from Cost Explorer (lib/costs.ts, cached
 * for hours and up to a day behind AWS); a project's spend is the install's spend times the project's share of this
 * month's events. Each budget alerts at its thresholds and on the forecast once a month, and can pause collection:
 * ingest then drops the project's (or every project's) data until the month ends, the limit is raised or someone
 * resumes it. Pausing can't stop every charge: requests still reach API Gateway and stored data still costs.
 */

const MAX_BUDGETS = 50;

interface Row {
  id: string; scope: 'install' | 'project'; project_id: string | null; monthly_limit: number; alert_at: number[]; alert_on_forecast: boolean;
  pause_at_limit: boolean; destination: BudgetDestination | null; signing_secret: string; state: BudgetStatus | null;
  created_by: string; created_at: Date;
}

export const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);

const freshState = (now: number): BudgetStatus => ({
  month: monthOf(now), spent: null, forecast: null, estimated: false, alerted: [], forecastAlerted: false,
  paused: false, pausedAt: null, resumed: false, checkedAt: null, lastStatus: null,
});

async function toBudget(r: Row, names: Map<string, string>): Promise<Budget> {
  return {
    id: r.id, scope: r.scope, projectId: r.project_id, projectName: r.project_id ? names.get(r.project_id) ?? null : null,
    monthlyLimit: r.monthly_limit, alertAt: r.alert_at, alertOnForecast: r.alert_on_forecast, pauseAtLimit: r.pause_at_limit,
    destination: r.destination, signingSecret: r.signing_secret, createdBy: r.created_by, createdAt: r.created_at.toISOString(),
    status: r.state ?? freshState(Date.now()),
  };
}

// ---------------------------------------------------------------- access

/** Owners only: install budgets need you to own a project, project budgets that project. */
async function access(email: string) {
  const projects = await P.listProjects(email);
  const owned = projects.filter((p) => p.role === 'owner');
  if (!owned.length) throw new HttpError(403, 'Only project owners can manage budgets');
  return { owned: new Set(owned.map((p) => p.id)), names: new Map(projects.map((p) => [p.id, p.name])) };
}

async function getRow(id: string): Promise<Row> {
  const [r] = await query<Row>('SELECT * FROM budgets WHERE id = $1', [id]);
  if (!r) throw new HttpError(404, 'Budget not found');
  return r;
}

async function editable(email: string, id: string) {
  const a = await access(email);
  const r = await getRow(id);
  if (r.scope === 'project' && !a.owned.has(r.project_id!)) throw new HttpError(404, 'Budget not found');
  return { a, r };
}

// ---------------------------------------------------------------- validation

async function validDestination(owned: Set<string>, d: unknown): Promise<BudgetDestination | null> {
  if (d === null || d === undefined) return null;
  const x = d as Partial<BudgetDestination>;
  if (x.type === 'webhook' && typeof x.url === 'string') {
    assertPublicHttpsUrl(x.url);
    return { type: 'webhook', url: x.url };
  }
  if (x.type === 'slack' && typeof x.projectId === 'string' && typeof x.integrationId === 'string') {
    if (!owned.has(x.projectId)) throw new HttpError(400, 'Pick a Slack channel of a project you own');
    const rows = await query('SELECT 1 FROM integrations WHERE project_id = $1 AND id = $2 AND type = $3', [x.projectId, x.integrationId, 'slack']);
    if (!rows.length) throw new HttpError(400, 'That Slack channel is not connected');
    return { type: 'slack', projectId: x.projectId, integrationId: x.integrationId };
  }
  throw new HttpError(400, 'destination must be null, { type: "webhook", url } or { type: "slack", projectId, integrationId }');
}

function validLimit(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) throw new HttpError(400, 'monthlyLimit must be a positive amount');
  return Math.round(n * 100) / 100;
}

function validAlertAt(v: unknown): number[] {
  if (!Array.isArray(v) || v.length > 10) throw new HttpError(400, 'alertAt must be a list of up to 10 percentages');
  const list = [...new Set(v.map(Number))].sort((a, b) => a - b);
  if (list.some((n) => !Number.isInteger(n) || n < 1 || n > 1000)) throw new HttpError(400, 'alertAt percentages must be whole numbers from 1 to 1000');
  return list;
}

// ---------------------------------------------------------------- CRUD

export async function listBudgets(email: string): Promise<Budget[]> {
  const a = await access(email);
  const rows = await query<Row>('SELECT * FROM budgets ORDER BY created_at');
  const mine = rows.filter((r) => r.scope === 'install' || a.owned.has(r.project_id!));
  return Promise.all(mine.map((r) => toBudget(r, a.names)));
}

export async function createBudget(email: string, body: Partial<BudgetInput>): Promise<Budget> {
  const a = await access(email);
  if (body.acknowledged !== true) throw new HttpError(400, 'Confirm that cost figures are estimates and that the AWS bill is yours');
  const scope = body.scope === 'project' ? 'project' : body.scope === 'install' ? 'install' : null;
  if (!scope) throw new HttpError(400, 'scope must be install or project');
  const pid = scope === 'project' ? String(body.projectId ?? '') : null;
  if (scope === 'project' && !a.owned.has(pid!)) throw new HttpError(403, 'Only the project’s owners can set its budget');
  const [{ n }] = await query<{ n: number }>('SELECT count(*)::int AS n FROM budgets');
  if (n >= MAX_BUDGETS) throw new HttpError(400, `At most ${MAX_BUDGETS} budgets`);
  const id = randomUUID();
  await query(
    `INSERT INTO budgets (id, scope, project_id, monthly_limit, alert_at, alert_on_forecast, pause_at_limit, destination, signing_secret, state, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10::jsonb, $11)`,
    [id, scope, pid, validLimit(body.monthlyLimit), JSON.stringify(validAlertAt(body.alertAt ?? [50, 80, 100])), body.alertOnForecast === true,
      body.pauseAtLimit === true, JSON.stringify(await validDestination(a.owned, body.destination)), 'whsec_' + randomBytes(24).toString('base64url'),
      JSON.stringify(freshState(Date.now())), email],
  );
  await checkBudgets({ ids: [id] });
  return toBudget(await getRow(id), a.names);
}

export async function updateBudget(email: string, id: string, body: Partial<BudgetInput>): Promise<Budget> {
  const { a, r } = await editable(email, id);
  await query(
    `UPDATE budgets SET monthly_limit = $2, alert_at = $3::jsonb, alert_on_forecast = $4, pause_at_limit = $5, destination = $6::jsonb WHERE id = $1`,
    [id, body.monthlyLimit !== undefined ? validLimit(body.monthlyLimit) : r.monthly_limit,
      JSON.stringify(body.alertAt !== undefined ? validAlertAt(body.alertAt) : r.alert_at),
      body.alertOnForecast !== undefined ? body.alertOnForecast === true : r.alert_on_forecast,
      body.pauseAtLimit !== undefined ? body.pauseAtLimit === true : r.pause_at_limit,
      JSON.stringify(body.destination !== undefined ? await validDestination(a.owned, body.destination) : r.destination)],
  );
  await checkBudgets({ ids: [id] }); // a higher limit or no pause unpauses at once
  return toBudget(await getRow(id), a.names);
}

export async function deleteBudget(email: string, id: string): Promise<void> {
  await editable(email, id);
  await query('DELETE FROM budgets WHERE id = $1', [id]);
  pausedCache.clear();
}

/** Collect data again for the rest of the month, whatever the spend. */
export async function resumeBudget(email: string, id: string): Promise<Budget> {
  const { a, r } = await editable(email, id);
  const state = { ...(r.state ?? freshState(Date.now())), paused: false, pausedAt: null, resumed: true };
  await query('UPDATE budgets SET state = $2::jsonb WHERE id = $1', [id, JSON.stringify(state)]);
  pausedCache.clear();
  await notify(r, state, 'resumed', null);
  return toBudget(await getRow(id), a.names);
}

// ---------------------------------------------------------------- pausing (ingest path)

const pausedCache = new Map<string, { paused: boolean; exp: number }>();
const PAUSED_MS = 60_000;

/** Whether a budget stopped collection for this project (or the whole install). Cached a minute per container. */
export async function collectionPaused(pid: string): Promise<boolean> {
  const hit = pausedCache.get(pid);
  if (hit && hit.exp > Date.now()) return hit.paused;
  let paused = false;
  try {
    const rows = await query(
      `SELECT 1 FROM budgets WHERE (scope = 'install' OR project_id = $1) AND state->>'paused' = 'true' LIMIT 1`, [pid]);
    paused = rows.length > 0;
  } catch (err) {
    console.warn('checking budget pauses failed', err); // never block ingest on this
  }
  pausedCache.set(pid, { paused, exp: Date.now() + PAUSED_MS });
  if (pausedCache.size > 2000) pausedCache.delete(pausedCache.keys().next().value!);
  return paused;
}

// ---------------------------------------------------------------- evaluation

type Event = 'threshold' | 'forecast' | 'paused' | 'resumed';

/** The next state of a budget given this month's spend, and what to notify about. Pure. */
export function nextState(r: Pick<Row, 'monthly_limit' | 'alert_at' | 'alert_on_forecast' | 'pause_at_limit' | 'state'>, spent: number | null, forecast: number | null, estimated: boolean, now: number): { state: BudgetStatus; events: Array<{ event: Event; percent: number | null }> } {
  const month = monthOf(now);
  const prev = r.state && r.state.month === month ? r.state : freshState(now); // a new month starts over (and unpauses)
  const state: BudgetStatus = { ...prev, month, spent, forecast, estimated, checkedAt: new Date(now).toISOString() };
  const events: Array<{ event: Event; percent: number | null }> = [];
  if (spent === null) return { state: { ...state, paused: false, pausedAt: null }, events };
  const pct = (spent / r.monthly_limit) * 100;
  const crossed = r.alert_at.filter((p) => pct >= p && !prev.alerted.includes(p));
  if (crossed.length) {
    state.alerted = [...prev.alerted, ...crossed].sort((a, b) => a - b);
    events.push({ event: 'threshold', percent: Math.max(...crossed) });
  }
  if (r.alert_on_forecast && !prev.forecastAlerted && forecast !== null && forecast > r.monthly_limit && pct < 100) {
    state.forecastAlerted = true;
    events.push({ event: 'forecast', percent: null });
  }
  const over = spent >= r.monthly_limit;
  if (r.pause_at_limit && over && !prev.resumed && !prev.paused) {
    state.paused = true;
    state.pausedAt = new Date(now).toISOString();
    events.push({ event: 'paused', percent: null });
  } else if (prev.paused && (!r.pause_at_limit || !over || prev.resumed)) {
    state.paused = false;
    state.pausedAt = null;
    events.push({ event: 'resumed', percent: null });
  }
  return { state, events };
}

/**
 * Checks budgets against this month's spend: every budget from the maintenance job, or `ids` right after one is
 * saved. Returns how many were checked.
 */
export async function checkBudgets(opts: { ids?: string[]; now?: number; costs?: () => Promise<CostsResponse> } = {}): Promise<{ checked: number; notified: number }> {
  const now = opts.now ?? Date.now();
  const rows = opts.ids?.length
    ? await query<Row>('SELECT * FROM budgets WHERE id = ANY($1::uuid[])', [opts.ids])
    : await query<Row>('SELECT * FROM budgets');
  if (!rows.length) return { checked: 0, notified: 0 };
  const costs = await (opts.costs ?? (() => getCosts(undefined, now)))();
  const total = costs.setup ? 0 : await eventsThisMonth(now);
  let notified = 0;
  for (const r of rows) {
    let spent: number | null = null, forecast: number | null = null;
    if (!costs.setup) {
      const share = r.scope === 'install' ? 1 : total ? Math.min(1, (await eventsThisMonth(now, r.project_id!)) / total) : 0;
      spent = Math.round(costs.monthToDate * share * 100) / 100;
      forecast = costs.forecast !== undefined ? Math.round(costs.forecast * share * 100) / 100 : null;
    }
    const { state, events } = nextState(r, spent, forecast, r.scope === 'project', now);
    await query('UPDATE budgets SET state = $2::jsonb WHERE id = $1', [r.id, JSON.stringify(state)]);
    for (const e of events) {
      state.lastStatus = await notify(r, state, e.event, e.percent);
      notified++;
    }
    if (events.length) await query('UPDATE budgets SET state = $2::jsonb WHERE id = $1', [r.id, JSON.stringify(state)]);
  }
  pausedCache.clear();
  return { checked: rows.length, notified };
}

// ---------------------------------------------------------------- notifications

const money = (n: number | null) => (n === null ? '?' : `$${n.toFixed(2)}`);

export function budgetMessage(r: Pick<Row, 'scope' | 'monthly_limit'>, name: string, s: BudgetStatus, event: Event, percent: number | null): string {
  const what = r.scope === 'install' ? 'The WGO install' : `Project ${name}`;
  const est = s.estimated ? ' (estimated from its share of events)' : '';
  switch (event) {
    case 'threshold': return `${what} has spent ${money(s.spent)}${est} this month: ${percent}% of its ${money(r.monthly_limit)} budget.`;
    case 'forecast': return `${what} is on track to spend ${money(s.forecast)}${est} this month, over its ${money(r.monthly_limit)} budget (${money(s.spent)} so far).`;
    case 'paused': return `${what} reached its ${money(r.monthly_limit)} budget (${money(s.spent)}${est}). WGO has stopped storing new data for ${r.scope === 'install' ? 'every project' : 'it'} until next month. Raise the limit or resume on the Costs page to collect again.`;
    case 'resumed': return `${what} is collecting data again (budget ${money(r.monthly_limit)}, ${money(s.spent)} spent this month).`;
  }
}

async function notify(r: Row, s: BudgetStatus, event: Event, percent: number | null): Promise<string> {
  const name = r.project_id ? (await query<{ name: string }>('SELECT name FROM projects WHERE id = $1', [r.project_id]))[0]?.name ?? '' : '';
  const text = budgetMessage(r, name, s, event, percent);
  console.log(JSON.stringify({ msg: 'budget', budget: r.id, event, text }));
  const d = r.destination;
  if (!d) return 'shown in WGO';
  let url: string, body: string;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'WGO-Webhook/1' };
  if (d.type === 'slack') {
    const [row] = await query<{ config: { webhookUrl: string } }>('SELECT config FROM integrations WHERE project_id = $1 AND id = $2', [d.projectId, d.integrationId]);
    if (!row) return 'slack: channel disconnected';
    url = row.config.webhookUrl;
    body = JSON.stringify({ text: `💰 ${text}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `💰 ${text}` } }] });
  } else {
    url = assertPublicHttpsUrl(d.url).toString();
    body = JSON.stringify({ budget: { id: r.id, scope: r.scope, projectId: r.project_id, projectName: name || null, monthlyLimit: r.monthly_limit }, event, percent, status: s, text, sentAt: new Date().toISOString() });
    headers['x-wgo-signature'] = sign(r.signing_secret, body);
  }
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000), redirect: 'manual' });
    return res.ok ? String(res.status) : `${res.status}`;
  } catch (err) {
    return (err as Error).name === 'TimeoutError' ? 'timeout' : `error: ${(err as Error).message}`.slice(0, 120);
  }
}
