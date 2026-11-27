import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DuckDBConnection, DuckDBInstance, DuckDBType } from '@duckdb/node-api';
import type { SqlColumn, SqlExport, SqlExportRequest, SqlRequest, SqlResult, SqlSchema } from '../contract';
import { parseRange, type Range } from './analytics';
import { HttpError } from './http';
import { duckQuery, filesFor, forgetFileLists, identityPairs, isMissingFile, loadDuckDb, relation, storeSecretSql, tsParam } from './store/duck';
import { location, type StoredFile } from './store/files';
import { DUCK_TYPES, RAW_TABLES, TABLES, type RawTable } from './store/tables';

/**
 * The SQL editor: DuckDB SQL a project member writes, over that project's raw tables.
 *
 * Every query gets a DuckDB instance of its own. Its tables are views over the project's Parquet files of the
 * chosen range, and before the query runs the instance is locked down: no file or network access except those
 * files (allowed_paths), and no changing settings. So a query can't read another project's files, local files
 * or environment, write anywhere (except the one export file it was given) or load extensions.
 */

const MAX_SQL_CHARS = 100_000;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;
/** JSON budget of one result: a Lambda response can't exceed 6 MB */
const MAX_RESULT_BYTES = 4_500_000;
/** Below API Gateway's 30 s and the API function's timeout, with room for listing files */
const timeoutMs = () => Number(process.env.SQL_TIMEOUT_MS ?? 24_000);
const EXPORT_URL_TTL_SECONDS = 15 * 60;

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

// ---------------------------------------------------------------- schema

const TABLE_DOCS: Record<RawTable, { description: string; columns?: Record<string, string> }> = {
  events: {
    description: 'Browser events from the SDK: pageviews, clicks, errors, failed requests, Web Vitals, custom events.',
    columns: {
      ts: 'When it happened (UTC)',
      type: "pageview, click, error, http_error, vitals, custom or identify",
      session_id: 'Browser session',
      anon_id: 'Anonymous visitor id (per browser)',
      user_id: 'Identified user; earlier anonymous events of the same browser are resolved to it',
      path: 'URL path of the page',
      selector: 'CSS selector of the clicked element',
      track_name: 'data-track name of the clicked element',
      name: 'Custom event name',
      fingerprint: 'Error group',
      http_status: 'Status of a failed request (0: network error)',
      duration_ms: 'Duration of a failed request',
      props: "Everything the SDK sent (JSON): Web Vitals as props->>'lcp', 'inp', 'cls', 'fcp', 'ttfb'; a custom event's properties under props->'props'",
      bot: 'Bot name when the visitor is a known bot, else NULL',
      dt: 'UTC day of the file',
    },
  },
  logs: {
    description: 'OpenTelemetry log records.',
    columns: {
      ts: 'When it was logged (UTC)',
      severity_number: '1-24: 9+ info, 13+ warn, 17+ error, 21+ fatal',
      body: 'Log message',
      service: 'service.name',
      attributes: 'Log attributes (JSON)',
      resource: 'Resource attributes (JSON)',
      dt: 'UTC day of the file',
    },
  },
  spans: {
    description: 'OpenTelemetry trace spans.',
    columns: {
      start_time: 'Span start (UTC)',
      parent_span_id: 'NULL for a root span',
      kind: '0 unspecified, 1 internal, 2 server, 3 client, 4 producer, 5 consumer',
      service: 'service.name',
      status_code: '0 unset, 1 ok, 2 error',
      attributes: 'Span attributes (JSON)',
      resource: 'Resource attributes (JSON)',
      events: 'Span events (JSON)',
      dt: 'UTC day of the file',
    },
  },
  metric_points: {
    description: 'OpenTelemetry metric data points.',
    columns: {
      ts: 'Time of the point (UTC)',
      type: 'gauge, sum, histogram, exponential_histogram or summary',
      value: 'Value (sum for histograms)',
      count: 'Number of observations (histograms)',
      attributes: 'Point attributes (JSON)',
      dt: 'UTC day of the file',
    },
  },
  replays: {
    description: 'Session recording chunks; `data` holds the recorded page changes as JSON text (large).',
    columns: { ts: 'When the chunk was sent (UTC)', seq: 'Chunk number within the page', dur: 'Milliseconds the chunk covers', data: 'Recorded records (JSON text)', dt: 'UTC day of the file' },
  },
  checks: {
    description: 'Uptime check runs.',
    columns: { ts: 'When the check ran (UTC)', check_id: 'Uptime check', ok: '1 when the check passed, else 0', status: 'HTTP status', dt: 'UTC day of the file' },
  },
  visitor_days: {
    description: 'One row per visitor and UTC day, kept for retention cohorts.',
    columns: { day: 'UTC day', person: 'user_id when identified, else anon_id', goals: 'Goals reached that day (JSON)', dt: 'UTC day of the file' },
  },
};

