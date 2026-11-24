import type { Destination, DestinationInput, DestinationLevel, RecordingSettings, TriggerDestination } from '../api/contract';
import type { ClickAlias, ClickAliasInput, Device, Goal, GoalInput, Kiosk, KioskConfig, KioskState, Member, Project, SavedView, SavedViewInput, SlackIntegration, Trigger, TriggerInput, UptimeCheckInput } from '../api/contract';
import * as D from './data';
import { funnel } from './funnel';
import { hex } from './rng';
import * as F from './filters';
import * as REC from './recordings';
import * as REL from './releases';
import { covers } from '../pages/ErrorSuppressions';
import type { Budget, BudgetInput, ErrorSuppression, ErrorSuppressionInput } from '../api/contract';
import * as EX from './explain';
import { retention as mockRetention } from './retention';

interface Db { budgets?: Budget[]; suppressions?: Record<string, ErrorSuppression[]>; projects: Project[]; members: Record<string, Member[]>; devices?: Device[]; triggers?: Record<string, Trigger[]>; integrations?: Record<string, SlackIntegration[]>; slackApps?: Record<string, string>; kiosks?: Record<string, Kiosk[]>; views?: Record<string, SavedView[]>; goals?: Record<string, Goal[]>; clickAliases?: Record<string, ClickAlias[]>; recordingSettings?: Record<string, RecordingSettings>; uploadKeys?: Record<string, string> }
import * as UP from './uptime';
import * as QY from './query';
import type { Dashboard, DashboardInput, DashboardSummary, DashboardTile } from '../api/contract';
import { mockSite, mockSiteImage } from './site';

interface Db { budgets?: Budget[]; suppressions?: Record<string, ErrorSuppression[]>; projects: Project[]; members: Record<string, Member[]>; devices?: Device[]; triggers?: Record<string, Trigger[]>; integrations?: Record<string, SlackIntegration[]>; slackApps?: Record<string, string>; kiosks?: Record<string, Kiosk[]>; views?: Record<string, SavedView[]>; goals?: Record<string, Goal[]>; clickAliases?: Record<string, ClickAlias[]>; uptime?: Record<string, UP.MockCheck[]>; recordingSettings?: Record<string, RecordingSettings>; destinations?: MockDestination[]; accountSlackApps?: Record<string, string> }
/** A saved destination: a project's (projectId) or an account's (owner). Slack channels note their workspace. */
type MockDestination = Destination & { projectId: string | null; workspaceId?: string };
/** A connected Slack workspace: a project's (projectId) or someone's own (owner). */
interface MockWorkspace { id: string; projectId: string | null; owner: string | null; teamName: string; createdBy: string; createdAt: string }
interface Db { slackWorkspaces?: MockWorkspace[] }
interface Db { dashboards?: Record<string, Dashboard[]> }
const MOCK_CHANNELS = [
  { id: 'C01ALERTS', name: '#alerts', private: false }, { id: 'C02CHECK', name: '#checkout', private: false }, { id: 'C03GROW', name: '#growth', private: false },
  { id: 'G04ONCALL', name: '#oncall', private: true }, { id: 'C05RANDOM', name: '#random', private: false },
];
const KEY = 'wgo.mock.db';
const newKey = () => 'ak_' + hex(28, Date.now(), Math.floor(Math.random() * 1e9));

function load(email: string): Db {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Db | null;
    if (d) { for (const p of d.projects) p.retention ??= { ...RETENTION }; return d; }
  } catch { /* fall through */ }
  const empty = new URLSearchParams(location.search).has('mock_empty');
  const db: Db = { projects: empty ? [] : [{ id: 'prj_demo', name: 'Acme Storefront', writeKey: 'ak_live_9f2c41d07be3a6584c10e7', role: 'owner', createdAt: new Date(Date.now() - 40 * 86400e3).toISOString(), retention: { ...RETENTION } }], members: {} };
  if (!empty) db.members.prj_demo = [{ email, role: 'owner', createdAt: db.projects[0].createdAt }, { email: 'sam@acme.dev', role: 'member', createdAt: new Date(Date.now() - 9 * 86400e3).toISOString() }];
  return db;
}
const RETENTION = { days: 90, defaultDays: 90, maxDays: 400 };
const save = (db: Db) => localStorage.setItem(KEY, JSON.stringify(db));

export class MockHttpError extends Error { constructor(public status: number, m: string) { super(m); } }

