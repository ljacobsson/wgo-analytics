/**
 * The SQL editor in mock mode. There's no DuckDB in the browser: queries are recognised only roughly, and answered
 * from the mock events (rows of events, or views per path for a GROUP BY). Enough to work on the page.
 */
import type { SqlColumn, SqlExport, SqlResult, SqlSchema } from '../api/contract';
import { splitStatements } from '../sql/statements';
import * as D from './data';

export class SqlMockError extends Error {}

const col = (name: string, type: string, description?: string) => ({ name, type, ...(description ? { description } : {}) });

const TABLES: SqlSchema['tables'] = [
  {
    name: 'events', timeColumn: 'ts', description: 'Browser events from the SDK: pageviews, clicks, errors, failed requests, Web Vitals, custom events.',
    columns: [
      col('ts', 'TIMESTAMP', 'When it happened (UTC)'), col('id', 'VARCHAR'), col('type', 'VARCHAR', 'pageview, click, error, http_error, vitals, custom or identify'),
      col('session_id', 'VARCHAR', 'Browser session'), col('anon_id', 'VARCHAR', 'Anonymous visitor id (per browser)'), col('user_id', 'VARCHAR', 'Identified user'),
      col('url', 'VARCHAR'), col('path', 'VARCHAR', 'URL path of the page'), col('title', 'VARCHAR'), col('referrer', 'VARCHAR'), col('selector', 'VARCHAR'),
      col('element_text', 'VARCHAR'), col('element_tag', 'VARCHAR'), col('track_name', 'VARCHAR'), col('error_message', 'VARCHAR'), col('error_stack', 'VARCHAR'),
      col('error_source', 'VARCHAR'), col('fingerprint', 'VARCHAR', 'Error group'), col('http_method', 'VARCHAR'), col('http_url', 'VARCHAR'), col('http_route', 'VARCHAR'),
      col('http_status', 'INTEGER'), col('duration_ms', 'INTEGER'), col('name', 'VARCHAR', 'Custom event name'), col('props', 'JSON', 'Everything the SDK sent (JSON)'),
      col('browser', 'VARCHAR'), col('os', 'VARCHAR'), col('device', 'VARCHAR'), col('country', 'VARCHAR'), col('region', 'VARCHAR'), col('city', 'VARCHAR'),
      col('lat', 'DOUBLE'), col('lon', 'DOUBLE'), col('bot', 'VARCHAR'), col('dt', 'DATE', 'UTC day of the file'),
    ],
  },
  {
    name: 'logs', timeColumn: 'ts', description: 'OpenTelemetry log records.',
    columns: [col('ts', 'TIMESTAMP'), col('id', 'VARCHAR'), col('severity_number', 'INTEGER', '9+ info, 13+ warn, 17+ error'), col('severity_text', 'VARCHAR'), col('body', 'VARCHAR'),
      col('service', 'VARCHAR'), col('trace_id', 'VARCHAR'), col('span_id', 'VARCHAR'), col('attributes', 'JSON'), col('resource', 'JSON'), col('dt', 'DATE')],
  },
  {
    name: 'spans', timeColumn: 'start_time', description: 'OpenTelemetry trace spans.',
    columns: [col('start_time', 'TIMESTAMP'), col('span_id', 'VARCHAR'), col('trace_id', 'VARCHAR'), col('parent_span_id', 'VARCHAR'), col('name', 'VARCHAR'), col('kind', 'INTEGER'),
      col('service', 'VARCHAR'), col('end_time', 'TIMESTAMP'), col('duration_ms', 'DOUBLE'), col('status_code', 'INTEGER'), col('status_message', 'VARCHAR'), col('attributes', 'JSON'),
      col('resource', 'JSON'), col('events', 'JSON'), col('dt', 'DATE')],
  },
  {
    name: 'metric_points', timeColumn: 'ts', description: 'OpenTelemetry metric data points.',
    columns: [col('ts', 'TIMESTAMP'), col('id', 'VARCHAR'), col('name', 'VARCHAR'), col('type', 'VARCHAR'), col('unit', 'VARCHAR'), col('description', 'VARCHAR'), col('service', 'VARCHAR'),
      col('value', 'DOUBLE'), col('count', 'BIGINT'), col('attributes', 'JSON'), col('dt', 'DATE')],
  },
  { name: 'replays', timeColumn: 'ts', description: 'Session recording chunks.', columns: [col('ts', 'TIMESTAMP'), col('id', 'VARCHAR'), col('session_id', 'VARCHAR'), col('anon_id', 'VARCHAR'), col('page_id', 'VARCHAR'), col('seq', 'INTEGER'), col('dur', 'INTEGER'), col('url', 'VARCHAR'), col('data', 'VARCHAR'), col('dt', 'DATE')] },
  { name: 'checks', timeColumn: 'ts', description: 'Uptime check runs.', columns: [col('ts', 'TIMESTAMP'), col('id', 'VARCHAR'), col('check_id', 'VARCHAR'), col('ok', 'INTEGER'), col('status', 'INTEGER'), col('duration_ms', 'DOUBLE'), col('error', 'VARCHAR'), col('region', 'VARCHAR'), col('dt', 'DATE')] },
  { name: 'visitor_days', timeColumn: 'day', description: 'One row per visitor and UTC day, kept for retention cohorts.', columns: [col('day', 'TIMESTAMP'), col('person', 'VARCHAR'), col('anon_id', 'VARCHAR'), col('user_id', 'VARCHAR'), col('sessions', 'INTEGER'), col('events', 'INTEGER'), col('device', 'VARCHAR'), col('country', 'VARCHAR'), col('source', 'VARCHAR'), col('goals', 'JSON'), col('dt', 'DATE')] },
  { name: 'identities', timeColumn: '', description: 'Which user each anonymous visitor (anon_id) identified as.', columns: [col('anon_id', 'VARCHAR'), col('user_id', 'VARCHAR')] },
];

