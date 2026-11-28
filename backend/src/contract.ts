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
  /** When this install was deployed (ISO time), and the git commit it was built from with that commit's date; empty when not deployed from a git checkout. */
  deployedAt?: string;
  commit?: string;
  commitDate?: string;
  /** False turns off the dashboard's check for newer commits on GitHub (UPDATE_CHECK=false). Absent = on. */
  updateCheck?: boolean;
  /** Where AI assistants connect over MCP (the McpUrl stack output, e.g. https://wgo.example.com/mcp). Whether MCP is on is Me.features.mcp. */
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
  // which hosts count as development traffic besides the built-in ones
  devTraffic: DevTrafficSettings;
}

// PATCH /api/projects/{pid} {devTraffic} (owners only). Development traffic is stored with AnalyticsEvent.bot =
// 'development' and left out like bots unless `dev=1`. Built in: localhost, loopback/private/link-local addresses,
// single-label names, local-only domains (.localhost, .local, .internal, .lan, …) and pages opened from disk (file:);
// these are also checked against the page URL at query time, so events stored before flagging count too. Mobile SDK
// events never are.
//   hosts: extra wildcard patterns on the page's hostname, e.g. "*.vercel.app" or "*.test" (case-insensitive,
//          `*` = anything; at most 50). Applies to events arriving within a minute after saving.
export interface DevTrafficSettings {
  hosts: string[];
}

// GET /api/projects/{pid}/upload-key and POST /api/projects/{pid}/rotate-upload-key (owners only; 403 otherwise)
//   CI secret for `wgo-sourcemaps` / POST /sourcemaps/upload-url (header x-wgo-upload-key). Created on first read.
export interface UploadKey {
  uploadKey: string; // uk_…
}

