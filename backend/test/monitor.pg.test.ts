/** Threshold/anomaly triggers end to end: evaluation over stored events, firing → resolved, cooldown, preview. */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/live', () => ({ fanOut: vi.fn(async () => {}) }));

const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('monitor (PostgreSQL)', async () => {
  // its own schema, so it can run alongside the other *.pg tests
  if (!process.env.DATABASE_URL) return;
  const BASE = process.env.DATABASE_URL;
  const isolated = new URL(BASE);
  isolated.searchParams.set('options', '-c search_path=monitor_test');
  process.env.DATABASE_URL = isolated.toString();
  const { Client } = await import('pg');
  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { runMonitor } = await import('../src/lib/monitor');
  const ingest = (await import('../src/handlers/ingest')).handler;
  const api = (await import('../src/handlers/api')).handler;

  const OWNER = 'monitor@example.com';
  const MIN = 60_000;
  const now = Date.now() - 30 * 60_000; // in the past: ingest moves events more than 5 minutes in the future to "now"
  let pid = '';
  let writeKey = '';
  const sent: Array<Record<string, any>> = [];
  const realFetch = globalThis.fetch;

  const ev = (method: string, path: string, body?: string) => ({
    rawPath: path, headers: { origin: 'https://wgo.test' }, queryStringParameters: undefined, body, isBase64Encoded: false,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { email: OWNER } } } },
  }) as unknown as APIGatewayProxyEventV2;
  const call = async (method: string, path: string, body?: object) => {
    const res = (await api(ev(method, path, body && JSON.stringify(body)) as never)) as APIGatewayProxyStructuredResultV2;
    return { status: res.statusCode!, body: JSON.parse(res.body as string) };
  };
  const errorsAt = async (ts: number, n: number) => {
    const e = Array.from({ length: n }, (_, i) => ({ id: crypto.randomUUID(), t: 'error', ts: ts + i * 100, s: `s${ts}`, url: 'https://shop.test/checkout', path: '/checkout', d: { msg: 'Boom', kind: 'error' } }));
    const batch = { k: writeKey, a: 'anon-m', sentAt: Date.now(), ctx: { sdk: 'wgo-js/0.1.0', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36' }, e };
    expect(((await ingest(ev('POST', '/ingest', JSON.stringify(batch)))) as APIGatewayProxyStructuredResultV2).statusCode).toBe(202);
  };
  const trigger = (body: object) => call('POST', `/api/projects/${pid}/triggers`, { destination: { type: 'webhook', url: 'https://hooks.example.com/wgo' }, ...body });

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS monitor_test CASCADE');
    await admin.query('CREATE SCHEMA monitor_test');
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    const created = await call('POST', '/api/projects', { name: 'Monitor' });
    pid = created.body.id;
    writeKey = created.body.writeKey;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).startsWith('https://hooks.example.com')) { sent.push(JSON.parse(String(init.body))); return new Response('', { status: 200 }); }
      return realFetch(url, init);
    }));
  });
  afterAll(async () => { vi.unstubAllGlobals(); await closeDb(); });

  it('validates aggregate definitions', async () => {
    expect((await trigger({ name: 'x', kind: 'threshold', filters: [], metric: { agg: 'count' }, windowMinutes: 7, condition: { op: 'above', value: 1 } })).status).toBe(400);
    expect((await trigger({ name: 'x', kind: 'threshold', scope: 'logs', filters: [], metric: { agg: 'sessions' }, windowMinutes: 5, condition: { op: 'above', value: 1 } })).status).toBe(400);
    expect((await trigger({ name: 'x', kind: 'anomaly', filters: [], metric: { agg: 'p95' }, windowMinutes: 5, condition: { direction: 'up', sensitivity: 'high' } })).status).toBe(400);
    // a match trigger still needs filters
    expect((await trigger({ name: 'x', filters: [] })).status).toBe(400);
  });

  it('fires once, stays quiet while firing, resolves, and respects the cooldown', async () => {
    const t = await trigger({
      name: 'Error spike', kind: 'threshold', filters: [{ field: 'type', op: 'eq', value: 'error' }], metric: { agg: 'count' },
      windowMinutes: 5, condition: { op: 'above', value: 5 }, cooldownSeconds: 3600,
    });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ kind: 'threshold', windowMinutes: 5, status: { state: null } });
    await errorsAt(now - 3 * MIN, 12);

    expect(await runMonitor(now)).toMatchObject({ evaluated: 1, firing: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'threshold', state: 'firing', value: 12, windowMinutes: 5, trigger: { name: 'Error spike' } });

    await runMonitor(now + 30_000); // still firing: no second notification
    expect(sent).toHaveLength(1);

    await runMonitor(now + 10 * MIN); // the errors left the window
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ state: 'resolved', value: 0 });

    // firing again within the hour's cooldown is only counted
    await errorsAt(now + 9 * MIN, 12);
    await runMonitor(now + 12 * MIN);
    expect(sent).toHaveLength(2);
    const [row] = await query<{ state: string; suppressed: number; fire_count: number }>('SELECT state, suppressed, fire_count FROM triggers WHERE id = $1', [t.body.id]);
    expect(row).toMatchObject({ state: 'firing', suppressed: 1, fire_count: 1 });

    const list = (await call('GET', `/api/projects/${pid}/triggers`)).body;
    expect(list.find((x: { id: string }) => x.id === t.body.id).status).toMatchObject({ state: 'firing', lastValue: 12 });
    await call('PATCH', `/api/projects/${pid}/triggers/${t.body.id}`, { enabled: false });
  });

  it('notices silence', async () => {
    const t = await trigger({ name: 'No pageviews', kind: 'threshold', filters: [{ field: 'type', op: 'eq', value: 'pageview' }], metric: { agg: 'count' }, windowMinutes: 30, condition: { op: 'below', value: 1 } });
    sent.length = 0;
    await runMonitor(now);
    expect(sent).toEqual([expect.objectContaining({ state: 'firing', value: 0, trigger: expect.objectContaining({ name: 'No pageviews' }) })]);
    await call('PATCH', `/api/projects/${pid}/triggers/${t.body.id}`, { enabled: false });
  });

  it('anomaly triggers wait for enough history', async () => {
    const t = await trigger({ name: 'Unusual errors', kind: 'anomaly', filters: [{ field: 'type', op: 'eq', value: 'error' }], metric: { agg: 'count' }, windowMinutes: 15, condition: { direction: 'up', sensitivity: 'medium' } });
    sent.length = 0;
    await runMonitor(now);
    expect(sent).toHaveLength(0);
    const [row] = await query<{ state: string; baseline: unknown }>('SELECT state, baseline FROM triggers WHERE id = $1', [t.body.id]);
    expect(row).toMatchObject({ state: 'ok', baseline: null });
    await call('PATCH', `/api/projects/${pid}/triggers/${t.body.id}`, { enabled: false });
  });

  it('previews an unsaved definition', async () => {
    // the preview uses the real clock: the last hour holds both bursts of 12 errors
    const p = await call('POST', `/api/projects/${pid}/triggers/preview`, { kind: 'threshold', filters: [{ field: 'type', op: 'eq', value: 'error' }], metric: { agg: 'count' }, windowMinutes: 60, condition: { op: 'above', value: 5 } });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ value: 24, fires: true, baseline: null });
    const a = await call('POST', `/api/projects/${pid}/triggers/preview`, { kind: 'anomaly', filters: [], metric: { agg: 'count' }, windowMinutes: 15, condition: { direction: 'either', sensitivity: 'low' } });
    expect(a.body.note).toMatch(/Not enough history yet/);
  });
});
