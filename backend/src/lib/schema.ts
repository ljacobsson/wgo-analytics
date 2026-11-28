/**
 * DSQL schema. Rules that shape it:
 * - one DDL statement per transaction (each statement here runs on its own),
 * - indexes must be created with CREATE INDEX ASYNC,
 * - no foreign keys / sequences — UUID keys, integrity enforced in code,
 * - primary keys lead with project_id + time so per-project range scans stay cheap.
 * Statements must be idempotent: the migration re-runs on every schema version bump.
 */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS projects (
     id uuid PRIMARY KEY,
     name text NOT NULL,
     write_key text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX ASYNC IF NOT EXISTS projects_write_key_idx ON projects (write_key)`,

  `CREATE TABLE IF NOT EXISTS project_members (
     project_id uuid NOT NULL,
     email text NOT NULL,
     role text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (project_id, email)
   )`,
  `CREATE INDEX ASYNC IF NOT EXISTS project_members_email_idx ON project_members (email)`,

  // Android widget credentials: read-only, per user; only the SHA-256 of the token is stored
  `CREATE TABLE IF NOT EXISTS device_tokens (
     id uuid PRIMARY KEY,
     email text NOT NULL,
     name text NOT NULL,
     token_hash text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     last_used_at timestamptz
   )`,
  `CREATE UNIQUE INDEX ASYNC IF NOT EXISTS device_tokens_hash_idx ON device_tokens (token_hash)`,
  `CREATE INDEX ASYNC IF NOT EXISTS device_tokens_email_idx ON device_tokens (email)`,

  `CREATE TABLE IF NOT EXISTS events (
     project_id uuid NOT NULL,
     ts timestamptz NOT NULL,
     id uuid NOT NULL,
     type text NOT NULL,
     session_id text,
     anon_id text,
     user_id text,
     url text,
     path text,
     title text,
     referrer text,
     selector text,
     element_text text,
     element_tag text,
     track_name text,
     error_message text,
     error_stack text,
     error_source text,
     fingerprint text,
     http_method text,
     http_url text,
     http_route text,
     http_status int,
     duration_ms int,
     name text,
     props jsonb,
     browser text,
     os text,
     device text,
     country text,
     region text,
     city text,
     lat double precision,
     lon double precision,
     bot text,
     PRIMARY KEY (project_id, ts, id)
   )`,
  // v2: visitor location (stacks created before it need the columns added; one DDL per statement)
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS country text`,
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS region text`,
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS city text`,
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS lat double precision`,
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS lon double precision`,
  // bot classification (lib/bots.ts): null = human
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS bot text`,
  `CREATE INDEX ASYNC IF NOT EXISTS events_type_ts_idx ON events (project_id, type, ts)`,
  `CREATE INDEX ASYNC IF NOT EXISTS events_session_idx ON events (project_id, session_id, ts)`,
  `CREATE INDEX ASYNC IF NOT EXISTS events_fingerprint_idx ON events (project_id, fingerprint, ts)`,

  `CREATE TABLE IF NOT EXISTS spans (
     project_id uuid NOT NULL,
     start_time timestamptz NOT NULL,
     span_id text NOT NULL,
     trace_id text NOT NULL,
     parent_span_id text,
     name text NOT NULL,
     kind int NOT NULL,
     service text NOT NULL,
     end_time timestamptz NOT NULL,
     duration_ms double precision NOT NULL,
     status_code int NOT NULL,
     status_message text,
     attributes jsonb,
     resource jsonb,
     events jsonb,
     PRIMARY KEY (project_id, start_time, span_id)
   )`,
  `CREATE INDEX ASYNC IF NOT EXISTS spans_trace_idx ON spans (project_id, trace_id)`,

  `CREATE TABLE IF NOT EXISTS logs (
     project_id uuid NOT NULL,
     ts timestamptz NOT NULL,
     id uuid NOT NULL,
     severity_number int NOT NULL,
     severity_text text,
     body text NOT NULL,
     service text NOT NULL,
     trace_id text,
     span_id text,
     attributes jsonb,
     resource jsonb,
     PRIMARY KEY (project_id, ts, id)
   )`,
  `CREATE INDEX ASYNC IF NOT EXISTS logs_trace_idx ON logs (project_id, trace_id)`,

  `CREATE TABLE IF NOT EXISTS metric_points (
     project_id uuid NOT NULL,
     ts timestamptz NOT NULL,
     id uuid NOT NULL,
     name text NOT NULL,
     type text NOT NULL,
     unit text,
     description text,
     service text NOT NULL,
     value double precision NOT NULL,
     count bigint,
     attributes jsonb,
     PRIMARY KEY (project_id, ts, id)
   )`,
  `CREATE INDEX ASYNC IF NOT EXISTS metric_points_name_idx ON metric_points (project_id, name, ts)`,

  // alerts: filters over incoming events → webhook / Slack
  `CREATE TABLE IF NOT EXISTS triggers (
     project_id uuid NOT NULL,
     id uuid NOT NULL,
     name text NOT NULL,
     filters jsonb NOT NULL,
     destination jsonb NOT NULL,
     cooldown_seconds int NOT NULL,
     enabled boolean NOT NULL,
     signing_secret text NOT NULL,
     created_by text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     last_fired_at timestamptz,
     fire_count int NOT NULL DEFAULT 0,
     suppressed int NOT NULL DEFAULT 0,
     last_status text,
     dashboard_url text,
     PRIMARY KEY (project_id, id)
   )`,

  // per-project connections to external services (Slack channels via "Add to Slack")
  `CREATE TABLE IF NOT EXISTS integrations (
     project_id uuid NOT NULL,
     id uuid NOT NULL,
     type text NOT NULL,
     config jsonb NOT NULL,
     created_by text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (project_id, id)
   )`,

  // v3: raw data retention per project (NULL = the default, see lib/retention.ts)
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS retention_days int`,

  // one sample stack per error group; error events no longer carry their own copy
  `CREATE TABLE IF NOT EXISTS error_stacks (
     project_id uuid NOT NULL,
     fingerprint text NOT NULL,
     stack text NOT NULL,
     updated_at timestamptz NOT NULL,
     PRIMARY KEY (project_id, fingerprint)
   )`,

  // hourly aggregates of events, kept longer than raw data (lib/rollups.ts). `dim` first in the key so a
  // long range of one dimension is a single contiguous scan.
  //   dim 'type'  key = event type     events = count
  //   dim 'page'  key = path           events = pageviews, sessions = distinct sessions in the hour
  //   dim browser|os|device|country|city|referrer   sessions = sessions that started in the hour
  `CREATE TABLE IF NOT EXISTS rollups (
     project_id uuid NOT NULL,
     dim text NOT NULL,
     hour timestamptz NOT NULL,
     key text NOT NULL,
     events bigint NOT NULL,
     sessions bigint NOT NULL,
     PRIMARY KEY (project_id, dim, hour, key)
   )`,
  // HyperLogLog sketches of the sessions and users active in each hour (lib/hll.ts)
  `CREATE TABLE IF NOT EXISTS rollup_sketches (
     project_id uuid NOT NULL,
     hour timestamptz NOT NULL,
     sessions bytea NOT NULL,
     users bytea NOT NULL,
     PRIMARY KEY (project_id, hour)
   )`,
  // progress of the scheduled maintenance jobs (rollup watermark, last retention / cluster metrics run)
  `CREATE TABLE IF NOT EXISTS job_state (
     name text PRIMARY KEY,
     at timestamptz NOT NULL
   )`,

  // wall displays (lib/kiosks.ts). The token is the kiosk URL's secret; it's kept readable (like write_key) so
  // members can open the link or set up the screen again. It grants read access to data the same dump already holds.
  `CREATE TABLE IF NOT EXISTS kiosks (
     project_id uuid NOT NULL,
     id uuid NOT NULL,
     name text NOT NULL,
     token text NOT NULL,
     config jsonb NOT NULL,
     reload_at timestamptz,
     created_by text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     last_seen_at timestamptz,
     display text,
     PRIMARY KEY (project_id, id)
   )`,
  `CREATE UNIQUE INDEX ASYNC IF NOT EXISTS kiosks_token_idx ON kiosks (token)`,

  // what a trigger watches: events | logs | spans (NULL = events, for triggers created before scopes)
  `ALTER TABLE triggers ADD COLUMN IF NOT EXISTS scope text`,

  // named dashboard pages with their filters (lib/views.ts), shared by a project's members
  `CREATE TABLE IF NOT EXISTS saved_views (
     project_id uuid NOT NULL,
     id uuid NOT NULL,
     name text NOT NULL,
     page text NOT NULL,
     params text NOT NULL,
     created_by text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (project_id, id)
   )`,

  // conversion goals (lib/goals.ts): events matching `filters` (events scope) count as conversions
  `CREATE TABLE IF NOT EXISTS goals (
     project_id uuid NOT NULL,
     id uuid NOT NULL,
     name text NOT NULL,
     filters jsonb NOT NULL,
     created_by text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (project_id, id)
   )`,
  // funnel steps before a goal (GoalStep[] JSON; NULL = none)
  `ALTER TABLE goals ADD COLUMN IF NOT EXISTS steps jsonb`,

  // who an anonymous visitor turned out to be (lib/identities.ts): the first user id seen on each anon_id.
  // Queries resolve the user of that browser's anonymous events through it.
  `CREATE TABLE IF NOT EXISTS identities (
     project_id uuid NOT NULL,
     anon_id text NOT NULL,
     user_id text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (project_id, anon_id)
   )`,
  `CREATE INDEX ASYNC IF NOT EXISTS identities_created_idx ON identities (project_id, created_at)`,

  // readable names for autocaptured click targets (lib/clickAliases.ts), keyed by the captured selector
  `CREATE TABLE IF NOT EXISTS click_aliases (
     project_id uuid NOT NULL,
     selector text NOT NULL,
     alias text NOT NULL,
     updated_by text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (project_id, selector)
   )`,

  // session recording settings (lib/recordings.ts); no row = recording off
  `CREATE TABLE IF NOT EXISTS recording_settings (
     project_id uuid PRIMARY KEY,
     enabled boolean NOT NULL,
     sample_percent double precision NOT NULL,
     triggers jsonb NOT NULL,
     max_per_hour integer,
     max_per_day integer,
     mask_text boolean NOT NULL,
     updated_by text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  // sessions granted a recording slot: the hourly/daily limits count these, and ingest only stores replay
  // chunks of sessions listed here. The recording itself is Parquet (the replays raw table).
  `CREATE TABLE IF NOT EXISTS recordings (
     project_id uuid NOT NULL,
     session_id text NOT NULL,
     started_at timestamptz NOT NULL,
     anon_id text,
     reason text NOT NULL,
     PRIMARY KEY (project_id, session_id)
   )`,
  `CREATE INDEX ASYNC IF NOT EXISTS recordings_started_idx ON recordings (project_id, started_at)`,
  // whether the visitor clicked, tapped, scrolled, typed or hovered (lib/recordings.ts); null = recorded before it was tracked
  `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS active boolean`,

  // projects deleted by their owner (lib/projects.ts deleteProject): the project row is gone at once, and the
  // maintenance job removes the rest of its data (lib/purge.ts), then this row
  `CREATE TABLE IF NOT EXISTS deleted_projects (
     id uuid PRIMARY KEY,
     deleted_at timestamptz NOT NULL DEFAULT now()
   )`,

  // versions seen in the wild (lib/releases.ts): the SDK's `release` (kind 'web', service '') and OpenTelemetry's
  // service.version per service (kind 'service'). First-seen times are deploy markers and outlive raw data.
  `CREATE TABLE IF NOT EXISTS releases (
     project_id uuid NOT NULL,
     kind text NOT NULL,
     service text NOT NULL,
     version text NOT NULL,
     first_seen timestamptz NOT NULL,
     last_seen timestamptz NOT NULL,
     PRIMARY KEY (project_id, kind, service, version)
   )`,

  // aggregate triggers (lib/monitor.ts): kind NULL/'match' = per matching row (ingest); 'threshold' | 'anomaly' are
  // evaluated every minute over a window. metric = TriggerMetric, condition = TriggerCondition (JSON).
  `ALTER TABLE triggers ADD COLUMN IF NOT EXISTS kind text`,
  `ALTER TABLE triggers ADD COLUMN IF NOT EXISTS metric jsonb`,
  `ALTER TABLE triggers ADD COLUMN IF NOT EXISTS condition jsonb`,
  `ALTER TABLE triggers ADD COLUMN IF NOT EXISTS window_minutes int`,
  // 'ok' | 'firing' (NULL until first evaluated), the last value and when it was computed
  `ALTER TABLE triggers ADD COLUMN IF NOT EXISTS state text`,
  `ALTER TABLE triggers ADD COLUMN IF NOT EXISTS state_since timestamptz`,
  `ALTER TABLE triggers ADD COLUMN IF NOT EXISTS last_value double precision`,
  `ALTER TABLE triggers ADD COLUMN IF NOT EXISTS last_evaluated_at timestamptz`,
  // anomaly baseline, recomputed at most hourly: { at, hour, values, median, mad }
  `ALTER TABLE triggers ADD COLUMN IF NOT EXISTS baseline jsonb`,
  // source maps: CI secret for POST /sourcemaps/upload-url (lib/projects.ts); error stacks remember the release
  // they came from so they can be symbolicated (lib/sourcemaps.ts)
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS upload_key text`,
  `ALTER TABLE error_stacks ADD COLUMN IF NOT EXISTS release text`,

  // uptime checks (lib/uptime.ts); every result is a row of the `checks` raw table
  `CREATE TABLE IF NOT EXISTS uptime_checks (
     project_id uuid NOT NULL,
     id uuid NOT NULL,
     name text NOT NULL,
     url text NOT NULL,
     method text NOT NULL,
     expect text NOT NULL,
     keyword text,
     interval_seconds integer NOT NULL,
     timeout_ms integer NOT NULL,
     enabled boolean NOT NULL DEFAULT true,
     state text,
     state_since timestamptz,
     last_checked_at timestamptz,
     fail_streak integer NOT NULL DEFAULT 0,
     last_status integer,
     last_error text,
     last_duration_ms double precision,
     created_by text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (project_id, id)
   )`,

  // the install's cost report (lib/costs.ts), cached because each Cost Explorer request costs $0.01
  `CREATE TABLE IF NOT EXISTS cost_cache (
     id text PRIMARY KEY,
     data jsonb NOT NULL,
     fetched_at timestamptz NOT NULL
   )`,

  // errors to drop at ingest (lib/suppressions.ts): wildcard patterns on the kind, message, failing URL and page path
  `CREATE TABLE IF NOT EXISTS error_suppressions (
     project_id uuid NOT NULL,
     id uuid NOT NULL,
     kind text,
     message text,
     source text,
     page text,
     created_by text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     hits bigint NOT NULL DEFAULT 0,
     last_hit_at timestamptz,
     PRIMARY KEY (project_id, id)
   )`,

  // monthly cost budgets (lib/budgets.ts): the whole install (project_id NULL) or one project. `state` holds this
  // month's alerts sent and whether collection is paused.
  `CREATE TABLE IF NOT EXISTS budgets (
     id uuid PRIMARY KEY,
     scope text NOT NULL,
     project_id uuid,
     monthly_limit double precision NOT NULL,
     alert_at jsonb NOT NULL,
     alert_on_forecast boolean NOT NULL,
     pause_at_limit boolean NOT NULL,
     destination jsonb,
     signing_secret text NOT NULL,
     state jsonb,
     created_by text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX ASYNC IF NOT EXISTS budgets_project_idx ON budgets (project_id)`,

  // the public website behind a project and its daily homepage screenshot (lib/sites.ts). Days are YYYY-MM-DD (UTC).
  `CREATE TABLE IF NOT EXISTS project_sites (
     project_id uuid PRIMARY KEY,
     origin text,
     origin_checked_at timestamptz,
     shot_day text,
     shot_origin text,
     shot_error text,
     image_key text,
     image_day text,
     image_at timestamptz
   )`,
  // the site's icon (favicon) as a data URL, refreshed with the screenshot
  `ALTER TABLE project_sites ADD COLUMN IF NOT EXISTS icon text`,

  // saved trigger destinations (lib/destinations.ts): a project's (project_id set) or an account's (owner_email set),
  // reusable by triggers. Project Slack channels connected before this live in `integrations` and are merged in.
  `CREATE TABLE IF NOT EXISTS destinations (
     id uuid PRIMARY KEY,
     project_id uuid,
     owner_email text,
     name text NOT NULL,
     type text NOT NULL,
     config jsonb NOT NULL,
     signing_secret text NOT NULL,
     created_by text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX ASYNC IF NOT EXISTS destinations_project_idx ON destinations (project_id)`,
  `CREATE INDEX ASYNC IF NOT EXISTS destinations_owner_idx ON destinations (owner_email)`,

  // Slack apps' client ids and secrets, a person's (slack_apps) or a project's (integrations of type slack_app), are no
  // longer used: workspaces are connected with a bot token (lib/slack.ts). Don't keep the secrets around.
  `DROP TABLE IF EXISTS slack_apps`,
  `DELETE FROM integrations WHERE type = 'slack_app'`,

  // Slack workspaces connected with a bot token (lib/slack.ts): a project's (project_id set) or a person's own
  // (owner_email set). Channels picked from them are stored like other Slack channels, with config.workspaceId.
  `CREATE TABLE IF NOT EXISTS slack_workspaces (
     id uuid PRIMARY KEY,
     project_id uuid,
     owner_email text,
     team_id text NOT NULL,
     team_name text,
     bot_token text NOT NULL,
     bot_user_id text,
     created_by text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX ASYNC IF NOT EXISTS slack_workspaces_project_idx ON slack_workspaces (project_id)`,
  `CREATE INDEX ASYNC IF NOT EXISTS slack_workspaces_owner_idx ON slack_workspaces (owner_email)`,
  // custom dashboards (lib/dashboards.ts): a grid of tiles, each a generic query (lib/query.ts), as one jsonb config
  `CREATE TABLE IF NOT EXISTS dashboards (
     project_id uuid NOT NULL,
     id uuid NOT NULL,
     name text NOT NULL,
     config jsonb NOT NULL,
     created_by text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (project_id, id)
   )`,
  // a trigger's own Slack message (SlackTemplate: Block Kit blocks with {{variables}}); NULL = the default message
  `ALTER TABLE triggers ADD COLUMN IF NOT EXISTS slack_template jsonb`,
  // GitHub Agent (lib/github.ts, lib/fixes.ts, lib/fixAgent/): the install's GitHub App, created once from a manifest. One row
  // (id 'app'); the 'state' row only holds the HMAC key that signs GitHub callback state before the app exists.
  `CREATE TABLE IF NOT EXISTS github_app (
     id text PRIMARY KEY,
     app_id bigint,
     slug text,
     client_id text,
     client_secret text,
     private_key text,
     webhook_secret text,
     html_url text,
     owner_login text,
     state_secret text,
     created_by text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  // a project's GitHub Agent settings: the repository it fixes and when runs start by themselves (auto, FixAutoSettings JSON)
  `CREATE TABLE IF NOT EXISTS fix_settings (
     project_id uuid PRIMARY KEY,
     enabled boolean NOT NULL DEFAULT false,
     installation_id bigint,
     account text,
     repo text,
     base_branch text,
     root_path text,
     instructions text,
     denied_paths jsonb,
     auto jsonb,
     dashboard_url text,
     updated_by text,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  // one GitHub Agent run per row; also the ledger that keeps automatic runs from repeating an error group
  `CREATE TABLE IF NOT EXISTS fix_runs (
     project_id uuid NOT NULL,
     id uuid NOT NULL,
     fingerprint text NOT NULL,
     message text,
     trigger text NOT NULL,
     requested_by text,
     repo text NOT NULL,
     status text NOT NULL,
     steps jsonb,
     result jsonb,
     branch text,
     pr_number int,
     pr_url text,
     pr_state text,
     pr_checked_at timestamptz,
     model_id text NOT NULL,
     input_tokens bigint NOT NULL DEFAULT 0,
     output_tokens bigint NOT NULL DEFAULT 0,
     cost_usd double precision,
     error text,
     created_at timestamptz NOT NULL DEFAULT now(),
     started_at timestamptz,
     finished_at timestamptz,
     PRIMARY KEY (project_id, id)
   )`,
  `CREATE INDEX ASYNC IF NOT EXISTS fix_runs_fingerprint_idx ON fix_runs (project_id, fingerprint, created_at)`,
  `CREATE INDEX ASYNC IF NOT EXISTS fix_runs_created_idx ON fix_runs (project_id, created_at)`,
  // the GitHub Agent's model for the whole install (lib/fixConfig.ts), one row (id 'config'); no row = the deploy defaults.
  // The Claude API key itself is in Secrets Manager; anthropic_key is only used without it (local development).
  `CREATE TABLE IF NOT EXISTS fix_agent_config (
     id text PRIMARY KEY,
     provider text NOT NULL,
     model_id text NOT NULL,
     effort text NOT NULL,
     key_hint text,
     key_set_by text,
     key_set_at timestamptz,
     anthropic_key text,
     updated_by text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  // fix runs for backend errors too: kind 'browser' (NULL for older rows) | 'span' | 'log', and the FixTarget JSON
  `ALTER TABLE fix_runs ADD COLUMN IF NOT EXISTS kind text`,
  `ALTER TABLE fix_runs ADD COLUMN IF NOT EXISTS target jsonb`,
  // a project's repositories for the GitHub Agent (lib/fixes.ts): settings per repository and which errors it fixes
  // (browser: the web app's JavaScript errors; services: backend services by OpenTelemetry service.name). `position`
  // orders them; the first also gets errors no repository claims.
  `CREATE TABLE IF NOT EXISTS fix_repos (
     project_id uuid NOT NULL,
     repo text NOT NULL,
     position int NOT NULL,
     base_branch text,
     root_path text,
     instructions text,
     denied_paths jsonb,
     browser boolean NOT NULL DEFAULT false,
     services jsonb,
     PRIMARY KEY (project_id, repo)
   )`,
  // projects set up with one repository before there could be several: it becomes their first, fixing everything
  `INSERT INTO fix_repos (project_id, repo, position, base_branch, root_path, instructions, denied_paths, browser, services)
     SELECT project_id, repo, 0, base_branch, root_path, instructions, denied_paths, true, '[]'::jsonb FROM fix_settings WHERE repo IS NOT NULL
     ON CONFLICT (project_id, repo) DO NOTHING`,
  // …once: the old column isn't written any more, and re-running the copy mustn't bring back a removed repository
  `UPDATE fix_settings SET repo = NULL WHERE repo IS NOT NULL`,
  // settings admins change in the dashboard instead of at deploy time (lib/installSettings.ts): the GitHub Agent and MCP
  // switches, the install's Slack app; secrets only when there's no Secrets Manager (local development)
  `CREATE TABLE IF NOT EXISTS install_settings (
     key text PRIMARY KEY,
     value jsonb NOT NULL,
     updated_by text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  // surveys the browser SDK shows on the project's site (lib/surveys.ts): SurveyQuestion[], SurveyDisplay and
  // SurveyTargeting JSON; status 'draft' | 'active' | 'paused'
  `CREATE TABLE IF NOT EXISTS surveys (
     project_id uuid NOT NULL,
     id uuid NOT NULL,
     name text NOT NULL,
     status text NOT NULL,
     questions jsonb NOT NULL,
     display jsonb NOT NULL,
     targeting jsonb NOT NULL,
     created_by text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (project_id, id)
   )`,
  // submitted survey responses (answers: question id -> answer), kept until the survey is deleted; `id` is made up by
  // the SDK, so a retried submit is stored once
  `CREATE TABLE IF NOT EXISTS survey_responses (
     project_id uuid NOT NULL,
     survey_id uuid NOT NULL,
     id uuid NOT NULL,
     created_at timestamptz NOT NULL,
     anon_id text,
     user_id text,
     session_id text,
     path text,
     answers jsonb NOT NULL,
     PRIMARY KEY (project_id, survey_id, id)
   )`,
  `CREATE INDEX ASYNC IF NOT EXISTS survey_responses_time_idx ON survey_responses (project_id, survey_id, created_at)`,

  // development traffic dropped at ingest: DevTrafficSettings JSON, NULL = keep everything (see lib/devTraffic.ts)
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS dev_traffic jsonb`,
];
