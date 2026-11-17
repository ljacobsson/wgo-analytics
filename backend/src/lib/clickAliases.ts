import type { ClickAlias, ClickAliasInput } from '../contract';
import { query } from './db';
import { HttpError } from './http';

/**
 * Click aliases: a readable name for an autocaptured click target, keyed by its CSS selector and shared by a
 * project's members. Shown instead of the element's text or selector wherever clicks are listed.
 */

export const MAX_ALIASES = 1000;
const MAX_SELECTOR = 512; // what ingest keeps of a selector (lib/events.ts)
const MAX_ALIAS = 80;

interface AliasRow { project_id: string; selector: string; alias: string; updated_by: string; updated_at: Date }

const toAlias = (r: AliasRow): ClickAlias => ({ selector: r.selector, alias: r.alias, updatedBy: r.updated_by, updatedAt: r.updated_at.toISOString() });

export function aliasSelector(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > MAX_SELECTOR) throw new HttpError(400, `selector must be 1-${MAX_SELECTOR} characters`);
  return s;
}

function aliasName(v: unknown): string {
  const n = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!n || n.length > MAX_ALIAS) throw new HttpError(400, `Alias must be 1-${MAX_ALIAS} characters`);
  return n;
}

export async function listAliases(pid: string): Promise<ClickAlias[]> {
  const rows = await query<AliasRow>('SELECT * FROM click_aliases WHERE project_id = $1 ORDER BY selector LIMIT $2', [pid, MAX_ALIASES]);
  return rows.map(toAlias);
}

/** selector → alias, for labelling click rows. */
export async function aliasMap(pid: string): Promise<Map<string, string>> {
  const rows = await query<{ selector: string; alias: string }>('SELECT selector, alias FROM click_aliases WHERE project_id = $1 LIMIT $2', [pid, MAX_ALIASES]);
  return new Map(rows.map((r) => [r.selector, r.alias]));
}

/** Creates or renames the alias of one selector. */
export async function setAlias(pid: string, email: string, body: Partial<ClickAliasInput>): Promise<ClickAlias> {
  const selector = aliasSelector(body.selector);
  const alias = aliasName(body.alias);
  const [existing] = await query<{ n: number }>('SELECT 1 AS n FROM click_aliases WHERE project_id = $1 AND selector = $2', [pid, selector]);
  if (!existing) {
    const [{ n }] = await query<{ n: number }>('SELECT count(*)::int AS n FROM click_aliases WHERE project_id = $1', [pid]);
    if (n >= MAX_ALIASES) throw new HttpError(400, `A project can have at most ${MAX_ALIASES} click aliases`);
  }
  const [row] = await query<AliasRow>(
    `INSERT INTO click_aliases (project_id, selector, alias, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (project_id, selector) DO UPDATE SET alias = EXCLUDED.alias, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [pid, selector, alias, email],
  );
  return toAlias(row);
}

/** Removes a selector's alias; removing one that doesn't exist is not an error. */
export async function deleteAlias(pid: string, selector: unknown): Promise<void> {
  await query('DELETE FROM click_aliases WHERE project_id = $1 AND selector = $2', [pid, aliasSelector(selector)]);
}
