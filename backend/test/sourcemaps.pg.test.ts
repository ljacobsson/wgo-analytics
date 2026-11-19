/**
 * Source maps end to end: upload key (owners only), an error stored with its release, a map in the local store,
 * and errors() / events() returning the symbolicated stack. Runs in its own schema.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/sourcemaps.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'sourcemaps_test';

d('source maps (PostgreSQL)', async () => {
  if (!BASE) { it.skip('needs DATABASE_URL'); return; }
  const url = new URL(BASE);
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const P = await import('../src/lib/projects');
  const A = await import('../src/lib/analytics');
  const { mapKey } = await import('../src/lib/sourcemaps');
  const { location } = await import('../src/lib/store/files');
  const ingest = (await import('../src/handlers/ingest')).handler;
  const sourcemaps = (await import('../src/handlers/sourcemaps')).handler;

  const fix = join(import.meta.dirname, 'fixtures');
  const js = readFileSync(join(fix, 'app-abc123.js'), 'utf8');
  const col = js.indexOf('new Error') + 1;
  const owner = 'owner@test.dev';
  const member = 'member@test.dev';
  let pid = '';
  let writeKey = '';

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    const p = await P.createProject(owner, 'Mapped');
    pid = p.id;
    writeKey = p.writeKey;
    await P.addMember(owner, pid, member);
  });
  afterAll(async () => { await closeDb(); });

  it('creates the upload key on first read, only for owners, and rotates it', async () => {
    const a = await P.getUploadKey(owner, pid);
    expect(a.uploadKey).toMatch(/^uk_[A-Za-z0-9]{20,}$/);
    expect((await P.getUploadKey(owner, pid)).uploadKey).toBe(a.uploadKey);
    await expect(P.getUploadKey(member, pid)).rejects.toMatchObject({ status: 403 });
    await expect(P.rotateUploadKey(member, pid)).rejects.toMatchObject({ status: 403 });
    expect(JSON.stringify(await P.getProject(member, pid))).not.toContain(a.uploadKey);
    const b = await P.rotateUploadKey(owner, pid);
    expect(b.uploadKey).not.toBe(a.uploadKey);
    expect(await P.projectIdForUploadKey(b.uploadKey)).toBe(pid);
    expect(await P.projectIdForUploadKey(a.uploadKey)).toBeNull();
  });

  it('issues upload urls for the key and symbolicates stored errors', async () => {
    const { uploadKey } = await P.getUploadKey(owner, pid);
    const up = await sourcemaps({
      rawPath: '/sourcemaps/upload-url', headers: { 'x-wgo-upload-key': uploadKey, host: 'wgo.test' }, body: JSON.stringify({ file: 'app-abc123.js.map', release: 'v7' }),
      isBase64Encoded: false, requestContext: { http: { method: 'POST' } },
    } as unknown as APIGatewayProxyEventV2) as { statusCode: number; body: string };
    expect(up.statusCode).toBe(200);
    const { key } = JSON.parse(up.body);
    expect(key).toBe(mapKey(pid, 'v7', 'app-abc123.js'));
    await location().put(key, readFileSync(join(fix, 'app-abc123.js.map')));

    const now = Date.now();
    const stack = `Error: too expensive\n    at o (https://shop.test/assets/app-abc123.js:1:${col})\n    at n (https://shop.test/assets/app-abc123.js:1:3)`;
    const res = await ingest({
      rawPath: '/ingest', headers: {}, isBase64Encoded: false, requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({ k: writeKey, a: 'anon-1', sentAt: now, ctx: { ua: 'Mozilla/5.0 Chrome/120.0', release: 'v7' },
        e: [{ id: randomUUID(), t: 'error', ts: now - 1000, s: 's1', url: 'https://shop.test/cart', path: '/cart', d: { msg: 'too expensive', kind: 'error', stack } }] }),
    } as unknown as APIGatewayProxyEventV2) as { statusCode: number };
    expect(res.statusCode).toBeLessThan(300);

    const rel = await query<{ release: string }>('SELECT release FROM error_stacks WHERE project_id = $1', [pid]);
    expect(rel).toEqual([{ release: 'v7' }]);

    const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };
    const [g] = await A.errors(pid, range);
    expect(g.minifiedStack).toBe(stack);
    expect(g.sampleStack).toContain('src/cart.ts:4:');
    expect(g.sampleStack).toContain('at o (src/cart.ts:4:');
    expect(g.stackFrames![0]).toMatchObject({ mapped: true, line: 4 });
    expect(g.stackFrames![0].context!.lines.join('\n')).toContain('too expensive');

    const { events } = await A.events(pid, { ...range, type: 'error' });
    expect(events[0].errorStack).toContain('src/cart.ts:4:');
  });
});
