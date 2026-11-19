/**
 * Uptime checks and the cost cache against PostgreSQL; results are read back through DuckDB from Parquet files.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55443/postgres npx vitest run test/uptime.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'uptime_test';

d('uptime checks and costs (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();
  process.env.STACK_NAME = 'wgo-test';

  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const U = await import('../src/lib/uptime');
  const C = await import('../src/lib/costs');
  const { rawQuery } = await import('../src/lib/store/duck');

  const pid = randomUUID();
  const mk = (body: Record<string, unknown> = {}) => U.createCheck(pid, 'a@b.test', { name: 'Site', url: 'https://example.com/', intervalSeconds: 60, ...body });
  const win = { from: new Date(Date.now() - 3600e3), to: new Date(Date.now() + 3600e3) };
  const ok = (status: number) => ({ fetch: (async () => new Response('', { status })) as never });

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    await query('INSERT INTO projects (id, name, write_key) VALUES ($1, $2, $3)', [pid, 'P', 'wk_uptimetest000000']);
  });
  afterAll(() => closeDb());

  it('creates, validates, caps and updates checks', async () => {
    const c = await mk();
    expect(c).toMatchObject({ name: 'Site', state: null, method: 'GET', expect: '2xx', timeoutMs: 10000 });
    await expect(mk({ url: 'http://localhost/' })).rejects.toThrow();
    const u = await U.updateCheck(pid, c.id, { name: 'Renamed', intervalSeconds: 900 });
    expect(u).toMatchObject({ name: 'Renamed', intervalSeconds: 900, url: 'https://example.com/' });
    for (let i = 0; i < 19; i++) await mk({ name: `c${i}` });
    await expect(mk()).rejects.toThrow('at most 20');
    await query('DELETE FROM uptime_checks WHERE project_id = $1', [pid]);
  });

  it('runs due checks, records results and drives the state machine', async () => {
    const c = await mk({ name: 'Shop' });
    const t0 = Date.now();
    expect(await U.runChecks(t0, ok(200))).toBe(1); // first run: never checked, now up (no event)
    expect(await U.runChecks(t0 + 30_000, ok(500))).toBe(0); // not due yet
    expect(await U.runChecks(t0 + 56_000, ok(500))).toBe(1); // due within the 5 s slack: first failure, still up
    let [row] = await query<{ state: string; fail_streak: number; last_status: number }>('SELECT * FROM uptime_checks WHERE id = $1', [c.id]);
    expect(row).toMatchObject({ state: 'up', fail_streak: 1, last_status: 500 });
    await U.runChecks(t0 + 120_000, ok(500)); // second failure: down + event
    [row] = await query('SELECT * FROM uptime_checks WHERE id = $1', [c.id]);
    expect(row).toMatchObject({ state: 'down', fail_streak: 2 });
    await U.runChecks(t0 + 180_000, ok(200)); // recovery + event
    [row] = await query('SELECT * FROM uptime_checks WHERE id = $1', [c.id]);
    expect(row).toMatchObject({ state: 'up', fail_streak: 0 });

    const events = await rawQuery<{ props: string }>(pid, win, `SELECT props FROM events WHERE name = 'wgo.uptime' ORDER BY ts`);
    const states = events.map((e) => (typeof e.props === 'string' ? JSON.parse(e.props) : e.props).state);
    expect(states).toEqual(['down', 'up']);
    const rows = await rawQuery<{ ok: number }>(pid, win, `SELECT ok FROM checks WHERE check_id = '${c.id}' ORDER BY ts`);
    expect(rows.map((r) => r.ok)).toEqual([1, 0, 0, 1]);
  });

  it('exits early with no enabled checks', async () => {
    await query('UPDATE uptime_checks SET enabled = false WHERE project_id = $1', [pid]);
    expect(await U.runChecks(Date.now() + 1e7, ok(200))).toBe(0);
  });

  it('buckets results and finds incidents', async () => {
    const { writeRows } = await import('../src/lib/store/write');
    const c = await mk({ name: 'Buckets' });
    const t = Date.now() - 50 * 60_000;
    const rows = Array.from({ length: 30 }, (_, i) => ({
      project_id: pid, ts: new Date(t + i * 60_000), id: randomUUID(), check_id: c.id, ok: i >= 10 && i < 13 ? 0 : 1,
      status: i >= 10 && i < 13 ? 503 : 200, duration_ms: 100 + i, error: i >= 10 && i < 13 ? 'expected 2xx, got 503' : null, region: 'eu-north-1',
    }));
    await writeRows('checks', rows);
    const range = { from: new Date(t - 60_000), to: new Date(Date.now()) };
    const out = await U.results(pid, c.id, range);
    expect(out.buckets.length).toBeGreaterThan(0);
    expect(out.buckets.reduce((a, b) => a + b.checks, 0)).toBe(30);
    expect(out.buckets.reduce((a, b) => a + b.failures, 0)).toBe(3);
    expect(out.uptime).toBeCloseTo(27 / 30, 5);
    expect(out.p50).toBeGreaterThan(100);
    expect(out.p95!).toBeGreaterThanOrEqual(out.p50!);
    expect(out.incidents).toHaveLength(1);
    expect(out.incidents[0]).toMatchObject({ error: 'expected 2xx, got 503' });
    expect(out.incidents[0].to).not.toBeNull();

    const list = await U.listChecks(pid, range);
    const strip = list.find((x) => x.id === c.id)!.strip;
    expect(strip).toHaveLength(90);
    expect(strip.filter((v) => v !== null).length).toBeGreaterThan(0);
    expect(strip.some((v) => v !== null && v < 1)).toBe(true);
    const sum = await U.summary(pid, range);
    expect(sum.find((x) => x.id === c.id)!.uptime).toBeCloseTo(27 / 30, 5);
  });

  describe('costs', () => {
    const now = Date.UTC(2026, 10, 19, 10);
    let calls = 0;
    const ce = (fail: boolean, empty = false) => ({
      send: async () => {
        calls++;
        if (fail) throw new Error('AccessDeniedException');
        return {
          ResultsByTime: empty ? [] : [
            { TimePeriod: { Start: '2026-10-31', End: '2026-11-01' }, Groups: [{ Keys: ['AWS Lambda'], Metrics: { UnblendedCost: { Amount: '1.5', Unit: 'USD' } } }] },
            { TimePeriod: { Start: '2026-11-01', End: '2026-11-02' }, Groups: [{ Keys: ['AWS Lambda'], Metrics: { UnblendedCost: { Amount: '0.8', Unit: 'USD' } } }] },
          ],
        };
      },
    }) as never;
    const usage = async () => ({ dataBucketBytes: 123, dsqlStorageBytes: 456 });

    it('caches a result for 12 hours, then asks again', async () => {
      await query('INSERT INTO rollups (project_id, dim, hour, key, events, sessions) VALUES ($1, $2, $3, $4, $5, $6)', [pid, 'type', new Date(now - 3600e3), 'pageview', 1200, 0]);
      const a = await C.getCosts(pid, now, { ce: ce(false), usage });
      expect(a).toMatchObject({ setup: false, monthToDate: 0.8, lastMonth: 1.5, usage: { eventsThisMonth: 1200, projectEventsThisMonth: 1200, dataBucketBytes: 123, dsqlStorageBytes: 456 } });
      expect(calls).toBe(1);
      const [{ n }] = await query<{ n: string }>('SELECT count(*) AS n FROM cost_cache');
      expect(Number(n)).toBe(1);
      await C.getCosts(undefined, now + 11 * 3600e3, { ce: ce(false), usage });
      expect(calls).toBe(1);
      const b = await C.getCosts(undefined, now + 12 * 3600e3 + 1000, { ce: ce(false), usage });
      expect(calls).toBe(2);
      expect(b.usage.projectEventsThisMonth).toBeUndefined();
    });

    it('falls back to setup, cached for only 1 hour', async () => {
      await query('DELETE FROM cost_cache');
      calls = 0;
      const a = await C.getCosts(undefined, now, { ce: ce(true), usage });
      expect(a.setup).toBe(true);
      expect(a.reason).toContain('AccessDenied');
      expect(a.monthToDate).toBe(0);
      await C.getCosts(undefined, now + 30 * 60e3, { ce: ce(true), usage });
      expect(calls).toBe(1);
      await C.getCosts(undefined, now + 61 * 60e3, { ce: ce(false, true), usage });
      expect(calls).toBe(2); // empty results (tag not activated) are setup too
      expect((await C.getCosts(undefined, now + 62 * 60e3, { ce: ce(false), usage })).setup).toBe(true);
      expect(calls).toBe(2);
    });
  });
});
