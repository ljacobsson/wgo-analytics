import type { InstallFeatures, InstallSettings, FixTarget, FixTargetInfo, ErrorGroup, FixAgentAdmin, FixAgentConfig, FixAgentConfigInput, FixModelOption, FixRun, FixSettings, FixSettingsInput, FixStep, FixUsageRow, GithubAppStatus } from '../api/contract';

/**
 * The GitHub Agent in mock mode. The GitHub App exists already (?mock_noapp shows the "create" step), installing it
 * comes straight back as installed, and a run plays out over about 15 seconds: queued, a few steps, then a pull
 * request (or, for errors without a stack frame in app code, no fix).
 */

const KEY = 'wgo-mock-fixes';
interface State { installed: boolean; settings: Omit<FixSettings, 'model' | 'installed' | 'account' | 'autoRunsToday' | 'updatedBy' | 'updatedAt'> | null; runs: FixRun[] }
export const DENIED = ['.github/**', '.circleci/**', '.gitlab-ci.yml', '.husky/**', '**/package.json', '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/Dockerfile', '**/*.sh', '**/*.tf', '**/template.yaml', '**/.env*', '**/.npmrc'];

const load = (pid: string): State => {
  try { return JSON.parse(localStorage.getItem(`${KEY}:${pid}`) ?? '') as State; } catch { return { installed: false, settings: null, runs: [] }; }
};
const save = (pid: string, s: State) => localStorage.setItem(`${KEY}:${pid}`, JSON.stringify(s));

export function githubApp(email: string, admin: boolean): GithubAppStatus {
  const none = new URLSearchParams(location.search).has('mock_noapp');
  return { enabled: true, canCreate: admin, app: none ? null : { slug: 'wgo-acme', htmlUrl: 'https://github.com/apps/wgo-acme', owner: 'acme', createdBy: email, createdAt: new Date(Date.now() - 5 * 86400e3).toISOString() } };
}

function settingsOf(pid: string, st: State, email: string | null): FixSettings {
  const day = new Date(); day.setUTCHours(0, 0, 0, 0);
  const base = st.settings && Array.isArray(st.settings.repos) ? st.settings : { enabled: false, repos: [], auto: { enabled: false, minEvents: 20, minSessions: 3, maxPerDay: 3 } };
  void pid;
  const c = adminConfig();
  const label = `${MODELS.find((m) => m.provider === c.provider && m.modelId === c.modelId)?.label ?? c.modelId} ${c.provider === 'bedrock' ? 'on Amazon Bedrock' : 'through the Claude API'}`;
  return { ...base, model: { provider: c.provider, modelId: c.modelId, label }, installed: st.installed, account: st.installed ? 'acme' : null, autoRunsToday: st.runs.filter((r) => r.trigger === 'auto' && Date.parse(r.createdAt) >= day.getTime()).length, updatedBy: st.settings ? email : null, updatedAt: st.settings ? new Date().toISOString() : null };
}

const STEPS: Array<[number, string, string]> = [
  [3, 'download', 'acme/storefront@main (4f2a9c1)'],
  [4.5, 'read_file', 'src/lib/cart.ts:1-120'],
  [6, 'grep', '/computeTotal/ in src/**'],
  [7.5, 'read_file', 'src/components/CartSummary.tsx:1-40'],
  [9, 'get_session_timeline', 's_7f3a2c'],
  [10.5, 'edit_file', 'src/lib/cart.ts'],
  [12, 'create_file', 'src/lib/cart.test.ts'],
  [13, 'diff', ''],
];
const DONE_S = 15;

