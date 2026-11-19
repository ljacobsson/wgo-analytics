import { randomUUID } from 'node:crypto';
import type { ErrorGroup, ErrorKind, ErrorSuppression, ErrorSuppressionInput } from '../contract';
import { query } from './db';
import type { EventRow } from './events';
import { HttpError } from './http';
import { setJobState } from './jobState';

/**
 * Error suppression: JavaScript errors matching a project's rules are dropped at ingest, before they're stored,
 * counted, sent live or matched by triggers. A rule has wildcard patterns (`*` = anything, case-insensitive, whole
 * value) on the error's kind, message, failing URL (`source`: a failed resource or the script that threw) and page
 * path. Every pattern a rule sets must match.
 */

export const MAX_RULES = 100;
const MAX_PATTERN = 500;
const KINDS: ErrorKind[] = ['error', 'rejection', 'resource', 'manual'];

/** A wildcard pattern as a RegExp: `*` matches anything, everything else literally, case-insensitive, whole value. */
export function wildcard(pattern: string): RegExp {
  const body = pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 'is');
}

export interface CompiledRule { id: string; kind: ErrorKind | null; message: RegExp | null; source: RegExp | null; page: RegExp | null }

export function compile(r: { id: string; kind: string | null; message: string | null; source: string | null; page: string | null }): CompiledRule {
  return {
    id: r.id, kind: (r.kind as ErrorKind) || null,
    message: r.message ? wildcard(r.message) : null, source: r.source ? wildcard(r.source) : null, page: r.page ? wildcard(r.page) : null,
  };
}

/** A URL matches a source pattern as a whole, or by its path (so "/img/*" matches any host). */
function sourceMatches(re: RegExp, url: string): boolean {
  if (re.test(url)) return true;
  try {
    const u = new URL(url);
    return re.test(u.pathname) || re.test(u.host + u.pathname);
  } catch {
    return false;
  }
}

export interface ErrorFacts { kind: string | null; message: string | null; source: string | null; page: string | null }

/** The first rule a JavaScript error matches, or null. */
export function matchRule(rules: CompiledRule[], e: ErrorFacts): CompiledRule | null {
  for (const r of rules) {
    if (r.kind && r.kind !== e.kind) continue;
    if (r.message && !(e.message && r.message.test(e.message))) continue;
    if (r.source && !(e.source && sourceMatches(r.source, e.source))) continue;
    if (r.page && !(e.page && r.page.test(e.page))) continue;
    return r;
  }
  return null;
}

// ---------------------------------------------------------------- storage

interface Row { id: string; kind: string | null; message: string | null; source: string | null; page: string | null; created_by: string; created_at: Date; hits: string | number; last_hit_at: Date | null }

const toApi = (r: Row): ErrorSuppression => ({
  id: r.id, kind: (r.kind as ErrorKind) || null, message: r.message, source: r.source, page: r.page,
  createdBy: r.created_by, createdAt: r.created_at.toISOString(), hits: Number(r.hits), lastHitAt: r.last_hit_at?.toISOString() ?? null,
});

type RuleRow = Pick<Row, 'id' | 'kind' | 'message' | 'source' | 'page'>;
const cache = new Map<string, { rules: CompiledRule[]; rows: RuleRow[]; exp: number }>();
const CACHE_MS = 30_000;

async function load(pid: string) {
  const hit = cache.get(pid);
  if (hit && hit.exp > Date.now()) return hit;
  const rows = await query<RuleRow>('SELECT id, kind, message, source, page FROM error_suppressions WHERE project_id = $1', [pid]);
  const entry = { rules: rows.map(compile), rows, exp: Date.now() + CACHE_MS };
  cache.set(pid, entry);
  if (cache.size > 1000) cache.delete(cache.keys().next().value!);
  return entry;
}

/** A project's rules, compiled, cached briefly per container: ingest runs on every SDK batch. */
export const rulesFor = async (pid: string): Promise<CompiledRule[]> => (await load(pid)).rules;

/** A wildcard pattern as an ILIKE pattern (used with ESCAPE '\'). */
export const likePattern = (pattern: string) => pattern.replace(/[\\%_]/g, (c) => '\\' + c).replace(/\*/g, '%');

const SCHEME = `'^[A-Za-z][A-Za-z0-9+.-]*://'`;

/**
 * ` AND NOT (…)` leaving out the stored errors a project's rules cover (DuckDB SQL over events, values bound into
 * `params`), or '' without rules. New errors are never stored; this hides the ones from before a rule existed.
 */
