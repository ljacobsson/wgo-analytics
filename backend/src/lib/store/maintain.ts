import { execute, query } from '../db';
import { getJobState, setJobState } from '../jobState';
import { duckQuery, forgetFileLists, rawRelation } from './duck';
import { location, type StoredFile } from './files';
import { dayOf, dayOfKey, dayPrefix, projectPrefix, RAW_TABLES, TABLES, type RawTable } from './tables';
import { newFileName, writeRows } from './write';

const DAY = 86_400_000;

/** The first day a project has files for in a table (YYYY-MM-DD), or null. */
export async function firstDay(table: RawTable, pid: string): Promise<string | null> {
  let first: string | null = null;
  await location().list(projectPrefix(table, pid), {
    until: (key) => {
      first = dayOfKey(key);
      return true;
    },
  });
  return first;
}

/** Delete a project's files of days before `day` (YYYY-MM-DD). Returns the number of files deleted. */
export async function deleteDaysBefore(table: RawTable, pid: string, day: string): Promise<number> {
  const prefix = projectPrefix(table, pid);
  const old = await location().list(prefix, { until: (key) => (dayOfKey(key) ?? '') >= day });
  if (old.length) await location().remove(old.map((f) => f.key));
  return old.length;
}

// ---------------------------------------------------------------- compaction

/**
 * Sizes here are bytes on disk, and a merge needs the rows uncompressed: about 12x more for spans (JSON
 * attributes; a sorted, ZSTD-compressed 50 MB merged file held 600 MB). A merge sorts all of it, spilling what
 * doesn't fit DuckDB's memory to the function's /tmp, so both limits stay well below what that can hold.
 * With a 48 MB SMALL_FILE a merged file of 47 MB was merged again with every run and no longer fit.
 */
/** Files below this are merged; bigger ones are left alone, so a busy day ends up as a handful of files. */
export const SMALL_FILE = 16 * 1024 * 1024;
/** At most this much input per merge, so one merge fits the maintenance function's memory, /tmp and time. */
const MAX_MERGE_BYTES = 64 * 1024 * 1024;
const MAX_MERGE_FILES = 2000;
/** Days back that are checked for small files (late data for older days stays as it is). */
const COMPACT_DAYS = 3;

/**
 * Merge one day's small files into one file: duplicates (an SQS redelivery, a retried SDK batch) dropped,
 * rows sorted for pruning (TABLES[t].sort), ZSTD-compressed. The new file is written before the old ones are
 * deleted; a reader that listed the old ones retries once (store/duck.ts).
 */
