import { CreateSecretCommand, DeleteSecretCommand, GetSecretValueCommand, PutSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { FixAgentAdmin, FixAgentConfig, FixAgentConfigInput, FixEffort, FixModelOption, FixProvider, FixUsageRow } from '../contract';
import { FIX_EFFORTS } from '../contract';
import { requireAdmin } from './admins';
import { execute, query } from './db';
import { appRow, fixAgentEnabled } from './github';
import { setSetting } from './installSettings';
import { HttpError } from './http';
import { listProjects } from './projects';

/**
 * Which model the GitHub Agent uses, for every project: Claude on Amazon Bedrock in this AWS account (the default), or
 * the Claude API with the install's own key. Admins set it on the dashboard's GitHub Agent page; until then the deploy
 * parameters (FixAgentModelId, FixAgentEffort) apply.
 *
 * The Claude API key is kept in Secrets Manager (FIX_SECRET_NAME), readable by the agent's function only; the API
 * can write and delete it but never returns it. Only its last 4 characters are stored in DSQL, for display.
 */

export const MODELS: FixModelOption[] = [
  { provider: 'bedrock', modelId: 'global.anthropic.claude-opus-5-5', label: 'Claude Opus 5.5', note: 'The strongest at tracing a bug across files. The default.', pricePerMTok: [4, 20] },
  { provider: 'bedrock', modelId: 'global.anthropic.claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Half the price of Opus; good for errors with a clear source-mapped stack.', pricePerMTok: [2, 10] },
  { provider: 'anthropic', modelId: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'The strongest at tracing a bug across files. The default.', pricePerMTok: [4, 20] },
  { provider: 'anthropic', modelId: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Half the price of Opus; good for errors with a clear source-mapped stack.', pricePerMTok: [2, 10] },
  { provider: 'anthropic', modelId: 'claude-fable-5-2', label: 'Claude Fable 5.2', note: 'Anthropic’s most capable model, for the hardest bugs; about twice the price of Opus.', pricePerMTok: [8, 40] },
];

const MODEL_ID = /^[A-Za-z0-9._:\/-]{3,120}$/;

export interface EffectiveConfig { provider: FixProvider; modelId: string; effort: FixEffort | null }

interface Row {
  provider: FixProvider;
  model_id: string;
  effort: FixEffort;
  key_hint: string | null;
  key_set_by: string | null;
  key_set_at: Date | null;
  anthropic_key: string | null;
  updated_by: string;
  updated_at: Date;
}

async function row(): Promise<Row | null> {
  return (await query<Row>(`SELECT * FROM fix_agent_config WHERE id = 'config'`))[0] ?? null;
}

function deployDefaults(): EffectiveConfig {
  const e = process.env.FIX_MODEL_EFFORT as FixEffort | undefined;
  return { provider: 'bedrock', modelId: process.env.FIX_MODEL_ID || MODELS[0].modelId, effort: e && FIX_EFFORTS.includes(e) ? e : 'high' };
}

/** What runs use now. */
export async function effectiveConfig(): Promise<EffectiveConfig> {
  const r = await row();
  return r ? { provider: r.provider, modelId: r.model_id, effort: r.effort } : deployDefaults();
}

export function modelLabel(provider: FixProvider, modelId: string): string {
  const known = MODELS.find((m) => m.provider === provider && m.modelId === modelId);
  return `${known?.label ?? modelId} ${provider === 'bedrock' ? 'on Amazon Bedrock' : 'through the Claude API'}`;
}

function toConfig(r: Row | null): FixAgentConfig {
  const d = r ? { provider: r.provider, modelId: r.model_id, effort: r.effort } : deployDefaults();
  return {
    provider: d.provider, modelId: d.modelId, effort: d.effort ?? 'high',
    apiKey: r?.key_hint ? { hint: r.key_hint, setBy: r.key_set_by ?? '', setAt: (r.key_set_at ?? r.updated_at).toISOString() } : null,
    updatedBy: r?.updated_by ?? null, updatedAt: r ? r.updated_at.toISOString() : null,
  };
}

// ---------------------------------------------------------------- the key

let sm: SecretsManagerClient | undefined;
const secretName = () => process.env.FIX_SECRET_NAME || null;
let keyCache: { key: string | null; exp: number } | null = null;

/** The saved Claude API key (agent only). */
export async function apiKey(): Promise<string | null> {
  if (keyCache && keyCache.exp > Date.now()) return keyCache.key;
  let key: string | null = null;
  const name = secretName();
  if (name) {
    sm ??= new SecretsManagerClient({});
    try {
      key = (await sm.send(new GetSecretValueCommand({ SecretId: name }))).SecretString ?? null;
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
    }
  } else {
    key = (await row())?.anthropic_key ?? null;
  }
  keyCache = { key, exp: Date.now() + 5 * 60_000 };
  return key;
}

async function storeKey(key: string | null): Promise<void> {
  keyCache = null;
  const name = secretName();
  if (!name) {
    await execute(`UPDATE fix_agent_config SET anthropic_key = $1 WHERE id = 'config'`, [key]);
    return;
  }
  sm ??= new SecretsManagerClient({});
  if (key === null) {
    await sm.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true })).catch((err) => {
      if (!(err instanceof ResourceNotFoundException)) throw err;
    });
    return;
  }
  try {
    await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: key }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
    await sm.send(new CreateSecretCommand({ Name: name, SecretString: key, Description: 'Claude API key for the WGO GitHub Agent' }));
  }
}

