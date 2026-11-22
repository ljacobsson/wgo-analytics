import { randomBytes, randomUUID } from 'node:crypto';
import type { Member, Project, Role, UploadKey } from '../contract';
import { allowlistMessage, emailAllowed } from './allowlist';
import { HttpError } from './http';
import { query } from './db';
import { DEFAULT_RETENTION_DAYS, effectiveRetention, forgetRetention, maxRetentionDays } from './retention';

const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function generateWriteKey(): string {
  const bytes = randomBytes(24);
  let out = 'wk_';
  for (const b of bytes) out += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return out;
}

export function generateUploadKey(): string {
  const bytes = randomBytes(32);
  let out = 'uk_';
  for (const b of bytes) out += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return out;
}

/** The source map upload key (a CI secret) of a project, created on first read. Owners only. */
export async function getUploadKey(email: string, projectId: string): Promise<UploadKey> {
  await requireOwner(email, projectId);
  const rows = await query<{ upload_key: string | null }>('SELECT upload_key FROM projects WHERE id = $1', [projectId]);
  if (rows[0]?.upload_key) return { uploadKey: rows[0].upload_key };
  const key = generateUploadKey();
  // only fill it when still empty, so two first reads agree on one key
  await query('UPDATE projects SET upload_key = $2 WHERE id = $1 AND upload_key IS NULL', [projectId, key]);
  const again = await query<{ upload_key: string }>('SELECT upload_key FROM projects WHERE id = $1', [projectId]);
  return { uploadKey: again[0].upload_key };
}

export async function rotateUploadKey(email: string, projectId: string): Promise<UploadKey> {
  await requireOwner(email, projectId);
  const key = generateUploadKey();
  await query('UPDATE projects SET upload_key = $2 WHERE id = $1', [projectId, key]);
  uploadKeyCache.clear();
  return { uploadKey: key };
}

const uploadKeyCache = new Map<string, { projectId: string | null; exp: number }>();

export async function projectIdForUploadKey(key: string | undefined): Promise<string | null> {
  if (!key || !/^uk_[A-Za-z0-9]{20,80}$/.test(key)) return null;
  const hit = uploadKeyCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.projectId;
  const rows = await query<{ id: string }>('SELECT id FROM projects WHERE upload_key = $1 LIMIT 1', [key]);
  const projectId = rows[0]?.id ?? null;
  uploadKeyCache.set(key, { projectId, exp: Date.now() + (projectId ? 30_000 : 5_000) });
  if (uploadKeyCache.size > 500) uploadKeyCache.delete(uploadKeyCache.keys().next().value!);
  return projectId;
}

// ---- write key -> project id, cached per container (keys are looked up on every ingest call) ----
const keyCache = new Map<string, { projectId: string | null; exp: number }>();

export async function projectIdForWriteKey(key: string | undefined): Promise<string | null> {
  if (!key || !/^wk_[A-Za-z0-9]{10,64}$/.test(key)) return null;
  const hit = keyCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.projectId;
  const rows = await query<{ id: string }>('SELECT id FROM projects WHERE write_key = $1 LIMIT 1', [key]);
  const projectId = rows[0]?.id ?? null;
  // cache misses briefly so a freshly created project starts working quickly
  keyCache.set(key, { projectId, exp: Date.now() + (projectId ? 60_000 : 10_000) });
  if (keyCache.size > 1000) keyCache.delete(keyCache.keys().next().value!);
  return projectId;
}

// ---- membership ----
interface ProjectRow {
  id: string;
  name: string;
  write_key: string;
  role: Role;
  created_at: Date;
  retention_days: number | null;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  writeKey: r.write_key,
  role: r.role,
  createdAt: r.created_at.toISOString(),
  retention: { days: effectiveRetention(r.retention_days), defaultDays: DEFAULT_RETENTION_DAYS, maxDays: maxRetentionDays() },
});

export async function listProjects(email: string): Promise<Project[]> {
  const rows = await query<ProjectRow>(
    `SELECT p.id, p.name, p.write_key, m.role, p.created_at, p.retention_days
       FROM project_members m JOIN projects p ON p.id = m.project_id
      WHERE m.email = $1 ORDER BY p.created_at`,
    [email],
  );
  return rows.map(toProject);
}

export async function getProject(email: string, projectId: string): Promise<Project> {
  if (!isUuid(projectId)) throw new HttpError(404, 'Project not found');
  const rows = await query<ProjectRow>(
    `SELECT p.id, p.name, p.write_key, m.role, p.created_at, p.retention_days
       FROM project_members m JOIN projects p ON p.id = m.project_id
      WHERE m.email = $1 AND m.project_id = $2`,
    [email, projectId],
  );
  if (!rows[0]) throw new HttpError(404, 'Project not found');
  return toProject(rows[0]);
}

