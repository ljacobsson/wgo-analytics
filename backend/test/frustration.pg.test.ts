/**
 * Frustration signals and click heatmaps against real SQL. Own schema, so it can run next to the other *.pg tests.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55442/postgres npx vitest run test/frustration.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'frustration_test';

d('frustration and heatmap (PostgreSQL)', async () => {
  if (!BASE) { it.skip('needs DATABASE_URL'); return; }
  const url = new URL(BASE);
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { writeRows } = await import('../src/lib/store/write');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { normalizeBatch } = await import('../src/lib/events');
  const { frustration, heatmap } = await import('../src/lib/frustration');
  const { READ_ROUTES } = await import('../src/lib/readRoutes');

  const pid = randomUUID();
  const now = Date.now();
  const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };
  const chrome = 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36';
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
  const googlebot = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  const t0 = now - 1800_000;

  let n = 0;
  type E = { t: string; at: number; path?: string; d?: object };
  const rows: unknown[] = [];
  const session = (s: string, ua: string, evs: E[]) => {
    rows.push(...normalizeBatch(pid, {
      k: 'k', a: `anon-${s}`, sentAt: now, ctx: { ua },
      e: evs.map((e) => ({ id: randomUUID(), t: e.t, ts: t0 + n * 60_000 + e.at, s, url: `https://shop.test${e.path ?? '/home'}`, path: e.path ?? '/home', ...(e.d ? { d: e.d } : {}) })),
    } as never, now));
    n++;
  };
  const click = (at: number, sel: string, d: object = {}, path = '/shop'): E => ({ t: 'click', at, path, d: { sel, tag: 'button', text: sel.slice(1), x: 10, y: 10, vw: 1280, vh: 800, ...d } });
  const err = (at: number): E => ({ t: 'error', at, d: { msg: 'boom', kind: 'error' } });
  const httpErr = (at: number): E => ({ t: 'http_error', at, d: { method: 'GET', url: 'https://api.test/x', status: 500, dur: 10, kind: 'fetch' } });
  const pv = (at: number): E => ({ t: 'pageview', at });
  const recorded = ['r-rage', 'r-err', 'r-desk-old', 'r-desk-new', 'r-mobile'];

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));

    session('r-rage', chrome, [pv(0), click(1000, '#rage', { rage: 5 }), click(1100, '#rage')]);
    session('s-rage2', chrome, [pv(0), click(1000, '#rage', { rage: 3 }), click(2000, '#rage', { rage: 2 })]); // rage < 3 is not rage
    session('s-dead1', chrome, [pv(0), click(1000, '#dead', { dead: 1 })]);
    session('s-dead2', chrome, [pv(0), click(1000, '#dead', { dead: 1 }), click(5000, '#dead', { dead: 1 }), click(9000, '#dead')]);
    session('r-err', chrome, [pv(0), click(1000, '#pay'), err(2000)]); // 1 s after: error click
    session('s-err2', chrome, [pv(0), click(1000, '#pay'), httpErr(2500)]); // 1.5 s after
    session('s-late', chrome, [pv(0), click(1000, '#pay'), err(4000)]); // 3 s after: not
    session('s-before', chrome, [pv(0), err(500), click(1000, '#pay')]); // error before the click: not
    session('s-fine', chrome, [pv(0), click(1000, '#fine'), click(20_000, '#fine')]);
    session('s-bot', googlebot, [pv(0), click(1000, '#dead', { dead: 1 })]);

    // heatmap on /home
    session('r-desk-old', chrome, [pv(0), click(1000, '#a', { x: 100, y: 200 }, '/home'), click(2000, '#a', { x: 103, y: 203 }, '/home')]);
    session('r-desk-new', chrome, [pv(0), click(1000, '#a', { x: 99, y: 205 }, '/home'), click(2000, '#b', { x: 500, y: 900 }, '/home')]);
    session('s-desk-wide', chrome, [pv(0), click(1000, '#a', { x: 1500, y: 100, vw: 1900 }, '/home')]); // other viewport width: left out
    session('r-mobile', iphone, [pv(0), click(1000, '#a', { x: 40, y: 300, vw: 390 }, '/home'), click(1500, '#a', { x: 41, y: 301, vw: 390 }, '/home')]);
    session('s-other-page', chrome, [{ t: 'pageview', at: 0, path: '/other' }, { t: 'click', at: 1000, path: '/other', d: { sel: '#o', tag: 'a', x: 1, y: 1, vw: 1280, vh: 800 } }]);
    await writeRows('events', rows as never);

    // r-desk-new's pageview is newer than r-desk-old's (sessions start a minute apart); s-desk-wide has no recording
    for (const [i, s] of recorded.entries()) {
      await query('INSERT INTO recordings (project_id, session_id, started_at, anon_id, reason) VALUES ($1, $2, $3, $4, $5)', [pid, s, new Date(t0 + i * 1000), `anon-${s}`, 'sample']);
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it('counts rage, dead and error clicks per target, with sessions', async () => {
    const rows = await frustration(pid, range);
    const by = Object.fromEntries(rows.map((r) => [r.selector, r]));
    expect(by['#rage']).toMatchObject({ clicks: 4, rageClicks: 2, rageSessions: 2, deadClicks: 0, errorClicks: 0 });
    expect(by['#dead']).toMatchObject({ clicks: 4, deadClicks: 3, deadSessions: 2, rageClicks: 0 }); // the bot is left out
    expect(by['#pay']).toMatchObject({ clicks: 4, errorClicks: 2, errorSessions: 2 }); // +1 s and +1.5 s, not +3 s or before
    expect(by['#fine']).toBeUndefined();
    expect(rows[0].selector).toBe('#dead'); // most frustrating first (3 vs 2 and 2)
    expect(rows.map((r) => r.selector).sort()).toEqual(['#dead', '#pay', '#rage'])
  });

  it('samples only recorded sessions, newest first', async () => {
    const rows = await frustration(pid, range);
    const by = Object.fromEntries(rows.map((r) => [r.selector, r]));
    expect(by['#rage'].samples.map((s) => s.sessionId)).toEqual(['r-rage']);
    expect(by['#pay'].samples.map((s) => s.sessionId)).toEqual(['r-err']);
    expect(by['#dead'].samples).toEqual([]); // none of its sessions has a recording
    expect(by['#pay'].samples[0].at).toBe(t0 + 4 * 60_000 + 1000);
  });

  it('serves both routes and respects limit and filters', async () => {
    expect((await READ_ROUTES.frustration(pid, { ...range, limit: '1' }, [])) as unknown[]).toHaveLength(1);
    const f = JSON.stringify([{ field: 'selector', op: 'eq', value: '#pay' }]);
    expect((await frustration(pid, { ...range, filters: f })).map((r) => r.selector)).toEqual(['#pay']);
    expect(await frustration(pid, { ...range, filters: f })).toMatchObject([{ errorClicks: 2 }]); // errors are still found
    const h = (await READ_ROUTES.heatmap(pid, { ...range, path: '/home' }, [])) as { total: number };
    expect(h.total).toBe(4);
  });

  it('buckets desktop clicks to 8 px at the most common width', async () => {
    const h = await heatmap(pid, { ...range, path: '/home', device: 'desktop' });
    expect(h.vw).toBe(1280);
    expect(h.total).toBe(4); // the 1900 px click is another width
    expect(h.points).toEqual([{ x: 96, y: 200, n: 3 }, { x: 496, y: 896, n: 1 }]);
  });

  it('filters by device: mobile covers phones and tablets', async () => {
    const h = await heatmap(pid, { ...range, path: '/home', device: 'mobile' });
    expect(h.vw).toBe(390);
    expect(h.points).toEqual([{ x: 40, y: 296, n: 2 }]);
    expect(h.snapshot).toMatchObject({ sessionId: 'r-mobile' });
    await expect(heatmap(pid, { ...range, path: '/home', device: 'tv' })).rejects.toMatchObject({ status: 400 });
    await expect(heatmap(pid, { ...range })).rejects.toMatchObject({ status: 400 });
  });

  it('picks the newest recorded session that viewed the page as the snapshot', async () => {
    const h = await heatmap(pid, { ...range, path: '/home', device: 'desktop' });
    expect(h.snapshot).toEqual({ sessionId: 'r-desk-new', at: expect.any(Number) });
    expect(h.snapshot!.at).toBeGreaterThan(t0);
    const none = await heatmap(pid, { ...range, path: '/other', device: 'desktop' });
    expect(none.snapshot).toBeNull(); // viewed only by an unrecorded session
    expect(none.points).toEqual([{ x: 0, y: 0, n: 1 }]);
    const empty = await heatmap(pid, { ...range, path: '/nothing' });
    expect(empty).toEqual({ vw: 0, points: [], total: 0, snapshot: null });
  });
});