/** Where a run is now, from how long ago it started. */
function advance(r: FixRun, now = Date.now()): FixRun {
  if (r.status !== 'queued' && r.status !== 'running') return r;
  const t = (now - Date.parse(r.createdAt)) / 1000;
  const steps: FixStep[] = STEPS.filter(([at]) => at <= t).map(([at, tool, summary]) => ({ ts: new Date(Date.parse(r.createdAt) + at * 1000).toISOString(), tool, summary }));
  if (t < 2.5) return r;
  if (t < DONE_S) return { ...r, status: 'running', startedAt: new Date(Date.parse(r.createdAt) + 2500).toISOString(), steps, inputTokens: Math.round(t * 9000), outputTokens: Math.round(t * 180) };
  const fixed = !/Script error|ResizeObserver/i.test(r.message ?? '');
  const n = 40 + (Date.parse(r.createdAt) % 50);
  return {
    ...r, status: fixed ? 'pr_opened' : 'no_fix', steps: [...steps, { ts: new Date().toISOString(), tool: 'commit', summary: '2 files' }, { ts: new Date().toISOString(), tool: 'pull_request', summary: `#${n}` }].slice(0, fixed ? undefined : steps.length),
    startedAt: new Date(Date.parse(r.createdAt) + 2500).toISOString(), finishedAt: new Date(Date.parse(r.createdAt) + DONE_S * 1000).toISOString(),
    inputTokens: 148_000, outputTokens: 3_900, costUsd: 0.31,
    ...(fixed ? { prNumber: n, prUrl: `https://github.com/acme/storefront/pull/${n}`, prState: 'open' as const, branch: `wgo-fix/${r.fingerprint.slice(0, 12)}-${r.runId.slice(0, 8)}` } : {}),
    result: fixed
      ? { outcome: 'fixed', rootCause: 'computeTotal assumes every cart line still has its product. When a product is removed from the catalog while it sits in someone\'s cart, the line keeps its quantity but product is undefined, so reading product.price throws.', summary: 'Skip cart lines whose product no longer exists when computing the total, the same way the cart page already hides them. Added a test with a line whose product was removed.', confidence: 'high', testsAdded: true, files: ['src/lib/cart.ts', 'src/lib/cart.test.ts'] }
      : { outcome: 'not_fixable', rootCause: 'The error comes from a third-party script (no frames in this repository).', summary: 'Every frame of the stack is in a script loaded from another origin, so there is nothing to change here. Consider suppressing it.', confidence: 'medium', testsAdded: false, files: [] },
  };
}

export function attachFixes(pid: string, groups: ErrorGroup[]): ErrorGroup[] {
  const st = load(pid);
  if (!st.runs.length) return groups;
  return groups.map((g) => {
    const r = st.runs.find((x) => x.fingerprint === g.fingerprint);
    if (!r) return g;
    const a = advance(r);
    return { ...g, fix: { runId: a.runId, status: a.status, prUrl: a.prUrl, prNumber: a.prNumber, prState: a.prState } };
  });
}

export class FixMockError extends Error { constructor(public status: number, m: string) { super(m); } }

