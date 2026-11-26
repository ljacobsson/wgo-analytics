import { execute, query } from './db';
import { PROJECT_CONFIG_TABLES } from './projects';
import { forgetFileLists } from './store/cache';
import { purgeSite } from './sites';
import { location } from './store/files';
import { projectPrefix, RAW_TABLES } from './store/tables';

/**
 * Removes the data of deleted projects (lib/projects.ts deleteProject), from the maintenance job.
 * Data sent just before the delete can still arrive for a while: ingest containers cache write keys for a minute
 * and queued batches are written later. So a deleted project is purged on every run, and its deleted_projects
 * row is only dropped by a complete purge that starts GRACE after the delete.
 */
const GRACE_MS = 3600_000;

/** Rows deleted per statement: DSQL caps a transaction at 3,000 modified rows, secondary indexes included. */
const BATCH = 500;
/** Per-project tables that can grow large, with their primary key after project_id. */
const BULK_TABLES: Array<[table: string, key: string]> = [
  ['error_stacks', 'fingerprint'],
  ['identities', 'anon_id'],
  ['recordings', 'session_id'],
  ['rollups', 'dim, hour, key'],
  ['rollup_sketches', 'hour'],
  ['releases', 'kind, service, version'],
  ['fix_runs', 'id'],
];

export async function purgeDeletedProjects(deadline: number, now = Date.now()): Promise<{ done: boolean; purged: string[]; files: number }> {
  const deleted = await query<{ id: string; deleted_at: Date }>('SELECT id, deleted_at FROM deleted_projects ORDER BY deleted_at');
  const purged: string[] = [];
  let files = 0;
  for (const { id, deleted_at } of deleted) {
    for (const table of PROJECT_CONFIG_TABLES) await execute(`DELETE FROM ${table} WHERE project_id = $1`, [id]);
    await purgeSite(id);
    for (const [table, key] of BULK_TABLES) {
      for (;;) {
        if (Date.now() > deadline) return { done: false, purged, files };
        const n = await execute(
          `DELETE FROM ${table} WHERE project_id = $1 AND (${key}) IN (SELECT ${key} FROM ${table} WHERE project_id = $1 LIMIT ${BATCH})`,
          [id],
        );
        if (n < BATCH) break;
      }
    }
    for (const table of RAW_TABLES) {
      if (Date.now() > deadline) return { done: false, purged, files };
      const list = await location().list(projectPrefix(table, id));
      if (list.length) await location().remove(list.map((f) => f.key));
      files += list.length;
    }
    if (now - deleted_at.getTime() >= GRACE_MS) {
      await execute('DELETE FROM deleted_projects WHERE id = $1', [id]);
      purged.push(id);
    }
  }
  if (files) forgetFileLists();
  return { done: true, purged, files };
}
