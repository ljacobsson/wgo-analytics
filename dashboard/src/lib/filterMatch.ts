import type { AnalyticsEvent, Filter, FilterScope } from '../api/contract';

/**
 * Filters applied in memory, with the semantics of backend/src/lib/filters.ts: mock mode answers queries with it,
 * and pages use it on live events that the warehouse doesn't have yet.
 */

export const NUMBER_FIELDS = new Set(['httpStatus', 'durationMs', 'lat', 'lon', 'severityNumber', 'statusCode', 'kind']);
export const BUILTIN: Record<FilterScope, string[]> = {
  events: ['type', 'path', 'url', 'title', 'referrer', 'selector', 'elementText', 'elementTag', 'trackName', 'errorMessage', 'errorSource', 'fingerprint',
    'httpMethod', 'httpUrl', 'httpRoute', 'httpStatus', 'durationMs', 'name', 'sessionId', 'anonId', 'userId', 'browser', 'os', 'device', 'country', 'region', 'city', 'lat', 'lon'],
  logs: ['body', 'service', 'severityText', 'severityNumber', 'traceId', 'spanId'],
  spans: ['name', 'service', 'durationMs', 'statusCode', 'statusMessage', 'kind', 'traceId', 'spanId'],
};

function get(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const k of path) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined;
  return cur;
}

/** Resolve a filter field on an event / log record. */
export function valueOf(scope: FilterScope, row: Record<string, unknown>, field: string): unknown {
  if (field.startsWith('props.')) return get(row.props, field.slice(6).split('.'));
  if (field.startsWith('attributes.')) return (row.attributes as Record<string, unknown> | undefined)?.[field.slice(11)];
  if (field.startsWith('resource.')) return (row.resource as Record<string, unknown> | undefined)?.[field.slice(9)];
  return BUILTIN[scope].includes(field) ? row[field] : undefined;
}

const NUM = /^\s*-?\d+(\.\d+)?\s*$/;

export function matches(scope: FilterScope, row: object, filters: Filter[]): boolean {
  return filters.every(({ field, op, value = '' }) => {
    const raw = valueOf(scope, row as Record<string, unknown>, field);
    const text = raw === null || raw === undefined ? null : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    const lower = text?.toLowerCase() ?? null;
    const v = value.toLowerCase();
    switch (op) {
      case 'eq': return text === value;
      case 'neq': return text !== value;
      case 'contains': return lower !== null && lower.includes(v);
      case 'not_contains': return lower === null || !lower.includes(v);
      case 'starts_with': return lower !== null && lower.startsWith(v);
      case 'ends_with': return lower !== null && lower.endsWith(v);
      case 'set': return !!text;
      case 'not_set': return !text;
      default: {
        if (text === null) return false;
        const numeric = NUM.test(value);
        const a: number | string = numeric ? (NUM.test(text) ? Number(text) : NaN) : text;
        const b: number | string = numeric ? Number(value) : value;
        if (typeof a === 'number' && Number.isNaN(a)) return false;
        return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
      }
    }
  });
}

/** The events list's free-text search (`q`): the columns backend/src/lib/analytics.ts searches with ILIKE. */
export function matchesEventSearch(e: AnalyticsEvent, q: string): boolean {
  const needle = q.toLowerCase();
  return [e.path, e.selector, e.elementText, e.trackName, e.errorMessage, e.httpUrl, e.name, e.userId].some((x) => x?.toLowerCase().includes(needle));
}
