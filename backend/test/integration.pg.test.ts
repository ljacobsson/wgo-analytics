/**
 * End-to-end over real SQL: runs the schema, the ingest + OTLP handlers and every API route against
 * PostgreSQL. DSQL is PostgreSQL-compatible; the only schema difference is `CREATE INDEX ASYNC`.
 *
 *   docker run -d --rm --name wgo-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/integration.pg.test.ts
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ProtobufTraceSerializer, JsonLogsSerializer, JsonMetricsSerializer } from '@opentelemetry/otlp-transformer';
import { context, SeverityNumber, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/live', () => ({ fanOut: vi.fn(async () => {}) }));

const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

type Res = APIGatewayProxyStructuredResultV2;

d('integration (PostgreSQL)', async () => {
  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const ingest = (await import('../src/handlers/ingest')).handler;
  const otlp = (await import('../src/handlers/otlp')).handler;
  const api = (await import('../src/handlers/api')).handler;
  const widget = (await import('../src/handlers/widget')).handler;
  const { fanOut } = await import('../src/lib/live');

  const OWNER = 'owner@example.com';
  let pid = '';
  let writeKey = '';
  const now = Date.now();

  const httpEvent = (method: string, path: string, opts: { body?: string | Buffer; headers?: Record<string, string>; query?: Record<string, string>; email?: string } = {}) => {
    const isBin = Buffer.isBuffer(opts.body);
    return {
      rawPath: path,
      headers: opts.headers ?? {},
      queryStringParameters: opts.query,
      body: isBin ? (opts.body as Buffer).toString('base64') : opts.body,
      isBase64Encoded: isBin,
      requestContext: { http: { method }, authorizer: { jwt: { claims: { email: opts.email ?? OWNER } } } },
    } as unknown as APIGatewayProxyEventV2;
  };
  const call = async <T = any>(method: string, path: string, opts: Parameters<typeof httpEvent>[2] = {}): Promise<{ status: number; body: T }> => {
    const res = (await api(httpEvent(method, path, opts) as never)) as Res;
    return { status: res.statusCode!, body: JSON.parse(res.body as string) };
  };
  const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };

  beforeAll(async () => {
    for (const t of ['projects', 'project_members', 'device_tokens', 'events', 'spans', 'logs', 'metric_points']) await query(`DROP TABLE IF EXISTS ${t}`);
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
  });
  afterAll(async () => closeDb());

  it('creates a project and manages members', async () => {
    const created = await call('POST', '/api/projects', { body: JSON.stringify({ name: 'Shop' }) });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: 'Shop', role: 'owner', writeKey: expect.stringMatching(/^wk_/) });
    pid = created.body.id;
    writeKey = created.body.writeKey;

    expect((await call('GET', '/api/me')).body.projects).toHaveLength(1);
    expect((await call('POST', `/api/projects/${pid}/members`, { body: JSON.stringify({ email: 'Friend@Example.com' }) })).body).toMatchObject({ email: 'friend@example.com', role: 'member' });
    expect((await call('GET', `/api/projects/${pid}/members`)).body).toHaveLength(2);
    // invited member sees the project and can read, but can't administer
    expect((await call('GET', '/api/me', { email: 'friend@example.com' })).body.projects[0]).toMatchObject({ id: pid, role: 'member' });
    expect((await call('POST', `/api/projects/${pid}/rotate-key`, { email: 'friend@example.com' })).status).toBe(403);
    // strangers get 404
    expect((await call('GET', `/api/projects/${pid}/stats`, { email: 'evil@example.com' })).status).toBe(404);
    expect((await call('DELETE', `/api/projects/${pid}/members/${encodeURIComponent(OWNER)}`)).status).toBe(400);
    expect((await call('PATCH', `/api/projects/${pid}`, { body: JSON.stringify({ name: 'Shop 2' }) })).body.name).toBe('Shop 2');
  });

  it('ingests SDK batches (plain and gzipped) and dedupes retries', async () => {
    const e = (t: string, d: object, extra: object = {}) => ({ id: crypto.randomUUID(), t, ts: now - 60_000, s: 'sess-1', url: 'https://shop.test/cart', path: '/cart', d, ...extra });
    const events = [
      e('pageview', {}, { ref: 'https://news.ycombinator.com/item?id=1' }),
      e('pageview', {}, { s: 'sess-2', path: '/', url: 'https://shop.test/', ref: 'https://shop.test/cart' }),
      e('click', { sel: 'button.buy', tag: 'button', text: 'Buy now', name: 'buy', rage: 3 }),
      e('click', { sel: 'button.buy', tag: 'button', text: 'Buy now', name: 'buy' }, { s: 'sess-2' }),
      e('click', { sel: 'a.home', tag: 'a', text: 'Home' }),
      e('error', { msg: 'TypeError: x is undefined', stack: 'TypeError\n    at a (https://shop.test/app.js:1:2)', kind: 'error', count: 4 }),
      e('http_error', { method: 'GET', url: 'https://api.shop.test/orders/123', status: 502, dur: 300, kind: 'fetch' }),
      e('custom', { name: 'checkout_started', props: { total: 99 } }),
      e('vitals', { lcp: 1800, fcp: 900, cls: 0.05, inp: 120, ttfb: 200 }),
    ];
    const batch = { k: writeKey, a: 'anon-1', sentAt: now, ctx: { sdk: 'wgo-js/0.1.0', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36' }, e: events };

    const plain = (await ingest(httpEvent('POST', '/ingest', { body: JSON.stringify(batch) }))) as Res;
    expect(plain.statusCode).toBe(202);
    expect(fanOut).toHaveBeenCalledWith(pid, expect.arrayContaining([expect.objectContaining({ type: 'click', trackName: 'buy' })]));

    // the same batch again, gzipped (as the SDK sends larger payloads): a retry must not duplicate rows
    const gz = (await ingest(httpEvent('POST', '/ingest', { body: gzipSync(JSON.stringify(batch)) }))) as Res;
    expect(gz.statusCode).toBe(202);
    const { rawQuery } = await import('../src/lib/store/duck');
    const [{ n }] = await rawQuery<{ n: number }>(pid, { from: new Date(0), to: new Date(now + 86400e3) }, 'SELECT count(*)::int AS n FROM events WHERE project_id = $1', [pid]);
    expect(n).toBe(events.length);

    // a second visitor, located by CloudFront in Gothenburg
    const located = { ...batch, a: 'anon-2', e: [e('pageview', {}, { s: 'sess-geo' }), e('click', { sel: 'a.home', tag: 'a', text: 'Home' }, { s: 'sess-geo' })] };
    const geoHeaders = { 'cloudfront-viewer-country': 'SE', 'cloudfront-viewer-city': 'Gothenburg', 'cloudfront-viewer-latitude': '57.70887', 'cloudfront-viewer-longitude': '11.97456' };
    expect(((await ingest(httpEvent('POST', '/ingest', { body: JSON.stringify(located), headers: geoHeaders }))) as Res).statusCode).toBe(202);

    const bad = (await ingest(httpEvent('POST', '/ingest', { body: JSON.stringify({ ...batch, k: 'wk_doesnotexist123' }) }))) as Res;
    expect(bad.statusCode).toBe(401);
  });

  it('serves product analytics', async () => {
    const stats = (await call('GET', `/api/projects/${pid}/stats`, { query: range })).body;
    expect(stats.totals).toMatchObject({ events: 11, pageviews: 3, clicks: 4, errors: 1, httpErrors: 1, sessions: 3, users: 2 });

    const geo = (await call('GET', `/api/projects/${pid}/geo`, { query: range })).body;
    const located = (await call('GET', `/api/projects/${pid}/events`, { query: { located: '1' } })).body.events;
    expect(located).toHaveLength(2);
    expect(located.every((e: any) => e.city === 'Gothenburg')).toBe(true);
    expect((await call('GET', `/api/projects/${pid}/events`, { query: { lat: '57.7', lon: '12', limit: '3' } })).body.events).toHaveLength(2);
    expect((await call('GET', `/api/projects/${pid}/events`, { query: { lat: '59.3', lon: '18.1' } })).body.events).toHaveLength(0);
    expect(geo).toEqual({
      points: [{ lat: 57.7, lon: 12, city: 'Gothenburg', country: 'SE', sessions: 1, events: 2 }],
      countries: [{ country: 'SE', sessions: 1, events: 2 }],
      located: 1,
      total: 3,
    });
    expect((await call('GET', `/api/projects/${pid}/breakdown`, { query: { ...range, dim: 'country' } })).body).toEqual([
      { key: 'Unknown', count: 2 }, { key: 'SE', count: 1 },
    ]);
    expect((await call('GET', `/api/projects/${pid}/breakdown`, { query: { ...range, dim: 'city' } })).body).toContainEqual({ key: 'Gothenburg, SE', count: 1 });
    expect(stats.previous.events).toBe(0);
    expect(stats.series.reduce((a: number, p: any) => a + p.click, 0)).toBe(4);

    const clicks = (await call('GET', `/api/projects/${pid}/clicks`, { query: range })).body;
    expect(clicks.find((c: any) => c.selector === 'button.buy')).toMatchObject({ trackName: 'buy', count: 2, sessions: 2, rageClicks: 1 });

    expect((await call('GET', `/api/projects/${pid}/pages`, { query: range })).body).toEqual(
      expect.arrayContaining([{ path: '/cart', views: 2, sessions: 2 }]),
    );

    const errors = (await call('GET', `/api/projects/${pid}/errors`, { query: range })).body;
    expect(errors[0]).toMatchObject({ message: 'TypeError: x is undefined', kind: 'error', count: 4 });
    expect(errors[0].series).toHaveLength(24);
    expect(errors[0].series.reduce((a: number, b: number) => a + b, 0)).toBe(4);

    const http = (await call('GET', `/api/projects/${pid}/http-errors`, { query: range })).body;
    expect(http[0]).toMatchObject({ method: 'GET', route: 'api.shop.test/orders/:id', status: 502, count: 1, avgDurationMs: 300 });

    expect((await call('GET', `/api/projects/${pid}/breakdown`, { query: { ...range, dim: 'browser' } })).body).toEqual([{ key: 'Chrome', count: 3 }]);
    // the in-app SPA navigation (shop.test -> shop.test) is not an external referrer
    expect((await call('GET', `/api/projects/${pid}/breakdown`, { query: { ...range, dim: 'referrer' } })).body).toEqual(
      expect.arrayContaining([{ key: 'news.ycombinator.com', count: 1 }, { key: '(direct)', count: 1 }]),
    );
    expect((await call('GET', `/api/projects/${pid}/breakdown`, { query: { ...range, dim: 'referrer' } })).body).toHaveLength(2);

    const vitals = (await call('GET', `/api/projects/${pid}/vitals`, { query: range })).body;
    expect(vitals).toMatchObject({ samples: 1, p75: { lcp: 1800, cls: 0.05 } });

    const page1 = (await call('GET', `/api/projects/${pid}/events`, { query: { limit: '5' } })).body;
    expect(page1.events).toHaveLength(5);
    expect(page1.nextBefore).toBeTruthy();
    const search = (await call('GET', `/api/projects/${pid}/events`, { query: { q: 'buy' } })).body;
    expect(search.events).toHaveLength(2);
    expect(search.events[0]).toMatchObject({ country: null, lat: null });
    const errs = (await call('GET', `/api/projects/${pid}/events`, { query: { type: 'error', fingerprint: errors[0].fingerprint } })).body;
    expect(errs.events[0].errorStack).toContain('app.js');
  });

  it('ingests OTLP (protobuf traces, gzipped JSON logs, JSON metrics) and serves them', async () => {
    const resource = resourceFromAttributes({ 'service.name': 'api' });
    const spanExporter = new InMemorySpanExporter();
    const tp = new TracerProvider({ resource, spanProcessors: [new SimpleSpanProcessor({ exporter: spanExporter })] });
    const tracer = tp.getTracer('t');
    const root = tracer.startSpan('POST /orders', { kind: SpanKind.SERVER });
    const child = tracer.startSpan('INSERT orders', { kind: SpanKind.CLIENT }, trace.setSpan(context.active(), root));
    child.setStatus({ code: SpanStatusCode.ERROR, message: 'boom' });
    child.end();
    root.end();
    await tp.forceFlush();
    const traceId = root.spanContext().traceId;

    const protoBody = Buffer.from(ProtobufTraceSerializer.serializeRequest(spanExporter.getFinishedSpans())!);
    const t = (await otlp(httpEvent('POST', '/v1/traces', { body: protoBody, headers: { 'content-type': 'application/x-protobuf', 'x-wgo-key': writeKey } }))) as Res;
    expect(t.statusCode).toBe(200);
    expect(t.headers?.['content-type']).toBe('application/x-protobuf');

    const logExporter = new InMemoryLogRecordExporter();
    const lp = new LoggerProvider({ resource, processors: [new SimpleLogRecordProcessor({ exporter: logExporter })] });
    trace.getSpan(trace.setSpan(context.active(), root));
    lp.getLogger('l').emit({ severityNumber: SeverityNumber.ERROR, body: 'order insert failed', context: trace.setSpan(context.active(), root) });
    lp.getLogger('l').emit({ severityNumber: SeverityNumber.INFO, body: 'hello' });
    await lp.forceFlush();
    const logsBody = gzipSync(Buffer.from(JsonLogsSerializer.serializeRequest(logExporter.getFinishedLogRecords())!));
    const l = (await otlp(httpEvent('POST', '/v1/logs', { body: logsBody, headers: { 'content-type': 'application/json', authorization: `Bearer ${writeKey}` } }))) as Res;
    expect(l.statusCode).toBe(200);

    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 });
    const mp = new MeterProvider({ resource, readers: [reader] });
    const counter = mp.getMeter('m').createCounter('http.requests');
    counter.add(5, { route: '/orders' });
    counter.add(2, { route: '/cart' });
    await reader.forceFlush();
    const metricsBody = Buffer.from(JsonMetricsSerializer.serializeRequest(metricExporter.getMetrics()[0])!).toString('utf8');
    const m = (await otlp(httpEvent('POST', '/v1/metrics', { body: metricsBody, headers: { 'content-type': 'application/json' }, query: { key: writeKey } }))) as Res;
    expect(m.statusCode).toBe(200);
    await mp.shutdown();

    expect(((await otlp(httpEvent('POST', '/v1/traces', { body: protoBody, headers: { 'content-type': 'application/x-protobuf' } }))) as Res).statusCode).toBe(401);

    const traces = (await call('GET', `/api/projects/${pid}/traces`, { query: range })).body;
    expect(traces[0]).toMatchObject({ traceId, rootName: 'POST /orders', service: 'api', spanCount: 2, errorCount: 1, services: ['api'] });
    expect((await call('GET', `/api/projects/${pid}/traces`, { query: { ...range, errorsOnly: '1', service: 'api', q: 'INSERT' } })).body).toHaveLength(1);
    expect((await call('GET', `/api/projects/${pid}/traces`, { query: { ...range, service: 'nope' } })).body).toHaveLength(0);

    const detail = (await call('GET', `/api/projects/${pid}/traces/${traceId}`)).body;
    expect(detail.spans.map((s: any) => s.name)).toEqual(['POST /orders', 'INSERT orders']);
    expect(detail.spans[1]).toMatchObject({ parentSpanId: root.spanContext().spanId, statusCode: 2, statusMessage: 'boom', kind: 3 });

    const services = (await call('GET', `/api/projects/${pid}/services`, { query: range })).body;
    expect(services[0]).toMatchObject({ service: 'api', spans: 2, errors: 1 });

    const logs = (await call('GET', `/api/projects/${pid}/logs`, { query: { ...range, severity: '17' } })).body;
    expect(logs.logs).toHaveLength(1);
    expect(logs.logs[0]).toMatchObject({ body: 'order insert failed', severityNumber: 17, service: 'api', traceId });
    expect((await call('GET', `/api/projects/${pid}/logs`, { query: { ...range, traceId } })).body.logs).toHaveLength(1);
    expect((await call('GET', `/api/projects/${pid}/logs`, { query: { ...range, q: 'HELLO' } })).body.logs).toHaveLength(1);

    const metrics = (await call('GET', `/api/projects/${pid}/metrics`, { query: range })).body;
    expect(metrics[0]).toMatchObject({ name: 'http.requests', type: 'sum', service: 'api', points: 2 });
    const series = (await call('GET', `/api/projects/${pid}/metrics/series`, { query: { ...range, name: 'http.requests', agg: 'max', groupBy: 'route' } })).body;
    const byKey = Object.fromEntries(series.series.map((s: any) => [s.key, s.points[0].value]));
    expect(byKey).toEqual({ '/orders': 5, '/cart': 2 });
    const p95 = (await call('GET', `/api/projects/${pid}/metrics/series`, { query: { ...range, name: 'http.requests', agg: 'p95' } })).body;
    expect(p95.series).toHaveLength(1);
    expect(p95.series[0].key).toBe('http.requests');
  });

  it('stores OTLP requests from the queue once, and drops ones with an unknown write key', async () => {
    const { queueHandler } = await import('../src/handlers/otlp');
    const logExporter = new InMemoryLogRecordExporter();
    const lp = new LoggerProvider({ resource: resourceFromAttributes({ 'service.name': 'queued' }), processors: [new SimpleLogRecordProcessor({ exporter: logExporter })] });
    lp.getLogger('l').emit({ severityNumber: SeverityNumber.WARN, body: 'via the queue' });
    lp.getLogger('l').emit({ severityNumber: SeverityNumber.WARN, body: 'via the queue' });
    await lp.forceFlush();
    const body = gzipSync(Buffer.from(JsonLogsSerializer.serializeRequest(logExporter.getFinishedLogRecords())!)).toString('base64');
    const record = (messageId: string, meta: string) => ({ messageId, body, messageAttributes: { meta: { stringValue: meta, dataType: 'String' } } });
    const event = (...records: ReturnType<typeof record>[]) => ({ Records: records }) as never;

    const good = record('m-1', `signal=logs\ncontent-type=application/json\nx-wgo-key=${writeKey}`);
    expect(await queueHandler(event(good, record('m-2', 'signal=logs\ncontent-type=application/json\nx-wgo-key=wk_doesnotexist000'), record('m-3', `signal=nope\nx-wgo-key=${writeKey}`)))).toEqual({ batchItemFailures: [] });
    expect(await queueHandler(event(good))).toEqual({ batchItemFailures: [] }); // SQS redelivery

    const found = (await call('GET', `/api/projects/${pid}/logs`, { query: { ...range, q: 'via the queue' } })).body.logs;
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ service: 'queued', severityNumber: 13 });
  });

  it('ingests SDK batches from the queue once, and drops ones with an unknown write key or invalid JSON', async () => {
    const { queueHandler } = await import('../src/handlers/ingest');
    const { rawQuery } = await import('../src/lib/store/duck');
    const count = async () => (await rawQuery<{ n: number }>(pid, { from: new Date(0), to: new Date(now + 86400e3) },
      "SELECT count(*)::int AS n FROM events WHERE project_id = $1 AND session_id = 'sess-queued'", [pid]))[0].n;
    // queued three days ago (kept out of the other tests' time windows; ts limits apply to the queue time).
    // The second event has no id: it gets one derived from the message id, so redelivery doesn't duplicate it.
    const sent = now - 3 * 86400e3;
    const events = [
      { id: crypto.randomUUID(), t: 'pageview', ts: sent - 30_000, s: 'sess-queued', url: 'https://shop.test/q', path: '/q' },
      { t: 'click', ts: sent - 29_000, s: 'sess-queued', url: 'https://shop.test/q', path: '/q', d: { sel: 'a.q', tag: 'a', text: 'Q' } },
    ];
    const batch = { a: 'anon-q', sentAt: sent, ctx: { ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36' }, e: events };
    const record = (messageId: string, body: Buffer, meta: string) => ({
      messageId, body: body.toString('base64'), attributes: { SentTimestamp: String(sent) }, messageAttributes: { meta: { stringValue: meta, dataType: 'String' } },
    });
    const event = (...records: ReturnType<typeof record>[]) => ({ Records: records }) as never;

    // write key from the query string, gzipped body, located by CloudFront
    const good = record('q-1', gzipSync(JSON.stringify(batch)), `source=sdk\nk=${writeKey}\ncloudfront-viewer-country=SE`);
    const unknownKey = record('q-2', Buffer.from(JSON.stringify({ ...batch, k: 'wk_doesnotexist123' })), 'source=sdk');
    const invalid = record('q-3', Buffer.from('{nope'), `source=sdk\nk=${writeKey}`);
    expect(await queueHandler(event(good, unknownKey, invalid))).toEqual({ batchItemFailures: [] });
    expect(await queueHandler(event(good))).toEqual({ batchItemFailures: [] }); // SQS redelivery
    expect(fanOut).toHaveBeenCalledWith(pid, expect.arrayContaining([expect.objectContaining({ type: 'click', sessionId: 'sess-queued', country: 'SE' })]));

    expect(await count()).toBe(events.length);
    const [{ ts }] = await rawQuery<{ ts: Date }>(pid, { from: new Date(0), to: new Date(now + 86400e3) },
      "SELECT min(ts) AS ts FROM events WHERE project_id = $1 AND session_id = 'sess-queued'", [pid]);
    expect(new Date(ts).getTime()).toBe(sent - 30_000);
  });

  it('pairs a device and serves the widget API with its token', async () => {
    const w = async <T = any>(path: string, token: string | undefined, query?: Record<string, string>, method = 'GET'): Promise<{ status: number; body: T }> => {
      const res = (await widget(httpEvent(method, path, { query, headers: token ? { authorization: `Bearer ${token}` } : {} }))) as Res;
      return { status: res.statusCode!, body: JSON.parse(res.body as string) };
    };
    const created = await call('POST', '/api/devices', { body: JSON.stringify({ name: 'Pixel 9' }) });
    expect(created.status).toBe(200);
    expect(created.body.device).toMatchObject({ name: 'Pixel 9', lastUsedAt: null });
    const token: string = created.body.token;
    expect(token).toMatch(/^dt_[A-Za-z0-9]{40}$/);
    // only the hash is stored
    const [stored] = await query<{ token_hash: string }>('SELECT token_hash FROM device_tokens');
    expect(stored.token_hash).not.toContain(token.slice(3));

    expect((await w('/widget/v1/me', undefined)).status).toBe(401);
    expect((await w('/widget/v1/me', 'dt_' + 'x'.repeat(40))).status).toBe(401);
    expect((await w('/widget/v1/me', token, undefined, 'POST')).status).toBe(405);
    const me = await w('/widget/v1/me', token);
    expect(me.body).toEqual({ email: OWNER, projects: [{ id: pid, name: 'Shop 2' }] });
    // the x-wgo-device header works too
    const viaHeader = (await widget(httpEvent('GET', '/widget/v1/me', { headers: { 'x-wgo-device': token } }))) as Res;
    expect(viaHeader.statusCode).toBe(200);

    // another user's device can't read this project
    const other = (await call('POST', '/api/devices', { email: 'evil@example.com', body: '{}' })).body.token;
    expect((await w(`/widget/v1/projects/${pid}/summary`, other, { stats: 'pageviews' })).status).toBe(404);

    const cat = (await w(`/widget/v1/projects/${pid}/catalog`, token)).body;
    const keys = cat.options.map((o: any) => o.key);
    expect(keys).toEqual(expect.arrayContaining(['visitors_now', 'pageviews', 'lcp', 'track:buy', 'event:checkout_started', 'metric:http.requests']));

    const stats = ['visitors_now', 'pageviews', 'sessions', 'users', 'clicks', 'errors', 'http_errors', 'top_page'];
    const s1 = await w(`/widget/v1/projects/${pid}/summary`, token, { range: '1h', stats: stats.join(',') });
    expect(s1.status).toBe(200);
    expect(s1.body.project).toEqual({ id: pid, name: 'Shop 2' });
    const by = Object.fromEntries(s1.body.stats.map((x: any) => [x.key, x]));
    expect(s1.body.stats.map((x: any) => x.key)).toEqual(stats); // order preserved
    expect(by.visitors_now).toMatchObject({ value: 3, previous: null, unit: 'count', page: 'live' });
    expect(by.visitors_now.series).toHaveLength(30);
    expect(by.pageviews).toMatchObject({ value: 3, previous: 0, better: 'up' });
    expect(by.pageviews.series).toHaveLength(24);
    expect(by.pageviews.series.reduce((a: number, b: number) => a + b, 0)).toBe(3);
    expect(by.sessions).toMatchObject({ value: 3, previous: 0 });
    expect(by.users).toMatchObject({ value: 2 });
    expect(by.clicks.value).toBe(4);
    expect(by.errors).toMatchObject({ value: 1, better: 'down', page: 'errors' });
    expect(by.http_errors).toMatchObject({ value: 1, page: 'network' });
    expect(by.top_page).toMatchObject({ unit: 'text', text: '/cart', value: 2 });

    const s2 = (await w(`/widget/v1/projects/${pid}/summary`, token, {
      range: '24h',
      stats: ['lcp', 'cls', 'top_country', 'traces', 'latency_p95', 'span_errors', 'log_errors', 'track:buy'].join(','),
    })).body;
    const by2 = Object.fromEntries(s2.stats.map((x: any) => [x.key, x]));
    expect(by2.lcp).toMatchObject({ value: 1800, rating: 'good', unit: 'ms' });
    expect(by2.lcp.series.every((v: number) => v === 1800)).toBe(true);
    expect(by2.cls).toMatchObject({ value: 0.05, unit: 'score', rating: 'good' });
    expect(by2.top_country).toMatchObject({ text: 'SE', value: 1 });
    expect(by2.traces).toMatchObject({ value: 1, previous: 0 });
    expect(by2.span_errors.value).toBe(1);
    expect(by2.latency_p95.value).toBeGreaterThanOrEqual(0);
    expect(by2.log_errors.value).toBe(1);
    expect(by2['track:buy']).toMatchObject({ label: 'buy', value: 2, page: 'clicks' });

    const s3 = (await w(`/widget/v1/projects/${pid}/summary`, token, { stats: `event:checkout_started,${encodeURIComponent('metric:http.requests')}` })).body;
    expect(s3.range).toBe('24h');
    expect(s3.stats[0]).toMatchObject({ key: 'event:checkout_started', value: 1 });
    expect(s3.stats[1]).toMatchObject({ key: 'metric:http.requests', unit: 'score', better: 'none' });
    expect(s3.stats[1].value).toBeGreaterThan(0);

    expect((await w(`/widget/v1/projects/${pid}/summary`, token, { stats: 'nope' })).status).toBe(400);
    expect((await w(`/widget/v1/projects/${pid}/summary`, token, { stats: 'pageviews', range: '2y' })).status).toBe(400);
    expect((await w(`/widget/v1/projects/${pid}/summary`, token, { stats: [...stats, 'lcp'].join(',') })).status).toBe(400);

    // overview: the same stats for every project the device's user can see
    const ov = await w('/widget/v1/overview', token, { range: '1h', stats: 'pageviews,visitors_now,errors' });
    expect(ov.status).toBe(200);
    expect(ov.body).toMatchObject({ range: '1h', total: 1 });
    expect(ov.body.projects).toHaveLength(1);
    expect(ov.body.projects[0].project).toEqual({ id: pid, name: 'Shop 2' });
    expect(ov.body.projects[0].error).toBeNull();
    expect(ov.body.projects[0].stats.map((x: any) => x.key)).toEqual(['pageviews', 'visitors_now', 'errors']);
    expect(ov.body.projects[0].stats[0]).toMatchObject({ value: 3, previous: 0 });
    expect((await w('/widget/v1/overview', other, { stats: 'pageviews' })).body).toMatchObject({ total: 0, projects: [] });
    expect((await w('/widget/v1/overview', token, { stats: 'top_page' })).status).toBe(400); // text stats don't fit a row
    expect((await w('/widget/v1/overview', token, { stats: 'track:buy' })).status).toBe(400); // per-project stats
    expect((await w('/widget/v1/overview', token, { stats: 'pageviews,sessions,users,errors' })).status).toBe(400);

    const list = (await call('GET', '/api/devices')).body;
    expect(list).toHaveLength(1);
    expect(list[0].lastUsedAt).toBeTruthy();
    expect((await call('DELETE', `/api/devices/${list[0].id}`, { email: 'evil@example.com' })).status).toBe(404);
    expect((await call('DELETE', `/api/devices/${list[0].id}`)).body).toEqual({ ok: true });
    expect((await w('/widget/v1/me', token)).status).toBe(401);
    expect((await call('GET', '/api/devices')).body).toHaveLength(0);
  });

  it('serves analytics over MCP to project members only', async () => {
    const { mcpFetch } = await import('../src/lib/mcp/http');
    let rpcId = 0;
    const tool = async (name: string, args: Record<string, unknown>, devEmail = OWNER) => {
      const res = await mcpFetch(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
        }),
        { publicOrigin: 'http://localhost', auth: null, devEmail },
      );
      const text = await res.text();
      const msg = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
      const result = msg.result as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: !!result.isError, text: result.content[0].text };
    };

    const projects = JSON.parse((await tool('list_projects', {})).text);
    expect(projects.projects.map((p: { id: string }) => p.id)).toContain(pid);

    const overview = await tool('get_overview', { projectId: pid, from: range.from, to: range.to });
    expect(overview.isError).toBe(false);
    expect(JSON.parse(overview.text).totals.events).toBeGreaterThan(0);

    const logs = JSON.parse((await tool('search_logs', { projectId: pid, minSeverity: 'error', range: '2h' })).text);
    expect(logs.logs.every((l: { severityNumber: number }) => l.severityNumber >= 17)).toBe(true);

    expect(await tool('get_overview', { projectId: pid }, 'stranger@example.com')).toEqual({ isError: true, text: 'Project not found' });
  });

  it('rotates the write key and invalidates the old one', async () => {
    const rotated = (await call('POST', `/api/projects/${pid}/rotate-key`)).body;
    expect(rotated.writeKey).not.toBe(writeKey);
    const res = (await ingest(httpEvent('POST', '/ingest', { body: JSON.stringify({ k: writeKey, a: 'x', sentAt: now, e: [] }) }))) as Res;
    expect(res.statusCode).toBe(401);
  });
});
