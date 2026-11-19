/** "Why did this change?" over real queries: a spike of errors on one page, browser and release, after a deploy. */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/live', () => ({ fanOut: vi.fn(async () => {}) }));

const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('explain (PostgreSQL)', async () => {
  // its own schema, so it can run alongside the other *.pg tests
  if (!process.env.DATABASE_URL) return;
  const BASE = process.env.DATABASE_URL;
  const isolated = new URL(BASE);
  isolated.searchParams.set('options', '-c search_path=explain_test');
  process.env.DATABASE_URL = isolated.toString();
  const { Client } = await import('pg');
  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const ingest = (await import('../src/handlers/ingest')).handler;
  const api = (await import('../src/handlers/api')).handler;

  const OWNER = 'explain@example.com';
  const MIN = 60_000;
  const now = Math.floor(Date.now() / MIN) * MIN;
  let pid = '';
  let writeKey = '';
  let goalId = '';

  const ev = (method: string, path: string, body?: string, q?: Record<string, string>) => ({
    rawPath: path, headers: {}, queryStringParameters: q, body, isBase64Encoded: false,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { email: OWNER } } } },
  }) as unknown as APIGatewayProxyEventV2;
  const call = async (method: string, path: string, opts: { body?: string; query?: Record<string, string> } = {}) => {
    const res = (await api(ev(method, path, opts.body, opts.query) as never)) as APIGatewayProxyStructuredResultV2;
    return { status: res.statusCode!, body: JSON.parse(res.body as string) };
  };
  const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
  const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

  async function send(ua: string, release: string, anon: string, events: object[]) {
    for (let i = 0; i < events.length; i += 500) {
      const batch = { k: writeKey, a: anon, sentAt: Date.now(), ctx: { sdk: 'wgo-js/0.1.0', ua, release }, e: events.slice(i, i + 500) };
      expect(((await ingest(ev('POST', '/ingest', JSON.stringify(batch)))) as APIGatewayProxyStructuredResultV2).statusCode).toBe(202);
    }
  }
  const e = (t: string, ts: number, s: string, path: string, d: object = {}) => ({ id: crypto.randomUUID(), t, ts, s, url: `https://shop.test${path}`, path, d });

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS explain_test CASCADE');
    await admin.query('CREATE SCHEMA explain_test');
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    const created = await call('POST', '/api/projects', { body: JSON.stringify({ name: 'Explain' }) });
    pid = created.body.id;
    writeKey = created.body.writeKey;
    goalId = (await call('POST', `/api/projects/${pid}/goals`, { body: JSON.stringify({ name: 'Signup', filters: [{ field: 'name', op: 'eq', value: 'signup' }] }) })).body.id;

    // two hours of steady Chrome traffic on 1.9.0: 2 errors a minute on /, sessions that sign up 1 in 4
    const steady: object[] = [];
    for (let m = 120; m > 0; m--) {
      const t = now - m * MIN;
      steady.push(e('error', t + 1000, `c${m}`, '/', { msg: 'Old flaky error', kind: 'error' }), e('error', t + 2000, `c${m}`, '/', { msg: 'Old flaky error', kind: 'error' }));
      for (let k = 0; k < 4; k++) {
        steady.push(e('pageview', t + 3000 + k, `c${m}-${k}`, '/'));
        if (k === 0) steady.push(e('custom', t + 4000, `c${m}-${k}`, '/', { name: 'signup' }));
      }
    }
    await send(CHROME, '1.9.0', 'anon-chrome', steady);
    // release 2.0.0 goes out 32 minutes ago; from 30 minutes ago Safari users on it hit 12 errors a minute on /checkout,
    // and none of their sessions sign up
    const spike: object[] = [];
    spike.push(e('pageview', now - 32 * MIN, 'deploy', '/'));
    for (let m = 30; m > 0; m--) {
      const t = now - m * MIN;
      for (let k = 0; k < 12; k++) spike.push(e('error', t + 100 * k, `sf${m}`, '/checkout', { msg: "TypeError: Cannot read properties of null (reading 'total')", kind: 'error' }));
      for (let k = 0; k < 10; k++) spike.push(e('pageview', t + 5000 + k, `sf${m}-${k}`, '/checkout'));
    }
    await send(SAFARI, '2.0.0', 'anon-safari', spike);
  });
  afterAll(async () => closeDb());

  const range = () => ({ from: new Date(now - 60 * MIN).toISOString(), to: new Date(now).toISOString() });

  it('explains an error spike: the segment, when it started and the release before it', async () => {
    const r = await call('GET', `/api/projects/${pid}/explain`, { query: { metric: 'events', where: JSON.stringify([{ field: 'type', op: 'eq', value: 'error' }]), ...range() } });
    expect(r.status).toBe(200);
    const x = r.body;
    expect(x).toMatchObject({ label: 'Errors', current: 480, previous: 120, significant: true });
    expect(x.ratio).toBeCloseTo(4);
    const keys = x.drivers.map((d: { dim: string; key: string }) => `${d.dim}:${d.key}`);
    expect(keys).toEqual(expect.arrayContaining(['path:/checkout', 'release:2.0.0', "error:TypeError: Cannot read properties of null (reading 'total')"]));
    expect(keys).not.toContain('path:/');
    const checkout = x.drivers.find((d: { key: string }) => d.key === '/checkout');
    expect(checkout).toMatchObject({ current: 360, previous: 0, share: 1, before: 0 });
    // started 30 minutes ago (± a bucket), 2 minutes after 2.0.0 was first seen
    expect(Math.abs(Date.parse(x.startedAt) - (now - 30 * MIN))).toBeLessThanOrEqual(2 * MIN);
    expect(x.release).toMatchObject({ kind: 'web', version: '2.0.0' });
    expect(x.summary).toMatch(/^Errors are up 4\.0× \(480 vs 120 before\)\. 100% of the increase is .+ It started around \d\d:\d\d UTC, \d+ minutes after release 2\.0\.0 was first seen\.$/);
    expect(x.series.length).toBe(120);
  });

  it('explains a conversion drop by segment', async () => {
    const r = await call('GET', `/api/projects/${pid}/explain`, { query: { metric: 'goal', goalId, ...range() } });
    expect(r.status).toBe(200);
    expect(r.body.significant).toBe(true);
    expect(r.body.current).toBeLessThan(r.body.previous);
    const keys = r.body.drivers.map((d: { dim: string; key: string }) => `${d.dim}:${d.key}`);
    expect(keys).toEqual(expect.arrayContaining(['release:2.0.0']));
    expect(r.body.summary).toMatch(/^Signup conversion is down \d+%/);
  });

  it('calls a flat metric noise, without drivers', async () => {
    const r = await call('GET', `/api/projects/${pid}/explain`, { query: { metric: 'events', where: JSON.stringify([{ field: 'errorMessage', op: 'eq', value: 'Old flaky error' }]), ...range() } });
    expect(r.body).toMatchObject({ current: 120, previous: 120, significant: false, drivers: [], startedAt: null });
    expect(r.body.summary).toBe("Matching events didn't change (120).");
  });

  it('rejects a bad metric', async () => {
    expect((await call('GET', `/api/projects/${pid}/explain`, { query: { metric: 'nope' } })).status).toBe(400);
  });
});
