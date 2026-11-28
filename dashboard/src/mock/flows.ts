import { FLOW_OTHER, type AnalyticsEvent, type Filter, type FlowExitPage, type FlowLink, type FlowMode, type FlowNode, type FlowsResponse } from '../api/contract';
import { matches } from './filters';
import { errKey, mockSessions } from './funnel';

/** Mock of GET /flows over the funnel mock's shop sessions. The counting mirrors backend/src/lib/flows.ts. */

const TOP_PAGES = 6;

export function parseSteps(raw: string | undefined): number {
  const n = Number(raw);
  return raw && Number.isInteger(n) ? Math.min(7, Math.max(3, n)) : 5;
}

type Step = { key: string; page: string | null; click: boolean; text: string | null; errors: Set<string> };

/**
 * A session's steps in order (repeats collapsed) with the errors hit at each: its pages, and in clicks mode its
 * clicks (keyed by selector) between them.
 */
function sequence(evs: AnalyticsEvent[], start: string | null, mode: FlowMode): Step[] | null {
  const steps: Array<Step & { at: number }> = [];
  for (const e of evs) {
    const click = mode === 'clicks' && e.type === 'click' && !!e.selector;
    const key = click ? e.selector : e.type === 'pageview' ? e.path : null;
    if (key && steps[steps.length - 1]?.key !== key) {
      steps.push({ key, page: e.path ?? null, click, text: click ? e.trackName ?? e.elementText ?? null : null, at: Date.parse(e.ts), errors: new Set() });
    }
  }
  for (const e of evs) {
    const k = errKey(e);
    if (k == null) continue;
    const t = Date.parse(e.ts);
    const i = steps.findLastIndex((s) => s.at <= t);
    if (i >= 0) steps[i].errors.add(k || '(no message)');
  }
  const from = start ? steps.findIndex((s) => s.key === start) : 0;
  return from < 0 || !steps.length ? null : steps.slice(from);
}

export function flows(from: number, to: number, filters: Filter[], start: string | null, steps: number, mode: FlowMode = 'pages'): FlowsResponse {
  const seqs: Array<{ pages: Step[]; w: number }> = [];
  const clicks = new Map<string, { label?: string; page?: string }>();
  for (const { events, weight } of mockSessions(from, to)) {
    if (filters.length && !events.some((e) => matches('events', e, filters))) continue;
    const pages = sequence(events, start, mode);
    if (!pages) continue;
    seqs.push({ pages, w: weight });
    for (const p of pages) if (p.click && !clicks.has(p.key)) clicks.set(p.key, { label: p.text ?? undefined, page: p.page ?? undefined });
  }

  // the top pages of each step; the rest are FLOW_OTHER
  const top = Array.from({ length: steps }, (_, i) => {
    const n = new Map<string, number>();
    for (const s of seqs) if (s.pages[i]) n.set(s.pages[i].key, (n.get(s.pages[i].key) ?? 0) + s.w);
    return new Set([...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_PAGES).map(([p]) => p));
  });
  const nodeKey = (i: number, path: string) => (top[i].has(path) ? path : FLOW_OTHER);

  const nodes = new Map<string, FlowNode & { errs: Map<string, number> }>();
  const links = new Map<string, FlowLink>();
  const exits = new Map<string, FlowExitPage>();
  for (const { pages, w } of seqs) {
    pages.slice(0, steps).forEach((p, i) => {
      const key = nodeKey(i, p.key), last = i === pages.length - 1;
      const k = `${i}\u0000${key}`;
      const c = key !== FLOW_OTHER ? clicks.get(key) : undefined;
      const n = nodes.get(k) ?? { step: i, key, kind: c ? 'click' : 'page', ...c, sessions: 0, exits: 0, errors: 0, errorExits: 0, topErrors: [], errs: new Map() };
      n.sessions += w;
      if (last) n.exits += w;
      if (p.errors.size) { n.errors += w; if (last) n.errorExits += w; }
      for (const e of p.errors) n.errs.set(e, (n.errs.get(e) ?? 0) + w);
      nodes.set(k, n);
      const next = pages[i + 1];
      if (next && i < steps - 1) {
        const to = nodeKey(i + 1, next.key), lk = `${i}\u0000${key}\u0000${to}`;
        const l = links.get(lk) ?? { step: i, from: key, to, sessions: 0 };
        l.sessions += w;
        links.set(lk, l);
      }
    });
    // exit pages: the whole session from the start on, a click counting on the page it happened on
    const lastPath = pages[pages.length - 1].page;
    const viewed = new Map<string, boolean>();
    for (const p of pages) if (p.page) viewed.set(p.page, (viewed.get(p.page) ?? false) || p.errors.size > 0);
    for (const [path, err] of viewed) {
      const x = exits.get(path) ?? { path, views: 0, exits: 0, rate: 0, errorViews: 0, errorExits: 0 };
      x.views += w;
      if (err) x.errorViews += w;
      if (path === lastPath) { x.exits += w; if (err) x.errorExits += w; }
      exits.set(path, x);
    }
  }

  return {
    mode, start, steps,
    sessions: seqs.reduce((a, s) => a + s.w, 0),
    nodes: [...nodes.values()]
      .map(({ errs, ...n }) => ({ ...n, topErrors: [...errs.entries()].map(([key, s]) => ({ key, sessions: s })).sort((a, b) => b.sessions - a.sessions).slice(0, 3) }))
      .sort((a, b) => a.step - b.step || +(a.key === FLOW_OTHER) - +(b.key === FLOW_OTHER) || b.sessions - a.sessions),
    links: [...links.values()].sort((a, b) => a.step - b.step || b.sessions - a.sessions),
    exitPages: [...exits.values()].map((x) => ({ ...x, rate: x.views ? x.exits / x.views : 0 })).sort((a, b) => b.exits - a.exits || b.views - a.views).slice(0, 10),
  };
}
