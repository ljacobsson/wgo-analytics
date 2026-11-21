import { createRequire } from 'node:module';
import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { syncIdentities } from '../identities';
import { forgetFileLists, listCache } from './cache';
import { location, type StoredFile } from './files';
import { dayOf, DUCK_TYPES, projectPrefix, RAW_TABLES, TABLES, type RawTable } from './tables';

/**
 * Raw-data queries run in an in-process DuckDB over the project's Parquet files. Callers write the same SQL
 * as before (PostgreSQL flavour, `FROM events WHERE project_id = $1 AND ts >= $2 ...`): rawQuery() turns each
 * raw table it mentions into a temporary view over just the files of that project and range.
 *
 * Dialect notes for SQL run here: JSON paths use json_extract_string (no #>>), ILIKE needs an explicit
 * ESCAPE '\', `/` divides as float (use // for integers), lists are expanded into `IN ($n, ...)` (see inList),
 * and Date parameters are bound as UTC timestamp strings.
 */

export interface Window {
  from: Date;
  to: Date;
}

let ready: Promise<DuckDBInstance> | null = null;
const idle: DuckDBConnection[] = [];

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Loaded with require: deployed, the package comes from the DuckDB layer (/opt/nodejs/node_modules), which
 * Lambda puts on NODE_PATH. require() honours NODE_PATH, import() does not.
 */
function loadDuckDb(): typeof import('@duckdb/node-api') {
  const req = typeof require === 'function' ? require : createRequire(import.meta.url);
  return req('@duckdb/node-api');
}

async function createInstance(): Promise<DuckDBInstance> {
  const { DuckDBInstance } = loadDuckDb();
  const opts: Record<string, string> = {
    TimeZone: 'UTC',
    // PostgreSQL's order: NULLs last ascending, first descending
    default_null_order: 'nulls_last_on_asc_first_on_desc',
    // A warm container keeps the bytes and footers of files it has read (DuckDB's external file cache) and
    // reads them again without asking S3. Keys are never rewritten (store/write.ts newFileName; merges write
    // new keys), so cached files need no revalidation: by default every query sent one request per file
    // to check it, which was most of a refreshing dashboard's S3 cost. Only files new since the container
    // last saw them are fetched.
    validate_external_file_cache: 'NO_VALIDATION',
    enable_http_metadata_cache: 'true',
    parquet_metadata_cache: 'true',
  };
  const memMb = Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE);
  if (memMb) {
    opts.memory_limit = `${Math.floor(memMb * 0.6)}MB`;
    opts.home_directory = '/tmp';
    opts.temp_directory = '/tmp/duckdb';
  }
  // deployed: httpfs ships in the DuckDB layer, nothing is downloaded at runtime
  if (process.env.DUCKDB_EXTENSION_DIRECTORY) {
    opts.extension_directory = process.env.DUCKDB_EXTENSION_DIRECTORY;
    opts.autoinstall_known_extensions = 'false';
  }
  const inst = await DuckDBInstance.create(':memory:', opts);
  const c = await inst.connect();
  if (location().s3) {
    await c.run('LOAD httpfs');
    const e = process.env;
    const parts = [
      'TYPE s3',
      `REGION ${sqlString(e.AWS_REGION ?? 'us-east-1')}`,
      ...(e.AWS_ACCESS_KEY_ID ? [`KEY_ID ${sqlString(e.AWS_ACCESS_KEY_ID)}`, `SECRET ${sqlString(e.AWS_SECRET_ACCESS_KEY ?? '')}`] : []),
      ...(e.AWS_SESSION_TOKEN ? [`SESSION_TOKEN ${sqlString(e.AWS_SESSION_TOKEN)}`] : []),
    ];
    await c.run(`CREATE SECRET store (${parts.join(', ')})`);
  }
  // typed empty tables: every view unions with one, so a range without files (or files from before a column
  // was added) still has every column with the right type
  for (const t of RAW_TABLES) {
    const cols = TABLES[t].columns.map(([n, type]) => `"${n}" ${DUCK_TYPES[type]}`).join(', ');
    await c.run(`CREATE TABLE empty_${t} (${cols}, project_id VARCHAR, dt DATE)`);
  }
  // anon_id → user_id of every project queried so far (lib/identities.ts), shared by all connections
  await c.run('CREATE TABLE identities (project_id VARCHAR, anon_id VARCHAR, user_id VARCHAR, PRIMARY KEY (project_id, anon_id))');
  idle.push(c);
  return inst;
}

