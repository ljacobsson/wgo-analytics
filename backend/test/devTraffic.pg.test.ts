/**
 * Development traffic end to end: events from development pages are stored but flagged, left out of the numbers
 * unless dev=1 (separately from bots=1), counted as hidden sessions, and extra hosts come from the project setting.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/devTraffic.pg.test.ts
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/live', () => ({ fanOut: vi.fn(async () => {}) }));

const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('development traffic (PostgreSQL)', async () => {
  if (!process.env.DATABASE_URL) return;
  const BASE = process.env.DATABASE_URL;
  const isolated = new URL(BASE);
  isolated.searchParams.set('options', '-c search_path=dev_traffic_test');
  process.env.DATABASE_URL = isolated.toString();
  const { Client } = await import('pg');
  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const ingest = (await import('../src/handlers/ingest')).handler;
  const api = (await import('../src/handlers/api')).handler;
  const { fanOut } = await import('../src/lib/live');
  const { rollupHour, floorHour } = await import('../src/lib/rollups');

  const OWNER = 'dev@example.com';
  const MEMBER = 'member@example.com';
  const now = Date.now();
  const at = now - 2 * 3600_000; // a complete hour, so long ranges read it from the rollups
  let pid = '';
  let writeKey = '';
  const ev = (method: string, path: string, body?: string, q?: Record<string, string>, email = OWNER) => ({
    rawPath: path, headers: {}, queryStringParameters: q, body, isBase64Encoded: false,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { email } } } },
  }) as unknown as APIGatewayProxyEventV2;
  const call = async (method: string, path: string, body?: object, q?: Record<string, string>, email = OWNER) => {
    const res = (await api(ev(method, path, body && JSON.stringify(body), q, email) as never)) as APIGatewayProxyStructuredResultV2;
    return { status: res.statusCode!, body: JSON.parse(res.body as string) };
  };
  const view = (url: string, s: string) => ({ id: crypto.randomUUID(), t: 'pageview', ts: at, s, url, path: url.startsWith('app:') ? '/home' : new URL(url).pathname });
  const send = async (e: object[], ctx: object = {}) => {
    const batch = { k: writeKey, a: 'anon-d', sentAt: Date.now(), ctx: { sdk: 'wgo-js/0.1.0', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36', ...ctx }, e };
    const res = (await ingest(ev('POST', '/ingest', JSON.stringify(batch)))) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(202);
  };
  const range = (q: Record<string, string> = {}) => ({ from: new Date(now - 3600_000 * 3).toISOString(), to: new Date(now + 60_000).toISOString(), ...q });
  const urls = async (q: Record<string, string> = {}) =>
    ((await call('GET', `/api/projects/${pid}/events`, undefined, { limit: '100', ...q })).body.events as Array<{ url: string }>).map((e) => e.url).sort();

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS dev_traffic_test CASCADE');
    await admin.query('CREATE SCHEMA dev_traffic_test');
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    const created = await call('POST', '/api/projects', { name: 'Pingis' });
    pid = created.body.id;
    writeKey = created.body.writeKey;
    await call('POST', `/api/projects/${pid}/members`, { email: MEMBER });
  });
  afterAll(async () => closeDb());

  it('validates the extra hosts and lets only owners change them', async () => {
    expect((await call('GET', `/api/projects/${pid}`)).body.devTraffic).toEqual({ hosts: [] });
    expect((await call('PATCH', `/api/projects/${pid}`, { devTraffic: { hosts: ['bad host'] } })).status).toBe(400);
    expect((await call('PATCH', `/api/projects/${pid}`, { devTraffic: { hosts: ['*.vercel.app'] } }, undefined, MEMBER)).status).toBe(403);
    const res = await call('PATCH', `/api/projects/${pid}`, { devTraffic: { hosts: ['https://*.vercel.app/'] } });
    expect(res.status).toBe(200);
    // a settings-only PATCH doesn't touch the name
    expect(res.body).toMatchObject({ name: 'Pingis', devTraffic: { hosts: ['*.vercel.app'] } });
  });

  it('stores development traffic flagged, without live updates', async () => {
    vi.mocked(fanOut).mockClear();
    await send([view('http://localhost:5173/cart', 's-local'), view('http://192.168.1.20:3000/', 's-lan'), view('https://pr-12-pingis.vercel.app/', 's-preview'),
      view('https://pingis.net/shop', 's-real'), view('app:/home', 's-app')]);
    await send([view('https://pingis.net/scrape', 's-bot')], { wd: true });
    const live = vi.mocked(fanOut).mock.calls.flatMap((c) => c[1] as Array<{ url: string }>).map((e) => e.url).sort();
    expect(live).toEqual(['app:/home', 'https://pingis.net/shop']);
  });

  it('leaves it out of events unless dev=1, separately from bots', async () => {
    expect(await urls()).toEqual(['app:/home', 'https://pingis.net/shop']);
    expect(await urls({ bots: '1' })).toEqual(['app:/home', 'https://pingis.net/scrape', 'https://pingis.net/shop']);
    expect(await urls({ dev: '1' })).toEqual(['app:/home', 'http://192.168.1.20:3000/', 'http://localhost:5173/cart', 'https://pingis.net/shop', 'https://pr-12-pingis.vercel.app/']);
    expect(await urls({ bots: '1', dev: '1' })).toHaveLength(6);
  });

  it('counts hidden development and bot sessions separately, from raw events and from rollups', async () => {
    const short = (await call('GET', `/api/projects/${pid}/stats`, undefined, range())).body;
    expect(short).toMatchObject({ totals: { pageviews: 2 }, botSessions: 1, devSessions: 3 });
    expect((await call('GET', `/api/projects/${pid}/stats`, undefined, range({ dev: '1' }))).body).toMatchObject({ totals: { pageviews: 5 }, botSessions: 1 });
    expect((await call('GET', `/api/projects/${pid}/stats`, undefined, range({ dev: '1' }))).body.devSessions).toBeUndefined();

    await rollupHour(pid, floorHour(at));
    const long = { from: new Date(now - 5 * 86400_000).toISOString(), to: new Date(now + 60_000).toISOString() };
    expect((await call('GET', `/api/projects/${pid}/stats`, undefined, long)).body).toMatchObject({ totals: { pageviews: 2 }, botSessions: 1, devSessions: 3 });
    // including development traffic reads raw events (rollups hold human traffic only)
    expect((await call('GET', `/api/projects/${pid}/stats`, undefined, { ...long, dev: '1' })).body).toMatchObject({ totals: { pageviews: 5 } });
  });

  it('applies changed hosts to new events only', async () => {
    await call('PATCH', `/api/projects/${pid}`, { devTraffic: { hosts: [] } });
    expect((await query<{ dev_traffic: unknown }>('SELECT dev_traffic FROM projects WHERE id = $1', [pid]))[0].dev_traffic).toBeNull();
    await send([view('https://pr-13-pingis.vercel.app/', 's-preview-2')]);
    expect(await urls()).toContain('https://pr-13-pingis.vercel.app/');
    expect(await urls()).not.toContain('https://pr-12-pingis.vercel.app/');
  });
});
