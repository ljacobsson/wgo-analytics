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
import * as SV from '../surveys';
import * as FL from '../flows';
import { SLACK_TEMPLATE_VARIABLES, TRIGGER_WINDOWS, type Dashboard, type Project, type Trigger } from '../../contract';
import { OPS } from '../filters';
import * as M from '../monitor';
import * as DST from '../destinations';
import * as S from '../slack';
import * as T from '../triggers';
import { HttpError } from '../http';
import * as P from '../projects';
import { BEHAVIOR_ACTIONS, findRecordings } from '../recordingSearch';
import * as U from '../uptime';
import * as QRY from '../query';
import * as D from '../dashboards';
import * as FX from '../fixes';
import { randomUUID } from 'node:crypto';
import { normalizeMapFile, normalizeRelease, UPLOAD_URL_TTL_SECONDS, uploadUrl } from '../sourcemaps';

/**
 * WGO's MCP tools: read-only views over the same queries the dashboard uses, plus naming click targets (aliases),
 * defining conversion goals and triggers (alerts) and creating a project, which any member can also do in the dashboard. Every tool that takes a `projectId` checks
 * membership for the signed-in user first, exactly like /api/projects/{pid}/*.
 */

type Q = Record<string, string | undefined>;

const INSTRUCTIONS = `WGO ("What's going on?") is a product analytics and observability backend.
Browser data (pageviews, clicks, JavaScript errors, failed HTTP requests, Web Vitals, custom events) and
OpenTelemetry traces, logs and metrics are stored per project.

Call list_projects first to get project ids. Every other tool takes a projectId.
To start tracking a site or app, call create_project (unless list_projects already has a project for it) and
add the returned snippet to the site's HTML <head>; get_install_snippet gives the snippet of an existing project.
Time windows: pass \`range\` (e.g. "15m", "1h", "24h", "7d", max "92d") or ISO-8601 \`from\`/\`to\`. Without
either, product analytics tools cover the last 24 hours and trace/log tools the last hour.
Raw data is kept per project (default 14 days). Overview stats, top pages and breakdowns over longer windows
come from hourly aggregates (sessions/users are estimates, about ±2%); other tools only see the raw data.
Start broad (get_overview, list_errors, list_failed_requests, list_services) and drill down
(search_events with a fingerprint or sessionId, get_trace, search_logs with a traceId).
An error group or error event with missingSourcemaps has a minified stack: no source map was uploaded for those
scripts. When you have the app's source (e.g. Claude Code in its repository), offer to fix that with upload_sourcemaps.
When a number moved ("why are errors up?", "why did signups drop?"), call explain_change first: it says which
segments account for the change, when it started and which release went out just before. list_releases compares
each version with the one before it. A failed browser request links to the backend trace it started (sampleTraceId
in list_failed_requests), and get_trace shows the page and visitor that sent it.
Session recordings (when the project records them): find_recordings finds them by what visitors did or didn't
do, e.g. hovered an element but never clicked it, or reached /pricing but never /signup, and links to each one.
Clicks are captured automatically with a CSS selector. When a selector is hard to read, give it an alias with
set_click_alias (the dashboard and top_clicks then show the alias); it changes labels only, never data.
Conversion goals: list_goals shows each goal's definition. To track a new conversion (a signup, a purchase, a
click on a button), call create_goal with event filters; check them first with search_events (same fields), e.g.
that a /thank-you pageview or a "checkout_completed" custom event actually occurs. Goals count from raw events, so
a new goal immediately covers the project's retention. update_goal changes one, delete_goal removes it.
Surveys: short questionnaires shown to visitors on the site (a popover card or inline in the page) to collect
feedback, ratings or NPS. list_surveys shows them, create_survey defines one (it starts as a draft), update_survey
changes it, delete_survey removes it. Status 'active' shows a survey on the site through the already-installed WGO
script, with no code change; 'paused' and 'draft' hide it. survey_results has the answers per question, the response
rate and the latest responses. Answers are kept until the survey is deleted.
Triggers (alerts) notify a webhook or a connected Slack channel: on every new matching event, log or span
(kind "match"), when a number over a window crosses a value ("threshold"), or when it's unusual for the time of
day ("anomaly"). list_triggers shows them and the Slack channels you can send to; preview_trigger shows what a
threshold/anomaly trigger would see right now; create_trigger saves one; test_trigger sends a sample notification.
A trigger can design its own Slack message (slackTemplate: Block Kit blocks with {{variables}}).
Any number across all of it (web events, Web Vitals, goals, spans, logs, OpenTelemetry metrics, uptime checks), as a
total, over time or split by a field: query_measures. To keep a set of them in view, build a custom dashboard:
create_dashboard with tiles (each tile is a query_measures measure plus how to show it), add_dashboard_tile to an
existing one (list_dashboards). Dashboards are shared with every project member.
When the install has the GitHub Agent and a project turned it on, start_fix_run asks it to fix one error group: it opens
a draft pull request on the project's GitHub repository for a person to review. list_fix_runs shows how runs went.`;

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
/** Adds something new; calling it twice adds two. */
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
/** Changes a label or definition shared with the project's members (never recorded data); setting the same value twice changes nothing more. */
const LABEL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Removes something members set up (never recorded data). */
const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
/** Hands out upload URLs; uploading a map again under the same name replaces it with the same content. */
const UPLOAD = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Saves a trigger, which sends notifications to a webhook or Slack: open world. */
const TRIGGER_CREATE = { ...CREATE, openWorldHint: true } as const;
const TRIGGER_WRITE = { ...LABEL_WRITE, openWorldHint: true } as const;
/** Sends a sample notification now. */
const SEND = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
type Hints = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };

const EVENT_FIELDS = 'A built-in event field: type (pageview, click, error, http_error, custom, vitals, identify), path, url, title, referrer, selector, elementText, elementTag, trackName (data-track), name (custom event name), errorMessage, httpRoute, httpStatus, userId, browser, os, device, country…; or props.<path> for event properties, e.g. props.props.plan for a custom event\'s `plan`';
/** A filter as in the dashboard's filter bar and the API; `field` describes the fields of its scope. */
const filterOf = (field: string) => z.object({
  field: z.string().min(1).max(200).describe(field),
  op: z.enum(OPS as [string, ...string[]]).describe('eq/neq exact; contains/not_contains/starts_with/ends_with case-insensitive; gt/gte/lt/lte; set/not_set need no value'),
  value: z.union([z.string().max(500), z.number()]).optional(),
});
const eventFilter = filterOf(EVENT_FIELDS);
const anyFilter = filterOf(
  `events scope: ${EVENT_FIELDS}. logs scope: body, service, severityText, severityNumber (17+ = error), traceId, attributes.<key>, resource.<key>. spans scope: name, service, durationMs, statusCode (2 = error), statusMessage, kind, traceId, attributes.<key> (e.g. attributes.http.route), resource.<key>`,
);

