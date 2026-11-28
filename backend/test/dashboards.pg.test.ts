/**
 * Custom dashboards end to end against PostgreSQL (own schema): CRUD for members, validation of tiles and their
 * queries, adding a tile, duplication, kiosk access and the generic query through the API.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/dashboards.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Dashboard, DashboardSummary, DashboardTile, Kiosk, QueryResult } from '../src/contract';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'dashboards_test';

d('custom dashboards (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { createProject } = await import('../src/lib/projects');
  const { MAX_TILES } = await import('../src/lib/dashboards');
  const api = (await import('../src/handlers/api')).handler;
  const kiosk = (await import('../src/handlers/kiosk')).handler;

  const OWNER = 'owner@example.com';
  let pid = '';
  let other = '';

  type Res = APIGatewayProxyStructuredResultV2;
  const ev = (method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; query?: Record<string, string>; email?: string } = {}) =>
    ({
      rawPath: path, headers: opts.headers ?? {}, queryStringParameters: opts.query,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body), isBase64Encoded: false,
      requestContext: { http: { method }, authorizer: { jwt: { claims: { email: opts.email ?? OWNER } } } },
    }) as unknown as APIGatewayProxyEventV2;
  const call = async <T = any>(method: string, path: string, opts: Parameters<typeof ev>[2] = {}) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = (await api(ev(method, path, opts) as never)) as Res;
    return { status: r.statusCode!, body: JSON.parse(r.body as string) as T };
  };
  const screen = async <T = any>(token: string, path: string, q?: Record<string, string>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = (await kiosk(ev('GET', path, { headers: { authorization: `Bearer ${token}` }, query: q }))) as Res;
    return { status: r.statusCode!, body: JSON.parse(r.body as string) as T };
  };

  const tile = (o: Partial<DashboardTile> = {}): DashboardTile => ({
    id: 'pv', title: 'Pageviews', viz: 'line', layout: { x: 0, y: 0, w: 6, h: 4 },
    measures: [{ source: 'events', agg: 'count', filters: [{ field: 'type', op: 'eq', value: 'pageview' }], unit: 'count', better: 'up' }],
    ...o,
  });

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    pid = (await createProject(OWNER, 'Shop')).id;
    other = (await createProject('someone@example.com', 'Elsewhere')).id;
  });
  afterAll(async () => closeDb());

  let dash: Dashboard;

  it('creates, lists, reads and updates a dashboard', async () => {
    const created = await call<Dashboard>('POST', `/api/projects/${pid}/dashboards`, { body: { name: ' Growth ', config: { tiles: [tile()], range: '7d' } } });
    expect(created.status).toBe(200);
    dash = created.body;
    expect(dash).toMatchObject({ name: 'Growth', createdBy: OWNER, config: { range: '7d', tiles: [{ id: 'pv', viz: 'line' }] } });

    const list = await call<DashboardSummary[]>('GET', `/api/projects/${pid}/dashboards`);
    expect(list.body).toEqual([expect.objectContaining({ id: dash.id, name: 'Growth', tiles: 1 })]);

    const number = tile({ id: 'sessions', viz: 'number', layout: { x: 6, y: 0, w: 3, h: 2 }, measures: [{ source: 'events', agg: 'sessions' }] });
    const upd = await call<Dashboard>('PATCH', `/api/projects/${pid}/dashboards/${dash.id}`, {
      body: { name: 'Growth board', config: { tiles: [tile(), number], filters: [{ field: 'country', op: 'eq', value: 'SE' }] } },
    });
    expect(upd.status).toBe(200);
    expect(upd.body.name).toBe('Growth board');
    expect(upd.body.config.tiles.map((t) => t.id)).toEqual(['pv', 'sessions']);
    expect(upd.body.config.filters).toEqual([{ field: 'country', op: 'eq', value: 'SE' }]);
    expect(upd.body.config.range).toBeUndefined();
    expect(Date.parse(upd.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(dash.updatedAt));

    const got = await call<Dashboard>('GET', `/api/projects/${pid}/dashboards/${dash.id}`);
    expect(got.body).toEqual(upd.body);
    dash = got.body;
  });

  it('rejects broken tiles with a readable message', async () => {
    const bad = async (tiles: unknown[], match: RegExp) => {
      const r = await call<{ error: string }>('PATCH', `/api/projects/${pid}/dashboards/${dash.id}`, { body: { config: { tiles } } });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(match);
    };
    await bad([tile({ viz: 'radar' as never })], /Tile 1: viz/);
    await bad([tile({ layout: { x: 10, y: 0, w: 4, h: 2 } })], /Tile 1: x/);
    await bad([tile(), tile()], /unique/);
    await bad([tile({ measures: [{ source: 'events', agg: 'avg', field: 'nope' }] })], /Tile 1, measure 1: Unknown field/);
    await bad([tile({ viz: 'top' })], /top needs a groupBy/);
    await bad([tile({ groupBy: 'country; DROP TABLE x' })], /Unknown field/);
    await bad([tile({ measures: [{ source: 'events', agg: 'count', unit: 'furlongs' as never }] })], /unit/);
    await bad(Array.from({ length: MAX_TILES + 1 }, (_, i) => tile({ id: `t${i}` })), /at most/);
    // text tiles need no measures
    const ok = await call('PATCH', `/api/projects/${pid}/dashboards/${dash.id}`, {
      body: { config: { ...dash.config, tiles: [...dash.config.tiles, { id: 'note', viz: 'text', text: 'Shipped v2 on Monday', layout: { x: 0, y: 4, w: 12, h: 1 } }] } },
    });
    expect(ok.status).toBe(200);
  });

  it('adds a tile below the others and duplicates a dashboard', async () => {
    const added = await call<Dashboard>('POST', `/api/projects/${pid}/dashboards/${dash.id}/tiles`, {
      body: { viz: 'top', groupBy: 'service', title: 'Error logs by service', measures: [{ source: 'logs', agg: 'count', filters: [{ field: 'severityNumber', op: 'gte', value: '17' }] }] },
    });
    expect(added.status).toBe(200);
    const last = added.body.config.tiles.at(-1)!;
    expect(last).toMatchObject({ viz: 'top', groupBy: 'service', layout: { x: 0, y: 5, w: 6, h: 4 } });
    expect(last.id).toMatch(/^[A-Za-z0-9_-]+$/);

    const copy = await call<Dashboard>('POST', `/api/projects/${pid}/dashboards/${dash.id}/duplicate`);
    expect(copy.status).toBe(200);
    expect(copy.body).toMatchObject({ name: 'Growth board (copy)', config: added.body.config });
    expect(copy.body.id).not.toBe(dash.id);
  });

  it('keeps dashboards to project members', async () => {
    expect((await call('GET', `/api/projects/${pid}/dashboards`, { email: 'stranger@example.com' })).status).toBe(404);
    expect((await call('GET', `/api/projects/${other}/dashboards/${dash.id}`, { email: 'someone@example.com' })).status).toBe(404);
    expect((await call('GET', `/api/projects/${pid}/dashboards/not-a-uuid`)).status).toBe(404);
    expect((await call('DELETE', `/api/projects/${pid}/dashboards/${randomUUID()}`)).status).toBe(404);
  });

  it('runs the generic query through the API', async () => {
    const r = await call<QueryResult>('GET', `/api/projects/${pid}/query`, {
      query: { q: JSON.stringify({ shape: 'total', compare: true, measures: [{ source: 'events', agg: 'sessions' }] }) },
    });
    expect(r.status).toBe(200);
    expect(r.body.measures).toEqual([{ total: 0, previous: 0 }]);
    expect((await call('GET', `/api/projects/${pid}/query`, { query: { q: '{' } })).status).toBe(400);
  });

  it('shows a dashboard on a kiosk of the same project only', async () => {
    const k = (await call<Kiosk>('POST', `/api/projects/${pid}/kiosks`, { body: { name: 'TV' } })).body;
    const set = await call<Kiosk>('PATCH', `/api/projects/${pid}/kiosks/${k.id}`, { body: { config: { screens: [{ page: 'dashboard', params: `id=${dash.id}&range=24h` }] } } });
    expect(set.status).toBe(200);
    expect((await call('PATCH', `/api/projects/${pid}/kiosks/${k.id}`, { body: { config: { screens: [{ page: 'dashboard', params: 'range=24h' }] } } })).status).toBe(400);

    const got = await screen<Dashboard>(k.token, `/kiosk/v1/dashboards/${dash.id}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(dash.id);
    const q = await screen<QueryResult>(k.token, '/kiosk/v1/query', { q: JSON.stringify({ shape: 'total', measures: [{ source: 'events', agg: 'count' }] }) });
    expect(q.status).toBe(200);

    const foreign = (await call<Dashboard>('POST', `/api/projects/${other}/dashboards`, { email: 'someone@example.com', body: { name: 'Theirs' } })).body;
    expect((await screen(k.token, `/kiosk/v1/dashboards/${foreign.id}`)).status).toBe(404);
  });

  it('deletes a dashboard', async () => {
    expect((await call('DELETE', `/api/projects/${pid}/dashboards/${dash.id}`)).status).toBe(200);
    expect((await call('GET', `/api/projects/${pid}/dashboards/${dash.id}`)).status).toBe(404);
  });
});
