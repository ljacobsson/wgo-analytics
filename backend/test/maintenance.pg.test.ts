/**
 * Maintenance jobs against PostgreSQL (own schema) and Parquet in a temp directory: hourly rollups answer long
 * ranges like raw events do, retention deletes old raw data by whole days (never before it is rolled up) while
 * rollup-backed views keep working,
 * error stacks are stored once per group, and cluster metrics reach the triggers.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/maintenance.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'maintenance_test';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

d('maintenance (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();
  delete process.env.TRIGGER_FUNCTION; // deliver in-process
  delete process.env.MAX_RETENTION_DAYS;

  const { query, closeDb } = await import('../src/lib/db');
  const { writeRows } = await import('../src/lib/store/write');
  const { rawQuery } = await import('../src/lib/store/duck');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { storeErrorStacks } = await import('../src/lib/errorStacks');
  const R = await import('../src/lib/rollups');
  const { runRetention } = await import('../src/lib/retention');
  const { reportCluster } = await import('../src/lib/cluster');
  const A = await import('../src/lib/analytics');
  const P = await import('../src/lib/projects');
  const T = await import('../src/lib/triggers');
  type EventRow = import('../src/lib/events').EventRow;

  const OWNER = 'owner@x.test';
  const now = Date.now();
  const thisHour = R.floorHour(now);
  let pid = '';
  const RAW = JSON.stringify([{ field: 'type', op: 'set' }]); // any filter forces the raw path
  /** SQL over all of the project's raw files */
  const raw = <T,>(sql: string, params: unknown[] = []) => rawQuery<T>(pid, { from: new Date(0), to: new Date(now + DAY) }, sql, params);
  const floorDay = (t: number) => Math.floor(t / DAY) * DAY;

  const row = (o: Partial<EventRow> & Pick<EventRow, 'ts' | 'type'>): EventRow => ({
    project_id: pid, id: randomUUID(), session_id: null, anon_id: null, user_id: null, url: 'https://shop.test/', path: '/',
    title: null, referrer: null, selector: null, element_text: null, element_tag: null, track_name: null, error_message: null,
    error_stack: null, error_source: null, fingerprint: null, http_method: null, http_url: null, http_route: null, http_status: null,
    duration_ms: null, name: null, props: {}, browser: null, os: null, device: null, country: null, region: null, city: null,
    lat: null, lon: null, bot: null, ...o,
  });

  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    pid = (await P.createProject(OWNER, 'Shop')).id;

    // 5 days of traffic: 1-4 sessions per hour, each within its hour; 40 recurring users
    const rows: EventRow[] = [];
    for (let h = 1; h <= 5 * 24; h++) {
      const start = thisHour - h * HOUR;
      for (let i = 0; i < 1 + (h % 4); i++) {
        const s = { session_id: `s-${h}-${i}`, anon_id: `a-${(h * 7 + i) % 40}`, browser: i % 2 ? 'Firefox' : 'Chrome', country: i % 3 ? 'SE' : null };
        const t = start + (5 + i) * 60_000;
        rows.push(row({ ...s, ts: new Date(t), type: 'pageview', path: `/p${i % 3}`, referrer: i % 2 ? 'https://google.com/q' : null }));
        rows.push(row({ ...s, ts: new Date(t + 30_000), type: 'click', selector: 'button' }));
        if (h % 10 === 0) {
          rows.push(row({ ...s, ts: new Date(t + 60_000), type: 'error', error_message: 'Boom', fingerprint: 'fp-new', error_stack: 'Error: Boom\n    at app.js:1:1' }));
        }
      }
    }
    // bots: excluded from every count, but reported as botSessions
    for (let h = 2; h <= 40; h += 3) {
      rows.push(row({ session_id: `bot-${h}`, anon_id: `bot-${h}`, bot: 'user-agent', ts: new Date(thisHour - h * HOUR + 600_000), type: 'pageview', path: '/p0' }));
      rows.push(row({ session_id: `bot-${h}`, anon_id: `bot-${h}`, bot: 'user-agent', ts: new Date(thisHour - h * HOUR + 660_000), type: 'click', selector: 'a' }));
    }
    rows.push(row({ session_id: 'bot-now', bot: 'automation', ts: new Date(now - 30_000), type: 'pageview', path: '/p1' }));
    // not rolled up yet: the current hour
    rows.push(row({ session_id: 's-now', anon_id: 'a-now', browser: 'Chrome', ts: new Date(now - 60_000), type: 'pageview', path: '/p0' }));
    // stored before error_stacks existed: the stack lives on the row
    rows.push(row({ session_id: 's-old', ts: new Date(thisHour - 30 * HOUR), type: 'error', error_message: 'Old', fingerprint: 'fp-legacy', error_stack: 'Error: Old\n    at legacy.js:2:2' }));
    await storeErrorStacks(rows.filter((r) => r.fingerprint === 'fp-new'));
    await writeRows('events', rows.map((r) => (r.fingerprint === 'fp-new' ? { ...r, error_stack: null } : r)));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeDb();
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  const range = { from: new Date(thisHour - 4 * DAY).toISOString(), to: new Date(now).toISOString() };

  it('backfills hourly rollups up to the last complete hour', async () => {
    const res = await R.runRollups(Date.now() + 60_000);
    expect(res.caughtUp).toBe(true);
    expect(res.until).toBe(R.floorHour(now - 5 * 60_000));
    R.resetWatermarkCache();
    const again = await R.runRollups(Date.now() + 60_000);
    expect(again.hours).toBe(0);
  });

  it('counts spans, logs and metric points per hour, backfilling what is stored', async () => {
    const at = (t: number) => new Date(t);
    const span = (t: number) => ({ project_id: pid, start_time: at(t), end_time: at(t + 50), span_id: randomUUID(), trace_id: randomUUID(), name: 'GET /', service: 'api' });
    const log = (t: number) => ({ project_id: pid, ts: at(t), id: randomUUID(), body: 'hello', service: 'api' });
    const point = (t: number) => ({ project_id: pid, ts: at(t), id: randomUUID(), name: 'requests', type: 'sum', service: 'api', value: 1 });
    const spans = [], logs = [], points = [];
    // hours 2..72 back (the last hour may still be settling)
    for (let h = 2; h <= 3 * 24; h += 5) {
      const t = thisHour - h * HOUR + 120_000;
      spans.push(span(t), span(t + 1000));
      logs.push(log(t));
    }
    for (let i = 0; i < 3; i++) points.push(point(thisHour - 2 * HOUR + i * 1000));
    await writeRows('spans', [...spans, span(now)]); // the current hour isn't complete: not counted yet
    await writeRows('logs', logs);
    await writeRows('metric_points', points);
    const counts = async () => Object.fromEntries((await query<{ key: string; n: number }>(
      `SELECT key, sum(events)::int AS n FROM rollups WHERE project_id = $1 AND dim = 'signal' GROUP BY key`, [pid])).map((r) => [r.key, r.n]));

    const res = await R.runSignalCounts(Date.now() + 60_000, now);
    expect(res).toEqual({ until: R.floorHour(now - 5 * 60_000), caughtUp: true });
    expect(await counts()).toEqual({ spans: spans.length, logs: logs.length, metric_points: 3 });
    const [{ h }] = await query<{ h: Date }>(`SELECT min(hour) AS h FROM rollups WHERE project_id = $1 AND dim = 'signal' AND key = 'logs'`, [pid]);
    expect(h.getTime()).toBe(thisHour - 72 * HOUR);

    // an hour later: the hour before the watermark is counted again (a late batch), and the next one for the first time
    await writeRows('spans', [span(res.until - HOUR + 2000)]);
    await R.runSignalCounts(Date.now() + 60_000, now + HOUR);
    expect((await counts()).spans).toBe(spans.length + 2);
  });

  it('long ranges count hidden bot sessions from rollups', async () => {
    const [rolled, raw] = await Promise.all([A.stats(pid, range), A.stats(pid, { ...range, filters: RAW })]);
    expect(raw.botSessions).toBe(14); // 13 in rolled-up hours, 1 in the current hour (read raw)
    expect(rolled.botSessions).toBe(raw.botSessions);
    expect((await A.stats(pid, { ...range, bots: '1' })).botSessions).toBeUndefined();
  });

  it('long ranges from rollups match raw events', async () => {
    const [rolled, raw] = await Promise.all([A.stats(pid, range), A.stats(pid, { ...range, filters: RAW })]);
    expect(rolled.bucketSeconds).toBe(raw.bucketSeconds);
    for (const k of ['events', 'pageviews', 'clicks', 'errors'] as const) expect(rolled.totals[k]).toBe(raw.totals[k]);
    expect(rolled.totals.events).toBeGreaterThan(400);
    expect(Math.abs(rolled.totals.sessions - raw.totals.sessions) / raw.totals.sessions).toBeLessThan(0.03);
    expect(Math.abs(rolled.totals.users - raw.totals.users)).toBeLessThanOrEqual(1);
    expect(rolled.series.map((p) => p.pageview)).toEqual(raw.series.map((p) => p.pageview));
    expect(rolled.previous!.events).toBe(raw.previous!.events);
    expect((await A.stats(pid, { ...range, compare: '0' })).previous).toBeNull();
    expect(await A.totalsFor(pid, range)).toEqual(rolled.totals);
  });

  it('pages and breakdowns from rollups match raw events', async () => {
    expect(await A.pages(pid, range)).toEqual(await A.pages(pid, { ...range, filters: RAW }));
    for (const dim of ['browser', 'country', 'referrer']) {
      const sort = (rows: Array<{ key: string; count: number }>) => [...rows].sort((a, b) => a.key.localeCompare(b.key));
      expect(sort(await A.breakdown(pid, { ...range, dim }))).toEqual(sort(await A.breakdown(pid, { ...range, dim, filters: RAW })));
    }
  });

  it('the widget reads 7-day stats from rollups', async () => {
    const { summary } = await import('../src/lib/widget');
    const res = await summary({ id: pid, name: 'Shop' }, { range: '7d', stats: 'pageviews,sessions,users,top_page,top_country' });
    const stat = (k: string) => res.stats.find((s) => s.key === k)!;
    const [totals] = await raw<{ pv: number; s: number; u: number }>(
      `SELECT sum(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END)::int AS pv, count(DISTINCT session_id)::int AS s, count(DISTINCT anon_id)::int AS u
         FROM events WHERE project_id = $1 AND bot IS NULL`, [pid]);
    expect(stat('pageviews').value).toBe(totals.pv); // all data lies within the last 5 days
    expect(stat('pageviews').previous).toBe(0);
    expect(stat('pageviews').series.reduce((a, b) => a + b, 0)).toBe(totals.pv);
    expect(Math.abs(stat('sessions').value! - totals.s) / totals.s).toBeLessThan(0.03);
    expect(Math.abs(stat('users').value! - totals.u)).toBeLessThanOrEqual(1);
    expect(stat('top_page').text).toBe('/p0');
    expect(stat('top_country').text).toBe('SE');
  });

  it('error groups and events get their stack from error_stacks, or from legacy rows', async () => {
    const groups = await A.errors(pid, { from: new Date(thisHour - 5 * DAY).toISOString(), to: range.to });
    expect(groups.find((g) => g.fingerprint === 'fp-new')?.sampleStack).toContain('app.js');
    expect(groups.find((g) => g.fingerprint === 'fp-legacy')?.sampleStack).toContain('legacy.js');
    const stored = await raw<{ error_stack: string | null }>(`SELECT error_stack FROM events WHERE project_id = $1 AND fingerprint = 'fp-new'`, [pid]);
    expect(stored.every((r) => r.error_stack === null)).toBe(true);
    const evts = await A.events(pid, { from: new Date(thisHour - 5 * DAY).toISOString(), to: range.to, fingerprint: 'fp-new' });
    expect(evts.events[0].errorStack).toContain('app.js');
  });

  it('retention never deletes events that are not rolled up yet', async () => {
    const before = await A.stats(pid, range);
    await P.setRetention(OWNER, pid, 2);
    const notRolledBefore = thisHour - 4 * DAY;
    await runRetention(Date.now() + 60_000, notRolledBefore, Date.now(), Infinity, notRolledBefore);
    const [{ n }] = await raw<{ n: number }>('SELECT count(*)::int AS n FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3', [pid, new Date(notRolledBefore), new Date(now - 2 * DAY)]);
    expect(n).toBeGreaterThan(0);
    // spans, logs and metric points likewise wait until they are counted
    const [{ s }] = await raw<{ s: number }>('SELECT count(*)::int AS s FROM spans WHERE project_id = $1 AND start_time >= $2 AND start_time < $3', [pid, new Date(notRolledBefore), new Date(now - 2 * DAY)]);
    expect(s).toBeGreaterThan(0);
    // whole days go: the day that isn't completely rolled up stays
    const [{ old }] = await raw<{ old: number }>('SELECT count(*)::int AS old FROM events WHERE project_id = $1 AND ts < $2', [pid, new Date(floorDay(notRolledBefore))]);
    expect(old).toBe(0);
    expect((await A.stats(pid, range)).totals.events).toBe(before.totals.events);
  });

  it('retention deletes old raw data and stale stacks; rollups keep long ranges intact', async () => {
    const before = await A.stats(pid, range);
    await query(`DELETE FROM job_state WHERE name = 'retention'`);
    await query(`UPDATE error_stacks SET updated_at = $2 WHERE project_id = $1`, [pid, new Date(now - 3 * DAY)]);
    const res = await runRetention(Date.now() + 60_000, R.floorHour(now - 5 * 60_000));
    expect(res.done).toBe(true);
    expect(res.deleted.events).toBeGreaterThan(0);
    const [{ old }] = await raw<{ old: number }>('SELECT count(*)::int AS old FROM events WHERE project_id = $1 AND ts < $2', [pid, new Date(floorDay(now - 2 * DAY))]);
    expect(old).toBe(0);
    expect(await query('SELECT 1 FROM error_stacks WHERE project_id = $1', [pid])).toHaveLength(0);
    const after = await A.stats(pid, range);
    expect(after.totals.events).toBe(before.totals.events);
    expect(after.series).toEqual(before.series);
    // ranges older than retention, even short ones, come from rollups
    const day3 = { from: new Date(thisHour - 3 * DAY).toISOString(), to: new Date(thisHour - 2.5 * DAY).toISOString() };
    expect((await A.stats(pid, day3)).totals.pageviews).toBeGreaterThan(0);
    // runs once a day
    expect((await runRetention(Date.now() + 60_000, now)).deleted).toEqual({});
  });

  it('validates the retention setting', async () => {
    await expect(P.setRetention(OWNER, pid, 0)).rejects.toMatchObject({ status: 400 });
    await expect(P.setRetention(OWNER, pid, 401)).rejects.toThrow(/between 1 and 400/);
    await expect(P.setRetention(OWNER, pid, 7.5)).rejects.toMatchObject({ status: 400 });
    const p = await P.setRetention(OWNER, pid, 30);
    expect(p.retention).toEqual({ days: 30, defaultDays: 90, maxDays: 400 });
  });

  it('records cluster metrics and fires triggers on them', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    await T.createTrigger(pid, OWNER, {
      name: 'Cluster too big',
      filters: [{ field: 'name', op: 'eq', value: 'wgo.cluster' }, { field: 'props.storageGb', op: 'gt', value: '1' }],
      destination: { type: 'webhook', url: 'https://example.com/hook' },
    });
    process.env.CLUSTER_METRICS_PROJECT_ID = pid;
    process.env.DSQL_CLUSTER_ID = 'abc123';
    const read = vi.fn(async () => ({ storageBytes: 2_500_000_000, dpuLastHour: 1234.4, dpuLast24h: 20_000 }));
    const stats = await reportCluster(now, read);
    expect(read).toHaveBeenCalledWith('abc123', now);
    expect(stats?.storageBytes).toBe(2_500_000_000);
    const points = await raw<{ name: string; value: number }>(`SELECT name, value FROM metric_points WHERE project_id = $1 AND name LIKE 'wgo.%' ORDER BY name`, [pid]);
    expect(points).toEqual([{ name: 'wgo.dsql.dpu', value: 1234.4 }, { name: 'wgo.dsql.storage_bytes', value: 2_500_000_000 }]);
    const [evt] = await raw<{ props: Record<string, unknown> }>(`SELECT props FROM events WHERE project_id = $1 AND name = 'wgo.cluster'`, [pid]);
    expect(evt.props).toMatchObject({ storageGb: 2.5, dpuLastHour: 1234, dpuLast24h: 20000 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('https://example.com/hook', expect.anything()));
    // hourly
    expect(await reportCluster(now + 10 * 60_000, read)).toBeNull();
    delete process.env.CLUSTER_METRICS_PROJECT_ID;
  });
});