/** What a trigger in `pid` can pick, as the API lists it: the project's Slack channels and webhooks, then the user's own. */
function projectDestinations(db: Db, pid: string, email: string): Destination[] {
  const channels: Destination[] = (db.integrations?.[pid] ?? []).map((i) => ({
    id: i.id, level: 'project', type: 'slack', name: i.channel, detail: i.teamName, owner: null, editable: true, ref: { type: 'slack', integrationId: i.id }, createdBy: i.createdBy, createdAt: i.createdAt,
  }));
  const saved = db.destinations ?? [];
  return [...channels, ...saved.filter((d) => d.projectId === pid)].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .concat(saved.filter((d) => !d.projectId && d.owner === email));
}
const labelOf = (db: Db, d: TriggerDestination): Trigger['destinationLabel'] => {
  if (d.type !== 'saved') return null;
  const x = db.destinations?.find((y) => y.id === d.destinationId);
  return x ? { name: x.name, detail: x.detail, owner: x.owner, type: x.type } : null;
};
/** Saved destinations: `projectId` null for the user's own. */
function destinationsApi(db: Db, projectId: string | null, email: string, method: string, id: string | undefined, action: string | undefined, body: unknown): unknown {
  const list = (db.destinations ??= []);
  const mine = (d: MockDestination) => (projectId ? d.projectId === projectId : !d.projectId && d.owner === email);
  if (!id && method === 'GET') return projectId ? projectDestinations(db, projectId, email) : list.filter(mine);
  const input = (body ?? {}) as Partial<DestinationInput>;
  if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 120)) throw new MockHttpError(400, 'Destination name must be 1-120 characters');
  if (input.url !== undefined && !/^https:\/\/[^/]+\.[^/]+/i.test(input.url)) throw new MockHttpError(400, 'Webhook URL must use https');
  if (!id && method === 'POST') {
    const did = crypto.randomUUID();
    const url = String(input.url);
    const d: MockDestination = {
      id: did, projectId, level: projectId ? 'project' : 'account', type: 'webhook', name: String(input.name).trim(), detail: new URL(url).host, url, signingSecret: 'whsec_' + hex(24, Date.now(), 11),
      owner: projectId ? null : email, editable: true, ref: { type: 'saved', destinationId: did }, createdBy: email, createdAt: new Date().toISOString(),
    };
    list.push(d); save(db); return d;
  }
  if (projectId && method === 'DELETE' && db.integrations?.[projectId]?.some((i) => i.id === id)) {
    db.integrations[projectId] = db.integrations[projectId].filter((i) => i.id !== id); save(db); return { ok: true };
  }
  if (projectId && action === 'test' && db.integrations?.[projectId]?.some((i) => i.id === id)) return { ok: true, status: '200' };
  const d = list.find((x) => x.id === id && mine(x));
  if (!d) throw new MockHttpError(404, 'Destination not found');
  if (action === 'test') return { ok: true, status: '200' };
  if (method === 'PATCH') {
    if (input.name !== undefined) d.name = input.name.trim();
    if (input.url !== undefined) { d.url = input.url; d.detail = new URL(input.url).host; }
    save(db); return d;
  }
  if (method === 'DELETE') {
    const used = Object.values(db.triggers ?? {}).flat().filter((t) => t.destination.type === 'saved' && t.destination.destinationId === id);
    if (used.length) throw new MockHttpError(409, `Still used by trigger${used.length > 1 ? 's' : ''}: ${used.map((t) => t.name).join(', ')}`);
    db.destinations = list.filter((x) => x !== d); save(db); return { ok: true };
  }
  return d;
}

