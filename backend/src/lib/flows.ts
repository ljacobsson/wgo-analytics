import { FLOW_OTHER, type FlowExitPage, type FlowLink, type FlowNode, type FlowsResponse } from '../contract';
import { parseRange } from './analytics';
import { filterSql, includeBots, parseFilters } from './filters';
import { ERROR_KEY } from './funnel';
import { rawQuery } from './store/duck';

/**
 * User flows: the pages sessions view one after another (reloads collapsed), as columns of top pages with the
 * sessions moving between them, where they leave and where they hit errors. Counted over raw events in one
 * statement; buildFlows() shapes its rows.
 */

export const MIN_STEPS = 3;
export const MAX_STEPS = 7;
export const DEFAULT_STEPS = 5;
/** Pages per step; the rest are FLOW_OTHER. */
export const TOP_PAGES = 6;
const TOP_ERRORS = 3;
const EXIT_PAGES = 10;

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
 */
export type FlowRow = { kind: 'total' | 'link' | 'nerr' | 'terr' | 'exit'; i: number | null; a: string | null; b: string | null; n: number; m: number | null; en: number | null; em: number | null };

/** Nodes, links and exit pages from the statement's rows. Steps are 1-based in SQL, 0-based in the response. */
export function buildFlows(rows: FlowRow[], start: string | null, steps: number): FlowsResponse {
  const nodes = new Map<string, FlowNode>();
  const node = (i: number, key: string) => {
    const k = `${i}\u0000${key}`;
    let n = nodes.get(k);
    if (!n) nodes.set(k, (n = { step: i - 1, key, sessions: 0, exits: 0, errors: 0, errorExits: 0, topErrors: [] }));
    return n;
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
    }
  }
  const list = [...nodes.values()].filter((n) => n.sessions > 0);
  for (const n of list) n.topErrors = n.topErrors.sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key)).slice(0, TOP_ERRORS);
  list.sort((a, b) => a.step - b.step || +(a.key === FLOW_OTHER) - +(b.key === FLOW_OTHER) || b.sessions - a.sessions || a.key.localeCompare(b.key));
  links.sort((a, b) => a.step - b.step || b.sessions - a.sessions);
  exitPages.sort((a, b) => b.exits - a.exits || b.views - a.views);
  return { start, steps, sessions, nodes: list, links, exitPages: exitPages.slice(0, EXIT_PAGES) };
}

const RANGE = `project_id = $1 AND ts >= $2 AND ts < $3 AND session_id IS NOT NULL`;