/** Ask the Claude API about the model with this key: free, and fails for a wrong key or model id. */
export async function checkKey(key: string, modelId: string): Promise<void> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 10_000 });
  try {
    await client.models.retrieve(modelId);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new HttpError(400, 'The Claude API doesn’t accept that key');
    if (err instanceof Anthropic.NotFoundError) throw new HttpError(400, `The Claude API has no model ${modelId} for that key`);
    if (err instanceof Anthropic.APIError) throw new HttpError(502, `The Claude API answered ${err.status ?? 'with an error'}. Try again`);
    throw new HttpError(502, 'Couldn’t reach the Claude API. Try again');
  }
}

// ---------------------------------------------------------------- the admin page

async function usage(email: string, now = new Date()): Promise<FixAgentAdmin['usage']> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await query<{ project_id: string; runs: number; opened: number; merged: number; tokens: string; cost: number | null }>(
    `SELECT project_id, count(*)::int AS runs,
            sum(CASE WHEN pr_number IS NOT NULL THEN 1 ELSE 0 END)::int AS opened,
            sum(CASE WHEN pr_state = 'merged' THEN 1 ELSE 0 END)::int AS merged,
            sum(input_tokens + output_tokens) AS tokens, sum(cost_usd)::float8 AS cost
       FROM fix_runs WHERE created_at >= $1 GROUP BY project_id`,
    [since],
  );
  const mine = new Map((await listProjects(email)).map((p) => [p.id, p.name]));
  const total = { runs: 0, prsOpened: 0, prsMerged: 0, tokens: 0, costUsd: 0 };
  const other: FixUsageRow = { projectId: null, name: 'Other projects', ...total };
  const projects: FixUsageRow[] = [];
  let others = 0;
  for (const r of rows) {
    const u = { runs: r.runs, prsOpened: r.opened, prsMerged: r.merged, tokens: Number(r.tokens ?? 0), costUsd: Math.round((r.cost ?? 0) * 100) / 100 };
    for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += u[k];
    const name = mine.get(r.project_id);
    if (name) projects.push({ projectId: r.project_id, name, ...u });
    else { others++; for (const k of Object.keys(total) as Array<keyof typeof total>) other[k] += u[k]; }
  }
  projects.sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs);
  if (others) projects.push({ ...other, name: `${others} other project${others === 1 ? '' : 's'}` });
  total.costUsd = Math.round(total.costUsd * 100) / 100;
  return { since: since.toISOString(), total, projects };
}