const slackTemplate = z.object({
  blocks: z.array(z.record(z.string(), z.unknown())).min(1).max(50).describe(
    `Slack Block Kit blocks (header, section, context, divider, actions, image, rich_text), as in Slack's Block Kit Builder. Any string may contain {{variables}}: ${SLACK_TEMPLATE_VARIABLES.map((v) => `${v.name} (${v.description}${v.kinds ? `; ${v.kinds.join('/')} triggers` : ''})`).join('; ')}. Values are escaped in mrkdwn text; {{summary}} and {{matches_list}} keep their bold and bullets. Blocks whose text comes out empty are left out. If Slack rejects the blocks, the default message is sent and the status says so: check with test_trigger.`,
  ),
}).describe('A Slack message design');

const triggerShape = {
  name: z.string().min(1).max(120).describe('Trigger name, 1-120 characters'),
  filters: z.array(anyFilter).max(20).describe('Rows to watch, all filters must match. At least one for match triggers; threshold/anomaly may pass [] to watch every row of the scope'),
  destination: z.union([
    z.object({ type: z.literal('webhook'), url: z.string().url().describe('Public https URL. hooks.slack.com URLs get a Slack-formatted message; others get JSON signed with X-WGO-Signature (HMAC-SHA256 with signingSecret)') }),
    z.object({ type: z.literal('slack'), integrationId: z.string().describe('A Slack channel id from list_triggers.slackChannels') }),
    z.object({ type: z.literal('saved'), destinationId: z.string().describe('A saved destination id from list_triggers.destinations (or use its `ref`)') }),
  ]).describe('Prefer a saved destination from list_triggers.destinations (pass its `ref`); a one-off webhook URL otherwise'),
  cooldownSeconds: z.number().int().min(0).max(86400).optional().describe('Least time between notifications (default 300). Matches in between are counted and reported with the next one'),
  enabled: z.boolean().optional().describe('Default true; false pauses it'),
  metric: z.object({
    agg: z.enum(['count', 'sessions', 'session_rate', 'avg', 'p75', 'p95']).describe('count of matching rows; sessions with a match; session_rate: share (0..1) of all sessions with a match (events only); avg/p75/p95 of `field`'),
    field: z.string().optional().describe('Numeric field for avg/p75/p95, e.g. durationMs or props.lcp'),
  }).optional().describe('threshold/anomaly only'),
  condition: z.union([
    z.object({ op: z.enum(['above', 'below']), value: z.number() }),
    z.object({ direction: z.enum(['up', 'down', 'either']), sensitivity: z.enum(['low', 'medium', 'high']) }),
  ]).optional().describe('threshold: {op, value}, e.g. {op: "below", value: 1} = nothing arrived. anomaly: {direction, sensitivity}'),
  windowMinutes: z.number().int().optional().describe(`threshold/anomaly only: one of ${TRIGGER_WINDOWS.join(', ')}`),
  slackTemplate: slackTemplate.nullable().optional().describe('Its own Slack message, used when it notifies Slack; omit (or null) for the default message'),
};
const triggerScope = z.enum(['events', 'logs', 'spans']).optional().describe('What it watches (default events): product events, OpenTelemetry logs or spans');
const triggerKind = z.enum(['match', 'threshold', 'anomaly']).optional().describe('Default match');

/** Only one-off webhook triggers sign with their own secret (saved webhooks use the destination's), so only they show it. */
const publicTrigger = ({ signingSecret, ...t }: Trigger) => (t.destination.type === 'webhook' ? { ...t, signingSecret } : t);
const surveyQuestion = z.object({
  type: z.enum(['single', 'multi', 'text', 'yesno', 'rating', 'nps']).describe('single: pick one option; multi: pick several; text: free answer; yesno; rating: 1 to `scale`; nps: 0-10'),
  title: z.string().min(1).max(300).describe('The question, 1-300 characters'),
  description: z.string().max(500).optional(),
  required: z.boolean().optional().describe('Default false'),
  options: z.array(z.string().min(1).max(200)).min(2).max(SV.MAX_OPTIONS).optional().describe('single/multi: 2-20 distinct options'),
  long: z.boolean().optional().describe('text: a multi-line answer'),
  placeholder: z.string().max(200).optional().describe('text'),
  scale: z.union([z.literal(5), z.literal(10)]).optional().describe('rating: 5 (default) or 10'),
  lowLabel: z.string().max(60).optional().describe('rating/nps: label under the lowest value'),
  highLabel: z.string().max(60).optional().describe('rating/nps: label under the highest value'),
  id: z.string().max(40).optional().describe('Stable id answers are kept under (letters, digits, _ -); default q1, q2, ...'),
});
const surveyShape = {
  name: z.string().min(1).max(120).describe('Survey name, 1-120 characters, internal (visitors do not see it)'),
  questions: z.array(surveyQuestion).min(1).max(SV.MAX_QUESTIONS).describe('The questions, in order'),
  display: z.object({
    mode: z.enum(['popover', 'inline']).default('popover').describe('popover: a floating card; inline: rendered inside the element matching `selector`'),
    selector: z.string().max(300).optional().describe('inline: CSS selector of an element on the page, e.g. "#feedback"'),
    position: z.enum(['bottom-right', 'bottom-left']).optional().describe('popover (default bottom-right)'),
    layout: z.enum(['steps', 'form']).optional().describe('steps: one question at a time (default for popover); form: all on one page (default for inline)'),
    theme: z.enum(['auto', 'light', 'dark']).optional().describe('auto (default) follows the visitor\'s colour scheme'),
    accent: z.string().optional().describe('Button and selection colour, #rrggbb'),
    submitLabel: z.string().max(40).optional().describe('Default "Submit"'),
    thankYou: z.string().max(300).optional().describe('Shown after submitting, default "Thanks for your feedback!"'),
  }).optional().describe('How it looks (default: a popover)'),
  targeting: z.object({
    paths: z.array(z.string().max(200)).max(20).optional().describe('Page path globs starting with /, e.g. "/pricing", "/docs/*"; none = every page'),
    delaySec: z.number().int().min(0).max(3600).optional().describe('Show after this many seconds on the page'),
    scrollPct: z.number().int().min(1).max(100).optional().describe('...and once the visitor scrolled this far down'),
    event: z.string().max(200).optional().describe('...only after the page tracked this custom event (WGO.track name)'),
    frequency: z.enum(['once', 'until_answered', 'always']).optional().describe('once (default): never again after answered or closed; until_answered: comes back next session if closed; always: on every matching page view'),
  }).optional().describe('Where and when it shows (default: every page, once)'),
  status: z.enum(['draft', 'active', 'paused']).optional().describe('Default draft; only active surveys are shown'),
};
const goalFilters = z.array(eventFilter).min(1).max(20);
const goalSteps = z.array(z.object({ name: z.string().min(1).max(80), filters: goalFilters })).max(G.MAX_STEPS);

