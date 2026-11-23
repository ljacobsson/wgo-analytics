/**
 * The generic query behind custom dashboards (lib/query.ts), over every source (own schema, runs alongside the
 * other pg tests).
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/query.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MeasureQuery, QuerySpec } from '../src/contract';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'query_test';

d('generic query (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query: sql, closeDb } = await import('../src/lib/db');
  const { writeRows } = await import('../src/lib/store/write');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const A = await import('../src/lib/analytics');
  const Q = await import('../src/lib/query');

  const pid = randomUUID();
  const HOUR = 3600_000;
  const MIN = 60_000;
  const T0 = Math.floor(Date.now() / HOUR) * HOUR - 4 * HOUR;
  const at = (m: number) => new Date(T0 + m * MIN);
  const range = { from: at(0).toISOString(), to: at(180).toISOString() };
  const run = (spec: QuerySpec, extra: Record<string, string> = {}) => Q.query(pid, { ...range, q: JSON.stringify(spec), ...extra });
  const total = async (m: MeasureQuery, extra: Record<string, string> = {}) => (await run({ shape: 'total', measures: [m] }, extra)).measures[0].total;

  const ev = (o: Record<string, unknown>) => ({
    project_id: pid, id: randomUUID(), browser: 'Chrome', os: 'macOS', device: 'desktop', path: '/', url: 'https://shop.test/', ...o,
  });

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const s of SCHEMA_STATEMENTS) await sql(s.replace(' ASYNC ', ' '));
    await sql('INSERT INTO projects (id, name, write_key) VALUES ($1, $2, $3)', [pid, 'Query', 'wk_querytest0000001']);

    await writeRows('events', [
      ev({ ts: at(10), type: 'pageview', session_id: 's1', anon_id: 'a1', country: 'SE', path: '/' }),
      ev({ ts: at(11), type: 'click', session_id: 's1', anon_id: 'a1', country: 'SE', track_name: 'signup', selector: 'button' }),
      ev({ ts: at(12), type: 'vitals', session_id: 's1', anon_id: 'a1', country: 'SE', props: { lcp: 2000, inp: 100 } }),
      ev({ ts: at(70), type: 'pageview', session_id: 's2', anon_id: 'a2', country: 'DE', path: '/pricing' }),
      ev({ ts: at(71), type: 'vitals', session_id: 's2', anon_id: 'a2', country: 'DE', props: { lcp: 4000, inp: 300 } }),
      ev({ ts: at(72), type: 'custom', session_id: 's2', anon_id: 'a2', country: 'DE', name: 'checkout', props: { props: { amount: 50 } } }),
      ev({ ts: at(130), type: 'pageview', session_id: 's3', anon_id: 'a2', country: 'DE', path: '/pricing' }),
      ev({ ts: at(131), type: 'error', session_id: 's3', anon_id: 'a2', country: 'DE', error_message: 'Boom' }),
      ev({ ts: at(132), type: 'pageview', session_id: 'sb', anon_id: 'ab', country: 'US', bot: 'ua' }),
    ]);
    await writeRows('logs', [
      { project_id: pid, id: randomUUID(), ts: at(5), severity_number: 17, severity_text: 'ERROR', body: 'db down', service: 'api', attributes: {}, resource: {} },
      { project_id: pid, id: randomUUID(), ts: at(65), severity_number: 17, severity_text: 'ERROR', body: 'db down', service: 'api', attributes: {}, resource: {} },
      { project_id: pid, id: randomUUID(), ts: at(66), severity_number: 9, severity_text: 'INFO', body: 'ok', service: 'web', attributes: {}, resource: {} },
    ]);
    const span = (m: number, ms: number, status: number) => ({
      project_id: pid, span_id: randomUUID().slice(0, 16), trace_id: randomUUID(), parent_span_id: null, name: 'GET /a', kind: 2, service: 'api',
      start_time: at(m), end_time: new Date(at(m).getTime() + ms), duration_ms: ms, status_code: status, status_message: null,
      attributes: { 'http.route': '/a' }, resource: {}, events: [],
    });
    await writeRows('spans', [span(20, 100, 0), span(80, 200, 2), span(140, 300, 0)]);
    const point = (m: number, name: string, value: number, route: string) => ({
      project_id: pid, id: randomUUID(), ts: at(m), name, type: 'histogram', unit: 'ms', description: 'Request time', service: 'api', value, count: 1,
      attributes: { 'http.route': route },
    });
    await writeRows('metric_points', [point(15, 'http.server.duration', 10, '/a'), point(75, 'http.server.duration', 20, '/a'),
      point(135, 'http.server.duration', 30, '/b'), point(135, 'other.metric', 999, '/b')]);
    const check = (m: number, ok: number, ms: number) => ({ project_id: pid, id: randomUUID(), ts: at(m), check_id: 'c1', ok, status: ok ? 200 : 500, duration_ms: ms, error: null, region: 'eu-north-1' });
    await writeRows('checks', [check(1, 1, 100), check(61, 1, 120), check(121, 0, 900), check(170, 1, 110)]);
  });

  afterAll(async () => {
    await closeDb();
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('matches the Overview totals for the same window, bots left out', async () => {
    const t = await A.totalsFor(pid, range);
    const pageviews: MeasureQuery = { source: 'events', agg: 'count', filters: [{ field: 'type', op: 'eq', value: 'pageview' }] };
    expect(await total(pageviews)).toBe(t.pageviews);
    expect(t.pageviews).toBe(3);
    expect(await total({ source: 'events', agg: 'sessions' })).toBe(t.sessions);
    expect(await total({ source: 'events', agg: 'users' })).toBe(t.users);
    expect(await total(pageviews, { bots: '1' })).toBe(4);
  });

  it('matches the Web Vitals p75', async () => {
    const v = await A.vitals(pid, range);
    const lcp = await total({ source: 'events', agg: 'p75', field: 'props.lcp', filters: [{ field: 'type', op: 'eq', value: 'vitals' }] });
    expect(lcp).toBeCloseTo(v.p75.lcp!, 6);
  });

  it('returns a zero-filled series on the picked bucket, and the previous window', async () => {
    const r = await run({ shape: 'series', compare: true, measures: [{ source: 'events', agg: 'count', filters: [{ field: 'type', op: 'eq', value: 'pageview' }] }] });
    expect(r.bucketSeconds).toBe(A.pickBucket({ from: at(0), to: at(180) }));
    const m = r.measures[0];
    expect(m.series).toHaveLength(1);
    expect(m.series![0].points).toHaveLength(A.bucketStarts({ from: at(0), to: at(180) }, r.bucketSeconds).length);
    expect(m.series![0].points.reduce((a, p) => a + (p.value ?? 0), 0)).toBe(3);
    expect(m.series![0].points.filter((p) => p.value === 0).length).toBeGreaterThan(0);
    expect(m).toMatchObject({ total: 3, previous: 0 });
  });

  it('leaves empty buckets of averages and percentiles empty', async () => {
    const r = await run({ shape: 'series', measures: [{ source: 'spans', agg: 'avg', field: 'durationMs' }] });
    const pts = r.measures[0].series![0].points;
    expect(pts.filter((p) => p.value !== null).map((p) => p.value)).toEqual([100, 200, 300]);
    expect(pts.some((p) => p.value === null)).toBe(true);
  });

  it('splits by a field, biggest first, with a series per group', async () => {
    const top = await run({ shape: 'top', groupBy: 'country', measures: [{ source: 'events', agg: 'sessions' }] });
    expect(top.measures[0].groups).toEqual([{ key: 'DE', value: 2 }, { key: 'SE', value: 1 }]);
    const ser = await run({ shape: 'series', groupBy: 'country', limit: 1, measures: [{ source: 'events', agg: 'count' }] });
    expect(ser.measures[0].series!.map((s) => s.key)).toEqual(['DE']);
    expect(ser.measures[0].total).toBe(8);
    const path = await run({ shape: 'top', groupBy: 'path', measures: [{ source: 'events', agg: 'count', filters: [{ field: 'type', op: 'eq', value: 'pageview' }] }] });
    expect(path.measures[0].groups![0]).toEqual({ key: '/pricing', value: 2 });
  });

  it('computes conversion rate, custom event props and tracked clicks', async () => {
    expect(await total({ source: 'events', agg: 'session_rate', filters: [{ field: 'name', op: 'eq', value: 'checkout' }] })).toBeCloseTo(1 / 3, 6);
    expect(await total({ source: 'events', agg: 'sum', field: 'props.props.amount', filters: [{ field: 'name', op: 'eq', value: 'checkout' }] })).toBe(50);
    expect(await total({ source: 'events', agg: 'count', filters: [{ field: 'trackName', op: 'eq', value: 'signup' }] })).toBe(1);
  });

  it('reads logs, spans, metrics and uptime checks', async () => {
    expect(await total({ source: 'logs', agg: 'count', filters: [{ field: 'severityNumber', op: 'gte', value: '17' }] })).toBe(2);
    const logs = await run({ shape: 'top', groupBy: 'service', measures: [{ source: 'logs', agg: 'count' }] });
    expect(logs.measures[0].groups).toEqual([{ key: 'api', value: 2 }, { key: 'web', value: 1 }]);
    expect(await total({ source: 'spans', agg: 'p50', field: 'durationMs' })).toBe(200);
    expect(await total({ source: 'spans', agg: 'count', filters: [{ field: 'statusCode', op: 'eq', value: '2' }] })).toBe(1);
    expect(await total({ source: 'metrics', agg: 'avg', metric: 'http.server.duration' })).toBe(20);
    expect(await total({ source: 'metrics', agg: 'max', metric: 'http.server.duration', filters: [{ field: 'attributes.http.route', op: 'eq', value: '/a' }] })).toBe(20);
    const routes = await run({ shape: 'top', groupBy: 'attributes.http.route', measures: [{ source: 'metrics', agg: 'count', metric: 'http.server.duration' }] });
    expect(routes.measures[0].groups).toEqual([{ key: '/a', value: 2 }, { key: '/b', value: 1 }]);
    expect(await total({ source: 'checks', agg: 'rate' })).toBe(0.75);
    expect(await total({ source: 'checks', agg: 'max', filters: [{ field: 'checkId', op: 'eq', value: 'c1' }] })).toBe(900);
  });

  it('applies dashboard filters to events measures only, and runs several measures together', async () => {
    const r = await run({ shape: 'total', measures: [
      { source: 'events', agg: 'sessions' },
      { source: 'logs', agg: 'count' },
    ] }, { filters: JSON.stringify([{ field: 'country', op: 'eq', value: 'SE' }]) });
    expect(r.measures.map((m) => m.total)).toEqual([1, 3]);
  });

  it('returns null for an average with nothing to average', async () => {
    expect(await total({ source: 'spans', agg: 'avg', field: 'durationMs', filters: [{ field: 'service', op: 'eq', value: 'nope' }] })).toBeNull();
    expect(await total({ source: 'spans', agg: 'count', filters: [{ field: 'service', op: 'eq', value: 'nope' }] })).toBe(0);
  });

  it('rejects bad specs with a 400', async () => {
    const bad = async (spec: unknown) => expect(Q.query(pid, { ...range, q: JSON.stringify(spec) })).rejects.toMatchObject({ status: 400 });
    await bad({ shape: 'total', measures: [{ source: 'events', agg: 'count', filters: [{ field: 'type; DROP TABLE events', op: 'eq', value: 'x' }] }] });
    await bad({ shape: 'total', measures: [{ source: 'events', agg: 'avg', field: 'nope' }] });
    await bad({ shape: 'top', groupBy: 'x) OR 1=1 --', measures: [{ source: 'events', agg: 'count' }] });
    await bad({ shape: 'total', measures: [{ source: 'logs', agg: 'sessions' }] });
    await bad({ shape: 'total', measures: [{ source: 'metrics', agg: 'avg' }] });
    await bad({ shape: 'total', measures: [{ source: 'events', agg: 'avg' }] });
    await bad({ shape: 'top', measures: [{ source: 'events', agg: 'count' }] });
    await bad({ shape: 'total', measures: Array(5).fill({ source: 'events', agg: 'count' }) });
    await bad({ shape: 'top', groupBy: 'country', measures: [{ source: 'events', agg: 'count' }, { source: 'events', agg: 'sessions' }] });
    await bad({ shape: 'pie', measures: [{ source: 'events', agg: 'count' }] });
    await bad({ shape: 'total', measures: [{ source: 'visitor_days', agg: 'count' }] });
    await expect(Q.query(pid, { ...range })).rejects.toMatchObject({ status: 400 });
  });

  it('names uptime checks when splitting by check', async () => {
    const id = randomUUID();
    await sql(`INSERT INTO uptime_checks (project_id, id, name, url, method, expect, interval_seconds, timeout_ms, enabled, created_by)
               VALUES ($1, $2, 'Shop', 'https://shop.test', 'GET', '2xx', 300, 10000, true, 'x')`, [pid, id]);
    await writeRows('checks', [{ project_id: pid, id: randomUUID(), ts: at(30), check_id: id, ok: 1, status: 200, duration_ms: 50, error: null, region: 'eu-north-1' }]);
    const r = await run({ shape: 'top', groupBy: 'checkId', measures: [{ source: 'checks', agg: 'count' }] });
    expect(r.measures[0].groups).toEqual([{ key: 'c1', value: 4 }, { key: id, label: 'Shop', value: 1 }]);
  });

  it('lists the names the measure picker offers', async () => {
    const n = await Q.measureNames(pid);
    expect(n.trackedClicks).toEqual(['signup']);
    expect(n.customEvents).toEqual(['checkout']);
    expect(n.metrics.map((m) => m.name)).toEqual(['http.server.duration', 'other.metric']);
    expect(n.metrics[0]).toMatchObject({ type: 'histogram', unit: 'ms' });
  });

  it('discovers metric attribute keys and check fields for the field picker', async () => {
    const f = await A.fields(pid, { ...range, scope: 'metrics', metric: 'http.server.duration' });
    expect(f.discovered.map((x) => x.field)).toEqual(['attributes.http.route']);
    const c = await A.fields(pid, { ...range, scope: 'checks' });
    expect(c.builtin.map((x) => x.field)).toContain('checkId');
    const v = await A.fieldValues(pid, { ...range, scope: 'checks', field: 'region' });
    expect(v.values.map((x) => x.value)).toEqual(['eu-north-1']);
  });
});
