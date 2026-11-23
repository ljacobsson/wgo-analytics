import { randomBytes, randomUUID } from 'node:crypto';
import type { Kiosk, KioskConfig, KioskPage, KioskScreen, KioskState } from '../contract';
import { query } from './db';
import { HttpError } from './http';
import { sanitizeWatches } from './match';
import { isUuid } from './projects';

/**
 * Kiosks: wall displays that show a project's dashboard without signing in. The kiosk URL carries a long random
 * token, which is the only credential: it grants read access to that one project's analytics (the same read-only
 * routes members use), and nothing else. Members pick what the screen shows; the screen polls for changes.
 */
export const KIOSK_PAGES: readonly KioskPage[] = ['overview', 'live', 'clicks', 'errors', 'network', 'events', 'traces', 'logs', 'metrics', 'dashboard'];
const MAX_KIOSKS = 20;
const MAX_SCREENS = 12;
const MAX_PARAMS = 4000;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TOKEN_RE = /^ks_[A-Za-z0-9]{40}$/;

export const DEFAULT_KIOSK_CONFIG: KioskConfig = {
  screens: [{ page: 'overview', params: 'range=24h' }],
  rotateSeconds: 60,
  refreshSeconds: 60,
  theme: 'dark',
  zoom: 1,
};

export function generateKioskToken(): string {
  // 40 chars over a 62-symbol alphabet ≈ 238 bits; the modulo bias is irrelevant at this length
  let out = 'ks_';
  for (const b of randomBytes(40)) out += ALPHABET[b % ALPHABET.length];
  return out;
}

// ---------------------------------------------------------------- validation

function int(v: unknown, name: string, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return Math.round(n);
}

function screen(input: unknown, i: number): KioskScreen {
  if (!input || typeof input !== 'object') throw new HttpError(400, `Screen ${i + 1} is not an object`);
  const o = input as Record<string, unknown>;
  const page = o.page as KioskPage;
  if (!KIOSK_PAGES.includes(page)) throw new HttpError(400, `Screen ${i + 1}: page must be one of ${KIOSK_PAGES.join(', ')}`);
  const params = typeof o.params === 'string' ? o.params.replace(/^\?/, '') : '';
  if (params.length > MAX_PARAMS) throw new HttpError(400, `Screen ${i + 1}: params is longer than ${MAX_PARAMS} characters`);
  const out: KioskScreen = { page, params };
  const title = typeof o.title === 'string' ? o.title.trim().slice(0, 80) : '';
  if (title) out.title = title;
  if (page === 'live') {
    const watches = sanitizeWatches(o.watches);
    if (watches.length) out.watches = watches;
  }
  if (page === 'dashboard' && !isUuid(new URLSearchParams(params).get('id') ?? '')) {
    throw new HttpError(400, `Screen ${i + 1}: pick a dashboard (params id=<dashboard id>)`);
  }
  return out;
}

/** Validate a full config, or a partial one laid over `base` (PATCH). Throws 400 with a readable message. */
export function sanitizeKioskConfig(input: unknown, base: KioskConfig = DEFAULT_KIOSK_CONFIG): KioskConfig {
  if (input == null) return base;
  if (typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'config must be an object');
  const c = { ...base, ...(input as Partial<KioskConfig>) };
  if (!Array.isArray(c.screens) || c.screens.length < 1 || c.screens.length > MAX_SCREENS) {
    throw new HttpError(400, `A kiosk shows 1 to ${MAX_SCREENS} screens`);
  }
  if (c.theme !== 'dark' && c.theme !== 'light') throw new HttpError(400, 'theme must be dark or light');
  const zoom = typeof c.zoom === 'number' ? c.zoom : Number.NaN;
  if (!Number.isFinite(zoom) || zoom < 0.5 || zoom > 3) throw new HttpError(400, 'zoom must be between 0.5 and 3');
  return {
    screens: c.screens.map(screen),
    rotateSeconds: int(c.rotateSeconds, 'rotateSeconds', 10, 3600),
    refreshSeconds: int(c.refreshSeconds, 'refreshSeconds', 15, 3600),
    theme: c.theme,
    zoom: Math.round(zoom * 100) / 100,
  };
}

function kioskName(v: unknown, fallback?: string): string {
  if (v === undefined && fallback !== undefined) return fallback;
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name || name.length > 60) throw new HttpError(400, 'Kiosk name must be 1-60 characters');
  return name;
}

// ---------------------------------------------------------------- management (project members)

interface Row {
  project_id: string;
  id: string;
  name: string;
  token: string;
  config: KioskConfig;
  reload_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  last_seen_at: Date | null;
  display: string | null;
}
const COLS = 'project_id, id, name, token, config, reload_at, created_by, created_at, updated_at, last_seen_at, display';
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const toKiosk = (r: Row): Kiosk => ({
  id: r.id,
  name: r.name,
  token: r.token,
  config: r.config,
  reloadAt: iso(r.reload_at),
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  lastSeenAt: iso(r.last_seen_at),
  display: r.display,
});

export async function listKiosks(pid: string): Promise<Kiosk[]> {
  const rows = await query<Row>(`SELECT ${COLS} FROM kiosks WHERE project_id = $1 ORDER BY created_at`, [pid]);
  return rows.map(toKiosk);
}

