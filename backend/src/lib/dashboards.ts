import { randomUUID } from 'node:crypto';
import type { Dashboard, DashboardConfig, DashboardInput, DashboardSummary, DashboardTile, QuerySpec, SqlResult, SqlTileQuery, TileMeasure, TileUnit, TileViz } from '../contract';
import { query } from './db';
import { filterSql, parseFilters } from './filters';
import { HttpError } from './http';
import { isUuid } from './projects';
import { validateMeasure, validateSpec } from './query';
import * as SQL from './sql';

/**
 * Custom dashboards: named grids of tiles, each one a generic query (lib/query.ts) and a way to show it. A dashboard
 * belongs to its project; every member sees and edits it. The whole layout is one jsonb config, validated on write.
 */

export const MAX_DASHBOARDS = 50;
export const MAX_TILES = 40;
const MAX_CONFIG_BYTES = 200_000;
export const COLS = 12;
const MAX_ROWS = 12;
const MAX_Y = 1000;
export const TILE_VIZ: readonly TileViz[] = ['number', 'line', 'area', 'bars', 'top', 'table', 'text', 'columns', 'pie', 'scatter'];
/** Chart types that only SQL tiles have */
const SQL_ONLY_VIZ: readonly TileViz[] = ['columns', 'pie', 'scatter'];
const UNITS: readonly TileUnit[] = ['count', 'ms', 's', 'bytes', 'percent', 'score', 'none'];
export const TILE_RANGES = ['15m', '1h', '24h', '7d', '30d'] as const;
const SQL_VIZ: readonly TileViz[] = ['number', 'line', 'area', 'bars', 'top', 'table', 'columns', 'pie', 'scatter'];
const MAX_TILE_SQL = 20_000;
/** Rows a SQL tile's chart gets */
const SQL_TILE_ROWS = 5000;

interface Row { project_id: string; id: string; name: string; config: DashboardConfig; created_by: string; created_at: Date; updated_at: Date }

const toDashboard = (r: Row): Dashboard => ({
  id: r.id, name: r.name, config: r.config, createdBy: r.created_by, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

const dashboardName = (v: unknown) => {
  const n = typeof v === 'string' ? v.trim() : '';
  if (!n || n.length > 120) throw new HttpError(400, 'Dashboard name must be 1-120 characters');
  return n;
};

const int = (v: unknown, min: number, max: number, what: string) => {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new HttpError(400, `${what} must be a whole number from ${min} to ${max}`);
  return v as number;
};
const optRange = (v: unknown, what: string) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (!(TILE_RANGES as readonly unknown[]).includes(v)) throw new HttpError(400, `${what} must be one of ${TILE_RANGES.join(', ')}`);
  return v as string;
};

/** The query shape a tile runs for its chart type. */
export function tileShape(t: Pick<DashboardTile, 'viz' | 'groupBy'>): QuerySpec['shape'] {
  if (t.viz === 'number') return 'total';
  if (t.viz === 'top') return 'top';
  if (t.viz === 'table') return t.groupBy ? 'top' : 'total';
  return 'series';
}

function sanitizeMeasure(raw: unknown, where: string): TileMeasure {
  const o = (raw ?? {}) as Record<string, unknown>;
  let m: TileMeasure;
  try {
    m = validateMeasure(o);
  } catch (e) {
    if (e instanceof HttpError) throw new HttpError(400, `${where}: ${e.message}`);
    throw e;
  }
  if (o.label !== undefined && o.label !== '') {
    if (typeof o.label !== 'string' || o.label.length > 80) throw new HttpError(400, `${where}: label must be at most 80 characters`);
    m.label = o.label;
  }
  if (o.unit !== undefined) {
    if (!UNITS.includes(o.unit as TileUnit)) throw new HttpError(400, `${where}: unit must be one of ${UNITS.join(', ')}`);
    m.unit = o.unit as TileUnit;
  }
  if (o.better !== undefined) {
    if (o.better !== 'up' && o.better !== 'down') throw new HttpError(400, `${where}: better must be up or down`);
    m.better = o.better;
  }
  return m;
}

const column = (v: unknown, what: string) => {
  if (typeof v !== 'string' || !v || v.length > 128) throw new HttpError(400, `${what} must be a column name of up to 128 characters`);
  return v;
};

function sanitizeSqlTile(raw: unknown, where: string): SqlTileQuery {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.query !== 'string' || !o.query.trim()) throw new HttpError(400, `${where}: the SQL query is empty`);
  if (o.query.length > MAX_TILE_SQL) throw new HttpError(400, `${where}: the SQL query must be at most ${MAX_TILE_SQL} characters`);
  const out: SqlTileQuery = { query: o.query };
  if (o.x !== undefined && o.x !== null && o.x !== '') out.x = column(o.x, `${where}: x`);
  if (o.y !== undefined && o.y !== null) {
    if (!Array.isArray(o.y) || o.y.length > 8) throw new HttpError(400, `${where}: y must be a list of at most 8 columns`);
    const y = o.y.map((c, k) => column(c, `${where}: y ${k + 1}`));
    if (y.length) out.y = y;
  }
  if (o.series !== undefined && o.series !== null && o.series !== '') out.series = column(o.series, `${where}: series`);
  if (o.unit !== undefined && o.unit !== null) {
    if (!UNITS.includes(o.unit as TileUnit)) throw new HttpError(400, `${where}: unit must be one of ${UNITS.join(', ')}`);
    out.unit = o.unit as TileUnit;
  }
  return out;
}

