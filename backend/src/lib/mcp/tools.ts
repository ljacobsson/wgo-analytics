import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import * as A from '../analytics';
import * as EX from '../explain';
import * as REL from '../releases';
import * as CA from '../clickAliases';
import * as FR from '../frustration';
import * as C from '../cohorts';
import * as G from '../goals';
import * as GF from '../funnel';
import { HttpError } from '../http';
import * as P from '../projects';
import { BEHAVIOR_ACTIONS, findRecordings } from '../recordingSearch';
import * as U from '../uptime';

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
When a number moved ("why are errors up?", "why did signups drop?"), call explain_change first: it says which
segments account for the change, when it started and which release went out just before. list_releases compares
each version with the one before it. A failed browser request links to the backend trace it started (sampleTraceId
in list_failed_requests), and get_trace shows the page and visitor that sent it.
Session recordings (when the project records them): find_recordings finds them by what visitors did or didn't
do, e.g. hovered an element but never clicked it, or reached /pricing but never /signup, and links to each one.
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

const behavior = z.object({
  action: z.enum(BEHAVIOR_ACTIONS as [string, ...string[]]).describe(
    'hover: the mouse rested on a clickable element, image or field for 300 ms or more (recordings only; not on touch devices). click, rage_click (3+ quick clicks on the same element), pageview, event (custom event), error (JavaScript error or failed request).',
  ),
  target: z.string().max(200).optional().describe(
    'Case-insensitive. hover/click/rage_click: part of the visible label, tracked name, click alias or CSS selector, e.g. "buy" or an exact selector from top_clicks. pageview: a path, "*" as wildcard ("/checkout*"), otherwise a substring. event: part of the event name. error: part of the message or failed request URL. Omit to match any.',
  ),
  minMs: z.number().int().min(0).optional().describe('hover only: lasted at least this long, e.g. 2000 for a long hesitation'),
  notClicked: z.boolean().optional().describe('hover only, in `did`: the visitor never clicked the element they hovered during the recording'),
});

