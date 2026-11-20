/**
 * MCP project creation against PostgreSQL (own schema): create_project makes a project owned by the caller and
 * returns a snippet whose write key sends data to it; get_install_snippet only answers for members.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/mcpProjects.pg.test.ts
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'mcp_projects_test';
const ORIGIN = 'http://localhost:8787';

d('MCP create_project (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { listProjects, projectIdForWriteKey } = await import('../src/lib/projects');
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

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
  });
  afterAll(async () => closeDb());

  let created: { project: { id: string; name: string; role: string; writeKey: string }; snippet: string; openTelemetry: Record<string, string> };

  it('creates a project owned by the caller and returns a snippet that sends data to it', async () => {
    const r = await callTool('create_project', { name: '  shop.example.com ' });
    expect(r.isError).toBe(false);
    created = JSON.parse(r.text);
    expect(created.project).toMatchObject({ name: 'shop.example.com', role: 'owner' });
    expect(created.snippet).toBe(`<script src="${ORIGIN}/sdk/v1/wgo.js" data-write-key="${created.project.writeKey}" data-endpoint="${ORIGIN}" async></script>`);
    expect(created.openTelemetry).toMatchObject({ OTEL_EXPORTER_OTLP_ENDPOINT: ORIGIN, OTEL_EXPORTER_OTLP_HEADERS: `x-wgo-key=${created.project.writeKey}` });
    expect(await projectIdForWriteKey(created.project.writeKey)).toBe(created.project.id);
    expect((await listProjects('owner@example.com')).map((p) => p.id)).toEqual([created.project.id]);
  });

  it('rejects a blank name', async () => {
    const r = await callTool('create_project', { name: '   ' });
    expect(r).toEqual({ isError: true, text: 'Project name must be 1-100 characters' });
  });

  it('gives the same snippet for an existing project, to members only', async () => {
    const again = JSON.parse((await callTool('get_install_snippet', { projectId: created.project.id })).text);
    expect(again.snippet).toBe(created.snippet);
    expect(await callTool('get_install_snippet', { projectId: created.project.id }, 'stranger@example.com')).toEqual({ isError: true, text: 'Project not found' });
  });
});
