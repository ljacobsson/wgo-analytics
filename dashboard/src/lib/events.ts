import type { AnalyticsEvent } from '../api/contract';

// layout-only utility classes (Tailwind/Bootstrap) say nothing about what an element is
const UTILITY = /^-?(?:[mp][xytrblse]?-|(?:w|h|min-w|max-w|min-h|max-h|gap|space-[xy]|text|font|leading|bg|border|rounded|shadow|ring|opacity|overflow|z|top|left|right|bottom|inset|items|justify|self|place|col|row|grid-cols|grid-rows|basis|grow|shrink|flex|order|cursor|transition|duration|ease|d|fs|fw)(?:-|$)|(?:flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|truncate|container|group|peer)$)|[:[\]/]/;

/**
 * A compact description of a click target for when it has no name or text: the last selector step, kept to
 * what identifies it. `div.w-full.py-6 > … > input.w-full.rounded-lg` → `input`; `button[aria-label="Close"]` stays.
 */
export function shortSelector(sel: string | null): string {
  if (!sel) return '';
  const last = (sel.split(' > ').pop() ?? sel).replace(/:nth-of-type\(\d+\)/g, '').trim();
  if (last.startsWith('#') || last.includes('[')) return last;
  const [tag, ...classes] = last.split('.');
  const meaningful = classes.filter((c) => c && !UTILITY.test(c)).slice(0, 1);
  return [tag, ...meaningful].join('.');
}

/**
 * What to call a click target, best first: the project's alias for its selector, data-track name, captured label,
 * then a short element description.
 */
export function clickLabel(c: { trackName: string | null; elementText: string | null; selector: string | null; alias?: string | null }): string {
  return c.alias || c.trackName || c.elementText || `‹${shortSelector(c.selector)}›`;
}

/** One line describing an event. `aliases` (selector → alias, from useClickAliases) names click targets. */
export function eventTitle(e: AnalyticsEvent, aliases?: Map<string, string>): string {
  switch (e.type) {
    case 'pageview': return e.path ?? e.url ?? '';
    case 'click': return e.selector ? clickLabel({ ...e, alias: aliases?.get(e.selector) }) : e.path || '';
    case 'error': return e.errorMessage ?? '';
    case 'http_error': return `${e.httpMethod ?? ''} ${e.httpRoute ?? e.httpUrl ?? ''} → ${e.httpStatus ?? ''}`;
    case 'custom': return e.name ?? '';
    case 'vitals': return e.name ?? String(e.props?.name ?? 'web vital');
    default: return e.userId ?? e.name ?? '';
  }
}
/**
 * Who an event came from: the user id when the app identified the visitor (`WGO.identify`, or the JWT
 * auto-identify), else the last part of the anonymous id. The SDK's anonymous ids are UUIDs, so that is the
 * group after the last dash; ids without dashes show their last 8 characters.
 */
export function userLabel(e: Pick<AnalyticsEvent, 'userId' | 'anonId'>): { text: string; identified: boolean } | null {
  if (e.userId) return { text: e.userId, identified: true };
  if (!e.anonId) return null;
  const dash = e.anonId.lastIndexOf('-');
  return { text: dash >= 0 ? e.anonId.slice(dash + 1) : e.anonId.slice(-8), identified: false };
}

export function eventDetail(e: AnalyticsEvent): string {
  if (e.type === 'click') return e.selector ?? '';
  if (e.type === 'error') return e.errorSource ?? e.path ?? '';
  return e.type === 'pageview' ? (e.title ?? '') : (e.path ?? '');
}