/** A fresh server for one request, acting as `email`. `origin`: the dashboard's, for links to its pages. */
export function buildMcpServer(email: string, origin?: string): McpServer {
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
    'list_frustration',
    'Frustrating click targets',
    'Click targets where visitors got stuck, most frustrating first: rage clicks (3+ quick clicks), dead clicks (nothing changed within 1 s) and error clicks (a JavaScript error or failed request within 2 s), each with the number of sessions, plus up to 3 recorded sessions to watch (sessionId and epoch ms).',
    { ...windowShape, limit: limit(50, 200) },
    (pid, a) => FR.frustration(pid, { ...windowParams(a), limit: str(a.limit) }),
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
    'Gives an autocaptured click selector a readable name (alias) that the dashboard and top_clicks show instead of its text or selector, shared with all project members. The alias covers every click on that selector whatever the element said (e.g. a buy button showing each product\'s price), and top_clicks then counts them as one row. Use the exact selector from top_clicks or search_events. Pass an empty alias to remove it. Changes labels and grouping only, never the recorded clicks.',
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
    'Browser JavaScript errors grouped by fingerprint: message, kind, source, sample stack (original source locations when source maps are uploaded; minifiedStack is the raw one), count, affected sessions, first/last seen and a sparkline. Pass a fingerprint to search_events for individual occurrences with stack traces.',
    { ...windowShape, limit: limit(50, 200) },
    async (pid, a) => (await A.errors(pid, { ...windowParams(a), limit: str(a.limit ?? 50) })).map(({ stackFrames: _frames, ...g }) => g), // sampleStack is symbolicated when source maps are uploaded
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
    'get_retention',
    'Retention cohorts',
    'Retention: people grouped by the day, week or month they were first seen (or first reached a conversion goal) and the share of each group that came back in each later period, with a size-weighted average and optionally the top 5 values of a split (device, country, source). Built each night from per-visitor daily rows kept 400 days, so it reaches back much further than raw events (default window 12 weeks, max 400 days). `dataSince` tells how far back the data goes. Goal ids come from goal_conversions.',
    {
      ...windowShape,
      period: z.enum(['day', 'week', 'month']).optional().describe('Cohort period (default week)'),
      start: z.string().optional().describe('"first_seen" (default) or "goal:<goalId>": what puts a person in a cohort'),
      return: z.string().optional().describe('"any" (default) or "goal:<goalId>": what counts as coming back'),
      split: z.enum(['none', 'device', 'country', 'source']).optional().describe('Split the average by this dimension (default none)'),
    },
    (pid, a) => C.retention(pid, { ...windowParams(a), period: a.period, start: a.start, return: a.return, split: a.split }),
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
    'find_recordings',
    'Find session recordings',
    'Session recordings, newest first, where the visitor did everything in `did` and nothing in `didNot` (all over the recording\'s time span). Translate a request into conditions, e.g. "hovered the buy button but never clicked it" = did [{action: "hover", target: "buy", notClicked: true}]; "saw pricing but never signed up" = did [{action: "pageview", target: "/pricing*"}], didNot [{action: "pageview", target: "/signup*"}]. With no conditions, lists recent recordings. Each result has the visitor, device, pages, counts, `moments` (when each `did` condition first happened, `offsetMs` into the recording) and a `link` that plays it from the first moment. `scanned` recordings were looked at; when `nextBefore` is set, pass it as `before` to look further back. A matching recording needs at least 3 seconds of data. Hovers exist only in recordings made with an SDK that records them; notClicked relies on click autocapture being on.',
    {
      ...windowShape,
      did: z.array(behavior).max(5).optional().describe('Everything that must have happened'),
      didNot: z.array(behavior).max(5).optional().describe('Nothing of this may have happened'),
      device: z.enum(['desktop', 'mobile', 'tablet']).optional(),
      minDurationSeconds: z.number().min(0).optional(),
      identifiedOnly: z.boolean().optional().describe('Only visitors with a user id'),
      before: z.string().optional().describe('Pagination cursor: nextBefore of the previous call'),
      limit: limit(20, 100),
    },
    async (pid, a) => {
      const w = a.range || a.from || a.to ? windowParams(a) : {};
      const res = await findRecordings(pid, {
        did: a.did as never, didNot: a.didNot as never, from: w.from, to: w.to, before: a.before, limit: a.limit,
        filters: { device: a.device, minDuration: str(a.minDurationSeconds), identified: a.identifiedOnly ? '1' : undefined },
      });
      return {
        ...res,
        recordings: res.recordings.map((r) => {
          const first = r.moments.map((m) => new Date(m.at).getTime()).sort((x, y) => x - y)[0];
          const path = `/p/${pid}/recordings/${encodeURIComponent(r.sessionId)}${first ? `?t=${first}` : ''}`;
          return { ...r, link: origin ? `${origin}/#${path}` : `#${path}` };
        }),
      };
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
    'All spans of one trace, sorted by start time, with attributes, events and status. When a failed browser request started it (the WGO SDK sends a traceparent), `browser` has that request with its page, visitor and session id, and its root span has service "browser". Failed requests in list_failed_requests carry sampleTraceId; search_events http_error events carry props.trace.',
    { traceId: z.string().regex(/^[0-9a-fA-F]{32}$/, 'A trace id is 32 hex characters') },
    (pid, a) => A.trace(pid, a.traceId.toLowerCase()),
  );

  projectTool(
    'explain_change',
    'Explain a change',
    'Why a number changed between a window and a baseline (default: the same-length window right before it). Compares event counts (metric "events", filtered by `where`, e.g. type = error), sessions with such an event ("sessions") or a goal\'s conversion rate ("goal" with goalId), and returns: the change and whether it is beyond noise, the segments (page, browser, OS, device, country, release, error message, failing request; for goals also entry page and source) that account for it beyond growing in line with the rest, when it started (if a clear change point exists in the window) and a release first seen around then, plus a one-paragraph summary. Start here when asked "why are errors up?" or "why did signups drop?".',
    {
      ...windowShape,
      metric: z.enum(['events', 'sessions', 'goal']).describe('events: count of events matching `where`; sessions: sessions with such an event; goal: conversion rate of goalId'),
      where: z.array(z.object({ field: z.string(), op: z.string(), value: z.union([z.string(), z.number()]).optional() })).max(10).optional()
        .describe('Event filters for events/sessions, e.g. [{"field":"type","op":"eq","value":"error"}] or [{"field":"httpRoute","op":"eq","value":"/api/checkout"}]. Fields as in search_events; ops: eq, neq, contains, starts_with, gt, gte, lt, lte, set, not_set'),
      goalId: z.string().optional().describe('For metric "goal": a goal id from list_goals'),
      baseFrom: z.string().optional().describe('Baseline start, ISO-8601 (default: the window before)'),
      baseTo: z.string().optional().describe('Baseline end, ISO-8601'),
    },
    (pid, a) => EX.explain(pid, { ...windowParams(a), metric: a.metric, where: a.where ? JSON.stringify(a.where) : undefined, goalId: a.goalId, baseFrom: a.baseFrom, baseTo: a.baseTo }),
  );

  projectTool(
    'list_releases',
    'Releases and their health',
    'Versions running in the window: web releases (the SDK\'s `release` option) with sessions, share of sessions with JavaScript errors or failed requests, p75 LCP/INP/CLS, conversion rate per goal and error groups first seen in that release; and service versions (OpenTelemetry service.version) with error rate and p50/p95. Each is compared with the version before it: verdicts are "worse"/"better" only when the difference is clearly beyond noise. `markers` are versions first seen in the window (deploys). Default window: 7 days.',
    windowShape,
    (pid, a) => REL.releases(pid, windowParams(a)),
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

  projectTool(
    'list_uptime_checks',
    'Uptime checks',
    'The project\'s uptime checks (URLs WGO fetches on a schedule) with current state (up, down or null before the first result), since when, uptime over the window (default last 24 hours) and the last error.',
    windowShape,
    (pid, a) => {
      const q = windowParams(a);
      return U.summary(pid, U.parseWindow({ from: q.from, to: q.to }));
    },
  );

  return server;
}

/** Lowest OTLP severityNumber of each level. */
const SEVERITY = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 } as const;