export function sanitizeTile(raw: unknown, i: number): DashboardTile {
  const o = (raw ?? {}) as Record<string, unknown>;
  const where = `Tile ${i + 1}`;
  if (typeof o.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(o.id)) throw new HttpError(400, `${where}: id must be 1-40 letters, digits, - or _`);
  const viz = o.viz as TileViz;
  if (!TILE_VIZ.includes(viz)) throw new HttpError(400, `${where}: viz must be one of ${TILE_VIZ.join(', ')}`);
  const l = (o.layout ?? {}) as Record<string, unknown>;
  const w = int(l.w, 1, COLS, `${where}: width`);
  const layout = { x: int(l.x, 0, COLS - w, `${where}: x`), y: int(l.y, 0, MAX_Y, `${where}: y`), w, h: int(l.h, 1, MAX_ROWS, `${where}: height`) };
  const tile: DashboardTile = { id: o.id, viz, measures: [], layout };
  if (o.title !== undefined && o.title !== '') {
    if (typeof o.title !== 'string' || o.title.length > 120) throw new HttpError(400, `${where}: title must be at most 120 characters`);
    tile.title = o.title;
  }
  const range = optRange(o.range, `${where}: range`);
  if (range) tile.range = range;
  if (viz === 'text') {
    if (typeof o.text !== 'string' || o.text.length > 2000) throw new HttpError(400, `${where}: text must be at most 2000 characters`);
    tile.text = o.text;
    return tile;
  }
  if (o.sql !== undefined && o.sql !== null) {
    if (!SQL_VIZ.includes(viz)) throw new HttpError(400, `${where}: a SQL tile shows as ${SQL_VIZ.join(', ')}`);
    tile.sql = sanitizeSqlTile(o.sql, where);
    return tile;
  }
  if (SQL_ONLY_VIZ.includes(viz)) throw new HttpError(400, `${where}: ${viz} charts are for SQL tiles`);
  if (!Array.isArray(o.measures)) throw new HttpError(400, `${where}: measures must be a list`);
  tile.measures = o.measures.map((m, k) => sanitizeMeasure(m, `${where}, measure ${k + 1}`));
  if (typeof o.groupBy === 'string' && o.groupBy) tile.groupBy = o.groupBy;
  if (o.limit !== undefined && o.limit !== null) tile.limit = o.limit as number;
  try {
    const spec = validateSpec({ shape: tileShape(tile), measures: tile.measures, groupBy: tile.groupBy, limit: tile.limit });
    if (spec.limit !== undefined) tile.limit = Math.min(spec.limit, 50);
  } catch (e) {
    if (e instanceof HttpError) throw new HttpError(400, `${where}: ${e.message}`);
    throw e;
  }
  return tile;
}

export function sanitizeConfig(raw: unknown): DashboardConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (JSON.stringify(o).length > MAX_CONFIG_BYTES) throw new HttpError(400, 'Dashboard is too large');
  const tiles = o.tiles ?? [];
  if (!Array.isArray(tiles)) throw new HttpError(400, 'tiles must be a list');
  if (tiles.length > MAX_TILES) throw new HttpError(400, `A dashboard can have at most ${MAX_TILES} tiles`);
  const out: DashboardConfig = { tiles: tiles.map(sanitizeTile) };
  const ids = new Set(out.tiles.map((t) => t.id));
  if (ids.size !== out.tiles.length) throw new HttpError(400, 'Tile ids must be unique');
  if (o.filters !== undefined) {
    if (!Array.isArray(o.filters)) throw new HttpError(400, 'filters must be a list');
    const filters = parseFilters(JSON.stringify(o.filters));
    filterSql(filters, 'events', []);
    if (filters.length) out.filters = filters;
  }
  const range = optRange(o.range, 'range');
  if (range) out.range = range;
  return out;
}