export function handleApi(method: string, url: URL, body: unknown, email: string): unknown {
  const db = load(email);
  const parts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  const qp = (k: string) => url.searchParams.get(k) ?? undefined;
  const now = Date.now();
  const from = Date.parse(qp('from') ?? '') || now - 86400e3, to = Date.parse(qp('to') ?? '') || now;
  const limit = Number(qp('limit') ?? 100);

  // ?mock_nonadmin: sign in as someone who isn't an admin (no Costs page)
  if (parts[0] === 'me') return { email, projects: db.projects, admin: !new URLSearchParams(location.search).has('mock_nonadmin') };
  if (parts[0] === 'destinations') return destinationsApi(db, null, email, method, parts[1], parts[2], body);
  if (parts[0] === 'devices') {
    const list = (db.devices ??= []);
    if (method === 'POST') {
      const device: Device = { id: crypto.randomUUID(), name: String((body as { name?: string })?.name || 'Android device'), createdAt: new Date().toISOString(), lastUsedAt: null };
      list.unshift(device); save(db);
      return { device, token: 'dt_' + hex(40, Date.now(), Math.floor(Math.random() * 1e9)).slice(0, 40) };
    }
    if (method === 'DELETE') { db.devices = list.filter((d) => d.id !== parts[1]); save(db); return { ok: true }; }
    return list;
  }
  if (parts[0] === 'costs' && parts[1] === 'budgets') {
    const list = (db.budgets ??= []);
    const [, , id, action] = parts;
    const b = list.find((x) => x.id === id);
    const month = new Date().toISOString().slice(0, 7);
    if (!id && method === 'POST') {
      const i = body as BudgetInput;
      if (!i.acknowledged) throw new MockHttpError(400, 'Confirm that cost figures are estimates and that the AWS bill is yours');
      // the same figures the mock Costs page shows: a project gets its share of the events
      const c = UP.mockCosts(i.projectId ?? '', Date.now(), false);
      const share = i.scope === 'install' || !c.usage.eventsThisMonth ? 1 : (c.usage.projectEventsThisMonth ?? 0) / c.usage.eventsThisMonth;
      const spent = Math.round(c.monthToDate * share * 100) / 100;
      const pct = (spent / i.monthlyLimit) * 100;
      const paused = i.pauseAtLimit && pct >= 100;
      const nb: Budget = {
        id: 'bud_' + hex(10, Date.now()), scope: i.scope, projectId: i.projectId ?? null, projectName: db.projects.find((p) => p.id === i.projectId)?.name ?? null,
        monthlyLimit: i.monthlyLimit, alertAt: i.alertAt, alertOnForecast: i.alertOnForecast, pauseAtLimit: i.pauseAtLimit, destination: i.destination,
        signingSecret: 'whsec_' + hex(24, Date.now(), 3), createdBy: email, createdAt: new Date().toISOString(),
        status: { month, spent, forecast: c.forecast != null ? Math.round(c.forecast * share * 100) / 100 : null, estimated: i.scope === 'project', alerted: i.alertAt.filter((p) => pct >= p), forecastAlerted: i.alertOnForecast && (c.forecast ?? 0) * share > i.monthlyLimit && pct < 100,
          paused, pausedAt: paused ? new Date().toISOString() : null, resumed: false, checkedAt: new Date().toISOString(), lastStatus: 'shown in WGO' },
      };
      list.push(nb); save(db); return nb;
    }
    if (b && action === 'resume') { b.status = { ...b.status, paused: false, pausedAt: null, resumed: true }; save(db); return b; }
    if (b && method === 'PATCH') { Object.assign(b, body as object); if (b.status.paused && (b.status.spent ?? 0) < b.monthlyLimit) b.status = { ...b.status, paused: false, pausedAt: null }; save(db); return b; }
    if (b && method === 'DELETE') { db.budgets = list.filter((x) => x.id !== id); save(db); return { ok: true }; }
    return list;
  }
  if (parts[0] === 'costs') {
    const own = db.projects.some((p) => p.role === 'owner');
    if (!own) throw new MockHttpError(403, 'Only project owners can see what the install costs');
    return UP.mockCosts(qp('pid') ?? '', now, new URLSearchParams(location.search).has('mock_costs_setup'));
  }
  if (parts[0] !== 'projects') throw new MockHttpError(404, 'Not found');
  if (parts.length === 1 && method === 'POST') {
    const p: Project = { id: 'prj_' + hex(8, Date.now()), name: String((body as { name: string }).name), writeKey: newKey(), role: 'owner', createdAt: new Date().toISOString(), retention: { ...RETENTION } };
    db.projects.push(p); db.members[p.id] = [{ email, role: 'owner', createdAt: p.createdAt }]; save(db); return p;
  }
  const pid = parts[1];
  const project = db.projects.find((p) => p.id === pid);
  if (!project) throw new MockHttpError(404, 'Project not found');
  const sub = parts[2];
  if (!sub) {
    if (method === 'DELETE') {
      if (project.role !== 'owner') throw new MockHttpError(403, 'Only project owners can do that');
      db.projects = db.projects.filter((p) => p.id !== pid);
      for (const m of [db.members, db.triggers, db.integrations, db.slackApps, db.kiosks, db.views, db.goals, db.clickAliases, db.recordingSettings]) if (m) delete m[pid];
      save(db);
      return { ok: true };
    }
    if (method === 'PATCH') {
      const b = body as { name?: string; retentionDays?: number };
      if (b.name !== undefined) project.name = String(b.name);
      if (b.retentionDays !== undefined) {
        if (!Number.isInteger(b.retentionDays) || b.retentionDays < 1 || b.retentionDays > project.retention.maxDays) throw new MockHttpError(400, `Retention must be a whole number of days between 1 and ${project.retention.maxDays}`);
        project.retention = { ...project.retention, days: b.retentionDays };
      }
      save(db);
    }
    return project;
  }
  switch (sub) {
    case 'rotate-key': project.writeKey = newKey(); save(db); return project;
    case 'upload-key': case 'rotate-upload-key': {
      if (project.role !== 'owner') throw new MockHttpError(403, 'Only project owners can do that');
      if (sub === 'rotate-upload-key' || !db.uploadKeys?.[pid]) { (db.uploadKeys ??= {})[pid] = 'uk_' + hex(40, Date.now(), Math.floor(Math.random() * 1e9)); save(db); }
      return { uploadKey: db.uploadKeys![pid] };
    }
    case 'kiosks': {
      const list = ((db.kiosks ??= {})[pid] ??= []);
      const [, , , id, action] = parts;
      const input = (body ?? {}) as { name?: string; config?: Partial<KioskConfig>; reload?: boolean };
      const stamp = new Date().toISOString();
      if (!id && method === 'POST') {
        const k: Kiosk = {
          id: crypto.randomUUID(), name: input.name || 'Office TV', token: newKioskToken(),
          config: { screens: [{ page: 'overview', params: 'range=24h' }], rotateSeconds: 60, refreshSeconds: 60, theme: 'dark', zoom: 1, ...input.config },
          reloadAt: null, createdBy: email, createdAt: stamp, updatedAt: stamp, lastSeenAt: null, display: null,
        };
        list.push(k); save(db); return k;
      }
      const k = list.find((x) => x.id === id);
      if (id && !k) throw new MockHttpError(404, 'Kiosk not found');
      if (k && action === 'rotate') { k.token = newKioskToken(); k.updatedAt = stamp; save(db); return k; }
      if (k && method === 'PATCH') {
        if (input.name) k.name = input.name;
        if (input.config) k.config = { ...k.config, ...input.config };
        if (input.reload) k.reloadAt = stamp;
        k.updatedAt = stamp; save(db); return k;
      }
      if (k && method === 'DELETE') { db.kiosks![pid] = list.filter((x) => x.id !== id); save(db); return { ok: true }; }
      return list;
    }
    case 'views': {
      const list = ((db.views ??= {})[pid] ??= []);
      const id = parts[3];
      const input = (body ?? {}) as Partial<SavedViewInput>;
      const clean = (p: string) => { const u = new URLSearchParams(p.replace(/^\?/, '')); for (const k of ['range', 'from', 'to', 'new', 'pf', 'scope', 'slack', 'slack_level']) u.delete(k); return u.toString(); };
      if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 120)) throw new MockHttpError(400, 'View name must be 1-120 characters');
      if (!id && method === 'POST') {
        const v: SavedView = { id: crypto.randomUUID(), name: input.name!.trim(), page: input.page ?? 'events', params: clean(input.params ?? ''), createdBy: email, createdAt: new Date().toISOString() };
        list.unshift(v); save(db); return v;
      }
      const v = list.find((x) => x.id === id);
      if (id && !v) throw new MockHttpError(404, 'View not found');
      if (v && method === 'PATCH') { if (input.name) v.name = input.name.trim(); if (input.page) v.page = input.page; if (input.params !== undefined) v.params = clean(input.params); save(db); return v; }
      if (v && method === 'DELETE') { db.views![pid] = list.filter((x) => x.id !== id); save(db); return { ok: true }; }
      return list;
    }
    case 'goals': {
      const list = ((db.goals ??= {})[pid] ??= []);
      const [, , , id, action] = parts;
      const input = (body ?? {}) as Partial<GoalInput>;
      if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 120)) throw new MockHttpError(400, 'Goal name must be 1-120 characters');
      if (input.filters !== undefined && !input.filters.length) throw new MockHttpError(400, 'A goal needs at least one filter');
      if (input.steps !== undefined) {
        if (input.steps.length > 6) throw new MockHttpError(400, 'A goal can have at most 6 funnel steps');
        input.steps.forEach((st, i) => {
          if (!st.name?.trim() || st.name.trim().length > 80) throw new MockHttpError(400, `Step ${i + 1} needs a name of 1-80 characters`);
          if (!st.filters?.length) throw new MockHttpError(400, `Step ${i + 1} needs at least one filter`);
        });
        input.steps = input.steps.map((st) => ({ name: st.name.trim(), filters: st.filters }));
      }
      if (!id && method === 'POST') {
        if (input.name === undefined || !input.filters) throw new MockHttpError(400, 'A goal needs a name and at least one filter');
        const g: Goal = { id: crypto.randomUUID(), name: input.name.trim(), filters: input.filters, steps: input.steps ?? [], createdBy: email, createdAt: new Date().toISOString() };
        list.push(g); save(db); return g;
      }
      const g = list.find((x) => x.id === id);
      if (id && !g) throw new MockHttpError(404, 'Goal not found');
      if (g && action === 'funnel') {
        const raw = qp('steps');
        return funnel(from, to, g, raw === undefined ? null : JSON.parse(raw), F.parse(qp('filters')));
      }
      if (g && method === 'PATCH') { if (input.name) g.name = input.name.trim(); if (input.filters) g.filters = input.filters; if (input.steps) g.steps = input.steps; save(db); return g; }
      if (g && method === 'DELETE') { db.goals![pid] = list.filter((x) => x.id !== id); save(db); return { ok: true }; }
      return list;
    }
    case 'site': return parts[3] === 'image' ? mockSiteImage() : mockSite(pid);
    case 'collection': {
      const scoped = (db.budgets ?? []).filter((b) => b.scope === 'install' || b.projectId === pid);
      return { paused: scoped.some((b) => b.status.paused) };
    }
    case 'error-suppressions': {
      const list = ((db.suppressions ??= {})[pid] ??= []);
      const id = parts[3];
      if (!id && method === 'POST') {
        const b = (body ?? {}) as ErrorSuppressionInput;
        const r: ErrorSuppression = { id: 'sup_' + hex(10, Date.now()), kind: b.kind ?? null, message: b.message ?? null, source: b.source ?? null, page: b.page ?? null, createdBy: email, createdAt: new Date().toISOString(), hits: 0, lastHitAt: null };
        list.push(r); save(db); return r;
      }
      if (id && method === 'DELETE') { db.suppressions![pid] = list.filter((x) => x.id !== id); save(db); return { ok: true }; }
      return list;
    }
    case 'conversions': return D.conversions(from, to, db.goals?.[pid] ?? [], F.parse(qp('filters')), qp('series') !== '0');
    case 'retention': return mockRetention(url.searchParams, now, db.goals?.[pid] ?? []);
    case 'triggers': {
      const list = ((db.triggers ??= {})[pid] ??= []);
      const [, , , id, action] = parts;
      const input = (body ?? {}) as Partial<TriggerInput>;
      if (!id && method === 'POST') {
        const t: Trigger = {
          id: 'trg_' + hex(10, Date.now()), name: input.name ?? 'Trigger', scope: input.scope ?? 'events', filters: input.filters ?? [], destination: input.destination!,
          cooldownSeconds: input.cooldownSeconds ?? 300, enabled: input.enabled ?? true, signingSecret: 'whsec_' + hex(24, Date.now(), 7),
          createdBy: email, createdAt: new Date().toISOString(), lastFiredAt: null, fireCount: 0, lastStatus: null,
          kind: input.kind ?? 'match', metric: input.metric ?? null, condition: input.condition ?? null, windowMinutes: input.windowMinutes ?? null,
          status: input.kind && input.kind !== 'match' ? { state: 'ok', since: new Date().toISOString(), lastValue: 3, lastEvaluatedAt: new Date().toISOString(), baseline: input.kind === 'anomaly' ? { median: 4, low: 0, high: 10, days: 7 } : null } : null,
          destinationLabel: labelOf(db, input.destination!),
        };
        list.push(t); save(db); return t;
      }
      if (id === 'preview' && method === 'POST') {
        const c = input.condition;
        const v = input.metric?.agg === 'session_rate' ? 0.031 : input.metric?.agg === 'count' ? 7 : 840;
        return { value: v, fires: !!c && ('op' in c ? (c.op === 'above' ? v > c.value : v < c.value) : false), baseline: c && 'direction' in c ? { median: 6, low: 1, high: 13, days: 7 } : null,
          window: { from: new Date(now - (input.windowMinutes ?? 15) * 60_000).toISOString(), to: new Date(now).toISOString() } };
      }
      const t = list.find((x) => x.id === id);
      if (id && !t) throw new Error('Trigger not found');
      if (t && action === 'test') { t.lastStatus = 'test: 200'; save(db); return { ok: true, status: '200' }; }
      if (t && method === 'PATCH') { Object.assign(t, input); t.destinationLabel = labelOf(db, t.destination); save(db); return t; }
      if (t && method === 'DELETE') { db.triggers![pid] = list.filter((x) => x.id !== id); save(db); return { ok: true }; }
      return list.map((x) => ({ ...x, destinationLabel: labelOf(db, x.destination) }));
    }
    case 'uptime': {
      if (!db.uptime) db.uptime = {};
      const list = (db.uptime[pid] ??= pid === 'prj_demo' ? UP.seedChecks(now) : []);
      const [, , , id, action] = parts;
      const input = (body ?? {}) as Partial<UptimeCheckInput>;
      const find = () => { const c = list.find((x) => x.id === id); if (!c) throw new MockHttpError(404, 'Check not found'); return c; };
      if (input.url !== undefined && !/^https?:\/\/[^/]+\.[^/]+/i.test(input.url)) throw new MockHttpError(400, 'URL must be a public http or https address');
      if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 120)) throw new MockHttpError(400, 'Name must be 1-120 characters');
      if (!id && method === 'POST') {
        if (list.length >= 20) throw new MockHttpError(400, 'A project can have at most 20 checks');
        const c: UP.MockCheck = {
          method: 'GET', expect: '2xx', keyword: null, intervalSeconds: 300, timeoutMs: 10000, enabled: true, ...input, name: String(input.name).trim(), url: String(input.url),
          id: 'chk_' + hex(10, Date.now()), state: 'up', stateSince: new Date(now).toISOString(), lastCheckedAt: null, failStreak: 0, lastStatus: 200, lastError: null,
          lastDurationMs: 140, createdBy: email, createdAt: new Date(now).toISOString(), strip: [],
        };
        list.push(c); save(db); return UP.present(c, from, to, now);
      }
      if (!id) return list.map((c) => UP.present(c, from, to, now));
      const c = find();
      if (action === 'run') { c.lastCheckedAt = new Date(now).toISOString(); save(db); return { ok: true, status: 200, error: null, durationMs: c.lastDurationMs ?? 150 }; }
      if (action === 'results') return UP.resultsFor(c, from, to, now);
      if (method === 'PATCH') { Object.assign(c, input); save(db); return UP.present(c, from, to, now); }
      if (method === 'DELETE') { db.uptime[pid] = list.filter((x) => x.id !== id); save(db); return { ok: true }; }
      return UP.present(c, from, to, now);
    }
    case 'destinations': return destinationsApi(db, pid, email, method, parts[3], parts[4], body);
    case 'integrations': {
      const list = ((db.integrations ??= {})[pid] ??= []);
      if (method === 'DELETE') { db.integrations![pid] = list.filter((i) => i.id !== parts[3]); save(db); return { ok: true }; }
      return list;
    }
    case 'slack': {
      const apps = (db.slackApps ??= {});
      const own = (db.accountSlackApps ??= {});
      // like the API: the project's app, then the user's own
      const status = () => ({
        configured: !!(apps[pid] ?? own[email]), source: apps[pid] ? 'project' : own[email] ? 'account' : null, clientId: apps[pid] ?? own[email] ?? null,
        accountClientId: own[email] ?? null,
        redirectUrl: 'https://abc123.execute-api.eu-west-1.amazonaws.com/slack/callback', createAppUrl: 'https://api.slack.com/apps?new_app=1',
        workspaces: (db.slackWorkspaces ?? []).filter((w) => w.projectId === pid || (!w.projectId && w.owner === email))
          .sort((a, b) => Number(!a.projectId) - Number(!b.projectId) || a.createdAt.localeCompare(b.createdAt))
          .map((w) => ({
            id: w.id, level: (w.projectId ? 'project' : 'account') as DestinationLevel, teamName: w.teamName, createdBy: w.createdBy, createdAt: w.createdAt,
            channels: [...Object.values(db.integrations ?? {}).flat() as Array<{ workspaceId?: string }>, ...(db.destinations ?? [])].filter((c) => c.workspaceId === w.id).length,
          })),
      });
      if (!parts[3]) return status();
      if (parts[3] === 'app') {
        const level = method === 'DELETE' ? url.searchParams.get('level') : (body as { level?: string } | null)?.level;
        const target = level === 'account' ? own : apps;
        const key = level === 'account' ? email : pid;
        if (method === 'DELETE') { delete target[key]; save(db); return status(); }
        const { clientId = '', clientSecret = '' } = (body ?? {}) as { clientId?: string; clientSecret?: string };
        if (!/^\d+\.\d+$/.test(clientId.trim())) throw new Error('That doesn’t look like a Slack Client ID (digits.digits, under Basic Information)');
        if (!/^[0-9a-f]{32}$/i.test(clientSecret.trim())) throw new Error('That doesn’t look like a Slack Client Secret (32 hex characters; click Show next to it)');
        target[key] = clientId.trim(); save(db); return status();
      }
      const wss = (db.slackWorkspaces ??= []);
      const ints = ((db.integrations ??= {})[pid] ??= []) as Array<SlackIntegration & { workspaceId?: string }>;
      if (parts[3] === 'workspaces') {
        const w = wss.find((x) => x.id === parts[4] && (x.projectId === pid || (!x.projectId && x.owner === email)));
        if (!w) throw new MockHttpError(404, 'Slack workspace not found');
        const used = [...Object.values(db.integrations ?? {}).flat() as Array<SlackIntegration & { workspaceId?: string }>, ...(db.destinations ?? [])]
          .filter((c) => c.workspaceId === w.id).map((c) => ('channel' in c ? c.channel : c.name));
        if (!parts[5] && method === 'DELETE') {
          if (used.length) throw new MockHttpError(409, `Remove its channel${used.length > 1 ? 's' : ''} first: ${used.join(', ')}`);
          db.slackWorkspaces = wss.filter((x) => x !== w); save(db); return status();
        }
        if (method === 'GET') return MOCK_CHANNELS;
        const c = MOCK_CHANNELS.find((x) => x.id === (body as { channelId?: string } | null)?.channelId);
        if (!c) throw new MockHttpError(400, 'WGO can’t see that channel. For a private channel, invite WGO there first (/invite @WGO).');
        const at = new Date().toISOString();
        if (!w.projectId) {
          if ((db.destinations ??= []).some((d) => d.owner === email && !d.projectId && d.name === c.name)) throw new MockHttpError(409, `${c.name} is already one of your destinations`);
          const did = crypto.randomUUID();
          const d: MockDestination = { id: did, projectId: null, level: 'account', type: 'slack', name: c.name, detail: w.teamName, owner: email, editable: true,
            ref: { type: 'saved', destinationId: did }, createdBy: email, createdAt: at, workspaceId: w.id };
          db.destinations.push(d); save(db); return d;
        }
        if (ints.some((i) => i.channel === c.name)) throw new MockHttpError(409, `${c.name} is already a destination of this project`);
        const i = { id: 'int_' + hex(8, Date.now()), type: 'slack' as const, channel: c.name, teamName: w.teamName, createdBy: email, createdAt: at, workspaceId: w.id };
        ints.push(i); save(db);
        return { id: i.id, level: 'project', type: 'slack', name: i.channel, detail: i.teamName, owner: null, editable: true, ref: { type: 'slack', integrationId: i.id }, createdBy: email, createdAt: at };
      }
      if (!apps[pid] && !own[email]) throw new Error('Set up a Slack app first: for this project, or your own for all your projects');
      // mock "Add to Slack": connect the workspace right away and bounce back like Slack would
      const level = url.searchParams.get('level') === 'account' ? 'account' : 'project';
      const mine = (x: MockWorkspace) => (level === 'account' ? !x.projectId && x.owner === email : x.projectId === pid);
      if (!wss.some(mine)) wss.push({ id: crypto.randomUUID(), projectId: level === 'project' ? pid : null, owner: level === 'account' ? email : null, teamName: 'Acme', createdBy: email, createdAt: new Date().toISOString() });
      save(db);
      return { url: `${location.pathname}${location.search}#/p/${pid}/triggers?slack=connected&slack_level=${level}` };
    }
    case 'members': {
      const list = (db.members[pid] ??= []);
      if (method === 'POST') { const m: Member = { email: String((body as { email: string }).email), role: 'member', createdAt: new Date().toISOString() }; list.push(m); save(db); return m; }
      if (method === 'DELETE') { db.members[pid] = list.filter((m) => m.email !== decodeURIComponent(parts[3])); save(db); return { ok: true }; }
      return list;
    }
    case 'stats': { const r = D.stats(from, to); return qp('compare') === '0' ? { ...r, previous: null } : r; }
    case 'totals': return D.totalsFor(from, to);
    case 'hours': return D.hours(from, to, qp('tz') || 'UTC');
    case 'clicks': {
      // like the API: an aliased selector is one row, keeping its text only when every click had the same one
      const names = new Map((db.clickAliases?.[pid] ?? []).map((a) => [a.selector, a.alias]));
      const rows = new Map<string, ReturnType<typeof D.clicks>[number]>();
      for (const r of D.clicks(from, to, 500)) {
        const alias = names.get(r.selector) ?? null;
        const key = alias ? r.selector : JSON.stringify([r.selector, r.elementText, r.trackName]);
        const cur = rows.get(key);
        if (!cur) { rows.set(key, { ...r, alias }); continue; }
        rows.set(key, {
          ...cur, count: cur.count + r.count, sessions: cur.sessions + r.sessions, rageClicks: cur.rageClicks + r.rageClicks,
          elementText: cur.elementText === r.elementText ? cur.elementText : null, trackName: cur.trackName === r.trackName ? cur.trackName : null,
          lastSeen: cur.lastSeen > r.lastSeen ? cur.lastSeen : r.lastSeen,
        });
      }
      return [...rows.values()].sort((a, b) => b.count - a.count).slice(0, limit);
    }
    case 'frustration': {
      const names = new Map((db.clickAliases?.[pid] ?? []).map((a) => [a.selector, a.alias]));
      const recs = REC.listRecordings(from, to, undefined, 12).recordings;
      return D.frustration(from, to, limit).map((r, i) => ({
        ...r, alias: names.get(r.selector) ?? null,
        samples: recs.slice((i * 2) % Math.max(1, recs.length)).slice(0, i % 4 === 3 ? 0 : 1 + (i % 3)).map((x) => ({ sessionId: x.sessionId, at: Date.parse(x.startedAt) + 4000 })),
      }));
    }
    case 'heatmap': return REC.heatmap(qp('path') ?? '/', from, to, qp('device') === 'mobile' ? 'mobile' : 'desktop');
    case 'click-aliases': {
      const list = ((db.clickAliases ??= {})[pid] ??= []);
      if (method === 'POST') {
        const input = (body ?? {}) as Partial<ClickAliasInput>;
        const selector = (input.selector ?? '').trim(), alias = (input.alias ?? '').replace(/\s+/g, ' ').trim();
        if (!selector || selector.length > 512) throw new MockHttpError(400, 'selector must be 1-512 characters');
        if (!alias || alias.length > 80) throw new MockHttpError(400, 'Alias must be 1-80 characters');
        const a: ClickAlias = { selector, alias, updatedBy: email, updatedAt: new Date().toISOString() };
        db.clickAliases![pid] = [...list.filter((x) => x.selector !== selector), a]; save(db); return a;
      }
      if (method === 'DELETE') { db.clickAliases![pid] = list.filter((x) => x.selector !== (qp('selector') ?? '').trim()); save(db); return { ok: true }; }
      return list;
    }
    case 'pages': return D.pages(from, to, limit);
    case 'errors': { const rules = db.suppressions?.[pid] ?? []; return D.errors(from, to, limit).map((g) => ({ ...g, suppressedBy: rules.find((r) => covers(r, g))?.id ?? null })); }
    case 'http-errors': return D.httpErrors(from, to, limit);
    case 'breakdown': return D.breakdown(from, to, qp('dim') ?? 'browser');
    case 'vitals': return D.vitals(from);
    case 'explain': return EX.explain({ metric: (qp('metric') ?? 'events') as never, where: F.parse(qp('where')), goalId: qp('goalId'), label: qp('label'), from, to, goals: db.goals?.[pid] ?? [] });
    case 'releases': return REL.releases(from, to, db.goals?.[pid] ?? [], qp('markers') === '1');
    case 'geo': return D.geo(from, to);
    case 'query': {
      let spec;
      try { spec = JSON.parse(qp('q') ?? ''); } catch { throw new MockHttpError(400, 'q must be JSON'); }
      if (!spec?.measures?.length) throw new MockHttpError(400, 'At least one measure');
      if (spec.shape === 'top' && !spec.groupBy) throw new MockHttpError(400, 'top needs a groupBy field');
      const checks = (db.uptime?.[pid] ?? UP.seedChecks(now)).map((c) => ({ id: c.id, name: c.name }));
      return QY.query(spec, from, to, checks, !!qp('filters'));
    }
    case 'measures': return QY.measureNames();
    case 'dashboards': {
      const list = ((db.dashboards ??= {})[pid] ??= []);
      const [, , , id, action] = parts;
      const d = list.find((x) => x.id === id);
      const at = new Date().toISOString();
      const name = (v: unknown) => {
        const n = typeof v === 'string' ? v.trim() : '';
        if (!n || n.length > 120) throw new MockHttpError(400, 'Dashboard name must be 1-120 characters');
        return n;
      };
      if (!id && method === 'GET') return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((x): DashboardSummary => ({ id: x.id, name: x.name, tiles: x.config.tiles.length, createdBy: x.createdBy, updatedAt: x.updatedAt }));
      if (!id && method === 'POST') {
        const b = (body ?? {}) as Partial<DashboardInput>;
        const n: Dashboard = { id: crypto.randomUUID(), name: name(b.name), config: b.config ?? { tiles: [] }, createdBy: email, createdAt: at, updatedAt: at };
        list.push(n); save(db); return n;
      }
      if (!d) throw new MockHttpError(404, 'Dashboard not found');
      if (!action && method === 'GET') return d;
      if (!action && method === 'PATCH') {
        const b = (body ?? {}) as Partial<DashboardInput>;
        if (b.name !== undefined) d.name = name(b.name);
        if (b.config !== undefined) {
          if (b.config.tiles.length > 40) throw new MockHttpError(400, 'A dashboard can have at most 40 tiles');
          d.config = b.config;
        }
        d.updatedAt = at; save(db); return d;
      }
      if (!action && method === 'DELETE') { db.dashboards![pid] = list.filter((x) => x.id !== id); save(db); return { ok: true }; }
      if (action === 'duplicate' && method === 'POST') {
        const n: Dashboard = { ...structuredClone(d), id: crypto.randomUUID(), name: `${d.name} (copy)`, createdBy: email, createdAt: at, updatedAt: at };
        list.push(n); save(db); return n;
      }
      if (action === 'tiles' && method === 'POST') {
        const t = body as Partial<DashboardTile>;
        const bottom = d.config.tiles.reduce((m, x) => Math.max(m, x.layout.y + x.layout.h), 0);
        d.config.tiles.push({ ...t, id: t.id ?? hex(8, Date.now()), layout: { x: 0, y: bottom, w: t.layout?.w ?? 6, h: t.layout?.h ?? (t.viz === 'number' ? 2 : 4) } } as DashboardTile);
        d.updatedAt = at; save(db); return d;
      }
      throw new MockHttpError(405, 'Method not allowed');
    }
    case 'fields': {
      const fscope = qp('scope') ?? 'events';
      if (fscope === 'metrics' || fscope === 'checks') {
        const builtin = fscope === 'metrics'
          ? [{ field: 'name', type: 'text' }, { field: 'service', type: 'text' }, { field: 'type', type: 'text' }, { field: 'unit', type: 'text' }, { field: 'value', type: 'number' }]
          : [{ field: 'checkId', type: 'text' }, { field: 'ok', type: 'number' }, { field: 'status', type: 'number' }, { field: 'durationMs', type: 'number' }, { field: 'error', type: 'text' }, { field: 'region', type: 'text' }];
        if (parts[3] === 'values') {
          const field = qp('field') ?? '';
          const vals = field === 'service' ? ['api-gateway', 'catalog-service', 'cart-service'] : field === 'region' ? ['eu-north-1', 'us-east-1'] : field === 'attributes.host.name' ? ['ip-10-0-1-12', 'ip-10-0-2-40'] : [];
          return { values: vals.map((value, i) => ({ value, count: 900 - i * 300 })) };
        }
        return { builtin, discovered: fscope === 'metrics' ? [{ field: 'attributes.host.name', type: 'json', count: 4100 }, { field: 'attributes.http.route', type: 'json', count: 3800 }] : [] };
      }
      const scope = fscope as 'events' | 'logs' | 'spans';
      const sample = scope === 'logs' ? D.logs({ from, to, limit: 300 }).logs : D.events({ from, to, limit: 300 }).events;
      return parts[3] === 'values' ? F.values(scope, sample, qp('field') ?? '', qp('q')) : F.fields(scope, sample);
    }
    case 'recording-settings': {
      const all = (db.recordingSettings ??= {});
      if (method === 'PATCH') {
        const b = body as RecordingSettings;
        if (!(b.samplePercent >= 0 && b.samplePercent <= 100)) throw new MockHttpError(400, 'The share of sessions must be from 0 to 100 %');
        if (b.triggers.some((t) => t.type !== 'error' && !t.value)) throw new MockHttpError(400, 'A trigger needs a value');
        all[pid] = b; save(db);
      }
      const settings = all[pid] ?? REC.DEFAULT_MOCK_SETTINGS;
      return { settings, usage: { lastHour: 9, lastDay: 214 }, retentionDays: 30, updatedAt: all[pid] ? new Date().toISOString() : null, updatedBy: all[pid] ? email : null };
    }
    case 'recordings': {
      if (parts[3]) {
        const r = REC.getRecording(decodeURIComponent(parts[3]));
        if (!r) throw new MockHttpError(404, 'No recording of that session');
        return r;
      }
      const flag = (k: string) => qp(k) === '1' || qp(k) === 'true' || undefined;
      return REC.listRecordings(from, to, qp('before') ? Date.parse(qp('before')!) : undefined, limit, {
        minDuration: qp('minDuration') ? Number(qp('minDuration')) : undefined, page: qp('page'), device: qp('device'), q: qp('q'),
        reason: qp('reason') as 'sample' | 'trigger' | undefined, errors: flag('errors'), rage: flag('rage'), identified: flag('identified'), inactive: flag('inactive'),
      });
    }
    case 'events': return D.events({ from, to, before: qp('before') ? Date.parse(qp('before')!) : undefined, type: qp('type'), q: qp('q'), sessionId: qp('sessionId'), fingerprint: qp('fingerprint'), filters: F.parse(qp('filters')), located: qp('located') === '1', lat: qp('lat') ? Number(qp('lat')) : undefined, lon: qp('lon') ? Number(qp('lon')) : undefined, limit });
    case 'services': return D.services(from, to);
    case 'traces':
      if (parts[3]) return D.browserTrace(parts[3]) ?? { spans: D.genTrace(D.slotOf(parts[3])) };
      return D.traces({ from, to, service: qp('service'), minDurationMs: qp('minDurationMs') ? Number(qp('minDurationMs')) : undefined, errorsOnly: qp('errorsOnly') === '1', q: qp('q'), limit });
    case 'logs': return D.logs({ from, to, before: qp('before') ? Date.parse(qp('before')!) : undefined, severity: qp('severity') ? Number(qp('severity')) : undefined, service: qp('service'), traceId: qp('traceId'), q: qp('q'), filters: F.parse(qp('filters')), limit });
    case 'metrics':
      if (parts[3] === 'series') return D.metricSeries(from, to, qp('name') ?? '', qp('service'), qp('agg') ?? 'avg', qp('groupBy'));
      return D.metricList(to);
  }
  throw new MockHttpError(404, 'Not found');
}

