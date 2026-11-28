/**
 * Development traffic end to end: the setting via the API, events from development pages dropped at ingest, no
 * recording slots or survey responses for them.
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
  const { closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { query } = await import('../src/lib/db');
  const ingest = (await import('../src/handlers/ingest')).handler;
  const api = (await import('../src/handlers/api')).handler;
  const R = await import('../src/lib/recordings');
  const S = await import('../src/lib/surveys');

  const OWNER = 'dev@example.com';
  const MEMBER = 'member@example.com';
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
  const view = (url: string) => ({ id: crypto.randomUUID(), t: 'pageview', ts: Date.now() - 1000, s: 'sess-d', url, path: new URL(url).pathname });
  const send = async (e: object[]) => {
    const batch = { k: writeKey, a: 'anon-d', sentAt: Date.now(), ctx: { sdk: 'wgo-js/0.1.0', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36' }, e };
    const res = (await ingest(ev('POST', '/ingest', JSON.stringify(batch)))) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(202);
    return JSON.parse(res.body as string).accepted as number;
  };
  const urls = async () => ((await call('GET', `/api/projects/${pid}/events`, undefined, { limit: '100' })).body.events as Array<{ url: string }>).map((e) => e.url).sort();

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

  it('keeps everything by default', async () => {
    expect((await call('GET', `/api/projects/${pid}`)).body.devTraffic).toEqual({ ignore: false, hosts: [] });
    expect(await send([view('http://localhost:5173/before')])).toBe(1);
    expect(await urls()).toEqual(['http://localhost:5173/before']);
  });

  it('validates the setting and lets only owners change it', async () => {
    expect((await call('PATCH', `/api/projects/${pid}`, { devTraffic: { ignore: 'yes' } })).status).toBe(400);
    expect((await call('PATCH', `/api/projects/${pid}`, { devTraffic: { hosts: ['bad host'] } })).status).toBe(400);
    expect((await call('PATCH', `/api/projects/${pid}`, { devTraffic: { ignore: true } }, undefined, MEMBER)).status).toBe(403);
    const res = await call('PATCH', `/api/projects/${pid}`, { devTraffic: { ignore: true, hosts: ['https://*.vercel.app/'] } });
    expect(res.status).toBe(200);
    // a settings-only PATCH doesn't touch the name
    expect(res.body).toMatchObject({ name: 'Pingis', devTraffic: { ignore: true, hosts: ['*.vercel.app'] } });
  });

  it('drops events from development pages at ingest and keeps the rest of the batch', async () => {
    const accepted = await send([
      view('http://localhost:5173/cart'), view('http://192.168.1.20:3000/'), view('https://pr-12-pingis.vercel.app/'),
      view('https://pingis.net/shop'), { ...view('https://pingis.net/shop'), url: 'app:/settings', path: '/settings' },
    ]);
    expect(accepted).toBe(2);
    expect(await urls()).toEqual(['app:/settings', 'http://localhost:5173/before', 'https://pingis.net/shop']);
  });

  it('gives development pages no recording slot', async () => {
    await R.saveSettings(pid, OWNER, { enabled: true, samplePercent: 100, triggers: [], maxPerHour: null, maxPerDay: null, maskAllText: false });
    expect(await R.startRecording({ k: writeKey, s: 'sess-local', a: 'anon-d', r: 'sample' }, Date.now(), 'http://localhost:5173')).toEqual({ ok: false });
    expect(await R.startRecording({ k: writeKey, s: 'sess-live', a: 'anon-d', r: 'sample' }, Date.now(), 'https://pingis.net')).toEqual({ ok: true });
  });

  it('accepts survey responses from development pages without storing them', async () => {
    // an unknown survey would be a 400 from a real page; from localhost it's never looked at
    expect(await S.respond({ k: writeKey, id: 'nope' }, 'http://localhost:5173')).toEqual({ ok: true });
    await expect(S.respond({ k: writeKey, id: 'nope' }, 'https://pingis.net')).rejects.toThrow();
  });

  it('turning it off keeps everything again', async () => {
    const res = await call('PATCH', `/api/projects/${pid}`, { devTraffic: { ignore: false, hosts: [] } });
    expect(res.body.devTraffic).toEqual({ ignore: false, hosts: [] });
    expect((await query<{ dev_traffic: unknown }>('SELECT dev_traffic FROM projects WHERE id = $1', [pid]))[0].dev_traffic).toBeNull();
    expect(await send([view('http://localhost:5173/after')])).toBe(1);
  });
});
