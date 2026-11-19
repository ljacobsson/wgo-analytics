/**
 * Raw telemetry tables. They live as Parquet files in the data bucket (see store/files.ts), one directory per
 * table, project and UTC day:  {table}/project_id={uuid}/dt={YYYY-MM-DD}/{file}.parquet
 * DSQL only keeps configuration, error stacks and the hourly rollups.
 *
 * Column order and types here are the file schema. Add new columns at the end: readers union files by name,
 * so older files simply read the new column as NULL.
 */
export type ColType = 'string' | 'json' | 'timestamp' | 'int' | 'bigint' | 'double';

export interface TableDef {
  name: RawTable;
  /** time column: partitions (dt) and range filters use it */
  time: string;
  /** unique key within a project, used to drop duplicates when files are compacted */
  key: string[];
  /** sort order of compacted files (row-group min/max then prune scans on the leading column) */
  sort: string[];
  columns: Array<[string, ColType]>;
}

export type RawTable = 'events' | 'logs' | 'spans' | 'metric_points' | 'replays' | 'checks' | 'visitor_days';

const s = 'string' as const, j = 'json' as const, ts = 'timestamp' as const, i = 'int' as const, d = 'double' as const;

export const TABLES: Record<RawTable, TableDef> = {
  events: {
    name: 'events', time: 'ts', key: ['id'], sort: ['ts'],
    columns: [
      ['ts', ts], ['id', s], ['type', s], ['session_id', s], ['anon_id', s], ['user_id', s], ['url', s], ['path', s], ['title', s],
      ['referrer', s], ['selector', s], ['element_text', s], ['element_tag', s], ['track_name', s], ['error_message', s],
      ['error_stack', s], ['error_source', s], ['fingerprint', s], ['http_method', s], ['http_url', s], ['http_route', s],
      ['http_status', i], ['duration_ms', i], ['name', s], ['props', j], ['browser', s], ['os', s], ['device', s],
      ['country', s], ['region', s], ['city', s], ['lat', d], ['lon', d], ['bot', s],
    ],
  },
  logs: {
    name: 'logs', time: 'ts', key: ['id'], sort: ['ts'],
    columns: [
      ['ts', ts], ['id', s], ['severity_number', i], ['severity_text', s], ['body', s], ['service', s], ['trace_id', s],
      ['span_id', s], ['attributes', j], ['resource', j],
    ],
  },
  // compacted span files are sorted by trace: opening one trace then reads a single row group per file
  spans: {
    name: 'spans', time: 'start_time', key: ['trace_id', 'span_id'], sort: ['trace_id', 'start_time'],
    columns: [
      ['start_time', ts], ['span_id', s], ['trace_id', s], ['parent_span_id', s], ['name', s], ['kind', i], ['service', s],
      ['end_time', ts], ['duration_ms', d], ['status_code', i], ['status_message', s], ['attributes', j], ['resource', j], ['events', j],
    ],
  },
  metric_points: {
    name: 'metric_points', time: 'ts', key: ['id'], sort: ['ts'],
    columns: [
      ['ts', ts], ['id', s], ['name', s], ['type', s], ['unit', s], ['description', s], ['service', s], ['value', d],
      ['count', 'bigint'], ['attributes', j],
    ],
  },
  // session recordings (lib/recordings.ts): one row per chunk the recorder sent, `data` its records as JSON text.
  // Compacted files are sorted by session, so opening one recording reads a single row group per file.
  replays: {
    name: 'replays', time: 'ts', key: ['id'], sort: ['session_id', 'ts'],
    columns: [
      ['ts', ts], ['id', s], ['session_id', s], ['anon_id', s], ['page_id', s], ['seq', i], ['dur', i], ['url', s], ['data', s],
    ],
  },
  // one row per uptime check run (lib/uptime.ts); ok is 1 or 0
  checks: {
    name: 'checks', time: 'ts', key: ['id'], sort: ['ts'],
    columns: [['ts', ts], ['id', s], ['check_id', s], ['ok', i], ['status', i], ['duration_ms', d], ['error', s], ['region', s]],
  },
  // one row per visitor and UTC day (lib/visitors.ts), kept ROLLUP_RETENTION_DAYS: retention cohorts need more history
  // than raw events. The time column is `day`, not `dt`: `dt` is the hive partition column every view adds.
  // The key includes the day because unmerged files of several days are deduplicated together (store/duck.ts relation).
  visitor_days: {
    name: 'visitor_days', time: 'day', key: ['day', 'person'], sort: ['person'],
    columns: [
      ['day', ts], ['person', s], ['anon_id', s], ['user_id', s], ['sessions', i], ['events', i], ['device', s], ['country', s],
      ['source', s], ['goals', j],
    ],
  },
};

export const RAW_TABLES = Object.keys(TABLES) as RawTable[];
export const isRawTable = (t: string): t is RawTable => Object.hasOwn(TABLES, t);

export const DUCK_TYPES: Record<ColType, string> = {
  string: 'VARCHAR', json: 'JSON', timestamp: 'TIMESTAMP', int: 'INTEGER', bigint: 'BIGINT', double: 'DOUBLE',
};

const DAY = 86_400_000;
export const dayOf = (t: number) => new Date(Math.floor(t / DAY) * DAY).toISOString().slice(0, 10);
export const floorDay = (t: number) => Math.floor(t / DAY) * DAY;

/** Directory of one table's files for a project (and day). */
export const projectPrefix = (table: RawTable, pid: string) => `${table}/project_id=${pid}/`;
export const dayPrefix = (table: RawTable, pid: string, day: string) => `${projectPrefix(table, pid)}dt=${day}/`;
/** The day a file key belongs to, or null if the key isn't a data file. */
export const dayOfKey = (key: string): string | null => /\/dt=(\d{4}-\d{2}-\d{2})\/[^/]+\.parquet$/.exec(key)?.[1] ?? null;