export function fixApi(pid: string, owner: boolean, email: string, method: string, sub: string, parts: string[], body: unknown, qp: (k: string) => string | undefined): unknown {
  const st = load(pid);
  st.runs = st.runs.map((r) => advance(r));
  if (sub === 'fix-settings') {
    const what = parts[3];
    if (!what && method === 'GET') return settingsOf(pid, st, email);
    if (!owner) throw new FixMockError(403, 'Only project owners can do that');
    if (what === 'install-url') { st.installed = true; save(pid, st); return { url: `${location.pathname}${location.search}#/p/${pid}/fix-agent?github=installed` }; }
    if (what === 'repos') return [{ fullName: 'acme/storefront', defaultBranch: 'main', private: true }, { fullName: 'acme/platform', defaultBranch: 'main', private: true }, { fullName: 'acme/marketing-site', defaultBranch: 'main', private: false }];
    if (!what && method === 'PATCH') {
      if (!st.installed) throw new FixMockError(409, 'Install the GitHub App for this project first');
      const cur = settingsOf(pid, st, email);
      const b = body as Partial<FixSettingsInput>;
      const next = { ...cur, ...b, auto: { ...cur.auto, ...(b.auto ?? {}) } };
      if (next.enabled && !next.repos.length) throw new FixMockError(400, 'Add a repository before turning the GitHub Agent on');
      if (next.repos.filter((r) => r.browser).length > 1) throw new FixMockError(400, 'Only one repository can fix the web app’s JavaScript errors');
      const names = next.repos.map((r) => r.fullName);
      if (names.some((n, k) => names.indexOf(n) !== k)) throw new FixMockError(400, 'A repository is listed twice');
      if (next.auto.maxPerDay < 1 || next.auto.maxPerDay > 50) throw new FixMockError(400, 'Automatic runs per day must be a whole number from 1 to 50');
      st.settings = { enabled: next.enabled, repos: next.repos.map((r) => ({ ...r, rootPath: r.rootPath ? `${r.rootPath.replace(/^\.?\/+|\/+$/g, '')}/` : null })), auto: next.auto };
      save(pid, st);
      return settingsOf(pid, st, email);
    }
  }
  if (sub === 'fixes') {
    const [id, action] = [parts[3], parts[4]];
    if (!id && method === 'GET') {
      if (qp('pr') === '1') return [...st.runs.filter((r) => r.prNumber), ...demoPullRequests(s0(pid, st, email))].slice(0, Number(qp('limit') ?? 50));
      const fp = qp('fingerprint');
      return st.runs.filter((r) => !fp || r.fingerprint === fp).slice(0, Number(qp('limit') ?? 50));
    }
    if (id === 'for' && method === 'GET') {
      const t = targetOf(qp);
      const fp = `${t.kind}:${t.kind === 'span' ? t.spanId : t.kind === 'log' ? t.logId : ''}`;
      const repos = settingsOf(pid, st, email).repos;
      const repo = (repos.find((r) => r.services.some((x) => x === 'cart-service' || (x.endsWith('*') && 'cart-service'.startsWith(x.slice(0, -1))))) ?? repos[0])?.fullName ?? null;
      return { fingerprint: fp, message: t.kind === 'span' ? 'TypeError: Cannot read properties of undefined (reading \'sku\')' : 'Unhandled error in request handler', service: 'cart-service', hasStack: true, repo, runs: st.runs.filter((r) => r.fingerprint === fp) } satisfies FixTargetInfo;
    }
    if (!id && method === 'POST') {
      const s = settingsOf(pid, st, email);
      const raw = body as { fingerprint?: string; message?: string; kind?: string };
      const target: FixTarget = raw.kind === 'span' || raw.kind === 'log' ? targetOf((k) => (body as Record<string, string | undefined>)[k]) : { kind: 'browser', fingerprint: raw.fingerprint ?? '' };
      const b = target.kind === 'browser' ? { fingerprint: target.fingerprint, message: raw.message }
        : { fingerprint: `${target.kind}:${target.kind === 'span' ? target.spanId : target.logId}`, message: `cart-service: ${target.kind === 'span' ? 'TypeError: Cannot read properties of undefined (reading \'sku\')' : 'Unhandled error in request handler'}` };
      if (!s.enabled || !s.repos.length) throw new FixMockError(409, 'The GitHub Agent is off for this project: a project owner turns it on on the GitHub Agent page');
      const prev = st.runs.filter((r) => r.fingerprint === b.fingerprint);
      if (prev.some((r) => r.status === 'queued' || r.status === 'running')) throw new FixMockError(409, 'The agent is already working on this error');
      const open = prev.find((r) => r.prState === 'open');
      if (open) throw new FixMockError(409, `Pull request #${open.prNumber} for this error is still open`);
      const run: FixRun = {
        runId: crypto.randomUUID(), status: 'queued', prUrl: null, prNumber: null, prState: null, kind: target.kind, target, fingerprint: b.fingerprint, message: b.message ?? null,
        trigger: 'manual', requestedBy: email, repo: typeof (body as { repo?: string }).repo === 'string' ? (body as { repo: string }).repo : target.kind === 'browser' ? (s.repos.find((r) => r.browser) ?? s.repos[0]).fullName : s.repos[0].fullName, branch: null, steps: [], result: null, error: null, modelId: adminConfig().modelId,
        inputTokens: 0, outputTokens: 0, costUsd: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      };
      st.runs.unshift(run);
      save(pid, st);
      return run;
    }
    const run = st.runs.find((r) => r.runId === id);
    if (!run) throw new FixMockError(404, 'Run not found');
    if (action === 'cancel' && method === 'POST') {
      if (run.status === 'queued' || run.status === 'running') Object.assign(run, { status: 'cancelled', finishedAt: new Date().toISOString() });
      save(pid, st);
    }
    return run;
  }
  throw new FixMockError(405, 'Method not allowed');
}

// ---------------------------------------------------------------- the admins' GitHub Agent page

