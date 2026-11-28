import { useCallback, useSyncExternalStore } from 'react';

export interface Route {
  segments: string[];
  params: URLSearchParams;
  raw: string;
}

function read(): string {
  return window.location.hash.replace(/^#/, '') || '/';
}
function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}
export function parseRoute(raw: string): Route {
  const [path, q = ''] = raw.split('?');
  return { segments: path.split('/').filter(Boolean), params: new URLSearchParams(q), raw };
}
export function useRoute(): Route {
  const raw = useSyncExternalStore(subscribe, read, () => '/');
  return parseRoute(raw);
}
export function navigate(to: string, replace = false) {
  const url = '#' + to;
  if (replace) window.history.replaceState(null, '', url + '');
  else window.location.hash = to;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}
export function useSetParams() {
  return useCallback((patch: Record<string, string | null | undefined>, replace = true) => {
    const r = parseRoute(read());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') r.params.delete(k); else r.params.set(k, v);
    }
    const q = r.params.toString();
    navigate('/' + r.segments.join('/') + (q ? '?' + q : ''), replace);
  }, []);
}
/** Build a link to a project page, preserving the time range params. */
export function pageHref(pid: string, page: string, params: URLSearchParams | Record<string, string> = {}, extra: Record<string, string> = {}) {
  const p = new URLSearchParams();
  const src = params instanceof URLSearchParams ? Object.fromEntries(params) : params;
  // time range and filters follow you between pages
  for (const k of ['range', 'from', 'to', 'f', 'lf', 'tf', 'bots', 'dev']) if (src[k]) p.set(k, src[k]);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const q = p.toString();
  return `/p/${pid}/${page}${q ? '?' + q : ''}`;
}