const newKioskToken = () => 'ks_' + Array.from(crypto.getRandomValues(new Uint8Array(40)), (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('');

/** Kiosk screens: /kiosk/v1/state, or a read route of the kiosk's project (rewritten to /api/projects/{pid}/…). */
export function handleKiosk(url: URL, token: string): unknown {
  const db = load('demo@wgo.dev');
  for (const [pid, list] of Object.entries(db.kiosks ?? {})) {
    const k = list.find((x) => x.token === token);
    if (!k) continue;
    const rest = url.pathname.replace(/^\/kiosk\/v1\//, '');
    if (rest === 'state') {
      k.lastSeenAt = new Date().toISOString();
      k.display = `${url.searchParams.get('w')}×${url.searchParams.get('h')}`;
      save(db);
      const project = db.projects.find((p) => p.id === pid)!;
      return { kiosk: { id: k.id, name: k.name }, project: { id: pid, name: project.name }, config: k.config, reloadAt: k.reloadAt, version: `${k.updatedAt}.${k.reloadAt}` } satisfies KioskState;
    }
    if (/^(kiosks|members|triggers|goals|integrations|slack|rotate-key|upload-key|rotate-upload-key|click-aliases)(\/|$)/.test(rest)) throw new MockHttpError(404, 'Not found');
    return handleApi('GET', new URL(`/api/projects/${pid}/${rest}${url.search}`, url.origin), undefined, 'demo@wgo.dev');
  }
  throw new MockHttpError(401, 'This kiosk link was removed or replaced. Get the current one from the dashboard.');
}
