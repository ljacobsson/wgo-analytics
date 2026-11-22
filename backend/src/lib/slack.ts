import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Destination, DestinationLevel, SlackChannel, SlackIntegration, SlackSetup, SlackWorkspace } from '../contract';
import { SLACK_BOT_SCOPES } from '../contract';
import { query } from './db';
import { integrationDestination, saveAccountSlack, type Owner, type Target } from './destinations';
import { HttpError } from './http';
import { isUuid } from './projects';

/**
 * "Add to Slack" connects a workspace: WGO's bot joins it and we keep its token (slack_workspaces), for the project
 * or for the person who connected it. Channels are then picked from a list and posted to with chat.postMessage.
 * Channels connected before that (with the incoming-webhook scope) have a webhook URL of their own and keep using it.
 *
 * Slack ties every "Add to Slack" button to a Slack app. A self-hosted WGO has one OAuth redirect URL, so one app
 * works for every project. It is set up once, in one of three places, used in this order:
 * - a project's (owners, from the dashboard): for everyone in that project;
 * - a person's own (anyone, from the dashboard): for them, in every project they're a member of;
 * - the instance's, with SLACK_CLIENT_ID / SLACK_CLIENT_SECRET at deploy time: for everyone.
 */
type Source = NonNullable<SlackSetup['source']>;
interface Creds { clientId: string; clientSecret: string; source: Source }

async function projectApp(pid: string): Promise<Creds | null> {
  const [row] = await query<{ config: { clientId: string; clientSecret: string } }>(
    `SELECT config FROM integrations WHERE project_id = $1 AND type = 'slack_app' LIMIT 1`,
    [pid],
  );
  return row ? { ...row.config, source: 'project' } : null;
}

async function accountApp(email: string | null | undefined): Promise<Creds | null> {
  if (!email) return null;
  const [row] = await query<{ client_id: string; client_secret: string }>('SELECT client_id, client_secret FROM slack_apps WHERE owner_email = $1', [email]);
  return row ? { clientId: row.client_id, clientSecret: row.client_secret, source: 'account' } : null;
}

function instanceApp(): Creds | null {
  const clientId = process.env.SLACK_CLIENT_ID ?? '';
  const clientSecret = process.env.SLACK_CLIENT_SECRET ?? '';
  return clientId && clientSecret ? { clientId, clientSecret, source: 'instance' } : null;
}

/** The app "Add to Slack" uses for `email` in project `pid`. */
async function credentials(pid: string, email?: string | null): Promise<Creds | null> {
  return (await projectApp(pid)) ?? (await accountApp(email)) ?? instanceApp();
}

/** The app a given source names: a callback is verified against the app its install started with. */
async function credentialsFrom(source: Source | undefined, pid: string, email: string | null): Promise<Creds | null> {
  if (source === 'account') return accountApp(email);
  if (source === 'instance') return instanceApp();
  if (source === 'project') return projectApp(pid);
  return (await projectApp(pid)) ?? instanceApp(); // installs started before sources were recorded
}

const redirectUrl = (apiDomain: string) => `https://${apiDomain}/slack/callback`;

/**
 * A pre-filled Slack app manifest: Slack's "create app" page asks only which workspace to create it in.
 * Bot scopes need a bot user. Token rotation stays off: the bot token must not expire.
 */
