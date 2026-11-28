import { FLOW_OTHER, type FlowExitPage, type FlowLink, type FlowMode, type FlowNode, type FlowsResponse } from '../contract';
import { parseRange } from './analytics';
import { aliasMap } from './clickAliases';
import { filterSql, flaggedSql, parseFilters } from './filters';
import { ERROR_KEY } from './funnel';
import { rawQuery } from './store/duck';

/**
 * User flows: the pages sessions view one after another (reloads collapsed), as columns of top pages with the
 * sessions moving between them, where they leave and where they hit errors. In clicks mode every click is a step
 * of its own between the pages (a click target by its selector, repeated clicks on it collapsed). Counted over raw
 * events in one statement; buildFlows() shapes its rows.
 */

export const MIN_STEPS = 3;
export const MAX_STEPS = 7;
export const DEFAULT_STEPS = 5;
/** Pages per step; the rest are FLOW_OTHER. */
export const TOP_PAGES = 6;
const TOP_ERRORS = 3;
const EXIT_PAGES = 10;

export const parseMode = (raw: string | undefined): FlowMode => (raw === 'clicks' ? 'clicks' : 'pages');

export function parseSteps(raw: string | undefined): number {
  const n = Number(raw);
  return raw && Number.isInteger(n) ? Math.min(MAX_STEPS, Math.max(MIN_STEPS, n)) : DEFAULT_STEPS;
}

/**
 * One row of the statement:
 * - total: n = sessions in the chart
 * - link: from node `a` at step i to node `b` at step i+1 (b NULL: the session left after `a`); n = sessions
 * - nerr: node `a` at step i; n = sessions that hit an error there, m = of those, sessions that left after it
 * - terr: node `a` at step i, error `b`; n = sessions
 * - exit: page `a`; n = exits, m = views, en = sessions with an error on it, em = of those, exits
 * - click: (clicks mode) click target `a` (a selector) charted at some step, `b` its most common tracked name or text
 * - cpage: (clicks mode) click target `a`, `b` the page it's most clicked on
 */
export type FlowRow = { kind: 'total' | 'link' | 'nerr' | 'terr' | 'exit' | 'click' | 'cpage'; i: number | null; a: string | null; b: string | null; n: number; m: number | null; en: number | null; em: number | null };

/**
 * Nodes, links and exit pages from the statement's rows. Steps are 1-based in SQL, 0-based in the response.
 * `aliases` (selector → alias) name click targets ahead of their text.
 */
export function buildFlows(rows: FlowRow[], start: string | null, steps: number, mode: FlowMode = 'pages', aliases: Map<string, string> = new Map()): FlowsResponse {
  const nodes = new Map<string, FlowNode>();
  const node = (i: number, key: string) => {
    const k = `${i}\u0000${key}`;
    let n = nodes.get(k);
    if (!n) nodes.set(k, (n = { step: i - 1, key, kind: 'page', sessions: 0, exits: 0, errors: 0, errorExits: 0, topErrors: [] }));
    return n;
  };
  const clicks = new Map<string, { label?: string; page?: string }>();
  const click = (key: string) => {
    let c = clicks.get(key);
    if (!c) clicks.set(key, (c = {}));
    return c;
  };
  const links: FlowLink[] = [];
  const exitPages: FlowExitPage[] = [];
  let sessions = 0;
  for (const r of rows) {
    if (r.kind === 'total') sessions = r.n;
    else if (r.kind === 'link' && r.i != null && r.a != null) {
      const n = node(r.i, r.a);
      n.sessions += r.n;
      if (r.b == null) n.exits += r.n;
      else if (r.i < steps) links.push({ step: r.i - 1, from: r.a, to: r.b, sessions: r.n });
    } else if (r.kind === 'nerr' && r.i != null && r.a != null) {
      const n = node(r.i, r.a);
      n.errors = r.n;
      n.errorExits = r.m ?? 0;
    } else if (r.kind === 'terr' && r.i != null && r.a != null && r.b != null) node(r.i, r.a).topErrors.push({ key: r.b, sessions: r.n });
    else if (r.kind === 'exit' && r.a != null) {
      const views = r.m ?? 0;
      exitPages.push({ path: r.a, views, exits: r.n, rate: views ? r.n / views : 0, errorViews: r.en ?? 0, errorExits: r.em ?? 0 });
    } else if (r.kind === 'click' && r.a != null) {
      const label = aliases.get(r.a) ?? r.b;
      click(r.a).label = label ?? undefined;
    } else if (r.kind === 'cpage' && r.a != null && r.b != null) click(r.a).page = r.b;
  }
  const list = [...nodes.values()].filter((n) => n.sessions > 0);
  for (const n of list) {
    const c = clicks.get(n.key);
    if (!c) continue;
    n.kind = 'click';
    if (c.label) n.label = c.label;
    if (c.page) n.page = c.page;
  }
  for (const n of list) n.topErrors = n.topErrors.sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key)).slice(0, TOP_ERRORS);
  list.sort((a, b) => a.step - b.step || +(a.key === FLOW_OTHER) - +(b.key === FLOW_OTHER) || b.sessions - a.sessions || a.key.localeCompare(b.key));
  links.sort((a, b) => a.step - b.step || b.sessions - a.sessions);
  exitPages.sort((a, b) => b.exits - a.exits || b.views - a.views);
  return { mode, start, steps, sessions, nodes: list, links, exitPages: exitPages.slice(0, EXIT_PAGES) };
}

