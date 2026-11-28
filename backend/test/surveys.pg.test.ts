/**
 * Surveys against real SQL: CRUD, the SDK's endpoints and the results. Uses its own schema.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/surveys.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'surveys_test';

d('surveys (PostgreSQL)', async () => {
  if (!BASE) { it.skip('needs DATABASE_URL'); return; }
  const url = new URL(BASE);
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { writeRows } = await import('../src/lib/store/write');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { normalizeBatch } = await import('../src/lib/events');
  const { createProject } = await import('../src/lib/projects');
  const R = await import('../src/lib/recordings');
  const S = await import('../src/lib/surveys');

  const email = 'owner@surveys.test';
  let pid = '';
  let key = '';
  const now = Date.now();
  const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };
  const input = {
    name: 'Onboarding',
    questions: [
      { type: 'single', title: 'Role', options: ['Dev', 'PM'], required: true },
      { type: 'text', title: 'Anything else?' },
    ],
    display: { mode: 'popover' },
    targeting: { paths: ['/app/*'] },
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    const p = await createProject(email, 'Surveyed');
    pid = p.id;
    key = p.writeKey;
  });
  afterAll(async () => { await closeDb(); });

  it('creates drafts the SDK does not see, until activated', async () => {
    const s = await S.createSurvey(pid, email, input as never);
    expect(s).toMatchObject({ name: 'Onboarding', status: 'draft', responses: 0, lastResponseAt: null, createdBy: email });
    expect(s.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(await S.publicSurveys(key)).toEqual({ s: [] });
    expect(await R.publicConfig(key)).toEqual({ on: false });

    await S.updateSurvey(pid, s.id, { status: 'active' });
    const pub = await S.publicSurveys(key);
    expect(pub.s).toHaveLength(1);
    expect(pub.s[0]).toEqual({ id: s.id, name: 'Onboarding', questions: s.questions, display: s.display, targeting: s.targeting });
    expect(await R.publicConfig(key)).toEqual({ on: false, sv: true });
    expect(await S.publicSurveys('wk_unknownunknown')).toEqual({ s: [] });
    await S.deleteSurvey(pid, s.id);
    expect(await S.listSurveys(pid)).toEqual([]);
  });

  it('reads surveys saved with a custom event name as a trigger', async () => {
    const s = await S.createSurvey(pid, email, { ...input, status: 'active' } as never);
    await query(`UPDATE surveys SET targeting = $3::jsonb WHERE project_id = $1 AND id = $2`, [pid, s.id, JSON.stringify({ paths: [], frequency: 'once', event: 'paid' })]);
    const paid = [{ field: 'type', op: 'eq', value: 'custom' }, { field: 'name', op: 'eq', value: 'paid' }];
    expect((await S.getSurvey(pid, s.id)).targeting).toEqual({ paths: [], frequency: 'once', trigger: paid });
    await S.updateSurvey(pid, s.id, { name: 'Renamed' }); // forgets the active-surveys cache
    expect((await S.publicSurveys(key)).s[0].targeting.trigger).toEqual(paid);
    await S.deleteSurvey(pid, s.id);
  });

  it('stores responses once, validates them and aggregates', async () => {
    const s = await S.createSurvey(pid, email, { ...input, status: 'active' } as never);
    const rid = randomUUID();
    const body = { k: key, id: s.id, r: rid, a: 'anon-1', s: 'sess-1', u: 'ada@x.test', path: '/app/home', ans: { q1: 'Dev', q2: 'Love it' } };
    expect(await S.respond(body)).toEqual({ ok: true });
    expect(await S.respond(body)).toEqual({ ok: true }); // a retry
    expect(await S.respond({ ...body, r: randomUUID(), a: 'anon-2', u: undefined, ans: { q1: 'PM' } })).toEqual({ ok: true });
    await expect(S.respond({ ...body, r: randomUUID(), ans: { q2: 'no role' } })).rejects.toThrow(/required/);
    expect(await S.respond({ ...body, k: 'wk_unknownunknown', r: randomUUID() })).toEqual({ ok: false });

    const got = await S.getSurvey(pid, s.id);
    expect(got.responses).toBe(2);
    expect(got.lastResponseAt).not.toBeNull();

    // the SDK's custom events give the shown / dismissed counts
    const ev = (name: string, sid: string) => ({ id: randomUUID(), t: 'custom', ts: now - 1000, s: 'sess-1', url: 'https://x.test/app', path: '/app', d: { name, props: { survey_id: sid } } });
    await writeRows('events', normalizeBatch(pid, { k: 'k', a: 'anon-1', sentAt: now, ctx: {}, e: [
      ev('survey_shown', s.id), ev('survey_shown', s.id), ev('survey_shown', s.id), ev('survey_dismissed', s.id), ev('survey_shown', randomUUID()),
    ] } as never, now));

    const res = await S.surveyResults(pid, s.id, range);
    expect(res).toMatchObject({ responses: 2, shown: 3, dismissed: 1, truncated: false });
    expect(res.questions[0].counts).toEqual([{ value: 'Dev', n: 1 }, { value: 'PM', n: 1 }]);
    expect(res.questions[1].texts?.map((t) => t.text)).toEqual(['Love it']);
    expect(res.series.reduce((a, b) => a + b, 0)).toBe(2);

    const p1 = await S.surveyResponses(pid, s.id, { ...range, limit: '1' });
    expect(p1.responses).toHaveLength(1);
    expect(p1.next).not.toBeNull();
    const p2 = await S.surveyResponses(pid, s.id, { ...range, limit: '1', before: p1.next! });
    expect(p2.responses).toHaveLength(1);
    expect(p2.next).toBeNull();
    const all = [...p1.responses, ...p2.responses];
    expect(new Set(all.map((r) => r.id)).size).toBe(2);
    expect(all.find((r) => r.id === rid)).toMatchObject({ anonId: 'anon-1', userId: 'ada@x.test', sessionId: 'sess-1', path: '/app/home', answers: { q1: 'Dev', q2: 'Love it' } });

    // paused: still takes answers from open surveys; drafts don't
    await S.updateSurvey(pid, s.id, { status: 'paused' });
    expect(await S.respond({ ...body, r: randomUUID() })).toEqual({ ok: true });
    await S.updateSurvey(pid, s.id, { status: 'draft' });
    expect(await S.respond({ ...body, r: randomUUID() })).toEqual({ ok: false });

    await S.deleteSurvey(pid, s.id);
    expect(await query('SELECT 1 FROM survey_responses WHERE project_id = $1', [pid])).toEqual([]);
    await expect(S.getSurvey(pid, s.id)).rejects.toThrow(/not found/);
  });
});
