import { createHmac } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Saved trigger destinations end to end through the API handler: project vs account levels, who can pick and see
 * what, signing with the destination's secret, and what happens when a destination's owner leaves the project.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/destinations.pg.test.ts
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('saved destinations (PostgreSQL)', async () => {
  if (!process.env.DATABASE_URL) return;
  const BASE = process.env.DATABASE_URL;
  const isolated = new URL(BASE);
  isolated.searchParams.set('options', '-c search_path=destinations_test');
  process.env.DATABASE_URL = isolated.toString();
  delete process.env.TRIGGER_FUNCTION;
  const { Client } = await import('pg');
  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const api = (await import('../src/handlers/api')).handler;

  const ANNA = 'anna@example.com';
  const BO = 'bo@example.com';
  const CY = 'cy@example.com';
  const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const fetchMock = vi.fn(async (u: string | URL, init?: RequestInit) => {
    sent.push({ url: String(u), body: String(init?.body), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response('ok', { status: 200 });
  });

  const ev = (method: string, path: string, body: string | undefined, email: string) => ({
    rawPath: path, headers: {}, queryStringParameters: undefined, body, isBase64Encoded: false,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { email } } } },
  }) as unknown as APIGatewayProxyEventV2;
  const call = async (method: string, path: string, body: object | undefined, email: string) => {
    const res = (await api(ev(method, path, body && JSON.stringify(body), email) as never)) as APIGatewayProxyStructuredResultV2;
    return { status: res.statusCode!, body: JSON.parse(res.body as string) };
  };
  const trigger = (name: string, destination: object) => ({ name, filters: [{ field: 'type', op: 'eq', value: 'click' }], destination });

  let shop = '', blog = '';

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS destinations_test CASCADE');
    await admin.query('CREATE SCHEMA destinations_test');
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    shop = (await call('POST', '/api/projects', { name: 'Shop' }, ANNA)).body.id;
    blog = (await call('POST', '/api/projects', { name: 'Blog' }, ANNA)).body.id;
    for (const who of [BO, CY]) expect((await call('POST', `/api/projects/${shop}/members`, { email: who }, ANNA)).status).toBe(200);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeDb();
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS destinations_test CASCADE');
    await admin.end();
  });

  it('keeps project destinations in their project and account ones with their owner', async () => {
    const mine = await call('POST', '/api/destinations', { name: 'Ops', url: 'https://ops.example.com/hook' }, ANNA);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ level: 'account', type: 'webhook', name: 'Ops', detail: 'ops.example.com', owner: ANNA, editable: true,
      url: 'https://ops.example.com/hook', signingSecret: expect.stringMatching(/^whsec_/), ref: { type: 'saved', destinationId: mine.body.id } });
    const team = await call('POST', `/api/projects/${shop}/destinations`, { name: 'Shop team', url: 'https://team.example.com/hook' }, BO);
    expect(team.body).toMatchObject({ level: 'project', owner: null, editable: true });

    // Anna, in Shop: the project's, then her own
    const annaShop = (await call('GET', `/api/projects/${shop}/destinations`, undefined, ANNA)).body;
    expect(annaShop.map((x: { name: string }) => x.name)).toEqual(['Shop team', 'Ops']);
    // Bo, in Shop: only the project's; Anna's are hers
    expect((await call('GET', `/api/projects/${shop}/destinations`, undefined, BO)).body.map((x: { name: string }) => x.name)).toEqual(['Shop team']);
    // Anna, in Blog: her own, not Shop's
    expect((await call('GET', `/api/projects/${blog}/destinations`, undefined, ANNA)).body.map((x: { name: string }) => x.name)).toEqual(['Ops']);
    expect((await call('GET', '/api/destinations', undefined, BO)).body).toEqual([]);
    // only the owner changes an account destination
    expect((await call('PATCH', `/api/destinations/${mine.body.id}`, { name: 'Hijacked' }, BO)).status).toBe(404);
    expect((await call('PATCH', `/api/destinations/${mine.body.id}`, { name: 'Ops pager' }, ANNA)).body.name).toBe('Ops pager');
    // validation
    expect((await call('POST', '/api/destinations', { name: 'x', url: 'http://localhost/hook' }, ANNA)).status).toBe(400);
    expect((await call('POST', '/api/destinations', { name: '', url: 'https://ok.example.com' }, ANNA)).status).toBe(400);
    // outsiders can't reach a project's
    expect((await call('GET', `/api/projects/${shop}/destinations`, undefined, 'stranger@example.com')).status).toBe(404);
  });

  it('lets triggers use the project’s or the caller’s own, and keeps another member’s on edit', async () => {
    const [ops] = (await call('GET', '/api/destinations', undefined, ANNA)).body;
    const team = (await call('GET', `/api/projects/${shop}/destinations`, undefined, BO)).body[0];

    // Bo can't point a trigger at Anna's destination; Anna can
    expect((await call('POST', `/api/projects/${shop}/triggers`, trigger('Bo', ops.ref), BO)).status).toBe(400);
    const t = await call('POST', `/api/projects/${shop}/triggers`, trigger('Clicks', ops.ref), ANNA);
    expect(t.status).toBe(200);
    expect(t.body.destinationLabel).toEqual({ name: 'Ops pager', detail: 'ops.example.com', owner: ANNA, type: 'webhook' });
    // a project destination can't be used from another project
    expect((await call('POST', `/api/projects/${blog}/triggers`, trigger('Elsewhere', team.ref), ANNA)).status).toBe(400);

    // Bo edits Anna's trigger and keeps her destination; he sees its label, not its URL
    const edited = await call('PATCH', `/api/projects/${shop}/triggers/${t.body.id}`, { name: 'Clicks!', destination: ops.ref }, BO);
    expect(edited.status).toBe(200);
    const listed = (await call('GET', `/api/projects/${shop}/triggers`, undefined, BO)).body.find((x: { id: string }) => x.id === t.body.id);
    expect(listed.destinationLabel).toMatchObject({ name: 'Ops pager', owner: ANNA });
    expect(JSON.stringify(listed)).not.toContain('ops.example.com/hook');

    // delivery goes to the saved URL, signed with the destination's secret
    sent.length = 0;
    expect((await call('POST', `/api/projects/${shop}/triggers/${t.body.id}/test`, undefined, BO)).body).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://ops.example.com/hook');
    const expected = 'sha256=' + createHmac('sha256', ops.signingSecret).update(sent[0].body).digest('hex');
    expect(sent[0].headers['x-wgo-signature']).toBe(expected);
    expect(sent[0].headers['x-wgo-destination']).toBe(ops.id);
    expect(sent[0].headers['x-wgo-trigger']).toBe(t.body.id);

    // in use: deleting is refused, naming the trigger and its project
    const del = await call('DELETE', `/api/destinations/${ops.id}`, undefined, ANNA);
    expect(del.status).toBe(409);
    expect(del.body.error).toContain('Clicks! (Shop)');
    expect((await call('DELETE', `/api/projects/${shop}/triggers/${t.body.id}`, undefined, ANNA)).status).toBe(200);
    expect((await call('DELETE', `/api/destinations/${ops.id}`, undefined, ANNA)).status).toBe(200);
  });

  it('stops sending to a member’s destination once they leave the project', async () => {
    const cys = (await call('POST', '/api/destinations', { name: 'Cy', url: 'https://cy.example.com/hook' }, CY)).body;
    const t = (await call('POST', `/api/projects/${shop}/triggers`, trigger('Cy alerts', cys.ref), CY)).body;
    sent.length = 0;
    expect((await call('POST', `/api/projects/${shop}/triggers/${t.id}/test`, undefined, ANNA)).body.ok).toBe(true);
    expect(sent).toHaveLength(1);

    expect((await call('DELETE', `/api/projects/${shop}/members/${CY}`, undefined, ANNA)).status).toBe(200);
    sent.length = 0;
    expect((await call('POST', `/api/projects/${shop}/triggers/${t.id}/test`, undefined, ANNA)).body).toEqual({ ok: false, status: 'destination owner is no longer a member' });
    expect(sent).toHaveLength(0);
  });

  it('sends tests, lists and removes project Slack channels, and goes with its project', async () => {
    const own = (await call('POST', '/api/destinations', { name: 'Mine', url: 'https://mine.example.com/hook' }, ANNA)).body;
    sent.length = 0;
    expect((await call('POST', `/api/destinations/${own.id}/test`, undefined, ANNA)).body).toEqual({ ok: true, status: '200' });
    expect(JSON.parse(sent[0].body)).toMatchObject({ test: true, trigger: { name: 'Test notification' } });

    // a channel connected with "Add to Slack" (stored in integrations) shows up as a project destination
    const channel = crypto.randomUUID();
    await query(`INSERT INTO integrations (project_id, id, type, config, created_by) VALUES ($1, $2, 'slack', $3::jsonb, $4)`,
      [blog, channel, JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/T/B/x', channel: '#blog', teamName: 'Team' }), ANNA]);
    const list = (await call('GET', `/api/projects/${blog}/destinations`, undefined, ANNA)).body;
    expect(list[0]).toMatchObject({ id: channel, level: 'project', type: 'slack', name: '#blog', detail: 'Team', ref: { type: 'slack', integrationId: channel } });
    sent.length = 0;
    expect((await call('POST', `/api/projects/${blog}/destinations/${channel}/test`, undefined, ANNA)).body.ok).toBe(true);
    expect(JSON.parse(sent[0].body)).toHaveProperty('blocks');
    expect((await call('DELETE', `/api/projects/${blog}/destinations/${channel}`, undefined, ANNA)).status).toBe(200);
    expect(await query('SELECT 1 FROM integrations WHERE id = $1', [channel])).toHaveLength(0);

    // deleting a project removes its destinations, not anyone's own
    await call('POST', `/api/projects/${blog}/destinations`, { name: 'Blog hook', url: 'https://blog.example.com/hook' }, ANNA);
    expect((await call('DELETE', `/api/projects/${blog}`, undefined, ANNA)).status).toBe(200);
    expect(await query('SELECT 1 FROM destinations WHERE project_id = $1', [blog])).toHaveLength(0);
    expect((await call('GET', '/api/destinations', undefined, ANNA)).body.map((x: { name: string }) => x.name)).toEqual(['Mine']);
  });
  it('adds channels of a connected Slack workspace through the API, for the project or for yourself', async () => {
    const [projectWs, annaWs] = [crypto.randomUUID(), crypto.randomUUID()];
    await query(`INSERT INTO slack_workspaces (id, project_id, owner_email, team_id, team_name, bot_token, created_by) VALUES ($1, $2, NULL, 'T1', 'Acme', 'xoxb-shop', $3), ($4, NULL, $3, 'T1', 'Acme', 'xoxb-anna', $3)`,
      [projectWs, shop, ANNA, annaWs]);
    fetchMock.mockImplementation(async (u: string | URL, init?: RequestInit) => {
      const url = String(u);
      sent.push({ url, body: String(init?.body), headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.endsWith('/conversations.list')) return Response.json({ ok: true, channels: [{ id: 'C2', name: 'shop' }, { id: 'C1', name: 'alerts' }] });
      if (url.endsWith('/conversations.info')) return Response.json({ ok: true, channel: { id: 'C1', name: 'alerts' } });
      return Response.json({ ok: true });
    });
    try {
      const setup = (await call('GET', `/api/projects/${shop}/slack`, undefined, BO)).body;
      // Bo sees the project's workspace, not Anna's own
      expect(setup.workspaces.map((w: { id: string }) => w.id)).toEqual([projectWs]);
      expect((await call('GET', `/api/projects/${shop}/slack/workspaces/${annaWs}/channels`, undefined, BO)).status).toBe(404);
      const channels = await call('GET', `/api/projects/${shop}/slack/workspaces/${projectWs}/channels`, undefined, BO);
      expect(channels.body).toEqual([{ id: 'C1', name: '#alerts', private: false }, { id: 'C2', name: '#shop', private: false }]);
      expect(sent.at(-1)!.headers.authorization).toBe('Bearer xoxb-shop');

      const added = await call('POST', `/api/projects/${shop}/slack/workspaces/${projectWs}/channels`, { channelId: 'C1' }, BO);
      expect(added.body).toMatchObject({ level: 'project', type: 'slack', name: '#alerts', ref: { type: 'slack', integrationId: added.body.id } });
      const mine = await call('POST', `/api/projects/${shop}/slack/workspaces/${annaWs}/channels`, { channelId: 'C1' }, ANNA);
      expect(mine.body).toMatchObject({ level: 'account', type: 'slack', name: '#alerts', owner: ANNA });
      const list = (await call('GET', `/api/projects/${shop}/destinations`, undefined, ANNA)).body as Array<{ id: string }>;
      expect(list.map((x) => x.id)).toEqual(expect.arrayContaining([added.body.id, mine.body.id]));

      // the test notification posts with the workspace's bot token
      sent.length = 0;
      expect((await call('POST', `/api/destinations/${mine.body.id}/test`, undefined, ANNA)).body).toEqual({ ok: true, status: '200' });
      expect(sent[0]).toMatchObject({ url: 'https://slack.com/api/chat.postMessage', headers: { authorization: 'Bearer xoxb-anna' } });
      expect(JSON.parse(sent[0].body)).toMatchObject({ channel: 'C1', blocks: expect.any(Array) });

      expect((await call('DELETE', `/api/projects/${shop}/slack/workspaces/${projectWs}`, undefined, BO)).status).toBe(409);
      expect((await call('DELETE', `/api/projects/${shop}/destinations/${added.body.id}`, undefined, BO)).status).toBe(200);
      const after = await call('DELETE', `/api/projects/${shop}/slack/workspaces/${projectWs}`, undefined, BO);
      expect(after.status).toBe(200);
      expect(after.body.workspaces).toEqual([]); // Bo sees only the project's, now gone
    } finally {
      fetchMock.mockImplementation(async (u: string | URL, init?: RequestInit) => {
        sent.push({ url: String(u), body: String(init?.body), headers: (init?.headers ?? {}) as Record<string, string> });
        return new Response('ok', { status: 200 });
      });
    }
  });
});