const RANGE = `project_id = $1 AND ts >= $2 AND ts < $3 AND session_id IS NOT NULL`;

/** GET /flows */
export async function flows(pid: string, p: Record<string, string | undefined>): Promise<FlowsResponse> {
  const r = parseRange(p);
  const steps = parseSteps(p.steps);
  const mode = parseMode(p.mode);
  const start = p.start?.trim() || null;
  const params: unknown[] = [pid, r.from, r.to];
  const bots = flaggedSql(p);
  // the filters choose sessions: any of their events matches (pageviews alone would lose e.g. "type = error")
  const filters = parseFilters(p.filters);
  const sessionsWhere = filters.length ? ` AND session_id IN (SELECT session_id FROM events WHERE ${RANGE}${filterSql(filters, 'events', params)}${bots})` : bots;
  // the steps: k is what a step is keyed on (the path, or a click's selector), page the page it happened on
  const items = mode === 'clicks'
    ? `SELECT session_id, ts, id, CASE WHEN type = 'click' THEN selector ELSE path END AS k, path AS page, type = 'click' AS clk,
              COALESCE(track_name, element_text) AS txt
         FROM events WHERE ${RANGE} AND ((type = 'pageview' AND path IS NOT NULL) OR (type = 'click' AND selector IS NOT NULL))${sessionsWhere}`
    : `SELECT session_id, ts, id, path AS k, path AS page FROM events WHERE ${RANGE} AND type = 'pageview' AND path IS NOT NULL${sessionsWhere}`;
  let seq = `seq AS (SELECT session_id, ts, k, page, until, i FROM r)`;
  if (start) {
    params.push(start);
    seq = `s0 AS (SELECT session_id, min(i) AS i0 FROM r WHERE k = $${params.length} GROUP BY session_id),
     seq AS (SELECT r.session_id, r.ts, r.k, r.page, r.until, r.i - s0.i0 + 1 AS i FROM r JOIN s0 ON s0.session_id = r.session_id WHERE r.i >= s0.i0)`;
  }
  // clicks mode: what to call the charted click targets, and the page each is most clicked on
  const clickCtes = mode === 'clicks'
    ? `,
     ck AS (SELECT k, txt, page FROM pv WHERE clk AND k IN (SELECT k FROM top)),
     ckt AS (SELECT k, txt, row_number() OVER (PARTITION BY k ORDER BY count(*) DESC, txt) AS rk FROM ck WHERE txt IS NOT NULL GROUP BY k, txt),
     ckp AS (SELECT k, page, row_number() OVER (PARTITION BY k ORDER BY count(*) DESC, page) AS rk FROM ck WHERE page IS NOT NULL GROUP BY k, page)`
    : '';
  const clickRows = mode === 'clicks'
    ? `
     UNION ALL (SELECT 'click', NULL, c.k, t.txt, NULL, NULL, NULL, NULL FROM (SELECT DISTINCT k FROM ck) c LEFT JOIN ckt t ON t.k = c.k AND t.rk = 1)
     UNION ALL (SELECT 'cpage', NULL, k, page, NULL, NULL, NULL, NULL FROM ckp WHERE rk = 1)`
    : '';
  const [rows, aliases] = await Promise.all([rawQuery<FlowRow>(pid, r,
    `WITH pv AS (${items}),
     d AS (SELECT session_id, ts, id, k, page, lag(k) OVER (PARTITION BY session_id ORDER BY ts, id) AS prev FROM pv),
     -- one row per step in order, repeats collapsed; \`until\`: when the next step happened
     r AS (SELECT session_id, ts, k, page, row_number() OVER w AS i, lead(ts) OVER w AS until
             FROM d WHERE prev IS DISTINCT FROM k WINDOW w AS (PARTITION BY session_id ORDER BY ts, id)),
     ${seq},
     lst AS (SELECT session_id, max(i) AS n FROM seq GROUP BY session_id),
     top AS (SELECT i, k FROM (SELECT i, k, row_number() OVER (PARTITION BY i ORDER BY count(*) DESC, k) AS rk
                                 FROM seq WHERE i <= ${steps} GROUP BY i, k) t WHERE rk <= ${TOP_PAGES}),
     nd AS (SELECT s.session_id, s.i, COALESCE(t.k, '${FLOW_OTHER}') AS node, s.i = l.n AS is_last
              FROM seq s JOIN lst l ON l.session_id = s.session_id LEFT JOIN top t ON t.i = s.i AND t.k = s.k
             WHERE s.i <= ${steps + 1}),
     -- errors at a step: from it up to the next step
     er AS (SELECT session_id, ts, COALESCE(${ERROR_KEY}, '(no message)') AS err FROM events
             WHERE ${RANGE} AND type IN ('error', 'http_error') AND session_id IN (SELECT session_id FROM lst)),
     se AS (SELECT s.session_id, s.i, s.page, e.err FROM seq s JOIN er e ON e.session_id = s.session_id AND e.ts >= s.ts AND (s.until IS NULL OR e.ts < s.until)),
     ne AS (SELECT se.session_id, se.i, nd.node, nd.is_last, se.err FROM se JOIN nd ON nd.session_id = se.session_id AND nd.i = se.i WHERE se.i <= ${steps}),
     te AS (SELECT i, node, err, count(DISTINCT session_id)::int AS n FROM ne GROUP BY i, node, err),
     -- exit pages: the page of the session's last step
     pg AS (SELECT DISTINCT session_id, page FROM seq WHERE page IS NOT NULL),
     ex AS (SELECT s.session_id, s.page FROM seq s JOIN lst l ON l.session_id = s.session_id AND s.i = l.n),
     pe AS (SELECT DISTINCT session_id, page FROM se)${clickCtes}
     SELECT 'total' AS kind, NULL::int AS i, NULL::text AS a, NULL::text AS b, count(*)::int AS n, NULL::int AS m, NULL::int AS en, NULL::int AS em FROM lst
     UNION ALL (SELECT 'link', a.i, a.node, b.node, count(*)::int, NULL, NULL, NULL FROM nd a
                  LEFT JOIN nd b ON b.session_id = a.session_id AND b.i = a.i + 1
                 WHERE a.i <= ${steps} GROUP BY a.i, a.node, b.node)
     UNION ALL (SELECT 'nerr', i, node, NULL, count(DISTINCT session_id)::int, count(DISTINCT CASE WHEN is_last THEN session_id END)::int, NULL, NULL
                  FROM ne GROUP BY i, node)
     UNION ALL (SELECT 'terr', i, node, err, n, NULL, NULL, NULL FROM (
                  SELECT i, node, err, n, row_number() OVER (PARTITION BY i, node ORDER BY n DESC, err) AS rk FROM te) x WHERE rk <= ${TOP_ERRORS})
     UNION ALL (SELECT 'exit', NULL, pg.page, NULL, count(ex.session_id)::int, count(*)::int, count(pe.session_id)::int,
                       count(CASE WHEN ex.session_id IS NOT NULL AND pe.session_id IS NOT NULL THEN 1 END)::int
                  FROM pg LEFT JOIN ex ON ex.session_id = pg.session_id AND ex.page = pg.page
                          LEFT JOIN pe ON pe.session_id = pg.session_id AND pe.page = pg.page
                 GROUP BY pg.page ORDER BY 5 DESC, 6 DESC LIMIT ${EXIT_PAGES})${clickRows}`,
    params,
  ), mode === 'clicks' ? aliasMap(pid) : Promise.resolve(new Map<string, string>())]);
  return buildFlows(rows, start, steps, mode, aliases);
}