async function withConnection<T>(fn: (c: DuckDBConnection) => Promise<T>): Promise<T> {
  ready ??= createInstance().catch((err) => {
    ready = null;
    throw err;
  });
  const inst = await ready;
  const c = idle.pop() ?? (await inst.connect());
  try {
    return await fn(c);
  } finally {
    idle.push(c);
  }
}

// ---------------------------------------------------------------- params and results

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** UTC timestamp literal DuckDB casts to TIMESTAMP without a time zone */
export const tsParam = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;

function bindable(v: unknown): unknown {
  if (v instanceof Date) return tsParam(v);
  if (Array.isArray(v)) throw new Error('DuckDB parameters cannot be arrays; expand them with inList()');
  return v === undefined ? null : v;
}

/** `($n, $n+1, ...)` for a list of values appended to params. Empty lists match nothing. */
export function inList(params: unknown[], values: unknown[]): string {
  if (!values.length) return '(NULL)';
  return `(${values.map((v) => `$${params.push(v)}`).join(', ')})`;
}

export type DuckRow = Record<string, unknown>;

/** Run SQL on a connection and return plain rows: numbers instead of bigints, parsed JSON, Dates. */
async function run<T>(c: DuckDBConnection, sql: string, params: unknown[]): Promise<T[]> {
  const reader = await c.runAndReadAll(sql, params.length ? params.map(bindable) as never : undefined);
  const names = reader.columnNames();
  const json = new Set(reader.columnTypes().map((t, i) => (t.alias === 'JSON' ? names[i] : null)).filter((n): n is string => !!n));
  return reader.getRowObjectsJS().map((row) => {
    const out: DuckRow = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === 'bigint' ? Number(v) : json.has(k) && typeof v === 'string' ? JSON.parse(v) : v;
    }
    return out as T;
  });
}

export { forgetFileLists };

/** SQL without raw-table views (compaction, tests). */
export const duckQuery = <T = DuckRow>(sql: string, params: unknown[] = []) => withConnection((c) => run<T>(c, sql, params));

// ---------------------------------------------------------------- file lists

const DAY = 86_400_000;

/** Data files of one project and table with days in [from, to). */
export async function filesFor(table: RawTable, pid: string, w: Window): Promise<StoredFile[]> {
  const fromDay = dayOf(w.from.getTime());
  const toDay = dayOf(Math.max(w.from.getTime(), w.to.getTime() - 1));
  const ck = `${table}|${pid}|${fromDay}|${toDay}`;
  const hit = listCache.get(ck);
  if (hit && hit.exp > Date.now()) return hit.files;
  const prefix = projectPrefix(table, pid);
  // "…/dt=2026-11-16" sorts right before that day's keys
  const files = await location().list(prefix, {
    startAfter: `${prefix}dt=${fromDay}`,
    until: (key) => key.slice(prefix.length + 3, prefix.length + 13) > toDay,
  });
  // past days only change when files are merged or expire; today's get new files every few seconds
  const recent = Date.parse(toDay) >= Date.now() - 2 * DAY;
  listCache.set(ck, { files, exp: Date.now() + (recent ? 5_000 : 120_000) });
  if (listCache.size > 500) listCache.delete(listCache.keys().next().value!);
  return files;
}

/** Merged files are named c….parquet (store/maintain.ts); they hold no duplicates. */
export const isMerged = (key: string) => key.slice(key.lastIndexOf('/') + 1).startsWith('c');

