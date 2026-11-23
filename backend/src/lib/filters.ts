import type { Filter, FilterOp, FilterScope } from '../contract';
import { HttpError } from './http';

/**
 * Rich filters → SQL for the raw-data queries (DuckDB, see store/duck.ts). Everything user-supplied (values,
 * JSON paths) is bound as a parameter; only column names from the fixed registry below are interpolated.
 */

type ColType = 'text' | 'number';
interface Column { sql: string; type: ColType }

const col = (sql: string, type: ColType = 'text'): Column => ({ sql, type });

/**
 * Scopes the generic query (lib/query.ts) can read: the filterable ones, plus OpenTelemetry metric points and uptime
 * check runs. The public FilterScope (triggers, the filter bar) stays the first three.
 */
export type QueryScope = FilterScope | 'metrics' | 'checks';

/** Built-in fields per scope, keyed by their API (camelCase) name. */
export const COLUMNS: Record<QueryScope, Record<string, Column>> = {
  events: {
    type: col('type'), path: col('path'), url: col('url'), title: col('title'), referrer: col('referrer'),
    selector: col('selector'), elementText: col('element_text'), elementTag: col('element_tag'), trackName: col('track_name'),
    errorMessage: col('error_message'), errorSource: col('error_source'), fingerprint: col('fingerprint'),
    httpMethod: col('http_method'), httpUrl: col('http_url'), httpRoute: col('http_route'),
    httpStatus: col('http_status', 'number'), durationMs: col('duration_ms', 'number'),
    name: col('name'), sessionId: col('session_id'), anonId: col('anon_id'), userId: col('user_id'),
    browser: col('browser'), os: col('os'), device: col('device'),
    country: col('country'), region: col('region'), city: col('city'), lat: col('lat', 'number'), lon: col('lon', 'number'),
    bot: col('bot'),
  },
  logs: {
    body: col('body'), service: col('service'), severityText: col('severity_text'), severityNumber: col('severity_number', 'number'),
    traceId: col('trace_id'), spanId: col('span_id'),
  },
  spans: {
    name: col('name'), service: col('service'), durationMs: col('duration_ms', 'number'), statusCode: col('status_code', 'number'),
    statusMessage: col('status_message'), kind: col('kind', 'number'), traceId: col('trace_id'), spanId: col('span_id'),
  },
  metrics: {
    name: col('name'), service: col('service'), type: col('type'), unit: col('unit'), value: col('value', 'number'),
  },
  checks: {
    checkId: col('check_id'), ok: col('ok', 'number'), status: col('status', 'number'), durationMs: col('duration_ms', 'number'),
    error: col('error'), region: col('region'),
  },
};

/**
 * JSON columns per scope and how a field maps into them. Event props nest (`props.props.plan` is a custom
 * event's `plan`), so the remainder is a path. OpenTelemetry attribute keys contain dots themselves
 * (`http.route`), so the remainder is one key.
 */
const JSON_PREFIXES: Record<QueryScope, Record<string, { column: string; nested: boolean }>> = {
  events: { props: { column: 'props', nested: true } },
  logs: { attributes: { column: 'attributes', nested: false }, resource: { column: 'resource', nested: false } },
  spans: { attributes: { column: 'attributes', nested: false }, resource: { column: 'resource', nested: false } },
  metrics: { attributes: { column: 'attributes', nested: false } },
  checks: {},
};

export const OPS: FilterOp[] = ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'gt', 'gte', 'lt', 'lte', 'set', 'not_set'];
const MAX_FILTERS = 20;
const MAX_VALUE = 500;

export function parseFilters(raw: string | undefined): Filter[] {
  if (!raw) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'filters must be a JSON array');
  }
  if (!Array.isArray(list)) throw new HttpError(400, 'filters must be a JSON array');
  if (list.length > MAX_FILTERS) throw new HttpError(400, `At most ${MAX_FILTERS} filters`);
  return list.map((f) => {
    const { field, op, value } = (f ?? {}) as Record<string, unknown>;
    if (typeof field !== 'string' || !field || field.length > 200) throw new HttpError(400, 'Each filter needs a field');
    if (!OPS.includes(op as FilterOp)) throw new HttpError(400, `Unknown filter op: ${String(op)}`);
    if (op !== 'set' && op !== 'not_set' && (typeof value !== 'string' && typeof value !== 'number')) throw new HttpError(400, `Filter on ${field} needs a value`);
    return { field, op: op as FilterOp, value: value === undefined ? undefined : String(value).slice(0, MAX_VALUE) };
  });
}

