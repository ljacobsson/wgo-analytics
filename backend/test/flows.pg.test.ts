/**
 * User flows against real SQL. Uses its own schema so it can run alongside the other *.pg tests.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/flows.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FlowsResponse } from '../src/contract';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'flows_test';

d('user flows (PostgreSQL)', async () => {
  if (!BASE) { it.skip('needs DATABASE_URL'); return; }
  const url = new URL(BASE);
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { writeRows } = await import('../src/lib/store/write');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { normalizeBatch } = await import('../src/lib/events');
  const { flows } = await import('../src/lib/flows');

  const pid = randomUUID();
  const now = Date.now();
  const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };
  const chrome = 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36';
  const googlebot = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

  /** Node at a step as [sessions, exits, errors, errorExits]. */
  const at = (f: FlowsResponse, step: number, key: string) => {
    const n = f.nodes.find((x) => x.step === step && x.key === key);
    return n && [n.sessions, n.exits, n.errors, n.errorExits];
  };
  const links = (f: FlowsResponse) => f.links.map((l) => `${l.step}:${l.from}>${l.to}=${l.sessions}`);

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));

    // Sessions start 10 s apart; their events 1 s apart.
    let n = 0;
    const session = (ua: string, kinds: Array<[string, string, object?]>) => {
      const s = `sess-${n}`, t0 = now - 1800_000 + n++ * 10_000;
      const e = kinds.map(([t, path, d = {}], i) => ({ id: randomUUID(), t, ts: t0 + i * 1000, s, url: `https://shop.test${path}`, path, ...d }));
      return normalizeBatch(pid, { k: 'k', a: `anon-${s}`, sentAt: now, ctx: { ua }, e } as never, now);
    };
    const pv = (path: string): [string, string] => ['pageview', path];
    const err = (path: string): [string, string, object] => ['error', path, { d: { msg: 'TypeError: plans is undefined' } }];
    const click = (path: string, sel: string, text: string): [string, string, object] => ['click', path, { d: { sel, text, tag: 'a' } }];
    const rows = [];
    // A ×10: / → click Pricing → /pricing (reloaded) → click #signup (twice) → /signup
    for (let i = 0; i < 10; i++) {
      rows.push(...session(chrome, [pv('/'), click('/', 'a.nav-pricing', 'Pricing'), pv('/pricing'), pv('/pricing'),
        click('/pricing', '#signup', 'Start'), click('/pricing', '#signup', 'Start'), pv('/signup')]));
    }
    // B ×6: / → /pricing, error there, leave
    for (let i = 0; i < 6; i++) rows.push(...session(chrome, [pv('/'), pv('/pricing'), err('/pricing')]));
    // C ×4: bounce on /
    for (let i = 0; i < 4; i++) rows.push(...session(chrome, [pv('/')]));
    // D ×3: seven pages, longer than the chart
    for (let i = 0; i < 3; i++) rows.push(...session(chrome, ['/blog', '/', '/pricing', '/blog', '/pricing', '/signup', '/done'].map(pv)));
    // E ×2: /pricing → / → /pricing, error on the second visit only, leave
    for (let i = 0; i < 2; i++) rows.push(...session(chrome, [pv('/pricing'), pv('/'), pv('/pricing'), err('/pricing')]));
    // a crawler: left out unless bots=1
    rows.push(...session(googlebot, [pv('/'), pv('/pricing')]));
    await writeRows('events', rows);
    await query(`INSERT INTO click_aliases (project_id, selector, alias, updated_by, updated_at) VALUES ($1, '#signup', 'Signup button', 'x', now())`, [pid]);
  });

  afterAll(async () => {
    await closeDb();
  });

  it('follows sessions page by page from their entry page, with exits and errors per step', async () => {
    const f = await flows(pid, range);
    expect(f).toMatchObject({ start: null, steps: 5, sessions: 25 });
    expect(at(f, 0, '/')).toEqual([20, 4, 0, 0]);
    expect(at(f, 0, '/blog')).toEqual([3, 0, 0, 0]);
    expect(at(f, 0, '/pricing')).toEqual([2, 0, 0, 0]); // E's error is on its second /pricing visit, not this one
    expect(at(f, 1, '/pricing')).toEqual([16, 6, 6, 6]); // the reload doesn't make a step
    expect(at(f, 1, '/')).toEqual([5, 0, 0, 0]);
    expect(at(f, 2, '/signup')).toEqual([10, 10, 0, 0]);
    expect(at(f, 2, '/pricing')).toEqual([5, 2, 2, 2]);
    expect(at(f, 3, '/blog')).toEqual([3, 0, 0, 0]);
    expect(at(f, 4, '/pricing')).toEqual([3, 0, 0, 0]); // D goes on past the chart: not an exit
    expect(f.nodes.filter((x) => x.step > 4)).toEqual([]);
    expect(f.nodes.find((x) => x.step === 1 && x.key === '/pricing')!.topErrors).toEqual([{ key: 'TypeError: plans is undefined', sessions: 6 }]);
    expect(links(f)).toEqual([
      '0:/>/pricing=16', '0:/blog>/=3', '0:/pricing>/=2',
      '1:/pricing>/signup=10', '1:/>/pricing=5',
      '2:/pricing>/blog=3',
      '3:/blog>/pricing=3',
    ]);
  });

  it('ranks the pages sessions leave on over the whole session', async () => {
    const f = await flows(pid, range);
    expect(f.exitPages.map((p) => [p.path, p.exits, p.views, p.errorViews, p.errorExits])).toEqual([
      ['/signup', 10, 13, 0, 0],
      ['/pricing', 8, 21, 8, 8],
      ['/', 4, 25, 0, 0],
      ['/done', 3, 3, 0, 0],
      ['/blog', 0, 3, 0, 0],
    ]);
    expect(f.exitPages[1].rate).toBeCloseTo(8 / 21);
  });

  it('starts at the first view of a page', async () => {
    const f = await flows(pid, { ...range, start: '/pricing' });
    expect(f).toMatchObject({ start: '/pricing', sessions: 21 }); // C never gets there
    expect(at(f, 0, '/pricing')).toEqual([21, 6, 6, 6]);
    expect(at(f, 1, '/signup')).toEqual([10, 10, 0, 0]);
    expect(at(f, 1, '/blog')).toEqual([3, 0, 0, 0]);
    expect(at(f, 1, '/')).toEqual([2, 0, 0, 0]);
    expect(at(f, 2, '/pricing')).toEqual([5, 2, 2, 2]);
    expect(at(f, 4, '/done')).toEqual([3, 3, 0, 0]);
  });

  it('filters choose sessions, not events; steps are clamped; bots on request', async () => {
    const errs = await flows(pid, { ...range, filters: JSON.stringify([{ field: 'type', op: 'eq', value: 'error' }]) });
    expect(errs.sessions).toBe(8);
    expect(at(errs, 0, '/')).toEqual([6, 0, 0, 0]);
    expect(at(errs, 0, '/pricing')).toEqual([2, 0, 0, 0]);

    const short = await flows(pid, { ...range, steps: '1' });
    expect(short.steps).toBe(3);
    expect(at(short, 2, '/pricing')).toEqual([5, 2, 2, 2]);
    expect(short.links.some((l) => l.step >= 2)).toBe(false);

    expect((await flows(pid, { ...range, bots: '1' })).sessions).toBe(26);
  });

  it('in clicks mode makes every click a step, repeats collapsed, named by alias or text', async () => {
    const f = await flows(pid, { ...range, mode: 'clicks' });
    expect(f).toMatchObject({ mode: 'clicks', steps: 5, sessions: 25 });
    expect(at(f, 0, '/')).toEqual([20, 4, 0, 0]);
    expect(at(f, 1, 'a.nav-pricing')).toEqual([10, 0, 0, 0]);
    expect(at(f, 1, '/pricing')).toEqual([6, 6, 6, 6]);
    expect(at(f, 2, '/pricing')).toEqual([15, 2, 2, 2]);
    expect(at(f, 3, '#signup')).toEqual([10, 0, 0, 0]); // clicked twice: one step
    expect(at(f, 4, '/signup')).toEqual([10, 10, 0, 0]);
    expect(f.nodes.find((n) => n.key === 'a.nav-pricing')).toMatchObject({ kind: 'click', label: 'Pricing', page: '/' });
    expect(f.nodes.find((n) => n.key === '#signup')).toMatchObject({ kind: 'click', label: 'Signup button', page: '/pricing' });
    expect(f.nodes.find((n) => n.key === '/signup')!.kind).toBe('page');
    expect(links(f)).toEqual([
      '0:/>a.nav-pricing=10', '0:/>/pricing=6', '0:/blog>/=3', '0:/pricing>/=2',
      '1:a.nav-pricing>/pricing=10', '1:/>/pricing=5',
      '2:/pricing>#signup=10', '2:/pricing>/blog=3',
      '3:#signup>/signup=10', '3:/blog>/pricing=3',
    ]);
    // the exit table stays by page: a click counts on the page it happened on
    expect(f.exitPages).toEqual((await flows(pid, range)).exitPages);

    const fromClick = await flows(pid, { ...range, mode: 'clicks', start: '#signup' });
    expect(fromClick.sessions).toBe(10);
    expect(fromClick.nodes.find((n) => n.step === 0)).toMatchObject({ key: '#signup', kind: 'click', sessions: 10 });
    expect(at(fromClick, 1, '/signup')).toEqual([10, 10, 0, 0]);
  });
});
