/** Releases: first/last seen recorded at ingest, per-version health, comparison with the version before, markers. */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/live', () => ({ fanOut: vi.fn(async () => {}) }));

const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('releases (PostgreSQL)', async () => {
  // its own schema, so it can run alongside the other *.pg tests
  if (!process.env.DATABASE_URL) return;
  const BASE = process.env.DATABASE_URL;
  const isolated = new URL(BASE);
  isolated.searchParams.set('options', '-c search_path=releases_test');
  process.env.DATABASE_URL = isolated.toString();
  const { Client } = await import('pg');
  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { storeOtlpRows } = await import('../src/lib/otlp/ingest');
  const ingest = (await import('../src/handlers/ingest')).handler;
  const api = (await import('../src/handlers/api')).handler;

  const OWNER = 'releases@example.com';
  const now = Date.now();
  let pid = '';
  let writeKey = '';

  const ev = (method: string, path: string, body?: string, q?: Record<string, string>) => ({
    rawPath: path, headers: {}, queryStringParameters: q, body, isBase64Encoded: false,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { email: OWNER } } } },
  }) as unknown as APIGatewayProxyEventV2;
  const call = async (method: string, path: string, opts: { body?: string; query?: Record<string, string> } = {}) => {
    const res = (await api(ev(method, path, opts.body, opts.query) as never)) as APIGatewayProxyStructuredResultV2;
    return { status: res.statusCode!, body: JSON.parse(res.body as string) };
  };

  /** n sessions on `release`, `bad` of them hitting a JS error, each with a pageview, one vitals sample and maybe a signup. */
  async function sessions(release: string, at: number, n: number, bad: number, lcp: number, signups: number) {
    const e: object[] = [];
    for (let i = 0; i < n; i++) {
      const s = `${release}-s${i}`;
      const base = { s, url: 'https://shop.test/', path: '/' };
      e.push({ ...base, id: crypto.randomUUID(), t: 'pageview', ts: at + i * 1000 });
      e.push({ ...base, id: crypto.randomUUID(), t: 'vitals', ts: at + i * 1000 + 10, d: { lcp, inp: 100, cls: 0.01 } });
      if (i < bad) e.push({ ...base, id: crypto.randomUUID(), t: 'error', ts: at + i * 1000 + 20, d: { msg: release === '1.1.0' ? 'TypeError: cart is null' : 'Old bug', kind: 'error' } });
      if (i < signups) e.push({ ...base, id: crypto.randomUUID(), t: 'custom', ts: at + i * 1000 + 30, d: { name: 'signup' } });
    }
    for (let i = 0; i < e.length; i += 500) {
      const batch = { k: writeKey, a: `anon-${release}`, sentAt: now, ctx: { sdk: 'wgo-js/0.1.0', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36', release }, e: e.slice(i, i + 500) };
      const res = (await ingest(ev('POST', '/ingest', JSON.stringify(batch)))) as APIGatewayProxyStructuredResultV2;
      expect(res.statusCode).toBe(202);
    }
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS releases_test CASCADE');
    await admin.query('CREATE SCHEMA releases_test');
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    const created = await call('POST', '/api/projects', { body: JSON.stringify({ name: 'Releases' }) });
    pid = created.body.id;
    writeKey = created.body.writeKey;
    await call('POST', `/api/projects/${pid}/goals`, { body: JSON.stringify({ name: 'Signup', filters: [{ field: 'name', op: 'eq', value: 'signup' }] }) });
    await sessions('1.0.0', now - 3 * 3600_000, 100, 3, 1500, 20);
    await sessions('1.1.0', now - 3600_000, 100, 30, 2600, 5);
    const span = (version: string, at: number, i: number, err: boolean, dur: number) => ({
      project_id: pid, start_time: new Date(at + i * 1000), span_id: crypto.randomUUID().replace(/-/g, '').slice(0, 16), trace_id: crypto.randomUUID().replace(/-/g, ''),
      parent_span_id: null, name: 'GET /api', kind: 2, service: 'api', end_time: new Date(at + i * 1000 + dur), duration_ms: dur, status_code: err ? 2 : 1,
      status_message: null, attributes: {}, resource: { 'service.name': 'api', 'service.version': version }, events: [],
    });
    await storeOtlpRows('traces', Array.from({ length: 60 }, (_, i) => span('2024.1', now - 3 * 3600_000, i, false, 40)));
    await storeOtlpRows('traces', Array.from({ length: 60 }, (_, i) => span('2024.2', now - 3600_000, i, i < 20, 90)));
  });
  afterAll(async () => closeDb());

  it('records first and last seen per version', async () => {
    const rows = await query<{ kind: string; service: string; version: string; first_seen: Date; last_seen: Date }>(
      'SELECT kind, service, version, first_seen, last_seen FROM releases WHERE project_id = $1 ORDER BY first_seen', [pid]);
    expect(rows.map((r) => [r.kind, r.service, r.version])).toEqual([
      ['web', '', '1.0.0'], ['service', 'api', '2024.1'], ['web', '', '1.1.0'], ['service', 'api', '2024.2'],
    ]);
    const web10 = rows[0];
    expect(Math.abs(web10.first_seen.getTime() - (now - 3 * 3600_000))).toBeLessThan(2000);
    expect(web10.last_seen.getTime()).toBeGreaterThan(web10.first_seen.getTime());
  });

  it('compares each version with the one before it', async () => {
    const r = await call('GET', `/api/projects/${pid}/releases`, { query: { from: new Date(now - 6 * 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() } });
    expect(r.status).toBe(200);
    const [v11, v10] = r.body.web;
    expect(v10).toMatchObject({ version: '1.0.0', sessions: 100, errorSessions: 3, previous: null });
    expect(v11).toMatchObject({ version: '1.1.0', sessions: 100, errorSessions: 30, previous: '1.0.0' });
    expect(v11.verdicts).toMatchObject({ errorSessions: 'worse', lcp: 'worse', inp: null, failedRequestSessions: null });
    expect(v11.goals[0]).toMatchObject({ name: 'Signup', converted: 5, rate: 0.05 });
    expect(Object.entries(v11.verdicts).find(([k]) => k.startsWith('goal:'))?.[1]).toBe('worse');
    expect(v11.newErrors).toEqual([expect.objectContaining({ message: 'TypeError: cart is null', count: 30 })]);
    expect(v11.vitals.lcp).toBeCloseTo(2600);

    const svc = r.body.services;
    expect(svc.map((s: { version: string }) => s.version)).toEqual(['2024.2', '2024.1']);
    expect(svc[0]).toMatchObject({ service: 'api', spans: 60, errors: 20, previous: '2024.1', verdicts: { errorRate: 'worse', p95: 'worse' } });

    expect(r.body.markers.map((m: { version: string }) => m.version)).toEqual(['1.0.0', '2024.1', '1.1.0', '2024.2']);
  });

  it('only marks versions first seen inside the range', async () => {
    const r = await call('GET', `/api/projects/${pid}/releases`, { query: { from: new Date(now - 2 * 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() } });
    expect(r.body.markers.map((m: { version: string }) => m.version)).toEqual(['1.1.0', '2024.2']);
    // 1.0.0 isn't active in this range at all; 1.1.0 then has nothing to compare with
    expect(r.body.web.map((w: { version: string }) => w.version)).toEqual(['1.1.0']);
    expect(r.body.web[0].previous).toBeNull();
  });
});