export async function mergeFiles(table: RawTable, pid: string, day: string, files: StoredFile[]): Promise<string> {
  const def = TABLES[table];
  const key = dayPrefix(table, pid, day) + newFileName('c');
  const cols = def.columns.map(([n]) => `"${n}"`).join(', ');
  const target = location().url(key).replace(/'/g, "''");
  if (!location().s3) await (await import('node:fs/promises')).mkdir((await import('node:path')).dirname(target), { recursive: true });
  // one pass removes duplicates within and across files (relation() would dedupe the unmerged ones a second time)
  await duckQuery(
    `COPY (
       SELECT ${cols} FROM (${rawRelation(table, files)})
       QUALIFY row_number() OVER (PARTITION BY ${def.key.join(', ')} ORDER BY ${def.time}) = 1
       ORDER BY ${def.sort.join(', ')}
     ) TO '${target}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)`,
  );
  await location().remove(files.map((f) => f.key));
  forgetFileLists();
  return key;
}

interface CompactionResult {
  done: boolean;
  /** files merged away */
  merged: number;
  /** merges that failed (logged); their files stay as they are and are tried again next run */
  failed: number;
}

/** Merge small files of the last few days for every project. Returns done: false when the deadline hit first. */
export async function runCompaction(deadline: number, now = Date.now()): Promise<CompactionResult> {
  const projects = await query<{ id: string }>('SELECT id FROM projects');
  const total: CompactionResult = { done: true, merged: 0, failed: 0 };
  for (const { id } of projects) {
    const res = await compactProject(id, deadline, now);
    total.merged += res.merged;
    total.failed += res.failed;
    if (!res.done) return { ...total, done: false };
  }
  return total;
}

/** Consecutive runs of files with at most MAX_MERGE_BYTES and MAX_MERGE_FILES each. */
export function mergeBatches(files: StoredFile[]): StoredFile[][] {
  const out: StoredFile[][] = [];
  let cur: StoredFile[] = [];
  let bytes = 0;
  for (const f of files) {
    if (cur.length && (bytes + f.size > MAX_MERGE_BYTES || cur.length >= MAX_MERGE_FILES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(f);
    bytes += f.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Merge one project's small files of the last few days, in batches that each fit one merge. A failed merge is
 * logged and skipped, so it can't hold up the other days, tables and projects.
 */
export async function compactProject(id: string, deadline: number, now = Date.now()): Promise<CompactionResult> {
  const since = dayOf(now - COMPACT_DAYS * DAY);
  let merged = 0;
  let failed = 0;
  for (const table of RAW_TABLES) {
    if (Date.now() > deadline) return { done: false, merged, failed };
    const prefix = projectPrefix(table, id);
    const files = await location().list(prefix, { startAfter: `${prefix}dt=${since}` });
    const byDay = new Map<string, StoredFile[]>();
    for (const f of files) {
      const day = dayOfKey(f.key);
      if (day && f.size < SMALL_FILE) byDay.set(day, [...(byDay.get(day) ?? []), f]);
    }
    for (const [day, small] of byDay) {
      for (const batch of mergeBatches(small)) {
        if (batch.length < 2) continue;
        if (Date.now() > deadline) return { done: false, merged, failed };
        try {
          await mergeFiles(table, id, day, batch);
          merged += batch.length;
        } catch (err) {
          failed++;
          const bytes = batch.reduce((n, f) => n + f.size, 0);
          console.error(JSON.stringify({ msg: 'merge failed', table, project: id, day, files: batch.length, bytes, error: String((err as Error)?.message ?? err).slice(0, 500) }));
        }
      }
    }
  }
  return { done: true, merged, failed };
}

// ---------------------------------------------------------------- retention

/** Delete files of days entirely before each cutoff. `cutoff` gives a project's cutoff per table. */
export async function deleteExpired(projects: string[], cutoff: (pid: string, table: RawTable) => number, deadline: number): Promise<{ done: boolean; deleted: Record<string, number> }> {
  const deleted: Record<string, number> = {};
  for (const pid of projects) {
    for (const table of RAW_TABLES) {
      if (Date.now() > deadline) return { done: false, deleted };
      const n = await deleteDaysBefore(table, pid, dayOf(cutoff(pid, table)));
      if (n) deleted[table] = (deleted[table] ?? 0) + n;
    }
  }
  if (Object.keys(deleted).length) forgetFileLists();
  return { done: true, deleted };
}

// ---------------------------------------------------------------- one-time move out of DSQL

/** Rows deleted per statement: DSQL caps a transaction at 3,000 modified rows, secondary indexes included. */
// replays, checks and visitor_days never lived in DSQL: their SELECT finds no table and moves on
const DELETE_BATCH: Record<RawTable, number> = { events: 500, logs: 1000, spans: 1000, metric_points: 1000, replays: 1000, checks: 1000, visitor_days: 1000 };
const KEY_TYPE: Record<RawTable, string> = { events: 'uuid', logs: 'uuid', spans: 'text', metric_points: 'uuid', replays: 'uuid', checks: 'uuid', visitor_days: 'text' };
const KEY_COL: Record<RawTable, string> = { events: 'id', logs: 'id', spans: 'span_id', metric_points: 'id', replays: 'id', checks: 'id', visitor_days: 'person' };
const MOVE_ROWS = 10_000;
const LEGACY = 'legacy-raw-moved';

/**
 * Stacks deployed before the Parquet store kept raw rows in DSQL tables. Move them, a chunk at a time: write
 * the chunk as Parquet, then delete exactly those rows (a row written meanwhile is moved by the next chunk).
 * Runs at the start of every maintenance run until the tables are empty, then never again.
 */
export async function moveLegacyRows(deadline: number): Promise<{ done: boolean; moved: Record<string, number> }> {
  const moved: Record<string, number> = {};
  if (await getJobState(LEGACY)) return { done: true, moved };
  for (const table of RAW_TABLES) {
    const def = TABLES[table];
    const cols = ['project_id', ...def.columns.map(([n]) => n)].join(', ');
    for (;;) {
      if (Date.now() > deadline) return { done: false, moved };
      let rows: Array<Record<string, unknown> & { project_id: string }>;
      try {
        rows = await query(`SELECT ${cols} FROM ${table} ORDER BY project_id, ${def.time} LIMIT ${MOVE_ROWS}`);
      } catch (err) {
        if ((err as { code?: string }).code === '42P01') break; // table never existed
        throw err;
      }
      if (!rows.length) break;
      await writeRows(table, rows);
      const byProject = new Map<string, typeof rows>();
      for (const r of rows) byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), r]);
      let deleted = 0;
      for (const [pid, list] of byProject) {
        for (let i = 0; i < list.length; i += DELETE_BATCH[table]) {
          const part = list.slice(i, i + DELETE_BATCH[table]);
          const times = part.map((r) => (r[def.time] as Date).getTime());
          // stored times may have microseconds; JS dates don't: widen the range by a millisecond
          deleted += await execute(
            `DELETE FROM ${table} WHERE project_id = $1 AND ${def.time} >= $2 AND ${def.time} < $3 AND ${KEY_COL[table]} = ANY($4::${KEY_TYPE[table]}[])`,
            [pid, new Date(Math.min(...times)), new Date(Math.max(...times) + 1), part.map((r) => r[KEY_COL[table]])],
          );
        }
      }
      moved[table] = (moved[table] ?? 0) + rows.length;
      if (deleted < rows.length) throw new Error(`moving ${table}: wrote ${rows.length} rows but deleted only ${deleted}`);
    }
  }
  await setJobState(LEGACY, new Date());
  return { done: true, moved };
}
