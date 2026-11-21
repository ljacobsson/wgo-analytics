/**
 * MCP goal tools against PostgreSQL (own schema): list_goals, create_goal, update_goal and delete_goal act on the
 * same goals as the dashboard, validate filters like the API does, and only answer for project members.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/mcpGoals.pg.test.ts
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'mcp_goals_test';
const ORIGIN = 'http://localhost:8787';

d('MCP goal tools (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { createProject } = await import('../src/lib/projects');
  const { listGoals } = await import('../src/lib/goals');
  const { mcpFetch } = await import('../src/lib/mcp/http');

  /** Calls a tool through the real MCP endpoint (local mode: no OAuth, acts as `email`). */
  const callTool = async (name: string, args: Record<string, unknown>, email = 'owner@example.com') => {
    const res = await mcpFetch(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
      { publicOrigin: ORIGIN, auth: null, devEmail: email },
    );
    const body = await res.text();
    const msg = JSON.parse(body.startsWith('{') ? body : body.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
    const result = msg.result as { content: Array<{ text: string }>; isError?: boolean };
    return { isError: !!result.isError, text: result.content[0].text };
  };

  let pid: string;
  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    pid = (await createProject('owner@example.com', 'shop.example.com')).id;
  });
  afterAll(async () => closeDb());

  const signup = [{ field: 'type', op: 'eq', value: 'pageview' }, { field: 'path', op: 'eq', value: '/welcome' }];
  let goalId: string;

  it('creates a goal with funnel steps, credited to the caller', async () => {
    const r = await callTool('create_goal', {
      projectId: pid, name: ' Signed up ', filters: signup,
      steps: [{ name: 'Pricing', filters: [{ field: 'path', op: 'starts_with', value: '/pricing' }] }],
    });
    expect(r.isError).toBe(false);
    const goal = JSON.parse(r.text);
    goalId = goal.id;
    expect(goal).toMatchObject({ name: 'Signed up', filters: signup, createdBy: 'owner@example.com' });
    expect(goal.steps).toEqual([{ name: 'Pricing', filters: [{ field: 'path', op: 'starts_with', value: '/pricing' }] }]);
    expect((await listGoals(pid)).map((g) => g.id)).toEqual([goalId]);
    expect(JSON.parse((await callTool('list_goals', { projectId: pid })).text)).toEqual(await listGoals(pid));
  });

  it('turns numeric filter values into strings, as the API does', async () => {
    const r = await callTool('create_goal', { projectId: pid, name: 'Paid', filters: [{ field: 'httpStatus', op: 'eq', value: 201 }] });
    const goal = JSON.parse(r.text);
    expect(goal.filters).toEqual([{ field: 'httpStatus', op: 'eq', value: '201' }]);
    await callTool('delete_goal', { projectId: pid, goalId: goal.id });
  });

  it('rejects unknown fields and missing filters', async () => {
    expect(await callTool('create_goal', { projectId: pid, name: 'Bad', filters: [{ field: 'nope', op: 'eq', value: 'x' }] }))
      .toMatchObject({ isError: true });
    expect((await callTool('create_goal', { projectId: pid, name: 'Bad', filters: [] })).isError).toBe(true);
    expect(await listGoals(pid)).toHaveLength(1);
  });

  it('updates only what is given, and clears steps with []', async () => {
    const renamed = JSON.parse((await callTool('update_goal', { projectId: pid, goalId, name: 'Signup' })).text);
    expect(renamed).toMatchObject({ name: 'Signup', filters: signup });
    expect(renamed.steps).toHaveLength(1);
    const cleared = JSON.parse((await callTool('update_goal', { projectId: pid, goalId, steps: [] })).text);
    expect(cleared).toMatchObject({ name: 'Signup', steps: [] });
  });

  it('only answers for project members', async () => {
    expect(await callTool('list_goals', { projectId: pid }, 'stranger@example.com')).toEqual({ isError: true, text: 'Project not found' });
    expect(await callTool('create_goal', { projectId: pid, name: 'X', filters: signup }, 'stranger@example.com'))
      .toEqual({ isError: true, text: 'Project not found' });
    expect(await callTool('delete_goal', { projectId: pid, goalId }, 'stranger@example.com')).toEqual({ isError: true, text: 'Project not found' });
    expect(await listGoals(pid)).toHaveLength(1);
  });

  it('deletes a goal', async () => {
    expect(JSON.parse((await callTool('delete_goal', { projectId: pid, goalId })).text)).toEqual({ deleted: goalId });
    expect(await listGoals(pid)).toEqual([]);
    expect(await callTool('update_goal', { projectId: pid, goalId, name: 'Gone' })).toEqual({ isError: true, text: 'Goal not found' });
    expect(await callTool('delete_goal', { projectId: pid, goalId: 'not-a-uuid' })).toEqual({ isError: true, text: 'Goal not found' });
  });
});
