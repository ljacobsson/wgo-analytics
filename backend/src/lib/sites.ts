import type { ProjectSite } from '../contract';
import { execute, query } from './db';
import { HttpError } from './http';
import { rawQuery } from './store/duck';
import { location } from './store/files';
import { dayOf } from './store/tables';
import { isPublicHost } from './triggers';

/**
 * The public website behind a project, with a daily screenshot of its homepage for the dashboard's project cards.
 *
 * The maintenance job (detectSites) works out each project's site once a day: the public origin with the most
 * pageviews in the last 3 days. ScreenshotFunction (handlers/screenshot.ts) then takes at most one screenshot a day
 * per project (runScreenshots), stored as `sites/project_id=…/YYYY-MM-DD.jpg`; the previous day's image is deleted
 * once the new one is written, and kept when today's attempt fails. The dashboard caches the image per day. The
 * site's icon (favicon) is fetched in the same visit and kept in the row as a small data URL (64 KB at most).
 */
const DETECT_EVERY_MS = 86400e3;
const DETECT_WINDOW_MS = 3 * 86400e3;

export const siteImageKey = (pid: string, day: string) => `sites/project_id=${pid}/${day}.jpg`;

/** The origin (scheme://host[:port]) to show for a project: the most viewed one that is a public http(s) host. */
export function pickOrigin(rows: Array<{ origin: string | null; n: number }>): string | null {
  for (const r of [...rows].sort((a, b) => b.n - a.n)) {
    if (!r.origin) continue;
    let u: URL;
    try {
      u = new URL(r.origin);
    } catch {
      continue;
    }
    if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && isPublicHost(u.hostname)) return u.origin;
  }
  return null;
}

/** From the maintenance job: (re)detect the site of projects not checked in the last day, until `deadline`. */
export async function detectSites(deadline: number, now = Date.now()): Promise<{ checked: number }> {
  const due = await query<{ id: string }>(
    `SELECT p.id FROM projects p LEFT JOIN project_sites s ON s.project_id = p.id
      WHERE s.origin_checked_at IS NULL OR s.origin_checked_at < $1 ORDER BY s.origin_checked_at NULLS FIRST`,
    [new Date(now - DETECT_EVERY_MS)],
  );
  let checked = 0;
  for (const { id } of due) {
    if (Date.now() > deadline) break;
    const from = new Date(now - DETECT_WINDOW_MS), to = new Date(now);
    const rows = await rawQuery<{ origin: string | null; n: bigint | number }>(id, { from, to },
      `SELECT regexp_extract(url, '^(https?://[^/?#]+)', 1) AS origin, count(*) AS n
         FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND type = 'pageview' AND url IS NOT NULL
        GROUP BY 1 ORDER BY n DESC LIMIT 20`,
      [id, from, to]);
    const origin = pickOrigin(rows.map((r) => ({ origin: r.origin, n: Number(r.n) })));
    await execute(
      `INSERT INTO project_sites (project_id, origin, origin_checked_at) VALUES ($1, $2, $3)
       ON CONFLICT (project_id) DO UPDATE SET origin = EXCLUDED.origin, origin_checked_at = EXCLUDED.origin_checked_at`,
      [id, origin, new Date(now)],
    );
    checked++;
  }
  return { checked };
}

interface SiteRow {
  project_id: string;
  origin: string | null;
  icon: string | null;
  shot_origin: string | null;
  image_key: string | null;
  image_day: string | null;
  image_at: Date | null;
}

/**
 * Takes one screenshot of a homepage (a JPEG) and fetches the site's icon (a data URL, null when there is none);
 * throws with a short reason when the page can't be shown.
 */
export type Shooter = (origin: string) => Promise<{ image: Uint8Array; icon: string | null }>;

/**
 * From ScreenshotFunction: screenshots every project whose site wasn't attempted today (or changed since), until
 * `deadline`. `open` starts the browser, only when something is due; `close` is called once at the end.
 */
