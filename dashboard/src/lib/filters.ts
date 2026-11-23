import { useCallback } from 'react';
import type { Filter, FilterOp, FilterScope } from '../api/contract';
import { parseRoute, useRoute, useSetParams } from './router';

/** Scopes with discoverable fields: the filterable ones, plus OpenTelemetry metric points and uptime check runs (dashboards). */
export type FieldScope = FilterScope | 'metrics' | 'checks';

/** URL param holding each scope's filters (JSON), so filtered views are shareable links. */
export const FILTER_PARAM: Record<FilterScope, string> = { events: 'f', logs: 'lf', spans: 'tf' };

export const OP_LABEL: Record<FilterOp, string> = {
  eq: 'equals', neq: 'does not equal', contains: 'contains', not_contains: 'does not contain',
  starts_with: 'begins with', ends_with: 'ends with', gt: '>', gte: '≥', lt: '<', lte: '≤', set: 'is set', not_set: 'is not set',
};
export const OPS = Object.keys(OP_LABEL) as FilterOp[];
export const needsValue = (op: FilterOp) => op !== 'set' && op !== 'not_set';

function decode(raw: string | null): Filter[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((f) => f && typeof f.field === 'string' && OPS.includes(f.op)) : [];
  } catch {
    return [];
  }
}