export async function getAdmin(email: string): Promise<FixAgentAdmin> {
  await requireAdmin(email);
  const [r, use, app, [on], enabled] = await Promise.all([
    row(), usage(email), appRow(),
    query<{ n: number }>('SELECT count(*)::int AS n FROM fix_settings WHERE enabled'),
    fixAgentEnabled(),
  ]);
  return {
    enabled, config: toConfig(r), models: MODELS, usage: use, projectsOn: on?.n ?? 0,
    app: app ? { slug: app.slug, htmlUrl: app.html_url, owner: app.owner_login, createdBy: app.created_by, createdAt: app.created_at.toISOString() } : null,
  };
}

export async function saveAdmin(email: string, body: Partial<FixAgentConfigInput>): Promise<FixAgentAdmin> {
  await requireAdmin(email);
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    await setSetting('fix_agent', { enabled: body.enabled }, email);
  }
  // only the switch: leave the model settings (and who changed them last) alone
  if (body.provider === undefined && body.modelId === undefined && body.effort === undefined && body.apiKey === undefined) return getAdmin(email);
  const r = await row();
  const cur = toConfig(r);
  const provider = body.provider ?? cur.provider;
  if (provider !== 'bedrock' && provider !== 'anthropic') throw new HttpError(400, 'provider must be bedrock or anthropic');
  const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : body.provider && body.provider !== cur.provider ? MODELS.find((m) => m.provider === provider)!.modelId : cur.modelId;
  if (!MODEL_ID.test(modelId)) throw new HttpError(400, 'Not a model id');
  if (provider === 'anthropic' && /^(global|us|eu|apac|jp|au)\.|^anthropic\./.test(modelId)) throw new HttpError(400, 'That’s a Bedrock model id. The Claude API uses ids like claude-opus-5-5');
  if (provider === 'bedrock' && !/anthropic\.claude/.test(modelId)) throw new HttpError(400, 'Use a Claude model on Bedrock, e.g. global.anthropic.claude-opus-5-5 (the agent’s permissions cover Claude models only)');
  const effort = body.effort ?? cur.effort;
  if (!FIX_EFFORTS.includes(effort)) throw new HttpError(400, `effort must be one of ${FIX_EFFORTS.join(', ')}`);

  const newKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : null;
  if (body.apiKey !== undefined && body.apiKey !== null && !/^sk-ant-[\w-]{20,300}$/.test(newKey ?? '')) throw new HttpError(400, 'That doesn’t look like a Claude API key (they start with sk-ant-)');
  const removing = body.apiKey === null;
  const hasKey = newKey ? true : removing ? false : !!cur.apiKey;
  if (provider === 'anthropic' && !hasKey) throw new HttpError(400, 'Add a Claude API key to use the Claude API');
  // check the key (or the saved one, with a new model) before anything is saved
  if (provider === 'anthropic' && (newKey || provider !== cur.provider || modelId !== cur.modelId)) {
    const key = newKey ?? (await apiKey());
    if (!key) throw new HttpError(400, 'Add a Claude API key to use the Claude API');
    await checkKey(key, modelId);
  }

  await query(
    `INSERT INTO fix_agent_config (id, provider, model_id, effort, updated_by, updated_at) VALUES ('config', $1, $2, $3, $4, now())
     ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, model_id = EXCLUDED.model_id, effort = EXCLUDED.effort,
       updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [provider, modelId, effort, email],
  );
  if (newKey) {
    await storeKey(newKey);
    await execute(`UPDATE fix_agent_config SET key_hint = $1, key_set_by = $2, key_set_at = now() WHERE id = 'config'`, [newKey.slice(-4), email]);
  } else if (removing) {
    await storeKey(null);
    await execute(`UPDATE fix_agent_config SET key_hint = NULL, key_set_by = NULL, key_set_at = NULL WHERE id = 'config'`);
  }
  return getAdmin(email);
}