export async function runScreenshots(deadline: number, open: () => Promise<{ shoot: Shooter; close: () => Promise<void> }>, now = Date.now()): Promise<{ shot: number; failed: number }> {
  const today = dayOf(now);
  const due = await query<SiteRow>(
    `SELECT s.project_id, s.origin, s.icon, s.shot_origin, s.image_key, s.image_day, s.image_at
       FROM project_sites s JOIN projects p ON p.id = s.project_id
      WHERE s.origin IS NOT NULL AND (s.shot_day IS NULL OR s.shot_day < $1 OR s.shot_origin IS NULL OR s.shot_origin <> s.origin)
      ORDER BY s.shot_day NULLS FIRST LIMIT 100`,
    [today],
  );
  if (!due.length) return { shot: 0, failed: 0 };
  const browser = await open();
  let shot = 0, failed = 0;
  try {
    for (const row of due) {
      if (Date.now() > deadline) break;
      const origin = row.origin!;
      try {
        const { image, icon } = await browser.shoot(origin);
        const key = siteImageKey(row.project_id, today);
        await location().put(key, image);
        await execute(
          `UPDATE project_sites SET shot_day = $2, shot_origin = $3, shot_error = NULL, image_key = $4, image_day = $2, image_at = $5, icon = $6
            WHERE project_id = $1`,
          [row.project_id, today, origin, key, new Date(), icon],
        );
        if (row.image_key && row.image_key !== key) await location().remove([row.image_key]).catch(() => undefined);
        shot++;
      } catch (err) {
        const reason = ((err as Error)?.message ?? 'screenshot failed').slice(0, 300);
        // keep yesterday's image of the same site; an image of another site is dropped
        const keep = row.shot_origin === origin;
        await execute(
          `UPDATE project_sites SET shot_day = $2, shot_origin = $3, shot_error = $4${keep ? '' : ', image_key = NULL, image_day = NULL, image_at = NULL, icon = NULL'}
            WHERE project_id = $1`,
          [row.project_id, today, origin, reason],
        );
        if (!keep && row.image_key) await location().remove([row.image_key]).catch(() => undefined);
        console.warn(JSON.stringify({ screenshot: row.project_id, origin, error: reason }));
        failed++;
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  return { shot, failed };
}

/** GET /api/projects/{pid}/site (the caller must be a member; checked by the route). */
export async function getSite(pid: string): Promise<ProjectSite> {
  const rows = await query<SiteRow>('SELECT project_id, origin, icon, shot_origin, image_key, image_day, image_at FROM project_sites WHERE project_id = $1', [pid]);
  const r = rows[0];
  if (!r) return { origin: null, icon: null, image: null };
  return { origin: r.origin, icon: r.icon, image: r.image_key && r.image_day && r.image_at ? { day: r.image_day, takenAt: r.image_at.toISOString() } : null };
}

/** GET /api/projects/{pid}/site/image?day=YYYY-MM-DD: that day's screenshot as a data URL; 404 once it's replaced. */
export async function getSiteImage(pid: string, day: string | undefined): Promise<{ image: string }> {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, 'day must be YYYY-MM-DD');
  const rows = await query<{ image_key: string | null; image_day: string | null }>('SELECT image_key, image_day FROM project_sites WHERE project_id = $1', [pid]);
  const r = rows[0];
  if (!r?.image_key || r.image_day !== day) throw new HttpError(404, 'No screenshot for that day');
  const bytes = await location().get(r.image_key);
  if (!bytes) throw new HttpError(404, 'No screenshot for that day');
  return { image: 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64') };
}

/** From the purge of a deleted project: its screenshot and site row. */
export async function purgeSite(pid: string): Promise<void> {
  const rows = await query<{ image_key: string | null }>('SELECT image_key FROM project_sites WHERE project_id = $1', [pid]);
  if (rows[0]?.image_key) await location().remove([rows[0].image_key]);
  await execute('DELETE FROM project_sites WHERE project_id = $1', [pid]);
}