export async function listDashboards(pid: string): Promise<DashboardSummary[]> {
  const rows = await query<Row>('SELECT * FROM dashboards WHERE project_id = $1 ORDER BY updated_at DESC LIMIT $2', [pid, MAX_DASHBOARDS]);
  return rows.map((r) => ({ id: r.id, name: r.name, tiles: r.config?.tiles?.length ?? 0, createdBy: r.created_by, updatedAt: r.updated_at.toISOString() }));
}

async function getRow(pid: string, id: string): Promise<Row> {
  const [row] = isUuid(id) ? await query<Row>('SELECT * FROM dashboards WHERE project_id = $1 AND id = $2', [pid, id]) : [];
  if (!row) throw new HttpError(404, 'Dashboard not found');
  return row;
}

export const getDashboard = async (pid: string, id: string): Promise<Dashboard> => toDashboard(await getRow(pid, id));

export async function createDashboard(pid: string, email: string, body: Partial<DashboardInput>): Promise<Dashboard> {
  const name = dashboardName(body.name);
  const config = sanitizeConfig(body.config ?? { tiles: [] });
  const [{ n }] = await query<{ n: number }>('SELECT count(*)::int AS n FROM dashboards WHERE project_id = $1', [pid]);
  if (n >= MAX_DASHBOARDS) throw new HttpError(400, `A project can have at most ${MAX_DASHBOARDS} dashboards`);
  const id = randomUUID();
  await query('INSERT INTO dashboards (project_id, id, name, config, created_by) VALUES ($1, $2, $3, $4::jsonb, $5)',
    [pid, id, name, JSON.stringify(config), email]);
  return getDashboard(pid, id);
}

export async function updateDashboard(pid: string, id: string, body: Partial<DashboardInput>): Promise<Dashboard> {
  const cur = await getRow(pid, id);
  const name = body.name !== undefined ? dashboardName(body.name) : cur.name;
  const config = body.config !== undefined ? sanitizeConfig(body.config) : cur.config;
  await query('UPDATE dashboards SET name = $3, config = $4::jsonb, updated_at = now() WHERE project_id = $1 AND id = $2',
    [pid, id, name, JSON.stringify(config)]);
  return getDashboard(pid, id);
}

export async function duplicateDashboard(pid: string, id: string, email: string): Promise<Dashboard> {
  const cur = await getRow(pid, id);
  return createDashboard(pid, email, { name: `${cur.name.slice(0, 113)} (copy)`, config: cur.config });
}

export async function deleteDashboard(pid: string, id: string): Promise<void> {
  await getRow(pid, id);
  await query('DELETE FROM dashboards WHERE project_id = $1 AND id = $2', [pid, id]);
}

/** Add one tile below the others (the "Add to dashboard" buttons and the MCP tool). */
export async function addTile(pid: string, id: string, raw: Partial<DashboardTile>): Promise<Dashboard> {
  const cur = await getRow(pid, id);
  const bottom = cur.config.tiles.reduce((m, t) => Math.max(m, t.layout.y + t.layout.h), 0);
  const w = Number.isInteger(raw.layout?.w) ? raw.layout!.w : 6;
  const tile = { ...raw, id: raw.id ?? randomUUID().slice(0, 8), layout: { x: 0, y: bottom, w, h: raw.layout?.h ?? (raw.viz === 'number' ? 2 : 4) } };
  return updateDashboard(pid, id, { config: { ...cur.config, tiles: [...cur.config.tiles, tile as DashboardTile] } });
}

/**
 * The result of a SQL tile's saved query over [from, to). Kiosks get their SQL tiles' data this way: they can run
 * the queries members saved on the dashboard, never SQL of their own.
 */
export async function tileData(pid: string, id: string, tileId: string, q: Record<string, string | undefined>): Promise<SqlResult> {
  const tile = (await getRow(pid, id)).config.tiles.find((t) => t.id === tileId);
  if (!tile?.sql) throw new HttpError(404, 'No SQL tile with that id on this dashboard');
  return SQL.run(pid, { sql: tile.sql.query, from: q.from, to: q.to, limit: SQL_TILE_ROWS });
}