const MAX_MEASURES = QRY.MAX_MEASURES;
const sourceFilter = z.object({
  field: z.string().min(1).max(200).describe('A field of the measure\'s source (see query_measures)'),
  op: z.enum(OPS as [string, ...string[]]),
  value: z.union([z.string().max(500), z.number()]).optional(),
});
const measureQuery = z.object({
  source: z.enum(['events', 'logs', 'spans', 'metrics', 'checks']),
  agg: z.enum(['count', 'sessions', 'users', 'session_rate', 'sum', 'avg', 'min', 'max', 'p50', 'p75', 'p95', 'p99', 'rate']),
  field: z.string().max(200).optional().describe('Numeric field for sum/avg/min/max/p50-p99 and rate (metrics default to value, checks to durationMs / ok)'),
  metric: z.string().max(200).optional().describe('Metrics source: the OpenTelemetry metric name (required), see list_measure_names'),
  filters: z.array(sourceFilter).max(20).optional().describe('ANDed, in the fields of the source'),
});
const tileRange = z.enum(['15m', '1h', '24h', '7d', '30d']);
const tileInput = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional().describe('1-40 letters, digits, - or _ (default: generated)'),
  viz: z.enum(['number', 'line', 'area', 'bars', 'top', 'table', 'text', 'columns', 'pie', 'scatter']).describe('number: one big total; line/area/bars: over time; top: biggest values of groupBy; table: one row per groupBy value, a column per measure; text: a note. SQL tiles only: columns (bars per category), pie (shares, up to 6 slices), scatter (a numeric column against another)'),
  measures: z.array(measureQuery.extend({
    label: z.string().max(80).optional().describe('Legend / column name'),
    unit: z.enum(['count', 'ms', 's', 'bytes', 'percent', 'score', 'none']).optional().describe('How values are shown; percent expects a 0..1 share'),
    better: z.enum(['up', 'down']).optional().describe('Which way a change is good'),
  })).max(MAX_MEASURES).optional().describe('1-4 measures (none for text)'),
  groupBy: z.string().max(200).optional().describe('Field of the source to split by (top and table need it; one measure only)'),
  limit: z.number().int().min(1).max(50).optional(),
  title: z.string().max(120).optional(),
  range: tileRange.optional().describe('The tile\'s own range; otherwise the dashboard\'s'),
  text: z.string().max(2000).optional().describe('Content of a text tile'),
  sql: z.object({
    query: z.string().max(20000).describe('One DuckDB statement over the tables events, logs, spans, metric_points, checks, visitor_days, identities; they hold the rows of the tile\'s range'),
    x: z.string().max(128).optional().describe('line/area/bars: the TIMESTAMP or DATE column; top: the label column (default: picked from the result)'),
    y: z.array(z.string().max(128)).max(8).optional().describe('Numeric columns to show (default: all numeric columns)'),
    series: z.string().max(128).optional().describe('line/area/bars with one y column: the column whose values become the series'),
    unit: z.enum(['count', 'ms', 's', 'bytes', 'percent', 'score', 'none']).optional(),
  }).optional().describe('A SQL tile (viz number, line, area, bars, top or table; no measures). Keep it when you update a dashboard'),
  layout: z.object({
    x: z.number().int().min(0).max(11), y: z.number().int().min(0), w: z.number().int().min(1).max(12), h: z.number().int().min(1).max(12),
  }).optional().describe('Position on a 12-column grid; omitted: stacked below the others (6 wide, 4 high; 2 for number)'),
});
type TileIn = z.infer<typeof tileInput>;

const QUERY_DOC = `Runs a generic query over a time range (from/to ISO-8601 or range; default last 24 hours, max 92 days) and returns per measure a total, and with shape series the points over time, with groupBy the groups (biggest first), with compare the previous window's total. The same queries power custom dashboards, so use it to try a tile before saving it.
A measure is {source, agg, field?, metric?, filters?}. Sources: events (pageviews, clicks, errors, vitals, custom events; fields type, path, country, device, browser, trackName, name, durationMs, props.<path>...), logs (service, severityNumber, severityText, body, attributes.<key>), spans (service, name, durationMs, statusCode, attributes.<key>), metrics (OpenTelemetry points: service, name, value, attributes.<key>; \`metric\` = metric name is required, see list_measure_names), checks (uptime check runs: checkId, ok, status, durationMs, region).
Aggs: count (rows), sessions / users / session_rate (events only; session_rate = share of sessions with a matching event, 0..1), sum/avg/min/max/p50/p75/p95/p99 over a numeric \`field\` (metrics default to value, checks to durationMs; other sources need field), rate = average of a 1/0 field (checks default ok, so uptime, 0..1).
Filters: {field, op, value}, ops eq neq contains not_contains starts_with ends_with gt gte lt lte set not_set.
Examples: pageviews = {source: events, agg: count, filters: [type eq pageview]}; LCP p75 = {source: events, agg: p75, field: props.lcp, filters: [type eq vitals]}; error logs = {source: logs, agg: count, filters: [severityNumber gte 17]}; span latency p95 by service = shape top (or series), groupBy service, {source: spans, agg: p95, field: durationMs}; uptime = {source: checks, agg: rate}; a metric = {source: metrics, agg: avg, metric: "process.cpu.utilization"}.
Shapes: total (one number per measure), series (over time; groupBy gives up to 10 series), top (needs groupBy: the biggest values). groupBy works with one measure. Optional dashboard-wide \`filters\` (event filters) apply to events measures only.`;

const TILE_DOC = `A tile is {viz, measures, groupBy?, limit?, title?, range?, layout?} (viz number|line|area|bars|top|table|text; measures as in query_measures plus optional label, unit count|ms|s|bytes|percent|score|none and better up|down; a text tile has \`text\` and no measures; top and table need groupBy). Tiles without layout are stacked below the others (6 columns wide, 4 rows high; 2 for number) on a 12-column grid, so w 6 at x 0 and x 6 puts two side by side. Put numbers on top, then charts, and set unit (ms for latencies, percent for rates).`;

