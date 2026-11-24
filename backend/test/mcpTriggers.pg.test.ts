/**
 * MCP trigger tools against PostgreSQL (own schema): list_triggers, create_trigger, update_trigger, delete_trigger
 * and test_trigger act on the same triggers as the dashboard, validate like the API does, and only answer for members.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/mcpTriggers.pg.test.ts
 */
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'mcp_triggers_test';
const ORIGIN = 'http://localhost:8787';

d('MCP trigger tools (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { createProject } = await import('../src/lib/projects');
  const { listTriggers } = await import('../src/lib/triggers');
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
  const SLACK_ID = '6f1d1e2a-0000-4000-8000-000000000001';
  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    pid = (await createProject('owner@example.com', 'shop.example.com')).id;
    await query(`INSERT INTO integrations (project_id, id, type, config, created_by) VALUES ($1, $2, 'slack', $3::jsonb, 'owner@example.com')`,
      [pid, SLACK_ID, JSON.stringify({ channel: '#alerts', teamName: 'Shop', webhookUrl: 'https://hooks.slack.com/services/T/B/secret' })]);
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => closeDb());

  const errors = [{ field: 'type', op: 'eq', value: 'error' }, { field: 'path', op: 'starts_with', value: '/checkout' }];
  let webhookId: string;
  let slackId: string;

  it('creates a match trigger to a webhook, with the signing secret to verify it', async () => {
    const r = await callTool('create_trigger', { projectId: pid, name: 'Checkout errors', filters: errors, destination: { type: 'webhook', url: 'https://example.com/hook' } });
    expect(r.isError).toBe(false);
    const t = JSON.parse(r.text);
    webhookId = t.id;
    expect(t).toMatchObject({ name: 'Checkout errors', kind: 'match', scope: 'events', filters: errors, cooldownSeconds: 300, enabled: true, createdBy: 'owner@example.com' });
    expect(t.signingSecret).toMatch(/^whsec_/);
  });

  it('creates a threshold trigger to a connected Slack channel, without the secret', async () => {
    const r = await callTool('create_trigger', {
      projectId: pid, name: 'No traffic', kind: 'threshold', filters: [{ field: 'type', op: 'eq', value: 'pageview' }],
      metric: { agg: 'count' }, condition: { op: 'below', value: 1 }, windowMinutes: 30, destination: { type: 'slack', integrationId: SLACK_ID },
    });
    expect(r.isError).toBe(false);
    const t = JSON.parse(r.text);
    slackId = t.id;
    expect(t).toMatchObject({ kind: 'threshold', metric: { agg: 'count' }, condition: { op: 'below', value: 1 }, windowMinutes: 30 });
    expect(t).not.toHaveProperty('signingSecret');
  });

  it('rejects what the API rejects', async () => {
    const bad = async (args: Record<string, unknown>) => callTool('create_trigger', { projectId: pid, name: 'Bad', filters: errors, destination: { type: 'webhook', url: 'https://example.com/hook' }, ...args });
    expect(await bad({ destination: { type: 'webhook', url: 'https://localhost/hook' } })).toEqual({ isError: true, text: 'Webhook URL must point to a public host' });
    expect(await bad({ destination: { type: 'slack', integrationId: 'nope' } })).toEqual({ isError: true, text: 'That Slack channel is not connected to this project' });
    expect((await bad({ filters: [] })).isError).toBe(true);
    expect((await bad({ kind: 'threshold', metric: { agg: 'count' }, condition: { op: 'above', value: 1 }, windowMinutes: 7 })).isError).toBe(true);
    expect(await listTriggers(pid)).toHaveLength(2);
  });

  it('lists triggers and the Slack channels they can use, never the Slack webhook URL', async () => {
    const r = await callTool('list_triggers', { projectId: pid });
    const body = JSON.parse(r.text);
    expect(body.triggers.map((t: { id: string }) => t.id)).toEqual([webhookId, slackId]);
    expect(body.slackChannels).toEqual([{ id: SLACK_ID, channel: '#alerts', teamName: 'Shop' }]);
    expect(r.text).not.toContain('hooks.slack.com');
  });

  it('pauses a trigger and keeps what is left out', async () => {
    const t = JSON.parse((await callTool('update_trigger', { projectId: pid, triggerId: webhookId, enabled: false, cooldownSeconds: 60 })).text);
    expect(t).toMatchObject({ name: 'Checkout errors', filters: errors, enabled: false, cooldownSeconds: 60 });
  });

  it('sends a test notification', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(JSON.parse((await callTool('test_trigger', { projectId: pid, triggerId: webhookId })).text)).toEqual({ ok: true, status: '204' });
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/hook', expect.objectContaining({ method: 'POST' }));
  });

  const design = { blocks: [
    { type: 'header', text: { type: 'plain_text', text: '{{headline}}' } },
    { type: 'section', text: { type: 'mrkdwn', text: 'Now *{{value}}* in {{project.name}}' } },
  ] };
  const slackBodies = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string) as { text: string; blocks: Array<{ text?: { text: string } }> });

  it('saves a Slack message design, sends it, and clears it with null', async () => {
    const t = JSON.parse((await callTool('update_trigger', { projectId: pid, triggerId: slackId, slackTemplate: design })).text);
    expect(t.slackTemplate).toEqual(design);
    expect((await listTriggers(pid)).find((x) => x.id === slackId)?.slackTemplate).toEqual(design);
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(JSON.parse((await callTool('test_trigger', { projectId: pid, triggerId: slackId })).text)).toEqual({ ok: true, status: '200' });
    const [msg] = slackBodies(fetchMock);
    expect(msg.blocks.map((b) => b.text?.text)).toEqual(['[test] 🔔 No traffic', 'Now *0* in shop.example.com']);
    expect(msg.text).toMatch(/^\[test\] 🔔 No traffic: Count in the last 30 minutes is 0/);
    const cleared = JSON.parse((await callTool('update_trigger', { projectId: pid, triggerId: slackId, slackTemplate: null })).text);
    expect(cleared.slackTemplate).toBeNull();
  });

  it('tries a design before saving it', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await callTool('test_trigger', { projectId: pid, triggerId: slackId, slackTemplate: { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Draft {{state}}' } }] } });
    expect(slackBodies(fetchMock)[0].blocks).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: 'Draft firing' } }]);
    expect((await listTriggers(pid)).find((x) => x.id === slackId)?.slackTemplate).toBeNull();
  });

  it('sends the default message when Slack rejects the design, and says so', async () => {
    await callTool('update_trigger', { projectId: pid, triggerId: slackId, slackTemplate: design });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('invalid_blocks', { status: 400 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(JSON.parse((await callTool('test_trigger', { projectId: pid, triggerId: slackId })).text)).toEqual({ ok: false, status: '200 (custom message rejected: invalid_blocks)' });
    const [, fallback] = slackBodies(fetchMock);
    expect(fallback.blocks[0].text?.text).toBe('[test] 🔔 No traffic');
    expect(fallback.blocks.map((b) => (b as { type: string }).type)).toEqual(['header', 'section', 'section']); // the default: header, summary, explanation (no dashboard link here)
  });

  it('rejects a broken design', async () => {
    const bad = (slackTemplate: unknown) => callTool('update_trigger', { projectId: pid, triggerId: slackId, slackTemplate });
    expect((await bad({ blocks: [] })).isError).toBe(true);
    expect(await bad({ blocks: [{ type: 'modal' }] })).toEqual({ isError: true, text: 'Block 1: "modal" blocks aren\'t supported (use header, section, context, divider, actions, image, rich_text)' });
  });

  it('only answers for project members', async () => {
    const stranger = 'stranger@example.com';
    expect(await callTool('list_triggers', { projectId: pid }, stranger)).toEqual({ isError: true, text: 'Project not found' });
    expect(await callTool('delete_trigger', { projectId: pid, triggerId: webhookId }, stranger)).toEqual({ isError: true, text: 'Project not found' });
    expect(await listTriggers(pid)).toHaveLength(2);
  });

  it('deletes a trigger', async () => {
    expect(JSON.parse((await callTool('delete_trigger', { projectId: pid, triggerId: webhookId })).text)).toEqual({ deleted: webhookId });
    expect((await listTriggers(pid)).map((t) => t.id)).toEqual([slackId]);
    expect(await callTool('test_trigger', { projectId: pid, triggerId: webhookId })).toEqual({ isError: true, text: 'Trigger not found' });
  });
});
