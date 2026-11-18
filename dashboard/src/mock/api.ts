import type { RecordingSettings } from '../api/contract';
import type { ClickAlias, ClickAliasInput, Device, Goal, GoalInput, Kiosk, KioskConfig, KioskState, Member, Project, SavedView, SavedViewInput, SlackIntegration, Trigger, TriggerInput } from '../api/contract';
import * as D from './data';
import { funnel } from './funnel';
import { hex } from './rng';
import * as F from './filters';
import * as REC from './recordings';

interface Db { projects: Project[]; members: Record<string, Member[]>; devices?: Device[]; triggers?: Record<string, Trigger[]>; integrations?: Record<string, SlackIntegration[]>; slackApps?: Record<string, string>; kiosks?: Record<string, Kiosk[]>; views?: Record<string, SavedView[]>; goals?: Record<string, Goal[]>; clickAliases?: Record<string, ClickAlias[]>; recordingSettings?: Record<string, RecordingSettings> }
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

export function handleApi(method: string, url: URL, body: unknown, email: string): unknown {
  const db = load(email);
  const parts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  const qp = (k: string) => url.searchParams.get(k) ?? undefined;
  const now = Date.now();
  const from = Date.parse(qp('from') ?? '') || now - 86400e3, to = Date.parse(qp('to') ?? '') || now;
  const limit = Number(qp('limit') ?? 100);

  if (parts[0] === 'me') return { email, projects: db.projects };
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
      const clean = (p: string) => { const u = new URLSearchParams(p.replace(/^\?/, '')); for (const k of ['range', 'from', 'to', 'new', 'pf', 'scope', 'slack']) u.delete(k); return u.toString(); };
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
    case 'conversions': return D.conversions(from, to, db.goals?.[pid] ?? [], F.parse(qp('filters')), qp('series') !== '0');
    case 'triggers': {
      const list = ((db.triggers ??= {})[pid] ??= []);
      const [, , , id, action] = parts;
      const input = (body ?? {}) as Partial<TriggerInput>;
      if (!id && method === 'POST') {
        const t: Trigger = {
          id: 'trg_' + hex(10, Date.now()), name: input.name ?? 'Trigger', scope: input.scope ?? 'events', filters: input.filters ?? [], destination: input.destination!,
          cooldownSeconds: input.cooldownSeconds ?? 300, enabled: input.enabled ?? true, signingSecret: 'whsec_' + hex(24, Date.now(), 7),
          createdBy: email, createdAt: new Date().toISOString(), lastFiredAt: null, fireCount: 0, lastStatus: null,
        };
        list.push(t); save(db); return t;
      }
      const t = list.find((x) => x.id === id);
      if (id && !t) throw new Error('Trigger not found');
      if (t && action === 'test') { t.lastStatus = 'test: 200'; save(db); return { ok: true, status: '200' }; }
      if (t && method === 'PATCH') { Object.assign(t, input); save(db); return t; }
      if (t && method === 'DELETE') { db.triggers![pid] = list.filter((x) => x.id !== id); save(db); return { ok: true }; }
      return list;
    }
    case 'integrations': {
      const list = ((db.integrations ??= {})[pid] ??= []);
      if (method === 'DELETE') { db.integrations![pid] = list.filter((i) => i.id !== parts[3]); save(db); return { ok: true }; }
      return list;
    }
    case 'slack': {
      const apps = (db.slackApps ??= {});
      const status = () => ({
        configured: !!apps[pid], source: apps[pid] ? 'project' : null, clientId: apps[pid] ?? null,
        redirectUrl: 'https://abc123.execute-api.eu-west-1.amazonaws.com/slack/callback', createAppUrl: 'https://api.slack.com/apps?new_app=1',
      });
      if (!parts[3]) return status();
      if (parts[3] === 'app') {
        if (method === 'DELETE') { delete apps[pid]; save(db); return status(); }
        const { clientId = '', clientSecret = '' } = (body ?? {}) as { clientId?: string; clientSecret?: string };
        if (!/^\d+\.\d+$/.test(clientId.trim())) throw new Error('That doesn’t look like a Slack Client ID (digits.digits, under Basic Information)');
        if (!/^[0-9a-f]{32}$/i.test(clientSecret.trim())) throw new Error('That doesn’t look like a Slack Client Secret (32 hex characters; click Show next to it)');
        apps[pid] = clientId.trim(); save(db); return status();
      }
      if (!apps[pid]) throw new Error('Set up the Slack app for this project first');
      // mock "Add to Slack": connect a channel right away and bounce back like Slack would
      const list = ((db.integrations ??= {})[pid] ??= []);
      const names = ['#alerts', '#checkout', '#growth', '#oncall'];
      list.push({ id: 'int_' + hex(8, Date.now()), type: 'slack', channel: names[list.length % names.length], teamName: 'Acme', createdBy: email, createdAt: new Date().toISOString() });
      save(db);
      return { url: `${location.pathname}${location.search}#/p/${pid}/triggers?slack=connected` };
    }
    case 'members': {
      const list = (db.members[pid] ??= []);
      if (method === 'POST') { const m: Member = { email: String((body as { email: string }).email), role: 'member', createdAt: new Date().toISOString() }; list.push(m); save(db); return m; }
      if (method === 'DELETE') { db.members[pid] = list.filter((m) => m.email !== decodeURIComponent(parts[3])); save(db); return { ok: true }; }
      return list;
    }
    case 'stats': { const r = D.stats(from, to); return qp('compare') === '0' ? { ...r, previous: null } : r; }
    case 'totals': return D.totalsFor(from, to);
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
    case 'errors': return D.errors(from, to, limit);
    case 'http-errors': return D.httpErrors(from, to, limit);
    case 'breakdown': return D.breakdown(from, to, qp('dim') ?? 'browser');
    case 'vitals': return D.vitals(from);
    case 'geo': return D.geo(from, to);
    case 'fields': {
      const scope = (qp('scope') ?? 'events') as 'events' | 'logs' | 'spans';
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
        reason: qp('reason') as 'sample' | 'trigger' | undefined, errors: flag('errors'), rage: flag('rage'), identified: flag('identified'),
      });
    }
    case 'events': return D.events({ from, to, before: qp('before') ? Date.parse(qp('before')!) : undefined, type: qp('type'), q: qp('q'), sessionId: qp('sessionId'), fingerprint: qp('fingerprint'), filters: F.parse(qp('filters')), located: qp('located') === '1', lat: qp('lat') ? Number(qp('lat')) : undefined, lon: qp('lon') ? Number(qp('lon')) : undefined, limit });
    case 'services': return D.services(from, to);
    case 'traces':
      if (parts[3]) return { spans: D.genTrace(D.slotOf(parts[3])) };
      return D.traces({ from, to, service: qp('service'), minDurationMs: qp('minDurationMs') ? Number(qp('minDurationMs')) : undefined, errorsOnly: qp('errorsOnly') === '1', q: qp('q'), limit });
    case 'logs': return D.logs({ from, to, before: qp('before') ? Date.parse(qp('before')!) : undefined, severity: qp('severity') ? Number(qp('severity')) : undefined, service: qp('service'), traceId: qp('traceId'), q: qp('q'), filters: F.parse(qp('filters')), limit });
    case 'metrics':
      if (parts[3] === 'series') return D.metricSeries(from, to, qp('name') ?? '', qp('agg') ?? 'avg', qp('groupBy'));
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
    if (/^(kiosks|members|triggers|goals|integrations|slack|rotate-key|click-aliases)(\/|$)/.test(rest)) throw new MockHttpError(404, 'Not found');
    return handleApi('GET', new URL(`/api/projects/${pid}/${rest}${url.search}`, url.origin), undefined, 'demo@wgo.dev');
  }
  throw new MockHttpError(401, 'This kiosk link was removed or replaced. Get the current one from the dashboard.');
}
