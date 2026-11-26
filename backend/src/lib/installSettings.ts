import { CreateSecretCommand, DeleteSecretCommand, GetSecretValueCommand, PutSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { query } from './db';

/**
 * Settings for the whole install that admins change in the dashboard instead of at deploy time (install_settings, one
 * row per key): the GitHub Agent and MCP switches and the install's Slack app. Secrets (the Slack app's client
 * secret) go to Secrets Manager under `<stack>/…` (SECRET_PREFIX); without it (local development) they're kept in
 * this table.
 */

export type SettingKey = 'fix_agent' | 'mcp' | 'slack_app';
export interface McpSetting { enabled: boolean; userPoolId?: string; scopes?: string[] }
export interface SlackAppSetting { clientId: string }

const TTL_MS = 30_000;
const cache = new Map<string, { value: unknown; exp: number }>();

export async function getSetting<T>(key: SettingKey | `secret:${string}`): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value as T | null;
  const [r] = await query<{ value: T }>('SELECT value FROM install_settings WHERE key = $1', [key]);
  cache.set(key, { value: r?.value ?? null, exp: Date.now() + TTL_MS });
  return r?.value ?? null;
}

export async function setSetting(key: SettingKey | `secret:${string}`, value: unknown, by: string): Promise<void> {
  if (value === null) await query('DELETE FROM install_settings WHERE key = $1', [key]);
  else {
    await query(
      `INSERT INTO install_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [key, JSON.stringify(value), by],
    );
  }
  cache.delete(key);
}

export const forgetSettings = () => cache.clear();

// ---------------------------------------------------------------- switches

/**
 * Whether the GitHub Agent is on. Installs that used it before it had a switch (a GitHub App, or a project with it
 * on) count as on until an admin decides.
 */
export async function fixAgentOn(): Promise<boolean> {
  const s = await getSetting<{ enabled: boolean }>('fix_agent');
  if (s) return s.enabled === true;
  const hit = cache.get('fix_agent:legacy');
  if (hit && hit.exp > Date.now()) return hit.value as boolean;
  const [used] = await query(`SELECT 1 FROM github_app WHERE id = 'app' AND app_id IS NOT NULL UNION ALL SELECT 1 FROM fix_settings WHERE enabled LIMIT 1`);
  cache.set('fix_agent:legacy', { value: !!used, exp: Date.now() + TTL_MS });
  return !!used;
}

/** Whether MCP is on (the McpAuth custom resource writes the setting on every deploy, so it exists once deployed). */
export async function mcpOn(): Promise<boolean> {
  return (await getSetting<McpSetting>('mcp'))?.enabled === true;
}

// ---------------------------------------------------------------- secrets

let sm: SecretsManagerClient | undefined;
const secretId = (name: string) => (process.env.SECRET_PREFIX ? `${process.env.SECRET_PREFIX}/${name}` : null);

export async function getSecret(name: string): Promise<string | null> {
  const id = secretId(name);
  if (!id) return (await getSetting<{ v: string }>(`secret:${name}`))?.v ?? null;
  const hit = cache.get(`secret:${name}`);
  if (hit && hit.exp > Date.now()) return hit.value as string | null;
  sm ??= new SecretsManagerClient({});
  let v: string | null = null;
  try {
    v = (await sm.send(new GetSecretValueCommand({ SecretId: id }))).SecretString ?? null;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
  cache.set(`secret:${name}`, { value: v, exp: Date.now() + 5 * 60_000 });
  return v;
}

export async function putSecret(name: string, value: string | null, by: string, description = 'WGO'): Promise<void> {
  cache.delete(`secret:${name}`);
  const id = secretId(name);
  if (!id) return setSetting(`secret:${name}`, value === null ? null : { v: value }, by);
  sm ??= new SecretsManagerClient({});
  if (value === null) {
    await sm.send(new DeleteSecretCommand({ SecretId: id, ForceDeleteWithoutRecovery: true })).catch((err) => {
      if (!(err instanceof ResourceNotFoundException)) throw err;
    });
    return;
  }
  try {
    await sm.send(new PutSecretValueCommand({ SecretId: id, SecretString: value }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
    await sm.send(new CreateSecretCommand({ Name: id, SecretString: value, Description: description }));
  }
}

// ---------------------------------------------------------------- the install's Slack app

/**
 * The install's own Slack app, for "Add to Slack" in every project. Set by admins in the dashboard; the old
 * SLACK_CLIENT_ID / SLACK_CLIENT_SECRET environment variables still work (local development).
 */
export async function slackApp(): Promise<{ clientId: string; clientSecret: string } | null> {
  const s = await getSetting<SlackAppSetting>('slack_app');
  if (s?.clientId) {
    const secret = await getSecret('slack-client-secret');
    if (secret) return { clientId: s.clientId, clientSecret: secret };
  }
  const clientId = process.env.SLACK_CLIENT_ID ?? '';
  const clientSecret = process.env.SLACK_CLIENT_SECRET ?? '';
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
