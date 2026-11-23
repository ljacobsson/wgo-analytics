import * as A from './analytics';
import * as F from './frustration';
import * as C from './cohorts';
import * as G from './goals';
import * as REL from './releases';
import * as EX from './explain';
import * as QY from './query';

type Q = Record<string, string | undefined>;
export type ProjectRoute = (pid: string, q: Q, rest: string[]) => Promise<unknown>;

/**
 * Read-only analytics routes under /api/projects/{pid}/... (dashboard, membership checked by the caller)
 * and /kiosk/v1/... (kiosk screens, project from the kiosk token).
 */
export const READ_ROUTES: Record<string, ProjectRoute> = {
  stats: (pid, q) => A.stats(pid, q),
  totals: (pid, q) => A.totalsFor(pid, q),
  clicks: (pid, q) => A.clicks(pid, q),
  frustration: (pid, q) => F.frustration(pid, q),
  heatmap: (pid, q) => F.heatmap(pid, q),
  pages: (pid, q) => A.pages(pid, q),
  errors: (pid, q) => A.errors(pid, q),
  'http-errors': (pid, q) => A.httpErrors(pid, q),
  breakdown: (pid, q) => A.breakdown(pid, q),
  vitals: (pid, q) => A.vitals(pid, q),
  geo: (pid, q) => A.geo(pid, q),
  fields: (pid, q, rest) => (rest[0] === 'values' ? A.fieldValues(pid, q) : A.fields(pid, q)),
  events: (pid, q) => A.events(pid, q),
  conversions: (pid, q) => G.conversions(pid, q),
  retention: (pid, q) => C.retention(pid, q),
  traces: (pid, q, rest) => (rest[0] ? A.trace(pid, rest[0], q) : A.traces(pid, q)),
  services: (pid, q) => A.services(pid, q),
  logs: (pid, q) => A.logs(pid, q),
  releases: (pid, q) => REL.releases(pid, q),
  explain: (pid, q) => EX.explain(pid, q),
  metrics: (pid, q, rest) => (rest[0] === 'series' ? A.metricSeries(pid, q) : A.metrics(pid, q)),
  query: (pid, q) => QY.query(pid, q),
  measures: (pid) => QY.measureNames(pid),
};