async function getKiosk(pid: string, id: string): Promise<Row> {
  if (!isUuid(id)) throw new HttpError(404, 'Kiosk not found');
  const [row] = await query<Row>(`SELECT ${COLS} FROM kiosks WHERE project_id = $1 AND id = $2`, [pid, id]);
  if (!row) throw new HttpError(404, 'Kiosk not found');
  return row;
}

export async function createKiosk(pid: string, email: string, body: { name?: unknown; config?: unknown }): Promise<Kiosk> {
  const name = kioskName(body.name);
  const config = sanitizeKioskConfig(body.config);
  const [{ n }] = await query<{ n: number }>('SELECT count(*)::int AS n FROM kiosks WHERE project_id = $1', [pid]);
  if (n >= MAX_KIOSKS) throw new HttpError(400, `A project can have at most ${MAX_KIOSKS} kiosks. Delete an old one first.`);
  const [row] = await query<Row>(
    `INSERT INTO kiosks (project_id, id, name, token, config, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
    [pid, randomUUID(), name, generateKioskToken(), JSON.stringify(config), email],
  );
  return toKiosk(row);
}

export async function updateKiosk(pid: string, id: string, body: { name?: unknown; config?: unknown; reload?: unknown }): Promise<Kiosk> {
  const cur = await getKiosk(pid, id);
  const name = kioskName(body.name, cur.name);
  const config = sanitizeKioskConfig(body.config, cur.config);
  const [row] = await query<Row>(
    `UPDATE kiosks SET name = $3, config = $4, updated_at = now(), reload_at = CASE WHEN $5 THEN now() ELSE reload_at END
      WHERE project_id = $1 AND id = $2 RETURNING ${COLS}`,
    [pid, id, name, JSON.stringify(config), body.reload === true],
  );
  return toKiosk(row);
}

export async function rotateKioskToken(pid: string, id: string): Promise<Kiosk> {
  const cur = await getKiosk(pid, id);
  const [row] = await query<Row>(`UPDATE kiosks SET token = $3, updated_at = now() WHERE project_id = $1 AND id = $2 RETURNING ${COLS}`, [
    pid,
    id,
    generateKioskToken(),
  ]);
  forget(cur.token);
  return toKiosk(row);
}

export async function deleteKiosk(pid: string, id: string): Promise<void> {
  const cur = await getKiosk(pid, id);
  await query('DELETE FROM kiosks WHERE project_id = $1 AND id = $2', [pid, id]);
  forget(cur.token);
}

// ---------------------------------------------------------------- the screen (kiosk token)

export interface KioskAuth {
  id: string;
  projectId: string;
}

// token -> kiosk, cached briefly per container. A deleted kiosk or rotated URL stops working within
// TOKEN_CACHE_MS on other warm containers (immediately on the one that handled the change).
const TOKEN_CACHE_MS = 30_000;
const tokenCache = new Map<string, KioskAuth & { exp: number }>();
const forget = (token: string) => tokenCache.delete(token);

export async function authenticateKiosk(token: string | undefined): Promise<KioskAuth> {
  if (!token || !TOKEN_RE.test(token)) throw new HttpError(401, 'Missing or malformed kiosk token');
  const hit = tokenCache.get(token);
  if (hit && hit.exp > Date.now()) return hit;
  const [row] = await query<{ id: string; project_id: string }>('SELECT id, project_id FROM kiosks WHERE token = $1', [token]);
  if (!row) throw new HttpError(401, 'This kiosk link was removed or replaced. Get the current one from the dashboard.');
  const entry = { id: row.id, projectId: row.project_id, exp: Date.now() + TOKEN_CACHE_MS };
  tokenCache.set(token, entry);
  if (tokenCache.size > 1000) tokenCache.delete(tokenCache.keys().next().value!);
  return entry;
}

// last_seen_at / display are bookkeeping for the dashboard: write them at most once a minute per kiosk
const TOUCH_EVERY_MS = 60_000;

/** What the screen should show. Polled by the kiosk page; also records that it's alive and its screen size. */
export async function kioskState(auth: KioskAuth, q: Record<string, string | undefined>): Promise<KioskState> {
  const [row] = await query<Row & { project_name: string }>(
    `SELECT k.id, k.name, k.config, k.reload_at, k.updated_at, k.last_seen_at, k.display, p.name AS project_name
       FROM kiosks k JOIN projects p ON p.id = k.project_id WHERE k.project_id = $1 AND k.id = $2`,
    [auth.projectId, auth.id],
  );
  if (!row) throw new HttpError(401, 'This kiosk was removed. Get a new link from the dashboard.');
  const w = Number(q.w), h = Number(q.h);
  const display = Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w < 100_000 && h < 100_000 ? `${w}×${h}` : row.display;
  if (!row.last_seen_at || Date.now() - row.last_seen_at.getTime() > TOUCH_EVERY_MS || display !== row.display) {
    await query('UPDATE kiosks SET last_seen_at = now(), display = $3 WHERE project_id = $1 AND id = $2', [auth.projectId, auth.id, display]).catch((e) =>
      console.warn('kiosk touch failed', e),
    );
  }
  return {
    kiosk: { id: row.id, name: row.name },
    project: { id: auth.projectId, name: row.project_name },
    config: row.config,
    reloadAt: iso(row.reload_at),
    version: `${row.updated_at.getTime()}.${row.reload_at?.getTime() ?? 0}`,
  };
}
