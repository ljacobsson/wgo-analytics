import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import * as A from '../analytics';
import * as CA from '../clickAliases';
import * as G from '../goals';
import * as GF from '../funnel';
import { HttpError } from '../http';
import * as P from '../projects';

/**
 * WGO's MCP tools: read-only views over the same queries the dashboard uses, plus naming click targets (aliases),
 * which any project member can also do in the dashboard. Every tool that takes a `projectId` checks membership for
 * the signed-in user first, exactly like /api/projects/{pid}/*.
 */

type Q = Record<string, string | undefined>;

const INSTRUCTIONS = `WGO ("What's going on?") is a product analytics and observability backend.
Browser data (pageviews, clicks, JavaScript errors, failed HTTP requests, Web Vitals, custom events) and
OpenTelemetry traces, logs and metrics are stored per project.

Call list_projects first to get project ids. Every other tool takes a projectId.
Time windows: pass \`range\` (e.g. "15m", "1h", "24h", "7d", max "92d") or ISO-8601 \`from\`/\`to\`. Without
either, product analytics tools cover the last 24 hours and trace/log tools the last hour.
Raw data is kept per project (default 14 days). Overview stats, top pages and breakdowns over longer windows
come from hourly aggregates (sessions/users are estimates, about ±2%); other tools only see the raw data.
Start broad (get_overview, list_errors, list_failed_requests, list_services) and drill down
(search_events with a fingerprint or sessionId, get_trace, search_logs with a traceId).
Clicks are captured automatically with a CSS selector. When a selector is hard to read, give it an alias with
set_click_alias (the dashboard and top_clicks then show the alias); it changes labels only, never data.`;

const RANGE_RE = /^(\d+)\s*(m|h|d)$/i;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

const projectId = z.string().describe('Project id (UUID) from list_projects');
const windowShape = {
  range: z
    .string()
    .regex(RANGE_RE, 'Use a number followed by m, h or d, e.g. "24h"')
    .optional()
    .describe('Relative window ending now (or at `to`), e.g. "1h", "24h", "7d". Ignored when `from` is set.'),
  from: z.string().optional().describe('Window start, ISO-8601'),
  to: z.string().optional().describe('Window end, ISO-8601 (default: now)'),
};
const limit = (def: number, max: number) => z.number().int().min(1).max(max).optional().describe(`Max rows (default ${def}, max ${max})`);

/** Turns the shared window arguments into the `from`/`to` query params the analytics layer parses. */
export function windowParams(args: { range?: string; from?: string; to?: string }): Q {
  const q: Q = { from: args.from, to: args.to };
  const m = args.range?.match(RANGE_RE);
  if (m && !args.from) {
    const to = args.to ? new Date(args.to) : new Date();
    if (Number.isNaN(to.getTime())) throw new HttpError(400, 'Invalid `to`');
    q.from = new Date(to.getTime() - Number(m[1]) * UNIT_MS[m[2].toLowerCase() as keyof typeof UNIT_MS]).toISOString();
    q.to = to.toISOString();
  }
  return q;
}

