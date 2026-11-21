import type { AnalyticsEvent, FieldsResponse, FieldValuesResponse, Filter, FilterScope, LogRecord } from '../api/contract';
import { BUILTIN, NUMBER_FIELDS, matches, valueOf } from '../lib/filterMatch';

/** Mock-mode mirror of backend/src/lib/filters.ts semantics (applied in memory). */

export { matches };

export function parse(raw: string | undefined): Filter[] {
  try {
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function flattenKeys(value: unknown, prefix: string, out: Map<string, number>, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 1) return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = `${prefix}${k}`;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenKeys(v, key + '.', out, depth + 1);
    else out.set(key, (out.get(key) ?? 0) + 1);
  }
}

export function fields(scope: FilterScope, sample: Array<AnalyticsEvent | LogRecord>): FieldsResponse {
  const seen = new Map<string, number>();
  for (const row of sample) {
    if ('props' in row) flattenKeys(row.props, 'props.', seen);
    if ('attributes' in row) { flattenKeys(row.attributes, 'attributes.', seen, 1); flattenKeys(row.resource, 'resource.', seen, 1); }
  }
  return {
    builtin: BUILTIN[scope].map((field) => ({ field, type: NUMBER_FIELDS.has(field) ? 'number' : 'text' })),
    discovered: [...seen].sort((a, b) => b[1] - a[1]).map(([field, count]) => ({ field, type: 'json', count })),
  };
}

export function values(scope: FilterScope, sample: object[], field: string, q?: string): FieldValuesResponse {
  const counts = new Map<string, number>();
  for (const row of sample) {
    const raw = valueOf(scope, row as Record<string, unknown>, field);
    if (raw === null || raw === undefined || raw === '') continue;
    const v = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    if (q && !v.toLowerCase().includes(q.toLowerCase())) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return { values: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([value, count]) => ({ value, count })) };
}
