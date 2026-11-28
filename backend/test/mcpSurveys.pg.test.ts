/**
 * MCP survey tools against PostgreSQL (own schema): list_surveys, create_survey, update_survey, delete_survey and survey_results act on the
 * same surveys as the dashboard, validate like the API does, and only answer for project members.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/mcpSurveys.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'mcp_surveys_test';
const ORIGIN = 'http://localhost:8787';

d('MCP survey tools (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { createProject } = await import('../src/lib/projects');
  const { listSurveys, respond } = await import('../src/lib/surveys');
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
  let writeKey: string;
  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    const project = await createProject('owner@example.com', 'shop.example.com');
    pid = project.id;
    writeKey = project.writeKey;
  });
  afterAll(async () => closeDb());

  const questions = [
    { type: 'nps', title: 'How likely are you to recommend us?' },
    { type: 'single', title: 'What is your role?', options: ['Dev', 'PM'], required: true },
    { type: 'text', title: 'Anything else?' },
  ];
  let id: string;

  it('creates a draft survey, credited to the caller, and lists it', async () => {
    const r = await callTool('create_survey', { projectId: pid, name: ' Feedback ', questions, display: { mode: 'inline', selector: '#feedback' }, targeting: { paths: ['/docs/*'] } });
    expect(r.isError).toBe(false);
    const s = JSON.parse(r.text);
    id = s.id;
    expect(s).toMatchObject({ name: 'Feedback', status: 'draft', createdBy: 'owner@example.com', responses: 0 });
    expect(s.questions.map((q: { id: string }) => q.id)).toEqual(['q1', 'q2', 'q3']);
    const list = JSON.parse((await callTool('list_surveys', { projectId: pid })).text);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id, name: 'Feedback', status: 'draft', questions: 3, questionTypes: ['nps', 'single', 'text'],
      display: { mode: 'inline', selector: '#feedback' }, targeting: { paths: ['/docs/*'], frequency: 'once' }, responses: 0, lastResponseAt: null,
    });
  });

  it('surfaces a validation error as a tool error', async () => {
    const r = await callTool('create_survey', { projectId: pid, name: 'Bad', questions: [{ type: 'single', title: 'Pick', options: ['Only one', 'Only one'] }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/same option twice/);
    const inline = await callTool('create_survey', { projectId: pid, name: 'Bad', questions, display: { mode: 'inline' } });
    expect(inline).toMatchObject({ isError: true });
    expect(inline.text).toMatch(/selector/);
    expect(await listSurveys(pid)).toHaveLength(1);
  });

  it('activates it, keeping what was not given', async () => {
    const s = JSON.parse((await callTool('update_survey', { projectId: pid, surveyId: id, status: 'active' })).text);
    expect(s).toMatchObject({ status: 'active', name: 'Feedback', display: { mode: 'inline', selector: '#feedback' } });
    expect(s.questions).toHaveLength(3);
  });

  it('reports results with question titles', async () => {
    const answer = (ans: Record<string, unknown>) => respond({ k: writeKey, id, r: randomUUID(), a: randomUUID(), path: '/docs/a', ans });
    expect(await answer({ q1: 10, q2: 'Dev', q3: 'Great docs' })).toEqual({ ok: true });
    expect(await answer({ q1: 6, q2: 'PM' })).toEqual({ ok: true });

    const r = await callTool('survey_results', { projectId: pid, surveyId: id });
    expect(r.isError).toBe(false);
    const res = JSON.parse(r.text);
    expect(res).toMatchObject({ survey: { id, name: 'Feedback', status: 'active' }, responses: 2, shown: 0, dismissed: 0, responseRate: null });
    const [nps, role, text] = res.questions;
    expect(nps).toMatchObject({ title: 'How likely are you to recommend us?', type: 'nps', answered: 2, average: 8, nps: 0 });
    expect(role).toMatchObject({ title: 'What is your role?', type: 'single', counts: [{ value: 'Dev', n: 1 }, { value: 'PM', n: 1 }] });
    expect(text).toMatchObject({ type: 'text', answered: 1 });
    expect(text.texts.map((t: { text: string }) => t.text)).toEqual(['Great docs']);
    expect(res.latestResponses).toHaveLength(2);
    expect(res.latestResponses.some((x: { answers: Record<string, unknown> }) => x.answers['Anything else?'] === 'Great docs')).toBe(true);

    const none = JSON.parse((await callTool('survey_results', { projectId: pid, surveyId: id, responses: 0, range: '7d' })).text);
    expect(none.latestResponses).toEqual([]);
    expect(none.responses).toBe(2);
    expect(JSON.parse((await callTool('list_surveys', { projectId: pid })).text)[0]).toMatchObject({ responses: 2 });
    expect(await callTool('survey_results', { projectId: pid, surveyId: id, range: '100d' })).toMatchObject({ isError: true });
  });

  it('only answers for project members', async () => {
    expect(await callTool('list_surveys', { projectId: pid }, 'stranger@example.com')).toEqual({ isError: true, text: 'Project not found' });
    expect(await callTool('delete_survey', { projectId: pid, surveyId: id }, 'stranger@example.com')).toEqual({ isError: true, text: 'Project not found' });
    expect(await listSurveys(pid)).toHaveLength(1);
  });

  it('deletes the survey and its responses', async () => {
    expect(JSON.parse((await callTool('delete_survey', { projectId: pid, surveyId: id })).text)).toEqual({ deleted: id });
    expect(await listSurveys(pid)).toEqual([]);
    expect((await query('SELECT 1 FROM survey_responses WHERE project_id = $1', [pid])).length).toBe(0);
    expect(await callTool('survey_results', { projectId: pid, surveyId: id })).toEqual({ isError: true, text: 'Survey not found' });
    expect(await callTool('update_survey', { projectId: pid, surveyId: id, name: 'Gone' })).toEqual({ isError: true, text: 'Survey not found' });
  });
});
