import { createHmac, createSign, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import type { GithubAppStatus, GithubManifestForm, GithubRepo, PrState } from '../contract';
import { isAdmin } from './admins';
import { query } from './db';
import { HttpError } from './http';

/**
 * The GitHub Agent's GitHub side: one GitHub App per WGO install, created by an admin from a manifest (no client id or
 * secret to set at deploy time), then installed by project owners on the repositories it may fix.
 *
 * - The app asks for contents and pull requests (write) and metadata (read) only. It never gets `workflows`, so
 *   GitHub itself refuses a commit from it that touches .github/workflows.
 * - Installing asks the person to authorize the app too (request_oauth_on_install): the callback checks with their
 *   token that they can see the installation, so nobody can attach someone else's installation to their project by
 *   sending its id.
 * - Tokens for the agent are installation tokens limited to the one repository of the run, valid for an hour.
 *
 * The app's private key is kept in DSQL like the Slack bot tokens (lib/slack.ts); DSQL is encrypted at rest and only
 * reachable with this stack's IAM roles.
 */

/** Whether the GitHub Agent is on for this install (admins switch it on the GitHub Agent page). */
export { fixAgentOn as fixAgentEnabled } from './installSettings';
import { fixAgentOn } from './installSettings';

const API = 'https://api.github.com';
const USER_AGENT = 'wgo-fix-agent';

export class GithubError extends HttpError {
  constructor(status: number, message: string, public readonly ghStatus: number) {
    super(status, message);
  }
}

interface AppRow {
  app_id: string;
  slug: string;
  client_id: string;
  client_secret: string;
  private_key: string;
  html_url: string;
  owner_login: string | null;
  created_by: string;
  created_at: Date;
}

let appCache: { row: AppRow | null; exp: number } | null = null;

export async function appRow(): Promise<AppRow | null> {
  if (appCache && appCache.exp > Date.now()) return appCache.row;
  const [row] = await query<AppRow>(`SELECT * FROM github_app WHERE id = 'app' AND app_id IS NOT NULL`);
  appCache = { row: row ?? null, exp: Date.now() + 60_000 };
  return row ?? null;
}

export const forgetGithubApp = () => { appCache = null; tokens.clear(); };

async function requireApp(): Promise<AppRow> {
  const app = await appRow();
  if (!app) throw new HttpError(409, 'No GitHub App yet: an admin creates it on the GitHub Agent page');
  return app;
}

export async function appStatus(email: string): Promise<GithubAppStatus> {
  const [app, admin] = await Promise.all([appRow(), isAdmin(email)]);
  return {
    enabled: await fixAgentOn(),
    app: app ? { slug: app.slug, htmlUrl: app.html_url, owner: app.owner_login, createdBy: app.created_by, createdAt: app.created_at.toISOString() } : null,
    canCreate: admin,
  };
}

// ---------------------------------------------------------------- signed callback state

const STATE_TTL_MS = 30 * 60 * 1000;

/** HMAC key for callback state, created on first use (the app's own secret doesn't exist before the manifest flow). */
async function stateSecret(): Promise<string> {
  const read = async () => (await query<{ state_secret: string }>(`SELECT state_secret FROM github_app WHERE id = 'state'`))[0]?.state_secret;
  const have = await read();
  if (have) return have;
  await query(`INSERT INTO github_app (id, state_secret) VALUES ('state', $1) ON CONFLICT (id) DO NOTHING`, [randomBytes(32).toString('base64url')]);
  return (await read())!;
}

export type StateKind = 'manifest' | 'install';
export interface GithubState { kind: StateKind; pid: string; email: string; returnTo: string | null }

const mac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

export function signState(secret: string, s: GithubState, now = Date.now()): string {
  const data = Buffer.from(JSON.stringify({ k: s.kind, p: s.pid, e: s.email, r: s.returnTo, x: now + STATE_TTL_MS })).toString('base64url');
  return `${data}.${mac(secret, data)}`;
}

export function verifyState(secret: string, state: string, kind: StateKind, now = Date.now()): GithubState {
  const [data, sig] = state.split('.');
  if (!data || !sig) throw new HttpError(400, 'Bad state');
  const expected = Buffer.from(mac(secret, data));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new HttpError(400, 'Bad state signature');
  const { k, p, e, r, x } = JSON.parse(Buffer.from(data, 'base64url').toString()) as { k: StateKind; p: string; e: string; r: string | null; x: number };
  if (k !== kind) throw new HttpError(400, 'Bad state');
  if (now > x) throw new HttpError(400, 'This GitHub link expired, start again from WGO');
  return { kind: k, pid: p, email: e, returnTo: r ?? null };
}

export async function verifyCallbackState(state: string, kind: StateKind): Promise<GithubState> {
  return verifyState(await stateSecret(), state, kind);
}

// ---------------------------------------------------------------- creating the app (admins)

/** GitHub App names are unique across GitHub and at most 34 characters. */
export function appName(apiDomain: string): string {
  return `WGO ${apiDomain.split('.')[0]}`.slice(0, 34);
}

export function manifest(apiDomain: string, dashboard: string | null): Record<string, unknown> {
  const base = `https://${apiDomain}`;
  return {
    name: appName(apiDomain),
    url: dashboard ?? base,
    description: 'WGO GitHub Agent: opens draft pull requests that fix errors WGO records. A person reviews and merges them.',
    public: false,
    redirect_url: `${base}/github/manifest`,
    setup_url: `${base}/github/setup`,
    callback_urls: [`${base}/github/setup`],
    request_oauth_on_install: true,
    setup_on_update: true,
    hook_attributes: { url: `${base}/github/hook`, active: false },
    default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    default_events: [],
  };
}

const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export async function manifestForm(email: string, pid: string, apiDomain: string, dashboard: string | null, org?: string): Promise<GithubManifestForm> {
  if (!(await fixAgentOn())) throw new HttpError(409, 'The GitHub Agent is off: an admin turns it on on the GitHub Agent page');
  if (!(await isAdmin(email))) throw new HttpError(403, 'Only admins can create the GitHub App');
  if (org && !ORG.test(org)) throw new HttpError(400, 'Not a GitHub organization name');
  const state = signState(await stateSecret(), { kind: 'manifest', pid, email, returnTo: dashboard });
  const page = org ? `https://github.com/organizations/${org}/settings/apps/new` : 'https://github.com/settings/apps/new';
  return { action: `${page}?state=${encodeURIComponent(state)}`, manifest: JSON.stringify(manifest(apiDomain, dashboard)) };
}

/** GET /github/manifest?code&state: GitHub created the app; exchange the code for its id, key and secrets. */
export async function completeManifest(code: string, state: string): Promise<GithubState> {
  const st = await verifyCallbackState(state, 'manifest');
  if (!(await isAdmin(st.email))) throw new HttpError(403, 'Only admins can create the GitHub App');
  if (!/^[\w-]{1,100}$/.test(code)) throw new HttpError(400, 'Bad code');
  const app = await gh<{ id: number; slug: string; client_id: string; client_secret: string; webhook_secret: string | null; pem: string; html_url: string; owner?: { login?: string } }>(
    `/app-manifests/${code}/conversions`, { method: 'POST' });
  await query(
    `INSERT INTO github_app (id, app_id, slug, client_id, client_secret, private_key, webhook_secret, html_url, owner_login, created_by, created_at)
     VALUES ('app', $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (id) DO UPDATE SET app_id = EXCLUDED.app_id, slug = EXCLUDED.slug, client_id = EXCLUDED.client_id,
       client_secret = EXCLUDED.client_secret, private_key = EXCLUDED.private_key, webhook_secret = EXCLUDED.webhook_secret,
       html_url = EXCLUDED.html_url, owner_login = EXCLUDED.owner_login, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at`,
    [app.id, app.slug, app.client_id, app.client_secret, app.pem, app.webhook_secret, app.html_url, app.owner?.login ?? null, st.email],
  );
  forgetGithubApp();
  return st;
}

// ---------------------------------------------------------------- installing it (project owners)

export async function installUrl(pid: string, email: string, dashboard: string | null): Promise<string> {
  const app = await requireApp();
  const state = signState(await stateSecret(), { kind: 'install', pid, email, returnTo: dashboard });
  return `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

/**
 * GET /github/setup?code&installation_id&state: the app was installed and the person authorized it. Their own
 * token must see the installation; then it's saved for the project. Returns the state and the account installed on.
 */
export async function completeInstall(code: string, installationId: string, state: string): Promise<GithubState & { account: string }> {
  const st = await verifyCallbackState(state, 'install');
  const app = await requireApp();
  const id = Number(installationId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Bad installation id');
  if (!code) throw new HttpError(400, 'GitHub did not ask you to authorize the app: reinstall it from WGO');
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ client_id: app.client_id, client_secret: app.client_secret, code }),
    signal: AbortSignal.timeout(10_000),
  });
  const tok = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!tok.access_token) throw new HttpError(400, `GitHub authorization failed: ${tok.error ?? res.status}`);
  let account: string | null = null;
  for (let page = 1; page <= 10 && !account; page++) {
    const list = await gh<{ installations: Array<{ id: number; account?: { login?: string } }> }>(`/user/installations?per_page=100&page=${page}`, { token: tok.access_token });
    const hit = list.installations.find((i) => i.id === id);
    if (hit) account = hit.account?.login ?? '';
    if (list.installations.length < 100) break;
  }
  if (account === null) throw new HttpError(403, 'Your GitHub account can’t see that installation');
  const { saveInstallation } = await import('./fixes');
  await saveInstallation(st.pid, st.email, id, account);
  return { ...st, account };
}

// ---------------------------------------------------------------- tokens

function b64url(v: object | Buffer): string {
  return (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');
}

/** A JWT that authenticates as the app itself (RS256, 9 minutes, backdated a minute for clock drift). */
export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const head = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iat, exp: iat + 600, iss: String(appId) })}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(privateKey).toString('base64url')}`;
}

const tokens = new Map<string, { token: string; exp: number }>();

/** An installation token, for one repository when `repo` (owner/name) is given. Cached until 5 minutes before it expires. */
export async function installationToken(installationId: number, repo?: string): Promise<string> {
  const key = `${installationId}:${repo ?? '*'}`;
  const hit = tokens.get(key);
  if (hit && hit.exp > Date.now() + 5 * 60_000) return hit.token;
  const app = await requireApp();
  const body = repo ? { repositories: [repo.split('/')[1]] } : {};
  const t = await gh<{ token: string; expires_at: string }>(`/app/installations/${installationId}/access_tokens`, {
    method: 'POST', bearer: appJwt(app.app_id, app.private_key), body,
  });
  tokens.set(key, { token: t.token, exp: new Date(t.expires_at).getTime() });
  return t.token;
}

// ---------------------------------------------------------------- REST

interface GhOptions { method?: string; token?: string; bearer?: string; body?: unknown; accept?: string }

export async function gh<T>(path: string, o: GhOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: o.accept ?? 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': USER_AGENT,
  };
  if (o.token || o.bearer) headers.authorization = `Bearer ${o.token ?? o.bearer}`;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { method: o.method ?? 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new GithubError(502, 'GitHub didn’t answer. Try again', 0);
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string };
    const msg = `GitHub ${res.status}: ${err.message ?? res.statusText}`;
    throw new GithubError(res.status === 404 || res.status === 403 || res.status === 422 ? 400 : 502, msg, res.status);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export async function listRepos(installationId: number): Promise<GithubRepo[]> {
  const token = await installationToken(installationId);
  const out: GithubRepo[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await gh<{ repositories: Array<{ full_name: string; default_branch: string; private: boolean }> }>(`/installation/repositories?per_page=100&page=${page}`, { token });
    out.push(...r.repositories.map((x) => ({ fullName: x.full_name, defaultBranch: x.default_branch, private: x.private })));
    if (r.repositories.length < 100) break;
  }
  return out.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^(?!\/|.*(?:\.\.|\/\/|@\{|\.lock$|\/$))[A-Za-z0-9._\/-]{1,200}$/;
export const validBranch = (b: string) => BRANCH_RE.test(b);

/** A repository handle bound to one installation token. */
export class Repo {
  constructor(public readonly fullName: string, private readonly token: string) {
    if (!REPO_RE.test(fullName)) throw new HttpError(400, 'Not a repository name');
  }

  static async open(installationId: number, fullName: string): Promise<Repo> {
    return new Repo(fullName, await installationToken(installationId, fullName));
  }

  private api<T>(path: string, o: Omit<GhOptions, 'token'> = {}) {
    return gh<T>(`/repos/${this.fullName}${path}`, { ...o, token: this.token });
  }

  async defaultBranch(): Promise<string> {
    return (await this.api<{ default_branch: string }>('')).default_branch;
  }

  /** The head commit of a branch and its tree. */
  async head(branch: string): Promise<{ sha: string; tree: string }> {
    if (!validBranch(branch)) throw new HttpError(400, 'Not a branch name');
    const b = await this.api<{ commit: { sha: string; commit: { tree: { sha: string } } } }>(`/branches/${encodeURIComponent(branch)}`);
    return { sha: b.commit.sha, tree: b.commit.commit.tree.sha };
  }

  /**
   * Download the tree of `sha` and unpack it into `dir`: text-sized regular files only (no symlinks, no files over
   * `maxFile` bytes, nothing under node_modules or .git), at most `maxTotal` bytes. Returns what was skipped.
   */
  async download(sha: string, dir: string, maxFile = 1024 * 1024, maxTotal = 300 * 1024 * 1024): Promise<{ files: number; bytes: number; truncated: boolean }> {
    const res = await fetch(`${API}/repos/${this.fullName}/tarball/${sha}`, {
      headers: { authorization: `Bearer ${this.token}`, 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok || !res.body) throw new GithubError(502, `GitHub ${res.status}: couldn’t download the repository`, res.status);
    let files = 0, bytes = 0, truncated = false;
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      tar.x({
        cwd: dir,
        strip: 1,
        preservePaths: false,
        filter: (path, entry) => {
          const e = entry as tar.ReadEntry;
          if (e.type !== 'File' && e.type !== 'Directory') return false;
          if (/(^|\/)(node_modules|\.git)(\/|$)/.test(path)) return false;
          if (e.type === 'File') {
            if ((e.size ?? 0) > maxFile) return false;
            if (bytes + (e.size ?? 0) > maxTotal) { truncated = true; return false; }
            bytes += e.size ?? 0;
            files++;
          }
          return true;
        },
      }),
    );
    return { files, bytes, truncated };
  }

  /**
   * Commit `changes` (path → new content, null = delete) on top of `base` as a new branch. Paths are repository
   * paths; executable files keep their mode.
   */
  async commit(base: { sha: string; tree: string }, branch: string, message: string, changes: Array<{ path: string; content: string | null; executable?: boolean }>): Promise<string> {
    if (!validBranch(branch)) throw new HttpError(400, 'Not a branch name');
    const tree = await Promise.all(changes.map(async (c) => {
      if (c.content === null) return { path: c.path, mode: '100644', type: 'blob', sha: null };
      const blob = await this.api<{ sha: string }>('/git/blobs', { method: 'POST', body: { content: c.content, encoding: 'utf-8' } });
      return { path: c.path, mode: c.executable ? '100755' : '100644', type: 'blob', sha: blob.sha };
    }));
    const t = await this.api<{ sha: string }>('/git/trees', { method: 'POST', body: { base_tree: base.tree, tree } });
    const commit = await this.api<{ sha: string }>('/git/commits', { method: 'POST', body: { message, tree: t.sha, parents: [base.sha] } });
    await this.api('/git/refs', { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
    return commit.sha;
  }

  /** Open a draft pull request; repositories without drafts (private ones on free plans) get a regular one. */
  async openPr(p: { title: string; body: string; head: string; base: string }): Promise<{ number: number; url: string }> {
    const open = (draft: boolean) => this.api<{ number: number; html_url: string }>('/pulls', { method: 'POST', body: { ...p, draft, maintainer_can_modify: true } });
    let pr: { number: number; html_url: string };
    try {
      pr = await open(true);
    } catch (err) {
      if (!(err instanceof GithubError) || err.ghStatus !== 422 || !/draft/i.test(err.message)) throw err;
      pr = await open(false);
    }
    return { number: pr.number, url: pr.html_url };
  }

  async prState(n: number): Promise<PrState> {
    const pr = await this.api<{ state: string; merged_at: string | null }>(`/pulls/${n}`);
    return pr.merged_at ? 'merged' : pr.state === 'open' ? 'open' : 'closed';
  }
}