export function createAppUrl(apiDomain: string): string {
  const manifest = {
    display_information: { name: 'WGO', description: "Notifications from WGO (What's going on?) triggers", background_color: '#14141c' },
    features: { bot_user: { display_name: 'WGO', always_online: false } },
    oauth_config: { redirect_urls: [redirectUrl(apiDomain)], scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

export async function setupStatus(pid: string, apiDomain: string, email?: string): Promise<SlackSetup> {
  const [creds, own, workspaces] = await Promise.all([credentials(pid, email), accountApp(email), listWorkspaces(pid, email ?? null)]);
  return {
    configured: !!creds,
    source: creds?.source ?? null,
    clientId: creds && creds.source !== 'instance' ? creds.clientId : null,
    accountClientId: own?.clientId ?? null,
    redirectUrl: redirectUrl(apiDomain),
    createAppUrl: createAppUrl(apiDomain),
    workspaces,
  };
}

/**
 * Save Slack app credentials, the project's or (level=account) the person's own, after checking them with Slack:
 * exchanging a dummy code fails with `invalid_code` only once the client id and secret are valid.
 */
export async function saveApp(pid: string, email: string, clientId: unknown, clientSecret: unknown, level: DestinationLevel = 'project'): Promise<void> {
  const id = typeof clientId === 'string' ? clientId.trim() : '';
  const secret = typeof clientSecret === 'string' ? clientSecret.trim() : '';
  if (!/^\d+\.\d+$/.test(id)) throw new HttpError(400, 'That doesn’t look like a Slack Client ID (digits.digits, under Basic Information)');
  if (!/^[0-9a-f]{32}$/i.test(secret)) throw new HttpError(400, 'That doesn’t look like a Slack Client Secret (32 hex characters; click Show next to it)');
  const check = await oauthAccess(id, secret, 'wgo-credential-check', 'https://example.invalid/');
  if (check.error === 'invalid_client_id') throw new HttpError(400, 'Slack doesn’t know that Client ID');
  if (check.error === 'bad_client_secret') throw new HttpError(400, 'That Client Secret doesn’t match the Client ID');
  if (level === 'account') {
    await query(
      `INSERT INTO slack_apps (owner_email, client_id, client_secret) VALUES ($1, $2, $3)
       ON CONFLICT (owner_email) DO UPDATE SET client_id = EXCLUDED.client_id, client_secret = EXCLUDED.client_secret`,
      [email, id, secret],
    );
    return;
  }
  await query(`DELETE FROM integrations WHERE project_id = $1 AND type = 'slack_app'`, [pid]);
  await query(
    `INSERT INTO integrations (project_id, id, type, config, created_by) VALUES ($1, $2, 'slack_app', $3::jsonb, $4)`,
    [pid, randomUUID(), JSON.stringify({ clientId: id, clientSecret: secret }), email],
  );
}

/** Forget the project's Slack app, or (level=account) the person's own. Connected channels keep working. */
export async function removeApp(pid: string, email?: string, level: DestinationLevel = 'project'): Promise<void> {
  if (level === 'account') await query('DELETE FROM slack_apps WHERE owner_email = $1', [email]);
  else await query(`DELETE FROM integrations WHERE project_id = $1 AND type = 'slack_app'`, [pid]);
}

// ---------------------------------------------------------------- OAuth

const STATE_TTL_MS = 15 * 60 * 1000;
const mac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

interface State { pid: string; email: string; returnTo: string | null; level: DestinationLevel; source?: Source }

/**
 * Signed, expiring state: ties the callback to the project and user that started the install, and to where the
 * channel is saved (the project, or the user's own destinations).
 */
export function signState(secret: string, pid: string, email: string, returnTo: string | null, now = Date.now(), level: DestinationLevel = 'project', source?: Source): string {
  const data = Buffer.from(JSON.stringify({ p: pid, e: email, r: returnTo, x: now + STATE_TTL_MS, ...(level === 'account' ? { l: 'account' } : {}), ...(source ? { s: source } : {}) })).toString('base64url');
  return `${data}.${mac(secret, data)}`;
}

/** Read before verification only to find which app's secret signed the state. */
function peekState(state: string): { p?: string; e?: string; s?: Source } {
  try {
    return JSON.parse(Buffer.from(state.split('.')[0] ?? '', 'base64url').toString()) as { p?: string; e?: string; s?: Source };
  } catch {
    return {};
  }
}
export const peekStateProject = (state: string): string | null => peekState(state).p ?? null;

export function verifyState(secret: string, state: string, now = Date.now()): State {
  const [data, sig] = state.split('.');
  if (!data || !sig) throw new HttpError(400, 'Bad state');
  const expected = Buffer.from(mac(secret, data));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new HttpError(400, 'Bad state signature');
  const { p, e, r, x, l, s } = JSON.parse(Buffer.from(data, 'base64url').toString()) as { p: string; e: string; r: string | null; x: number; l?: string; s?: Source };
  if (now > x) throw new HttpError(400, 'Slack install link expired, try again');
  return { pid: p, email: e, returnTo: r ?? null, level: l === 'account' ? 'account' : 'project', ...(s ? { source: s } : {}) };
}

/** Verify a callback's state against the app the install started with (the project's, the user's or the instance's). */
export async function verifyCallbackState(state: string): Promise<State & { creds: Creds }> {
  const { p, e, s } = peekState(state);
  const creds = p ? await credentialsFrom(s, p, e ?? null) : null;
  if (!creds) throw new HttpError(400, 'Bad state');
  return { ...verifyState(creds.clientSecret, state), creds };
}

export async function installUrl(pid: string, email: string, apiDomain: string, returnTo: string | null, level: DestinationLevel = 'project'): Promise<string> {
  const creds = await credentials(pid, email);
  if (!creds) throw new HttpError(409, 'Set up a Slack app first: for this project, or your own for all your projects');
  const u = new URL('https://slack.com/oauth/v2/authorize');
  u.searchParams.set('client_id', creds.clientId);
  u.searchParams.set('scope', SLACK_BOT_SCOPES.join(','));
  u.searchParams.set('redirect_uri', redirectUrl(apiDomain));
  u.searchParams.set('state', signState(creds.clientSecret, pid, email, returnTo, Date.now(), level, creds.source));
  return u.toString();
}

interface OAuthAccess {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  expires_in?: number;
  team?: { id?: string; name?: string };
}

async function oauthAccess(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<OAuthAccess> {
  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(8000),
  });
  return (await res.json()) as OAuthAccess;
}

/** The Slack app lacks bot scopes WGO needs: apps created from the manifest before bot tokens only had incoming-webhook. */
export class SlackScopesError extends HttpError {
  constructor(public missing: string[]) {
    super(400, `The Slack app needs these bot scopes: ${missing.join(', ')}`);
  }
}

/**
 * Exchange the code for the workspace's bot token and keep it: for the project, or (level=account) for the person who
 * connected it. Connecting a workspace again updates its token.
 */
export async function completeInstall(code: string, state: string, apiDomain: string): Promise<{ pid: string; level: DestinationLevel }> {
  const { pid, email, level, creds } = await verifyCallbackState(state);
  const body = await oauthAccess(creds.clientId, creds.clientSecret, code, redirectUrl(apiDomain));
  if (!body.ok) throw new HttpError(502, `Slack: ${body.error ?? 'no token returned'}`);
  const granted = new Set((body.scope ?? '').split(','));
  const missing = SLACK_BOT_SCOPES.filter((sc) => !granted.has(sc));
  if (body.token_type !== 'bot' || !body.access_token || missing.length) throw new SlackScopesError(missing.length ? missing : [...SLACK_BOT_SCOPES]);
  if (body.expires_in) throw new HttpError(400, 'Turn off token rotation for the Slack app: WGO’s bot token must not expire');
  if (!body.team?.id) throw new HttpError(502, 'Slack: no workspace returned');
  const owner: Owner = level === 'account' ? { level: 'account', email } : { level: 'project', pid };
  await saveWorkspace(owner, email, { teamId: body.team.id, teamName: body.team.name ?? null, token: body.access_token, botUserId: body.bot_user_id ?? null });
  return { pid, level };
}

// ---------------------------------------------------------------- workspaces

interface WorkspaceRow { id: string; project_id: string | null; owner_email: string | null; team_id: string; team_name: string | null; bot_token: string; created_by: string; created_at: Date }

const ownerWhere = (o: Owner): [string, string] => (o.level === 'project' ? ['project_id = $1', o.pid] : ['owner_email = $1 AND project_id IS NULL', o.email]);

async function saveWorkspace(o: Owner, email: string, w: { teamId: string; teamName: string | null; token: string; botUserId: string | null }): Promise<void> {
  const [where, v] = ownerWhere(o);
  const [cur] = await query<{ id: string }>(`SELECT id FROM slack_workspaces WHERE ${where} AND team_id = $2`, [v, w.teamId]);
  if (cur) {
    await query('UPDATE slack_workspaces SET bot_token = $2, team_name = $3, bot_user_id = $4 WHERE id = $1', [cur.id, w.token, w.teamName, w.botUserId]);
    return;
  }
  await query(
    `INSERT INTO slack_workspaces (id, project_id, owner_email, team_id, team_name, bot_token, bot_user_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [randomUUID(), o.level === 'project' ? o.pid : null, o.level === 'account' ? o.email : null, w.teamId, w.teamName, w.token, w.botUserId, email],
  );
}

/** Channels added from a workspace: the project's (integrations) and people's own (destinations). */
const CHANNELS_OF = `SELECT config->>'channel' AS channel FROM integrations WHERE type = 'slack' AND config->>'workspaceId' = $1
                     UNION ALL SELECT config->>'channel' FROM destinations WHERE type = 'slack' AND config->>'workspaceId' = $1`;

/** The workspaces `email` can add channels from in project `pid`: the project's, then their own. */
export async function listWorkspaces(pid: string, email: string | null): Promise<SlackWorkspace[]> {
  const rows = await query<WorkspaceRow & { channels: number }>(
    `SELECT w.*,
            (SELECT count(*) FROM integrations i WHERE i.type = 'slack' AND i.config->>'workspaceId' = w.id::text)::int
          + (SELECT count(*) FROM destinations d WHERE d.type = 'slack' AND d.config->>'workspaceId' = w.id::text)::int AS channels
       FROM slack_workspaces w
      WHERE w.project_id = $1 OR (w.project_id IS NULL AND w.owner_email = $2)
      ORDER BY w.project_id IS NULL, w.created_at`,
    [pid, email ?? ''],
  );
  return rows.map((r) => ({
    id: r.id, level: r.project_id ? 'project' : 'account', teamName: r.team_name, channels: Number(r.channels), createdBy: r.created_by, createdAt: r.created_at.toISOString(),
  }));
}

/** A workspace `email` may use in project `pid`: the project's, or their own. */
async function workspaceFor(pid: string, email: string, wid: string): Promise<WorkspaceRow> {
  const [w] = isUuid(wid)
    ? await query<WorkspaceRow>('SELECT * FROM slack_workspaces WHERE id = $1 AND (project_id = $2 OR (project_id IS NULL AND owner_email = $3))', [wid, pid, email])
    : [];
  if (!w) throw new HttpError(404, 'Slack workspace not found');
  return w;
}

/** Forget a workspace (its token). Refused while channels use it; WGO's app stays installed in Slack until removed there. */
export async function disconnectWorkspace(pid: string, email: string, wid: string): Promise<void> {
  const w = await workspaceFor(pid, email, wid);
  const used = await query<{ channel: string }>(CHANNELS_OF, [w.id]);
  if (used.length) throw new HttpError(409, `Remove its channel${used.length > 1 ? 's' : ''} first: ${used.map((u) => u.channel).join(', ')}`);
  await query('DELETE FROM slack_workspaces WHERE id = $1', [w.id]);
}

type SlackResponse<T> = T & { ok: boolean; error?: string };

async function slackApi<T>(token: string, method: string, params: Record<string, string>): Promise<SlackResponse<T>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${token}` },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return { ok: false, error: res.status === 429 ? 'ratelimited' : `http_${res.status}` } as SlackResponse<T>;
  return (await res.json()) as SlackResponse<T>;
}

const REVOKED = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive', 'team_access_not_granted']);
function slackFailure(error: string | undefined): HttpError {
  if (error && REVOKED.has(error)) return new HttpError(409, 'Slack no longer accepts WGO in this workspace (was the app removed?). Connect the workspace again.');
  if (error === 'missing_scope') return new HttpError(409, `The Slack app is missing a permission. Add the bot scopes ${SLACK_BOT_SCOPES.join(', ')} and connect the workspace again.`);
  return new HttpError(502, `Slack: ${error ?? 'no response'}`);
}

interface Conversation { id: string; name: string; is_private?: boolean; is_member?: boolean; is_archived?: boolean }

/** Channels WGO can post to: every public channel (chat:write.public), and private ones its bot was invited to. */
export async function listChannels(pid: string, email: string, wid: string): Promise<SlackChannel[]> {
  const w = await workspaceFor(pid, email, wid);
  const out: SlackChannel[] = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const body = await slackApi<{ channels?: Conversation[]; response_metadata?: { next_cursor?: string } }>(w.bot_token, 'conversations.list', {
      types: 'public_channel,private_channel', exclude_archived: 'true', limit: '1000', ...(cursor ? { cursor } : {}),
    });
    if (!body.ok) throw slackFailure(body.error);
    for (const c of body.channels ?? []) if (!c.is_private || c.is_member) out.push({ id: c.id, name: `#${c.name}`, private: !!c.is_private });
    cursor = body.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Channel settings stored with a Slack destination: a workspace channel, or (older) an incoming webhook. */
export interface SlackChannelConfig {
  channel: string;
  teamName: string | null;
  channelId?: string;
  workspaceId?: string; // posted to with the workspace's bot token
  webhookUrl?: string; // connected before workspaces: an incoming webhook
  configurationUrl?: string | null;
}

/**
 * Add a channel of a workspace as a destination, at the workspace's level: a project channel, or the person's own.
 * Checked with Slack: a private channel needs WGO's bot in it.
 */
export async function addChannel(pid: string, email: string, wid: string, channelId: unknown): Promise<Destination> {
  const w = await workspaceFor(pid, email, wid);
  if (typeof channelId !== 'string' || !/^[A-Z][A-Z0-9]{1,30}$/.test(channelId)) throw new HttpError(400, 'channelId must be a Slack channel id, e.g. C0123456789');
  const info = await slackApi<{ channel?: Conversation }>(w.bot_token, 'conversations.info', { channel: channelId });
  const c = info.channel;
  if (!info.ok && info.error !== 'channel_not_found') throw slackFailure(info.error);
  if (!c || (c.is_private && !c.is_member)) throw new HttpError(400, 'WGO can’t see that channel. For a private channel, invite WGO there first (/invite @WGO).');
  if (c.is_archived) throw new HttpError(400, `#${c.name} is archived`);
  const config: SlackChannelConfig = { workspaceId: w.id, channelId: c.id, channel: `#${c.name}`, teamName: w.team_name };
  const account = !w.project_id;
  const dup = account
    ? await query(`SELECT 1 FROM destinations WHERE owner_email = $1 AND project_id IS NULL AND type = 'slack' AND config->>'channelId' = $2`, [email, c.id])
    : await query(`SELECT 1 FROM integrations WHERE project_id = $1 AND type = 'slack' AND config->>'channelId' = $2`, [pid, c.id]);
  if (dup.length) throw new HttpError(409, `${config.channel} is already ${account ? 'one of your destinations' : 'a destination of this project'}`);
  if (account) return saveAccountSlack(email, config);
  const id = randomUUID();
  const [row] = await query<{ created_at: Date }>(
    'INSERT INTO integrations (project_id, id, type, config, created_by) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING created_at',
    [pid, id, 'slack', JSON.stringify(config), email],
  );
  return integrationDestination({ id, type: 'slack', channel: config.channel, teamName: config.teamName, createdBy: email, createdAt: row.created_at.toISOString() });
}

// ---------------------------------------------------------------- sending

/** Where a Slack destination posts, or why it can't (as a delivery status). */
export async function channelTarget(c: SlackChannelConfig, id: string | null): Promise<Target | string> {
  if (c.webhookUrl) return { url: c.webhookUrl, slack: true, secret: null, id };
  const [w] = c.workspaceId && isUuid(c.workspaceId) ? await query<{ bot_token: string }>('SELECT bot_token FROM slack_workspaces WHERE id = $1', [c.workspaceId]) : [];
  return w && c.channelId ? { token: w.bot_token, channelId: c.channelId } : 'slack: workspace disconnected';
}

/** Post a Block Kit message with a bot token. Returns the delivery status: "200", or "slack: <error>". */
export async function postToSlack(t: { token: string; channelId: string }, message: object): Promise<string> {
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${t.token}` },
      body: JSON.stringify({ ...message, channel: t.channelId, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return String(res.status);
    const body = (await res.json()) as { ok: boolean; error?: string };
    return body.ok ? '200' : `slack: ${body.error ?? 'unknown_error'}`;
  } catch (err) {
    return (err as Error).name === 'TimeoutError' ? 'timeout' : `error: ${(err as Error).message}`.slice(0, 120);
  }
}

// ---------------------------------------------------------------- connected channels

export async function listIntegrations(pid: string): Promise<SlackIntegration[]> {
  const rows = await query<{ id: string; config: { channel: string; teamName: string | null }; created_by: string; created_at: Date }>(
    `SELECT id, config, created_by, created_at FROM integrations WHERE project_id = $1 AND type = 'slack' ORDER BY created_at`,
    [pid],
  );
  // never expose the webhook URL itself: it's a credential for posting to the channel
  return rows.map((r) => ({ id: r.id, type: 'slack', channel: r.config.channel, teamName: r.config.teamName, createdBy: r.created_by, createdAt: r.created_at.toISOString() }));
}

export async function deleteIntegration(pid: string, id: string): Promise<void> {
  const used = await query<{ name: string }>(`SELECT name FROM triggers WHERE project_id = $1 AND destination->>'integrationId' = $2`, [pid, id]);
  if (used.length) throw new HttpError(409, `Still used by trigger${used.length > 1 ? 's' : ''}: ${used.map((u) => u.name).join(', ')}`);
  await query(`DELETE FROM integrations WHERE project_id = $1 AND id = $2 AND type = 'slack'`, [pid, id]);
}