// GET /api/projects/{pid}/site                    -> ProjectSite   (any member)
// GET /api/projects/{pid}/site/image?day=YYYY-MM-DD -> { image: string }  a data:image/jpeg URL; 404 once replaced
// The public website behind a project: the origin with the most pageviews in the last 3 days (re-checked daily,
// localhost and private addresses left out), and a screenshot of its homepage taken at most once a day. `image`
// is null until the first screenshot works; the dashboard caches the image per `day`. `icon` is the site's favicon
// (best of SVG, apple-touch-icon, largest <link rel=icon>, /favicon.ico) fetched in the same daily visit.
export interface ProjectSite {
  origin: string | null; // e.g. https://www.example.com
  icon: string | null; // data:image/… URL, at most 64 KB
  image: { day: string; takenAt: string } | null; // day = YYYY-MM-DD (UTC) the screenshot was taken
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
// DELETE /api/projects/{pid}                      -> {ok: true}    (owner; gone at once, its data is removed in the background)
// POST   /api/projects/{pid}/rotate-key           -> Project       (owner)
// GET    /api/projects/{pid}/members              -> Member[]
// POST   /api/projects/{pid}/members  {email}     -> Member        (owner; invited user gains access on next login with that email)
// DELETE /api/projects/{pid}/members/{email}      -> {ok: true}    (owner; cannot remove last owner)
export interface Me {
  email: string;
  projects: Project[];
  admin: boolean; // can see what the install costs and manage budgets (ADMIN_EMAILS; unset: the first project's owners)
  features: InstallFeatures;
}
/** What admins turned on for the whole install (dashboard, not deploy settings). */
export interface InstallFeatures {
  fixAgent: boolean; // the GitHub Agent
  mcp: boolean; // the MCP server for AI assistants, with Cognito client registration
  slackApp: boolean; // the install has a Slack app: "Add to Slack" works in every project
}
// GET /api/install (admins): the install-wide settings behind InstallFeatures
export interface InstallSettings extends InstallFeatures {
  slack: { clientId: string | null; secretSet: boolean; fromEnv: boolean; redirectUrl: string; createAppUrl: string };
  mcpUrl: string | null; // where MCP clients connect (the deployed McpUrl)
}
// PATCH /api/install/mcp {enabled}, PUT /api/install/slack {clientId, clientSecret}, DELETE /api/install/slack

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
  missingSourcemaps?: MissingSourcemaps; // set when errorStack points at scripts without an uploaded source map
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
  // why this is left out: a bot ('user-agent' | 'automation' | 'timezone-mismatch') or 'development' traffic
  // (DevTrafficSettings); null for humans
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
// Events-scope endpoints leave out bot traffic (AnalyticsEvent.bot) unless `bots=1`, and development traffic
// (bot = 'development', see DevTrafficSettings) unless `dev=1`.
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
//   X-WGO-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the signing secret>
// The secret is the trigger's signingSecret for a one-off webhook URL, and the destination's signingSecret for a saved
// webhook destination (then X-WGO-Destination carries its id), so one receiver can verify every trigger that uses it.
// Webhook URLs on hooks.slack.com receive a Slack-formatted message instead.
export type TriggerDestination =
  | { type: 'webhook'; url: string } // one-off URL: https only; private/internal addresses are rejected
  | { type: 'slack'; integrationId: string } // a Slack channel of the project (see SlackSetup)
  | { type: 'saved'; destinationId: string }; // a saved destination: the project's, or an account's (see Destination)

// ---------- saved destinations ----------
// Reusable places a trigger can notify, at two levels:
//   project: usable by every trigger in the project; any member manages them (like triggers)
//   account: yours, usable by triggers in every project you're a member of; only you manage them. Other members of a
//            project where a trigger uses yours see its name, type and host, never the URL or secret. When you leave
//            a project, its triggers stop sending to your destinations.
// Slack channels are added from a connected Slack workspace (see SlackSetup); webhooks are saved here.
//
// GET    /api/destinations                          -> Destination[]   your account destinations
// POST   /api/destinations          DestinationInput -> Destination     (a webhook)
// PATCH  /api/destinations/{id}     Partial<DestinationInput> -> Destination
// DELETE /api/destinations/{id}                     -> { ok: true }    409 while a trigger uses it
// POST   /api/destinations/{id}/test                -> TriggerTestResult
// GET    /api/projects/{pid}/destinations           -> Destination[]   the project's, then yours: everything a trigger
//                                                                      you save in this project can pick
// POST   /api/projects/{pid}/destinations  DestinationInput -> Destination   (a project webhook)
// PATCH  /api/projects/{pid}/destinations/{id}  Partial<DestinationInput> -> Destination
// DELETE /api/projects/{pid}/destinations/{id}      -> { ok: true }    409 while a trigger uses it
// POST   /api/projects/{pid}/destinations/{id}/test -> TriggerTestResult
export type DestinationLevel = 'project' | 'account';
export interface Destination {
  id: string;
  level: DestinationLevel;
  type: 'webhook' | 'slack';
  name: string; // webhooks: the name given; Slack: the channel, e.g. "#alerts"
  detail: string | null; // webhooks: the URL's host; Slack: the workspace
  url?: string; // webhooks you can edit
  signingSecret?: string; // webhooks you can edit
  owner: string | null; // account destinations: the owner's email
  editable: boolean;
  ref: TriggerDestination; // put this in a trigger's `destination` to use it
  createdBy: string;
  createdAt: string;
}
export interface DestinationInput {
  name: string; // 1-120 characters
  url: string; // https; hooks.slack.com URLs get a Slack message
}

// Kinds of trigger:
//   match:     every new row matching `filters` (checked as data arrives)
//   threshold: a number over the last `windowMinutes` crosses a value (checked every minute)
//   anomaly:   a number over the last `windowMinutes` is unusual for that time of day, compared with the same window
//              on each of the previous 7 days (checked every minute)
// threshold and anomaly notify when they start firing and when they resolve; the cooldown is the least time between
// two "firing" notifications.
export type TriggerKind = 'match' | 'threshold' | 'anomaly';
export type TriggerAgg = 'count' | 'sessions' | 'session_rate' | 'avg' | 'p75' | 'p95';
export interface TriggerMetric {
  agg: TriggerAgg; // count of matching rows; sessions with a match; share of all sessions with a match (events, 0..1);
                   // avg/p75/p95 of `field` over matching rows
  field?: string; // numeric field for avg/p75/p95, e.g. durationMs or props.lcp
}
export type TriggerCondition =
  | { op: 'above' | 'below'; value: number } // threshold ("below 1" over 30 minutes: nothing arrived)
  | { direction: 'up' | 'down' | 'either'; sensitivity: 'low' | 'medium' | 'high' }; // anomaly
export const TRIGGER_WINDOWS = [5, 15, 30, 60, 360, 1440] as const;

// A trigger's own Slack message: Slack Block Kit blocks (https://api.slack.com/block-kit, max 50; header, section,
// context, divider, actions, image, rich_text) in which any string may contain {{variables}} (SLACK_TEMPLATE_VARIABLES).
// Used when the trigger notifies Slack (a channel, or a hooks.slack.com webhook); other webhooks get the JSON payload.
// If Slack rejects the blocks, the default message is sent instead and the status says so.
export interface SlackTemplate {
  blocks: Array<Record<string, unknown>>;
}
/** Variables of a Slack template. `kinds`: the trigger kinds that have it (all when absent). */
export const SLACK_TEMPLATE_VARIABLES: ReadonlyArray<{ name: string; description: string; kinds?: TriggerKind[] }> = [
  { name: 'headline', description: 'The default header: 🔔 and the trigger name (✅ Resolved when it resolves, [test] for tests)' },
  { name: 'summary', description: 'The default summary: "3 matching events in Shop", or what a threshold/anomaly trigger measured' },
  { name: 'matches_list', description: 'The most recent matches (up to 5), one bullet each', kinds: ['match'] },
  { name: 'trigger.name', description: 'Trigger name' },
  { name: 'project.name', description: 'Project name' },
  { name: 'matches', description: 'Number of matching rows, including ones held back by the cooldown', kinds: ['match'] },
  { name: 'url', description: 'Dashboard link to the matching rows' },
  { name: 'time', description: 'When it fired, in each reader’s own time zone, e.g. “Today 14:05” (in UTC in plain text such as headers)' },
  { name: 'firedAt', description: 'When it fired (ISO 8601, UTC)' },
  { name: 'state', description: 'firing or resolved', kinds: ['threshold', 'anomaly'] },
  { name: 'value', description: 'The measured value, formatted', kinds: ['threshold', 'anomaly'] },
  { name: 'explanation', description: 'What the change comes from, when known', kinds: ['threshold', 'anomaly'] },
  { name: 'event.<field>', description: 'A field of the most recent matching event, e.g. event.path, event.errorMessage, event.props.plan', kinds: ['match'] },
  { name: 'log.<field>', description: 'A field of the most recent matching log record, e.g. log.body, log.service, log.attributes.user_id', kinds: ['match'] },
  { name: 'span.<field>', description: 'A field of the most recent matching span, e.g. span.name, span.durationMs, span.attributes.http.route', kinds: ['match'] },
];

export interface TriggerInput {
  name: string;
  scope?: FilterScope; // what it watches; default 'events'. Can't be changed after creation.
  filters: Filter[]; // at least one for match triggers; may be empty for threshold/anomaly (all rows of the scope)
  destination: TriggerDestination;
  cooldownSeconds?: number; // default 300, min 0, max 86400
  enabled?: boolean; // default true
  kind?: TriggerKind; // default 'match'. Can't be changed after creation.
  metric?: TriggerMetric; // threshold/anomaly
  condition?: TriggerCondition; // threshold/anomaly
  windowMinutes?: number; // threshold/anomaly: one of TRIGGER_WINDOWS
  slackTemplate?: SlackTemplate | null; // the Slack message's design; null or absent: the default message
}

/** Current state of a threshold/anomaly trigger. */
export interface TriggerStatus {
  state: 'ok' | 'firing' | null; // null: not evaluated yet
  since: string | null;
  lastValue: number | null;
  lastEvaluatedAt: string | null;
  baseline: { median: number; low: number; high: number; days: number } | null; // anomaly: the usual range
}

// POST /api/projects/{pid}/triggers/preview  TriggerInput -> TriggerPreview: the number right now, without saving
export interface TriggerPreview {
  value: number | null; // null: no data (avg/percentiles of nothing)
  fires: boolean;
  baseline: TriggerStatus['baseline'];
  window: { from: string; to: string };
  note?: string; // e.g. "Not enough history yet: anomaly triggers need 3 days of data"
}

export interface Trigger extends Required<Omit<TriggerInput, 'metric' | 'condition' | 'windowMinutes' | 'slackTemplate'>> {
  slackTemplate: SlackTemplate | null;
  metric: TriggerMetric | null; // null for match triggers
  condition: TriggerCondition | null;
  windowMinutes: number | null;
  id: string;
  signingSecret: string; // for verifying one-off webhook signatures (saved webhooks use the destination's)
  createdBy: string;
  createdAt: string;
  lastFiredAt: string | null;
  fireCount: number;
  lastStatus: string | null; // e.g. "200", "slack: channel_not_found", "timeout"
  status: TriggerStatus | null; // threshold/anomaly only
  destinationLabel: { name: string; detail: string | null; owner: string | null; type: 'webhook' | 'slack' } | null; // saved destinations
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
  // threshold/anomaly triggers (events/logs/spans are then empty)
  kind?: TriggerKind;
  state?: 'firing' | 'resolved';
  value?: number | null;
  metric?: TriggerMetric;
  condition?: TriggerCondition;
  windowMinutes?: number;
  baseline?: TriggerStatus['baseline'];
  explanation?: string; // events count metrics: what the change comes from (see GET /explain)
}

// Slack. A connected workspace (WGO's bot is in it) lets you pick channels from a list, as often as you like, without
// going back to Slack. A workspace and its channels are a project's (any member uses and manages them) or your own
// (only you; your channels are your account destinations, usable in all your projects).
// Channels connected before workspaces existed post through an incoming webhook and keep working.
// A workspace is connected with a bot token: create the WGO Slack app from createAppUrl (pre-filled), click Install
// to Workspace and paste its Bot User OAuth Token. When the instance has a Slack app of its own (set by an admin
// on the Triggers page, `addToSlack`), "Add to Slack" connects one without creating an app.
// GET    /api/projects/{pid}/integrations              -> SlackIntegration[]   the project's channels
// DELETE /api/projects/{pid}/integrations/{id}         -> { ok: true }
// GET    /api/projects/{pid}/slack                     -> SlackSetup   (for the caller)
// POST   /api/projects/{pid}/slack/workspaces {token, level?: 'project'|'account'} -> SlackWorkspace   checked with
//        Slack (auth.test); 400 for a token that isn't a bot token, expires or lacks SLACK_BOT_SCOPES. Connecting a
//        workspace again updates its token.
// GET    /api/projects/{pid}/slack/install?level=project|account -> { url }  (addToSlack only) open it: Slack asks for
//        the workspace, then redirects back to the dashboard
//        (#/p/{pid}/triggers?slack=connected|cancelled|scopes|error&slack_level=…). 409 without an instance app.
// GET    /api/projects/{pid}/slack/workspaces/{wid}/channels -> SlackChannel[]   public channels, and private ones
//        WGO's bot was invited to
// POST   /api/projects/{pid}/slack/workspaces/{wid}/channels {channelId} -> Destination   at the workspace's level
// DELETE /api/projects/{pid}/slack/workspaces/{wid}    -> SlackSetup   409 while channels use it
export const SLACK_BOT_SCOPES = ['chat:write', 'chat:write.public', 'channels:read', 'groups:read'] as const;
export interface SlackSetup {
  addToSlack: boolean; // the instance has a Slack app: "Add to Slack" (GET …/slack/install) connects a workspace
  createAppUrl: string; // opens Slack's "create app" with everything pre-filled; you only pick the workspace
  workspaces: SlackWorkspace[]; // the project's, then your own
}
export interface SlackWorkspace {
  id: string;
  level: DestinationLevel;
  teamName: string | null;
  channels: number; // channels added from it
  createdBy: string;
  createdAt: string;
}
export interface SlackChannel {
  id: string; // e.g. C0123456789
  name: string; // "#alerts"
  private: boolean;
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

// GET /api/projects/{pid}/flows?from&to[&filters&bots][&start=<path>][&steps=3..7]
//   How sessions move through the site, from raw events (the project's retention): the pages they view one after
//   another (reloads collapsed), step 1 being the entry page or, with `start`, the first view of that page (sessions
//   that never view it are left out). Each step lists its top pages, the rest as '(other)'. The filters choose
//   sessions: a session counts when any of its events matches (bots are left out unless bots=1).
//   Errors: error and http_error events of the session while it was on that page at that step (from its view up to
//   the next page's view).
export const FLOW_OTHER = '(other)';
export interface FlowError {
  key: string; // the error message (first 200 characters) or "POST /api/checkout 502"
  sessions: number;
}
export interface FlowNode {
  step: number; // 0 = the entry (or start) page
  key: string; // the page path, or FLOW_OTHER
  sessions: number; // sessions on this page at this step
  exits: number; // of those, sessions that left after this page (on the last step: the rest went on past the chart)
  errors: number; // sessions that hit an error on this page at this step
  errorExits: number; // of those, how many left after this page
  topErrors: FlowError[]; // the most common errors here, top 3
}
export interface FlowLink {
  step: number; // from a node of this step to one of the next
  from: string;
  to: string;
  sessions: number;
}
export interface FlowExitPage {
  path: string;
  views: number; // sessions that viewed it (from the start page on, every step, not only the charted ones)
  exits: number; // sessions whose last page it was
  rate: number; // exits / views
  errorViews: number; // sessions that hit an error on it
  errorExits: number; // of those, sessions that left on it
}
export interface FlowsResponse {
  start: string | null;
  steps: number;
  sessions: number; // sessions in the chart: with a pageview (and, with `start`, that reached it)
  nodes: FlowNode[]; // per step, by sessions (FLOW_OTHER last)
  links: FlowLink[];
  exitPages: FlowExitPage[]; // top 10 by exits
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
  devSessions?: number; // sessions left out as development traffic in this range (when it isn't included)
}

// GET /api/projects/{pid}/hours?from&to&tz=Europe/Stockholm[&filters]
//   Traffic per hour of the day in `tz` (an IANA zone, the viewer's), summed over the range. Read like /stats
//   (hourly rollups for long ranges): each UTC hour is placed by its midpoint, so half-hour zones round to an hour.
export interface HoursResponse {
  tz: string;
  hours: Array<{ hour: number; pageviews: number; events: number }>; // 24 rows, hour 0-23
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

// GET /api/projects/{pid}/frustration?from&to&limit=50&filters  → FrustrationRow[]
// Click targets where visitors got stuck, most frustrating first. Grouped like ClickRow (selector, with the alias
// merging different texts). Rage: 3+ quick clicks (props.rage). Dead: the SDK saw nothing change within 1 s of
// the click (props.dead). Error: a JavaScript error or failed request in the same session within 2 s after the click.
export interface FrustrationSample {
  sessionId: string; // a recorded session where it happened
  at: number; // epoch ms of the click, for the player's ?t= seek
}
export interface FrustrationRow {
  selector: string;
  elementText: string | null;
  trackName: string | null;
  elementTag: string | null;
  alias: string | null;
  clicks: number; // all clicks on the target
  rageClicks: number;
  rageSessions: number;
  deadClicks: number;
  deadSessions: number;
  errorClicks: number;
  errorSessions: number;
  samples: FrustrationSample[]; // up to 3, newest first, only sessions that have a recording
}

// GET /api/projects/{pid}/heatmap?path&from&to&device=desktop|mobile (mobile = phones and tablets; default desktop)
// Click density on one page. Points are page coordinates (not viewport) in 8 px buckets, for clicks made in browser
// windows of the most common width (`vw`, grouped in 100 px steps); `total` counts those clicks.
// `snapshot` is the most recent recorded session of that device type that viewed the page, `at` the epoch ms of
// its pageview: render that page's DOM from the recording behind the points.
export interface HeatmapPoint {
  x: number;
  y: number;
  n: number;
}
export interface HeatmapResponse {
  vw: number;
  points: HeatmapPoint[];
  total: number;
  snapshot: { sessionId: string; at: number } | null;
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
  sampleStack: string | null; // symbolicated when an uploaded source map matches (see minifiedStack)
  minifiedStack: string | null; // the stack as the browser reported it; set only when mapping changed something
  stackFrames?: StackFrame[]; // parsed frames of sampleStack, with code context for mapped ones
  missingSourcemaps?: MissingSourcemaps; // set when sampleStack points at scripts without an uploaded source map
  sampleUrl: string | null;
  source: string | null;
  series: number[]; // 24 equal buckets across [from,to] for a sparkline
  suppressedBy?: string | null; // id of an error suppression rule covering this group (new ones are dropped at ingest)
  fix?: FixSummary | null; // the latest GitHub Agent run for this group (set only when the project uses the GitHub Agent)
}

/**
 * A stack whose frames are in your own scripts but none of them could be mapped: no source map was uploaded for
 * these script files (for this release, or without one). Upload them with the `upload_sourcemaps` MCP tool or the
 * `wgo-sourcemaps` CLI.
 */
export interface MissingSourcemaps {
  release: string | null; // the SDK's release label the stack came from; null when the app sets none
  files: string[]; // script file names without a map, e.g. index-abc123.js (at most 10)
}

export interface StackFrame {
  fn: string | null;
  file: string; // original source path when mapped, else the script URL
  line: number;
  col: number;
  mapped: boolean;
  context?: { start: number; lines: string[] }; // source lines, `start` = 1-based number of lines[0]
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
  sampleTraceId: string | null; // a recent failure's trace id (the SDK's traceparent), when it sent one
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
  spans: Span[]; // includes a synthetic root span (service "browser") for each failed browser request that started it
  browser?: BrowserRequest[]; // the failed browser requests (http_error events) that sent this trace's traceparent
}

/** A failed request from the browser SDK that started a backend trace (it sent the trace's traceparent). */
export interface BrowserRequest {
  eventId: string;
  ts: string; // when the request ended
  spanId: string; // the parent span id the SDK sent
  method: string;
  url: string | null;
  route: string | null;
  status: number; // 0 = network failure
  durationMs: number | null;
  sessionId: string | null;
  anonId: string | null;
  userId: string | null;
  path: string | null; // the page it was made from
  browser: string | null;
  os: string | null;
  country: string | null;
  city: string | null;
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

// GET /api/projects/{pid}/metrics/series?name&from&to&agg=avg|sum|min|max|p95&service=<optional>&groupBy=<attribute key, optional>
//   For histograms the per-point value is sum/count (mean). groupBy=service.name splits by reporting service.
export interface MetricSeriesResponse {
  bucketSeconds: number;
  series: Array<{ key: string; points: Array<{ t: string; value: number }> }>;
  attributeKeys: string[]; // data point attribute keys seen on recent points (group-by choices)
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
// GET /widget/v1/overview?range&stats=<k1,k2,k3>                 -> WidgetOverview  (every project; max 3 built-in, non-text stats)
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
export interface WidgetOverview {
  range: WidgetRange;
  from: string;
  to: string;
  generatedAt: string;
  total: number; // projects the user can see; `projects` holds at most 30 of them
  /** busiest first, by the first stat */
  projects: Array<{ project: { id: string; name: string }; stats: WidgetStat[]; error: string | null }>;
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
export type KioskPage = 'overview' | 'live' | 'clicks' | 'errors' | 'network' | 'events' | 'traces' | 'logs' | 'metrics' | 'dashboard';

export interface KioskScreen {
  page: KioskPage;
  /** The page's URL query, as in the dashboard: time range, filters (f, lf, tf) and page options, e.g. `range=1h&f=[…]`. */
  params: string; // dashboard: id=<dashboard id> plus range and f
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

// ---------- session recordings ----------

/**
 * Starts a recording when it matches, even for a session the sample didn't pick (the hourly and daily limits
 * still apply). page: path glob (`/checkout*`); click: CSS selector; event: custom event name; error: text in a
 * JavaScript error or failed request (empty: any).
 */
export type RecordingTriggerType = 'page' | 'click' | 'event' | 'error';
export interface RecordingTrigger {
  type: RecordingTriggerType;
  value: string;
}

/** A project's recording settings. Off until an owner turns them on. */
export interface RecordingSettings {
  enabled: boolean;
  /** share of sessions recorded, 0–100 */
  samplePercent: number;
  triggers: RecordingTrigger[];
  /** most sessions that may start recording in any 60 minutes / 24 hours; null = no limit */
  maxPerHour: number | null;
  maxPerDay: number | null;
  /** replace all text on the page with asterisks (form values are never recorded either way) */
  maskAllText: boolean;
}

export interface RecordingSettingsResponse {
  settings: RecordingSettings;
  /** recordings started in the last 60 minutes and 24 hours */
  usage: { lastHour: number; lastDay: number };
  /** recordings are kept this many days (at most the project's retention) */
  retentionDays: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface RecordingSummary {
  sessionId: string;
  startedAt: string;
  /** when the last recorded activity happened (null while nothing has been stored yet) */
  endedAt: string | null;
  durationMs: number;
  /** why it was recorded: `sample`, or `trigger:<type>[:<value>]` */
  reason: string;
  anonId: string | null;
  userId: string | null;
  entryPath: string | null;
  pages: number;
  clicks: number;
  /** clicks that were part of a rage-click burst (3+ quick clicks on one element) */
  rageClicks: number;
  errors: number;
  /** events other than page views and web vitals (clicks, custom events, errors, identify calls) */
  events: number;
  /** the visitor clicked, tapped, scrolled, typed or hovered something clickable (for older recordings: viewed 2+ pages or caused other events) */
  active: boolean;
  /** distinct pages viewed, in the order first seen (at most 20) */
  paths: string[];
  browser: string | null;
  os: string | null;
  device: string | null;
  country: string | null;
  city: string | null;
}

/**
 * Filters of GET /recordings (query parameters). Recordings shorter than 3 seconds are never listed.
 * - minDuration / maxDuration: length in seconds
 * - page: a page viewed in the session; `*` is a wildcard, otherwise any path containing the text
 * - device: desktop | mobile | tablet; reason: sample | trigger
 * - errors=1, rage=1, identified=1: only sessions with errors / rage clicks / a known user
 * - inactive=1: also list recordings in which the visitor did nothing (see RecordingSummary.active), which are
 *   hidden otherwise (mostly tabs left open); errors=1 lists them too
 * - q: text in the user, visitor id, pages, location, browser, OS or reason
 */
export interface RecordingFilters {
  minDuration?: number;
  maxDuration?: number;
  page?: string;
  device?: string;
  reason?: 'sample' | 'trigger';
  errors?: boolean;
  rage?: boolean;
  identified?: boolean;
  inactive?: boolean;
  q?: string;
}

export interface RecordingsResponse {
  recordings: RecordingSummary[];
  /** pass as `before` for the next (older) page; set while older recordings may match */
  nextBefore: string | null;
}

/**
 * Part of a recording, as the SDK sent it (sdk/src/replay/recorder.ts describes the records). `page` identifies
 * one page load (tab): a session open in two tabs has two.
 */
export interface RecordingChunk {
  ts: string;
  page: string;
  seq: number;
  /** ms from `ts` to its last record */
  dur: number;
  url: string | null;
  r: unknown[][];
}

export interface RecordingResponse {
  recording: RecordingSummary;
  chunks: RecordingChunk[];
  /** more chunks follow: pass as `after` */
  nextAfter: string | null;
}

// ---------- Releases ----------
// GET /api/projects/{pid}/releases?from&to&filters[&markers=1]   markers=1: only `markers` (web and services empty)
// Versions come from the SDK's `release` option (web) and OpenTelemetry's service.version (services). Each version
// active in the range is compared with the one deployed before it (by first seen), when that one is active too.
export type Verdict = 'better' | 'worse' | null; // null: no clear difference, or not enough data

export interface ReleaseHealth {
  version: string;
  firstSeen: string; // first time any event carried it (kept beyond raw retention)
  lastSeen: string;
  sessions: number;
  errorSessions: number; // sessions with at least one JavaScript error
  failedRequestSessions: number; // sessions with a 5xx or network failure
  errors: number;
  vitals: { samples: number; lcp: number | null; inp: number | null; cls: number | null }; // p75
  goals: Array<{ id: string; name: string; converted: number; rate: number }>; // sessions converting / sessions
  newErrors: Array<{ fingerprint: string; message: string; count: number }>; // error groups first seen under this release
  previous: string | null; // the version it's compared with
  verdicts: Record<string, Verdict>; // keys: errorSessions, failedRequestSessions, lcp, inp, cls, goal:<id>
}

export interface ServiceVersionHealth {
  service: string;
  version: string;
  firstSeen: string;
  lastSeen: string;
  spans: number;
  errors: number; // spans with status error
  p50Ms: number | null; // server spans (kind 2) when there are any, else all spans
  p95Ms: number | null;
  previous: string | null;
  verdicts: Record<string, Verdict>; // keys: errorRate, p95
}

export interface ReleaseMarker {
  kind: 'web' | 'service';
  service: string; // '' for web releases
  version: string;
  firstSeen: string;
}

export interface ReleasesResponse {
  web: ReleaseHealth[]; // newest first
  services: ServiceVersionHealth[]; // per service, newest first
  markers: ReleaseMarker[]; // versions first seen inside the range (deploys), oldest first
}

// ---------- Explanations ("why did this change?") ----------
// GET /api/projects/{pid}/explain?metric=events|sessions|goal&where=<filters JSON>&goalId&from&to[&baseFrom&baseTo][&filters]
//   events: events matching `where` (e.g. type = error); sessions: sessions with such an event; goal: a goal's
//   conversion rate. The baseline defaults to the window of the same length right before `from`.
export type ExplainMetric = 'events' | 'sessions' | 'goal';
export type ExplainDim = 'path' | 'browser' | 'os' | 'device' | 'country' | 'release' | 'source' | 'entry' | 'error' | 'request';

export interface ExplainDriver {
  dim: ExplainDim;
  key: string;
  current: number; // count in the current window (goal: sessions)
  previous: number; // count in the baseline
  share: number; // share of the overall change this segment accounts for (0..1, can exceed 1 when others moved the other way)
  before: number; // its share of the baseline total (0..1): a segment that grew in line with the rest isn't a driver
  rate?: { current: number; previous: number }; // goal: the segment's conversion rate in each window
}

export interface Explanation {
  metric: ExplainMetric;
  label: string; // "Errors", "Sessions", "Signup conversion"
  current: number; // count, or rate (goal)
  previous: number;
  ratio: number | null; // current / previous
  significant: boolean; // beyond the noise expected from counts this size
  startedAt: string | null; // when the change began (single change point), if it's clear and inside the current window
  release: ReleaseMarker | null; // a version first seen around startedAt (or, without one, during the current window)
  drivers: ExplainDriver[]; // biggest first, at most 8
  bucketSeconds: number;
  series: Array<{ t: string; value: number }>; // baseline and current window, for a chart
  baseFrom: string;
  from: string;
  summary: string; // one plain sentence or three, times in UTC
}

// ---------- uptime checks ----------
// WGO fetches a URL on a schedule from the region where it is deployed and records every result (the `checks`
// raw table). A check is `down` after 2 failures in a row and `up` again after 1 success. Each state change is
// recorded as a custom event named `wgo.uptime` (props: check, checkId, url, state, status, error, durationMs),
// so a trigger like "name = wgo.uptime AND props.state = down" notifies Slack or a webhook. A new check's first
// success (null to up) is not recorded.
//
// GET    /api/projects/{pid}/uptime?from&to           -> UptimeCheck[]   (strip covers from..to, default 24h)
// POST   /api/projects/{pid}/uptime      UptimeCheckInput -> UptimeCheck   (max 20 per project)
// PATCH  /api/projects/{pid}/uptime/{id} Partial<UptimeCheckInput> -> UptimeCheck
// DELETE /api/projects/{pid}/uptime/{id}               -> { ok: true }
// POST   /api/projects/{pid}/uptime/{id}/run           -> UptimeRunResult   (checks now, records the result)
// GET    /api/projects/{pid}/uptime/{id}/results?from&to -> UptimeResults
export type UptimeState = 'up' | 'down';

export interface UptimeCheckInput {
  name: string;
  url: string; // http or https, public hosts only
  method?: 'GET' | 'HEAD'; // default GET
  expect?: string; // '2xx' (default), '3xx' or an exact status code such as '200'
  keyword?: string | null; // the body must contain it (GET only; the first 1 MB is read)
  intervalSeconds?: 60 | 300 | 900; // default 300
  timeoutMs?: number; // 1000-30000, default 10000
  enabled?: boolean; // default true
}

export interface UptimeCheck extends Required<UptimeCheckInput> {
  id: string;
  state: UptimeState | null; // null until the first result
  stateSince: string | null;
  lastCheckedAt: string | null;
  failStreak: number;
  lastStatus: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  createdBy: string;
  createdAt: string;
  /** 90 buckets over the requested range, oldest first: share of successful checks 0-1, null = no checks */
  strip: Array<number | null>;
}

export interface UptimeRunResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
}

export interface UptimeBucket {
  t: string;
  checks: number;
  failures: number;
  uptime: number | null; // 0-1, null when nothing was checked
  p50: number | null; // response time ms
  p95: number | null;
}

export interface UptimeIncident {
  from: string;
  to: string | null; // null: still down
  error: string | null;
}

export interface UptimeResults {
  buckets: UptimeBucket[];
  incidents: UptimeIncident[];
  uptime: number | null; // 0-1 over the range
  p50: number | null;
  p95: number | null;
}

// ---------- what the install costs ----------
// GET /api/costs?pid={pid}  -> CostsResponse
// Admins only (Me.admin; others get 403). `pid` must be one of the admin's projects. Amounts come from AWS Cost Explorer for the
// resources of this stack (tag aws:cloudformation:stack-name, which must be activated as a cost allocation tag),
// cached for 12 hours: Cost Explorer charges $0.01 per request. `setup: true` means no numbers are available yet.
// Categories: storage (S3, DSQL, DynamoDB and log storage), ingestion (taking events in and writing them), querying
// (the dashboard, MCP, widgets, kiosks and live view reading them) and other (background jobs, sign-in, logs).
// Lambda and DSQL compute are shared, so they are divided by CloudWatch metrics (lib/costSplit.ts): estimates.
export type CostCategory = 'storage' | 'ingestion' | 'querying' | 'other';
// What came in, counted from the hourly rollups (complete hours only): browser events (bots and suppressed errors not
// counted) and OpenTelemetry spans, log records and metric points. Signals sent before they were counted (or older
// than raw retention when counting started) are 0.
export interface SignalCounts { events: number; spans: number; logs: number; metricPoints: number }
// The ingestion cost by what was taken in (backend lib/costSplit.ts): browser events, and OpenTelemetry spans, logs and
// metric points together. Recordings and source maps are in neither. Estimates; 0 while CloudWatch has no numbers.
export interface IngestionPaths { events: number; otel: number }
export interface CostsResponse {
  setup: boolean;
  reason?: string; // set with `setup`: why there are no numbers
  currency: string;
  monthToDate: number;
  lastMonth: number;
  forecast?: number; // month-to-date projected linearly to the end of the month
  // last 30 days; `signals`: what the whole install took in that UTC day (absent only with `setup`)
  daily: Array<{ day: string; amount: number; byCategory: Record<CostCategory, number>; ingestion?: IngestionPaths; signals?: SignalCounts }>;
  services: Array<{ service: string; amount: number }>; // month to date, largest first
  // month to date, in the order storage, ingestion, querying, other; each with its services, largest first
  categories: Array<{ category: CostCategory; amount: number; services: Array<{ service: string; amount: number }> }>;
  ingestionPaths?: IngestionPaths; // month to date (absent with `setup`)
  usage: {
    eventsThisMonth: number; // = signalsThisMonth.events
    projectEventsThisMonth?: number; // with `pid`
    signalsThisMonth?: SignalCounts; // whole install (absent only with `setup`)
    projectSignalsThisMonth?: SignalCounts; // with `pid`
    // with `pid`: the project's estimated share of the cost (0-1): its share of the events and of the OpenTelemetry
    // items, weighted by what taking each in cost (without that split: its share of everything that came in)
    projectShare?: number;
    dataBucketBytes: number | null;
    dsqlStorageBytes: number | null;
  };
  fetchedAt: string;
}

// GET /api/projects/{pid}/retention?from&to&period=day|week|month&start=first_seen|goal:<goalId>&return=any|goal:<goalId>
//   &split=none|device|country|source
//   Retention cohorts from visitor_days, a per-visitor-per-day table built each night and kept 400 days (the range may be
//   that long; defaults to 12 weeks). Periods are UTC days, ISO weeks (Monday) or calendar months.
//   - start: a person's cohort is the period they were first seen (first_seen, looking back over everything stored, so
//     returning visitors are not counted as new) or first reached the goal.
//   - return: period k counts a person when they had any visit (any) or reached the goal in period k after their cohort.
//   - cohorts: newest period last, at most 30 days, 26 weeks or 13 months. values/counts have one entry per period
//     0..n, only for periods that are over; values = counts / size.
//   - average: size-weighted over the cohorts old enough for each period.
//   - splits: top 5 values of the split dimension by cohort size (the visitor's first day in the cohort), each with its
//     own average. Absent with split=none.
//   - dataSince: the first day (YYYY-MM-DD) visitor_days has data for, null before the first nightly run.
export type RetentionPeriod = 'day' | 'week' | 'month';
export interface RetentionCohort {
  start: string; // ISO timestamp of the period start
  size: number;
  values: number[];
  counts: number[];
}
export interface RetentionSplit {
  key: string;
  size: number;
  average: number[];
}
export interface RetentionResponse {
  period: RetentionPeriod;
  cohorts: RetentionCohort[];
  average: number[];
  splits?: RetentionSplit[];
  dataSince: string | null;
}

// ---------- Error suppression ----------
// GET    /api/projects/{pid}/error-suppressions                     -> ErrorSuppression[]
// POST   /api/projects/{pid}/error-suppressions  ErrorSuppressionInput -> ErrorSuppression   (max 100 per project)
// DELETE /api/projects/{pid}/error-suppressions/{id}                -> { ok: true }
// JavaScript errors matching a rule are dropped when they arrive: not stored, not counted, no triggers. Patterns are
// case-insensitive and match the whole value; `*` matches anything. `source` matches the failing resource or script
// URL, or just its path ("/materials/image/*"). Every set field must match. Errors stored before a rule existed stay;
// the Errors list marks the groups a rule covers (ErrorGroup.suppressedBy).
export type ErrorKind = 'error' | 'rejection' | 'resource' | 'manual';
export interface ErrorSuppressionInput {
  kind?: ErrorKind | null; // null/absent: any kind
  message?: string | null; // e.g. "*ResizeObserver loop*", "TypeError: *"
  source?: string | null; // e.g. "https://cdn.example.com/img/*" or "/img/*"
  page?: string | null; // page path, e.g. "/admin/*"
}
export interface ErrorSuppression extends ErrorSuppressionInput {
  id: string;
  createdBy: string;
  createdAt: string;
  hits: number; // errors dropped since it was created (approximate)
  lastHitAt: string | null;
}

// ---------- Cost budgets ----------
// GET    /api/projects/{pid}/collection     -> { paused: boolean }   any member: is a budget stopping collection?
// Budgets are for admins only (Me.admin; others get 403).
// GET    /api/costs/budgets                 -> Budget[]   install budgets, and project budgets of projects you own
// POST   /api/costs/budgets  BudgetInput    -> Budget     install: any admin; project: an admin who owns it
// PATCH  /api/costs/budgets/{id} Partial<BudgetInput> -> Budget
// DELETE /api/costs/budgets/{id}            -> { ok: true }
// POST   /api/costs/budgets/{id}/resume     -> Budget     collect data again for the rest of the month
// Spend comes from AWS Cost Explorer (it can lag a day behind); a project's spend is estimated from its share of the
// month's events. Checked every 15 minutes and whenever a budget is saved.
export type BudgetDestination =
  | { type: 'webhook'; url: string } // JSON POST, signed with X-WGO-Signature like triggers
  | { type: 'slack'; projectId: string; integrationId: string }; // a channel connected to one of your projects
export interface BudgetInput {
  scope: 'install' | 'project';
  projectId?: string | null; // project budgets
  monthlyLimit: number; // in the Cost Explorer currency (USD)
  alertAt: number[]; // percents of the limit, e.g. [50, 80, 100]; each alerts once a month
  alertOnForecast: boolean; // alert once when the month's forecast passes the limit
  pauseAtLimit: boolean; // stop storing new data once spend reaches the limit, until next month (or resume / a higher limit)
  destination: BudgetDestination | null; // null: only shown in WGO
  acknowledged?: boolean; // required to create: the user accepts that figures are estimates and the AWS bill is theirs
}
export interface BudgetStatus {
  month: string; // YYYY-MM (UTC)
  spent: number | null; // null: Cost Explorer isn't set up
  forecast: number | null;
  estimated: boolean; // project budgets: spent is a share of the install's cost
  alerted: number[]; // thresholds already alerted this month
  forecastAlerted: boolean;
  paused: boolean; // collection is stopped
  pausedAt: string | null;
  resumed: boolean; // resumed by hand this month: no pause until next month
  checkedAt: string | null;
  lastStatus: string | null; // the last notification's delivery result
}
export interface Budget extends Omit<BudgetInput, 'acknowledged'> {
  id: string;
  projectName: string | null;
  signingSecret: string;
  createdBy: string;
  createdAt: string;
  status: BudgetStatus;
}

// ---------- generic query (custom dashboards) ----------
// One measure over any source: events (web analytics), logs, spans, metrics (OpenTelemetry metric points) and
// checks (uptime check runs). Fields are the filter fields of the source (see GET /fields?scope=…): for metrics
// name, service, type, unit, value and attributes.<key>; for checks checkId, ok (1/0), status, durationMs, error, region.
export type QuerySource = 'events' | 'logs' | 'spans' | 'metrics' | 'checks';
export type QueryAgg =
  | 'count' // matching rows
  | 'sessions' | 'users' // distinct sessions / visitors (events)
  | 'session_rate' // share of sessions with a matching event, 0..1 (events; the measure's filters pick the matches)
  | 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p75' | 'p95' | 'p99' // over `field` (metrics: the point value)
  | 'rate'; // average of a 0/1 field, 0..1 (checks: `ok` by default, so uptime)
export interface MeasureQuery {
  source: QuerySource;
  agg: QueryAgg;
  field?: string; // numeric field for sum…p99 and rate; metrics default to the point value, checks to durationMs / ok
  metric?: string; // metrics: the OpenTelemetry metric name (required)
  filters?: Filter[]; // ANDed, in the source's fields
}
// GET /api/projects/{pid}/query?q=<JSON QuerySpec>&from&to[&filters=<JSON Filter[]>][&bots=1][&dev=1]
//   `filters` (dashboard-wide) apply to events measures only. Range at most 92 days.
export interface QuerySpec {
  measures: MeasureQuery[]; // 1-4
  groupBy?: string; // a field of the measure's source: split into one series / row per value (one measure only)
  shape: 'series' | 'total' | 'top'; // over time; one number; top values of groupBy
  limit?: number; // groups: series default 5, max 10; top default 10, max 50
  compare?: boolean; // also the total of the same-length window just before `from`
}
export interface QueryMeasureResult {
  total: number | null; // null: nothing to average
  previous?: number | null; // with compare
  series?: Array<{ key: string; label?: string; points: Array<{ t: string; value: number | null }> }>; // shape series; key '' without groupBy
  groups?: Array<{ key: string; label?: string; value: number | null }>; // with groupBy, biggest first
  // label: a readable name for a key that is an id (uptime checks: the check's name)
}
export interface QueryResult {
  bucketSeconds: number; // shape series
  measures: QueryMeasureResult[]; // in the order asked
}

// GET /api/projects/{pid}/measures -> MeasureNames: names seen in the last 7 days, for the measure picker
export interface MeasureNames {
  trackedClicks: string[]; // data-track names
  customEvents: string[];
  metrics: Array<{ name: string; type: MetricInfo['type']; unit: string | null; description: string | null }>;
}

// ---------- SQL editor ----------
// DuckDB SQL over the project's raw tables, for project members (not kiosks). Read-only and sandboxed: the query
// sees this project's tables and nothing else (no files, no network, no settings).
// POST /api/projects/{pid}/sql          body SqlRequest       -> SqlResult
// POST /api/projects/{pid}/sql/export   body SqlExportRequest -> SqlExport
// GET  /api/projects/{pid}/sql/schema                          -> SqlSchema
// Every table holds the rows of [from, to) only (default the last 24 hours, at most 92 days). One statement per
// request. A query that fails is a 400 with DuckDB's message, which usually ends in a `LINE n: …` excerpt with a ^
// under the position.
export interface SqlRequest {
  sql: string;
  from?: string;
  to?: string;
  limit?: number; // rows to return: default 1000, max 10000
}
export interface SqlColumn {
  name: string;
  type: string; // DuckDB type: VARCHAR, TIMESTAMP, JSON, BIGINT, INTEGER[], STRUCT(...)
}
export interface SqlResult {
  columns: SqlColumn[];
  // one array per row in column order. Numbers are numbers (strings past 2^53), timestamps 'YYYY-MM-DD HH:MM:SS[.fff]'
  // in UTC, JSON columns parsed, lists arrays, structs objects, maps [{ key, value }]
  rows: unknown[][];
  truncated: boolean; // there were more rows than `limit`, or than fit in one response
  elapsedMs: number;
  scanned: { files: number; bytes: number }; // the Parquet files behind the tables the query used
}
export interface SqlExportRequest {
  sql: string;
  from?: string;
  to?: string;
  format: 'csv' | 'ndjson';
}
export interface SqlExport {
  url: string | null; // download link, valid for 15 minutes. null from a local dev server, which sends `content` instead
  content?: string;
  filename: string;
  rows: number;
}
export interface SqlSchema {
  tables: Array<{
    name: string;
    description: string;
    timeColumn: string;
    columns: Array<{ name: string; type: string; description?: string }>;
  }>;
  functions: Array<{
    name: string;
    kind: 'scalar' | 'aggregate' | 'table' | 'macro' | 'table_macro' | 'pragma';
    signature: string; // e.g. "date_trunc(part VARCHAR, timestamp TIMESTAMP) → TIMESTAMP"; the first overload
    overloads: number;
    description: string | null;
  }>;
  keywords: string[];
}

// ---------- custom dashboards ----------
// A dashboard belongs to its project: every member sees and edits it.
// GET    /api/projects/{pid}/dashboards                 -> DashboardSummary[] (most recently updated first)
// GET    /api/projects/{pid}/dashboards/{id}            -> Dashboard  (also GET /kiosk/v1/dashboards/{id})
// POST   /api/projects/{pid}/dashboards  DashboardInput -> Dashboard
// PATCH  /api/projects/{pid}/dashboards/{id}  Partial<DashboardInput> -> Dashboard
// POST   /api/projects/{pid}/dashboards/{id}/duplicate  -> Dashboard
// POST   /api/projects/{pid}/dashboards/{id}/tiles  DashboardTile (id and layout optional: added below the others) -> Dashboard
// GET    /api/projects/{pid}/dashboards/{id}/tiles/{tileId}/data?from&to  -> SqlResult of a SQL tile's saved query
//        (also GET /kiosk/v1/dashboards/{id}/tiles/{tileId}/data: kiosks run a tile's query, never SQL of their own)
// DELETE /api/projects/{pid}/dashboards/{id}            -> 204
export type TileViz = 'number' | 'line' | 'area' | 'bars' | 'top' | 'table' | 'text'
  | 'columns' | 'pie' | 'scatter'; // SQL tiles only: bars per category, a donut of shares, numbers against numbers
export type TileUnit = 'count' | 'ms' | 's' | 'bytes' | 'percent' | 'score' | 'none';
export interface TileMeasure extends MeasureQuery {
  label?: string; // legend / column name
  unit?: TileUnit; // how values are shown; percent: a 0..1 share
  better?: 'up' | 'down'; // which way a change is good
}
export interface TileLayout { x: number; y: number; w: number; h: number } // 12 columns; x 0-11, w 1-12, h 1-12 rows
export interface DashboardTile {
  id: string; // 1-40 characters
  title?: string; // up to 120 characters
  viz: TileViz;
  measures: TileMeasure[]; // 1-4 (none for text)
  groupBy?: string;
  limit?: number;
  range?: string; // the tile's own range ('15m', '1h', '24h', '7d', '30d'); otherwise the dashboard's
  text?: string; // viz text: up to 2000 characters
  sql?: SqlTileQuery; // a SQL tile: any viz but text, and no measures
  layout: TileLayout;
}
// A tile that shows the result of a SQL query (see the SQL editor) over the tile's range. Columns left out are picked
// from the result: x the first time column (line/area/bars) or text column (top), y the numeric columns.
export interface SqlTileQuery {
  query: string; // one DuckDB statement, up to 20000 characters
  x?: string; // line/area/bars: a TIMESTAMP or DATE column; top/columns/pie: the label column; scatter: a numeric column
  y?: string[]; // 1-8 numeric columns; number, top, pie and scatter use the first
  series?: string; // line/area/bars/columns with one y column: a column whose values become the series (long format);
  //                  scatter: the column that colors the dots
  unit?: TileUnit;
}
export interface DashboardConfig {
  tiles: DashboardTile[]; // at most 40
  filters?: Filter[]; // default dashboard filters (events measures), applied when the URL has none
  range?: string; // default range
}
export interface DashboardInput {
  name: string; // 1-120 characters
  config: DashboardConfig;
}
export interface Dashboard extends DashboardInput {
  id: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface DashboardSummary {
  id: string;
  name: string;
  tiles: number;
  createdBy: string;
  updatedAt: string;
}

// ---------- GitHub Agent (opt-in: EnableFixAgent at deploy, then per project) ----------
// An AI agent (Strands Agents on Amazon Bedrock) reads the project's GitHub repository, finds the cause of one error
// group and opens a draft pull request. A person always reviews and merges it.

// GET /api/github: the install's GitHub App, created once by an admin from a manifest
export interface GithubAppStatus {
  enabled: boolean; // the GitHub Agent is deployed (EnableFixAgent=true)
  app: { slug: string; htmlUrl: string; owner: string | null; createdBy: string; createdAt: string } | null;
  canCreate: boolean; // the caller is an admin
}
// GET /api/github/manifest?pid&org: what the dashboard POSTs (as a form field named `manifest`) to `action`
export interface GithubManifestForm {
  action: string; // https://github.com/settings/apps/new?state=… or the organization's page
  manifest: string; // JSON
}

export type FixRunStatus = 'queued' | 'running' | 'pr_opened' | 'no_fix' | 'failed' | 'cancelled';
export type FixOutcome = 'fixed' | 'not_fixable' | 'needs_more_info';
export type PrState = 'open' | 'merged' | 'closed';

export interface FixAutoSettings {
  enabled: boolean; // start a run for new error groups by itself
  minEvents: number; // in the last hour, 1-100000
  minSessions: number; // in the last hour, 1-100000
  maxPerDay: number; // automatic runs per UTC day, 1-50 (runs people start have no limit)
}
// GET /api/projects/{pid}/fix-settings (members), PATCH (owners, partial FixSettingsInput)
/**
 * One repository the agent works in. Errors are routed to a repository by what it fixes: a failed span or error log
 * to the one listing its service, a JavaScript error to the one marked `browser`; anything no repository claims goes
 * to the first. A run can also name its repository.
 */
export interface FixRepo {
  fullName: string; // owner/name, one of GET .../fix-settings/repos
  baseBranch: string | null; // null = the repository's default branch
  rootPath: string | null; // the app's folder in a monorepo, e.g. "dashboard/"; null = the whole repository
  instructions: string | null; // guidance for the agent, up to 4000 characters
  deniedPaths: string[]; // glob patterns the agent may not change (at most 50)
  browser: boolean; // fixes the web app's JavaScript errors
  services: string[]; // fixes errors from these backend services (OpenTelemetry service.name), at most 50
}
export interface FixSettingsInput {
  enabled: boolean;
  repos: FixRepo[]; // at most 10, in order; the first also gets errors no repository claims
  auto: FixAutoSettings;
}
export interface FixSettings extends FixSettingsInput {
  model: { provider: FixProvider; modelId: string; label: string }; // what runs use, set by admins for the whole install
  installed: boolean; // the GitHub App is installed for this project
  account: string | null; // the GitHub account it's installed on
  autoRunsToday: number; // automatic runs started today (UTC)
  updatedBy: string | null;
  updatedAt: string | null;
}
// GET /api/projects/{pid}/fix-settings/repos (owners)
export interface GithubRepo {
  fullName: string; // owner/name
  defaultBranch: string;
  private: boolean;
}

export interface FixStep {
  ts: string;
  tool: string; // read_file, grep, edit_file, …
  summary: string; // one line, e.g. "src/cart.ts:40-120"
  error?: boolean;
}
export interface FixResult {
  outcome: FixOutcome;
  rootCause: string;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  testsAdded: boolean;
  files: string[]; // changed files
  prTitle?: string; // the pull request's title, when it opened one
}
export interface FixSummary {
  runId: string;
  status: FixRunStatus;
  prUrl: string | null;
  prNumber: number | null;
  prState: PrState | null;
}
/**
 * What a run fixes: a JavaScript error group, a failed span of a trace, or an error log record (severity ERROR or
 * FATAL). `at` is when the span or log happened (any time near it), so it's found quickly.
 */
export type FixTarget =
  | { kind: 'browser'; fingerprint: string }
  | { kind: 'span'; traceId: string; spanId: string; at?: string }
  | { kind: 'log'; logId: string; at: string };
export type FixKind = FixTarget['kind'];

// GET /api/projects/{pid}/fixes/for?kind=span&traceId&spanId&at | ?kind=log&logId&at: the backend error a span or log
// stands for (spans and logs with the same exception and top frame share one fingerprint) and its runs
export interface FixTargetInfo {
  fingerprint: string;
  message: string;
  service: string;
  hasStack: boolean;
  repo: string | null; // the repository a run goes to by default (null: none connected)
  runs: FixRun[]; // newest first, of every occurrence of this error
}

// GET /api/projects/{pid}/fixes?fingerprint&pr=1&limit=50 (pr=1: only runs with a pull request), GET .../fixes/{id}, POST .../fixes {fingerprint} | FixTarget,
// POST .../fixes/{id}/cancel
export interface FixRun extends FixSummary {
  kind: FixKind;
  target: FixTarget;
  fingerprint: string;
  message: string | null; // the error message when the run started
  trigger: 'manual' | 'auto';
  requestedBy: string | null;
  repo: string;
  branch: string | null;
  steps: FixStep[];
  result: FixResult | null;
  error: string | null;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null; // estimate from list prices
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ---------- GitHub Agent: install-wide model settings (admins) ----------
// GET /api/fix-agent, PATCH /api/fix-agent (FixAgentConfigInput). Applies to every project's runs.
export type FixProvider = 'bedrock' | 'anthropic'; // Claude on Amazon Bedrock (this AWS account), or the Claude API with your own key
export type FixEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const FIX_EFFORTS: FixEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface FixModelOption {
  provider: FixProvider;
  modelId: string; // e.g. global.anthropic.claude-opus-5-5 (Bedrock), claude-opus-5-5 (Claude API)
  label: string;
  note: string; // one line on what it's good for
  pricePerMTok: [number, number] | null; // list price per million input / output tokens, USD
}
export interface FixAgentConfigInput {
  enabled?: boolean; // the GitHub Agent for this whole WGO (off: no runs, and members don't see it)
  provider: FixProvider;
  modelId: string; // one of the options, or another id of that provider (3-120 characters)
  effort: FixEffort;
  apiKey?: string | null; // Claude API key: a new one to save, null to remove; leave out to keep the saved one
}
export interface FixAgentConfig extends Omit<FixAgentConfigInput, 'apiKey' | 'enabled'> {
  apiKey: { hint: string; setBy: string; setAt: string } | null; // only the last 4 characters are ever shown
  updatedBy: string | null; // null: the deploy defaults (FixAgentModelId, FixAgentEffort)
  updatedAt: string | null;
}
export interface FixUsageRow {
  projectId: string | null; // null: projects you aren't a member of, together
  name: string;
  runs: number;
  prsOpened: number;
  prsMerged: number;
  tokens: number;
  costUsd: number; // estimate from list prices
}
export interface FixAgentAdmin {
  enabled: boolean;
  config: FixAgentConfig;
  models: FixModelOption[];
  usage: { since: string; total: Omit<FixUsageRow, 'projectId' | 'name'>; projects: FixUsageRow[] }; // this month (UTC)
  app: GithubAppStatus['app'];
  projectsOn: number; // projects with the GitHub Agent turned on
}

// ---------- surveys ----------
// Surveys built in the dashboard and shown by the browser SDK on the project's site, as a floating card or inline in
// an element matched by a CSS selector. The SDK fetches active surveys from GET /surveys/config?k=<write key> and posts
// answers to POST /surveys/respond (both write-key auth, like /ingest; see backend/src/lib/surveys.ts).
// GET    /api/projects/{pid}/surveys                    -> Survey[]   (newest first)
// POST   /api/projects/{pid}/surveys   SurveyInput      -> Survey
// GET    /api/projects/{pid}/surveys/{id}               -> Survey
// PATCH  /api/projects/{pid}/surveys/{id}  Partial<SurveyInput> -> Survey
// DELETE /api/projects/{pid}/surveys/{id}               -> { ok: true }   (its responses too)
// GET    /api/projects/{pid}/surveys/{id}/results?from&to          -> SurveyResults
// GET    /api/projects/{pid}/surveys/{id}/responses?from&to[&before=<ISO time>][&limit]  -> SurveyResponsesPage
export type SurveyQuestionType = 'single' | 'multi' | 'text' | 'yesno' | 'rating' | 'nps';
export interface SurveyQuestion {
  id: string; // stable within the survey (answers are keyed by it): 1-40 of [A-Za-z0-9_-]
  type: SurveyQuestionType;
  title: string; // 1-300 characters
  description?: string; // up to 500 characters
  required: boolean;
  options?: string[]; // single / multi: 2-20 distinct options of 1-200 characters
  long?: boolean; // text: a multi-line answer
  placeholder?: string; // text
  scale?: 5 | 10; // rating: 1..scale (default 5)
  lowLabel?: string; // rating / nps: label under the lowest value
  highLabel?: string; // rating / nps: label under the highest value
}
export type SurveyStatus = 'draft' | 'active' | 'paused'; // only active surveys reach the SDK
export interface SurveyDisplay {
  mode: 'popover' | 'inline'; // a floating card, or inside the element matching `selector`
  selector?: string; // inline: CSS selector of the element the survey is rendered into (required for inline)
  position?: 'bottom-right' | 'bottom-left'; // popover (default bottom-right)
  // popover: start as a slim bar showing just the question, expanded with a tap: on phones (default, screens up to
  // 640px wide), always or never
  collapse?: 'mobile' | 'always' | 'never';
  layout: 'steps' | 'form'; // one question at a time, or all questions on one form
  theme: 'auto' | 'light' | 'dark'; // auto follows the visitor's colour scheme
  accent?: string; // #rrggbb, buttons and selected answers
  submitLabel?: string; // default "Submit"
  thankYou?: string; // shown after submitting; default "Thanks for your feedback!"
}
export interface SurveyTargeting {
  paths: string[]; // path globs (`/pricing`, `/docs/*`); [] = every page
  delaySec?: number; // show after this many seconds on a matching page
  scrollPct?: number; // ...and once the visitor scrolled this far down the page (1-100)
  // ...only after an event on the page matches all these filters (events scope, fields in SURVEY_TRIGGER_FIELDS or
  // props.<path>): a click on a button, a custom event, an error, a failed request. The SDK checks them in the browser.
  trigger?: Filter[];
  // once: never again after it was answered or closed; until_answered: closed surveys come back next session;
  // always: on every matching page view (e.g. an inline feedback form)
  frequency: 'once' | 'until_answered' | 'always';
}
// Event fields the browser SDK knows when the event happens (not ones the backend adds, like country or browser)
export const SURVEY_TRIGGER_FIELDS = [
  'type', 'path', 'url', 'title', 'referrer', 'selector', 'elementText', 'elementTag', 'trackName', 'name',
  'errorMessage', 'errorSource', 'httpMethod', 'httpUrl', 'httpStatus', 'durationMs', 'userId',
] as const;
export interface SurveyInput {
  name: string; // 1-120 characters, internal
  status: SurveyStatus;
  questions: SurveyQuestion[]; // 1-20
  display: SurveyDisplay;
  targeting: SurveyTargeting;
}
export interface Survey extends SurveyInput {
  id: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  responses: number; // all time
  lastResponseAt: string | null;
}
// an answer: single → the option, multi → options, text → the text, yesno → boolean, rating / nps → the number
export type SurveyAnswer = string | string[] | number | boolean;
export interface SurveyResponse {
  id: string;
  createdAt: string;
  anonId: string | null;
  userId: string | null; // the identified user, when the visitor was identified
  sessionId: string | null; // links to the session's events (and its recording, when there is one)
  path: string | null;
  answers: Record<string, SurveyAnswer>; // by question id; unanswered optional questions are absent
}
export interface SurveyQuestionResult {
  id: string;
  answered: number; // responses that answered it
  counts?: { value: string; n: number }[]; // single / multi / yesno ("Yes" / "No") / rating / nps (every value, in scale order)
  average?: number; // rating / nps
  nps?: number; // nps: % promoters (9-10) - % detractors (0-6), -100..100
  texts?: { text: string; at: string; responseId: string }[]; // text: newest first, at most 50
}
export interface SurveyResults {
  responses: number; // in the range
  // from the SDK's survey_shown / survey_dismissed custom events: raw events, so ranges older than the project's
  // retention come out short (responses themselves are kept until the survey is deleted)
  shown: number;
  dismissed: number;
  questions: SurveyQuestionResult[]; // in the survey's question order
  series: number[]; // responses per bucket, 24 buckets across the range
  truncated: boolean; // more than 20,000 responses in the range: the numbers cover the newest 20,000
}
export interface SurveyResponsesPage {
  responses: SurveyResponse[]; // newest first
  next: string | null; // pass as `before` for the next page
}