const schemaColumns = (t: RawTable) => [...TABLES[t].columns.map(([name, type]) => ({ name, type: DUCK_TYPES[type] })), { name: 'dt', type: 'DATE' }];

/** Function names that read or write files: they can't work in the sandbox, so they aren't suggested. */
const HIDDEN_FUNCTION = /^(read_|parquet_|sniff_|glob$|iceberg_|delta_|sqlite_|postgres_|mysql_|duckdb_(secrets|extensions|settings)$|load_|write_|copy_|pragma_|checkpoint|force_checkpoint|enable_|disable_|install|getenv)/;

let schemaCache: Promise<Pick<SqlSchema, 'functions' | 'keywords'>> | null = null;

async function catalog(): Promise<Pick<SqlSchema, 'functions' | 'keywords'>> {
  const fns = await duckQuery<{ name: string; kind: string; params: string[]; types: string[]; returns: string | null; description: string | null; overloads: number }>(
    `SELECT function_name AS name, any_value(function_type) AS kind, first(parameters) AS params, first(parameter_types) AS types,
            first(return_type) AS returns, max(description) AS description, count(*)::int AS overloads
       FROM duckdb_functions() GROUP BY function_name ORDER BY function_name`);
  const keywords = await duckQuery<{ k: string }>(`SELECT keyword_name AS k FROM duckdb_keywords() WHERE keyword_category <> 'column_name' OR length(keyword_name) > 2 ORDER BY 1`);
  return {
    functions: fns
      .filter((f) => /^[a-z_][a-z0-9_]*$/.test(f.name) && !f.name.startsWith('__') && !HIDDEN_FUNCTION.test(f.name))
      .map((f) => {
        const args = (f.params ?? []).map((p, i) => {
          const t = f.types?.[i];
          return t && t !== 'ANY' ? `${p} ${t}` : p;
        });
        return {
          name: f.name,
          kind: f.kind as SqlSchema['functions'][number]['kind'],
          signature: `${f.name}(${args.join(', ')})${f.returns && f.returns !== 'ANY' ? ` → ${f.returns}` : ''}`,
          overloads: f.overloads,
          description: f.description ? f.description.slice(0, 400) : null,
        };
      }),
    keywords: keywords.map((r) => r.k.toUpperCase()),
  };
}

export async function schema(): Promise<SqlSchema> {
  schemaCache ??= catalog().catch((err) => {
    schemaCache = null;
    throw err;
  });
  const { functions, keywords } = await schemaCache;
  const tables = RAW_TABLES.map((t) => ({
    name: t,
    description: TABLE_DOCS[t].description,
    timeColumn: TABLES[t].time,
    columns: schemaColumns(t).map((c) => ({ ...c, ...(TABLE_DOCS[t].columns?.[c.name] ? { description: TABLE_DOCS[t].columns![c.name] } : {}) })),
  }));
  tables.push({
    name: 'identities' as RawTable,
    description: 'Which user each anonymous visitor (anon_id) identified as. events.user_id is already resolved through it.',
    timeColumn: '',
    columns: [{ name: 'anon_id', type: 'VARCHAR' }, { name: 'user_id', type: 'VARCHAR' }],
  });
  return { tables, functions, keywords };
}