const MODELS: FixModelOption[] = [
  { provider: 'bedrock', modelId: 'global.anthropic.claude-opus-5-5', label: 'Claude Opus 5.5', note: 'The strongest at tracing a bug across files. The default.', pricePerMTok: [4, 20] },
  { provider: 'bedrock', modelId: 'global.anthropic.claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Half the price of Opus; good for errors with a clear source-mapped stack.', pricePerMTok: [2, 10] },
  { provider: 'anthropic', modelId: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'The strongest at tracing a bug across files. The default.', pricePerMTok: [4, 20] },
  { provider: 'anthropic', modelId: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Half the price of Opus; good for errors with a clear source-mapped stack.', pricePerMTok: [2, 10] },
  { provider: 'anthropic', modelId: 'claude-fable-5-2', label: 'Claude Fable 5.2', note: 'Anthropic’s most capable model, for the hardest bugs; about twice the price of Opus.', pricePerMTok: [8, 40] },
];
const ADMIN_KEY = 'wgo-mock-fix-admin';
const adminConfig = (): FixAgentConfig => {
  try { return JSON.parse(localStorage.getItem(ADMIN_KEY) ?? '') as FixAgentConfig; } catch { return { provider: 'bedrock', modelId: MODELS[0].modelId, effort: 'high', apiKey: null, updatedBy: null, updatedAt: null }; }
};

export function fixAdminApi(method: string, body: unknown, email: string, projects: Array<{ id: string; name: string }>, admin: boolean): FixAgentAdmin {
  if (!admin) throw new FixMockError(403, 'Only admins can see what the install costs and manage budgets');
  let c = adminConfig();
  if (method === 'PATCH' && (body as Partial<FixAgentConfigInput>).enabled !== undefined) {
    const b = body as Partial<FixAgentConfigInput>;
    saveFeatures({ fixAgent: b.enabled === true });
    if (b.provider === undefined && b.modelId === undefined && b.effort === undefined && b.apiKey === undefined) return fixAdminApi('GET', null, email, projects, admin);
  }
  if (method === 'PATCH') {
    const b = body as Partial<FixAgentConfigInput>;
    const provider = b.provider ?? c.provider;
    const modelId = b.modelId ?? c.modelId;
    if (provider === 'anthropic' && /^(global|us|eu)\.|^anthropic\./.test(modelId)) throw new FixMockError(400, 'That’s a Bedrock model id. The Claude API uses ids like claude-opus-5-5');
    if (typeof b.apiKey === 'string' && !/^sk-ant-[\w-]{20,300}$/.test(b.apiKey)) throw new FixMockError(400, 'That doesn’t look like a Claude API key (they start with sk-ant-)');
    if (typeof b.apiKey === 'string' && b.apiKey.endsWith('bad')) throw new FixMockError(400, 'The Claude API doesn’t accept that key');
    const key = typeof b.apiKey === 'string' ? { hint: b.apiKey.slice(-4), setBy: email, setAt: new Date().toISOString() } : b.apiKey === null ? null : c.apiKey;
    if (provider === 'anthropic' && !key) throw new FixMockError(400, 'Add a Claude API key to use the Claude API');
    c = { provider, modelId, effort: b.effort ?? c.effort, apiKey: key, updatedBy: email, updatedAt: new Date().toISOString() };
    localStorage.setItem(ADMIN_KEY, JSON.stringify(c));
  }
  const since = new Date(); since.setUTCDate(1); since.setUTCHours(0, 0, 0, 0);
  const rows: FixUsageRow[] = projects.map((p) => {
    const runs = load(p.id).runs.map((r) => advance(r)).filter((r) => Date.parse(r.createdAt) >= since.getTime());
    return { projectId: p.id, name: p.name, runs: runs.length, prsOpened: runs.filter((r) => r.prNumber).length, prsMerged: 0, tokens: runs.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0), costUsd: Math.round(runs.reduce((a, r) => a + (r.costUsd ?? 0), 0) * 100) / 100 };
  }).filter((r) => r.runs);
  rows.push({ projectId: null, name: '2 other projects', runs: 9, prsOpened: 5, prsMerged: 3, tokens: 1_240_000, costUsd: 2.86 });
  const total = rows.reduce((a, r) => ({ runs: a.runs + r.runs, prsOpened: a.prsOpened + r.prsOpened, prsMerged: a.prsMerged + r.prsMerged, tokens: a.tokens + r.tokens, costUsd: Math.round((a.costUsd + r.costUsd) * 100) / 100 }), { runs: 0, prsOpened: 0, prsMerged: 0, tokens: 0, costUsd: 0 });
  return {
    enabled: features().fixAgent, config: c, models: MODELS, usage: { since: since.toISOString(), total, projects: rows }, projectsOn: projects.filter((p) => load(p.id).settings?.enabled).length + 2,
    app: githubApp(email, true).app,
  };
}

function targetOf(get: (k: string) => string | undefined): Exclude<FixTarget, { kind: 'browser' }> {
  if (get('kind') === 'log') return { kind: 'log', logId: get('logId') ?? '', at: get('at') ?? '' };
  if (get('kind') === 'span') return { kind: 'span', traceId: get('traceId') ?? '', spanId: get('spanId') ?? '', at: get('at') };
  throw new FixMockError(400, 'kind must be span or log');
}

// ---------------------------------------------------------------- install-wide switches (admins)