const fn = (name: string, kind: SqlSchema['functions'][number]['kind'], signature: string, description: string | null = null) => ({ name, kind, signature, overloads: 1, description });
const FUNCTIONS: SqlSchema['functions'] = [
  fn('count', 'aggregate', 'count(arg) → BIGINT', 'Returns the number of non-NULL values in arg.'),
  fn('sum', 'aggregate', 'sum(arg) → DOUBLE', 'Calculates the sum value for all tuples in arg.'),
  fn('avg', 'aggregate', 'avg(x DOUBLE) → DOUBLE', 'Calculates the average value for all tuples in x.'),
  fn('min', 'aggregate', 'min(arg) → ANY'), fn('max', 'aggregate', 'max(arg) → ANY'),
  fn('any_value', 'aggregate', 'any_value(arg) → ANY', 'Returns the first non-NULL value from arg.'),
  fn('quantile_cont', 'aggregate', 'quantile_cont(x DOUBLE, pos DOUBLE) → DOUBLE', 'Returns the interpolated quantile number between 0 and 1.'),
  fn('approx_count_distinct', 'aggregate', 'approx_count_distinct(any) → BIGINT', 'Computes the approximate count of distinct elements using HyperLogLog.'),
  fn('arg_max', 'aggregate', 'arg_max(arg, val) → ANY', 'Finds the row with the maximum val and returns arg of that row.'),
  fn('histogram', 'aggregate', 'histogram(arg) → MAP', 'Returns a MAP of key-value pairs representing buckets and counts.'),
  fn('list', 'aggregate', 'list(arg) → LIST', 'Returns a LIST containing all the values of a column.'),
  fn('date_trunc', 'scalar', 'date_trunc(part VARCHAR, timestamp TIMESTAMP) → TIMESTAMP', 'Truncate to specified precision.'),
  fn('time_bucket', 'scalar', 'time_bucket(bucket_width INTERVAL, timestamp TIMESTAMP) → TIMESTAMP', 'Truncate timestamp by the specified interval bucket_width.'),
  fn('strftime', 'scalar', 'strftime(data TIMESTAMP, format VARCHAR) → VARCHAR', 'Converts a timestamp to a string according to the format string.'),
  fn('epoch_ms', 'scalar', 'epoch_ms(temporal TIMESTAMP) → BIGINT', 'Extract the epoch component in milliseconds from a temporal type.'),
  fn('json_extract_string', 'scalar', 'json_extract_string(json VARCHAR, path VARCHAR) → VARCHAR', 'Extracts a VARCHAR from json at the given path.'),
  fn('json_keys', 'scalar', 'json_keys(json VARCHAR) → VARCHAR[]', 'Returns the keys of json as a LIST of VARCHAR.'),
  fn('regexp_extract', 'scalar', 'regexp_extract(string VARCHAR, pattern VARCHAR) → VARCHAR', 'If string contains the regexp pattern, returns the capturing group.'),
  fn('regexp_matches', 'scalar', 'regexp_matches(string VARCHAR, pattern VARCHAR) → BOOLEAN', 'Returns true if string contains the regexp pattern, false otherwise.'),
  fn('split_part', 'scalar', 'split_part(string VARCHAR, separator VARCHAR, index BIGINT) → VARCHAR'),
  fn('lower', 'scalar', 'lower(string VARCHAR) → VARCHAR', 'Converts string to lower case.'),
  fn('coalesce', 'scalar', 'coalesce(value, ...) → ANY', 'Returns the first non-NULL value.'),
  fn('round', 'scalar', 'round(x DOUBLE, precision INTEGER) → DOUBLE', 'Rounds x to s decimal places.'),
  fn('range', 'table', 'range(start BIGINT, stop BIGINT) → TABLE', 'Creates a table of numbers from start (inclusive) to stop (exclusive).'),
  fn('generate_series', 'table', 'generate_series(start, stop, step) → TABLE'),
  fn('unnest', 'table', 'unnest(list) → TABLE', 'Unnests a list or struct.'),
];

