/**
 * Triggers end to end against PostgreSQL (own schema): CRUD + validation, evaluation of ingested batches,
 * delivery with cooldown, Slack/webhook formats, and parity of the in-memory matcher with the SQL filters.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/triggers.pg.test.ts
 */
import { createHmac, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Filter, TriggerWebhookPayload } from '../src/contract';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'triggers_test';

d('triggers (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();
  delete process.env.TRIGGER_FUNCTION; // deliver in-process instead of invoking a Lambda

  const { query, closeDb } = await import('../src/lib/db');
  const { writeRows } = await import('../src/lib/store/write');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { normalizeBatch, toApiEvent } = await import('../src/lib/events');
  const T = await import('../src/lib/triggers');
  const A = await import('../src/lib/analytics');
  const { matchesAll } = await import('../src/lib/filterMatch');

  const pid = randomUUID();
  const now = Date.now();
  const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const fetchMock = vi.fn(async (u: string | URL, init?: RequestInit) => {
    sent.push({ url: String(u), body: String(init?.body), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response('ok', { status: 200 });
  });

  const batch = (events: Array<Record<string, unknown>>, ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36') =>
    normalizeBatch(pid, { k: 'k', a: 'anon', sentAt: now, ctx: { ua }, e: events.map((e) => ({ id: randomUUID(), ts: now - 1000, s: 's1', url: 'https://shop.test/cart', path: '/cart', ...e })) } as never, now);

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    await query('INSERT INTO projects (id, name, write_key) VALUES ($1, $2, $3)', [pid, 'Shop', 'wk_triggerstest0001']);
    await query(`INSERT INTO integrations (project_id, id, type, config, created_by) VALUES ($1, $2, 'slack', $3::jsonb, 'me@x.test')`,
      [pid, '00000000-0000-4000-8000-00000000510c', JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/T/B/secret', channel: '#alerts', teamName: 'Team' })]);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeDb();
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  const settle = () => vi.waitFor(async () => { await new Promise((r) => setTimeout(r, 30)); }, { timeout: 2000 });

  it('validates input', async () => {
    const base = { name: 'x', filters: [{ field: 'type', op: 'eq', value: 'click' }] as Filter[], destination: { type: 'webhook' as const, url: 'https://example.com/hook' } };
    await expect(T.createTrigger(pid, 'me@x.test', { ...base, filters: [] })).rejects.toMatchObject({ status: 400 });
    await expect(T.createTrigger(pid, 'me@x.test', { ...base, filters: [{ field: 'body', op: 'eq', value: 'x' }] })).rejects.toThrow(/Unknown field/);
    await expect(T.createTrigger(pid, 'me@x.test', { ...base, destination: { type: 'webhook', url: 'http://example.com' } })).rejects.toThrow(/https/);
    await expect(T.createTrigger(pid, 'me@x.test', { ...base, destination: { type: 'slack', integrationId: randomUUID() } })).rejects.toThrow(/not connected/);
    await expect(T.createTrigger(pid, 'me@x.test', { ...base, cooldownSeconds: -1 })).rejects.toThrow(/cooldown/);
  });

  it('creates, lists, updates and deletes', async () => {
    const t = await T.createTrigger(pid, 'me@x.test', { name: 'Temp', filters: [{ field: 'path', op: 'eq', value: '/x' }], destination: { type: 'webhook', url: 'https://example.com/hook' } }, 'https://wgo.example.com');
    expect(t).toMatchObject({ name: 'Temp', cooldownSeconds: 300, enabled: true, fireCount: 0, signingSecret: expect.stringMatching(/^whsec_/) });
    const u = await T.updateTrigger(pid, 'me@x.test', t.id, { enabled: false, name: 'Renamed' });
    expect(u).toMatchObject({ enabled: false, name: 'Renamed', filters: t.filters });
    expect((await T.listTriggers(pid)).map((x) => x.id)).toContain(t.id);
    await T.deleteTrigger(pid, t.id);
    expect((await T.listTriggers(pid)).map((x) => x.id)).not.toContain(t.id);
  });

  it('notifies Slack for matching events, then holds back matches during the cooldown', async () => {
    const t = await T.createTrigger(pid, 'me@x.test', {
      name: 'Checkout failures',
      filters: [{ field: 'type', op: 'eq', value: 'http_error' }, { field: 'httpStatus', op: 'gte', value: '500' }],
      destination: { type: 'slack', integrationId: '00000000-0000-4000-8000-00000000510c' },
      cooldownSeconds: 600,
    }, 'https://wgo.example.com');
    sent.length = 0;

    const rows = batch([
      { t: 'http_error', d: { method: 'POST', url: 'https://api.shop.test/pay', status: 502, dur: 300 } },
      { t: 'http_error', d: { method: 'GET', url: 'https://api.shop.test/cart', status: 404, dur: 30 } }, // below 500
      { t: 'click', d: { sel: 'button', tag: 'button', text: 'Pay' } },
    ]);
    expect(await T.evaluateTriggers(pid, rows.map(toApiEvent))).toBe(1);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].url).toBe('https://hooks.slack.com/services/T/B/secret');
    const slack = JSON.parse(sent[0].body);
    expect(slack.text).toBe('🔔 Checkout failures: 1 matching event');
    expect(JSON.stringify(slack.blocks)).toContain('POST api.shop.test/pay → 502');
    expect(JSON.stringify(slack.blocks)).toContain('https://wgo.example.com/#/p/');

    // inside the cooldown: counted, not sent
    const more = batch([{ t: 'http_error', d: { method: 'POST', url: 'https://api.shop.test/pay', status: 500, dur: 10 } }, { t: 'http_error', d: { method: 'POST', url: 'https://api.shop.test/pay', status: 503, dur: 10 } }]);
    await T.evaluateTriggers(pid, more.map(toApiEvent));
    await vi.waitFor(async () => expect((await query<{ suppressed: number }>('SELECT suppressed FROM triggers WHERE id = $1', [t.id]))[0].suppressed).toBe(2));
    expect(sent).toHaveLength(1);

    // after the cooldown the next notification includes the held-back matches
    await query(`UPDATE triggers SET last_fired_at = now() - interval '1 hour' WHERE id = $1`, [t.id]);
    await T.evaluateTriggers(pid, batch([{ t: 'http_error', d: { method: 'GET', url: 'https://api.shop.test/x', status: 500, dur: 1 } }]).map(toApiEvent));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(JSON.parse(sent[1].body).text).toBe('🔔 Checkout failures: 3 matching events');
    const [row] = await T.listTriggers(pid).then((l) => l.filter((x) => x.id === t.id));
    expect(row).toMatchObject({ fireCount: 2, lastStatus: '200' });
    await T.deleteTrigger(pid, t.id);
  });

  it('sends signed JSON to webhooks, and test notifications on demand', async () => {
    const t = await T.createTrigger(pid, 'me@x.test', {
      name: 'Signup clicks', filters: [{ field: 'trackName', op: 'eq', value: 'signup' }],
      destination: { type: 'webhook', url: 'https://example.com/hook' }, cooldownSeconds: 0,
    }, 'https://wgo.example.com');
    sent.length = 0;
    await T.evaluateTriggers(pid, batch([{ t: 'click', d: { sel: 'a', tag: 'a', text: 'Sign up', name: 'signup' } }]).map(toApiEvent));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const { body, headers } = sent[0];
    const payload = JSON.parse(body) as TriggerWebhookPayload;
    expect(payload).toMatchObject({ trigger: { id: t.id, name: 'Signup clicks' }, project: { id: pid, name: 'Shop' }, matches: 1 });
    expect(payload.events[0]).toMatchObject({ type: 'click', trackName: 'signup' });
    expect(payload.url).toContain('https://wgo.example.com/#/p/' + pid + '/events');
    expect(headers['x-wgo-signature']).toBe('sha256=' + createHmac('sha256', t.signingSecret).update(body).digest('hex'));

    const res = await T.testTrigger(pid, t.id);
    expect(res).toEqual({ ok: true, status: '200' });
    expect(JSON.parse(sent[1].body)).toMatchObject({ test: true, matches: 1 });

    // disabled triggers don't fire
    await T.updateTrigger(pid, 'me@x.test', t.id, { enabled: false });
    sent.length = 0;
    expect(await T.evaluateTriggers(pid, batch([{ t: 'click', d: { sel: 'a', tag: 'a', text: 'Sign up', name: 'signup' } }]).map(toApiEvent))).toBe(0);
    await T.deleteTrigger(pid, t.id);
  });

  it('records delivery failures instead of throwing', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('channel_not_found', { status: 404 }));
    const t = await T.createTrigger(pid, 'me@x.test', { name: 'Broken', filters: [{ field: 'type', op: 'eq', value: 'pageview' }], destination: { type: 'webhook', url: 'https://example.com/gone' } });
    expect(await T.testTrigger(pid, t.id)).toEqual({ ok: false, status: '404 channel_not_found' });
    await T.deleteTrigger(pid, t.id);
  });

  it('matches in memory exactly what the SQL filters select', async () => {
    const rows = [
      ...batch([
        { t: 'click', d: { sel: 'button.buy', tag: 'button', text: 'Buy now', name: 'buy', rage: 3 } },
        { t: 'custom', d: { name: 'checkout', props: { plan: 'pro', value: 120 } } },
        { t: 'custom', d: { name: 'checkout', props: { plan: 'free', value: '0' } } },
        { t: 'http_error', d: { method: 'POST', url: 'https://api.shop.test/orders/1', status: 503, dur: 900 } },
        { t: 'pageview', path: '/docs/a', url: 'https://shop.test/docs/a' },
      ]),
      ...batch([{ t: 'click', d: { sel: 'a.docs', tag: 'a', text: 'Docs' }, path: '/docs/a' }], 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0'),
    ];
    await writeRows('events', rows);
    const all = rows.map(toApiEvent);
    const cases: Filter[][] = [
      [{ field: 'type', op: 'eq', value: 'click' }],
      [{ field: 'type', op: 'neq', value: 'click' }],
      [{ field: 'path', op: 'starts_with', value: '/DOCS' }],
      [{ field: 'elementText', op: 'contains', value: 'buy' }],
      [{ field: 'elementText', op: 'not_contains', value: 'buy' }],
      [{ field: 'httpStatus', op: 'gte', value: '500' }],
      [{ field: 'httpStatus', op: 'neq', value: '503' }],
      [{ field: 'props.props.value', op: 'gt', value: '100' }],
      [{ field: 'props.props.value', op: 'lte', value: '0' }],
      [{ field: 'props.props.plan', op: 'gt', value: '5' }],
      [{ field: 'props.props.plan', op: 'lt', value: 'q' }],
      [{ field: 'props.rage', op: 'set' }],
      [{ field: 'trackName', op: 'not_set' }],
      [{ field: 'browser', op: 'eq', value: 'Firefox' }, { field: 'type', op: 'eq', value: 'click' }],
      [{ field: 'props.name', op: 'ends_with', value: 'OUT' }],
    ];
    const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };
    for (const filters of cases) {
      const sqlIds = (await A.events(pid, { ...range, limit: '500', filters: JSON.stringify(filters) })).events.map((e) => e.id).sort();
      const jsIds = all.filter((e) => matchesAll(e, filters)).map((e) => e.id).sort();
      expect(jsIds, JSON.stringify(filters)).toEqual(sqlIds);
    }
  });

  it('fires log triggers from OTLP ingest, and matches logs in memory exactly as SQL does', async () => {
    const { decodeOtlp, storeOtlpRows, evaluateOtlpTriggers } = await import('../src/lib/otlp/ingest');
    const nanos = (ms: number) => String(BigInt(ms) * 1_000_000n);
    const attr = (key: string, v: string | number) => ({ key, value: typeof v === 'number' ? { intValue: v } : { stringValue: v } });
    const payload = {
      resourceLogs: [{
        resource: { attributes: [attr('service.name', 'checkout'), attr('service.version', '1.2.0')] },
        scopeLogs: [{ logRecords: [
          { timeUnixNano: nanos(now - 2000), severityNumber: 17, severityText: 'ERROR', body: { stringValue: 'Payment declined for order 42' }, attributes: [attr('http.route', '/pay'), attr('retries', 3)] },
          { timeUnixNano: nanos(now - 1500), severityNumber: 9, severityText: 'INFO', body: { stringValue: 'Payment ok for order 43' }, attributes: [attr('http.route', '/pay')] },
          { timeUnixNano: nanos(now - 1000), severityNumber: 13, severityText: 'WARN', body: { stringValue: 'Slow cart' }, attributes: [attr('http.route', '/cart'), attr('retries', 1)] },
        ] }],
      }],
    };
    const t = await T.createTrigger(pid, 'me@x.test', {
      name: 'Declined payments', scope: 'logs',
      filters: [{ field: 'severityNumber', op: 'gte', value: '17' }, { field: 'attributes.http.route', op: 'eq', value: '/pay' }],
      destination: { type: 'webhook', url: 'https://example.com/logs-hook' },
    }, 'https://wgo.example.com');
    expect(t.scope).toBe('logs');
    await expect(T.updateTrigger(pid, 'me@x.test', t.id, { scope: 'events' })).rejects.toThrow(/scope/);
    // fields are checked against the trigger's scope
    await expect(T.createTrigger(pid, 'me@x.test', { name: 'x', scope: 'logs', filters: [{ field: 'type', op: 'eq', value: 'click' }], destination: { type: 'webhook', url: 'https://example.com/h' } })).rejects.toThrow(/Unknown field for logs/);
    // an events trigger never sees logs, and vice versa
    const ev = await T.createTrigger(pid, 'me@x.test', { name: 'Any event', filters: [{ field: 'type', op: 'set' }], destination: { type: 'webhook', url: 'https://example.com/ev' } });

    sent.length = 0;
    const rows = decodeOtlp('logs', pid, Buffer.from(JSON.stringify(payload)), false);
    await storeOtlpRows('logs', rows);
    await evaluateOtlpTriggers('logs', rows);
    await vi.waitFor(() => expect(sent.filter((x) => x.url === 'https://example.com/logs-hook')).toHaveLength(1));
    await settle();
    expect(sent.map((x) => x.url)).not.toContain('https://example.com/ev');
    const body = JSON.parse(sent.find((x) => x.url === 'https://example.com/logs-hook')!.body) as TriggerWebhookPayload;
    expect(body).toMatchObject({ scope: 'logs', matches: 1, events: [], trigger: { name: 'Declined payments' } });
    expect(body.logs!.map((l) => l.body)).toEqual(['Payment declined for order 42']);
    expect(body.url).toMatch(/^https:\/\/wgo\.example\.com\/#\/p\/.+\/logs\?range=24h&lf=/);
    await T.deleteTrigger(pid, t.id);
    await T.deleteTrigger(pid, ev.id);

    // parity: what the logs page shows for a filter is what a trigger with that filter would match
    const all = (await A.logs(pid, { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString(), limit: '500' })).logs;
    expect(all).toHaveLength(3);
    const cases: Filter[][] = [
      [{ field: 'severityNumber', op: 'gte', value: '13' }],
      [{ field: 'body', op: 'starts_with', value: 'PAYMENT' }],
      [{ field: 'body', op: 'not_contains', value: 'order' }],
      [{ field: 'attributes.http.route', op: 'eq', value: '/pay' }],
      [{ field: 'attributes.retries', op: 'gt', value: '2' }],
      [{ field: 'attributes.retries', op: 'not_set' }],
      [{ field: 'resource.service.version', op: 'eq', value: '1.2.0' }, { field: 'service', op: 'eq', value: 'checkout' }],
      [{ field: 'severityText', op: 'neq', value: 'INFO' }],
    ];
    for (const filters of cases) {
      const sqlIds = (await A.logs(pid, { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString(), limit: '500', filters: JSON.stringify(filters) })).logs.map((l) => l.id).sort();
      const jsIds = all.filter((l) => matchesAll(l, filters, 'logs')).map((l) => l.id).sort();
      expect(jsIds, JSON.stringify(filters)).toEqual(sqlIds);
    }
  });

  it('saves, renames and deletes views, dropping the time range from their params', async () => {
    const V = await import('../src/lib/views');
    await expect(V.createView(pid, 'me@x.test', { name: ' ', page: 'logs', params: '' })).rejects.toMatchObject({ status: 400 });
    await expect(V.createView(pid, 'me@x.test', { name: 'x', page: '../etc', params: '' })).rejects.toThrow(/page/);
    const v = await V.createView(pid, 'me@x.test', { name: 'Checkout errors', page: 'logs', params: '?range=7d&sev=17&lf=%5B%5D&new=1' });
    expect(v).toMatchObject({ name: 'Checkout errors', page: 'logs', params: 'sev=17&lf=%5B%5D', createdBy: 'me@x.test' });
    expect((await V.updateView(pid, v.id, { name: 'Renamed' })).name).toBe('Renamed');
    expect((await V.listViews(pid)).map((x) => x.id)).toEqual([v.id]);
    await V.deleteView(pid, v.id);
    expect(await V.listViews(pid)).toEqual([]);
    await expect(V.deleteView(pid, v.id)).rejects.toMatchObject({ status: 404 });
  });

  /**
   * A fake slack.com for a Slack app with client id `id` and secret `secret`: the OAuth code exchange (granting
   * `scopes`), conversations.list in two pages, conversations.info and chat.postMessage (recorded in `posts`).
   */
  const fakeSlack = (id: string, secret: string, opts: { scopes?: string; posts?: Array<{ auth: string; body: Record<string, unknown> }>; postError?: string } = {}) => {
    let n = 0;
    const channels: Record<string, { id: string; name: string; is_private?: boolean; is_member?: boolean }> = {
      C1: { id: 'C1', name: 'alerts' }, G1: { id: 'G1', name: 'secret', is_private: true, is_member: false }, G2: { id: 'G2', name: 'ops', is_private: true, is_member: true },
    };
    return async (u: string | URL, init?: RequestInit) => {
      const url = String(u);
      const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
      if (url === 'https://slack.com/api/oauth.v2.access') {
        const f = new URLSearchParams(String(init?.body));
        if (f.get('client_id') !== id) return Response.json({ ok: false, error: 'invalid_client_id' });
        if (f.get('client_secret') !== secret) return Response.json({ ok: false, error: 'bad_client_secret' });
        if (f.get('code') !== 'real-code') return Response.json({ ok: false, error: 'invalid_code' });
        n++;
        return Response.json({ ok: true, access_token: `xoxb-${n}`, token_type: 'bot', scope: opts.scopes ?? 'chat:write,chat:write.public,channels:read,groups:read', bot_user_id: 'UBOT', team: { id: 'T1', name: 'Acme' } });
      }
      if (!auth.startsWith('Bearer xoxb-')) return Response.json({ ok: false, error: 'not_authed' });
      if (url === 'https://slack.com/api/conversations.list') {
        const f = new URLSearchParams(String(init?.body));
        expect(f.get('types')).toBe('public_channel,private_channel');
        return f.get('cursor') === 'p2'
          ? Response.json({ ok: true, channels: [channels.G1, channels.G2], response_metadata: { next_cursor: '' } })
          : Response.json({ ok: true, channels: [channels.C1], response_metadata: { next_cursor: 'p2' } });
      }
      if (url === 'https://slack.com/api/conversations.info') {
        const c = channels[new URLSearchParams(String(init?.body)).get('channel') ?? ''];
        return Response.json(c ? { ok: true, channel: c } : { ok: false, error: 'channel_not_found' });
      }
      if (url === 'https://slack.com/api/chat.postMessage') {
        opts.posts?.push({ auth, body: JSON.parse(String(init?.body)) });
        return Response.json(opts.postError ? { ok: false, error: opts.postError } : { ok: true, ts: '1.2' });
      }
      return new Response('ok', { status: 200 });
    };
  };
  const resetFetch = () => fetchMock.mockImplementation(async (u: string | URL, init?: RequestInit) => {
    sent.push({ url: String(u), body: String(init?.body), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response('ok', { status: 200 });
  });

  it('sets up your own Slack app once and connects workspaces for a project or for yourself', async () => {
    const S = await import('../src/lib/slack');
    const DST = await import('../src/lib/destinations');
    const { handler: callback } = await import('../src/handlers/slack');
    const domain = 'abc.execute-api.eu-west-1.amazonaws.com';
    const ID = '1111111111.2222222222', SECRET = 'c'.repeat(32), ME = 'own-app@x.test';
    const [p1, p2] = [randomUUID(), randomUUID()];
    for (const p of [p1, p2]) {
      await query('INSERT INTO projects (id, name, write_key) VALUES ($1, $2, $3)', [p, 'P', `wk_ownapp${p.slice(0, 8)}`]);
      await query(`INSERT INTO project_members (project_id, email, role) VALUES ($1, $2, 'owner')`, [p, ME]);
    }
    const posts: Array<{ auth: string; body: Record<string, unknown> }> = [];
    fetchMock.mockImplementation(fakeSlack(ID, SECRET, { posts }));
    const ev = (qs: Record<string, string>) => ({ queryStringParameters: qs, requestContext: { domainName: domain } }) as never;
    const connect = async (pid: string, level: 'project' | 'account') => {
      const url = new URL(await S.installUrl(pid, ME, domain, 'https://wgo.example.com', level));
      expect(url.searchParams.get('client_id')).toBe(ID);
      const res = (await callback(ev({ code: 'real-code', state: url.searchParams.get('state')! }))) as { headers: Record<string, string> };
      expect(res.headers.location).toBe(`https://wgo.example.com/#/p/${pid}/triggers?slack=connected&slack_level=${level}`);
    };
    try {
      expect(await S.setupStatus(p1, domain, ME)).toMatchObject({ configured: false, accountClientId: null, workspaces: [] });
      await S.saveApp(p1, ME, ID, SECRET, 'account');
      // nothing was saved to the project: it's mine, and works in both projects
      expect(await query(`SELECT 1 FROM integrations WHERE project_id = $1 AND type = 'slack_app'`, [p1])).toHaveLength(0);
      for (const p of [p1, p2]) expect(await S.setupStatus(p, domain, ME)).toMatchObject({ configured: true, source: 'account', clientId: ID, accountClientId: ID });
      // others in those projects don't get it
      expect((await S.setupStatus(p1, domain, 'someone@x.test')).configured).toBe(false);

      await connect(p1, 'project');
      await connect(p2, 'account');
      // my own workspace shows up in every project; the project's only in its own
      expect((await S.listWorkspaces(p1, ME)).map((w) => [w.level, w.teamName])).toEqual([['project', 'Acme'], ['account', 'Acme']]);
      expect((await S.listWorkspaces(p2, ME)).map((w) => w.level)).toEqual(['account']);
      expect(await S.listWorkspaces(p2, 'someone@x.test')).toEqual([]);
      // connecting the same workspace again updates its token instead of adding another
      await connect(p1, 'project');
      expect(await query('SELECT bot_token FROM slack_workspaces WHERE project_id = $1', [p1])).toEqual([{ bot_token: 'xoxb-3' }]);
      // tokens never leave the server
      expect(JSON.stringify(await S.setupStatus(p1, domain, ME))).not.toContain('xoxb');

      // a channel of my own workspace becomes my own destination, usable in both projects
      const mine = (await S.listWorkspaces(p2, ME))[0];
      const dest = await S.addChannel(p2, ME, mine.id, 'C1');
      expect(dest).toMatchObject({ level: 'account', type: 'slack', name: '#alerts', detail: 'Acme', owner: ME });
      expect((await DST.listAccountDestinations(ME)).map((d) => d.name)).toEqual(['#alerts']);
      await expect(S.addChannel(p2, ME, mine.id, 'C1')).rejects.toMatchObject({ status: 409 });
      // someone else can't use my workspace
      await expect(S.addChannel(p2, 'someone@x.test', mine.id, 'C2')).rejects.toMatchObject({ status: 404 });
      expect((await DST.testDestination({ level: 'account', email: ME }, dest.id, null)).ok).toBe(true);
      expect(posts.at(-1)).toMatchObject({ auth: 'Bearer xoxb-2', body: { channel: 'C1', text: expect.stringContaining('[test]') } });

      // removing the app keeps the connected workspaces
      await S.removeApp(p1, ME, 'account');
      expect((await S.setupStatus(p2, domain, ME)).configured).toBe(false);
      expect(await S.listWorkspaces(p1, ME)).toHaveLength(2);
    } finally {
      resetFetch();
    }
  });

  it('sets up a Slack app from the dashboard, connects a workspace and picks its channels', async () => {
    const S = await import('../src/lib/slack');
    const { SLACK_BOT_SCOPES } = await import('../src/contract');
    const { handler: callback } = await import('../src/handlers/slack');
    const domain = 'abc.execute-api.eu-west-1.amazonaws.com';
    const ID = '1234567890.9876543210', SECRET = 'a'.repeat(32), ME = 'me@x.test';
    const posts: Array<{ auth: string; body: Record<string, unknown> }> = [];
    const slack = { scopes: 'incoming-webhook', posts, postError: undefined as string | undefined };
    fetchMock.mockImplementation((u, init) => fakeSlack(ID, SECRET, slack)(u, init));
    try {
      expect(await S.setupStatus(pid, domain)).toMatchObject({ configured: false, source: null, redirectUrl: `https://${domain}/slack/callback` });
      await expect(S.installUrl(pid, ME, domain, null)).rejects.toMatchObject({ status: 409 });

      await expect(S.saveApp(pid, ME, 'nope', SECRET)).rejects.toThrow(/Client ID/);
      await expect(S.saveApp(pid, ME, ID, 'short')).rejects.toThrow(/Client Secret/);
      await expect(S.saveApp(pid, ME, ID, 'b'.repeat(32))).rejects.toThrow(/doesn’t match/);
      await S.saveApp(pid, ME, ID, SECRET);
      expect(await S.setupStatus(pid, domain)).toMatchObject({ configured: true, source: 'project', clientId: ID });

      const url = new URL(await S.installUrl(pid, ME, domain, 'https://wgo.example.com'));
      expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
      expect(url.searchParams.get('client_id')).toBe(ID);
      expect(url.searchParams.get('scope')).toBe(SLACK_BOT_SCOPES.join(','));
      const state = url.searchParams.get('state')!;
      const ev = (qs: Record<string, string>) => ({ queryStringParameters: qs, requestContext: { domainName: domain } }) as never;

      // an app created before bot tokens only grants incoming-webhook: say so instead of saving a useless token
      const old = (await callback(ev({ code: 'real-code', state }))) as { headers: Record<string, string> };
      expect(old.headers.location).toBe(`https://wgo.example.com/#/p/${pid}/triggers?slack=scopes&slack_level=project`);
      expect(await S.listWorkspaces(pid, ME)).toEqual([]);

      slack.scopes = SLACK_BOT_SCOPES.join(',');
      const ok = (await callback(ev({ code: 'real-code', state }))) as { statusCode: number; headers: Record<string, string> };
      expect(ok.statusCode).toBe(302);
      expect(ok.headers.location).toBe(`https://wgo.example.com/#/p/${pid}/triggers?slack=connected&slack_level=project`);
      const [ws] = await S.listWorkspaces(pid, ME);
      expect(ws).toMatchObject({ level: 'project', teamName: 'Acme', channels: 0, createdBy: ME });
      // any member uses the project's workspace
      expect(await S.listWorkspaces(pid, 'other@x.test')).toHaveLength(1);

      // public channels, and private ones the bot was invited to, over every page
      expect(await S.listChannels(pid, ME, ws.id)).toEqual([{ id: 'C1', name: '#alerts', private: false }, { id: 'G2', name: '#ops', private: true }]);
      await expect(S.addChannel(pid, ME, ws.id, 'G1')).rejects.toThrow(/invite WGO/);
      await expect(S.addChannel(pid, ME, ws.id, 'CNOPE1')).rejects.toThrow(/invite WGO/);
      await expect(S.addChannel(pid, ME, ws.id, 'not a channel')).rejects.toMatchObject({ status: 400 });
      const ch = await S.addChannel(pid, ME, ws.id, 'C1');
      expect(ch).toMatchObject({ level: 'project', type: 'slack', name: '#alerts', detail: 'Acme', ref: { type: 'slack', integrationId: ch.id } });
      await expect(S.addChannel(pid, ME, ws.id, 'C1')).rejects.toMatchObject({ status: 409 });
      expect((await S.listIntegrations(pid)).map((i) => i.channel)).toContain('#alerts');
      expect((await S.listWorkspaces(pid, ME))[0].channels).toBe(1);

      // triggers post with the bot token
      const t = await T.createTrigger(pid, ME, { name: 'Bot alert', scope: 'events', filters: [{ field: 'type', op: 'eq', value: 'error' }], destination: { type: 'slack', integrationId: ch.id } });
      expect(await T.testTrigger(pid, t.id)).toEqual({ ok: true, status: '200' });
      expect(posts.at(-1)).toMatchObject({ auth: 'Bearer xoxb-1', body: { channel: 'C1', unfurl_links: false, text: expect.stringContaining('Bot alert'), blocks: expect.any(Array) } });
      slack.postError = 'channel_not_found';
      expect(await T.testTrigger(pid, t.id)).toEqual({ ok: false, status: 'slack: channel_not_found' });

      // a workspace with channels can't be disconnected; once they're gone it can, and nothing posts with its token
      await expect(S.disconnectWorkspace(pid, ME, ws.id)).rejects.toThrow(/#alerts/);
      await T.deleteTrigger(pid, t.id);
      await S.deleteIntegration(pid, ch.id);
      await S.disconnectWorkspace(pid, ME, ws.id);
      expect(await S.listWorkspaces(pid, ME)).toEqual([]);
      expect(await S.channelTarget({ channel: '#alerts', teamName: 'Acme', workspaceId: ws.id, channelId: 'C1' }, null)).toBe('slack: workspace disconnected');

      const cancelled = (await callback(ev({ error: 'access_denied', state }))) as { headers: Record<string, string> };
      expect(cancelled.headers.location).toContain('slack=cancelled');
      const forged = (await callback(ev({ code: 'real-code', state: state.split('.')[0] + '.AAAA' }))) as { statusCode: number };
      expect(forged.statusCode).toBe(400);

      await S.removeApp(pid);
      expect((await S.setupStatus(pid, domain)).configured).toBe(false);
    } finally {
      resetFetch();
    }
  });
});
