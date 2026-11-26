import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { InstallFeatures, InstallSettings } from '../contract';
import { requireAdmin } from './admins';
import { HttpError } from './http';
import { fixAgentOn, getSecret, getSetting, mcpOn, putSecret, setSetting, slackApp, type McpSetting, type SlackAppSetting } from './installSettings';
import { createAppUrl, redirectUrl } from './slack';

/**
 * What admins turn on for the whole install, in the dashboard: MCP (MCP page), the install's Slack app (Triggers page)
 * and the GitHub Agent (GitHub Agent page, lib/fixConfig.ts). These used to be deploy settings.
 */

export async function features(): Promise<InstallFeatures> {
  const [fixAgent, mcp, slack] = await Promise.all([fixAgentOn(), mcpOn(), slackApp()]);
  return { fixAgent, mcp, slackApp: !!slack };
}

export async function getInstall(email: string, apiDomain: string, dashboard: string | null): Promise<InstallSettings> {
  await requireAdmin(email);
  const [f, s, secret] = await Promise.all([features(), getSetting<SlackAppSetting>('slack_app'), getSecret('slack-client-secret')]);
  return {
    ...f,
    slack: { clientId: s?.clientId ?? null, secretSet: !!(s && secret), fromEnv: !s && !!process.env.SLACK_CLIENT_ID, redirectUrl: redirectUrl(apiDomain), createAppUrl: createAppUrl(apiDomain) },
    mcpUrl: dashboard ? `${dashboard}/mcp` : null,
  };
}

let lambda: LambdaClient | undefined;

/**
 * Turn MCP on or off. Cognito's client registration is changed by the MCP auth function, the only code allowed to
 * change the user pool; the API may only invoke it. Locally (no function) only the setting changes.
 */
export async function setMcp(email: string, enabled: unknown, apiDomain: string, dashboard: string | null): Promise<InstallSettings> {
  await requireAdmin(email);
  if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
  const fn = process.env.MCP_AUTH_FUNCTION;
  if (fn) {
    lambda ??= new LambdaClient({});
    const res = await lambda.send(new InvokeCommand({ FunctionName: fn, InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify({ action: 'set', enabled })) }));
    if (res.FunctionError) {
      const detail = Buffer.from(res.Payload ?? []).toString().slice(0, 300);
      console.error('turning MCP auth on/off failed', detail);
      throw new HttpError(502, `Couldn’t change Cognito’s MCP sign-in: ${(JSON.parse(detail || '{}') as { errorMessage?: string }).errorMessage ?? 'see the McpAuthFunction logs'}`);
    }
  } else {
    const cur = await getSetting<McpSetting>('mcp');
    await setSetting('mcp', { ...(cur ?? {}), enabled }, email);
  }
  return getInstall(email, apiDomain, dashboard);
}

/** Check a Slack app's client id and secret: with a made-up code, Slack says whether it's the code or the app that's wrong. */
async function checkSlackApp(clientId: string, clientSecret: string): Promise<void> {
  let body: { ok?: boolean; error?: string };
  try {
    const res = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: 'wgo-credentials-check' }),
      signal: AbortSignal.timeout(8000),
    });
    body = (await res.json()) as { ok?: boolean; error?: string };
  } catch {
    throw new HttpError(502, 'Slack didn’t answer. Try again');
  }
  if (body.error === 'invalid_client_id') throw new HttpError(400, 'Slack doesn’t know that client ID. Copy it from the app’s Basic Information page');
  if (body.error === 'bad_client_secret') throw new HttpError(400, 'That client secret doesn’t belong to this app. Copy it from the app’s Basic Information page');
}

const CLIENT_ID = /^\d{6,20}\.\d{6,20}$/;
const SECRET = /^[0-9a-f]{32}$/i;

export async function setSlackApp(email: string, body: { clientId?: unknown; clientSecret?: unknown }, apiDomain: string, dashboard: string | null): Promise<InstallSettings> {
  await requireAdmin(email);
  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
  const given = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '';
  if (!CLIENT_ID.test(clientId)) throw new HttpError(400, 'That doesn’t look like a Slack client ID (two numbers with a dot, e.g. 1234567890.1234567890)');
  // keep the saved secret when only the id changes
  const clientSecret = given || (await getSecret('slack-client-secret')) || '';
  if (!SECRET.test(clientSecret)) throw new HttpError(400, 'That doesn’t look like a Slack client secret (32 letters and digits)');
  await checkSlackApp(clientId, clientSecret);
  await putSecret('slack-client-secret', clientSecret, email, 'Client secret of the WGO Slack app');
  await setSetting('slack_app', { clientId }, email);
  return getInstall(email, apiDomain, dashboard);
}

export async function deleteSlackApp(email: string, apiDomain: string, dashboard: string | null): Promise<InstallSettings> {
  await requireAdmin(email);
  await setSetting('slack_app', null, email);
  await putSecret('slack-client-secret', null, email);
  return getInstall(email, apiDomain, dashboard);
}