/** DuckDB JSON path with every key quoted: `$."props"."plan"`, `$."http.route"`. */
export const jsonPath = (keys: string[]) => '$' + keys.map((k) => `."${k.replace(/["\\]/g, (c) => '\\' + c)}"`).join('');

/** Resolve a field to a SQL expression (+ its params) or reject it. */
function expression(scope: QueryScope, field: string, bind: (v: unknown) => string): { sql: string; type: ColType | 'json' } {
  const c = COLUMNS[scope][field];
  if (c) return c;
  const dot = field.indexOf('.');
  const prefix = dot > 0 ? JSON_PREFIXES[scope][field.slice(0, dot)] : undefined;
  const rest = dot > 0 ? field.slice(dot + 1) : '';
  if (!prefix || !rest) throw new HttpError(400, `Unknown field for ${scope}: ${field}`);
  const path = prefix.nested ? rest.split('.').filter(Boolean) : [rest];
  return { sql: `json_extract_string(${prefix.column}, ${bind(jsonPath(path))})`, type: 'json' };
}

/** SQL expression and kind of one field, binding any JSON path into `params`. */
export function fieldInfo(scope: QueryScope, field: string, params: unknown[]): { sql: string; type: ColType | 'json' } {
  return expression(scope, field, (v) => `$${params.push(v)}`);
}

/** SQL expression for one field, binding any JSON path into `params` (used for value suggestions). */
export function fieldExpression(scope: QueryScope, field: string, params: unknown[]): string {
  return expression(scope, field, (v) => `$${params.push(v)}`).sql;
}

const like = (v: string, pre: string, post: string) => pre + v.replace(/[\\%_]/g, (c) => '\\' + c) + post;
const NUMERIC = /^\s*-?\d+(\.\d+)?\s*$/;

/**
 * Compile filters into `AND …` SQL (empty string when none). Params are appended to `params`, so this works
 * after a query has already bound its own parameters.
 */
export function filterSql(filters: Filter[], scope: QueryScope, params: unknown[]): string {
  if (!filters.length) return '';
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const parts = filters.map(({ field, op, value = '' }) => {
    const e = expression(scope, field, bind);
    // text view of the field: numeric columns compare as text for string operators
    const text = e.type === 'number' ? `(${e.sql})::text` : e.sql;
    const isNumber = NUMERIC.test(value);
    // numeric view: json values only when they look like numbers, so a stray string never breaks the cast
    const num = e.type === 'number' ? e.sql : `(CASE WHEN ${e.sql} ~ '^\\s*-?[0-9]+(\\.[0-9]+)?\\s*$' THEN (${e.sql})::double END)`;
    switch (op) {
      case 'eq':
        return e.type === 'number' ? (isNumber ? `${e.sql} = ${bind(Number(value))}` : 'false') : `${text} = ${bind(value)}`;
      case 'neq':
        return e.type === 'number' ? (isNumber ? `${e.sql} IS DISTINCT FROM ${bind(Number(value))}` : 'true') : `${text} IS DISTINCT FROM ${bind(value)}`;
      case 'contains':
        return `${text} ILIKE ${bind(like(value, '%', '%'))} ESCAPE '\\'`;
      case 'not_contains':
        return `(${text} IS NULL OR ${text} NOT ILIKE ${bind(like(value, '%', '%'))} ESCAPE '\\')`;
      case 'starts_with':
        return `${text} ILIKE ${bind(like(value, '', '%'))} ESCAPE '\\'`;
      case 'ends_with':
        return `${text} ILIKE ${bind(like(value, '%', ''))} ESCAPE '\\'`;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const sym = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
        // numbers compare numerically; anything else (ISO dates, versions…) as text
        return isNumber ? `${num} ${sym} ${bind(Number(value))}` : `${text} ${sym} ${bind(value)}`;
      }
      case 'set':
        return `NULLIF(${text}, '') IS NOT NULL`;
      case 'not_set':
        return `NULLIF(${text}, '') IS NULL`;
    }
  });
  return ' AND ' + parts.map((p) => `(${p})`).join(' AND ');
}

/** Parse the `filters` request param and compile it in one go. */
export function filtersFrom(p: Record<string, string | undefined>, scope: FilterScope, params: unknown[]): string {
  // bot traffic is left out of product analytics unless explicitly included
  const bots = scope === 'events' && !includeBots(p) ? ' AND bot IS NULL' : '';
  return filterSql(parseFilters(p.filters), scope, params) + bots;
}

export const includeBots = (p: Record<string, string | undefined>) => p.bots === '1' || p.bots === 'true';
