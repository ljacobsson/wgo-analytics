/**
 * API contract between the WGO backend and dashboard.
 * The dashboard keeps a verbatim copy in dashboard/src/api/contract.ts — keep them in sync.
 *
 * Auth: every /api/* route requires `Authorization: Bearer <Cognito ID token>`.
 * Time params (`from`, `to`, `before`) are ISO-8601 strings. Timestamps in responses are ISO-8601 strings.
 */

// ---------- runtime config (served as /config.json next to the dashboard) ----------
export interface RuntimeConfig {
  apiUrl: string; // https://xxx.execute-api.region.amazonaws.com  (no trailing slash; routes below are appended)
  ingestUrl: string; // same host as apiUrl in practice; SDK endpoint + OTLP base
  wsUrl: string; // wss://yyy.execute-api.region.amazonaws.com/live
  sdkUrl: string; // https://dzzz.cloudfront.net/sdk/v1/wgo.js
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  /** Local development only (backend/dev/server.mts): skip Cognito and act as this email. Never set in deployed configs. */
  devEmail?: string;
  /** Optional MapLibre style URLs for the visitor map (default: OpenFreeMap dark / positron, OpenStreetMap data). */
  mapStyleUrl?: string;
  mapStyleUrlLight?: string;
  /** Email domains allowed to sign up (empty/absent = anyone); shown as a hint on the sign-up screen. */
  allowedEmailDomains?: string[];
  /** False when self sign-up is off (AllowSelfSignup=false) and accounts are created in Cognito; the sign-in page then hides "Create account". Absent = on. */
  selfSignup?: boolean;
  /** The MCP server for AI assistants (the McpUrl stack output, e.g. https://wgo.example.com/mcp); empty or absent when MCP is turned off. */
  mcpUrl?: string;
}

// ---------- accounts & projects ----------
export type Role = 'owner' | 'member';

export interface Project {
  id: string;
  name: string;
  writeKey: string; // public key used by the SDK and OTLP exporters
  role: Role; // caller's role
  createdAt: string;
  // raw events, logs, spans and metric points (Parquet files in S3) older than `days` are deleted daily, a whole
  // day at a time; hourly Overview rollups are kept 400 days. maxDays is the stack's MaxRetentionDays.
  retention: { days: number; defaultDays: number; maxDays: number };
}

export interface Member {
  email: string;
  role: Role;
  createdAt: string;
}

// GET    /api/me                                  -> Me
// POST   /api/projects            {name}          -> Project       (caller becomes owner)
// GET    /api/projects/{pid}                      -> Project
// PATCH  /api/projects/{pid}      {name?, retentionDays?} -> Project (owner)
// POST   /api/projects/{pid}/rotate-key           -> Project       (owner)
// GET    /api/projects/{pid}/members              -> Member[]
// POST   /api/projects/{pid}/members  {email}     -> Member        (owner; invited user gains access on next login with that email)
// DELETE /api/projects/{pid}/members/{email}      -> {ok: true}    (owner; cannot remove last owner)
export interface Me {
  email: string;
  projects: Project[];
}

// ---------- product analytics ----------
export type EventType = 'pageview' | 'click' | 'error' | 'http_error' | 'custom' | 'vitals' | 'identify';

export interface AnalyticsEvent {
  id: string;
  type: EventType;
  ts: string;
  sessionId: string | null;
  anonId: string | null;
  userId: string | null;
  url: string | null;
  path: string | null;
  title: string | null;
  referrer: string | null;
  // click
  selector: string | null;
  elementText: string | null;
  elementTag: string | null;
  trackName: string | null; // data-track / data-wgo value
  // error
  errorMessage: string | null;
  errorStack: string | null;
  errorSource: string | null;
  fingerprint: string | null;
  // http_error
  httpMethod: string | null;
  httpUrl: string | null;
  httpRoute: string | null; // normalized: query stripped, ids replaced with :id
  httpStatus: number | null;
  durationMs: number | null;
  // custom
  name: string | null;
  // full type-specific payload from the SDK (`d`), plus anything extra
  props: Record<string, unknown>;
  browser: string | null;
  os: string | null;
  device: string | null; // 'desktop' | 'mobile' | 'tablet'
  // approximate viewer location from the IP (CloudFront edge geolocation); IPs are never stored
  country: string | null; // ISO 3166-1 alpha-2, e.g. 'SE'
  region: string | null; // e.g. 'Stockholm County'
  city: string | null;
  lat: number | null; // rounded to 1 decimal (~11 km)
  lon: number | null;
  // why this looks like a bot ('user-agent' | 'automation' | 'timezone-mismatch'), null for humans
  bot: string | null;
}