/** Gives tiles without an id or layout one (layouts stacked below the lowest tile so far). */
function stackTiles<C extends { tiles: TileIn[] }>(config: C) {
  let bottom = 0;
  const tiles = config.tiles.map((t) => {
    const layout = t.layout ?? { x: 0, y: bottom, w: 6, h: t.viz === 'number' ? 2 : 4 };
    bottom = Math.max(bottom, layout.y + layout.h);
    return { ...t, id: t.id ?? randomUUID().slice(0, 8), layout };
  });
  return { ...config, tiles };
}

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

export const MAX_SOURCEMAP_UPLOADS = 50;

/** Single-quotes a string for a POSIX shell. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Upload URLs for local source map files and the curl command that PUTs them, run by the assistant from the
 * directory the paths are relative to. Throws HttpError(400) for paths that aren't uniquely named .map files.
 */
export async function sourcemapUploads(pid: string, args: { release?: string; files: string[] }, fallbackOrigin: string | undefined) {
  const release = normalizeRelease(args.release?.trim());
  if (!release) throw new HttpError(400, 'release must be 1-100 characters: letters, digits and . _ ~ @ + = -');
  const seen = new Map<string, string>();
  for (const path of args.files) {
    const file = normalizeMapFile(path);
    if (!/\.map$/i.test(path) || !file) throw new HttpError(400, `Not a source map file name: ${path} (expected e.g. dist/assets/index-abc123.js.map)`);
    if (seen.has(file)) throw new HttpError(400, `${seen.get(file)} and ${path} have the same file name, so one would replace the other. Upload maps of one build at a time.`);
    seen.set(file, path);
  }
  const uploads = [];
  for (const [file, path] of seen) {
    const target = await uploadUrl(pid, release, file, fallbackOrigin);
    if (!target) throw new HttpError(503, 'This server cannot sign uploads. Upload with the wgo-sourcemaps CLI instead (Settings → Source maps).');
    uploads.push({ path, file, url: target.url });
  }
  const n = uploads.length;
  return {
    release: release === '_' ? null : release,
    expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    files: uploads.map(({ path, file }) => ({ path, script: file })),
    command: [...uploads.map((u) => `curl -fsS -T ${shellQuote(u.path)} ${shellQuote(u.url)}`), `echo ${shellQuote(`Uploaded ${n} source map${n === 1 ? '' : 's'}`)}`].join(' &&\n'),
    next: 'Run `command` in a shell from the directory the paths are relative to, before expiresAt. Then delete the .map files from the build output '
      + '(or make sure they are not deployed): they contain the source code. Stacks are mapped when read, so list_errors shows original '
      + 'locations within about a minute, also for errors that happened before the upload. To upload on every deploy, use the '
      + 'wgo-sourcemaps CLI in CI with the upload key from the dashboard (Settings → Source maps).',
  };
}

/** The dashboard's default script tag: `scriptSnippet` in dashboard/src/pages/SnippetOptions.tsx with DEFAULT_OPTIONS. */
export function scriptSnippet(ingestOrigin: string, writeKey: string): string {
  return `<script src="${ingestOrigin}/sdk/v1/wgo.js" data-write-key="${writeKey}" data-endpoint="${ingestOrigin}" async></script>`;
}

/** What an assistant needs to start sending a project data: the browser snippet and the OTLP settings. */
export function installInfo(project: Project, ingestOrigin: string, origin?: string) {
  const { id, name, role, writeKey, createdAt } = project;
  return {
    project: { id, name, role, writeKey, createdAt },
    snippet: scriptSnippet(ingestOrigin, writeKey),
    howToInstall:
      'Paste `snippet` once into the <head> of every page (index.html, or the root layout/template of a framework app, e.g. app/layout.tsx in Next.js). '
      + 'It captures pageviews (including client-side navigation), clicks, JavaScript errors, failed requests and Web Vitals by itself. '
      + 'Optional, from code after the script has loaded: WGO.identify(userId) when a user logs in, WGO.reset() on logout, WGO.track(name, props) for custom events. '
      + 'Add data-track="name" to an element to give its clicks a stable name, data-wgo-ignore to never record clicks on it, data-wgo-mask to hide its text.',
    openTelemetry: {
      OTEL_EXPORTER_OTLP_ENDPOINT: ingestOrigin,
      OTEL_EXPORTER_OTLP_HEADERS: `x-wgo-key=${writeKey}`,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    },
    ...(origin ? { dashboard: `${origin}/#/p/${id}` } : {}),
  };
}

/**
 * A fresh server for one request, acting as `email`. `origin`: the dashboard's, for links to its pages.
 * `ingestOrigin`: where the SDK is served and data is sent, for install snippets.
 */