const FEATURES_KEY = 'wgo-mock-install';
interface MockInstall { fixAgent: boolean; mcp: boolean; slackClientId: string | null }
const install = (): MockInstall => {
  try { return { fixAgent: false, mcp: true, slackClientId: null, ...(JSON.parse(localStorage.getItem(FEATURES_KEY) ?? '{}') as Partial<MockInstall>) }; } catch { return { fixAgent: false, mcp: true, slackClientId: null }; }
};
const saveFeatures = (p: Partial<MockInstall>) => localStorage.setItem(FEATURES_KEY, JSON.stringify({ ...install(), ...p }));
/** ?mock_agent turns the GitHub Agent on for a fresh browser. */
export function features(): InstallFeatures {
  const i = install();
  return { fixAgent: i.fixAgent || new URLSearchParams(location.search).has('mock_agent'), mcp: i.mcp, slackApp: !!i.slackClientId };
}

export function installApi(method: string, sub: string | undefined, body: unknown, admin: boolean): InstallSettings {
  if (!admin) throw new FixMockError(403, 'Only admins can see what the install costs and manage budgets');
  if (sub === 'mcp' && method === 'PATCH') saveFeatures({ mcp: (body as { enabled: boolean }).enabled === true });
  if (sub === 'slack' && method === 'PUT') {
    const b = body as { clientId?: string; clientSecret?: string };
    if (!/^\d{6,20}\.\d{6,20}$/.test(b.clientId ?? '')) throw new FixMockError(400, 'That doesn’t look like a Slack client ID (two numbers with a dot, e.g. 1234567890.1234567890)');
    if (!install().slackClientId && !/^[0-9a-f]{32}$/i.test(b.clientSecret ?? '')) throw new FixMockError(400, 'That doesn’t look like a Slack client secret (32 letters and digits)');
    saveFeatures({ slackClientId: b.clientId! });
  }
  if (sub === 'slack' && method === 'DELETE') saveFeatures({ slackClientId: null });
  const i = install();
  return {
    ...features(),
    slack: { clientId: i.slackClientId, secretSet: !!i.slackClientId, fromEnv: false, redirectUrl: 'https://abc123.execute-api.eu-west-1.amazonaws.com/slack/callback', createAppUrl: 'https://api.slack.com/apps?new_app=1' },
    mcpUrl: `${location.origin}/mcp`,
  };
}

const s0 = (pid: string, st: State, email: string) => settingsOf(pid, st, email);

/** A few pull requests from earlier days, so the Pull requests page has something to show. */
function demoPullRequests(s: FixSettings): FixRun[] {
  if (!s.repos.length) return [];
  const repo = s.repos[0].fullName;
  const day = 86400e3, now = Date.now();
  const pr = (n: number, ago: number, state: 'open' | 'merged' | 'closed', title: string, cause: string, msg: string, trigger: 'manual' | 'auto' = 'manual'): FixRun => ({
    runId: `demo-${n}`, status: 'pr_opened', prUrl: `https://github.com/${repo}/pull/${n}`, prNumber: n, prState: state, kind: 'browser',
    target: { kind: 'browser', fingerprint: `demo${n}` }, fingerprint: `demo${n}`, message: msg, trigger, requestedBy: trigger === 'auto' ? null : 'demo@wgo.dev', repo,
    branch: `wgo-fix/demo${n}`, steps: [], error: null, modelId: 'global.anthropic.claude-opus-5-5', inputTokens: 120_000, outputTokens: 3_000, costUsd: 0.27,
    result: { outcome: 'fixed', rootCause: cause, summary: '', confidence: 'high', testsAdded: true, files: [], prTitle: title },
    createdAt: new Date(now - ago).toISOString(), startedAt: new Date(now - ago).toISOString(), finishedAt: new Date(now - ago + 240_000).toISOString(),
  });
  return [
    pr(41, 2 * day, 'merged', 'Fix TypeError when a cart line’s product was removed', 'computeTotal read product.price on cart lines whose product had been removed from the catalog.', 'TypeError: Cannot read properties of undefined (reading \'price\')'),
    pr(38, 4 * day, 'open', 'Retry dynamic imports after a deploy', 'Old tabs requested chunk files that the new deploy no longer serves.', 'TypeError: Failed to fetch dynamically imported module', 'auto'),
    pr(33, 9 * day, 'closed', 'Guard against a missing gtag', 'An ad blocker removed the analytics script, so gtag was never defined.', 'ReferenceError: gtag is not defined'),
  ];
}