/** Filters for a scope as currently in the URL (non-hook read, for building query keys/params). */
export function currentFilters(scope: FilterScope): Filter[] {
  return decode(parseRoute(window.location.hash.replace(/^#/, '') || '/').params.get(FILTER_PARAM[scope]));
}

export function useFilters(scope: FilterScope): [Filter[], (next: Filter[]) => void] {
  const route = useRoute();
  const set = useSetParams();
  const filters = decode(route.params.get(FILTER_PARAM[scope]));
  const setFilters = useCallback((next: Filter[]) => set({ [FILTER_PARAM[scope]]: next.length ? JSON.stringify(next) : null }), [set, scope]);
  return [filters, setFilters];
}

/** Product analytics leave bot traffic out unless the URL says bots=1 (API param `bots`). */
export const botsParam = (): '1' | undefined =>
  parseRoute(window.location.hash.replace(/^#/, '') || '/').params.get('bots') === '1' ? '1' : undefined;

/** API param for the current filters of a scope (undefined when none, so query keys stay stable). */
export function filtersParam(scope: FilterScope): string | undefined {
  const f = currentFilters(scope);
  return f.length ? JSON.stringify(f) : undefined;
}

const LABELS: Record<string, string> = {
  type: 'Event type', path: 'Path', url: 'URL', title: 'Page title', referrer: 'Referrer', selector: 'Selector',
  elementText: 'Element text', elementTag: 'Element tag', trackName: 'Track name', errorMessage: 'Error message',
  errorSource: 'Error source', fingerprint: 'Error fingerprint', httpMethod: 'HTTP method', httpUrl: 'HTTP URL',
  httpRoute: 'HTTP route', httpStatus: 'HTTP status', durationMs: 'Duration (ms)', name: 'Name', sessionId: 'Session ID',
  anonId: 'Anonymous ID', userId: 'User ID', browser: 'Browser', os: 'OS', device: 'Device', country: 'Country',
  region: 'Region', city: 'City', lat: 'Latitude', lon: 'Longitude', bot: 'Bot reason', body: 'Message', service: 'Service',
  severityText: 'Severity', severityNumber: 'Severity number', traceId: 'Trace ID', spanId: 'Span ID',
  statusCode: 'Status code', statusMessage: 'Status message', kind: 'Span kind',
  checkId: 'Uptime check', ok: 'Succeeded (1/0)', status: 'HTTP status', error: 'Error', unit: 'Unit', value: 'Value',
};

/** Human label for a field: built-ins get names, JSON paths keep their path (that's what users recognise). */
export const fieldLabel = (field: string) => LABELS[field] ?? field;

const SEV_NAMES: Array<[number, string]> = [[21, 'FATAL'], [17, 'ERROR'], [13, 'WARN'], [9, 'INFO'], [5, 'DEBUG'], [1, 'TRACE']];
const SPAN_STATUS = ['unset', 'ok', 'error'];
const SPAN_KINDS = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];
/** What a coded value means, shown next to it: severity 17 → "ERROR", span status 2 → "error". */
export function valueHint(field: string, op: FilterOp, value: string | undefined): string | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  if (field === 'severityNumber') { const s = SEV_NAMES.find(([m]) => n >= m)?.[1]; return s ? (op === 'gte' || op === 'gt' ? `${s}+` : s) : null; }
  if (field === 'statusCode' && (op === 'eq' || op === 'neq')) return SPAN_STATUS[n] ?? null;
  if (field === 'kind' && (op === 'eq' || op === 'neq')) return SPAN_KINDS[n] ?? null;
  return null;
}

export const describeFilter = (f: Filter) => {
  const hint = valueHint(f.field, f.op, f.value);
  return `${fieldLabel(f.field)} ${OP_LABEL[f.op]}${needsValue(f.op) ? ` ${f.value ?? ''}${hint ? ` (${hint})` : ''}` : ''}`;
};

// ---------- pages, scopes and page options ----------

/** The filter scope each filterable page shows, and the page that lists each scope's rows. */
export const PAGE_SCOPE: Record<string, FilterScope> = {
  overview: 'events', clicks: 'events', errors: 'events', network: 'events', events: 'events', goals: 'events', logs: 'logs', traces: 'spans',
};
export const SCOPE_PAGE: Record<FilterScope, string> = { events: 'events', logs: 'logs', spans: 'traces' };
export const SCOPE_LABEL: Record<FilterScope, string> = { events: 'Product events', logs: 'Logs', spans: 'Spans' };

/**
 * A page's own options (severity, service, type…) as filters of its scope, so "Create trigger" and view names
 * see everything that narrows the page, not just the filter chips. Free-text search on the events page spans
 * several fields and has no filter equivalent.
 */
export function pageFilters(page: string, params: URLSearchParams): Filter[] {
  const out: Filter[] = [];
  const p = (k: string) => params.get(k) ?? '';
  const add = (field: string, op: FilterOp, value?: string) => out.push(value === undefined ? { field, op } : { field, op, value });
  if (page === 'errors') add('type', 'eq', 'error');
  if (page === 'network') add('type', 'eq', 'http_error');
  if (page === 'clicks') add('type', 'eq', 'click');
  if (page === 'events') {
    if (p('type')) add('type', 'eq', p('type'));
    if (p('sessionId')) add('sessionId', 'eq', p('sessionId'));
  }
  if (page === 'logs') {
    if (Number(p('sev')) > 0) add('severityNumber', 'gte', p('sev'));
    if (p('service')) add('service', 'eq', p('service'));
    if (p('q')) add('body', 'contains', p('q'));
    if (p('traceId')) add('traceId', 'eq', p('traceId'));
  }
  if (page === 'traces') {
    if (p('service')) add('service', 'eq', p('service'));
    if (p('errors') === '1') add('statusCode', 'eq', '2');
    if (Number(p('min')) > 0) add('durationMs', 'gte', p('min'));
  }
  return out;
}

/**
 * Params a saved view keeps: everything but the time range, one-shot/selection params (drawers, dialogs) and the
 * filters of other scopes (they follow you between pages but don't belong to this one).
 */
const NOT_VIEW_PARAMS = new Set(['range', 'from', 'to', 'new', 'pf', 'scope', 'slack', 'fp', 'g']);
export function viewParamsOf(params: URLSearchParams, scope?: FilterScope): string {
  const out = new URLSearchParams();
  const otherScopes = new Set((Object.keys(FILTER_PARAM) as FilterScope[]).filter((s) => scope && s !== scope).map((s) => FILTER_PARAM[s]));
  for (const [k, v] of [...params].sort(([a], [b]) => a.localeCompare(b))) if (!NOT_VIEW_PARAMS.has(k) && !otherScopes.has(k) && v) out.set(k, v);
  return out.toString();
}
/** Same view? Compares page and normalised params (param order and filter JSON formatting don't matter). */
export const sameView = (a: { page: string; params: string }, b: { page: string; params: string }) => {
  const scope = PAGE_SCOPE[a.page];
  return a.page === b.page && viewParamsOf(new URLSearchParams(a.params), scope) === viewParamsOf(new URLSearchParams(b.params), scope);
};

/** Canonical key of a filter set: same conditions in any order are the same set. */
export const filterSetKey = (filters: Filter[]) =>
  JSON.stringify(filters.map(({ field, op, value }) => [field, op, needsValue(op) ? value ?? '' : '']).sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000'))));

/** Merge conditions into a filter set: a new condition replaces an existing one on the same field and operator. */
export const mergeFilters = (cur: Filter[], add: Filter[]) => [...cur.filter((x) => !add.some((f) => f.field === x.field && f.op === x.op)), ...add];
