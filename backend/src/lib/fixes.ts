import { randomUUID } from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { ErrorGroup, FixAutoSettings, FixKind, FixRepo, FixResult, FixRun, FixRunStatus, FixSettings, FixSettingsInput, FixStep, FixSummary, FixTarget, FixTargetInfo, GithubRepo, PrState } from '../contract';
import { parseTarget, resolveBackend } from './fixAgent/targets';
import { collectionPaused } from './budgets';
import { effectiveConfig, modelLabel, type EffectiveConfig } from './fixConfig';
import { buildInsert, execute, query } from './db';
import { fixAgentEnabled, listRepos, Repo, REPO_RE, validBranch } from './github';
import { HttpError } from './http';
import { getJobState, setJobState } from './jobState';

/**
 * The GitHub Agent's runs and per-project settings (see lib/github.ts for GitHub, lib/fixAgent/ for the agent).
 *
 * A run starts from the dashboard ("Fix with agent" on an error group), from MCP, or by itself (autoSweep) for error
 * groups that cross the project's thresholds and never had a run. Every start goes through startRun, which refuses
 * when the project hasn't opted in, a cost budget stopped the project, the group already has a run going or an open
 * pull request, or the day's limit is reached.
 */

export const DEFAULT_DENIED_PATHS = [
  '.github/**', '.circleci/**', '.gitlab-ci.yml', '.husky/**', '**/package.json', '**/package-lock.json', '**/yarn.lock',
  '**/pnpm-lock.yaml', '**/Dockerfile', '**/*.sh', '**/*.tf', '**/template.yaml', '**/.env*', '**/.npmrc',
];
const DEFAULT_AUTO: FixAutoSettings = { enabled: false, minEvents: 20, minSessions: 3, maxPerDay: 3 };
/** A run that hasn't finished after this long died with its Lambda (the agent stops itself after 14 minutes). */
const STALE_MS = 20 * 60_000;
const PR_CHECK_MS = 10 * 60_000;

interface SettingsRow {
  project_id: string;
  enabled: boolean;
  installation_id: string | null;
  account: string | null;
  auto: FixAutoSettings | null;
  dashboard_url: string | null;
  updated_by: string | null;
  updated_at: Date;
}

