import { query } from './db';
import { HttpError } from './http';

/**
 * Admins see what the whole install costs and manage cost budgets (which can stop every project collecting data).
 * They are the emails in ADMIN_EMAILS (comma-separated, set at deploy time). When it's empty, the owners of the
 * oldest project are: that is whoever deployed and set WGO up, so an upgraded install keeps its Costs page without
 * every account that signs up and creates a project getting it.
 */
export function adminEmails(env = process.env.ADMIN_EMAILS): string[] {
  return (env ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export async function isAdmin(email: string): Promise<boolean> {
  const listed = adminEmails();
  const me = email.trim().toLowerCase();
  if (listed.length) return listed.includes(me);
  const rows = await query<{ email: string }>(
    `SELECT m.email FROM project_members m
      WHERE m.role = 'owner' AND m.project_id = (SELECT id FROM projects ORDER BY created_at, id LIMIT 1)`,
  );
  return rows.some((r) => r.email.toLowerCase() === me);
}

export async function requireAdmin(email: string): Promise<void> {
  if (!(await isAdmin(email))) throw new HttpError(403, 'Only admins can see what the install costs and manage budgets');
}
