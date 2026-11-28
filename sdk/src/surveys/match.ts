import type { SurveyFilter, WireEvent } from '../types'

/**
 * A survey's event trigger, checked in the browser against the SDK's own events. Field names and filter semantics
 * are those of the dashboard's event filters (backend/src/lib/filters.ts), mapped from the wire event the way the
 * backend stores it (backend/src/lib/events.ts normalizeBatch): `props.<path>` reads the event's data.
 */
export function fieldOf(e: WireEvent, field: string): unknown {
  const d = (e.d ?? {}) as Record<string, unknown>
  if (field.startsWith('props.')) {
    let cur: unknown = d
    for (const k of field.slice(6).split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined
    return cur
  }
  const of = (t: string, v: unknown) => (e.t === t ? v : undefined)
  switch (field) {
    case 'type': return e.t
    case 'path': return e.path
    case 'url': return e.url
    case 'title': return e.title
    case 'referrer': return of('pageview', e.ref)
    case 'userId': return e.u
    case 'selector': return of('click', d.sel)
    case 'elementText': return of('click', d.text)
    case 'elementTag': return of('click', d.tag)
    case 'trackName': return of('click', d.name)
    case 'name': return of('custom', d.name)
    case 'errorMessage': return of('error', d.msg)
    case 'errorSource': return of('error', d.src)
    case 'httpMethod': return of('http_error', typeof d.method === 'string' ? d.method.toUpperCase() : d.method)
    case 'httpUrl': return of('http_error', d.url)
    case 'httpStatus': return of('http_error', d.status)
    case 'durationMs': return of('http_error', typeof d.dur === 'number' ? Math.round(d.dur) : d.dur)
  }
  return undefined
}

const NUM = /^\s*-?\d+(\.\d+)?\s*$/

export function matches(filters: SurveyFilter[], e: WireEvent): boolean {
  return filters.every(({ field, op, value = '' }) => {
    const raw = fieldOf(e, field)
    const text = raw == null ? null : typeof raw === 'object' ? JSON.stringify(raw) : String(raw)
    const lower = text?.toLowerCase() ?? null
    const v = value.toLowerCase()
    switch (op) {
      case 'eq': return text === value
      case 'neq': return text !== value
      case 'contains': return lower !== null && lower.includes(v)
      case 'not_contains': return lower === null || !lower.includes(v)
      case 'starts_with': return lower !== null && lower.startsWith(v)
      case 'ends_with': return lower !== null && lower.endsWith(v)
      case 'set': return !!text
      case 'not_set': return !text
      default: {
        if (text === null) return false
        const numeric = NUM.test(value)
        const a: number | string = numeric ? (NUM.test(text) ? Number(text) : NaN) : text
        const b: number | string = numeric ? Number(value) : value
        if (typeof a === 'number' && Number.isNaN(a)) return false
        return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b
      }
    }
  })
}
