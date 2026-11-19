/**
 * Project sites and their daily homepage screenshots against PostgreSQL, with pageviews in Parquet and a fake browser.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55443/postgres npx vitest run test/sites.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'sites_test';

d('project sites and screenshots (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { writeRows } = await import('../src/lib/store/write');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { normalizeBatch } = await import('../src/lib/events');
  const { location } = await import('../src/lib/store/files');
  const S = await import('../src/lib/sites');
  const { purgeDeletedProjects } = await import('../src/lib/purge');

  const pid = randomUUID(), quiet = randomUUID();
  const now = Date.now();
  const DAY = 86400e3;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const jpeg = (s: string) => new TextEncoder().encode(s);
  const ICON = 'data:image/png;base64,iVBORw0KGgo=';
  const browser = (shoot: (origin: string) => Promise<Uint8Array>) => {
    const calls: string[] = [];
    let opened = 0;
    return { calls, opened: () => opened, open: async () => { opened++; return { shoot: async (o: string) => { calls.push(o); return { image: await shoot(o), icon: ICON }; }, close: async () => undefined }; } };
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    await query('INSERT INTO projects (id, name, write_key) VALUES ($1, $2, $3), ($4, $5, $6)', [pid, 'Shop', 'wk_sitestest0000001', quiet, 'Quiet', 'wk_sitestest0000002']);
    const views = (url: string, n: number) => normalizeBatch(pid, {
      k: 'k', a: 'anon-' + url, sentAt: now, ctx: { ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0 Safari/537.36', tz: 'UTC', lang: 'en' },
      e: Array.from({ length: n }, (_, i) => ({ id: randomUUID(), t: 'pageview', ts: now - 3600_000 + i, s: 's-' + url, url, path: new URL(url).pathname })),
    } as never, now);
    await writeRows('events', [...views('http://localhost:5173/', 30), ...views('https://shop.example.com/cart', 5), ...views('https://example.com/', 2)]);
  });

  afterAll(async () => {
    await closeDb();
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('finds the most viewed public origin, once a day', async () => {
    expect(await S.detectSites(Date.now() + 60_000, now)).toEqual({ checked: 2 });
    expect(await S.getSite(pid)).toEqual({ origin: 'https://shop.example.com', icon: null, image: null });
    expect(await S.getSite(quiet)).toEqual({ origin: null, icon: null, image: null });
    expect(await S.detectSites(Date.now() + 60_000, now + 3600e3)).toEqual({ checked: 0 });
  });

  it('takes one screenshot a day and serves it for that day', async () => {
    const b = browser(async () => jpeg('day1'));
    expect(await S.runScreenshots(Date.now() + 60_000, b.open, now)).toEqual({ shot: 1, failed: 0 });
    expect(b.calls).toEqual(['https://shop.example.com']);
    const site = await S.getSite(pid);
    expect(site.image?.day).toBe(day(now));
    expect(site.icon).toBe(ICON);
    const { image } = await S.getSiteImage(pid, day(now));
    expect(image).toBe('data:image/jpeg;base64,' + Buffer.from('day1').toString('base64'));
    await expect(S.getSiteImage(pid, day(now - DAY))).rejects.toMatchObject({ status: 404 });
    await expect(S.getSiteImage(pid, 'x')).rejects.toMatchObject({ status: 400 });

    // later the same day: nothing is due, the browser isn't even started
    const again = browser(async () => jpeg('nope'));
    expect(await S.runScreenshots(Date.now() + 60_000, again.open, now + 3600e3)).toEqual({ shot: 0, failed: 0 });
    expect(again.opened()).toBe(0);
  });

  it('replaces the image the next day and deletes the old one', async () => {
    const b = browser(async () => jpeg('day2'));
    expect(await S.runScreenshots(Date.now() + 60_000, b.open, now + DAY)).toEqual({ shot: 1, failed: 0 });
    expect((await S.getSite(pid)).image?.day).toBe(day(now + DAY));
    expect(await location().get(S.siteImageKey(pid, day(now)))).toBeNull();
    expect(Buffer.from((await location().get(S.siteImageKey(pid, day(now + DAY))))!).toString()).toBe('day2');
  });

  it('keeps the last image when a day fails, and drops it when the site changes', async () => {
    const fail = browser(async () => { throw new Error('the homepage answered 503'); });
    expect(await S.runScreenshots(Date.now() + 60_000, fail.open, now + 2 * DAY)).toEqual({ shot: 0, failed: 1 });
    expect((await S.getSite(pid)).image?.day).toBe(day(now + DAY));
    expect((await S.getSite(pid)).icon).toBe(ICON);
    const [row] = await query<{ shot_error: string }>('SELECT shot_error FROM project_sites WHERE project_id = $1', [pid]);
    expect(row.shot_error).toBe('the homepage answered 503');
    // no retry the same day
    expect(await S.runScreenshots(Date.now() + 60_000, fail.open, now + 2 * DAY + 3600e3)).toEqual({ shot: 0, failed: 0 });

    await query("UPDATE project_sites SET origin = 'https://new.example.com' WHERE project_id = $1", [pid]);
    expect(await S.runScreenshots(Date.now() + 60_000, fail.open, now + 2 * DAY + 7200e3)).toEqual({ shot: 0, failed: 1 });
    expect((await S.getSite(pid)).image).toBeNull();
    expect((await S.getSite(pid)).icon).toBeNull();
    expect(await location().get(S.siteImageKey(pid, day(now + DAY)))).toBeNull();
  });

  it('is removed with a deleted project', async () => {
    const b = browser(async () => jpeg('day4'));
    await S.runScreenshots(Date.now() + 60_000, b.open, now + 3 * DAY);
    const key = S.siteImageKey(pid, day(now + 3 * DAY));
    expect(await location().get(key)).not.toBeNull();
    await query('DELETE FROM projects WHERE id = $1', [pid]);
    await query('INSERT INTO deleted_projects (id, deleted_at) VALUES ($1, $2)', [pid, new Date(now - 2 * 3600e3)]);
    await purgeDeletedProjects(Date.now() + 60_000);
    expect(await location().get(key)).toBeNull();
    expect(await query('SELECT 1 FROM project_sites WHERE project_id = $1', [pid])).toHaveLength(0);
  });
});