/** GET /flows */
export async function flows(pid: string, p: Record<string, string | undefined>): Promise<FlowsResponse> {
  const r = parseRange(p);
  const steps = parseSteps(p.steps);
  const start = p.start?.trim() || null;
  const params: unknown[] = [pid, r.from, r.to];
  const bots = includeBots(p) ? '' : ' AND bot IS NULL';
  // the filters choose sessions: any of their events matches (pageviews alone would lose e.g. "type = error")
  const filters = parseFilters(p.filters);
  const sessionsWhere = filters.length ? ` AND session_id IN (SELECT session_id FROM events WHERE ${RANGE}${filterSql(filters, 'events', params)}${bots})` : bots;
  let seq = `seq AS (SELECT session_id, ts, path, until, i FROM r)`;
  if (start) {
    params.push(start);
    seq = `s0 AS (SELECT session_id, min(i) AS i0 FROM r WHERE path = $${params.length} GROUP BY session_id),
     seq AS (SELECT r.session_id, r.ts, r.path, r.until, r.i - s0.i0 + 1 AS i FROM r JOIN s0 ON s0.session_id = r.session_id WHERE r.i >= s0.i0)`;
  }
  const rows = await rawQuery<FlowRow>(pid, r,
    `WITH pv AS (SELECT session_id, ts, id, path FROM events WHERE ${RANGE} AND type = 'pageview' AND path IS NOT NULL${sessionsWhere}),
     d AS (SELECT session_id, ts, id, path, lag(path) OVER (PARTITION BY session_id ORDER BY ts, id) AS prev FROM pv),
     -- one row per page in the order viewed, repeats collapsed; \`until\`: when the next page was viewed
     r AS (SELECT session_id, ts, path, row_number() OVER w AS i, lead(ts) OVER w AS until
             FROM d WHERE prev IS DISTINCT FROM path WINDOW w AS (PARTITION BY session_id ORDER BY ts, id)),
     ${seq},
     lst AS (SELECT session_id, max(i) AS n FROM seq GROUP BY session_id),
     top AS (SELECT i, path FROM (SELECT i, path, row_number() OVER (PARTITION BY i ORDER BY count(*) DESC, path) AS rk
                                    FROM seq WHERE i <= ${steps} GROUP BY i, path) t WHERE rk <= ${TOP_PAGES}),
     nd AS (SELECT s.session_id, s.i, COALESCE(t.path, '${FLOW_OTHER}') AS node, s.i = l.n AS is_last
              FROM seq s JOIN lst l ON l.session_id = s.session_id LEFT JOIN top t ON t.i = s.i AND t.path = s.path
             WHERE s.i <= ${steps + 1}),
     -- errors while on a page: from its view up to the next page's
     er AS (SELECT session_id, ts, COALESCE(${ERROR_KEY}, '(no message)') AS err FROM events
             WHERE ${RANGE} AND type IN ('error', 'http_error') AND session_id IN (SELECT session_id FROM lst)),
     se AS (SELECT s.session_id, s.i, s.path, e.err FROM seq s JOIN er e ON e.session_id = s.session_id AND e.ts >= s.ts AND (s.until IS NULL OR e.ts < s.until)),
     ne AS (SELECT se.session_id, se.i, nd.node, nd.is_last, se.err FROM se JOIN nd ON nd.session_id = se.session_id AND nd.i = se.i WHERE se.i <= ${steps}),
     te AS (SELECT i, node, err, count(DISTINCT session_id)::int AS n FROM ne GROUP BY i, node, err),
     pg AS (SELECT DISTINCT session_id, path FROM seq),
     ex AS (SELECT s.session_id, s.path FROM seq s JOIN lst l ON l.session_id = s.session_id AND s.i = l.n),
     pe AS (SELECT DISTINCT session_id, path FROM se)
     SELECT 'total' AS kind, NULL::int AS i, NULL::text AS a, NULL::text AS b, count(*)::int AS n, NULL::int AS m, NULL::int AS en, NULL::int AS em FROM lst
     UNION ALL (SELECT 'link', a.i, a.node, b.node, count(*)::int, NULL, NULL, NULL FROM nd a
                  LEFT JOIN nd b ON b.session_id = a.session_id AND b.i = a.i + 1
                 WHERE a.i <= ${steps} GROUP BY a.i, a.node, b.node)
     UNION ALL (SELECT 'nerr', i, node, NULL, count(DISTINCT session_id)::int, count(DISTINCT CASE WHEN is_last THEN session_id END)::int, NULL, NULL
                  FROM ne GROUP BY i, node)
     UNION ALL (SELECT 'terr', i, node, err, n, NULL, NULL, NULL FROM (
                  SELECT i, node, err, n, row_number() OVER (PARTITION BY i, node ORDER BY n DESC, err) AS rk FROM te) x WHERE rk <= ${TOP_ERRORS})
     UNION ALL (SELECT 'exit', NULL, pg.path, NULL, count(ex.session_id)::int, count(*)::int, count(pe.session_id)::int,
                       count(CASE WHEN ex.session_id IS NOT NULL AND pe.session_id IS NOT NULL THEN 1 END)::int
                  FROM pg LEFT JOIN ex ON ex.session_id = pg.session_id AND ex.path = pg.path
                          LEFT JOIN pe ON pe.session_id = pg.session_id AND pe.path = pg.path
                 GROUP BY pg.path ORDER BY 5 DESC, 6 DESC LIMIT ${EXIT_PAGES})`,
    params,
  );
  return buildFlows(rows, start, steps);
}
