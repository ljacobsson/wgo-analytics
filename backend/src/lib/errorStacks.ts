import { buildInsert, query } from './db';
import type { EventRow } from './events';

/**
 * One sample stack per error group (project + fingerprint) instead of a copy on every error event: stacks are
 * up to 8 KB and nearly identical within a group. A group's stack is refreshed at most hourly per container
 * while it keeps occurring, which also keeps `updated_at` recent enough for retention to know it is in use.
 */
const REFRESH_MS = 3600_000;
const fresh = new Map<string, number>();

/** The SDK's release label of an event (props.$ctx.release), used to find the source maps of its stack. */
function releaseOf(r: EventRow): string | null {
  const v = (r.props as { $ctx?: { release?: unknown } } | null)?.$ctx?.release;
  return typeof v === 'string' && v ? v.slice(0, 100) : null;
}

export async function storeErrorStacks(rows: EventRow[], now = Date.now()): Promise<void> {
  const latest = new Map<string, EventRow>();
  for (const r of rows) {
    if (r.type !== 'error' || !r.fingerprint || !r.error_stack) continue;
    const k = `${r.project_id}:${r.fingerprint}`;
    if ((fresh.get(k) ?? 0) > now) continue;
    latest.set(k, r);
  }
  if (!latest.size) return;
  const values = [...latest.values()].map((r) => [r.project_id, r.fingerprint, r.error_stack, new Date(now), releaseOf(r)]);
  const { sql, params } = buildInsert('error_stacks', ['project_id', 'fingerprint', 'stack', 'updated_at', 'release'], values, {},
    'ON CONFLICT (project_id, fingerprint) DO UPDATE SET stack = EXCLUDED.stack, updated_at = EXCLUDED.updated_at, release = EXCLUDED.release');
  await query(sql, params);
  for (const k of latest.keys()) fresh.set(k, now + REFRESH_MS);
  if (fresh.size > 5000) for (const [k, exp] of fresh) if (exp <= now) fresh.delete(k);
}

/** Sample stacks of the given error groups. */
export async function stacksFor(pid: string, fingerprints: string[]): Promise<Map<string, string>> {
  const fps = [...new Set(fingerprints)];
  if (!fps.length) return new Map();
  const rows = await query<{ fingerprint: string; stack: string }>(
    'SELECT fingerprint, stack FROM error_stacks WHERE project_id = $1 AND fingerprint = ANY($2::text[])',
    [pid, fps],
  );
  return new Map(rows.map((r) => [r.fingerprint, r.stack]));
}

/** Release each given error group's sample stack came from (groups without one are left out). */
export async function stackReleases(pid: string, fingerprints: string[]): Promise<Map<string, string>> {
  const fps = [...new Set(fingerprints)];
  if (!fps.length) return new Map();
  const rows = await query<{ fingerprint: string; release: string | null }>(
    'SELECT fingerprint, release FROM error_stacks WHERE project_id = $1 AND fingerprint = ANY($2::text[]) AND release IS NOT NULL',
    [pid, fps],
  );
  return new Map(rows.map((r) => [r.fingerprint, r.release!]));
}