export interface Totals {
  events: number;
  pageviews: number;
  clicks: number;
  errors: number;
  httpErrors: number;
  sessions: number;
  users: number; // distinct anon ids
}

// ---------- rich filters ----------
// Every analytics endpoint below (events scope: stats, clicks, pages, errors, http-errors, breakdown, vitals,
// geo, events; logs scope: logs; spans scope: traces, services) accepts `filters=<JSON Filter[]>`.
// Events-scope endpoints leave out bot traffic (AnalyticsEvent.bot) unless `bots=1`.
// All filters must match (AND). Fields: a built-in field (see FieldsResponse.builtin), `props.<path>` for event
// properties (nested with dots, e.g. `props.props.plan` for a custom event's `plan`), or for logs/spans
// `attributes.<key>` / `resource.<key>` (OTel keys keep their dots, e.g. `attributes.http.route`).
export type FilterScope = 'events' | 'logs' | 'spans';
export type FilterOp =
  | 'eq' | 'neq' // exact (numeric fields compare as numbers)
  | 'contains' | 'not_contains' | 'starts_with' | 'ends_with' // case-insensitive
  | 'gt' | 'gte' | 'lt' | 'lte' // numeric when the value is a number, else text order (ISO dates work)
  | 'set' | 'not_set'; // present / missing or empty (no value)
export interface Filter {
  field: string;
  op: FilterOp;
  value?: string;
}

// GET /api/projects/{pid}/fields?scope=events|logs|spans&from&to
//   builtin: fixed fields; discovered: property/attribute keys seen recently, most common first
export interface FieldInfo {
  field: string;
  type: 'text' | 'number' | 'json';
  count?: number; // discovered fields: how many recent rows have it
}
export interface FieldsResponse {
  builtin: FieldInfo[];
  discovered: FieldInfo[];
}

// GET /api/projects/{pid}/fields/values?scope&field&from&to&q  -> top values (most frequent first, max 20)
export interface FieldValuesResponse {
  values: Array<{ value: string; count: number }>;
}

// ---------- triggers (alerts) ----------
// A trigger watches incoming product events, OpenTelemetry logs or spans (its `scope`). When a new row matches
// all its filters (same fields and semantics as above, for that scope), it notifies a destination, at most once
// per cooldown. Matches during the cooldown are counted and reported with the next notification.
//
// GET    /api/projects/{pid}/triggers                 -> Trigger[]
// POST   /api/projects/{pid}/triggers        TriggerInput -> Trigger
// PATCH  /api/projects/{pid}/triggers/{id}   Partial<TriggerInput> -> Trigger
// DELETE /api/projects/{pid}/triggers/{id}            -> { ok: true }
// POST   /api/projects/{pid}/triggers/{id}/test       -> TriggerTestResult   (sends a sample notification now)
//
// Webhook payload (POST, JSON): TriggerWebhookPayload, signed with
//   X-WGO-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the trigger's signingSecret>
// Webhook URLs on hooks.slack.com receive a Slack-formatted message instead.
export type TriggerDestination =
  | { type: 'webhook'; url: string } // https only; private/internal addresses are rejected
  | { type: 'slack'; integrationId: string }; // a channel connected with "Add to Slack"

export interface TriggerInput {
  name: string;
  scope?: FilterScope; // what it watches; default 'events'. Can't be changed after creation.
  filters: Filter[]; // at least one
  destination: TriggerDestination;
  cooldownSeconds?: number; // default 300, min 0, max 86400
  enabled?: boolean; // default true
}

export interface Trigger extends Required<TriggerInput> {
  id: string;
  signingSecret: string; // for verifying webhook signatures
  createdBy: string;
  createdAt: string;
  lastFiredAt: string | null;
  fireCount: number;
  lastStatus: string | null; // e.g. "200", "slack: channel_not_found", "timeout"
}

