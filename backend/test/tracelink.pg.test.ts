/**
 * Browser → backend trace linking: a failed request the SDK reports with the traceparent it sent (props.trace /
 * props.span) shows up on its backend trace as a synthetic root span, and its failure group carries the trace id.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/live', () => ({ fanOut: vi.fn(async () => {}) }));

const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('trace linking (PostgreSQL)', async () => {
  // its own schema, so it can run alongside the other *.pg tests
  if (!process.env.DATABASE_URL) return;
  const BASE = process.env.DATABASE_URL;
  const isolated = new URL(BASE);
  isolated.searchParams.set('options', '-c search_path=tracelink_test');
  process.env.DATABASE_URL = isolated.toString();
  const { Client } = await import('pg');
  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { writeRows } = await import('../src/lib/store/write');
  const ingest = (await import('../src/handlers/ingest')).handler;
  const api = (await import('../src/handlers/api')).handler;

  const OWNER = 'tracelink@example.com';
  const now = Date.now();
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const BROWSER_SPAN = '00f067aa0ba902b7';
  let pid = '';

  const ev = (method: string, path: string, body?: string, q?: Record<string, string>) => ({
    rawPath: path, headers: {}, queryStringParameters: q, body, isBase64Encoded: false,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { email: OWNER } } } },
  }) as unknown as APIGatewayProxyEventV2;
  const call = async (method: string, path: string, opts: { body?: string; query?: Record<string, string> } = {}) => {
    const res = (await api(ev(method, path, opts.body, opts.query) as never)) as APIGatewayProxyStructuredResultV2;
    return { status: res.statusCode!, body: JSON.parse(res.body as string) };
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS tracelink_test CASCADE');
    await admin.query('CREATE SCHEMA tracelink_test');
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    const created = await call('POST', '/api/projects', { body: JSON.stringify({ name: 'Trace link' }) });
    pid = created.body.id;
    const batch = {
      k: created.body.writeKey, a: 'anon-t', sentAt: now, ctx: { sdk: 'wgo-js/0.1.0', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36' },
      e: [
        { id: crypto.randomUUID(), t: 'http_error', ts: now - 60_000, s: 'sess-t', url: 'https://shop.test/checkout', path: '/checkout',
          d: { method: 'POST', url: 'https://shop.test/api/checkout', status: 502, dur: 1200, kind: 'fetch', trace: TRACE, span: BROWSER_SPAN } },
        // an older failure of the same route without a trace (sent before the SDK propagated)
        { id: crypto.randomUUID(), t: 'http_error', ts: now - 120_000, s: 'sess-u', url: 'https://shop.test/checkout', path: '/checkout',
          d: { method: 'POST', url: 'https://shop.test/api/checkout', status: 502, dur: 900, kind: 'fetch' } },
      ],
    };
    expect(((await ingest(ev('POST', '/ingest', JSON.stringify(batch)))) as APIGatewayProxyStructuredResultV2).statusCode).toBe(202);
    const start = new Date(now - 61_150);
    await writeRows('spans', [{
      project_id: pid, start_time: start, span_id: 'a1b2c3d4e5f60718', trace_id: TRACE, parent_span_id: BROWSER_SPAN, name: 'POST /api/checkout',
      kind: 2, service: 'checkout', end_time: new Date(start.getTime() + 1100), duration_ms: 1100, status_code: 2, status_message: 'upstream timeout',
      attributes: {}, resource: { 'service.name': 'checkout' }, events: [],
    }]);
  });
  afterAll(async () => closeDb());

  it('puts the browser request on the trace as its root span', async () => {
    const t = await call('GET', `/api/projects/${pid}/traces/${TRACE}`, { query: { at: new Date(now - 61_000).toISOString() } });
    expect(t.status).toBe(200);
    expect(t.body.browser).toEqual([expect.objectContaining({ spanId: BROWSER_SPAN, method: 'POST', status: 502, sessionId: 'sess-t', path: '/checkout', durationMs: 1200 })]);
    const [root, server] = t.body.spans;
    expect(root).toMatchObject({ traceId: TRACE, spanId: BROWSER_SPAN, parentSpanId: null, service: 'browser', statusCode: 2, durationMs: 1200 });
    expect(server).toMatchObject({ parentSpanId: BROWSER_SPAN, service: 'checkout' });
  });

  it('gives the failure group the latest trace id', async () => {
    const r = await call('GET', `/api/projects/${pid}/http-errors`, { query: { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() } });
    expect(r.body).toEqual([expect.objectContaining({ route: 'shop.test/api/checkout', count: 2, sampleTraceId: TRACE })]);
  });

  it('a trace without browser requests has no browser part', async () => {
    await writeRows('spans', [{
      project_id: pid, start_time: new Date(now - 30_000), span_id: 'ffffffffffffffff', trace_id: 'f'.repeat(32), parent_span_id: null, name: 'cron',
      kind: 1, service: 'jobs', end_time: new Date(now - 29_000), duration_ms: 1000, status_code: 0, status_message: null, attributes: {}, resource: {}, events: [],
    }]);
    const t = await call('GET', `/api/projects/${pid}/traces/${'f'.repeat(32)}`);
    expect(t.body.browser).toBeUndefined();
    expect(t.body.spans).toHaveLength(1);
  });
});
