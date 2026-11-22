/**
 * Session recordings end to end: settings, the SDK's config and slot requests with their limits, ingest (only
 * granted sessions are stored) and reading recordings back. Runs in its own schema.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/recordings.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'recordings_test';

d('session recordings (PostgreSQL)', async () => {
  if (!BASE) { it.skip('needs DATABASE_URL'); return; }
  const url = new URL(BASE);
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { createProject } = await import('../src/lib/projects');
  const R = await import('../src/lib/recordings');
  const ingest = (await import('../src/handlers/ingest')).handler;
  const replay = (await import('../src/handlers/replay')).handler;

  const email = 'owner@test.dev';
  const now = Date.now();
  let pid = '';
  let key = '';

  const settings = (over: object = {}) => R.saveSettings(pid, email, { enabled: true, samplePercent: 50, triggers: [{ type: 'error', value: '' }], maxPerHour: 2, maxPerDay: 3, maskAllText: false, ...over });
  const start = (s: string, r = 'sample', at = now) => R.startRecording({ k: key, s, a: `anon-${s}`, r }, at);
  const post = (body: unknown) => ingest({
    rawPath: '/ingest', headers: {}, body: JSON.stringify(body), isBase64Encoded: false, requestContext: { http: { method: 'POST' } },
  } as unknown as APIGatewayProxyEventV2);
  const chunk = (s: string, ago: number, r: unknown[][], q = 0) => ({ id: randomUUID(), t: 'replay', ts: now - ago, s, url: 'https://shop.test/', path: '/', d: { p: 'page-1', q, dur: 500, r } });
  const ev = (s: string, t: string, ago: number, extra: object = {}) => ({ id: randomUUID(), t, ts: now - ago, s, url: 'https://shop.test/cart', path: '/cart', ...extra });

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    const p = await createProject(email, 'Recorded');
    pid = p.id;
    key = p.writeKey;
  });
  afterAll(async () => { await closeDb(); });

  it('is off by default: the SDK is told not to record and gets no slot', async () => {
    expect((await R.getSettings(pid)).settings.enabled).toBe(false);
    expect(await R.publicConfig(key)).toEqual({ on: false });
    expect(await start('s0')).toEqual({ ok: false });
    expect(await R.publicConfig('wk_unknownunknown')).toEqual({ on: false });
  });

  it('serves the config to the SDK once an owner turns it on', async () => {
    const res = await settings();
    expect(res.settings).toMatchObject({ enabled: true, samplePercent: 50, maxPerHour: 2 });
    expect(res.updatedBy).toBe(email);
    const r = await replay({ rawPath: '/replay/config', queryStringParameters: { k: key }, requestContext: { http: { method: 'GET' } } } as never) as { body: string; headers: Record<string, string> };
    expect(JSON.parse(r.body)).toEqual({ on: true, rate: 0.5, trg: [{ type: 'error', value: '' }], mask: false });
    expect(r.headers['cache-control']).toBe('public, max-age=60');
  });

  it('grants slots up to the hourly and daily limits; a granted session keeps its slot', async () => {
    expect(await start('s1')).toEqual({ ok: true });
    expect(await start('s2', 'trigger:error')).toEqual({ ok: true });
    expect(await start('s3')).toEqual({ ok: false }) // 2 per hour
    expect(await start('s1')).toEqual({ ok: true }); // already recording
    expect((await R.getSettings(pid)).usage).toEqual({ lastHour: 2, lastDay: 2 });
    // an hour later the hourly window has room again, but the daily limit (3) stops the fourth
    expect(await start('s3', 'sample', now + 3600_000 + 1000)).toEqual({ ok: true });
    expect(await start('s4', 'sample', now + 2 * 3600_000)).toEqual({ ok: false });
    const rows = await query<{ session_id: string; reason: string }>('SELECT session_id, reason FROM recordings WHERE project_id = $1 ORDER BY session_id', [pid]);
    expect(rows).toEqual([{ session_id: 's1', reason: 'sample' }, { session_id: 's2', reason: 'trigger:error' }, { session_id: 's3', reason: 'sample' }]);
  });

  it('stores chunks of granted sessions only, next to their events', async () => {
    const snap = { w: 1280, h: 800, sx: 0, sy: 0, u: 'https://shop.test/', ti: 'Shop', ch: 'x', j: { html: '<p>hi</p>', css: [] } };
    const res = await post({
      k: key, a: 'anon-s1', sentAt: now, ctx: { ua: 'Mozilla/5.0 (Macintosh) Chrome/120.0' },
      e: [
        chunk('s1', 60_000, [[4, 0, 1280, 800], [0, 10, snap]]),
        chunk('s1', 30_000, [[1, 0, 10, 20], [2, 400, 10, 20]], 1),
        chunk('s4', 30_000, [[1, 0, 1, 1]]), // no slot: dropped
        ev('s1', 'pageview', 60_000, { path: '/' }),
        ev('s1', 'click', 29_600, { d: { sel: '#buy', tag: 'button' } }),
        ev('s1', 'error', 20_000, { d: { msg: 'boom', kind: 'error' } }),
      ],
    });
    expect(res).toMatchObject({ statusCode: 202 });
    expect(JSON.parse((res as { body: string }).body)).toEqual({ accepted: 5 });

    const list = await R.listRecordings(pid, { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() });
    expect(list.recordings.map((r) => r.sessionId)).toEqual(['s1']); // s2 got a slot but sent nothing: not listed
    const s1 = list.recordings.find((r) => r.sessionId === 's1')!;
    expect(s1).toMatchObject({ reason: 'sample', anonId: 'anon-s1', entryPath: '/', pages: 1, clicks: 1, rageClicks: 0, errors: 1, events: 2, paths: ['/'], browser: 'Chrome', durationMs: 30_000 + 500 });
    const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };
    const ids = async (f: Record<string, string>) => (await R.listRecordings(pid, { ...range, ...f })).recordings.map((r) => r.sessionId);
    expect(await ids({ errors: '1', page: '/' })).toEqual(['s1']);
    expect(await ids({ minDuration: '60' })).toEqual([]);
    expect(await ids({ reason: 'trigger' })).toEqual([]);
    expect(s1.startedAt).toBe(new Date(now - 60_000).toISOString()); // the lead-up before the slot counts

    const rec = await R.getRecording(pid, 's1', {});
    expect(rec.chunks.map((c) => [c.seq, c.r.length])).toEqual([[0, 2], [1, 2]]);
    expect(rec.chunks[0].r[1]).toEqual([0, 10, snap]);
    expect(rec.nextAfter).toBeNull();
    await expect(R.getRecording(pid, 's4', {})).rejects.toThrow(/No recording/);
  });

  it('pages through a long recording', async () => {
    const big = (i: number) => chunk('s2', 50_000 - i, [[0, 0, { j: { html: 'x'.repeat(150_000), css: [] } }]], i);
    await post({ k: key, a: 'anon-s2', sentAt: now, e: Array.from({ length: 25 }, (_, i) => big(i)) });
    const first = await R.getRecording(pid, 's2', {});
    expect(first.chunks.length).toBe(19); // 3 MB of data per response
    expect(first.nextAfter).toBeTruthy();
    const rest = await R.getRecording(pid, 's2', { after: first.nextAfter! });
    expect([...first.chunks, ...rest.chunks].map((c) => c.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(rest.nextAfter).toBeNull();
  });

  it('hides recordings in which the visitor did nothing unless asked for', async () => {
    const active = async (sid: string) => (await query<{ active: boolean | null }>('SELECT active FROM recordings WHERE project_id = $1 AND session_id = $2', [pid, sid]))[0].active;
    expect(await active('s1')).toBe(true); // its chunks hold a click
    // s5: a tab left open on one page, its pointer moving now and then, no events at all
    await query(`INSERT INTO recordings (project_id, session_id, started_at, reason, active) VALUES ($1, 's5', $2, 'sample', false)`, [pid, new Date(now - 50_000)]);
    await post({ k: key, a: 'anon-s5', sentAt: now, e: [chunk('s5', 40_000, [[1, 0, 5, 5]]), chunk('s5', 10_000, [[1, 0, 6, 6]], 1)] });
    // s6: the same, recorded before interactions were tracked; the events decide, and the list stores the outcome
    await query(`INSERT INTO recordings (project_id, session_id, started_at, reason) VALUES ($1, 's6', $2, 'sample')`, [pid, new Date(now - 50_000)]);
    await post({ k: key, a: 'anon-s6', sentAt: now, e: [chunk('s6', 40_000, [[1, 0, 5, 5]]), chunk('s6', 10_000, [[1, 0, 6, 6]], 1), ev('s6', 'pageview', 40_000)] });
    const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };
    const ids = async (f: Record<string, string> = {}) => (await R.listRecordings(pid, { ...range, ...f })).recordings.map((r) => r.sessionId).sort();
    expect(await ids()).toEqual(['s1']);
    expect(await active('s5')).toBe(false);
    expect(await active('s6')).toBe(false);
    expect(await ids({ inactive: '1' })).toEqual(['s1', 's5', 's6']);
    // scrolling is something
    await post({ k: key, a: 'anon-s5', sentAt: now, e: [chunk('s5', 5_000, [[3, 0, 0, 400]], 2)] });
    expect(await active('s5')).toBe(true);
    expect(await ids()).toEqual(['s1', 's5']);
  });

  it('stops storing as soon as recording is turned off', async () => {
    await settings({ enabled: false });
    expect(await R.publicConfig(key)).toEqual({ on: false });
    await post({ k: key, a: 'anon-s1', sentAt: now, e: [chunk('s1', 10_000, [[1, 0, 99, 99]], 2)] });
    await settings({ enabled: true });
    expect((await R.getRecording(pid, 's1', {})).chunks.map((c) => c.seq)).toEqual([0, 1]);
  });
});