export interface TriggerTestResult {
  ok: boolean;
  status: string;
}

export interface TriggerWebhookPayload {
  trigger: { id: string; name: string };
  project: { id: string; name: string };
  firedAt: string;
  scope: FilterScope;
  matches: number; // matching rows in this notification, including ones held back by the cooldown
  events: AnalyticsEvent[]; // events scope: up to 10 most recent matches (empty for other scopes)
  logs?: LogRecord[]; // logs scope: up to 10 most recent matching log records
  spans?: Span[]; // spans scope: up to 10 most recent matching spans
  url: string; // dashboard link to the matching rows
  test?: boolean;
}

// Slack channels connected to a project ("Add to Slack": pick workspace + channel on Slack, one click).
// GET    /api/projects/{pid}/integrations              -> SlackIntegration[]
// DELETE /api/projects/{pid}/integrations/{id}         -> { ok: true }
// GET    /api/projects/{pid}/slack/install             -> { url }  open it: Slack asks for workspace and channel,
//        then redirects back to the dashboard (#/p/{pid}/triggers?slack=connected|cancelled|error).
//        409 until a Slack app is set up (see SlackSetup).
//
// Slack ties "Add to Slack" to a Slack app. Self-hosted WGO creates one once: from the dashboard
// (per project, owners only) or instance-wide with SLACK_CLIENT_ID/SECRET at deploy time.
// GET    /api/projects/{pid}/slack                     -> SlackSetup
// POST   /api/projects/{pid}/slack/app  {clientId, clientSecret} -> SlackSetup   (owner; checked with Slack)
// DELETE /api/projects/{pid}/slack/app                 -> SlackSetup   (owner)
export interface SlackSetup {
  configured: boolean;
  source: 'project' | 'instance' | null;
  clientId: string | null; // project-level app only; the secret is never returned
  redirectUrl: string; // the app's OAuth redirect URL (already in the manifest behind createAppUrl)
  createAppUrl: string; // opens Slack's "create app" with everything pre-filled; you only pick the workspace
}
export interface SlackIntegration {
  id: string;
  type: 'slack';
  channel: string; // "#alerts"
  teamName: string | null;
  createdBy: string;
  createdAt: string;
}

// ---------- saved views ----------
// A named dashboard page plus its filters and page options, shared by the project's members.
// GET    /api/projects/{pid}/views                -> SavedView[]   (newest first)
// POST   /api/projects/{pid}/views   SavedViewInput -> SavedView
// PATCH  /api/projects/{pid}/views/{id}  Partial<SavedViewInput> -> SavedView
// DELETE /api/projects/{pid}/views/{id}           -> { ok: true }
export interface SavedViewInput {
  name: string; // 1-120 characters
  page: string; // dashboard page id, e.g. "logs", "events", "errors"
  params: string; // URL query string of the page's filters and options, e.g. "lf=%5B…%5D&sev=17" (no time range)
}
export interface SavedView extends SavedViewInput {
  id: string;
  createdBy: string;
  createdAt: string;
}

// ---------- conversion goals ----------
// A goal turns any kind of event into a conversion: a pageview of /thank-you, a click on the signup button, a custom
// `checkout_completed` event. It's described with filters (events scope, same fields and semantics as above).
// A session converts when it has at least one matching event; conversion rate = converting sessions / sessions.
// GET    /api/projects/{pid}/goals                 -> Goal[]   (oldest first)
// POST   /api/projects/{pid}/goals   GoalInput     -> Goal
// PATCH  /api/projects/{pid}/goals/{id}  Partial<GoalInput> -> Goal
// DELETE /api/projects/{pid}/goals/{id}            -> { ok: true }
// GET    /api/projects/{pid}/goals/{id}/funnel     -> GoalFunnel (below)
export interface GoalInput {
  name: string; // 1-120 characters
  filters: Filter[]; // events scope, at least one
  steps?: GoalStep[]; // optional funnel steps before the goal, in order (at most 6); the goal itself is the last step
}
export interface GoalStep {
  name: string; // 1-80 characters
  filters: Filter[]; // events scope, at least one
}
export interface Goal extends GoalInput {
  steps: GoalStep[]; // [] when the goal has no funnel steps
  id: string;
  createdBy: string;
  createdAt: string;
}

