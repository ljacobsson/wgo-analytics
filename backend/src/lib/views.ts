import { randomUUID } from 'node:crypto';
import type { SavedView, SavedViewInput } from '../contract';
import { query } from './db';
import { HttpError } from './http';

/** Saved views: a named dashboard page with its filters and options, shared by a project's members. */

const MAX_VIEWS = 200;
// time range params are left out on purpose: a saved view follows the range you're looking at
const DROP_PARAMS = ['range', 'from', 'to', 'new', 'pf', 'scope', 'slack', 'slack_level'];

interface ViewRow { project_id: string; id: string; name: string; page: string; params: string; created_by: string; created_at: Date }

const toView = (r: ViewRow): SavedView => ({ id: r.id, name: r.name, page: r.page, params: r.params, createdBy: r.created_by, createdAt: r.created_at.toISOString() });

const viewName = (v: unknown) => {
  const n = typeof v === 'string' ? v.trim() : '';
  if (!n || n.length > 120) throw new HttpError(400, 'View name must be 1-120 characters');
  return n;
};
const viewPage = (v: unknown) => {
  if (typeof v !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(v)) throw new HttpError(400, 'page must be a dashboard page id, e.g. "logs"');
  return v;
};
/** Normalise to a query string without a leading "?", dropping the time range and one-shot params. */
export function viewParams(v: unknown): string {
  if (typeof v !== 'string' || v.length > 4000) throw new HttpError(400, 'params must be a query string of at most 4000 characters');
  const p = new URLSearchParams(v.replace(/^\?/, ''));
  for (const k of DROP_PARAMS) p.delete(k);
  return p.toString();
}

export async function listViews(pid: string): Promise<SavedView[]> {
  const rows = await query<ViewRow>('SELECT * FROM saved_views WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2', [pid, MAX_VIEWS]);
  return rows.map(toView);
}

async function getView(pid: string, id: string): Promise<ViewRow> {
  const [row] = await query<ViewRow>('SELECT * FROM saved_views WHERE project_id = $1 AND id = $2', [pid, id]);
  if (!row) throw new HttpError(404, 'View not found');
  return row;
}

export async function createView(pid: string, email: string, body: Partial<SavedViewInput>): Promise<SavedView> {
  const [{ n }] = await query<{ n: number }>('SELECT count(*)::int AS n FROM saved_views WHERE project_id = $1', [pid]);
  if (n >= MAX_VIEWS) throw new HttpError(400, `A project can have at most ${MAX_VIEWS} saved views`);
  const id = randomUUID();
  await query(
    'INSERT INTO saved_views (project_id, id, name, page, params, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
    [pid, id, viewName(body.name), viewPage(body.page), viewParams(body.params ?? ''), email],
  );
  return toView(await getView(pid, id));
}

export async function updateView(pid: string, id: string, body: Partial<SavedViewInput>): Promise<SavedView> {
  const cur = await getView(pid, id);
  await query('UPDATE saved_views SET name = $3, page = $4, params = $5 WHERE project_id = $1 AND id = $2', [
    pid, id,
    body.name !== undefined ? viewName(body.name) : cur.name,
    body.page !== undefined ? viewPage(body.page) : cur.page,
    body.params !== undefined ? viewParams(body.params) : cur.params,
  ]);
  return toView(await getView(pid, id));
}

export async function deleteView(pid: string, id: string): Promise<void> {
  await getView(pid, id);
  await query('DELETE FROM saved_views WHERE project_id = $1 AND id = $2', [pid, id]);
}