export function buildMcpServer(email: string, origin?: string, ingestOrigin?: string): McpServer {
  const server = new McpServer({ name: 'wgo', title: 'WGO analytics', version: '1.0.0' }, { instructions: INSTRUCTIONS });

  /** Registers a tool (read-only unless `hints` say otherwise) whose handler runs after the project membership check. */
  const projectTool = <S extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    shape: S,
    run: (pid: string, args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
    hints: Hints = READ_ONLY,
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

  const install = (project: Project) => {
    if (!ingestOrigin) throw new HttpError(503, 'This server does not know its public URL; copy the snippet from the dashboard (Settings → Install)');
    return installInfo(project, ingestOrigin, origin);
  };

  server.registerTool(
    'create_project',
    {
      title: 'Create a project',
      description: 'Creates a new project (one site or app) owned by you and returns its id, write key and a ready-to-paste script tag (`snippet`) that sends its data to the new project, with instructions where to put it and OpenTelemetry exporter settings. Check list_projects first: calling this twice creates two projects.',
      inputSchema: z.object({ name: z.string().min(1).max(100).describe('Project name, 1-100 characters, e.g. the site\'s domain or the app\'s name') }),
      annotations: { title: 'Create a project', ...CREATE },
    },
    async ({ name }) => {
      try {
        const trimmed = name.trim();
        if (!trimmed) throw new HttpError(400, 'Project name must be 1-100 characters');
        return ok(install(await P.createProject(email, trimmed)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  projectTool(
    'get_install_snippet',
    'Install snippet',
    'The script tag (`snippet`) that sends a project\'s browser data, where to put it, and OpenTelemetry exporter settings for its backend services.',
    {},
    async (pid) => install(await P.getProject(email, pid)),
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
    'upload_sourcemaps',
    'Upload source maps',
    'Uploads a build\'s source maps so JavaScript error stacks (list_errors, search_events and the dashboard) show the original files, lines and functions. '
      + 'Returns a shell `command` that PUTs the local .map files with curl (upload URLs work for 10 minutes); run it yourself, the files never pass through this tool. '
      + 'Use it from the app\'s source repository. Steps: '
      + '1. Find the release label the app reports (the `release` option of WGO.init, or data-release on the script tag); list_errors shows it per error group in missingSourcemaps.release, with the script files that lack a map. '
      + '2. Build the app with source maps that the bundles don\'t link to: Vite build.sourcemap: "hidden", webpack devtool: "hidden-source-map", esbuild --sourcemap=external. '
      + 'The build must be of the deployed code: maps are found by the script\'s file name (index-abc123.js) and must match its contents. '
      + '3. Call this with the path of every *.js.map in the build output (relative to where you will run the command) and the same release; omit release when the app sets none (those maps are then used for every release). '
      + '4. Run `command`, then follow `next`.',
    {
      release: z.string().max(100).optional().describe('The app\'s release label, exactly as it passes it to the SDK, e.g. a git sha or "1.4.0". Omit when the app sets none.'),
      files: z.array(z.string().min(1).max(1000).regex(/^[^\0\r\n]+$/, 'One path per entry'))
        .min(1).max(MAX_SOURCEMAP_UPLOADS)
        .describe(`Paths of the .js.map files, e.g. "dist/assets/index-abc123.js.map" (max ${MAX_SOURCEMAP_UPLOADS} per call; call again for more)`),
    },
    (pid, a) => sourcemapUploads(pid, a, ingestOrigin),
    UPLOAD,
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
    'Browser JavaScript errors grouped by fingerprint: message, kind, source, sample stack (original source locations when source maps are uploaded; minifiedStack is the raw one), count, affected sessions, first/last seen and a sparkline. missingSourcemaps (release and script files) means no source map matched the stack: upload_sourcemaps fixes that. Pass a fingerprint to search_events for individual occurrences with stack traces.',
    { ...windowShape, limit: limit(50, 200) },
    async (pid, a) => (await A.errors(pid, { ...windowParams(a), limit: str(a.limit ?? 50) })).map(({ stackFrames: _frames, ...g }) => g), // sampleStack is symbolicated when source maps are uploaded
  );

  {
    projectTool(
      'list_fix_runs',
      'GitHub Agent runs',
      'Runs of WGO\'s GitHub Agent, newest first: the error group (fingerprint), status (queued, running, pr_opened, no_fix, failed, cancelled), the draft pull request it opened and its state, the agent\'s root cause and summary, the steps it took and the token cost. Pass a fingerprint for one error group\'s runs.',
      { fingerprint: z.string().max(200).optional().describe('Only runs for this error group'), limit: limit(20, 100) },
      (pid, a) => FX.listRuns(pid, { fingerprint: a.fingerprint, limit: str(a.limit ?? 20) }),
    );

    projectTool(
      'start_fix_run',
      'Ask the GitHub Agent to fix an error',
      'Starts WGO\'s GitHub Agent on one error: a JavaScript error group (fingerprint from list_errors), a failed span (traceId and spanId from get_trace) or an ERROR/FATAL log record (logId and its timestamp from search_logs). It reads the project\'s GitHub repository, looks for the cause and, when it finds a fix, opens a draft pull request for a person to review; it takes a few minutes, and list_fix_runs shows how it went. It only works when a project owner turned the GitHub Agent on, and it refuses while the error has a run going or an open pull request. Each run costs model tokens, so only start one when asked to.',
      {
        fingerprint: z.string().max(200).optional().describe('Error group fingerprint from list_errors'),
        traceId: z.string().regex(/^[0-9a-f]{32}$/i).optional().describe('With spanId: a failed span'),
        spanId: z.string().regex(/^[0-9a-f]{16}$/i).optional(),
        logId: z.string().max(64).optional().describe('With at: an ERROR or FATAL log record'),
        at: z.string().max(40).optional().describe('ISO time of the span or log record'),
        repo: z.string().max(140).optional().describe('owner/name: one of the project\'s repositories. Without it, the repository that fixes this kind of error or service'),
      },
      (pid, a) => {
        const repo = a.repo ? { repo: a.repo } : {};
        if (a.fingerprint) return FX.startRun(pid, email, { fingerprint: a.fingerprint, ...repo });
        if (a.traceId && a.spanId) return FX.startRun(pid, email, { kind: 'span', traceId: a.traceId, spanId: a.spanId, at: a.at, ...repo });
        if (a.logId && a.at) return FX.startRun(pid, email, { kind: 'log', logId: a.logId, at: a.at, ...repo });
        throw new HttpError(400, 'Pass fingerprint, traceId and spanId, or logId and at');
      },
      CREATE,
    );
  }

  projectTool(
    'list_failed_requests',
    'Failed HTTP requests',
    'Failed fetch/XHR calls made by the browser, grouped by method, normalized route and status (0 = network failure).',
    { ...windowShape, limit: limit(50, 200) },
    (pid, a) => A.httpErrors(pid, { ...windowParams(a), limit: str(a.limit ?? 50) }),
  );

  projectTool(
    'list_goals',
    'Goal definitions',
    'The project\'s conversion goals, oldest first: id, name, the event filters that count as a conversion, optional funnel steps before it, and who created it. goal_conversions has their numbers.',
    {},
    (pid) => G.listGoals(pid),
  );

  projectTool(
    'create_goal',
    'Create a conversion goal',
    `Defines a conversion goal shared with all project members: a session converts when it has at least one event matching all \`filters\`. E.g. a signup page: [{field: "type", op: "eq", value: "pageview"}, {field: "path", op: "eq", value: "/welcome"}]; a custom event: [{field: "type", op: "eq", value: "custom"}, {field: "name", op: "eq", value: "checkout_completed"}]; a button: [{field: "type", op: "eq", value: "click"}, {field: "trackName", op: "eq", value: "signup"}]. Optional \`steps\` (at most ${G.MAX_STEPS}, in order) are the funnel before the goal, shown by goal_funnel. Check list_goals first: calling this twice creates two goals (at most ${G.MAX_GOALS} per project). Returns the goal; it counts past events too, so goal_conversions shows numbers right away.`,
    {
      name: z.string().min(1).max(120).describe('Goal name, 1-120 characters, e.g. "Signed up"'),
      filters: goalFilters.describe('Event filters, all must match'),
      steps: goalSteps.optional().describe('Funnel steps before the goal, each with a name (1-80 characters) and event filters'),
    },
    (pid, a) => G.createGoal(pid, email, a as never),
    CREATE,
  );

  projectTool(
    'update_goal',
    'Change a conversion goal',
    'Changes a goal\'s name, filters or funnel steps (id from list_goals); what you leave out stays. `steps: []` removes the funnel steps. Its numbers are recomputed from raw events, so the change applies to the past too.',
    {
      goalId: z.string().describe('Goal id from list_goals'),
      name: z.string().min(1).max(120).optional(),
      filters: goalFilters.optional().describe('Replaces the goal\'s filters'),
      steps: goalSteps.optional().describe('Replaces the funnel steps'),
    },
    (pid, { goalId, ...body }) => G.updateGoal(pid, goalId, body as never),
    LABEL_WRITE,
  );

  projectTool(
    'delete_goal',
    'Delete a conversion goal',
    'Removes a goal (id from list_goals) for all project members. Recorded events stay, so recreating it with the same filters brings its numbers back.',
    { goalId: z.string().describe('Goal id from list_goals') },
    async (pid, a) => {
      await G.deleteGoal(pid, a.goalId);
      return { deleted: a.goalId };
    },
    DELETE,
  );

  projectTool(
    'list_surveys',
    'Surveys',
    'The project\'s surveys, newest first: id, name, status (draft, active, paused), the questions\' count and types, how it is displayed (popover, or inline with its CSS selector), its targeting (pages, delay, scroll depth, event, frequency), the number of responses (all time) and when the last one came in. survey_results has the answers.',
    {},
    async (pid) => (await SV.listSurveys(pid)).map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      questions: s.questions.length,
      questionTypes: s.questions.map((q) => q.type),
      display: s.display,
      targeting: s.targeting,
      responses: s.responses,
      lastResponseAt: s.lastResponseAt,
    })),
  );

  projectTool(
    'create_survey',
    'Create a survey',
    `Creates a survey shown to the site's visitors, shared with all project members. It starts as a draft, and drafts are not shown: set \`status\` "active" (here or later with update_survey) to show it on the site. The site needs no code change: the WGO script it already has loads active surveys. An "inline" survey needs \`display.selector\`, a CSS selector of an element on the page it renders into; a "popover" is a floating card. Question types: single and multi need \`options\`, text takes a free answer, yesno, rating (1 to scale) and nps (0-10). Changes reach visitors within about a minute. Check list_surveys first: calling this twice creates two surveys (at most ${SV.MAX_SURVEYS} per project, ${SV.MAX_QUESTIONS} questions each). Returns the survey.`,
    surveyShape,
    (pid, a) => SV.createSurvey(pid, email, a as never),
    CREATE,
  );

  projectTool(
    'update_survey',
    'Change a survey',
    'Changes a survey (id from list_surveys); what you leave out stays. Use `status` "active" to start showing it on the site, "paused" to stop (answers already given are kept). `questions`, `display` and `targeting` replace the whole value, so pass all of them when changing one; keep question ids to keep their earlier answers matching. Changes reach visitors within about a minute.',
    {
      surveyId: z.string().describe('Survey id from list_surveys'),
      ...Object.fromEntries(Object.entries(surveyShape).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof surveyShape]: z.ZodOptional<(typeof surveyShape)[K]> },
    },
    (pid, { surveyId, ...body }) => SV.updateSurvey(pid, surveyId, body as never),
    LABEL_WRITE,
  );

  projectTool(
    'delete_survey',
    'Delete a survey',
    'Deletes a survey (id from list_surveys) for all project members, together with all its responses; this cannot be undone. It stops showing on the site. To only stop showing it, use update_survey with status "paused".',
    { surveyId: z.string().describe('Survey id from list_surveys') },
    async (pid, a) => {
      await SV.deleteSurvey(pid, a.surveyId);
      return { deleted: a.surveyId };
    },
    DELETE,
  );

  projectTool(
    'survey_results',
    'Survey results',
    'What visitors answered to one survey (id from list_surveys) in a window (default the last 30 days, max 92d): the number of responses, how often it was shown and dismissed and the response rate (responses / shown), and per question its title and type with the answers: counts per option or value, the average (rating, nps), the NPS score (nps: % promoters minus % detractors) or up to 20 text answers, newest first. `responses` adds the latest individual responses, with the answers under the question titles. Shown and dismissed come from raw events, so windows older than the project\'s retention show too few.',
    {
      ...windowShape,
      surveyId: z.string().describe('Survey id from list_surveys'),
      responses: z.number().int().min(0).max(100).optional().describe('How many of the latest individual responses to include (default 10, 0 for none)'),
    },
    async (pid, a) => {
      const w = windowParams(a);
      const [survey, res] = await Promise.all([SV.getSurvey(pid, a.surveyId), SV.surveyResults(pid, a.surveyId, w)]);
      const byId = new Map(survey.questions.map((q) => [q.id, q]));
      const n = a.responses ?? 10;
      const latest = n ? (await SV.surveyResponses(pid, a.surveyId, { ...w, limit: String(n) })).responses : [];
      return {
        survey: { id: survey.id, name: survey.name, status: survey.status },
        responses: res.responses,
        shown: res.shown,
        dismissed: res.dismissed,
        responseRate: res.shown > 0 ? res.responses / res.shown : null,
        truncated: res.truncated,
        questions: res.questions.map(({ id, texts, ...q }) => ({
          id,
          title: byId.get(id)?.title ?? id,
          type: byId.get(id)?.type,
          ...q,
          ...(texts ? { texts: texts.slice(0, 20) } : {}),
        })),
        latestResponses: latest.map((r) => ({
          at: r.createdAt,
          userId: r.userId,
          sessionId: r.sessionId,
          path: r.path,
          answers: Object.fromEntries(Object.entries(r.answers).map(([id, v]) => [byId.get(id)?.title ?? id, v])),
        })),
      };
    },
  );

  projectTool(
    'list_triggers',
    'Triggers (alerts)',
    'The project\'s triggers with their kind, scope, filters, destination, cooldown, whether enabled, when they last fired and the last delivery status (threshold/anomaly also their current state and usual range), plus `destinations`: the saved destinations a trigger can notify, first the project\'s (level "project", shared with its members), then the user\'s own (level "account", usable in all their projects). Put a destination\'s `ref` in a trigger\'s destination. `slackChannels` lists just the project\'s Slack channels. Connecting a Slack channel is done in the dashboard (Triggers page); webhooks can be saved with create_destination.',
    {},
    async (pid) => {
      const [triggers, slackChannels, destinations] = await Promise.all([T.listTriggers(pid), S.listIntegrations(pid), DST.listProjectDestinations(pid, email)]);
      return {
        triggers: triggers.map(publicTrigger),
        destinations: destinations.map(({ id, level, type, name, detail, owner, ref }) => ({ id, level, type, name, detail, owner, ref })),
        slackChannels: slackChannels.map(({ id, channel, teamName }) => ({ id, channel, teamName })),
      };
    },
  );

  projectTool(
    'preview_trigger',
    'Preview a trigger',
    'What a threshold or anomaly trigger would see right now, without saving it: the current value over its window, whether it would fire, and for anomaly triggers the usual range at this time of day. Use it to pick a sensible threshold before create_trigger.',
    {
      scope: triggerScope,
      kind: z.enum(['threshold', 'anomaly']),
      filters: triggerShape.filters,
      metric: triggerShape.metric.unwrap(),
      condition: triggerShape.condition.unwrap(),
      windowMinutes: z.number().int().describe(`One of ${TRIGGER_WINDOWS.join(', ')}`),
    },
    (pid, a) => M.previewTrigger(pid, a as never),
  );

  projectTool(
    'create_trigger',
    'Create a trigger (alert)',
    `Saves a trigger shared with all project members. Kinds: "match" notifies on every new row matching all \`filters\` (checked as data arrives), e.g. errors on /checkout: scope events, filters [{field: "type", op: "eq", value: "error"}, {field: "path", op: "starts_with", value: "/checkout"}]. "threshold" notifies when \`metric\` over the last \`windowMinutes\` crosses \`condition\` and again when it resolves (checked every minute), e.g. no pageviews in 30 minutes: filters [{field: "type", op: "eq", value: "pageview"}], metric {agg: "count"}, condition {op: "below", value: 1}, windowMinutes 30. "anomaly" notifies when the metric is unusual for the time of day compared with the previous 7 days (needs 3 days of data). Scope and kind can't be changed later. Notifications go to a saved destination from list_triggers.destinations (pass its \`ref\`), or a one-off public https webhook URL. Check list_triggers first: calling this twice creates two triggers. A one-off webhook trigger's result has signingSecret for verifying X-WGO-Signature; saved webhooks sign with the destination's secret. test_trigger sends a sample notification.`,
    { scope: triggerScope, kind: triggerKind, ...triggerShape },
    async (pid, a) => publicTrigger(await T.createTrigger(pid, email, a as never, origin)),
    TRIGGER_CREATE,
  );

  projectTool(
    'update_trigger',
    'Change a trigger',
    'Changes a trigger (id from list_triggers): name, filters, destination, cooldown, enabled (false pauses it) and, for threshold/anomaly, metric, condition and window. What you leave out stays. Changing what a threshold/anomaly trigger measures resets its state. Scope and kind can\'t be changed: create a new trigger instead.',
    {
      triggerId: z.string().describe('Trigger id from list_triggers'),
      name: triggerShape.name.optional(),
      filters: triggerShape.filters.optional(),
      destination: triggerShape.destination.optional(),
      cooldownSeconds: triggerShape.cooldownSeconds,
      enabled: triggerShape.enabled,
      metric: triggerShape.metric,
      condition: triggerShape.condition,
      windowMinutes: triggerShape.windowMinutes,
      slackTemplate: triggerShape.slackTemplate.describe('Its own Slack message; null goes back to the default message'),
    },
    async (pid, { triggerId, ...body }) => publicTrigger(await T.updateTrigger(pid, email, triggerId, body as never, origin)),
    TRIGGER_WRITE,
  );

  projectTool(
    'delete_trigger',
    'Delete a trigger',
    'Removes a trigger (id from list_triggers) for all project members; it stops notifying. To pause it instead, update_trigger with enabled false.',
    { triggerId: z.string().describe('Trigger id from list_triggers') },
    async (pid, a) => {
      await T.deleteTrigger(pid, a.triggerId);
      return { deleted: a.triggerId };
    },
    DELETE,
  );

  projectTool(
    'test_trigger',
    'Send a test notification',
    'Sends a sample notification from a trigger (id from list_triggers) to its destination now, marked as a test, and returns whether it was delivered and the status (HTTP status, or the Slack error). Pass slackTemplate to try a Slack message design before saving it.',
    { triggerId: z.string().describe('Trigger id from list_triggers'), slackTemplate: slackTemplate.optional().describe('A Slack message design to try instead of the saved one') },
    (pid, a) => T.testTrigger(pid, a.triggerId, a.slackTemplate ? { slackTemplate: a.slackTemplate } : undefined),
    SEND,
  );

  const destinationOwner = (pid: string, level: 'project' | 'account' | undefined) =>
    level === 'account' ? ({ level: 'account', email } as const) : ({ level: 'project', pid } as const);
  const destinationLevel = z.enum(['project', 'account']).optional()
    .describe('project (default): shared with the project\'s members. account: the user\'s own, usable by triggers in every project they\'re a member of');

  projectTool(
    'create_destination',
    'Save a webhook destination',
    'Saves a webhook that triggers can notify, so several triggers (and, at account level, several projects) share one URL and one signing secret. Returns it with `signingSecret` (requests carry X-WGO-Signature, HMAC-SHA256 of the body with it, and X-WGO-Destination) and `ref` to put in create_trigger\'s destination. hooks.slack.com URLs get a Slack message instead. Check list_triggers.destinations first: calling this twice saves two.',
    {
      name: z.string().min(1).max(120).describe('A name to recognise it by, e.g. "PagerDuty" or "Ops webhook"'),
      url: z.string().url().describe('Public https URL'),
      level: destinationLevel,
    },
    (pid, a) => DST.createDestination(destinationOwner(pid, a.level), email, { name: a.name, url: a.url }),
    TRIGGER_CREATE,
  );

  projectTool(
    'delete_destination',
    'Delete a saved destination',
    'Removes a saved destination (id from list_triggers.destinations; the project\'s, or the user\'s own with level "account"). Refused while a trigger uses it: point those triggers elsewhere first.',
    { destinationId: z.string(), level: destinationLevel },
    async (pid, a) => {
      await DST.deleteDestination(destinationOwner(pid, a.level), a.destinationId);
      return { deleted: a.destinationId };
    },
    DELETE,
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
    'user_flows',
    'User flows: paths, drop-off and errors',
    `How sessions move through the site: the pages they view one after another (reloads collapsed), from the entry page or from the first view of \`start\`, for ${FL.MIN_STEPS}-${FL.MAX_STEPS} steps (default ${FL.DEFAULT_STEPS}). Per step the top ${FL.TOP_PAGES} pages (the rest as "(other)") with sessions, how many left after that page (\`exits\`; on the last step the rest went on), and how many hit a JavaScript error or failed request there (\`errors\`, \`errorExits\`: of those, how many left; \`topErrors\`). \`links\` are the sessions going from one page to the next. \`exitPages\` ranks pages by sessions that ended on them, with the exit rate and the same counts for sessions that hit an error there. \`filters\` choose sessions: a session counts when any of its events matches. Use it for "where do people drop off" or "do errors make people leave". Only covers raw data (the project's retention).`,
    {
      ...windowShape,
      start: z.string().optional().describe('Start at this page path, e.g. "/pricing" (default: the entry page)'),
      steps: z.number().int().min(FL.MIN_STEPS).max(FL.MAX_STEPS).optional().describe(`Steps to follow (default ${FL.DEFAULT_STEPS})`),
      filters: z.array(eventFilter).max(20).optional().describe('Event filters: sessions with at least one matching event'),
    },
    (pid, a) => FL.flows(pid, {
      ...windowParams(a),
      start: a.start ? String(a.start) : undefined,
      steps: a.steps != null ? String(a.steps) : undefined,
      filters: (a.filters as unknown[] | undefined)?.length ? JSON.stringify(a.filters) : undefined,
    }),
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
      service: z.string().optional().describe('Only points reported by this service (from list_metrics)'),
      groupBy: z.string().optional().describe('Attribute key to split by, or service.name to split by service'),
    },
    (pid, a) => A.metricSeries(pid, { ...windowParams(a), name: a.name, agg: a.agg, service: a.service, groupBy: a.groupBy }),
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

  const dashboardUrl = (pid: string, id: string) => (origin ? { url: `${origin}/#/p/${pid}/dashboards/${id}` } : {});
  const withUrl = (pid: string, d: Dashboard) => ({ ...d, ...dashboardUrl(pid, d.id) });

  projectTool(
    'query_measures',
    'Query measures',
    QUERY_DOC,
    {
      ...windowShape,
      shape: z.enum(['total', 'series', 'top']).describe('total: one number per measure; series: values over time; top: the biggest values of groupBy (needs groupBy)'),
      measures: z.array(measureQuery).min(1).max(MAX_MEASURES).describe('1-4 measures; with groupBy, exactly one'),
      groupBy: z.string().min(1).max(200).optional().describe('A field of the measure\'s source to split by, e.g. path, country, service, name'),
      limit: z.number().int().min(1).max(50).optional().describe('Groups to return (series: default 5, max 10; top: default 10, max 50)'),
      compare: z.boolean().optional().describe('Also return the total of the same-length window just before `from`'),
      filters: z.array(eventFilter).max(20).optional().describe('Dashboard-wide filters, applied to events measures only'),
    },
    (pid, a) => {
      const spec = { shape: a.shape, measures: a.measures, groupBy: a.groupBy, limit: a.limit, compare: a.compare };
      return QRY.query(pid, { ...windowParams(a), q: JSON.stringify(spec), filters: a.filters?.length ? JSON.stringify(a.filters) : undefined });
    },
  );

  projectTool(
    'list_measure_names',
    'List measure names',
    'Names to use in measures, seen in the last 7 days: tracked clicks (data-track names, for trackName filters), custom events (name filters) and OpenTelemetry metric names (the `metric` of a metrics measure) with type and unit.',
    {},
    (pid) => QRY.measureNames(pid),
  );

  projectTool(
    'list_dashboards',
    'List dashboards',
    'The project\'s custom dashboards, most recently updated first, with tile counts. A dashboard belongs to the project: every member sees it.',
    {},
    async (pid) => (await D.listDashboards(pid)).map((d) => ({ ...d, ...dashboardUrl(pid, d.id) })),
  );

  projectTool(
    'get_dashboard',
    'Get a dashboard',
    'A dashboard with all its tiles (viz, measures, layout) and default filters and range.',
    { dashboardId: z.string().describe('Dashboard id from list_dashboards') },
    async (pid, a) => withUrl(pid, await D.getDashboard(pid, a.dashboardId)),
  );

  projectTool(
    'create_dashboard',
    'Create a dashboard',
    `Creates a custom dashboard shared with all project members (every member sees and edits it). ${TILE_DOC} Check list_dashboards first: calling this twice creates two dashboards (at most ${D.MAX_DASHBOARDS} per project). Try each tile's measures with query_measures first. Returns the dashboard with its \`url\` when known.`,
    {
      name: z.string().min(1).max(120).describe('Dashboard name, 1-120 characters'),
      tiles: z.array(tileInput).max(D.MAX_TILES).optional(),
      filters: z.array(eventFilter).max(20).optional().describe('Default dashboard filters (events measures)'),
      range: tileRange.optional().describe('Default range for tiles without their own'),
    },
    async (pid, a) => {
      const config = stackTiles({ tiles: a.tiles ?? [], filters: a.filters, range: a.range });
      return withUrl(pid, await D.createDashboard(pid, email, { name: a.name, config: config as never }));
    },
    CREATE,
  );

  projectTool(
    'add_dashboard_tile',
    'Add a dashboard tile',
    `Adds one tile below the others on a dashboard (id from list_dashboards). ${TILE_DOC}`,
    { dashboardId: z.string().describe('Dashboard id from list_dashboards'), tile: tileInput },
    async (pid, a) => withUrl(pid, await D.addTile(pid, a.dashboardId, a.tile as never)),
    CREATE,
  );

  projectTool(
    'update_dashboard',
    'Change a dashboard',
    'Renames a dashboard and/or replaces its whole config (tiles, filters, range); what you leave out stays. `config` replaces all tiles, so start from get_dashboard and keep the tiles you want. To add one tile use add_dashboard_tile.',
    {
      dashboardId: z.string().describe('Dashboard id from list_dashboards'),
      name: z.string().min(1).max(120).optional(),
      config: z.object({
        tiles: z.array(tileInput).max(D.MAX_TILES),
        filters: z.array(eventFilter).max(20).optional(),
        range: tileRange.optional(),
      }).optional().describe('Replaces the dashboard\'s config; tiles without a layout are stacked below the others'),
    },
    async (pid, a) => withUrl(pid, await D.updateDashboard(pid, a.dashboardId, { name: a.name, config: a.config ? (stackTiles(a.config) as never) : undefined })),
    LABEL_WRITE,
  );

  projectTool(
    'delete_dashboard',
    'Delete a dashboard',
    'Removes a dashboard (id from list_dashboards) for all project members. Recorded data stays.',
    { dashboardId: z.string().describe('Dashboard id from list_dashboards') },
    async (pid, a) => {
      await D.deleteDashboard(pid, a.dashboardId);
      return { deleted: a.dashboardId };
    },
    DELETE,
  );

  return server;
}

/** Lowest OTLP severityNumber of each level. */
const SEVERITY = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 } as const;