export async function suppressedSql(pid: string, params: unknown[]): Promise<string> {
  const { rows } = await load(pid);
  if (!rows.length) return '';
  const b = (v: unknown) => `$${params.push(v)}`;
  const ilike = (col: string, pattern: string) => `${col} ILIKE ${b(likePattern(pattern))} ESCAPE '\\'`;
  const any = rows.map((r) => {
    const c: string[] = [];
    if (r.kind) c.push(`json_extract_string(props, '$.kind') = ${b(r.kind)}`);
    if (r.message) c.push(ilike('error_message', r.message));
    if (r.source) {
      // the whole URL, its host and path, or just its path (as in matchRule)
      const path = `regexp_replace(regexp_replace(error_source, ${SCHEME} || '[^/]*', ''), '[?#].*$', '')`;
      c.push(`(${ilike('error_source', r.source)} OR ${ilike(`regexp_replace(error_source, ${SCHEME}, '')`, r.source)} OR ${ilike(path, r.source)})`);
    }
    if (r.page) c.push(ilike('path', r.page));
    return `(${c.join(' AND ')})`;
  });
  return ` AND NOT (type = 'error' AND COALESCE(${any.join(' OR ')}, false))`;
}

export async function listSuppressions(pid: string): Promise<ErrorSuppression[]> {
  const rows = await query<Row>('SELECT * FROM error_suppressions WHERE project_id = $1 ORDER BY created_at', [pid]);
  return rows.map(toApi);
}

const pattern = (v: unknown, label: string): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, `${label} must be text`);
  const s = v.trim();
  if (s.length > MAX_PATTERN) throw new HttpError(400, `${label} is too long`);
  return s && s !== '*' ? s : null;
};

export async function createSuppression(pid: string, email: string, body: Partial<ErrorSuppressionInput>): Promise<ErrorSuppression> {
  const kind = body.kind ?? null;
  if (kind !== null && !KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}`);
  const message = pattern(body.message, 'message'), source = pattern(body.source, 'source'), page = pattern(body.page, 'page');
  if (!kind && !message && !source && !page) throw new HttpError(400, 'A rule needs a kind or at least one pattern; it would suppress every error');
  const [{ n }] = await query<{ n: number }>('SELECT count(*)::int AS n FROM error_suppressions WHERE project_id = $1', [pid]);
  if (n >= MAX_RULES) throw new HttpError(400, `A project can have at most ${MAX_RULES} suppression rules`);
  const id = randomUUID();
  await query('INSERT INTO error_suppressions (project_id, id, kind, message, source, page, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [pid, id, kind, message, source, page, email]);
  cache.delete(pid);
  await markReroll(pid);
  const [row] = await query<Row>('SELECT * FROM error_suppressions WHERE project_id = $1 AND id = $2', [pid, id]);
  return toApi(row);
}

export async function deleteSuppression(pid: string, id: string): Promise<void> {
  const rows = await query('DELETE FROM error_suppressions WHERE project_id = $1 AND id = $2 RETURNING id', [pid, id]);
  if (!rows.length) throw new HttpError(404, 'Suppression rule not found');
  cache.delete(pid);
  await markReroll(pid);
}

/** Hourly rollups count errors too: have the maintenance job recount this project's hours (rollups.ts runRerolls). */
const markReroll = (pid: string) => setJobState(`reroll:${pid}`, new Date(0));

// ---------------------------------------------------------------- ingest and reads

const pathOf = (r: EventRow) => r.path ?? null;

/**
 * Drops the error rows a project's rules match and counts the hits per rule (best effort: a failed count never
 * fails ingest). Rows of other types pass through untouched.
 */
export async function dropSuppressed(pid: string, rows: EventRow[]): Promise<EventRow[]> {
  if (!rows.some((r) => r.type === 'error')) return rows;
  const rules = await rulesFor(pid);
  if (!rules.length) return rows;
  const hits = new Map<string, number>();
  const kept = rows.filter((r) => {
    if (r.type !== 'error') return true;
    const kind = typeof r.props?.kind === 'string' ? r.props.kind : null;
    const rule = matchRule(rules, { kind, message: r.error_message, source: r.error_source, page: pathOf(r) });
    if (!rule) return true;
    const n = typeof r.props?.count === 'number' ? r.props.count : 1; // the SDK folds repeats into one event
    hits.set(rule.id, (hits.get(rule.id) ?? 0) + n);
    return false;
  });
  await Promise.all([...hits].map(([id, n]) =>
    query('UPDATE error_suppressions SET hits = hits + $3, last_hit_at = now() WHERE project_id = $1 AND id = $2', [pid, id, n])
      .catch((err) => console.warn('counting suppressed errors failed', err))));
  return kept;
}

/**
 * Marks the error groups a rule covers. A group stands for many events, so only its kind, message and source are
 * compared; rules with a page pattern only apply to new errors.
 */
export async function markSuppressed(pid: string, groups: ErrorGroup[]): Promise<ErrorGroup[]> {
  const rules = (await rulesFor(pid)).filter((r) => !r.page);
  for (const g of groups) g.suppressedBy = rules.length ? matchRule(rules, { kind: g.kind, message: g.message, source: g.source, page: null })?.id ?? null : null;
  return groups;
}