// GET /api/projects/{pid}/conversions?from&to[&series=0]   (also /kiosk/v1/conversions)
//   Every goal of the project, counted over raw events (so only within the project's retention). The page filters
//   (`filters`, `bots`) narrow both the goal's events and the sessions it's compared with.
export interface GoalConversions {
  id: string;
  name: string;
  filters: Filter[];
  conversions: number; // matching events
  sessions: number; // sessions with at least one matching event
  users: number; // distinct anon ids among them
  series: number[]; // matching events in 24 equal buckets across [from,to] (empty with series=0)
}
export interface ConversionsResponse {
  sessions: number; // all sessions in range: the denominator of the conversion rate
  users: number;
  goals: GoalConversions[];
}

// GET /api/projects/{pid}/goals/{id}/funnel?from&to[&filters&bots][&steps=<GoalStep[] JSON>]
//   How sessions reach one goal, from raw events (the project's retention). `steps` previews unsaved funnel steps in
//   place of the goal's own. The page filters narrow every number, the denominator included.
//   - steps: the funnel steps and then the goal. A session reaches step i when it has a matching event at or after the
//     time it reached step i-1, so the steps count in order.
//   - drivers: sessions split by entry page, pages viewed and errors hit before converting, source, device, browser
//     and country, each with its conversion rate. `best` holds segments that convert clearly better than their
//     baseline (the 95% interval lies above it), sorted by extra conversions; `worst` the ones clearly worse, sorted by
//     conversions missed. The baseline is the overall rate, except for errors: those compare with the other sessions
//     that viewed the page the error happened on, since only sessions that get that far can hit it.
export type DriverDim = 'entry' | 'page' | 'source' | 'device' | 'browser' | 'country' | 'error';
export interface DriverRow {
  dim: DriverDim;
  key: string; // the page path, referrer host or "(direct)", error message or "GET /api/x 500", device, …
  at: string | null; // errors: the page they happened on
  sessions: number;
  converted: number; // of those sessions, how many converted
  rate: number; // converted / sessions
  baseline: number; // the rate it's compared with: overall, or for errors the other sessions that viewed `at`
  lift: number | null; // rate / baseline (null when the baseline is 0)
  low: number; // 95% (Wilson) interval of the rate
  high: number;
  impact: number; // converted - sessions × baseline: extra (+) or missed (-) conversions
}
export interface FunnelStepResult {
  name: string;
  filters: Filter[];
  sessions: number; // sessions that reached this step in order
  medianSeconds: number | null; // median time from the previous step (null for the first step)
  exits: Array<{ key: string; sessions: number }>; // where the sessions that stopped here left: their last page, top 5
}
export interface JourneyRow {
  pages: string[]; // the session's first pages (up to 3), repeats collapsed; for converting sessions, up to the conversion
  sessions: number;
  converted: number;
  rate: number;
  low: number; // 95% (Wilson) interval of the rate
  high: number;
}
export interface GoalFunnel {
  goal: { id: string; name: string; filters: Filter[] };
  sessions: number; // all sessions in range
  converted: number; // sessions with a goal event (as /conversions)
  steps: FunnelStepResult[]; // the funnel steps, then the goal last
  best: DriverRow[];
  worst: DriverRow[];
  dims: Record<DriverDim, DriverRow[]>; // top 25 per dimension by sessions
  journeys: JourneyRow[]; // top 15 by sessions
}

// GET /api/projects/{pid}/stats?from&to[&compare=0]
//   Ranges of 3+ days (or reaching past the project's retention) without filters are served from hourly
//   rollups: buckets of 1h or more, sessions/users are HyperLogLog estimates (about ±2%).
// GET /api/projects/{pid}/totals?from&to -> Totals   (one window; the dashboard's comparison window)
export interface StatsResponse {
  bucketSeconds: number;
  totals: Totals;
  previous: Totals | null; // same-length window immediately before `from`; null with compare=0 (fetch it from /totals)
  series: Array<{ t: string; pageview: number; click: number; error: number; http_error: number; custom: number }>;
  botSessions?: number; // sessions left out as bots in this range (when bots aren't included)
}

// GET /api/projects/{pid}/clicks?from&to&limit=50
export interface ClickRow {
  selector: string;
  elementText: string | null;
  trackName: string | null;
  elementTag: string | null;
  alias: string | null; // the project's readable name for this selector (click aliases), if set
  count: number;
  sessions: number;
  rageClicks: number;
  lastSeen: string;
}

