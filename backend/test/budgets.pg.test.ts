/** Cost budgets end to end: access, acknowledgement, alerts, pausing collection at ingest, resuming. */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CostsResponse } from '../src/contract';

vi.mock('../src/lib/live', () => ({ fanOut: vi.fn(async () => {}) }));

const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('budgets (PostgreSQL)', async () => {
  if (!process.env.DATABASE_URL) return;
  const BASE = process.env.DATABASE_URL;
  const isolated = new URL(BASE);
  isolated.searchParams.set('options', '-c search_path=budgets_test');
  process.env.DATABASE_URL = isolated.toString();
  const { Client } = await import('pg');
  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const B = await import('../src/lib/budgets');
  const ingest = (await import('../src/handlers/ingest')).handler;
  const api = (await import('../src/handlers/api')).handler;

  const OWNER = 'budget@example.com';
  let pid = '', other = '', writeKey = '';
  const ev = (method: string, path: string, body?: string, email = OWNER) => ({
    rawPath: path, headers: {}, queryStringParameters: undefined, body, isBase64Encoded: false,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { email } } } },
  }) as unknown as APIGatewayProxyEventV2;
  const call = async (method: string, path: string, body?: object, email = OWNER) => {
    const res = (await api(ev(method, path, body && JSON.stringify(body), email) as never)) as APIGatewayProxyStructuredResultV2;
    return { status: res.statusCode!, body: JSON.parse(res.body as string) };
  };
  const costs = (monthToDate: number): CostsResponse => ({
    setup: false, currency: 'USD', monthToDate, lastMonth: 10, forecast: monthToDate * 2, daily: [], services: [], categories: [],
    usage: { eventsThisMonth: 0, dataBucketBytes: null, dsqlStorageBytes: null }, fetchedAt: new Date().toISOString(),
  });
  const pageview = async () => {
    const batch = { k: writeKey, a: 'anon-b', sentAt: Date.now(), ctx: { sdk: 'wgo-js/0.1.0' }, e: [{ id: crypto.randomUUID(), t: 'pageview', ts: Date.now() - 1000, s: 's1', url: 'https://shop.test/', path: '/' }] };
    return JSON.parse(String(((await ingest(ev('POST', '/ingest', JSON.stringify(batch)))) as APIGatewayProxyStructuredResultV2).body)).accepted;
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS budgets_test CASCADE');
    await admin.query('CREATE SCHEMA budgets_test');
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    const a = (await call('POST', '/api/projects', { name: 'Shop' })).body;
    pid = a.id; writeKey = a.writeKey;
    other = (await call('POST', '/api/projects', { name: 'Blog' })).body.id;
    // this month: Shop has 75% of the install's events
    const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1, 1));
    await query(`INSERT INTO rollups (project_id, dim, hour, key, events, sessions) VALUES ($1, 'type', $3, 'pageview', 300, 0), ($2, 'type', $3, 'pageview', 100, 0)`, [pid, other, month]);
  });
  afterAll(async () => closeDb());

  it('needs the acknowledgement, a valid limit and project ownership', async () => {
    expect((await call('POST', '/api/costs/budgets', { scope: 'install', monthlyLimit: 10, alertAt: [50], alertOnForecast: false, pauseAtLimit: false, destination: null })).status).toBe(400);
    expect((await call('POST', '/api/costs/budgets', { scope: 'install', monthlyLimit: -1, alertAt: [50], alertOnForecast: false, pauseAtLimit: false, destination: null, acknowledged: true })).status).toBe(400);
    expect((await call('POST', '/api/costs/budgets', { scope: 'project', projectId: pid, monthlyLimit: 5, alertAt: [], alertOnForecast: false, pauseAtLimit: false, destination: null, acknowledged: true }, 'stranger@example.com')).status).toBe(403);
    expect((await call('GET', '/api/costs/budgets', undefined, 'stranger@example.com')).status).toBe(403);
  });

  it('is for admins only: a new account that creates a project sees neither costs nor budgets', async () => {
    const NEWCOMER = 'newcomer@example.com';
    expect((await call('POST', '/api/projects', { name: 'Mine' }, NEWCOMER)).status).toBe(200);
    // no ADMIN_EMAILS: the owners of the oldest project are the admins
    expect((await call('GET', '/api/me')).body.admin).toBe(true);
    expect((await call('GET', '/api/me', undefined, NEWCOMER)).body.admin).toBe(false);
    expect((await call('GET', '/api/costs', undefined, NEWCOMER)).status).toBe(403);
    expect((await call('GET', '/api/costs/budgets', undefined, NEWCOMER)).status).toBe(403);
    expect((await call('POST', '/api/costs/budgets', { scope: 'install', monthlyLimit: 1, alertAt: [], alertOnForecast: false, pauseAtLimit: true, destination: null, acknowledged: true }, NEWCOMER)).status).toBe(403);
    // ADMIN_EMAILS decides when set, even for someone who owns no project
    process.env.ADMIN_EMAILS = ' Ops@Example.com , newcomer@example.com';
    try {
      expect((await call('GET', '/api/me')).body.admin).toBe(false);
      expect((await call('GET', '/api/costs/budgets')).status).toBe(403);
      expect((await call('GET', '/api/costs/budgets', undefined, 'ops@example.com')).status).toBe(200);
      expect((await call('GET', '/api/me', undefined, NEWCOMER)).body.admin).toBe(true);
    } finally {
      delete process.env.ADMIN_EMAILS;
    }
  });

  it('estimates a project’s share, alerts, pauses collection and resumes', async () => {
    const created = await call('POST', '/api/costs/budgets', { scope: 'project', projectId: pid, monthlyLimit: 30, alertAt: [50, 100], alertOnForecast: true, pauseAtLimit: true, destination: null, acknowledged: true });
    expect(created.status).toBe(200);
    const id = created.body.id;
    expect(created.body).toMatchObject({ scope: 'project', projectName: 'Shop', monthlyLimit: 30 });

    expect(await pageview()).toBe(1);
    // install spent $20 so far: Shop's share is 75% → $15, half its budget, forecast $30
    await B.checkBudgets({ costs: async () => costs(20) });
    let b = (await call('GET', '/api/costs/budgets')).body.find((x: { id: string }) => x.id === id);
    expect(b.status).toMatchObject({ spent: 15, forecast: 30, estimated: true, alerted: [50], forecastAlerted: false, paused: false, lastStatus: 'shown in WGO' });

    // $44 → $33 for Shop: over its budget, collection stops
    await B.checkBudgets({ costs: async () => costs(44) });
    b = (await call('GET', '/api/costs/budgets')).body.find((x: { id: string }) => x.id === id);
    expect(b.status).toMatchObject({ spent: 33, alerted: [50, 100], paused: true });
    expect(await pageview()).toBe(0);
    expect(await B.collectionPaused(other)).toBe(false);

    const resumed = (await call('POST', `/api/costs/budgets/${id}/resume`)).body;
    expect(resumed.status).toMatchObject({ paused: false, resumed: true });
    expect(await pageview()).toBe(1);
    await B.checkBudgets({ costs: async () => costs(60) }); // resumed holds for the month
    expect(await B.collectionPaused(pid)).toBe(false);
  });

  it('an install budget pauses every project; raising the limit resumes', async () => {
    const { body } = await call('POST', '/api/costs/budgets', { scope: 'install', monthlyLimit: 50, alertAt: [100], alertOnForecast: false, pauseAtLimit: true, destination: null, acknowledged: true });
    await B.checkBudgets({ ids: [body.id], costs: async () => costs(60) });
    expect(await B.collectionPaused(pid)).toBe(true);
    expect(await B.collectionPaused(other)).toBe(true);
    // a higher limit takes effect on save (checked right away; Cost Explorer's cached numbers here: none, so stub)
    await query('UPDATE budgets SET monthly_limit = 100 WHERE id = $1', [body.id]);
    await B.checkBudgets({ ids: [body.id], costs: async () => costs(60) });
    expect(await B.collectionPaused(other)).toBe(false);
    await call('DELETE', `/api/costs/budgets/${body.id}`);
    expect((await call('GET', '/api/costs/budgets')).body.some((x: { id: string }) => x.id === body.id)).toBe(false);
  });
});