const str = (v: number | boolean | undefined) => (v === undefined ? undefined : String(v));

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(err: unknown): CallToolResult {
  if (!(err instanceof HttpError)) console.error(err);
  const message = err instanceof HttpError ? err.message : 'Internal error';
  return { content: [{ type: 'text', text: message }], isError: true };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Changes a label shared with the project's members; setting the same value twice changes nothing more. */
const LABEL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** A fresh server for one request, acting as `email`. */
export function buildMcpServer(email: string): McpServer {
  const server = new McpServer({ name: 'wgo', title: 'WGO analytics', version: '1.0.0' }, { instructions: INSTRUCTIONS });

  /** Registers a tool (read-only unless `hints` say otherwise) whose handler runs after the project membership check. */
  const projectTool = <S extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    shape: S,
    run: (pid: string, args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
    hints: typeof READ_ONLY | typeof LABEL_WRITE = READ_ONLY,
  ) => {
    const inputSchema = z.object({ projectId, ...shape });
    server.registerTool(name, { title, description, inputSchema, annotations: { title, ...hints } }, (async (args: { projectId: string }) => {
      try {
        const project = await P.getProject(email, args.projectId); // 404 unless the user is a member
        return ok(await run(project.id, args as unknown as z.infer<z.ZodObject<S>>));
      } catch (err) {
        return fail(err);
      }
    }) as never);
  };

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'Projects you are a member of, with your role and the write key used by the SDK snippet and OTLP exporters.',
      inputSchema: z.object({}),
      annotations: { title: 'List projects', ...READ_ONLY },
    },
    async () => {
      try {
        const projects = await P.listProjects(email);
        return ok({ email, projects: projects.map(({ id, name, role, writeKey, createdAt }) => ({ id, name, role, writeKey, createdAt })) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  projectTool(
    'get_overview',
    'Traffic overview',
    'Totals (events, pageviews, clicks, errors, failed requests, sessions, users) for the window and the same-length window before it, plus a time series.',
    windowShape,
    (pid, a) => A.stats(pid, windowParams(a)),
  );

  projectTool(
    'top_clicks',
    'Top clicked elements',
    'Most clicked elements with their alias (set_click_alias), tracked name (data-track), selector, text and tag.',
    { ...windowShape, limit: limit(50, 200) },
    (pid, a) => A.clicks(pid, { ...windowParams(a), limit: str(a.limit) }),
  );

  projectTool(
    'list_click_aliases',
    'Click aliases',
    'The readable names the project gave its click selectors, with who set each one and when.',
    {},
    (pid) => CA.listAliases(pid),
  );

  projectTool(
    'set_click_alias',
    'Name a click target',
    'Gives an autocaptured click selector a readable name (alias) that the dashboard and top_clicks show instead of its text or selector, shared with all project members. Use the exact selector from top_clicks or search_events. Pass an empty alias to remove it. Changes labels only, never the recorded clicks.',
    {
      selector: z.string().min(1).max(512).describe('Exact CSS selector as captured, from top_clicks or search_events'),
      alias: z.string().max(80).describe('Readable name, 1-80 characters, e.g. "Pricing: start trial button". Empty string removes the alias.'),
    },
    async (pid, a) => {
      if (!a.alias.trim()) {
        await CA.deleteAlias(pid, a.selector);
        return { selector: a.selector.trim(), alias: null };
      }
      return CA.setAlias(pid, email, { selector: a.selector, alias: a.alias });
    },
    LABEL_WRITE,
  );

  projectTool(
    'top_pages',
    'Top pages',
    'Most viewed pages (paths) with views and sessions.',
    { ...windowShape, limit: limit(50, 200) },
    (pid, a) => A.pages(pid, { ...windowParams(a), limit: str(a.limit) }),
  );

  projectTool(
    'list_errors',
    'JavaScript errors',
    'Browser JavaScript errors grouped by fingerprint: message, kind, source, count, affected sessions, first/last seen and a sparkline. Pass a fingerprint to search_events for individual occurrences with stack traces.',
    { ...windowShape, limit: limit(50, 200) },
    (pid, a) => A.errors(pid, { ...windowParams(a), limit: str(a.limit ?? 50) }),
  );

  projectTool(
    'list_failed_requests',
    'Failed HTTP requests',
    'Failed fetch/XHR calls made by the browser, grouped by method, normalized route and status (0 = network failure).',
    { ...windowShape, limit: limit(50, 200) },
    (pid, a) => A.httpErrors(pid, { ...windowParams(a), limit: str(a.limit ?? 50) }),
  );

  projectTool(
    'goal_conversions',
    'Conversion goals',
    'The project\'s conversion goals (events matching filters, e.g. a pageview of /thank-you or a custom checkout event) with conversions, converting sessions and users, and each goal\'s conversion rate: converting sessions / all sessions in the window. Use goal_funnel to see how sessions reach a goal. Only covers raw data (the project\'s retention).',
    windowShape,
    async (pid, a) => {
      const c = await G.conversions(pid, { ...windowParams(a), series: '0' });
      return { ...c, goals: c.goals.map(({ series: _s, ...g }) => ({ ...g, rate: c.sessions ? g.sessions / c.sessions : null })) };
    },
  );

  projectTool(
    'goal_funnel',
    'Goal funnel and drivers',
    'How sessions reach one conversion goal (id from goal_conversions): the goal\'s funnel steps counted in order with the median time between them and where sessions that stopped left; the segments (entry page, pages viewed or errors hit before converting, traffic source, device, browser, country) that convert clearly better (`best`) or worse (`worst`) than average, with their rate, lift and extra or missed conversions; and the most common first-page journeys with their conversion rate. Only covers raw data (the project\'s retention).',
    { ...windowShape, goalId: z.string().describe('Goal id from goal_conversions') },
    async (pid, a) => {
      const { dims: _d, ...f } = await GF.goalFunnel(pid, String(a.goalId), windowParams(a));
      return f;
    },
  );

  projectTool(
    'breakdown',
    'Sessions by dimension',
    'Top 12 values of one dimension by distinct sessions.',
    { ...windowShape, dim: z.enum(['browser', 'os', 'device', 'referrer', 'country', 'city']).describe('Dimension to group by') },
    (pid, a) => A.breakdown(pid, { ...windowParams(a), dim: a.dim }),
  );

  projectTool(
    'web_vitals',
    'Web Vitals',
    'Core Web Vitals percentiles (LCP, INP, CLS, FCP, TTFB) for the window.',
    windowShape,
    (pid, a) => A.vitals(pid, windowParams(a)),
  );

  projectTool(
    'visitor_locations',
    'Visitor locations',
    'Sessions by country, and the busiest ~11 km map cells (top 100). Locations are approximate (CloudFront IP geolocation); IPs are never stored.',
    windowShape,
    async (pid, a) => {
      const g = await A.geo(pid, windowParams(a));
      return { ...g, points: g.points.slice(0, 100) };
    },
  );

  projectTool(
    'search_events',
    'Search raw events',
    'Individual browser events, newest first. Filter by type, free text (path, selector, element text, tracked name, error message, request URL, event name, user id), session or error fingerprint. Page with `before` = the returned nextBefore.',
    {
      ...windowShape,
      type: z.enum(['pageview', 'click', 'error', 'http_error', 'custom', 'vitals', 'identify']).optional(),
      q: z.string().max(200).optional().describe('Case-insensitive substring'),
      sessionId: z.string().optional(),
      fingerprint: z.string().optional().describe('Error fingerprint from list_errors'),
      before: z.string().optional().describe('Only events before this ISO-8601 time (pagination cursor)'),
      limit: limit(50, 200),
    },
    (pid, a) => {
      // the events query has no implicit window: only bound it when the caller asked for one
      const w = a.range || a.from || a.to ? windowParams(a) : {};
      return A.events(pid, { ...w, type: a.type, q: a.q, sessionId: a.sessionId, fingerprint: a.fingerprint, before: a.before, limit: str(a.limit ?? 50) });
    },
  );

  projectTool(
    'list_services',
    'OpenTelemetry services',
    'Services that sent spans, with span and error counts and latency.',
    windowShape,
    (pid, a) => A.services(pid, windowParams(a)),
  );

  projectTool(
    'list_traces',
    'Search traces',
    'Traces with root span name, services, duration, span and error counts, newest first. Default window: last hour.',
    {
      ...windowShape,
      service: z.string().optional().describe('Only traces touching this service'),
      minDurationMs: z.number().min(0).optional(),
      errorsOnly: z.boolean().optional(),
      q: z.string().max(200).optional().describe('Span name substring, or an exact trace id'),
      limit: limit(50, 200),
    },
    (pid, a) =>
      A.traces(pid, {
        ...windowParams(a), service: a.service, minDurationMs: str(a.minDurationMs), errorsOnly: a.errorsOnly ? '1' : undefined, q: a.q, limit: str(a.limit ?? 50),
      }),
  );

  projectTool(
    'get_trace',
    'Get trace',
    'All spans of one trace, sorted by start time, with attributes, events and status.',
    { traceId: z.string().regex(/^[0-9a-fA-F]{32}$/, 'A trace id is 32 hex characters') },
    (pid, a) => A.trace(pid, a.traceId.toLowerCase()),
  );

  projectTool(
    'search_logs',
    'Search logs',
    'OpenTelemetry log records, newest first. Default window: last hour. Page with `before` = the returned nextBefore.',
    {
      ...windowShape,
      minSeverity: z
        .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
        .optional()
        .describe('Only records at or above this severity'),
      service: z.string().optional(),
      traceId: z.string().optional(),
      q: z.string().max(200).optional().describe('Case-insensitive substring of the log body'),
      before: z.string().optional().describe('Only records before this ISO-8601 time (pagination cursor)'),
      limit: limit(100, 500),
    },
    (pid, a) =>
      A.logs(pid, {
        ...windowParams(a),
        severity: a.minSeverity ? String(SEVERITY[a.minSeverity]) : undefined,
        service: a.service, traceId: a.traceId, q: a.q, before: a.before, limit: str(a.limit ?? 100),
      }),
  );

  projectTool(
    'list_metrics',
    'List metrics',
    'OpenTelemetry metric names with type, unit, service, point count and last seen time.',
    windowShape,
    (pid, a) => A.metrics(pid, windowParams(a)),
  );

  projectTool(
    'get_metric_series',
    'Metric time series',
    'Aggregated time series of one metric, optionally split by an attribute (top 10 series). Histograms aggregate their per-point mean. Cumulative sums are stored as reported: use max or avg, not sum.',
    {
      ...windowShape,
      name: z.string().min(1).describe('Metric name from list_metrics'),
      agg: z.enum(['avg', 'sum', 'min', 'max', 'p95']).optional().describe('Default avg'),
      groupBy: z.string().optional().describe('Attribute key to split by'),
    },
    (pid, a) => A.metricSeries(pid, { ...windowParams(a), name: a.name, agg: a.agg, groupBy: a.groupBy }),
  );

  return server;
}

/** Lowest OTLP severityNumber of each level. */
const SEVERITY = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 } as const;
