/**
 * MCP dashboard tools against PostgreSQL (own schema): query_measures, list_measure_names and the dashboard tools
 * act on the same data as the dashboard, validate like the API does, and only answer for project members.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/mcpDashboards.pg.test.ts
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'mcp_dashboards_test';
const ORIGIN = 'http://localhost:8787';

d('MCP dashboard tools (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { createProject } = await import('../src/lib/projects');
  const { listDashboards, getDashboard } = await import('../src/lib/dashboards');
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

  const pageviews = { source: 'events', agg: 'count', filters: [{ field: 'type', op: 'eq', value: 'pageview' }] };

  it('query_measures answers a total and a top query', async () => {
    const total = await callTool('query_measures', { projectId: pid, shape: 'total', measures: [pageviews], compare: true });
    expect(total.isError).toBe(false);
    const t = JSON.parse(total.text);
    expect(t.measures).toHaveLength(1);
    expect(t.measures[0].total).toBe(0);
    const top = await callTool('query_measures', { projectId: pid, range: '7d', shape: 'top', groupBy: 'path', measures: [pageviews] });
    expect(top.isError).toBe(false);
    expect(JSON.parse(top.text).measures[0].groups).toEqual([]);
  });

  it('query_measures turns a bad measure into a tool error', async () => {
    const r = await callTool('query_measures', { projectId: pid, shape: 'total', measures: [{ source: 'events', agg: 'count', filters: [{ field: 'nope', op: 'eq', value: 'x' }] }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/nope/i);
    expect((await callTool('query_measures', { projectId: pid, shape: 'total', measures: [{ source: 'logs', agg: 'users' }] })).isError).toBe(true);
  });

  it('lists measure names', async () => {
    const r = await callTool('list_measure_names', { projectId: pid });
    expect(JSON.parse(r.text)).toEqual({ trackedClicks: [], customEvents: [], metrics: [] });
  });

  let dashId: string;
  it('creates a dashboard and stacks tiles without layout', async () => {
    const r = await callTool('create_dashboard', {
      projectId: pid, name: ' Overview ',
      tiles: [
        { viz: 'number', title: 'Pageviews', measures: [{ ...pageviews, unit: 'count' }] },
        { viz: 'top', title: 'Top pages', groupBy: 'path', measures: [pageviews] },
        { viz: 'line', title: 'Uptime', measures: [{ source: 'checks', agg: 'rate', unit: 'percent', better: 'up' }], layout: { x: 6, y: 0, w: 6, h: 2 } },
      ],
    });
    expect(r.isError).toBe(false);
    const dash = JSON.parse(r.text);
    dashId = dash.id;
    expect(dash.name).toBe('Overview');
    expect(dash.createdBy).toBe('owner@example.com');
    expect(dash.config.tiles.map((t: { layout: unknown }) => t.layout)).toEqual([
      { x: 0, y: 0, w: 6, h: 2 }, { x: 0, y: 2, w: 6, h: 4 }, { x: 6, y: 0, w: 6, h: 2 },
    ]);
    expect(new Set(dash.config.tiles.map((t: { id: string }) => t.id)).size).toBe(3);
  });

  it('adds a tile below the others', async () => {
    const r = await callTool('add_dashboard_tile', { projectId: pid, dashboardId: dashId, tile: { viz: 'text', text: 'Notes' } });
    expect(r.isError).toBe(false);
    const dash = JSON.parse(r.text);
    expect(dash.config.tiles).toHaveLength(4);
    expect(dash.config.tiles[3]).toMatchObject({ viz: 'text', text: 'Notes', layout: { x: 0, y: 6, w: 6, h: 4 } });
  });

  it('gets and lists dashboards', async () => {
    const got = JSON.parse((await callTool('get_dashboard', { projectId: pid, dashboardId: dashId })).text);
    expect(got.config).toEqual((await getDashboard(pid, dashId)).config);
    const list = JSON.parse((await callTool('list_dashboards', { projectId: pid })).text);
    expect(list).toMatchObject([{ id: dashId, name: 'Overview', tiles: 4 }]);
    expect((await callTool('get_dashboard', { projectId: pid, dashboardId: 'missing' })).isError).toBe(true);
  });

  it('rejects a tile with an unknown field and leaves the dashboard alone', async () => {
    const bad = await callTool('add_dashboard_tile', {
      projectId: pid, dashboardId: dashId,
      tile: { viz: 'number', measures: [{ source: 'events', agg: 'count', filters: [{ field: 'nope', op: 'eq', value: 'x' }] }] },
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/nope/i);
    expect((await getDashboard(pid, dashId)).config.tiles).toHaveLength(4);
    expect((await callTool('create_dashboard', { projectId: pid, name: 'Bad', tiles: [{ viz: 'top', measures: [pageviews] }] })).isError).toBe(true);
    expect(await listDashboards(pid)).toHaveLength(1);
  });

  it('renames a dashboard and keeps its tiles', async () => {
    const dash = JSON.parse((await callTool('update_dashboard', { projectId: pid, dashboardId: dashId, name: 'Traffic' })).text);
    expect(dash.name).toBe('Traffic');
    expect(dash.config.tiles).toHaveLength(4);
  });

  it('replaces the config', async () => {
    const dash = JSON.parse((await callTool('update_dashboard', {
      projectId: pid, dashboardId: dashId, config: { tiles: [{ viz: 'number', measures: [pageviews] }], range: '7d' },
    })).text);
    expect(dash.config).toMatchObject({ range: '7d', tiles: [{ viz: 'number', layout: { x: 0, y: 0, w: 6, h: 2 } }] });
  });

  it('keeps SQL tiles through get_dashboard and update_dashboard', async () => {
    const sqlTile = { id: 'sq', viz: 'line', sql: { query: "SELECT date_trunc('hour', ts) AS h, count(*) AS n FROM events GROUP BY 1", x: 'h', y: ['n'], unit: 'count' } };
    const added = JSON.parse((await callTool('add_dashboard_tile', { projectId: pid, dashboardId: dashId, tile: sqlTile })).text);
    expect(added.config.tiles.find((t: { id: string }) => t.id === 'sq').sql).toEqual(sqlTile.sql);
    const got = JSON.parse((await callTool('get_dashboard', { projectId: pid, dashboardId: dashId })).text);
    const res = await callTool('update_dashboard', { projectId: pid, dashboardId: dashId, config: got.config });
    expect(res.isError).toBe(false);
    expect((await getDashboard(pid, dashId)).config.tiles.find((t) => t.id === 'sq')?.sql).toEqual(sqlTile.sql);
  });

  it('only answers for project members', async () => {
    expect(await callTool('list_dashboards', { projectId: pid }, 'stranger@example.com')).toEqual({ isError: true, text: 'Project not found' });
    expect(await callTool('delete_dashboard', { projectId: pid, dashboardId: dashId }, 'stranger@example.com')).toEqual({ isError: true, text: 'Project not found' });
    expect(await listDashboards(pid)).toHaveLength(1);
  });

  it('deletes a dashboard', async () => {
    expect(JSON.parse((await callTool('delete_dashboard', { projectId: pid, dashboardId: dashId })).text)).toEqual({ deleted: dashId });
    expect(await listDashboards(pid)).toEqual([]);
    expect((await callTool('delete_dashboard', { projectId: pid, dashboardId: dashId })).isError).toBe(true);
  });
});
