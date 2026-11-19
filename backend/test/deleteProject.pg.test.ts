/**
 * Deleting a project against PostgreSQL (own schema) and Parquet in a temp directory: only owners can, the project
 * and its settings are gone at once, and the maintenance purge removes the rest of its data (keeping other
 * projects' data) and forgets the project once the grace period is over.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/deleteProject.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'delete_project_test';

d('deleting a project (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const P = await import('../src/lib/projects');
  const { purgeDeletedProjects } = await import('../src/lib/purge');
  const { writeRows } = await import('../src/lib/store/write');
  const { location } = await import('../src/lib/store/files');
  const { projectPrefix } = await import('../src/lib/store/tables');
  const api = (await import('../src/handlers/api')).handler;
  type EventRow = import('../src/lib/events').EventRow;

  const OWNER = 'owner@example.com';
  const MEMBER = 'member@example.com';
  const STRANGER = 'stranger@example.com';
  let doomed: Awaited<ReturnType<typeof P.createProject>>;
  let kept: Awaited<ReturnType<typeof P.createProject>>;

  const call = async (method: string, path: string, email = OWNER) => {
    const r = (await api({
      rawPath: path, headers: {}, isBase64Encoded: false,
      requestContext: { http: { method }, authorizer: { jwt: { claims: { email } } } },
    } as unknown as APIGatewayProxyEventV2 as never)) as APIGatewayProxyStructuredResultV2;
    return { status: r.statusCode!, body: JSON.parse(r.body as string) };
  };

  const event = (pid: string, ts: Date): EventRow => ({
    project_id: pid, id: randomUUID(), ts, type: 'pageview', session_id: 's1', anon_id: 'a1', user_id: null, url: 'https://x.test/', path: '/',
    title: null, referrer: null, selector: null, element_text: null, element_tag: null, track_name: null, error_message: null,
    error_stack: null, error_source: null, fingerprint: null, http_method: null, http_url: null, http_route: null, http_status: null,
    duration_ms: null, name: null, props: {}, browser: null, os: null, device: null, country: null, region: null, city: null,
    lat: null, lon: null, bot: null,
  });

  const count = async (table: string, pid: string) =>
    (await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE project_id = $1`, [pid]))[0].n;
  const files = async (pid: string) => (await location().list(projectPrefix('events', pid))).length;

  /** a bit of everything a project accumulates */
  async function fill(pid: string) {
    const hour = new Date(Math.floor(Date.now() / 3600_000) * 3600_000);
    await query(`INSERT INTO saved_views (project_id, id, name, page, params, created_by) VALUES ($1, $2, 'v', 'events', '', $3)`, [pid, randomUUID(), OWNER]);
    await query(`INSERT INTO goals (project_id, id, name, filters, created_by) VALUES ($1, $2, 'g', '[]', $3)`, [pid, randomUUID(), OWNER]);
    await query(`INSERT INTO error_stacks (project_id, fingerprint, stack, updated_at) VALUES ($1, 'fp', 'Error', now())`, [pid]);
    for (let i = 0; i < 1200; i++) {
      await query(`INSERT INTO identities (project_id, anon_id, user_id) VALUES ($1, $2, 'u')`, [pid, `a${i}`]);
    }
    await query(`INSERT INTO rollups (project_id, dim, hour, key, events, sessions) VALUES ($1, 'type', $2, 'pageview', 3, 1)`, [pid, hour]);
    await query(`INSERT INTO rollup_sketches (project_id, hour, sessions, users) VALUES ($1, $2, '\\x00', '\\x00')`, [pid, hour]);
    await query(`INSERT INTO recordings (project_id, session_id, started_at, reason) VALUES ($1, 's1', now(), 'sampled')`, [pid]);
    await writeRows('events', [event(pid, new Date(Date.now() - 2 * 86_400_000)), event(pid, new Date())]);
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    doomed = await P.createProject(OWNER, 'Doomed');
    kept = await P.createProject(OWNER, 'Kept');
    await P.addMember(OWNER, doomed.id, MEMBER);
    await fill(doomed.id);
    await fill(kept.id);
  });

  afterAll(async () => {
    await closeDb();
  });

  it('only an owner can delete a project', async () => {
    expect((await call('DELETE', `/api/projects/${doomed.id}`, MEMBER)).status).toBe(403);
    expect((await call('DELETE', `/api/projects/${doomed.id}`, STRANGER)).status).toBe(404);
    expect((await call('GET', `/api/projects/${doomed.id}`)).status).toBe(200);
  });

  it('removes the project, its members and settings at once', async () => {
    expect(await P.projectIdForWriteKey(doomed.writeKey)).toBe(doomed.id);
    const res = await call('DELETE', `/api/projects/${doomed.id}`);
    expect(res).toEqual({ status: 200, body: { ok: true } });

    expect((await call('GET', '/api/me')).body.projects.map((p: { id: string }) => p.id)).toEqual([kept.id]);
    expect((await call('GET', '/api/me', MEMBER)).body.projects).toEqual([]);
    expect((await call('GET', `/api/projects/${doomed.id}`)).status).toBe(404);
    expect((await call('DELETE', `/api/projects/${doomed.id}`)).status).toBe(404);
    expect(await P.projectIdForWriteKey(doomed.writeKey)).toBeNull();
    for (const t of P.PROJECT_CONFIG_TABLES) expect(await count(t, doomed.id)).toBe(0);
    expect(await query('SELECT id FROM deleted_projects')).toEqual([{ id: doomed.id }]);
    // bulk data waits for the maintenance job
    expect(await count('identities', doomed.id)).toBe(1200);
    expect(await files(doomed.id)).toBe(2);
  });

  it('purges the data in the background and forgets the project after the grace period', async () => {
    const first = await purgeDeletedProjects(Date.now() + 60_000);
    expect(first).toEqual({ done: true, purged: [], files: 2 });
    for (const t of ['error_stacks', 'identities', 'rollups', 'rollup_sketches', 'recordings']) expect(await count(t, doomed.id)).toBe(0);
    expect(await files(doomed.id)).toBe(0);
    // still listed: data sent just before the delete may yet arrive
    expect(await query('SELECT id FROM deleted_projects')).toHaveLength(1);

    // a late batch lands, and the next run after the grace period removes it and the tombstone
    await writeRows('events', [event(doomed.id, new Date())]);
    const later = await purgeDeletedProjects(Date.now() + 60_000, Date.now() + 2 * 3600_000);
    expect(later).toEqual({ done: true, purged: [doomed.id], files: 1 });
    expect(await files(doomed.id)).toBe(0);
    expect(await query('SELECT id FROM deleted_projects')).toEqual([]);
    expect(await purgeDeletedProjects(Date.now() + 60_000)).toEqual({ done: true, purged: [], files: 0 });
  });

  it('leaves other projects alone', async () => {
    expect((await call('GET', `/api/projects/${kept.id}`)).status).toBe(200);
    expect(await count('project_members', kept.id)).toBe(1);
    expect(await count('saved_views', kept.id)).toBe(1);
    expect(await count('identities', kept.id)).toBe(1200);
    expect(await count('rollups', kept.id)).toBe(1);
    expect(await files(kept.id)).toBe(2);
  });

  it('stops when the time is up and continues next run', async () => {
    const p = await P.createProject(OWNER, 'Slow');
    await fill(p.id);
    await P.deleteProject(OWNER, p.id);
    expect((await purgeDeletedProjects(Date.now() - 1)).done).toBe(false);
    expect(await purgeDeletedProjects(Date.now() + 60_000, Date.now() + 2 * 3600_000)).toEqual({ done: true, purged: [p.id], files: 2 });
  });
});