// ---------------------------------------------------------------- statements

/**
 * The statement without top-level semicolons (outside strings, quoted names and comments), so it can be wrapped
 * in COPY (...). Comments stay: the caller closes the wrapper on a new line.
 */
export function stripSemicolons(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j < 0 ? sql.length : j;
      out += sql.slice(i, end);
      i = end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      const end = j < 0 ? sql.length : j + 2;
      out += sql.slice(i, end);
      i = end;
    } else {
      out += c === ';' ? ' ' : c;
      i++;
    }
  }
  return out.trimEnd();
}

function checkSql(sql: unknown): string {
  if (typeof sql !== 'string' || !sql.trim()) throw new HttpError(400, 'Write a query to run');
  if (sql.length > MAX_SQL_CHARS) throw new HttpError(400, `The query is too long (max ${MAX_SQL_CHARS / 1000}k characters)`);
  return sql;
}

/** DuckDB's message for the editor: without the "Failed to extract statements:" wrapper. */
const userMessage = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Failed to extract statements:\s*/, '');

// ---------------------------------------------------------------- sandbox

const emptyRelation = (t: RawTable) =>
  `(SELECT ${TABLES[t].columns.map(([n, type]) => `CAST(NULL AS ${DUCK_TYPES[type]}) AS ${ident(n)}`).join(', ')}, CAST(NULL AS VARCHAR) AS project_id, CAST(NULL AS DATE) AS dt LIMIT 0)`;

/** Tables a statement may use: matched as words, so a quoted or qualified name still counts. */
const tablesIn = (sql: string): RawTable[] => RAW_TABLES.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(sql));

interface Sandbox {
  inst: DuckDBInstance;
  c: DuckDBConnection;
  scanned: { files: number; bytes: number };
}

async function openSandbox(pid: string, r: Range, sql: string, writable: string | null): Promise<Sandbox> {
  const used = tablesIn(sql);
  const lists = new Map<RawTable, StoredFile[]>();
  await Promise.all(used.map(async (t) => lists.set(t, await filesFor(t, pid, r))));
  const resolveUsers = used.includes('events') || /\bidentities\b/i.test(sql);
  const pairs = resolveUsers ? await identityPairs(pid) : [];

  const { DuckDBInstance } = loadDuckDb();
  const opts: Record<string, string> = {
    TimeZone: 'UTC',
    default_null_order: 'nulls_last_on_asc_first_on_desc',
    enable_http_metadata_cache: 'true',
    parquet_metadata_cache: 'true',
  };
  const memMb = Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE);
  if (memMb) {
    // the shared instance (store/duck.ts) may hold up to 60% of the function's memory
    opts.memory_limit = `${Math.floor(memMb * 0.3)}MB`;
    opts.home_directory = '/tmp';
    opts.temp_directory = '/tmp/duckdb-sql';
  }
  if (process.env.DUCKDB_EXTENSION_DIRECTORY) {
    opts.extension_directory = process.env.DUCKDB_EXTENSION_DIRECTORY;
    opts.autoinstall_known_extensions = 'false';
  }
  const inst = await DuckDBInstance.create(':memory:', opts);
  const c = await inst.connect();
  try {
    const secret = storeSecretSql('store');
    if (secret) {
      await c.run('LOAD httpfs');
      await c.run(secret);
    }
    await c.run('CREATE TABLE identities (anon_id VARCHAR, user_id VARCHAR)');
    if (pairs.length) {
      const ap = await c.createAppender('identities');
      for (const p of pairs) {
        ap.appendVarchar(p.anon_id);
        ap.appendVarchar(p.user_id);
        ap.endRow();
      }
      ap.closeSync();
    }
    const from = `TIMESTAMP ${sqlString(tsParam(r.from))}`, to = `TIMESTAMP ${sqlString(tsParam(r.to))}`;
    for (const t of RAW_TABLES) {
      const rel = relation(t, lists.get(t) ?? [], emptyRelation(t));
      const time = ident(TABLES[t].time);
      // visitor_days has one row per day: a range starting mid-day still includes that day
      const lower = t === 'visitor_days' ? `date_trunc('day', ${from})` : from;
      const src = t === 'events' && pairs.length
        ? `SELECT e.* REPLACE (coalesce(e.user_id, i.user_id) AS user_id) FROM (${rel}) e LEFT JOIN identities i ON i.anon_id = e.anon_id`
        : rel;
      await c.run(`CREATE VIEW ${t} AS SELECT * EXCLUDE (project_id) FROM (${src}) WHERE ${time} >= ${lower} AND ${time} < ${to}`);
    }
    const files = [...lists.values()].flat();
    const loc = location();
    const allowed = [...files.map((f) => loc.url(f.key)), ...(writable ? [writable] : [])];
    await c.run(`SET allowed_paths = [${allowed.map(sqlString).join(', ')}]`);
    await c.run('SET allowed_directories = []');
    await c.run('SET enable_external_access = false');
    await c.run('SET lock_configuration = true');
    return { inst, c, scanned: { files: files.length, bytes: files.reduce((s, f) => s + f.size, 0) } };
  } catch (err) {
    close({ inst, c });
    throw err;
  }
}

