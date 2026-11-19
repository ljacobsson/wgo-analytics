/**
 * Retention cohorts against PostgreSQL (own schema) and Parquet in a temp directory: visitor_days are built from
 * complete days of events (identities resolved, bots left out, goals reached), rebuilt idempotently, kept 400 days
 * while raw events wait for them, and /retention answers first-seen and goal cohorts with a split.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/retention.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'retention_test';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

d('retention cohorts (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();
  delete process.env.MAX_RETENTION_DAYS;

  const { query, closeDb } = await import('../src/lib/db');
  const { writeRows } = await import('../src/lib/store/write');
  const { rawQuery } = await import('../src/lib/store/duck');
  const { location } = await import('../src/lib/store/files');
  const { dayPrefix, dayOf, floorDay } = await import('../src/lib/store/tables');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { getJobState, setJobState } = await import('../src/lib/jobState');
  const { forgetIdentities } = await import('../src/lib/identities');
  const { runVisitorDays } = await import('../src/lib/visitors');
  const { runRetention, forgetRetention } = await import('../src/lib/retention');
  const { retention } = await import('../src/lib/cohorts');
  const { createGoal } = await import('../src/lib/goals');
  const { HttpError } = await import('../src/lib/http');
  const P = await import('../src/lib/projects');
  type EventRow = import('../src/lib/events').EventRow;

  const OWNER = 'owner@x.test';
  const now = Date.now();
  const today = floorDay(now);
  const [d1, d2, d3] = [today - 3 * DAY, today - 2 * DAY, today - DAY];
  const rolledUntil = today + 2 * HOUR; // rollups are past the end of yesterday plus the late-event hour
  let pid = '';
  let goalId = '';

  const row = (o: Partial<EventRow> & Pick<EventRow, 'ts' | 'type'>): EventRow => ({
    project_id: pid, id: randomUUID(), session_id: null, anon_id: null, user_id: null, url: 'https://shop.test/', path: '/',
    title: null, referrer: null, selector: null, element_text: null, element_tag: null, track_name: null, error_message: null,
    error_stack: null, error_source: null, fingerprint: null, http_method: null, http_url: null, http_route: null, http_status: null,
    duration_ms: null, name: null, props: {}, browser: null, os: null, device: null, country: null, region: null, city: null,
    lat: null, lon: null, bot: null, ...o,
  });
  const at = (day: number, hour = 10) => new Date(day + hour * HOUR);
  const visits = (pid2: string, day: number, who: { anon: string; device: string; ref?: string; path?: string; user?: string }) => [
    row({ ts: at(day), type: 'pageview', session_id: `${who.anon}-${day}`, anon_id: who.anon, user_id: who.user ?? null, device: who.device, country: 'SE',
      referrer: who.ref ?? null, path: who.path ?? '/' }),
    row({ ts: at(day, 11), type: 'click', session_id: `${who.anon}-${day}`, anon_id: who.anon, user_id: who.user ?? null, device: who.device, country: 'SE' }),
  ].map((r) => ({ ...r, project_id: pid2 }));
  const all = <T,>(sql: string, params: unknown[] = []) => rawQuery<T>(pid, { from: new Date(now - 420 * DAY), to: new Date(now + DAY) }, sql, params);
  const days = () => all<{ day: Date; person: string; anon_id: string; user_id: string | null; sessions: number; events: number; device: string; source: string; goals: string[] }>(
    'SELECT day, person, anon_id, user_id, sessions, events, device, source, goals FROM visitor_days WHERE project_id = $1 ORDER BY day, person', [pid]);
  const dayFiles = async (day: number) => (await location().list(dayPrefix('visitor_days', pid, dayOf(day)))).length;

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    pid = (await P.createProject(OWNER, 'Shop')).id;
    goalId = (await createGoal(pid, OWNER, { name: 'Thanks', filters: [{ field: 'path', op: 'eq', value: '/thanks' }] })).id;

    await writeRows('events', [
      // alice browses anonymously on day 1 and logs in on day 2 (the identity resolves day 1 too); she reaches the goal on day 2
      ...visits(pid, d1, { anon: 'a1', device: 'desktop', ref: 'https://google.com/search' }),
      ...visits(pid, d2, { anon: 'a1', device: 'desktop', user: 'alice@x.test', path: '/thanks' }),
      ...visits(pid, d3, { anon: 'a1', device: 'desktop', user: 'alice@x.test' }),
      // bob only comes on day 1
      ...visits(pid, d1, { anon: 'b1', device: 'mobile' }),
      // carol starts on day 2 and reaches the goal on day 3
      ...visits(pid, d2, { anon: 'c1', device: 'desktop' }),
      ...visits(pid, d3, { anon: 'c1', device: 'desktop', path: '/thanks' }),
      // a bot never shows up
      ...visits(pid, d1, { anon: 'bot1', device: 'desktop' }).map((r) => ({ ...r, bot: 'ua' })),
    ]);
    await query('INSERT INTO identities (project_id, anon_id, user_id) VALUES ($1, $2, $3)', [pid, 'a1', 'alice@x.test']);
    forgetIdentities();
  });
  afterAll(async () => { await closeDb(); });

  it('builds one row per visitor and day from the complete days', async () => {
    const res = await runVisitorDays(Date.now() + 60_000, rolledUntil, now);
    expect(res).toMatchObject({ until: today, caughtUp: true, days: 3 });
    expect((await getJobState('visitors'))?.getTime()).toBe(today);

    const rows = await days();
    expect(rows.map((r) => [dayOf(r.day.getTime()), r.person])).toEqual([
      [dayOf(d1), 'alice@x.test'], [dayOf(d1), 'b1'],
      [dayOf(d2), 'alice@x.test'], [dayOf(d2), 'c1'],
      [dayOf(d3), 'alice@x.test'], [dayOf(d3), 'c1'],
    ]);
    const alice1 = rows[0];
    expect(alice1).toMatchObject({ user_id: 'alice@x.test', anon_id: 'a1', sessions: 1, events: 2, device: 'desktop', source: 'google.com', goals: [] });
    expect(rows[1]).toMatchObject({ source: '', device: 'mobile' }); // direct
    expect(rows[2].goals).toEqual([goalId]);
    expect(rows[5].goals).toEqual([goalId]);
    expect(rows[3].goals).toEqual([]);
  });

  it('is idempotent: a day built again replaces its files instead of adding rows', async () => {
    await setJobState('visitors', new Date(d1));
    const res = await runVisitorDays(Date.now() + 60_000, rolledUntil, now);
    expect(res.days).toBe(3);
    expect(await days()).toHaveLength(6);
    expect([await dayFiles(d1), await dayFiles(d2), await dayFiles(d3)]).toEqual([1, 1, 1]);
  });

  it('waits for the late-event hour and has nothing to do when caught up', async () => {
    expect(await runVisitorDays(Date.now() + 60_000, rolledUntil, now)).toMatchObject({ until: today, caughtUp: true, days: 0 });
    // rollups are not an hour past yesterday yet: yesterday is not processed
    await setJobState('visitors', new Date(d3));
    expect(await runVisitorDays(Date.now() + 60_000, today + 30 * 60_000, now)).toMatchObject({ until: d3, caughtUp: true, days: 0 });
    await setJobState('visitors', new Date(today));
  });

  it('answers first-seen cohorts, with a split', async () => {
    const r = await retention(pid, { period: 'day', from: new Date(d1).toISOString(), to: new Date(now).toISOString(), split: 'device' }, now);
    expect(r.dataSince).toBe(dayOf(d1));
    expect(r.cohorts.map((c) => c.start.slice(0, 10))).toEqual([d1, d2, d3, today].map(dayOf));
    // day 1: alice and bob; alice comes back on days 2 and 3, bob never. Alice's first day is the cohort, not her later ones
    expect(r.cohorts[0]).toMatchObject({ size: 2, counts: [2, 1, 1], values: [1, 0.5, 0.5] });
    expect(r.cohorts[1]).toMatchObject({ size: 1, counts: [1, 1] }); // carol: new on day 2, alice (seen before) is not
    expect(r.cohorts[2]).toMatchObject({ size: 0, counts: [0] });
    expect(r.average).toEqual([1, 0.6667, 0.5]);
    expect(r.splits?.map((s) => [s.key, s.size])).toEqual([['desktop', 2], ['mobile', 1]]);
    expect(r.splits?.[0].average).toEqual([1, 1, 1]);
    expect(r.splits?.[1].average).toEqual([1, 0, 0]);
  });

  it('answers weekly cohorts and splits by source', async () => {
    const r = await retention(pid, { period: 'week', split: 'source' }, now);
    expect(r.period).toBe('week');
    expect(r.cohorts.reduce((a, c) => a + c.size, 0)).toBe(3);
    expect(r.splits?.map((s) => s.key).sort()).toEqual(['(direct)', 'google.com']);
  });

  it('answers goal cohorts and goal returns', async () => {
    const q = { period: 'day', from: new Date(d1).toISOString(), to: new Date(now).toISOString() };
    // who first reached the goal: alice on day 2, carol on day 3; both visit again afterwards only as far as the data goes
    const r = await retention(pid, { ...q, start: `goal:${goalId}` }, now);
    expect(r.cohorts.map((c) => c.size)).toEqual([0, 1, 1, 0]);
    expect(r.cohorts[1]).toMatchObject({ counts: [1, 1] });
    // came back = reached the goal again: alice did not
    const g = await retention(pid, { ...q, start: `goal:${goalId}`, return: `goal:${goalId}` }, now);
    expect(g.cohorts[1]).toMatchObject({ size: 1, counts: [1, 0] });
    // new visitors who later reached the goal: alice on day 2 (period 1), bob never
    const f = await retention(pid, { ...q, return: `goal:${goalId}` }, now);
    expect(f.cohorts[0]).toMatchObject({ size: 2, counts: [0, 1, 0] });
    await expect(retention(pid, { ...q, start: 'goal:nope' }, now)).rejects.toBeInstanceOf(HttpError);
    await expect(retention(pid, { period: 'year' }, now)).rejects.toBeInstanceOf(HttpError);
    await expect(retention(pid, { from: new Date(now - 401 * DAY).toISOString(), to: new Date(now).toISOString() }, now)).rejects.toBeInstanceOf(HttpError);
  });

  it('keeps visitor_days 400 days and raw events until they became visitor_days', async () => {
    await query('UPDATE projects SET retention_days = 1 WHERE id = $1', [pid]);
    forgetRetention(pid);
    const old = (day: number) => ({ project_id: pid, day: new Date(day), person: 'old', anon_id: 'old', user_id: null, sessions: 1, events: 1, device: null, country: null, source: '', goals: [] });
    await writeRows('visitor_days', [old(now - 401 * DAY), old(now - 300 * DAY)]);
    const events = async () => (await all<{ n: number }>('SELECT count(DISTINCT dt)::int AS n FROM events WHERE project_id = $1', [pid]))[0].n;
    expect(await events()).toBe(3);

    // the watermark is still at the first day: no event day may go, but the 401 day old visitor row does
    const held = await runRetention(Date.now() + 60_000, now, now, d1);
    expect(held.deleted).toEqual({ visitor_days: 1 });
    expect(await events()).toBe(3);
    expect((await days()).filter((r) => r.person === 'old')).toHaveLength(1);

    // processed up to yesterday: events before yesterday go (raw retention is 1 day), visitor_days stay
    await query("DELETE FROM job_state WHERE name = 'retention'");
    const done = await runRetention(Date.now() + 60_000, now, now, d3);
    expect(done.deleted).toEqual({ events: 2 });
    expect(await events()).toBe(1);
    expect(await days()).toHaveLength(7);
  });
});
