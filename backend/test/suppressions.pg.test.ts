/** Error suppression end to end: rules via the API, matching errors dropped at ingest, hits counted, groups marked. */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/live', () => ({ fanOut: vi.fn(async () => {}) }));

const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('error suppression (PostgreSQL)', async () => {
  if (!process.env.DATABASE_URL) return;
  const BASE = process.env.DATABASE_URL;
  const isolated = new URL(BASE);
  isolated.searchParams.set('options', '-c search_path=suppressions_test');
  process.env.DATABASE_URL = isolated.toString();
  const { Client } = await import('pg');
  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const ingest = (await import('../src/handlers/ingest')).handler;
  const api = (await import('../src/handlers/api')).handler;
  const { fanOut } = await import('../src/lib/live');
  const { rollupHour, runRerolls, floorHour } = await import('../src/lib/rollups');
  const errorRollup = async (hour: number) =>
    Number((await query<{ events: string }>(`SELECT events FROM rollups WHERE project_id = $1 AND dim = 'type' AND key = 'error' AND hour = $2`, [pid, new Date(hour)]))[0]?.events ?? 0);

  const OWNER = 'suppress@example.com';
  const now = Date.now();
  let pid = '';
  let writeKey = '';
  const ev = (method: string, path: string, body?: string, q?: Record<string, string>) => ({
    rawPath: path, headers: {}, queryStringParameters: q, body, isBase64Encoded: false,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { email: OWNER } } } },
  }) as unknown as APIGatewayProxyEventV2;
  const call = async (method: string, path: string, body?: object, q?: Record<string, string>) => {
    const res = (await api(ev(method, path, body && JSON.stringify(body), q) as never)) as APIGatewayProxyStructuredResultV2;
    return { status: res.statusCode!, body: JSON.parse(res.body as string) };
  };
  const img = (name: string, ts: number, page = '/rubbers') => ({
    id: crypto.randomUUID(), t: 'error', ts, s: 'sess-s', url: `https://pingis.test${page}`, path: page,
    d: { msg: 'Failed to load <img>', kind: 'resource', src: `https://api.pingis.net/materials/image/rubber/${name}` },
  });
  const send = async (e: object[]) => {
    const batch = { k: writeKey, a: 'anon-s', sentAt: Date.now(), ctx: { sdk: 'wgo-js/0.1.0', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36' }, e };
    expect(((await ingest(ev('POST', '/ingest', JSON.stringify(batch)))) as APIGatewayProxyStructuredResultV2).statusCode).toBe(202);
  };
  const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS suppressions_test CASCADE');
    await admin.query('CREATE SCHEMA suppressions_test');
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    const created = await call('POST', '/api/projects', { name: 'Pingis' });
    pid = created.body.id;
    writeKey = created.body.writeKey;
    // before any rule: two missing images and a real bug
    await send([img('stiga-carbo', now - 600_000), img('dhs-hurricane-3', now - 590_000),
      { id: crypto.randomUUID(), t: 'error', ts: now - 580_000, s: 'sess-s', url: 'https://pingis.test/cart', path: '/cart', d: { msg: 'TypeError: cart is null', kind: 'error' } }]);
    // rolled up before any rule: the hour counts all three errors
    await rollupHour(pid, floorHour(now - 600_000));
    if (floorHour(now - 580_000) !== floorHour(now - 600_000)) await rollupHour(pid, floorHour(now - 580_000));
  });
  afterAll(async () => closeDb());

  it('validates rules', async () => {
    expect((await call('POST', `/api/projects/${pid}/error-suppressions`, {})).status).toBe(400);
    expect((await call('POST', `/api/projects/${pid}/error-suppressions`, { message: '*' })).status).toBe(400);
    expect((await call('POST', `/api/projects/${pid}/error-suppressions`, { kind: 'nope' })).status).toBe(400);
    expect((await call('POST', `/api/projects/${pid}/error-suppressions`, { source: '/x' }, undefined)).status).toBe(200);
    const list = (await call('GET', `/api/projects/${pid}/error-suppressions`)).body;
    await call('DELETE', `/api/projects/${pid}/error-suppressions/${list[0].id}`);
    expect((await call('GET', `/api/projects/${pid}/error-suppressions`)).body).toEqual([]);
  });

  it('marks existing groups and drops new matching errors at ingest', async () => {
    const rule = (await call('POST', `/api/projects/${pid}/error-suppressions`, { kind: 'resource', source: 'https://api.pingis.net/materials/image/rubber/*' })).body;
    expect(rule).toMatchObject({ kind: 'resource', source: 'https://api.pingis.net/materials/image/rubber/*', message: null, page: null, hits: 0 });

    const before = (await call('GET', `/api/projects/${pid}/errors`, undefined, range)).body;
    expect(before.filter((g: { suppressedBy: string | null }) => g.suppressedBy === rule.id)).toHaveLength(2);
    expect(before.find((g: { message: string }) => g.message === 'TypeError: cart is null').suppressedBy).toBeNull();

    // the Overview no longer counts the suppressed errors stored before the rule
    const stats = (await call('GET', `/api/projects/${pid}/stats`, undefined, range)).body;
    expect(stats.totals.errors).toBe(1);
    expect(stats.series.reduce((a: number, p: { error: number }) => a + p.error, 0)).toBe(1);

    // and the maintenance job recounts the rolled hours
    const hours = [...new Set([floorHour(now - 600_000), floorHour(now - 580_000)])];
    const rolled = async () => (await Promise.all(hours.map(errorRollup))).reduce((a, b) => a + b, 0);
    expect(await rolled()).toBe(3);
    expect(await runRerolls(Date.now() + 60_000, floorHour(now) + 3600_000)).toMatchObject({ projects: 1 });
    expect(await rolled()).toBe(1);
    expect(await query(`SELECT 1 FROM job_state WHERE name = $1`, [`reroll:${pid}`])).toHaveLength(0);

    vi.mocked(fanOut).mockClear();
    await send([img('stiga-evo', now - 60_000), img('stiga-evo', now - 59_000), img('butterfly-tenergy-05', now - 58_000),
      { id: crypto.randomUUID(), t: 'pageview', ts: now - 57_000, s: 'sess-s', url: 'https://pingis.test/rubbers', path: '/rubbers' }]);
    // the pageview went live, the suppressed errors didn't
    expect(vi.mocked(fanOut).mock.calls.flatMap((c) => c[1] as Array<{ type: string }>).map((e) => e.type)).toEqual(['pageview']);

    const after = (await call('GET', `/api/projects/${pid}/errors`, undefined, range)).body;
    expect(after.map((g: { source: string | null }) => g.source).filter((s: string | null) => s?.includes('stiga-evo') || s?.includes('butterfly'))).toEqual([]);
    const [r] = (await call('GET', `/api/projects/${pid}/error-suppressions`)).body;
    expect(r).toMatchObject({ hits: 3, lastHitAt: expect.any(String) });
  });

  it('page patterns only drop errors on matching pages', async () => {
    await call('POST', `/api/projects/${pid}/error-suppressions`, { message: 'TypeError: *', page: '/admin/*' });
    const err = (page: string) => ({ id: crypto.randomUUID(), t: 'error', ts: now - 30_000, s: 'sess-t', url: `https://pingis.test${page}`, path: page, d: { msg: 'TypeError: x is undefined', kind: 'error' } });
    await send([err('/admin/users'), err('/shop')]);
    const groups = (await call('GET', `/api/projects/${pid}/errors`, undefined, range)).body;
    const g = groups.find((x: { message: string }) => x.message === 'TypeError: x is undefined');
    expect(g).toMatchObject({ count: 1, suppressedBy: null }); // only /shop's arrived; page rules don't mark groups
  });
});