function close(s: Pick<Sandbox, 'inst' | 'c'>) {
  try { s.c.closeSync(); } catch { /* already closed */ }
  try { s.inst.closeSync(); } catch { /* already closed */ }
}

/** Run `fn` in a fresh sandbox, retrying once when a listed file was merged away meanwhile. */
async function withSandbox<T>(pid: string, r: Range, sql: string, writable: string | null, fn: (s: Sandbox) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const s = await openSandbox(pid, r, sql, writable);
    let timedOut = false;
    const limitMs = timeoutMs();
    const timer = setTimeout(() => { timedOut = true; s.c.interrupt(); }, limitMs);
    try {
      return await fn(s);
    } catch (err) {
      if (timedOut) throw new HttpError(400, `The query ran longer than ${Math.round(limitMs / 1000)} seconds and was stopped. Try a shorter time range, fewer columns, or a LIMIT.`);
      if (attempt === 0 && /^(IO|HTTP) Error/.test(userMessage(err)) && isMissingFile(err)) {
        forgetFileLists();
        continue;
      }
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, userMessage(err));
    } finally {
      clearTimeout(timer);
      close(s);
    }
  }
}

async function oneStatement(c: DuckDBConnection, sql: string) {
  const ex = await c.extractStatements(sql);
  if (ex.count === 0) throw new HttpError(400, 'Write a query to run');
  if (ex.count > 1) throw new HttpError(400, `Run one statement at a time (this has ${ex.count}). In the editor, put the cursor in the one to run or select it.`);
}

// ---------------------------------------------------------------- values

const UNSAFE_INT = new Set(['BIGINT', 'HUGEINT', 'UBIGINT', 'UHUGEINT']);

function interval(v: { months: number; days: number; micros: string | number }): string {
  const parts: string[] = [];
  const y = Math.trunc(v.months / 12), mo = v.months % 12;
  if (y) parts.push(`${y} year${Math.abs(y) === 1 ? '' : 's'}`);
  if (mo) parts.push(`${mo} month${Math.abs(mo) === 1 ? '' : 's'}`);
  if (v.days) parts.push(`${v.days} day${Math.abs(v.days) === 1 ? '' : 's'}`);
  const us = BigInt(v.micros);
  if (us || !parts.length) {
    const neg = us < 0n, a = neg ? -us : us;
    const h = a / 3_600_000_000n, m = (a / 60_000_000n) % 60n, s = (a / 1_000_000n) % 60n, frac = a % 1_000_000n;
    const pad = (n: bigint) => String(n).padStart(2, '0');
    parts.push(`${neg ? '-' : ''}${pad(h)}:${pad(m)}:${pad(s)}${frac ? '.' + String(frac).padStart(6, '0').replace(/0+$/, '') : ''}`);
  }
  return parts.join(' ');
}

