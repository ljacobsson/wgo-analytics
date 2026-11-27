/**
 * The SQL editor (lib/sql.ts): results, the time range, user resolution, exports, and the sandbox that keeps a
 * query inside its own project. Runs in its own schema.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/sql.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlResult } from '../src/contract';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'sql_test';

d('SQL editor (PostgreSQL)', async () => {
  if (!BASE) { it.skip('needs DATABASE_URL'); return; }
  const url = new URL(BASE);
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { normalizeBatch } = await import('../src/lib/events');
  const { storeEvents } = await import('../src/lib/store/queue');
  const { forgetIdentities } = await import('../src/lib/identities');
  const { location } = await import('../src/lib/store/files');
  const SQL = await import('../src/lib/sql');

  const pid = randomUUID(), other = randomUUID();
  const now = Date.now();
  const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };
  const ev = (t: string, ago: number, extra: object = {}) => ({ id: randomUUID(), t, ts: now - ago, s: 'sess', url: 'https://shop.test/', path: '/', ...extra });
  const store = (p: string, a: string, e: unknown[]) => storeEvents(normalizeBatch(p, { k: 'k', a, sentAt: now, e } as never, now));
  const run = (sql: string, extra: object = {}) => SQL.run(pid, { sql, ...range, ...extra });
  const rows = (r: SqlResult) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])));
  const fails = async (sql: string) => {
    try { await run(sql); } catch (err) { return (err as Error).message; }
    throw new Error(`expected to fail: ${sql}`);
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    forgetIdentities();
    await store(pid, 'anon-a', [
      ev('pageview', 600_000),
      ev('custom', 500_000, { d: { name: 'checkout', props: { plan: 'pro', amount: 49 } } }),
      ev('identify', 400_000, { u: 'alice@x.com' }),
    ]);
    await store(pid, 'anon-b', [ev('pageview', 300_000, { path: '/pricing' }), ev('pageview', 2 * 3600_000, { path: '/old' })]);
    await store(other, 'anon-z', [ev('pageview', 100_000, { path: '/secret' })]);
  });
  afterAll(async () => { await closeDb(); });

  it('returns typed columns and rows', async () => {
    const r = await run('SELECT type, count(*) AS n FROM events GROUP BY 1 ORDER BY 1');
    expect(r.columns).toEqual([{ name: 'type', type: 'VARCHAR' }, { name: 'n', type: 'BIGINT' }]);
    expect(r.rows).toEqual([['custom', 1], ['identify', 1], ['pageview', 2]]);
    expect(r.truncated).toBe(false);
    expect(r.scanned.files).toBeGreaterThan(0);
  });

  it('only has rows of the time range', async () => {
    const r = await run("SELECT path FROM events WHERE type = 'pageview' ORDER BY ts");
    expect(r.rows.flat()).toEqual(['/', '/pricing']);
  });

  it("resolves anonymous events to the user their browser identified as", async () => {
    const r = await run("SELECT DISTINCT anon_id, user_id FROM events ORDER BY 1");
    expect(rows(r)).toEqual([{ anon_id: 'anon-a', user_id: 'alice@x.com' }, { anon_id: 'anon-b', user_id: null }]);
    expect((await run('SELECT * FROM identities')).rows).toEqual([['anon-a', 'alice@x.com']]);
  });

  it('parses JSON columns and supports DuckDB syntax', async () => {
    const r = await run("FROM events SELECT props->'props' AS p, props->'props'->>'plan' AS plan WHERE type = 'custom'");
    expect(rows(r)).toEqual([{ p: { plan: 'pro', amount: 49 }, plan: 'pro' }]);
    const t = await run("SELECT [1, 2] AS l, {'a': 1} AS s, INTERVAL 90 MINUTE AS iv, 12345678901234567890::HUGEINT AS big, 1.25::DECIMAL(5,2) AS dec");
    expect(t.rows[0]).toEqual([[1, 2], { a: 1 }, '01:30:00', '12345678901234567890', 1.25]);
  });

  it('caps rows at the limit', async () => {
    const r = await run('SELECT * FROM range(5000)', { limit: 100 });
    expect(r.rows).toHaveLength(100);
    expect(r.truncated).toBe(true);
  });

  it('runs one statement at a time; trailing semicolons and comments are fine', async () => {
    expect(await fails('SELECT 1; SELECT 2')).toMatch(/one statement at a time/);
    expect((await run('SELECT 1 AS x; -- done')).rows).toEqual([[1]]);
    expect(await fails('SELEC 1')).toMatch(/^Parser Error: syntax error at or near "SELEC"[\s\S]*LINE 1/);
  });

  it("can't see other projects, files, the network or settings", async () => {
    expect((await run("SELECT count(*) FROM events WHERE path = '/secret'")).rows).toEqual([[0]]);
    const otherFile = (await location().list(`events/project_id=${other}/`))[0];
    expect(otherFile).toBeTruthy();
    expect(await fails(`SELECT * FROM read_parquet('${location().url(otherFile.key)}')`)).toMatch(/Permission Error/);
    expect(await fails(`SELECT * FROM read_parquet('${location().url('events')}/**/*.parquet')`)).toMatch(/Permission Error/);
    expect(await fails("SELECT * FROM read_text('/etc/passwd')")).toMatch(/Permission Error/);
    expect(await fails("SELECT * FROM read_csv('https://example.com/x.csv')")).toMatch(/Permission Error/);
    expect(await fails("COPY (SELECT 1) TO '/tmp/wgo-sql-escape.csv'")).toMatch(/Permission Error/);
    expect(await fails("ATTACH '/tmp/wgo-sql-escape.db'")).toMatch(/Permission Error/);
    expect(await fails('SET enable_external_access = true')).toMatch(/locked/);
    expect(await fails("SET allowed_directories = ['/']")).toMatch(/locked/);
    expect(await fails('INSTALL spatial')).toMatch(/Permission Error|locked/);
  });

  it('stops a query that runs too long', async () => {
    process.env.SQL_TIMEOUT_MS = '300';
    await expect(SQL.run(pid, { sql: 'SELECT count(*) FROM range(100000000000)', ...range })).rejects.toThrow(/ran longer than/);
    delete process.env.SQL_TIMEOUT_MS;
  });

  it('exports the whole result as CSV or NDJSON', async () => {
    const sql = "SELECT path, type FROM events WHERE type = 'pageview' ORDER BY ts;";
    const csv = await SQL.exportResult(pid, { sql, ...range, format: 'csv' }, 'Acme Shop');
    expect(csv).toMatchObject({ url: null, rows: 2, content: 'path,type\n/,pageview\n/pricing,pageview\n' });
    expect(csv.filename).toMatch(/^acme-shop-query-\d{8}-\d{4}\.csv$/);
    const nd = await SQL.exportResult(pid, { sql: "SELECT props FROM events WHERE type = 'custom' -- trailing", ...range, format: 'ndjson' });
    expect(nd.content!.trim().split('\n').map((l) => JSON.parse(l))).toEqual([{ props: { name: 'checkout', props: { plan: 'pro', amount: 49 } } }]);
    // the export file is the only path the sandbox may write, and it's gone afterwards
    expect(await location().list('exports/')).toEqual([]);
  });

  it('lists tables, columns and functions for autocomplete', async () => {
    const s = await SQL.schema();
    const events = s.tables.find((t) => t.name === 'events')!;
    expect(events.timeColumn).toBe('ts');
    expect(events.columns).toContainEqual({ name: 'props', type: 'JSON', description: expect.any(String) });
    expect(s.tables.map((t) => t.name)).toContain('identities');
    expect(s.functions.find((f) => f.name === 'date_trunc')?.signature).toMatch(/^date_trunc\(/);
    expect(s.functions.some((f) => f.name.startsWith('read_'))).toBe(false);
    expect(s.keywords).toContain('SELECT');
  });
});

describe('stripSemicolons', async () => {
  const { stripSemicolons } = await import('../src/lib/sql');
  it('drops top-level semicolons only', () => {
    expect(stripSemicolons("SELECT ';' AS a, \"x;y\" -- c;\n;")).toBe("SELECT ';' AS a, \"x;y\" -- c;");
    expect(stripSemicolons('SELECT 1 /* ; */ ;  ')).toBe('SELECT 1 /* ; */');
    expect(stripSemicolons("SELECT 'it''s;'")).toBe("SELECT 'it''s;'");
  });
});