// Click aliases: a readable name for an autocaptured click target, keyed by its selector.
// GET    /api/projects/{pid}/click-aliases                → ClickAlias[]
// POST   /api/projects/{pid}/click-aliases  ClickAliasInput → ClickAlias (creates or renames)
// DELETE /api/projects/{pid}/click-aliases?selector=…      → { ok: true }
export interface ClickAliasInput {
  selector: string; // 1-512 characters, as captured
  alias: string; // 1-80 characters
}
export interface ClickAlias extends ClickAliasInput {
  updatedBy: string;
  updatedAt: string;
}

// GET /api/projects/{pid}/pages?from&to&limit=50
export interface PageRow {
  path: string;
  views: number;
  sessions: number;
}

// GET /api/projects/{pid}/errors?from&to&limit=100
export interface ErrorGroup {
  fingerprint: string;
  message: string;
  kind: string | null; // error | rejection | resource | manual
  count: number;
  sessions: number;
  firstSeen: string;
  lastSeen: string;
  sampleStack: string | null;
  sampleUrl: string | null;
  source: string | null;
  series: number[]; // 24 equal buckets across [from,to] for a sparkline
}

// GET /api/projects/{pid}/http-errors?from&to&limit=100
export interface HttpErrorGroup {
  method: string;
  route: string;
  status: number; // 0 = network failure
  count: number;
  sessions: number;
  avgDurationMs: number;
  lastSeen: string;
  sampleUrl: string | null;
}

// GET /api/projects/{pid}/breakdown?from&to&dim=browser|os|device|referrer|country|city
export interface BreakdownRow {
  key: string;
  count: number;
}

// GET /api/projects/{pid}/geo?from&to
//   points: distinct ~11 km cells with traffic (top 1000 by sessions); countries: all, by sessions
export interface GeoPoint {
  lat: number;
  lon: number;
  city: string | null;
  country: string | null;
  sessions: number;
  events: number;
}
export interface GeoResponse {
  points: GeoPoint[];
  countries: Array<{ country: string; sessions: number; events: number }>;
  located: number; // sessions with a known location
  total: number; // all sessions in range
}

// GET /api/projects/{pid}/vitals?from&to
export interface VitalsResponse {
  samples: number;
  p75: { lcp: number | null; fcp: number | null; cls: number | null; inp: number | null; ttfb: number | null };
}

// GET /api/projects/{pid}/events?type&before&limit=100&q&sessionId&fingerprint&located=1&lat&lon
//   located=1: only events with a location; lat+lon: only events in that ~11 km map cell
//   q = case-insensitive substring over path / selector / element text / error message / http url / name
export interface EventsResponse {
  events: AnalyticsEvent[];
  nextBefore: string | null; // pass as `before` for the next page
}

// ---------- OpenTelemetry ----------
export interface SpanEvent {
  name: string;
  ts: string;
  attributes: Record<string, unknown>;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number; // OTLP SpanKind: 0 unspecified, 1 internal, 2 server, 3 client, 4 producer, 5 consumer
  service: string;
  start: string;
  end: string;
  durationMs: number;
  statusCode: number; // 0 unset, 1 ok, 2 error
  statusMessage: string | null;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  events: SpanEvent[];
}

// GET /api/projects/{pid}/traces?from&to&service&minDurationMs&errorsOnly=1&q&limit=100
export interface TraceSummary {
  traceId: string;
  rootName: string;
  service: string;
  start: string;
  durationMs: number;
  spanCount: number;
  errorCount: number;
  services: string[];
}

// GET /api/projects/{pid}/traces/{traceId}?at=  -> { spans: Span[] }  (sorted by start)
//   `at`: optional ISO time within the trace (its start, a log record's time). Spans are stored per day: with it,
//   the lookup reads that day first; without, the last two days, then everything still stored.
export interface TraceResponse {
  spans: Span[];
}

// GET /api/projects/{pid}/services?from&to
export interface ServiceRow {
  service: string;
  spans: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
}