/** Per column: a function that turns DuckDB's JSON form of a value into what the dashboard shows. */
function converter(type: DuckDBType): (v: unknown) => unknown {
  const name = type.toString();
  if (type.alias === 'JSON') return (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
  if (UNSAFE_INT.has(name)) return (v) => (typeof v === 'string' && Number.isSafeInteger(Number(v)) ? Number(v) : v);
  if (name.startsWith('DECIMAL')) return (v) => (typeof v === 'string' && Number.isFinite(Number(v)) ? Number(v) : v);
  if (name === 'INTERVAL') return (v) => (v && typeof v === 'object' ? interval(v as never) : v);
  return (v) => v;
}

const columnType = (t: DuckDBType) => t.alias ?? t.toString();

// ---------------------------------------------------------------- run

function body<T extends { from?: string; to?: string }>(b: unknown): T & { range: Range } {
  const o = (b && typeof b === 'object' ? b : {}) as T;
  return { ...o, range: parseRange({ from: o.from, to: o.to }) };
}

export async function run(pid: string, input: unknown): Promise<SqlResult> {
  const req = body<SqlRequest>(input);
  const sql = checkSql(req.sql);
  const limit = Math.min(Math.max(1, Math.floor(Number(req.limit) || DEFAULT_LIMIT)), MAX_LIMIT);
  return withSandbox(pid, req.range, sql, null, async ({ c, scanned }) => {
    await oneStatement(c, sql);
    const t0 = performance.now();
    const result = await c.stream(sql);
    const { JsonDuckDBValueConverter } = loadDuckDb();
    const names = result.columnNames(), types = result.columnTypes();
    const convert = types.map(converter);
    const rows: unknown[][] = [];
    let bytes = 0, truncated = false;
    outer: for (;;) {
      const chunk = await result.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      for (const raw of chunk.convertRows(JsonDuckDBValueConverter)) {
        if (rows.length >= limit) { truncated = true; break outer; }
        const row = raw.map((v, i) => (v === null ? null : convert[i](v)));
        bytes += JSON.stringify(row).length + 1;
        if (bytes > MAX_RESULT_BYTES && rows.length) { truncated = true; break outer; }
        rows.push(row);
      }
    }
    const columns: SqlColumn[] = names.map((name, i) => ({ name, type: columnType(types[i]) }));
    return { columns, rows, truncated, elapsedMs: Math.round(performance.now() - t0), scanned };
  });
}

/**
 * The whole result as a CSV or NDJSON file. DuckDB writes it straight to the data bucket (the only path the
 * sandbox may write) and the caller gets a short-lived download link; the bucket expires exports after a day.
 */
export async function exportResult(pid: string, input: unknown, projectName = 'wgo'): Promise<SqlExport> {
  const req = body<SqlExportRequest>(input);
  const sql = checkSql(req.sql);
  const format = req.format === 'ndjson' ? 'ndjson' : 'csv';
  const loc = location();
  const key = `exports/project_id=${pid}/${randomUUID()}.${format}`;
  const target = loc.url(key);
  if (!loc.s3) await mkdir(dirname(target), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const filename = `${projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'wgo'}-query-${stamp}.${format}`;
  const options = format === 'csv' ? 'FORMAT csv, HEADER true' : 'FORMAT json';
  const rows = await withSandbox(pid, req.range, sql, target, async ({ c }) => {
    await oneStatement(c, sql);
    const res = await c.runAndReadAll(`COPY (\n${stripSemicolons(sql)}\n) TO ${sqlString(target)} (${options}, USE_TMP_FILE false)`);
    return Number(res.getRows()[0]?.[0] ?? 0);
  });
  if (loc.s3) return { url: await loc.presignGet(key, EXPORT_URL_TTL_SECONDS, filename), filename, rows };
  // local dev server: no presigned links, so the file comes back in the response
  try {
    return { url: null, content: (await readFile(target)).toString('utf8'), filename, rows };
  } finally {
    await rm(target, { force: true });
  }
}