/**
 * Relation over the given files, plus the typed empty table. Rows of files not merged yet are deduplicated on
 * the table's key (an SDK retry or SQS redelivery writes the same rows twice); those files are the recent,
 * small ones, so this stays cheap.
 */
export function relation(table: RawTable, files: StoredFile[]): string {
  const loc = location();
  const read = (list: StoredFile[]) =>
    `read_parquet([${list.map((f) => sqlString(loc.url(f.key))).join(', ')}], hive_partitioning = true, hive_types = {'project_id': VARCHAR, 'dt': DATE}, union_by_name = true)`;
  const merged = files.filter((f) => isMerged(f.key));
  const fresh = files.filter((f) => !isMerged(f.key));
  const parts = [`SELECT * FROM empty_${table}`];
  if (merged.length) parts.push(`SELECT * FROM ${read(merged)}`);
  if (fresh.length) {
    parts.push(`SELECT * FROM (SELECT * FROM ${read(fresh)} QUALIFY row_number() OVER (PARTITION BY ${TABLES[table].key.join(', ')}) = 1)`);
  }
  return parts.join(' UNION ALL BY NAME ');
}

// ---------------------------------------------------------------- identities

const IDENTITY_CHUNK = 1000;

async function insertIdentities(pid: string, rows: Array<[string, string]>): Promise<void> {
  await withConnection(async (c) => {
    for (let i = 0; i < rows.length; i += IDENTITY_CHUNK) {
      const params: unknown[] = [];
      const values = rows.slice(i, i + IDENTITY_CHUNK).map(([a, u]) => `(${sqlString(pid)}, $${params.push(a)}, $${params.push(u)})`);
      await run(c, `INSERT OR IGNORE INTO identities VALUES ${values.join(', ')}`, params);
    }
  });
}

/** SQL that reads user_id, by name or through `*`. Other queries skip the join. */
const READS_USER = /\buser_id\b|\bSELECT\s+(?:DISTINCT\s+)?\*|\w\.\*/i;

/**
 * Events with `user_id` resolved: an event without one gets the user its browser (anon_id) identified as,
 * before or after it (lib/identities.ts). Events that carry their own user id keep it.
 */
const resolvedEvents = (pid: string, rel: string) =>
  `SELECT e.* REPLACE (coalesce(e.user_id, i.user_id) AS user_id) FROM (${rel}) e
   LEFT JOIN identities i ON i.project_id = ${sqlString(pid)} AND i.anon_id = e.anon_id`;

const TABLE_REF = new RegExp(`\\b(?:FROM|JOIN)\\s+(${RAW_TABLES.join('|')})\\b`, 'gi');

/** True for errors that mean a listed file disappeared (merged or expired) before it was read. */
const isMissingFile = (err: unknown) => /404|No files found|No such file|not found|does not exist|NoSuchKey/i.test((err as Error)?.message ?? '');

/**
 * Query raw tables of one project over a time window. Every raw table named after FROM/JOIN reads only the
 * files of `pid` whose day overlaps `w`; the SQL still filters on its own time column.
 */
export async function rawQuery<T = DuckRow>(pid: string, w: Window, sql: string, params: unknown[] = []): Promise<T[]> {
  const tables = [...new Set([...sql.matchAll(TABLE_REF)].map((m) => m[1].toLowerCase() as RawTable))];
  const resolve = tables.includes('events') && READS_USER.test(sql) && (await syncIdentities(pid, (rows) => insertIdentities(pid, rows)));
  for (let attempt = 0; ; attempt++) {
    const lists = await Promise.all(tables.map((t) => filesFor(t, pid, w)));
    try {
      return await withConnection(async (c) => {
        for (let i = 0; i < tables.length; i++) {
          const rel = relation(tables[i], lists[i]);
          await c.run(`CREATE OR REPLACE TEMP VIEW ${tables[i]} AS ${resolve && tables[i] === 'events' ? resolvedEvents(pid, rel) : rel}`);
        }
        return run<T>(c, sql, params);
      });
    } catch (err) {
      if (attempt > 0 || !isMissingFile(err)) throw err;
      forgetFileLists();
    }
  }
}