// GET /api/projects/{pid}/logs?from&to&before&severity=<min severityNumber>&service&traceId&q&limit=200
export interface LogRecord {
  id: string;
  ts: string;
  severityNumber: number; // OTLP: 1-4 trace, 5-8 debug, 9-12 info, 13-16 warn, 17-20 error, 21-24 fatal
  severityText: string | null;
  body: string;
  service: string;
  traceId: string | null;
  spanId: string | null;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
}
export interface LogsResponse {
  logs: LogRecord[];
  nextBefore: string | null;
}

// GET /api/projects/{pid}/metrics?from&to  -> MetricInfo[]
export interface MetricInfo {
  name: string;
  type: 'gauge' | 'sum' | 'histogram' | 'exponential_histogram' | 'summary';
  unit: string | null;
  description: string | null;
  service: string;
  points: number;
  lastSeen: string;
}

// GET /api/projects/{pid}/metrics/series?name&from&to&agg=avg|sum|min|max|p95&groupBy=<attribute key, optional>
//   For histograms the per-point value is sum/count (mean).
export interface MetricSeriesResponse {
  bucketSeconds: number;
  series: Array<{ key: string; points: Array<{ t: string; value: number }> }>;
}

// ---------- realtime (WebSocket) ----------
// Connect: `${wsUrl}?token=<Cognito ID token>&projectId=<pid>`
// Client -> server (JSON, API Gateway route key = `action`):
//   { action: 'subscribe', watches: Watch[], firehose: boolean }   replaces the connection's subscription
//   { action: 'ping' }                                             keep-alive; send every ~5 min (idle timeout is 10 min)
// Server -> client:
//   { type: 'subscribed', watches: number, firehose: boolean }
//   { type: 'events', events: LiveEvent[] }      one message per ingested batch, only matching events (all events if firehose)
//   { type: 'pong' }

export interface Watch {
  id: string; // client-generated
  label: string;
  type: EventType; // usually 'click'
  // every provided field must match (case-insensitive substring match); omitted fields are wildcards
  selector?: string;
  text?: string;
  name?: string; // trackName for clicks, custom event name for 'custom'
  path?: string;
}

export interface LiveEvent extends AnalyticsEvent {
  matches: string[]; // watch ids this event matched
}

export type ServerMessage =
  | { type: 'subscribed'; watches: number; firehose: boolean }
  | { type: 'events'; events: LiveEvent[] }
  | { type: 'pong' };

// ---------- ingestion (public, keyed by write key) ----------
// POST {ingestUrl}/ingest          SDK batches (see sdk/README.md for the wire format)
// POST {ingestUrl}/v1/traces       OTLP/HTTP, JSON or protobuf
// POST {ingestUrl}/v1/logs         OTLP/HTTP, JSON or protobuf
// POST {ingestUrl}/v1/metrics      OTLP/HTTP, JSON or protobuf
//   OTLP auth: header `x-wgo-key: <writeKey>` (or `Authorization: Bearer <writeKey>`, or `?key=<writeKey>`)

// ---------- devices (Android home-screen widget) ----------
// A device token is a long-lived, read-only credential for one user. It only works on /widget/v1/*,
// sees the same projects as its user, and can be revoked from the dashboard. Only a SHA-256 hash is stored.
//
// Dashboard (Cognito):
// GET    /api/devices                      -> Device[]
// POST   /api/devices        {name}        -> DeviceCreated   (the token is returned exactly once)
// DELETE /api/devices/{id}                 -> {ok: true}
export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}
export interface DeviceCreated {
  device: Device;
  token: string; // dt_…
}

// Widget API (device token): `Authorization: Bearer <token>` or `x-wgo-device: <token>`, against apiUrl.
// GET /widget/v1/me                                             -> WidgetMe
// GET /widget/v1/projects/{pid}/catalog                         -> WidgetCatalog
// GET /widget/v1/projects/{pid}/summary?range&stats=<k1,k2,…>   -> WidgetSummary   (max 8 stats)
export interface WidgetMe {
  email: string;
  projects: Array<{ id: string; name: string }>;
}

export type WidgetRange = '1h' | '24h' | '7d' | '30d';
export type WidgetStatCategory = 'Traffic' | 'Engagement' | 'Reliability' | 'Performance' | 'Backend' | 'Tracked clicks' | 'Custom events' | 'Metrics';

