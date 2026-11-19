/**
 * Finding recordings by behaviour: hovers from the recording chunks, clicks, pages and errors from the events,
 * "did" and "did not" conditions, aliases. Runs in its own schema.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/recordingSearch.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'recording_search_test';

d('finding recordings by behaviour (PostgreSQL)', async () => {
  if (!BASE) { it.skip('needs DATABASE_URL'); return; }
  const url = new URL(BASE);
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { createProject } = await import('../src/lib/projects');
  const R = await import('../src/lib/recordings');
  const S = await import('../src/lib/recordingSearch');
  const CA = await import('../src/lib/clickAliases');
  const ingest = (await import('../src/handlers/ingest')).handler;

  const email = 'owner@test.dev';
  const now = Date.now();
  let pid = '';
  let key = '';

  const post = (body: unknown) => ingest({
    rawPath: '/ingest', headers: {}, body: JSON.stringify(body), isBase64Encoded: false, requestContext: { http: { method: 'POST' } },
  } as unknown as APIGatewayProxyEventV2);
  const chunk = (s: string, ago: number, r: unknown[][], q = 0) => ({ id: randomUUID(), t: 'replay', ts: now - ago, s, url: 'https://shop.test/', path: '/', d: { p: 'page-1', q, dur: 500, r } });
  const ev = (s: string, t: string, ago: number, extra: object = {}) => ({ id: randomUUID(), t, ts: now - ago, s, url: 'https://shop.test/', path: '/', ...extra });
  const snap = { w: 1280, h: 800, sx: 0, sy: 0, u: 'https://shop.test/', ti: 'Shop', ch: 'x', j: { html: '<p>hi</p>', css: [] } };
  const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };
  const find = async (s: Partial<import('../src/lib/recordingSearch').RecordingSearch>) => (await S.findRecordings(pid, { ...range, ...s })).recordings.map((r) => r.sessionId).sort();

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    const p = await createProject(email, 'Shop');
    pid = p.id;
    key = p.writeKey;
    await R.saveSettings(pid, email, { enabled: true, samplePercent: 100, triggers: [], maxPerHour: null, maxPerDay: null, maskAllText: false });

    // h1: hovered the buy button, never clicked it. h2: hovered and clicked it. h3: hovered docs only, then
    // reached /pricing and hit an error. h4: hovered the buy button briefly, clicked another button.
    for (const [i, s] of ['h1', 'h2', 'h3', 'h4'].entries()) await R.startRecording({ k: key, s, a: `anon-${s}`, r: 'sample' }, now - 120_000 + i);
    const base = (s: string) => [chunk(s, 60_000, [[4, 0, 1280, 800], [0, 10, snap]]), ev(s, 'pageview', 60_000)];
    const res = await post({
      k: key, a: 'anon', sentAt: now,
      e: [
        ...base('h1'), chunk('h1', 30_000, [[1, 0, 10, 20], [7, 2000, 'button.buy', 1500, 'Buy now'], [7, 4000, 'a.docs', 400, 'Docs']], 1),
        ...base('h2'), chunk('h2', 30_000, [[7, 2000, 'button.buy', 800, 'Buy now']], 1), ev('h2', 'click', 27_000, { d: { sel: 'button.buy', tag: 'button', text: 'Buy now' } }),
        ...base('h3'), chunk('h3', 30_000, [[7, 1000, 'a.docs', 700, null, 'docs-link']], 1),
        ev('h3', 'pageview', 20_000, { path: '/pricing/team', url: 'https://shop.test/pricing/team' }), ev('h3', 'error', 10_000, { d: { msg: 'Payment widget failed', kind: 'error' } }),
        ...base('h4'), chunk('h4', 30_000, [[7, 1000, 'button.buy', 320, 'Buy now']], 1), ev('h4', 'click', 25_000, { d: { sel: '#other', tag: 'button', text: 'Other' } }),
      ],
    });
    expect(res).toMatchObject({ statusCode: 202 });
  });
  afterAll(async () => { await closeDb(); });

  it('lists every recording without conditions', async () => {
    expect(await find({})).toEqual(['h1', 'h2', 'h3', 'h4']);
  });

  it('finds hovers by label, tracked name or selector, with when they happened', async () => {
    expect(await find({ did: [{ action: 'hover', target: 'BUY' }] })).toEqual(['h1', 'h2', 'h4']);
    expect(await find({ did: [{ action: 'hover', target: 'docs-link' }] })).toEqual(['h3']);
    expect(await find({ did: [{ action: 'hover', target: 'a.docs' }] })).toEqual(['h1', 'h3']);
    expect(await find({ did: [{ action: 'hover', target: 'buy', minMs: 1000 }] })).toEqual(['h1']);
    const [h1] = (await S.findRecordings(pid, { ...range, did: [{ action: 'hover', target: 'buy' }], limit: 5 })).recordings.filter((r) => r.sessionId === 'h1');
    // the hover started 2000 - 1500 ms after the chunk began, 30 s ago; the recording started 60 s ago
    expect(h1.moments).toEqual([{ action: 'hover', at: new Date(now - 30_000 + 500).toISOString(), offsetMs: 30_500, element: 'Buy now', selector: 'button.buy', hoverMs: 1500 }]);
  });

  it('hovered but never clicked: the same element, whatever else was clicked', async () => {
    expect(await find({ did: [{ action: 'hover', target: 'buy', notClicked: true }] })).toEqual(['h1', 'h4']);
    // the same, said as two conditions
    expect(await find({ did: [{ action: 'hover', target: 'buy' }], didNot: [{ action: 'click', target: 'buy' }] })).toEqual(['h1', 'h4']);
    expect(await find({ did: [{ action: 'hover', target: 'buy' }], didNot: [{ action: 'click' }] })).toEqual(['h1']);
  });

  it('matches click aliases', async () => {
    await CA.setAlias(pid, email, { selector: 'button.buy', alias: 'Checkout CTA' });
    expect(await find({ did: [{ action: 'hover', target: 'checkout cta', notClicked: true }] })).toEqual(['h1', 'h4']);
    expect(await find({ did: [{ action: 'click', target: 'checkout' }] })).toEqual(['h2']);
    const [h2] = (await S.findRecordings(pid, { ...range, did: [{ action: 'click', target: 'checkout' }] })).recordings;
    expect(h2.moments[0]).toMatchObject({ action: 'click', element: 'Checkout CTA', selector: 'button.buy' });
    await CA.deleteAlias(pid, 'button.buy');
  });

  it('combines pages, errors and hovers', async () => {
    expect(await find({ did: [{ action: 'pageview', target: '/pricing*' }] })).toEqual(['h3']);
    expect(await find({ did: [{ action: 'pageview', target: 'pricing' }, { action: 'error', target: 'payment' }] })).toEqual(['h3']);
    expect(await find({ did: [{ action: 'pageview', target: '/pricing' }] })).toEqual(['h3']); // a substring without *
    expect(await find({ did: [{ action: 'pageview', target: '/pricing' + '' }, { action: 'hover', target: 'buy' }] })).toEqual([]);
    expect(await find({ didNot: [{ action: 'error' }, { action: 'hover', target: 'docs' }] })).toEqual(['h2', 'h4']);
    const [h3] = (await S.findRecordings(pid, { ...range, did: [{ action: 'error' }, { action: 'hover' }] })).recordings;
    expect(h3.moments.map((m) => m.action)).toEqual(['error', 'hover']); // in the order asked
    expect(h3.moments[0].detail).toBe('Payment widget failed');
  });

  it('pages and rejects bad conditions', async () => {
    const first = await S.findRecordings(pid, { ...range, limit: 1 });
    expect(first.recordings).toHaveLength(1);
    expect(first.nextBefore).not.toBeNull();
    const rest = await S.findRecordings(pid, { ...range, before: first.nextBefore!, limit: 10 });
    expect(rest.recordings.length).toBe(3);
    await expect(S.findRecordings(pid, { did: [{ action: 'click', notClicked: true }] })).rejects.toThrow(/only apply to hovers/);
    await expect(S.findRecordings(pid, { didNot: [{ action: 'hover', notClicked: true }] })).rejects.toThrow(/did/);
    await expect(S.findRecordings(pid, { did: [{ action: 'look' as never }] })).rejects.toThrow(/Unknown action/);
  });
});
