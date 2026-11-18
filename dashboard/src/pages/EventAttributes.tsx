import type { ReactNode } from 'react';
import { ListFilter } from 'lucide-react';
import type { AnalyticsEvent, FilterScope } from '../api/contract';
import { fieldLabel } from '../lib/filters';
import { useAddFilter } from '../ui/FilterBar';

/** Built-in event fields shown when expanding a row (the order is the reading order). */
const FIELDS: Array<keyof AnalyticsEvent> = [
  'bot', 'type', 'name', 'path', 'url', 'title', 'referrer', 'trackName', 'elementText', 'elementTag', 'selector',
  'errorMessage', 'errorSource', 'fingerprint', 'httpMethod', 'httpUrl', 'httpRoute', 'httpStatus', 'durationMs',
  'userId', 'sessionId', 'anonId', 'browser', 'os', 'device', 'country', 'region', 'city', 'lat', 'lon',
];

/** Flatten nested JSON into dotted paths; arrays and deep objects become JSON text. */
export function flatten(value: unknown, prefix: string, depth = 0, out: Array<[string, string]> = []): Array<[string, string]> {
  if (value && typeof value === 'object' && !Array.isArray(value) && depth < 4) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
  } else if (value !== undefined && value !== null && value !== '') {
    out.push([prefix, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  }
  return out;
}

/** Attribute table with a one-click "filter by this value" per row. */
export function AttributeTable({ rows, scope, extra }: { rows: Array<[field: string, value: string]>; scope: FilterScope; extra?: Record<string, ReactNode> }) {
  const addFilter = useAddFilter(scope);
  return (
    <div className="grid grid-cols-[minmax(96px,140px)_minmax(0,1fr)_auto] gap-x-3 text-[12px] sm:grid-cols-[minmax(140px,220px)_minmax(0,1fr)_auto] sm:gap-x-4">
      {rows.map(([field, value]) => (
        <div key={field} className="group contents">
          <div className="truncate py-1 text-faint" title={field}>{fieldLabel(field) !== field ? fieldLabel(field) : <span className="font-mono">{field}</span>}</div>
          <div className="min-w-0 break-words py-1 font-mono text-[11.5px]">{extra?.[field] ?? value}</div>
          <button onClick={() => addFilter({ field, op: 'eq', value })} title={`Filter: ${field} = ${value}`}
            className="rounded p-1 text-faint opacity-0 transition-opacity hover:bg-[var(--hl)] hover:text-accent group-hover:opacity-100 cursor-pointer"><ListFilter size={13} /></button>
        </div>))}
    </div>
  );
}

export function eventAttributeRows(e: AnalyticsEvent): Array<[string, string]> {
  const builtins = FIELDS.flatMap((k): Array<[string, string]> => (e[k] === null || e[k] === undefined || e[k] === '' ? [] : [[k, String(e[k])]]));
  return [...builtins, ...flatten(e.props, 'props')];
}