export async function requireOwner(email: string, projectId: string): Promise<Project> {
  const p = await getProject(email, projectId);
  if (p.role !== 'owner') throw new HttpError(403, 'Only project owners can do that');
  return p;
}

export async function createProject(email: string, name: string): Promise<Project> {
  const id = randomUUID();
  const writeKey = generateWriteKey();
  // DSQL: separate statements; each runs in its own implicit transaction
  await query('INSERT INTO projects (id, name, write_key) VALUES ($1, $2, $3)', [id, name, writeKey]);
  await query(`INSERT INTO project_members (project_id, email, role) VALUES ($1, $2, 'owner')`, [id, email]);
  return getProject(email, id);
}

export async function renameProject(email: string, projectId: string, name: string): Promise<Project> {
  await requireOwner(email, projectId);
  await query('UPDATE projects SET name = $2 WHERE id = $1', [projectId, name]);
  return getProject(email, projectId);
}

export async function setRetention(email: string, projectId: string, days: unknown): Promise<Project> {
  await requireOwner(email, projectId);
  const max = maxRetentionDays();
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > max) {
    throw new HttpError(400, `Retention must be a whole number of days between 1 and ${max}`);
  }
  await query('UPDATE projects SET retention_days = $2 WHERE id = $1', [projectId, days]);
  forgetRetention(projectId);
  return getProject(email, projectId);
}

export async function rotateKey(email: string, projectId: string): Promise<Project> {
  const p = await requireOwner(email, projectId);
  await query('UPDATE projects SET write_key = $2 WHERE id = $1', [projectId, generateWriteKey()]);
  keyCache.delete(p.writeKey);
  return getProject(email, projectId);
}

/**
 * Settings and links of a project. Cleared as soon as the project is deleted, so its kiosks, triggers and Slack
 * channels stop working right away. All are small (a handful of rows per project).
 */
export const PROJECT_CONFIG_TABLES = [
  'project_members', 'kiosks', 'triggers', 'integrations', 'saved_views', 'goals', 'click_aliases', 'recording_settings',
  'error_suppressions', 'budgets', 'destinations', 'slack_workspaces',
] as const;

/**
 * Delete a project (owners only). The project disappears for everyone and its write key stops working at once;
 * its raw data, rollups and other bulk rows are removed by the maintenance job (lib/purge.ts), which finds it
 * through the deleted_projects row. That row is written first, so a failure halfway still gets cleaned up.
 */
export async function deleteProject(email: string, projectId: string): Promise<void> {
  const p = await requireOwner(email, projectId);
  await query('INSERT INTO deleted_projects (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [projectId]);
  await query('DELETE FROM projects WHERE id = $1', [projectId]);
  for (const table of PROJECT_CONFIG_TABLES) await query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]);
  keyCache.delete(p.writeKey);
  forgetRetention(projectId);
}

export async function listMembers(email: string, projectId: string): Promise<Member[]> {
  await getProject(email, projectId);
  const rows = await query<{ email: string; role: Role; created_at: Date }>(
    'SELECT email, role, created_at FROM project_members WHERE project_id = $1 ORDER BY created_at',
    [projectId],
  );
  return rows.map((r) => ({ email: r.email, role: r.role, createdAt: r.created_at.toISOString() }));
}

export async function addMember(email: string, projectId: string, invitee: string): Promise<Member> {
  await requireOwner(email, projectId);
  const normalized = normalizeEmail(invitee);
  if (!emailAllowed(normalized)) throw new HttpError(400, allowlistMessage());
  const rows = await query<{ email: string; role: Role; created_at: Date }>(
    `INSERT INTO project_members (project_id, email, role) VALUES ($1, $2, 'member')
     ON CONFLICT (project_id, email) DO UPDATE SET email = EXCLUDED.email
     RETURNING email, role, created_at`,
    [projectId, normalized],
  );
  const r = rows[0];
  return { email: r.email, role: r.role, createdAt: r.created_at.toISOString() };
}

export async function removeMember(email: string, projectId: string, target: string): Promise<void> {
  await requireOwner(email, projectId);
  const normalized = normalizeEmail(target);
  const owners = await query<{ email: string }>(
    `SELECT email FROM project_members WHERE project_id = $1 AND role = 'owner'`,
    [projectId],
  );
  if (owners.length === 1 && owners[0].email === normalized) throw new HttpError(400, 'Cannot remove the last owner');
  await query('DELETE FROM project_members WHERE project_id = $1 AND email = $2', [projectId, normalized]);
}

export function normalizeEmail(email: string): string {
  const e = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw new HttpError(400, 'Invalid email');
  return e;
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