const KEYWORDS = ('SELECT FROM WHERE GROUP BY ORDER HAVING LIMIT OFFSET WITH AS ON USING JOIN LEFT RIGHT INNER FULL CROSS ASOF UNION ALL EXCEPT INTERSECT '
  + 'DISTINCT AND OR NOT IN IS NULL TRUE FALSE LIKE ILIKE BETWEEN CASE WHEN THEN ELSE END CAST TRY_CAST QUALIFY WINDOW OVER PARTITION ASC DESC '
  + 'NULLS FIRST LAST INTERVAL EXCLUDE REPLACE COLUMNS PIVOT UNPIVOT DESCRIBE SUMMARIZE EXPLAIN').split(' ');

export const sqlSchema = (): SqlSchema => ({ tables: TABLES, functions: FUNCTIONS, keywords: KEYWORDS });

interface Body { sql?: string; from?: string; to?: string; limit?: number; format?: string }

export function sqlRun(body: Body): SqlResult {
  const sql = String(body.sql ?? '');
  const statements = splitStatements(sql);
  if (!statements.length) throw new SqlMockError('Write a query to run');
  if (statements.length > 1) throw new SqlMockError(`Run one statement at a time (this has ${statements.length}). In the editor, put the cursor in the one to run or select it.`);
  const text = statements[0].text.replace(/^(\s*--[^\n]*\n)+/, '');
  const word = /^\s*(\w+)/.exec(text)?.[1] ?? '';
  if (!/^(select|from|with|describe|summarize|pivot|show)$/i.test(word)) {
    const line = text.split('\n')[0];
    throw new SqlMockError(`Parser Error: syntax error at or near "${word}"\n\nLINE 1: ${line}\n        ${'^'.repeat(Math.max(1, word.length))}`);
  }
  const now = Date.now();
  const evs = D.events({ from: Date.parse(body.from ?? '') || now - 86400e3, to: Date.parse(body.to ?? '') || now, limit: 1000 }).events;
  const sqlLimit = Number(/\blimit\s+(\d+)/i.exec(text)?.[1] ?? Infinity);
  const limit = Math.min(body.limit ?? 1000, sqlLimit);
  let columns: SqlColumn[], rows: unknown[][];
  const fmt = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  if (/\b(date_trunc|time_bucket)\b/i.test(text)) {
    // over time, per hour (per day past 3 days); split by type when the query selects it
    const from = Date.parse(body.from ?? '') || now - 86400e3, to = Date.parse(body.to ?? '') || now;
    const step = to - from > 3 * 86400e3 ? 86400e3 : 3600e3;
    const byType = /\bselect\b[\s\S]*\btype\b[\s\S]*\bfrom\b/i.test(text);
    const buckets = new Map<string, number>();
    for (const e of evs) {
      const b = Math.floor(Date.parse(e.ts) / step) * step;
      const k = byType ? `${b}|${e.type}` : `${b}`;
      buckets.set(k, (buckets.get(k) ?? 0) + 1);
    }
    columns = [{ name: step === 3600e3 ? 'hour' : 'day', type: 'TIMESTAMP' }, ...(byType ? [{ name: 'type', type: 'VARCHAR' }] : []), { name: 'events', type: 'BIGINT' }];
    rows = [...buckets].map(([k, n]) => { const [b, ty] = k.split('|'); return byType ? [fmt(Number(b)), ty, n] : [fmt(Number(b)), n]; })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  } else if (/\bgroup\s+by\b/i.test(text)) {
    const by = new Map<string, { n: number; visitors: Set<string> }>();
    for (const e of evs) {
      const k = e.path ?? '/';
      const g = by.get(k) ?? { n: 0, visitors: new Set() };
      g.n++; if (e.anonId) g.visitors.add(e.anonId);
      by.set(k, g);
    }
    columns = [{ name: 'path', type: 'VARCHAR' }, { name: 'views', type: 'BIGINT' }, { name: 'visitors', type: 'BIGINT' }];
    rows = [...by].sort((a, b) => b[1].n - a[1].n).map(([k, g]) => [k, g.n, g.visitors.size]);
  } else {
    columns = [
      { name: 'ts', type: 'TIMESTAMP' }, { name: 'type', type: 'VARCHAR' }, { name: 'path', type: 'VARCHAR' }, { name: 'session_id', type: 'VARCHAR' },
      { name: 'anon_id', type: 'VARCHAR' }, { name: 'user_id', type: 'VARCHAR' }, { name: 'browser', type: 'VARCHAR' }, { name: 'country', type: 'VARCHAR' },
      { name: 'duration_ms', type: 'INTEGER' }, { name: 'props', type: 'JSON' },
    ];
    rows = evs.map((e) => [e.ts.replace('T', ' ').replace('Z', ''), e.type, e.path, e.sessionId, e.anonId, e.userId, e.browser, e.country, e.durationMs, e.props]);
  }
  const truncated = rows.length > limit && limit === body.limit;
  return { columns, rows: rows.slice(0, limit), truncated, elapsedMs: 40 + Math.round(Math.random() * 300), scanned: { files: 14, bytes: 3_412_000 } };
}

export function sqlExport(body: Body): SqlExport {
  const r = sqlRun({ ...body, limit: 100_000 });
  const format = body.format === 'ndjson' ? 'ndjson' : 'csv';
  const csvCell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const content = format === 'csv'
    ? [r.columns.map((c) => c.name).join(','), ...r.rows.map((row) => row.map(csvCell).join(','))].join('\n') + '\n'
    : r.rows.map((row) => JSON.stringify(Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])))).join('\n') + '\n';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return { url: null, content, filename: `acme-storefront-query-${stamp}.${format}`, rows: r.rows.length };
}