export interface WidgetStatOption {
  key: string; // built-in key, or 'track:<name>' / 'event:<name>' / 'metric:<name>'
  label: string;
  description: string;
  category: WidgetStatCategory;
}
export interface WidgetCatalog {
  options: WidgetStatOption[]; // built-ins, then the project's tracked clicks, custom events and OTel metrics (last 7 days)
}

export interface WidgetStat {
  key: string;
  label: string;
  /** count = integer, ms = duration, score = unitless (CLS), text = see `text` */
  unit: 'count' | 'ms' | 'score' | 'text';
  value: number | null; // null = no data in range
  previous: number | null; // same-length window before the range (null when not comparable, e.g. visitors now)
  /** which direction is good, for colouring the delta */
  better: 'up' | 'down' | 'none';
  rating: 'good' | 'warn' | 'bad' | null; // Web Vitals thresholds
  text: string | null; // unit 'text': e.g. the top page path
  suffix: string | null; // display unit for OTel metrics, e.g. 'By' or 'requests'
  series: number[]; // evenly spaced points across the range for a sparkline (may be empty)
  page: string; // dashboard page to open, e.g. 'errors'
}
export interface WidgetSummary {
  project: { id: string; name: string };
  range: WidgetRange;
  from: string;
  to: string;
  generatedAt: string;
  stats: WidgetStat[];
}

// ---------- kiosks: wall displays without sign-in (e.g. a Raspberry Pi, set up with /downloads/wgo-kiosk.sh) ----------
// A kiosk shows one or more dashboard pages of a project in turn. Its URL, <dashboard>/#/kiosk/<token>, is the only
// credential: anyone with it can read that project's analytics, nothing else. Project members choose what it shows
// from the dashboard, and the screen picks up changes within about 15 seconds.
//
// GET    /api/projects/{pid}/kiosks                                    -> Kiosk[]
// POST   /api/projects/{pid}/kiosks       {name, config?}              -> Kiosk
// PATCH  /api/projects/{pid}/kiosks/{id}  {name?, config?, reload?}    -> Kiosk    (reload: true = reload the page on the screen)
// POST   /api/projects/{pid}/kiosks/{id}/rotate                        -> Kiosk    (new URL; the old one stops working)
// DELETE /api/projects/{pid}/kiosks/{id}                               -> {ok: true}
//
// Kiosk API (kiosk token): `Authorization: Bearer <token>`, against apiUrl. No Cognito.
// GET /kiosk/v1/state?w=1920&h=1080        -> KioskState   (polled by the screen; w×h is shown in the dashboard)
// GET /kiosk/v1/{stats|clicks|…}           -> same as GET /api/projects/{pid}/{stats|clicks|…} for the kiosk's project
// Live WebSocket: connect with ?kiosk=<token> instead of ?token=…&projectId=…
export type KioskPage = 'overview' | 'live' | 'clicks' | 'errors' | 'network' | 'events' | 'traces' | 'logs' | 'metrics';

export interface KioskScreen {
  page: KioskPage;
  /** The page's URL query, as in the dashboard: time range, filters (f, lf, tf) and page options, e.g. `range=1h&f=[…]`. */
  params: string;
  title?: string; // caption on the screen (default: the page name)
  watches?: Watch[]; // 'live' only: the watches to count (a browser keeps its own watches locally; the kiosk gets a copy)
}
export interface KioskConfig {
  screens: KioskScreen[]; // 1-12, shown in turn
  rotateSeconds: number; // 10-3600: time per screen
  refreshSeconds: number; // 15-3600: how often the data reloads
  theme: 'dark' | 'light';
  zoom: number; // 0.5-3: page zoom, for screens read from across the room
}
export interface Kiosk {
  id: string;
  name: string;
  token: string; // the secret in the kiosk URL (members can see it, like the write key)
  config: KioskConfig;
  reloadAt: string | null; // set by PATCH {reload: true}; the screen reloads the page when it changes
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null; // the screen polls every ~15 s; recorded at most once a minute
  display: string | null; // screen size the kiosk reports, e.g. "1920×1080"
}
export interface KioskState {
  kiosk: { id: string; name: string };
  project: { id: string; name: string };
  config: KioskConfig;
  reloadAt: string | null;
  version: string; // changes whenever the config, the name or reloadAt does
}