export interface RunRow {
  project_id: string;
  id: string;
  fingerprint: string;
  message: string | null;
  trigger: 'manual' | 'auto';
  kind: FixKind | null; // null: browser (runs from before backend errors)
  target: FixTarget | null;
  requested_by: string | null;
  repo: string;
  status: FixRunStatus;
  steps: FixStep[] | null;
  result: FixResult | null;
  branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: PrState | null;
  pr_checked_at: Date | null;
  model_id: string;
  input_tokens: string | number;
  output_tokens: string | number;
  cost_usd: number | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** Settings the agent itself runs with. */
export interface RunSettings {
  installationId: number;
  repo: string;
  baseBranch: string | null;
  rootPath: string | null;
  instructions: string | null;
  deniedPaths: string[];
  /** The dashboard's origin, for links back from pull requests (remembered when an owner saves the settings). */
  dashboardUrl: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function settingsRow(pid: string): Promise<SettingsRow | null> {
  return (await query<SettingsRow>('SELECT * FROM fix_settings WHERE project_id = $1', [pid]))[0] ?? null;
}

interface RepoRow {
  repo: string;
  base_branch: string | null;
  root_path: string | null;
  instructions: string | null;
  denied_paths: string[] | null;
  browser: boolean;
  services: string[] | null;
}

export async function projectRepos(pid: string): Promise<FixRepo[]> {
  const rows = await query<RepoRow>('SELECT * FROM fix_repos WHERE project_id = $1 ORDER BY position', [pid]);
  return rows.map((r) => ({
    fullName: r.repo, baseBranch: r.base_branch, rootPath: r.root_path, instructions: r.instructions,
    deniedPaths: r.denied_paths ?? DEFAULT_DENIED_PATHS, browser: r.browser, services: r.services ?? [],
  }));
}

/** `checkout-*` matches checkout-api; case doesn't matter. */
const serviceMatches = (pattern: string, service: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(service);

/**
 * The repository an error goes to: a span or log to the first repository listing its service, a JavaScript error to
 * the one fixing the web app, and anything else to the first repository.
 */
export function routeRepo(repos: FixRepo[], kind: FixKind, service: string | null): FixRepo | null {
  if (!repos.length) return null;
  if (kind === 'browser') return repos.find((r) => r.browser) ?? repos[0];
  return (service ? repos.find((r) => r.services.some((p) => serviceMatches(p, service))) : undefined) ?? repos[0];
}

/** Automatic runs started today (UTC): the daily limit counts only these; people can start as many as they like. */
export async function autoRunsToday(pid: string, now = Date.now()): Promise<number> {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const [r] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM fix_runs WHERE project_id = $1 AND created_at >= $2 AND trigger = 'auto'`, [pid, day]);
  return r?.n ?? 0;
}

function toSettings(row: SettingsRow | null, repos: FixRepo[], today: number, model: EffectiveConfig): FixSettings {
  return {
    model: { provider: model.provider, modelId: model.modelId, label: modelLabel(model.provider, model.modelId) },
    enabled: row?.enabled ?? false,
    repos,
    auto: { ...DEFAULT_AUTO, ...(row?.auto ?? {}) },
    installed: !!row?.installation_id,
    account: row?.account ?? null,
    autoRunsToday: today,
    updatedBy: row?.updated_by ?? null,
    updatedAt: row ? row.updated_at.toISOString() : null,
  };
}

export async function getSettings(pid: string): Promise<FixSettings> {
  const [row, repos, today, model] = await Promise.all([settingsRow(pid), projectRepos(pid), autoRunsToday(pid), effectiveConfig()]);
  return toSettings(row, repos, today, model);
}

/** The app was installed for the project (lib/github.ts completeInstall, after checking the person can see it). */
export async function saveInstallation(pid: string, email: string, installationId: number, account: string): Promise<void> {
  await query(
    `INSERT INTO fix_settings (project_id, enabled, installation_id, account, updated_by, updated_at) VALUES ($1, false, $2, $3, $4, now())
     ON CONFLICT (project_id) DO UPDATE SET installation_id = EXCLUDED.installation_id, account = EXCLUDED.account,
       updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [pid, installationId, account, email],
  );
}

export async function repos(pid: string): Promise<GithubRepo[]> {
  const row = await settingsRow(pid);
  if (!row?.installation_id) throw new HttpError(409, 'Install the GitHub App for this project first');
  return listRepos(Number(row.installation_id));
}

/** `dashboard/` for "dashboard", "/dashboard", "./dashboard/"; null for "", "/" or "."; rejects `..`. */
export function normalizeRootPath(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || v.length > 200) throw new HttpError(400, 'Root folder must be up to 200 characters');
  const parts = v.trim().replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..' || /[\0:*?"<>|]/.test(p))) throw new HttpError(400, 'Root folder must be a folder inside the repository');
  return parts.length ? `${parts.join('/')}/` : null;
}

const int = (v: unknown, min: number, max: number, name: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`);
  return n;
};

const MAX_REPOS = 10;
const SERVICE = /^[\w.\-:/@* ]{1,100}$/;

/** One repository from a request, checked; `installed` lists what the GitHub App can see (null: don't check). */
function validRepo(v: Partial<FixRepo>, installed: Set<string> | null): FixRepo {
  const fullName = typeof v.fullName === 'string' ? v.fullName.trim() : '';
  if (!REPO_RE.test(fullName)) throw new HttpError(400, 'Pick a repository');
  if (installed && !installed.has(fullName)) throw new HttpError(400, `The GitHub App isn’t installed on ${fullName}`);
  const baseBranch = typeof v.baseBranch === 'string' && v.baseBranch.trim() ? v.baseBranch.trim() : null;
  if (v.baseBranch != null && typeof v.baseBranch !== 'string') throw new HttpError(400, 'Not a branch name');
  if (baseBranch && !validBranch(baseBranch)) throw new HttpError(400, `${baseBranch} is not a branch name`);
  if (v.instructions != null && (typeof v.instructions !== 'string' || v.instructions.length > 4000)) throw new HttpError(400, 'Instructions must be up to 4000 characters');
  const denied = v.deniedPaths ?? DEFAULT_DENIED_PATHS;
  if (!Array.isArray(denied) || denied.length > 50 || denied.some((p) => typeof p !== 'string' || !p.trim() || p.length > 200)) {
    throw new HttpError(400, 'Protected paths: at most 50 patterns of up to 200 characters');
  }
  const services = v.services ?? [];
  if (!Array.isArray(services) || services.length > 50 || services.some((x) => typeof x !== 'string' || !SERVICE.test(x.trim()))) {
    throw new HttpError(400, 'Services: at most 50 service names of up to 100 characters (* matches any characters)');
  }
  return {
    fullName, baseBranch, rootPath: normalizeRootPath(v.rootPath), instructions: v.instructions?.trim() || null,
    deniedPaths: [...new Set(denied.map((p) => p.trim()))], browser: v.browser === true, services: [...new Set(services.map((x) => x.trim()))],
  };
}

/** PATCH /fix-settings (owners): a partial FixSettingsInput. `dashboard` is the dashboard's origin, for links in pull requests. */
export async function saveSettings(pid: string, email: string, body: Partial<FixSettingsInput>, dashboard: string | null = null): Promise<FixSettings> {
  const row = await settingsRow(pid);
  if (!row?.installation_id) throw new HttpError(409, 'Install the GitHub App for this project first');
  const cur = await projectRepos(pid);
  let repos = cur;
  if (body.repos !== undefined) {
    if (!Array.isArray(body.repos) || body.repos.length > MAX_REPOS) throw new HttpError(400, `At most ${MAX_REPOS} repositories`);
    // only repositories that are new here are checked with GitHub
    const added = body.repos.some((r) => !cur.some((c) => c.fullName === r?.fullName));
    const installed = added ? new Set((await listRepos(Number(row.installation_id))).map((r) => r.fullName)) : null;
    repos = body.repos.map((r) => validRepo(r ?? {}, cur.some((c) => c.fullName === r?.fullName) ? null : installed));
    const names = repos.map((r) => r.fullName.toLowerCase());
    const dup = names.find((n, k) => names.indexOf(n) !== k);
    if (dup) throw new HttpError(400, `${dup} is listed twice`);
    if (repos.filter((r) => r.browser).length > 1) throw new HttpError(400, 'Only one repository can fix the web app’s JavaScript errors');
    const owner = new Map<string, string>();
    for (const r of repos) {
      for (const sv of r.services) {
        const k = sv.toLowerCase();
        if (owner.has(k)) throw new HttpError(400, `The service ${sv} is listed for both ${owner.get(k)} and ${r.fullName}`);
        owner.set(k, r.fullName);
      }
    }
  }
  const enabled = body.enabled ?? row.enabled;
  if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
  const a = { ...DEFAULT_AUTO, ...(row.auto ?? {}), ...(body.auto ?? {}) };
  const auto: FixAutoSettings = {
    enabled: a.enabled === true,
    minEvents: int(a.minEvents, 1, 100_000, 'Minimum events'),
    minSessions: int(a.minSessions, 1, 100_000, 'Minimum sessions'),
    maxPerDay: int(a.maxPerDay, 1, 50, 'Automatic runs per day'),
  };
  if (enabled && !repos.length) throw new HttpError(400, 'Add a repository before turning the GitHub Agent on');
  if (body.repos !== undefined) {
    await execute('DELETE FROM fix_repos WHERE project_id = $1', [pid]);
    if (repos.length) {
      const { sql, params } = buildInsert('fix_repos', ['project_id', 'repo', 'position', 'base_branch', 'root_path', 'instructions', 'denied_paths', 'browser', 'services'],
        repos.map((r, k) => [pid, r.fullName, k, r.baseBranch, r.rootPath, r.instructions, JSON.stringify(r.deniedPaths), r.browser, JSON.stringify(r.services)]),
        { denied_paths: '::jsonb', services: '::jsonb' }, '');
      await query(sql, params);
    }
  }
  await query(
    `UPDATE fix_settings SET enabled = $2, auto = $3, dashboard_url = COALESCE($5, dashboard_url), updated_by = $4, updated_at = now() WHERE project_id = $1`,
    [pid, enabled, JSON.stringify(auto), email, dashboard],
  );
  return getSettings(pid);
}

// ---------------------------------------------------------------- runs

export function toRun(r: RunRow): FixRun {
  return {
    runId: r.id, status: r.status, prUrl: r.pr_url, prNumber: r.pr_number, prState: r.pr_state,
    kind: r.kind ?? 'browser', target: r.target ?? { kind: 'browser', fingerprint: r.fingerprint },
    fingerprint: r.fingerprint, message: r.message, trigger: r.trigger, requestedBy: r.requested_by, repo: r.repo, branch: r.branch,
    steps: r.steps ?? [], result: r.result, error: r.error, modelId: r.model_id,
    inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), costUsd: r.cost_usd,
    createdAt: r.created_at.toISOString(), startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
  };
}

const LIVE: FixRunStatus[] = ['queued', 'running'];

/** Runs whose Lambda died (timeout, crash) without finishing are failed once they're clearly over. */
async function failStale(rows: RunRow[], now = Date.now()): Promise<void> {
  for (const r of rows) {
    if (!LIVE.includes(r.status) || now - r.created_at.getTime() < STALE_MS) continue;
    await execute(`UPDATE fix_runs SET status = 'failed', error = 'The run stopped without finishing', finished_at = now() WHERE project_id = $1 AND id = $2 AND status IN ('queued', 'running')`, [r.project_id, r.id]);
    r.status = 'failed';
    r.error = 'The run stopped without finishing';
  }
}

/** Open pull requests are checked on GitHub at most every 10 minutes, a few per request. */
async function refreshPrStates(pid: string, rows: RunRow[], now = Date.now()): Promise<void> {
  const due = rows.filter((r) => r.pr_number && r.pr_state === 'open' && (!r.pr_checked_at || now - r.pr_checked_at.getTime() > PR_CHECK_MS)).slice(0, 3);
  if (!due.length) return;
  const s = await settingsRow(pid);
  if (!s?.installation_id) return;
  await Promise.all(due.map(async (r) => {
    try {
      const repo = await Repo.open(Number(s.installation_id), r.repo);
      r.pr_state = await repo.prState(r.pr_number!);
      await execute('UPDATE fix_runs SET pr_state = $3, pr_checked_at = now() WHERE project_id = $1 AND id = $2', [pid, r.id, r.pr_state]);
    } catch (err) {
      console.warn(JSON.stringify({ msg: 'checking pull request failed', run: r.id, error: String(err) }));
    }
  }));
}

export async function listRuns(pid: string, q: { fingerprint?: string; limit?: string }): Promise<FixRun[]> {
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const rows = q.fingerprint
    ? await query<RunRow>('SELECT * FROM fix_runs WHERE project_id = $1 AND fingerprint = $2 ORDER BY created_at DESC LIMIT $3', [pid, q.fingerprint, limit])
    : await query<RunRow>('SELECT * FROM fix_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2', [pid, limit]);
  await failStale(rows);
  await refreshPrStates(pid, rows);
  return rows.map(toRun);
}

export async function runRow(pid: string, id: string): Promise<RunRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'Run not found');
  const [r] = await query<RunRow>('SELECT * FROM fix_runs WHERE project_id = $1 AND id = $2', [pid, id]);
  if (!r) throw new HttpError(404, 'Run not found');
  return r;
}

export async function getRun(pid: string, id: string): Promise<FixRun> {
  const r = await runRow(pid, id);
  await failStale([r]);
  await refreshPrStates(pid, [r]);
  return toRun(r);
}

/** The agent checks for this after every tool call and stops. */
export async function cancelRun(pid: string, id: string): Promise<FixRun> {
  await runRow(pid, id);
  await execute(`UPDATE fix_runs SET status = 'cancelled', finished_at = now() WHERE project_id = $1 AND id = $2 AND status IN ('queued', 'running')`, [pid, id]);
  return getRun(pid, id);
}

/** The latest run of each error group, for the Errors page (nothing when the GitHub Agent isn't deployed). */
export async function attachFixes(pid: string, groups: ErrorGroup[]): Promise<void> {
  if (!groups.length || !(await fixAgentEnabled())) return;
  let rows: RunRow[];
  try {
    rows = await query<RunRow>(
      `SELECT id, fingerprint, status, pr_url, pr_number, pr_state, created_at FROM fix_runs
        WHERE project_id = $1 AND fingerprint = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1000`,
      [pid, groups.map((g) => g.fingerprint)],
    );
  } catch (err) {
    // the Errors page must work even when this can't (e.g. a deploy whose schema migration hasn't run)
    console.warn(JSON.stringify({ msg: 'reading fix runs for error groups failed', error: String(err) }));
    return;
  }
  const latest = new Map<string, FixSummary>();
  for (const r of rows) {
    if (latest.has(r.fingerprint)) continue;
    const stale = LIVE.includes(r.status) && Date.now() - r.created_at.getTime() >= STALE_MS;
    latest.set(r.fingerprint, { runId: r.id, status: stale ? 'failed' : r.status, prUrl: r.pr_url, prNumber: r.pr_number, prState: r.pr_state });
  }
  for (const g of groups) g.fix = latest.get(g.fingerprint) ?? null;
}

let lambda: LambdaClient | undefined;

/** Hand a run to the agent (async; locally, without a Lambda, it runs in this process). */
async function dispatch(projectId: string, runId: string): Promise<void> {
  const fn = process.env.FIX_AGENT_FUNCTION;
  if (!fn) {
    const { runFixAgent } = await import('./fixAgent/agent');
    void runFixAgent(projectId, runId).catch((err) => console.error('GitHub Agent failed', err));
    return;
  }
  lambda ??= new LambdaClient({});
  await lambda.send(new InvokeCommand({ FunctionName: fn, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify({ projectId, runId })) }));
}

/** GET /fixes/for: the error a span or log stands for, and the runs for it (any occurrence). */
export async function targetInfo(pid: string, q: Record<string, string | undefined>): Promise<FixTargetInfo> {
  const target = parseTarget(q);
  if (target.kind === 'browser') throw new HttpError(400, 'kind must be span or log');
  const e = await resolveBackend(pid, target);
  if (!e) throw new HttpError(404, target.kind === 'span' ? 'Span not found' : 'Log not found');
  const [runs, repos] = await Promise.all([listRuns(pid, { fingerprint: e.fingerprint, limit: '10' }), projectRepos(pid)]);
  return { fingerprint: e.fingerprint, message: e.message, service: e.service, hasStack: !!e.stack, repo: routeRepo(repos, target.kind, e.service)?.fullName ?? null, runs };
}

/**
 * Start a run. `body` is {fingerprint} for a JavaScript error group or a span/log FixTarget, optionally with `repo`
 * (one of the project's repositories; otherwise routeRepo picks it); `by` is the member who asked (null for automatic
 * runs). `message` (error groups) is the message as shown, kept for the run list only.
 */
export async function startRun(pid: string, by: string | null, body: Record<string, unknown>, trigger: 'manual' | 'auto' = 'manual'): Promise<FixRun> {
  if (!(await fixAgentEnabled())) throw new HttpError(409, 'The GitHub Agent is off for this WGO: an admin turns it on on the GitHub Agent page');
  let target = parseTarget(body);
  const [s, repos] = await Promise.all([settingsRow(pid), projectRepos(pid)]);
  if (!s?.enabled || !s.installation_id || !repos.length) throw new HttpError(409, 'The GitHub Agent is off for this project: a project owner turns it on on the GitHub Agent page');
  const asked = typeof body.repo === 'string' && body.repo ? repos.find((r) => r.fullName === body.repo) : undefined;
  if (typeof body.repo === 'string' && body.repo && !asked) throw new HttpError(400, `${body.repo} isn’t one of this project’s repositories`);
  let service: string | null = null;
  if (await collectionPaused(pid)) throw new HttpError(409, 'A cost budget stopped this project, so the GitHub Agent doesn’t run either');
  let fingerprint: string;
  let message = typeof body.message === 'string' ? body.message.slice(0, 500) : null;
  if (target.kind === 'browser') {
    fingerprint = target.fingerprint;
    const [known] = await query('SELECT 1 FROM error_stacks WHERE project_id = $1 AND fingerprint = $2', [pid, fingerprint]);
    if (!known) throw new HttpError(404, 'No error group with a stack has that fingerprint');
  } else {
    const e = await resolveBackend(pid, target);
    if (!e) throw new HttpError(404, target.kind === 'span' ? 'Span not found' : 'Log not found');
    ({ fingerprint, target } = e);
    message = `${e.service}: ${e.message}`.slice(0, 500);
    service = e.service;
  }
  const repo = asked ?? routeRepo(repos, target.kind, service)!;
  const prev = await query<RunRow>('SELECT * FROM fix_runs WHERE project_id = $1 AND fingerprint = $2 ORDER BY created_at DESC LIMIT 5', [pid, fingerprint]);
  await failStale(prev);
  await refreshPrStates(pid, prev);
  if (prev.some((r) => LIVE.includes(r.status))) throw new HttpError(409, 'The agent is already working on this error');
  const open = prev.find((r) => r.pr_state === 'open');
  if (open) throw new HttpError(409, `Pull request #${open.pr_number} for this error is still open`);
  const auto = { ...DEFAULT_AUTO, ...(s.auto ?? {}) };
  if (trigger === 'auto' && (await autoRunsToday(pid)) >= auto.maxPerDay) throw new HttpError(429, `The GitHub Agent started ${auto.maxPerDay} automatic runs today, this project’s limit`);
  const id = randomUUID();
  await query(
    `INSERT INTO fix_runs (project_id, id, fingerprint, message, trigger, requested_by, repo, status, steps, model_id, kind, target)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', '[]'::jsonb, $8, $9, $10)`,
    [pid, id, fingerprint, message, trigger, by, repo.fullName, (await effectiveConfig()).modelId, target.kind, JSON.stringify(target)],
  );
  try {
    await dispatch(pid, id);
  } catch (err) {
    console.error('starting the GitHub Agent failed', err);
    await execute(`UPDATE fix_runs SET status = 'failed', error = 'Couldn’t start the agent', finished_at = now() WHERE project_id = $1 AND id = $2`, [pid, id]);
    throw new HttpError(502, 'Couldn’t start the agent. Try again');
  }
  return getRun(pid, id);
}

/** What the agent runs with in `repo`; null when the project turned the agent off or removed the repository since. */
export async function runSettings(pid: string, repo: string): Promise<RunSettings | null> {
  const [s, repos] = await Promise.all([settingsRow(pid), projectRepos(pid)]);
  const r = repos.find((x) => x.fullName === repo);
  if (!s?.enabled || !s.installation_id || !r) return null;
  return {
    installationId: Number(s.installation_id), repo: r.fullName, baseBranch: r.baseBranch, rootPath: r.rootPath,
    instructions: r.instructions, deniedPaths: r.deniedPaths, dashboardUrl: s.dashboard_url,
  };
}

// ---------------------------------------------------------------- automatic runs

const SWEEP_JOB = 'fix_auto_sweep';
const SWEEP_EVERY_MS = 5 * 60_000;

/**
 * From the monitor (every minute, acting every 5): for projects with automatic runs on, start runs for error groups
 * that crossed the thresholds in the last hour and never had one, most frequent first, up to the day's limit.
 * Without any such project it's one small query.
 */
export async function autoSweep(now = Date.now()): Promise<{ started: number }> {
  if (!(await fixAgentEnabled())) return { started: 0 };
  const projects = await query<SettingsRow>(`SELECT * FROM fix_settings WHERE enabled AND (auto->>'enabled') = 'true'`);
  if (!projects.length) return { started: 0 };
  const last = await getJobState(SWEEP_JOB);
  if (last && now - last.getTime() < SWEEP_EVERY_MS - 5000) return { started: 0 };
  await setJobState(SWEEP_JOB, new Date(now));
  const { errors } = await import('./analytics');
  let started = 0;
  for (const s of projects) {
    const pid = s.project_id;
    try {
      const auto = { ...DEFAULT_AUTO, ...(s.auto ?? {}) };
      let room = auto.maxPerDay - (await autoRunsToday(pid, now));
      if (room <= 0 || (await collectionPaused(pid))) continue;
      const groups = (await errors(pid, { from: new Date(now - 3600_000).toISOString(), to: new Date(now).toISOString(), limit: '50' }))
        .filter((g) => !g.suppressedBy && g.sampleStack && g.count >= auto.minEvents && g.sessions >= auto.minSessions);
      if (!groups.length) continue;
      const tried = new Set((await query<{ fingerprint: string }>(
        'SELECT DISTINCT fingerprint FROM fix_runs WHERE project_id = $1 AND fingerprint = ANY($2::text[])', [pid, groups.map((g) => g.fingerprint)],
      )).map((r) => r.fingerprint));
      for (const g of groups) {
        if (room <= 0) break;
        if (tried.has(g.fingerprint)) continue;
        try {
          await startRun(pid, null, { fingerprint: g.fingerprint, message: g.message }, 'auto');
          started++;
          room--;
        } catch (err) {
          if (!(err instanceof HttpError) || err.status >= 500) throw err;
        }
      }
    } catch (err) {
      console.warn(JSON.stringify({ msg: 'GitHub Agent sweep failed', project: pid, error: String(err) }));
    }
  }
  return { started };
}
