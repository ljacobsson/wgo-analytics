/**
 * Click aliases against real SQL. Uses its own schema so it can run alongside the other *.pg tests.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/clickAliases.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'click_aliases_test';

d('click aliases (PostgreSQL)', async () => {
  if (!BASE) { it.skip('needs DATABASE_URL'); return; }
  const url = new URL(BASE);
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { writeRows } = await import('../src/lib/store/write');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { normalizeBatch } = await import('../src/lib/events');
  const CA = await import('../src/lib/clickAliases');
  const A = await import('../src/lib/analytics');

  const pid = randomUUID();
  const other = randomUUID();
  const now = Date.now();
  const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };
  const ugly = 'div.w-full.py-6 > div:nth-of-type(2) > button.rounded-lg';
  const buy = 'main > button.buy';

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));

    const click = (sel: string, text?: string, s = 'sess-a') =>
      ({ id: randomUUID(), t: 'click', ts: now - 60_000, s, url: 'https://shop.test/', path: '/', d: { sel, tag: 'button', ...(text ? { text } : {}) } });
    const batch = (e: unknown[]) => ({ k: 'k', a: 'anon-1', sentAt: now, ctx: { ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0' }, e });
    await writeRows('events', [...normalizeBatch(pid, batch([click(ugly), click(ugly), click('#signup', 'Sign up'),
      // the same buy button with each product's price on it
      click(buy, 'Buy – $49'), click(buy, 'Buy – $49', 'sess-b'), click(buy, 'Buy – $129', 'sess-c'), click(buy, 'Buy – $15')]) as never, now)]);
  });

  afterAll(async () => closeDb());

  it('sets, renames, lists and removes aliases, validating input', async () => {
    expect(await CA.listAliases(pid)).toEqual([]);

    const a = await CA.setAlias(pid, 'alice@example.com', { selector: `  ${ugly} `, alias: '  Plan   picker  ' });
    expect(a).toMatchObject({ selector: ugly, alias: 'Plan picker', updatedBy: 'alice@example.com' });

    const b = await CA.setAlias(pid, 'bob@example.com', { selector: ugly, alias: 'Choose plan' });
    expect(b).toMatchObject({ selector: ugly, alias: 'Choose plan', updatedBy: 'bob@example.com' });
    expect(await CA.listAliases(pid)).toHaveLength(1);
    expect(await CA.listAliases(other)).toEqual([]);

    await expect(CA.setAlias(pid, 'a@x', { selector: ugly, alias: '   ' })).rejects.toMatchObject({ status: 400 });
    await expect(CA.setAlias(pid, 'a@x', { selector: ugly, alias: 'x'.repeat(81) })).rejects.toMatchObject({ status: 400 });
    await expect(CA.setAlias(pid, 'a@x', { selector: '', alias: 'Hi' })).rejects.toMatchObject({ status: 400 });
    await expect(CA.setAlias(pid, 'a@x', { selector: 'a'.repeat(513), alias: 'Hi' })).rejects.toMatchObject({ status: 400 });

    await CA.deleteAlias(pid, ugly);
    await CA.deleteAlias(pid, ugly); // already gone: fine
    expect(await CA.listAliases(pid)).toEqual([]);
  });

  it('labels click rows with their alias', async () => {
    await CA.setAlias(pid, 'alice@example.com', { selector: ugly, alias: 'Choose plan' });
    const rows = await A.clicks(pid, range);
    expect(rows.find((r) => r.selector === ugly)).toMatchObject({ alias: 'Choose plan', count: 2 });
    expect(rows.find((r) => r.selector === '#signup')).toMatchObject({ alias: null, elementText: 'Sign up' });
  });

  it('counts every text of an aliased selector as one target', async () => {
    const before = (await A.clicks(pid, range)).filter((r) => r.selector === buy);
    expect(before.map((r) => [r.elementText, r.count]).sort()).toEqual([['Buy – $129', 1], ['Buy – $15', 1], ['Buy – $49', 2]]);

    await CA.setAlias(pid, 'alice@example.com', { selector: buy, alias: 'Buy button' });
    const after = (await A.clicks(pid, range)).filter((r) => r.selector === buy);
    expect(after).toEqual([expect.objectContaining({ alias: 'Buy button', elementText: null, elementTag: 'button', count: 4, sessions: 3 })]);
    // a selector whose clicks all had one text keeps it
    expect((await A.clicks(pid, range)).find((r) => r.selector === ugly)).toMatchObject({ alias: 'Choose plan', count: 2 });
  });
});
