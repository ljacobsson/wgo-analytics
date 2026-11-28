/**
 * The GitHub Agent end to end, without Bedrock or GitHub: settings and runs through the API, a scripted model driving
 * the real Strands agent loop and tools, and a fake repository that records the commit and pull request.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { Model, type Message, type ModelStreamEvent } from '@strands-agents/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/live', () => ({ fanOut: vi.fn(async () => {}) }));

const invoked: Array<{ FunctionName: string; Payload: { projectId: string; runId: string } }> = [];
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { async send(cmd: { input: { FunctionName: string; Payload: Uint8Array } }) { invoked.push({ FunctionName: cmd.input.FunctionName, Payload: JSON.parse(Buffer.from(cmd.input.Payload).toString()) }); return {}; } },
  InvokeCommand: class { constructor(public input: unknown) {} },
}));

const prStates = new Map<number, string>();
vi.mock('../src/lib/github', async (orig) => {
  const real = await orig<typeof import('../src/lib/github')>();
  return {
    ...real,
    listRepos: vi.fn(async () => [{ fullName: 'acme/shop', defaultBranch: 'main', private: true }, { fullName: 'acme/api', defaultBranch: 'main', private: true }]),
    Repo: { ...real.Repo, open: vi.fn(async () => ({ prState: async (n: number) => prStates.get(n) ?? 'open' })) },
  };
});

// the Claude API, for checking keys: a key ending in "bad" is refused, model "claude-nope" doesn't exist
const retrieved: Array<{ key: string; model: string }> = [];
vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error { constructor(public status: number) { super(`status ${status}`); } }
  class AuthenticationError extends APIError {}
  class PermissionDeniedError extends APIError {}
  class NotFoundError extends APIError {}
  class Anthropic {
    static APIError = APIError; static AuthenticationError = AuthenticationError; static PermissionDeniedError = PermissionDeniedError; static NotFoundError = NotFoundError;
    constructor(private o: { apiKey: string }) {}
    models = {
      retrieve: async (model: string) => {
        retrieved.push({ key: this.o.apiKey, model });
        if (this.o.apiKey.endsWith('bad')) throw new AuthenticationError(401);
        if (model === 'claude-nope') throw new NotFoundError(404);
        return { id: model };
      },
    };
  }
  return { default: Anthropic };
});

type Turn = { tools?: Array<{ name: string; input: object }>; text?: string };
/** Plays back fixed turns; `seen` keeps what the model was sent each time. */
class ScriptedModel extends Model {
  seen: Message[][] = [];
  constructor(private readonly turns: Array<Turn | ((messages: Message[]) => Turn)>) { super(); }
  updateConfig() {}
  getConfig() { return { modelId: 'scripted' }; }
  async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.seen.push([...messages]);
    const next = this.turns.shift() ?? { text: 'Done.' };
    const t = typeof next === 'function' ? next(messages) : next;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (t.text) {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: t.text } };
      yield { type: 'modelContentBlockStopEvent' };
    }
    for (const [i, call] of (t.tools ?? []).entries()) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: call.name, toolUseId: `t${this.seen.length}-${i}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(call.input) } };
      yield { type: 'modelContentBlockStopEvent' };
    }
    yield { type: 'modelMessageStopEvent', stopReason: t.tools?.length ? 'toolUse' : 'endTurn' };
    yield { type: 'modelMetadataEvent', usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cacheReadInputTokens: 5000 } };
  }
}

/** The text of every tool result the model was sent last. */
const lastResults = (messages: Message[]): Array<{ status: string; text: string }> => {
  const last = messages[messages.length - 1];
  return (last?.content ?? []).filter((b) => b.type === 'toolResultBlock').map((b) => {
    const r = b as unknown as { status: string; content: Array<{ text?: string; json?: unknown }> };
    return { status: r.status, text: r.content.map((c) => c.text ?? JSON.stringify(c.json)).join('') };
  });
};

const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('GitHub Agent (PostgreSQL)', async () => {
  if (!process.env.DATABASE_URL) return;
  const BASE = process.env.DATABASE_URL;
  const isolated = new URL(BASE);
  isolated.searchParams.set('options', '-c search_path=fixagent_test');
  process.env.DATABASE_URL = isolated.toString();
  process.env.FIX_AGENT_FUNCTION = 'wgo-FixAgentFunction-run';
  process.env.FIX_MODEL_ID = 'global.anthropic.claude-opus-5-5';
  const { Client } = await import('pg');
  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const ingest = (await import('../src/handlers/ingest')).handler;
  const api = (await import('../src/handlers/api')).handler;
  const FX = await import('../src/lib/fixes');
  const { runFixAgent } = await import('../src/lib/fixAgent/agent');

  const OWNER = 'fixer@example.com';
  const MEMBER = 'helper@example.com';
  const now = Date.now();
  let pid = '';
  let writeKey = '';
  const ev = (method: string, path: string, body?: string, q?: Record<string, string>, email = OWNER) => ({
    rawPath: path, headers: { origin: 'https://wgo.example.com' }, queryStringParameters: q, body, isBase64Encoded: false,
    requestContext: { http: { method }, domainName: 'api.example.com', authorizer: { jwt: { claims: { email } } } },
  }) as unknown as APIGatewayProxyEventV2;
  const call = async (method: string, path: string, body?: object, q?: Record<string, string>, email = OWNER) => {
    const res = (await api(ev(method, path, body && JSON.stringify(body), q, email) as never)) as APIGatewayProxyStructuredResultV2;
    return { status: res.statusCode!, body: JSON.parse(res.body as string) };
  };
  const STACK = 'TypeError: Cannot read properties of null (reading \'items\')\n    at total (https://shop.test/assets/index.js:1:200)\n    at render (https://shop.test/assets/index.js:1:900)';
  const send = async (msg: string, stack: string, sessions: string[], at = now - 120_000) => {
    for (const s of sessions) {
      const batch = { k: writeKey, a: `anon-${s}`, sentAt: Date.now(), ctx: { sdk: 'wgo-js/0.1.0', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36' },
        e: [
          { id: crypto.randomUUID(), t: 'pageview', ts: at - 5000, s, url: 'https://shop.test/cart', path: '/cart', d: {} },
          { id: crypto.randomUUID(), t: 'error', ts: at, s, url: 'https://shop.test/cart', path: '/cart', d: { msg, kind: 'error', stack } },
        ] };
      expect(((await ingest(ev('POST', '/ingest', JSON.stringify(batch)))) as APIGatewayProxyStructuredResultV2).statusCode).toBe(202);
    }
  };
  const fingerprintOf = async (msg: string) =>
    (await call('GET', `/api/projects/${pid}/errors`, undefined, { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() }))
      .body.find((g: { message: string }) => g.message === msg).fingerprint as string;

  /** A repository that writes a few files on download and records what the agent commits. */
  const fakeRepo = () => {
    const rec = { commits: [] as Array<{ base: unknown; branch: string; message: string; changes: Array<{ path: string; content: string | null }> }>, prs: [] as Array<{ title: string; body: string; head: string; base: string }> };
    const repo = {
      defaultBranch: async () => 'main',
      head: async () => ({ sha: 'base1', tree: 'tree1' }),
      download: async (_sha: string, dir: string) => {
        await mkdir(join(dir, 'src'), { recursive: true });
        await mkdir(join(dir, '.github/workflows'), { recursive: true });
        await writeFile(join(dir, 'src/cart.ts'), 'export function total(cart) {\n  return cart.items.reduce((a, i) => a + i.price, 0);\n}\n');
        await writeFile(join(dir, '.github/workflows/ci.yml'), 'on: pull_request\n');
        return { files: 2, bytes: 100, truncated: false };
      },
      commit: async (base: unknown, branch: string, message: string, changes: Array<{ path: string; content: string | null }>) => { rec.commits.push({ base, branch, message, changes }); return 'c2'; },
      openPr: async (p: { title: string; body: string; head: string; base: string }) => { rec.prs.push(p); return { number: 7, url: 'https://github.com/acme/shop/pull/7' }; },
    };
    return { rec, repo };
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS fixagent_test CASCADE');
    await admin.query('CREATE SCHEMA fixagent_test');
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    const created = await call('POST', '/api/projects', { name: 'Shop' });
    pid = created.body.id;
    writeKey = created.body.writeKey;
    expect((await call('POST', `/api/projects/${pid}/members`, { email: MEMBER })).status).toBe(200);
    await send('TypeError: Cannot read properties of null (reading \'items\')', STACK, ['s1', 's2', 's3']);
  });
  beforeEach(() => { invoked.length = 0; });
  const patchRepos = async (repos: object[]) => expect((await call('PATCH', `/api/projects/${pid}/fix-settings`, { repos })).status).toBe(200);
  afterAll(async () => closeDb());

  it('is off until an admin turns it on, the app is installed and an owner turns it on', async () => {
    expect((await call('GET', '/api/me')).body.features.fixAgent).toBe(false);
    expect((await call('GET', '/api/github')).body.enabled).toBe(false);
    // OWNER owns the first project, so is an admin
    expect((await call('PATCH', '/api/fix-agent', { enabled: true })).body.enabled).toBe(true);
    const { forgetSettings } = await import('../src/lib/installSettings');
    forgetSettings();
    const s = (await call('GET', `/api/projects/${pid}/fix-settings`, undefined, undefined, MEMBER)).body;
    expect(s).toMatchObject({ enabled: false, installed: false, repos: [], auto: { enabled: false, maxPerDay: 3 } });
    expect((await call('PATCH', `/api/projects/${pid}/fix-settings`, { enabled: true })).status).toBe(409); // not installed
    const fp = await fingerprintOf('TypeError: Cannot read properties of null (reading \'items\')');
    expect((await call('POST', `/api/projects/${pid}/fixes`, { fingerprint: fp })).status).toBe(409);
    expect(invoked).toEqual([]);
  });

  it('validates settings, owners only', async () => {
    await FX.saveInstallation(pid, OWNER, 42, 'acme');
    expect((await call('PATCH', `/api/projects/${pid}/fix-settings`, { enabled: true }, undefined, MEMBER)).status).toBe(403);
    expect((await call('PATCH', `/api/projects/${pid}/fix-settings`, { enabled: true })).body.error).toMatch(/Add a repository/);
    const patch = (b: object) => call('PATCH', `/api/projects/${pid}/fix-settings`, b);
    const shop = { fullName: 'acme/shop', browser: true };
    expect((await patch({ repos: [{ fullName: 'acme/other' }] })).body.error).toMatch(/isn’t installed on acme\/other/);
    expect((await patch({ repos: [{ ...shop, rootPath: '../up' }] })).status).toBe(400);
    expect((await patch({ repos: [{ ...shop, baseBranch: 'a..b' }] })).status).toBe(400);
    expect((await patch({ repos: [shop, shop] })).body.error).toMatch(/listed twice/);
    expect((await patch({ repos: [shop, { fullName: 'acme/api', browser: true }] })).body.error).toMatch(/Only one repository/);
    expect((await patch({ repos: [{ ...shop, services: ['cart-api'] }, { fullName: 'acme/api', services: ['CART-API'] }] })).body.error).toMatch(/listed for both/);
    expect((await patch({ repos: [shop], auto: { maxPerDay: 99 } })).status).toBe(400);
    const saved = await patch({ enabled: true, repos: [{ ...shop, rootPath: './web', instructions: '  Tests use vitest.  ' }, { fullName: 'acme/api', services: ['billing-*', 'orders'] }] });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, installed: true, account: 'acme', repos: [
      { fullName: 'acme/shop', rootPath: 'web/', instructions: 'Tests use vitest.', baseBranch: null, browser: true, services: [] },
      { fullName: 'acme/api', rootPath: null, browser: false, services: ['billing-*', 'orders'], deniedPaths: expect.arrayContaining(['.github/**']) },
    ] });
    // turning it on needs a repository
    expect((await patch({ repos: [] })).body.error).toMatch(/Add a repository/);
    expect((await call('GET', `/api/projects/${pid}/fix-settings/repos`)).body).toHaveLength(2);
  });

  let runId = '';
  it('starts a run for an error group and hands it to the agent', async () => {
    expect((await call('POST', `/api/projects/${pid}/fixes`, { fingerprint: 'nope' }, undefined, MEMBER)).status).toBe(404);
    const fp = await fingerprintOf('TypeError: Cannot read properties of null (reading \'items\')');
    const r = await call('POST', `/api/projects/${pid}/fixes`, { fingerprint: fp, message: 'TypeError…' }, undefined, MEMBER);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'queued', fingerprint: fp, trigger: 'manual', requestedBy: MEMBER, repo: 'acme/shop', modelId: 'global.anthropic.claude-opus-5-5' });
    runId = r.body.runId;
    expect(invoked).toEqual([{ FunctionName: 'wgo-FixAgentFunction-run', Payload: { projectId: pid, runId } }]);
    expect((await call('POST', `/api/projects/${pid}/fixes`, { fingerprint: fp })).body.error).toMatch(/already working/);
  });

  it('runs the agent: reads, edits, and opens a draft pull request', async () => {
    const model = new ScriptedModel([
      { text: 'Looking at the cart.', tools: [{ name: 'read_file', input: { path: 'src/cart.ts' } }, { name: 'grep', input: { pattern: 'items', glob: 'src/**' } }] },
      (m) => {
        const [read, grep] = lastResults(m);
        expect(read.status).toBe('success');
        expect(read.text).toContain('    2    return cart.items.reduce');
        expect(grep.text).toContain('src/cart.ts:2:');
        return { tools: [{ name: 'edit_file', input: { path: 'src/cart.ts', old_text: 'cart.items.reduce', new_text: '(cart?.items ?? []).reduce' } }] };
      },
      { tools: [{ name: 'diff', input: {} }] },
      { tools: [{ name: 'submit_result', input: { outcome: 'fixed', root_cause: 'The cart is null before it loads.', summary: 'Treat a missing cart as empty.', pr_title: 'Fix TypeError when the cart is null', confidence: 'high', tests_added: false } }] },
      { text: 'Opened.' },
    ]);
    const { rec, repo } = fakeRepo();
    await runFixAgent(pid, runId, { model: () => model, openRepo: async () => repo as never });

    // the brief: telemetry fenced off, the project's instructions, where the app lives
    const brief = JSON.stringify(model.seen[0][0].content);
    expect(brief).toContain('<telemetry>');
    expect(brief).toContain('Tests use vitest.');
    expect(brief).toContain('lives in web/');
    expect(brief).toContain('3 sessions');

    expect(rec.commits).toHaveLength(1);
    expect(rec.commits[0].base).toEqual({ sha: 'base1', tree: 'tree1' });
    expect(rec.commits[0].branch).toMatch(/^wgo-fix\/[A-Za-z0-9]{1,12}-[0-9a-f]{8}$/);
    expect(rec.commits[0].changes).toEqual([{ path: 'src/cart.ts', content: 'export function total(cart) {\n  return (cart?.items ?? []).reduce((a, i) => a + i.price, 0);\n}\n', executable: false }]);
    expect(rec.prs[0]).toMatchObject({ title: 'Fix TypeError when the cart is null', base: 'main', head: rec.commits[0].branch });
    expect(rec.prs[0].body).toContain('Treat a missing cart as empty.');
    expect(rec.prs[0].body).toContain(`https://wgo.example.com/#/p/${pid}/errors?fp=`);
    // the Pull requests page: only runs with a pull request, with its title
    const prs = (await call('GET', `/api/projects/${pid}/fixes`, undefined, { pr: '1' })).body;
    expect(prs.map((x: { runId: string }) => x.runId)).toEqual([runId]);
    expect(prs[0]).toMatchObject({ prNumber: 7, result: { prTitle: 'Fix TypeError when the cart is null' } });

    const run = (await call('GET', `/api/projects/${pid}/fixes/${runId}`)).body;
    expect(run).toMatchObject({ status: 'pr_opened', prNumber: 7, prUrl: 'https://github.com/acme/shop/pull/7', prState: 'open', branch: rec.commits[0].branch,
      result: { outcome: 'fixed', confidence: 'high', files: ['src/cart.ts'] } });
    // read_file and grep ran in parallel: logged as they finished
    const tools = run.steps.map((s: { tool: string }) => s.tool);
    expect([tools[0], ...tools.slice(1, 3).sort(), ...tools.slice(3)]).toEqual(['download', 'grep', 'read_file', 'edit_file', 'diff', 'submit_result', 'commit', 'pull_request']);
    expect(run.inputTokens).toBe(5 * 6000);
    expect(run.outputTokens).toBe(5 * 100);
    expect(run.costUsd).toBeCloseTo((5 * 1000 * 4 + 5 * 100 * 20 + 5 * 5000 * 0.2) / 1e6, 6);

    // the Errors page shows it, and the open pull request blocks another run
    const fp = run.fingerprint;
    const groups = (await call('GET', `/api/projects/${pid}/errors`, undefined, { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() })).body;
    expect(groups.find((g: { fingerprint: string }) => g.fingerprint === fp).fix).toEqual({ runId, status: 'pr_opened', prUrl: 'https://github.com/acme/shop/pull/7', prNumber: 7, prState: 'open' });
    expect((await call('POST', `/api/projects/${pid}/fixes`, { fingerprint: fp })).body.error).toMatch(/#7 for this error is still open/);

    // merged on GitHub: the background sweep notices once the last check is 10 minutes old, without anyone looking
    prStates.set(7, 'merged');
    expect((await FX.sweepPrStates()).checked).toBe(0); // just checked by the request above
    await query(`UPDATE fix_runs SET pr_checked_at = now() - interval '11 minutes' WHERE project_id = $1 AND id = $2`, [pid, runId]);
    expect((await FX.sweepPrStates()).checked).toBe(1);
    expect((await query<{ pr_state: string }>('SELECT pr_state FROM fix_runs WHERE project_id = $1 AND id = $2', [pid, runId]))[0].pr_state).toBe('merged');
    // and looking at the run checks again after a minute
    await query(`UPDATE fix_runs SET pr_state = 'open', pr_checked_at = now() - interval '2 minutes' WHERE project_id = $1 AND id = $2`, [pid, runId]);
    expect((await call('GET', `/api/projects/${pid}/fixes/${runId}`)).body.prState).toBe('merged');
    prStates.delete(7);
    await query(`UPDATE fix_runs SET pr_state = 'open', pr_checked_at = now() WHERE project_id = $1 AND id = $2`, [pid, runId]);
  });

  it('refuses protected paths and reports runs without a fix', async () => {
    prStates.set(7, 'closed');
    await query(`UPDATE fix_runs SET pr_checked_at = now() - interval '1 hour' WHERE id = $1`, [runId]);
    const fp = (await call('GET', `/api/projects/${pid}/fixes/${runId}`)).body.fingerprint;
    const started = await call('POST', `/api/projects/${pid}/fixes`, { fingerprint: fp });
    expect(started.status).toBe(200);
    const model = new ScriptedModel([
      // as if telemetry had talked it into touching CI
      { tools: [{ name: 'edit_file', input: { path: '.github/workflows/ci.yml', old_text: 'pull_request', new_text: 'pull_request_target' } }, { name: 'read_file', input: { path: '../../etc/passwd' } }] },
      (m) => {
        const [edit, read] = lastResults(m);
        expect(edit.status).toBe('error');
        expect(edit.text).toMatch(/protected/);
        expect(read.status).toBe('error');
        return { tools: [{ name: 'submit_result', input: { outcome: 'fixed', root_cause: 'x', summary: 'x', pr_title: 'x', confidence: 'low', tests_added: false } }] };
      },
      (m) => {
        expect(lastResults(m)[0]).toMatchObject({ status: 'error' }); // "fixed" without changes is refused
        return { tools: [{ name: 'submit_result', input: { outcome: 'not_fixable', root_cause: 'Needs a CI change.', summary: 'The fix is in CI config, which I may not change.', pr_title: 'n/a', confidence: 'medium', tests_added: false } }] };
      },
    ]);
    const { rec, repo } = fakeRepo();
    await runFixAgent(pid, started.body.runId, { model: () => model, openRepo: async () => repo as never });
    expect(rec.commits).toEqual([]);
    const run = (await call('GET', `/api/projects/${pid}/fixes/${started.body.runId}`)).body;
    expect(run).toMatchObject({ status: 'no_fix', prNumber: null, result: { outcome: 'not_fixable', files: [] } });
    expect(run.steps.filter((s: { error?: boolean }) => s.error).map((s: { tool: string }) => s.tool).sort()).toEqual(['edit_file', 'read_file', 'submit_result']);
  });

  it('asks once more when the agent stops without a result, then fails', async () => {
    const fp = (await call('GET', `/api/projects/${pid}/fixes/${runId}`)).body.fingerprint;
    await query('UPDATE fix_settings SET auto = $2 WHERE project_id = $1', [pid, JSON.stringify({ enabled: false, minEvents: 1, minSessions: 1, maxPerDay: 10 })]);
    const started = await call('POST', `/api/projects/${pid}/fixes`, { fingerprint: fp });
    const model = new ScriptedModel([{ text: 'I think it is fine.' }, { text: 'Still fine.' }]);
    const { repo } = fakeRepo();
    await runFixAgent(pid, started.body.runId, { model: () => model, openRepo: async () => repo as never });
    expect(model.seen).toHaveLength(2);
    expect(JSON.stringify(model.seen[1].at(-1)!.content)).toContain('call submit_result');
    expect((await call('GET', `/api/projects/${pid}/fixes/${started.body.runId}`)).body).toMatchObject({ status: 'failed', error: expect.stringMatching(/without a result/) });
  });

  it('does nothing for a run cancelled before it started', async () => {
    const fp = (await call('GET', `/api/projects/${pid}/fixes/${runId}`)).body.fingerprint;
    const started = await call('POST', `/api/projects/${pid}/fixes`, { fingerprint: fp });
    expect((await call('POST', `/api/projects/${pid}/fixes/${started.body.runId}/cancel`, {}, undefined, MEMBER)).body.status).toBe('cancelled');
    const model = new ScriptedModel([]);
    await runFixAgent(pid, started.body.runId, { model: () => model, openRepo: async () => { throw new Error('must not open'); } });
    expect(model.seen).toEqual([]);
    expect((await call('GET', `/api/projects/${pid}/fixes/${started.body.runId}`)).body.status).toBe('cancelled');
  });

  it('limits automatic runs per day, never the runs people start', async () => {
    const fp = (await call('GET', `/api/projects/${pid}/fixes/${runId}`)).body.fingerprint;
    await query('UPDATE fix_settings SET auto = $2 WHERE project_id = $1', [pid, JSON.stringify({ enabled: false, minEvents: 1, minSessions: 1, maxPerDay: 1 })]);
    // several manual runs today already, and another one is fine
    expect(Number((await query<{ n: string }>(`SELECT count(*) AS n FROM fix_runs WHERE project_id = $1 AND trigger = 'manual'`, [pid]))[0].n)).toBeGreaterThan(1);
    const manual = await call('POST', `/api/projects/${pid}/fixes`, { fingerprint: fp });
    expect(manual.status).toBe(200);
    await call('POST', `/api/projects/${pid}/fixes/${manual.body.runId}/cancel`, {});
    expect((await call('GET', `/api/projects/${pid}/fix-settings`)).body.autoRunsToday).toBe(0);
    // one automatic run fits, the next doesn't
    const auto = await FX.startRun(pid, null, { fingerprint: fp }, 'auto');
    await call('POST', `/api/projects/${pid}/fixes/${auto.runId}/cancel`, {});
    expect((await call('GET', `/api/projects/${pid}/fix-settings`)).body.autoRunsToday).toBe(1);
    await expect(FX.startRun(pid, null, { fingerprint: fp }, 'auto')).rejects.toThrow(/1 automatic runs today/);
    expect((await call('POST', `/api/projects/${pid}/fixes`, { fingerprint: fp })).status).toBe(200);
    await query(`UPDATE fix_runs SET status = 'cancelled' WHERE project_id = $1 AND status IN ('queued', 'running')`, [pid]);
  });

  it('starts automatic runs for groups over the thresholds that never had one', async () => {
    await send('ReferenceError: price is not defined', 'ReferenceError: price is not defined\n    at line (https://shop.test/assets/index.js:1:500)', ['s4', 's5']);
    await query('UPDATE fix_settings SET auto = $2 WHERE project_id = $1', [pid, JSON.stringify({ enabled: true, minEvents: 2, minSessions: 2, maxPerDay: 10 })]);
    const r = await FX.autoSweep(Date.now());
    expect(r.started).toBe(1);
    const fp = await fingerprintOf('ReferenceError: price is not defined');
    expect(invoked).toHaveLength(1);
    const runs = (await call('GET', `/api/projects/${pid}/fixes`, undefined, { fingerprint: fp })).body;
    expect(runs).toMatchObject([{ trigger: 'auto', requestedBy: null, status: 'queued', message: 'ReferenceError: price is not defined' }]);
    // not again within five minutes, and never twice for the same group
    expect((await FX.autoSweep(Date.now())).started).toBe(0);
    await query(`UPDATE fix_runs SET status = 'no_fix' WHERE project_id = $1`, [pid]);
    expect((await FX.autoSweep(Date.now() + 6 * 60_000)).started).toBe(0);
  });

  it('lets admins choose the model for every project, and keeps the key out of every response', async () => {
    expect((await call('GET', '/api/fix-agent', undefined, undefined, MEMBER)).status).toBe(403);
    const first = (await call('GET', '/api/fix-agent')).body;
    expect(first.config).toMatchObject({ provider: 'bedrock', modelId: 'global.anthropic.claude-opus-5-5', effort: 'high', apiKey: null, updatedBy: null });
    expect(first.models.map((m: { provider: string; modelId: string }) => `${m.provider}:${m.modelId}`)).toContain('anthropic:claude-sonnet-5-5');
    expect(first.projectsOn).toBe(1);
    expect(first.usage.projects).toMatchObject([{ projectId: pid, name: 'Shop', prsOpened: 1 }]);
    expect(first.usage.total.runs).toBeGreaterThanOrEqual(5);
    expect(first.usage.total.costUsd).toBeGreaterThan(0);

    const patch = (b: object, email = OWNER) => call('PATCH', '/api/fix-agent', b, undefined, email);
    expect((await patch({ effort: 'medium' }, MEMBER)).status).toBe(403);
    expect((await patch({ provider: 'anthropic' })).body.error).toMatch(/Add a Claude API key/);
    expect((await patch({ provider: 'anthropic', apiKey: 'nope' })).body.error).toMatch(/start with sk-ant-/);
    expect((await patch({ provider: 'anthropic', apiKey: 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaabad' })).body.error).toMatch(/doesn’t accept that key/);
    expect((await patch({ provider: 'anthropic', modelId: 'global.anthropic.claude-opus-5-5', apiKey: 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).body.error).toMatch(/Bedrock model id/);
    expect((await patch({ provider: 'bedrock', modelId: 'meta.llama4' })).body.error).toMatch(/Claude model/);
    expect((await patch({ effort: 'extreme' })).status).toBe(400);

    const saved = await patch({ provider: 'anthropic', modelId: 'claude-sonnet-5-5', effort: 'xhigh', apiKey: 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaWXYZ' });
    expect(saved.status).toBe(200);
    expect(saved.body.config).toMatchObject({ provider: 'anthropic', modelId: 'claude-sonnet-5-5', effort: 'xhigh', apiKey: { hint: 'WXYZ', setBy: OWNER }, updatedBy: OWNER });
    expect(JSON.stringify(saved.body)).not.toContain('aaaaWXYZ');
    expect(retrieved.at(-1)).toEqual({ key: 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaWXYZ', model: 'claude-sonnet-5-5' });
    // a new model is checked with the saved key
    expect((await patch({ modelId: 'claude-nope' })).body.error).toMatch(/no model claude-nope/);
    // members see which model runs use, not the key
    const s = (await call('GET', `/api/projects/${pid}/fix-settings`, undefined, undefined, MEMBER)).body;
    expect(s.model).toEqual({ provider: 'anthropic', modelId: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 through the Claude API' });

    // a run uses it
    await query('UPDATE fix_settings SET auto = $2 WHERE project_id = $1', [pid, JSON.stringify({ enabled: false, minEvents: 1, minSessions: 1, maxPerDay: 50 })]);
    await query(`UPDATE fix_runs SET pr_state = 'closed' WHERE project_id = $1`, [pid]);
    const fp = (await call('GET', `/api/projects/${pid}/fixes/${runId}`)).body.fingerprint;
    const started = await call('POST', `/api/projects/${pid}/fixes`, { fingerprint: fp });
    expect(started.body.modelId).toBe('claude-sonnet-5-5');
    let used: unknown = null;
    const { repo } = fakeRepo();
    await runFixAgent(pid, started.body.runId, { model: (cfg) => { used = cfg; return new ScriptedModel([{ tools: [{ name: 'submit_result', input: { outcome: 'needs_more_info', root_cause: '-', summary: '-', pr_title: '-', confidence: 'low', tests_added: false } }] }]); }, openRepo: async () => repo as never });
    expect(used).toEqual({ provider: 'anthropic', modelId: 'claude-sonnet-5-5', effort: 'xhigh' });
    const { apiKey } = await import('../src/lib/fixConfig');
    expect(await apiKey()).toBe('sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaWXYZ');

    // the key can't be removed while the Claude API is in use; switching back to Bedrock and removing it works
    expect((await patch({ apiKey: null })).body.error).toMatch(/Add a Claude API key/);
    const back = await patch({ provider: 'bedrock', apiKey: null });
    expect(back.body.config).toMatchObject({ provider: 'bedrock', modelId: 'global.anthropic.claude-opus-5-5', apiKey: null });
    expect(await apiKey()).toBeNull();
  });

  it('fixes backend errors from failed spans and error logs', async () => {
    prStates.clear(); // the fake GitHub numbers every pull request #7; an earlier test closed it
    const { writeRows } = await import('../src/lib/store/write');
    const TRACE = 'ab'.repeat(16), TRACE2 = 'cd'.repeat(16);
    const stack = 'TypeError: Cannot read properties of null (reading \'items\')\n    at total (/var/task/src/cart.ts:2:17)\n    at handler (/var/task/src/api.ts:9:3)';
    const span = (trace: string, id: string, at: number, extra: object = {}) => ({
      project_id: pid, start_time: new Date(at), span_id: id, trace_id: trace, parent_span_id: null, name: 'POST /api/cart/total', kind: 2, service: 'cart-api',
      end_time: new Date(at + 40), duration_ms: 40, status_code: 2, status_message: 'boom', attributes: { 'http.route': '/api/cart/total' }, resource: { 'service.name': 'cart-api' },
      events: [{ name: 'exception', ts: new Date(at + 30).toISOString(), attributes: { 'exception.type': 'TypeError', 'exception.message': 'Cannot read properties of null (reading \'items\')', 'exception.stacktrace': stack } }], ...extra,
    });
    const t0 = Date.now() - 300_000;
    await writeRows('spans', [span(TRACE, '1111111111111111', t0), span(TRACE2, '2222222222222222', t0 + 60_000),
      { ...span(TRACE, '3333333333333333', t0 + 5), status_code: 1, events: [], name: 'SELECT carts' }]);
    const logId = crypto.randomUUID(), infoId = crypto.randomUUID();
    await writeRows('logs', [
      { project_id: pid, ts: new Date(t0 + 20), id: logId, severity_number: 17, severity_text: 'ERROR', body: 'cart total failed', service: 'cart-api', trace_id: TRACE, span_id: '1111111111111111', attributes: { 'exception.stacktrace': stack }, resource: {} },
      { project_id: pid, ts: new Date(t0 + 10), id: infoId, severity_number: 9, severity_text: 'INFO', body: 'loading cart 42', service: 'cart-api', trace_id: TRACE, span_id: '1111111111111111', attributes: {}, resource: {} },
    ]);
    const at = new Date(t0).toISOString();

    // what the dashboard shows for a span: the same error in two traces is one fingerprint
    const info = await call('GET', `/api/projects/${pid}/fixes/for`, undefined, { kind: 'span', traceId: TRACE, spanId: '1111111111111111', at }, MEMBER);
    expect(info.body).toMatchObject({ message: 'TypeError: Cannot read properties of null (reading \'items\')', service: 'cart-api', hasStack: true, runs: [] });
    expect(info.body.fingerprint).toMatch(/^span:/);
    const other = await call('GET', `/api/projects/${pid}/fixes/for`, undefined, { kind: 'span', traceId: TRACE2, spanId: '2222222222222222', at });
    expect(other.body.fingerprint).toBe(info.body.fingerprint);
    // spans that didn't fail, info logs and unknown ids are refused
    expect((await call('GET', `/api/projects/${pid}/fixes/for`, undefined, { kind: 'span', traceId: TRACE, spanId: '3333333333333333', at })).body.error).toMatch(/didn’t fail/);
    expect((await call('GET', `/api/projects/${pid}/fixes/for`, undefined, { kind: 'log', logId: infoId, at })).body.error).toMatch(/ERROR and FATAL/);
    expect((await call('GET', `/api/projects/${pid}/fixes/for`, undefined, { kind: 'span', traceId: 'ef'.repeat(16), spanId: '1111111111111111' })).status).toBe(404);

    // a run for the span
    const started = await call('POST', `/api/projects/${pid}/fixes`, { kind: 'span', traceId: TRACE, spanId: '1111111111111111', at }, undefined, MEMBER);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ kind: 'span', target: { kind: 'span', traceId: TRACE, spanId: '1111111111111111' }, fingerprint: info.body.fingerprint, message: expect.stringMatching(/^cart-api: TypeError/) });
    expect((await call('POST', `/api/projects/${pid}/fixes`, { kind: 'span', traceId: TRACE2, spanId: '2222222222222222' })).body.error).toMatch(/already working/);
    const model = new ScriptedModel([
      { tools: [{ name: 'search_logs', input: { trace_id: TRACE } }, { name: 'read_file', input: { path: 'src/cart.ts' } }] },
      (m) => {
        const [logs] = lastResults(m);
        expect(logs.text).toContain('ERROR cart-api: cart total failed');
        expect(logs.text).toContain('INFO cart-api: loading cart 42');
        return { tools: [{ name: 'edit_file', input: { path: 'src/cart.ts', old_text: 'cart.items.reduce', new_text: '(cart?.items ?? []).reduce' } }] };
      },
      { tools: [{ name: 'submit_result', input: { outcome: 'fixed', root_cause: 'A null cart.', summary: 'Treat a missing cart as empty.', pr_title: 'Fix cart total for a null cart', confidence: 'high', tests_added: false } }] },
    ]);
    const { rec, repo } = fakeRepo();
    await runFixAgent(pid, started.body.runId, { model: () => model, openRepo: async () => repo as never });
    const brief = JSON.stringify(model.seen[0][0].content);
    expect(brief).toContain('A backend error in service cart-api (a failed span)');
    expect(brief).toContain('/var/task/src/cart.ts:2 → repository file src/cart.ts');
    expect(brief).toContain('cart-api POST /api/cart/total 40 ms ERROR');
    expect(brief).toContain('Logs in this trace');
    expect(rec.prs[0].body).toContain(`/#/p/${pid}/traces/${TRACE}?at=`);
    expect(rec.prs[0].body).toContain('a failed span in cart-api');
    expect((await call('GET', `/api/projects/${pid}/fixes/${started.body.runId}`)).body).toMatchObject({ status: 'pr_opened', kind: 'span' });
    // every occurrence now shows the pull request
    expect((await call('GET', `/api/projects/${pid}/fixes/for`, undefined, { kind: 'span', traceId: TRACE2, spanId: '2222222222222222' })).body.runs).toMatchObject([{ prNumber: 7, prState: 'open' }]);

    // an error log
    const logRun = await call('POST', `/api/projects/${pid}/fixes`, { kind: 'log', logId, at: new Date(t0 + 20).toISOString() });
    expect(logRun.body).toMatchObject({ kind: 'log', target: { kind: 'log', logId }, fingerprint: expect.stringMatching(/^log:/) });
    const lm = new ScriptedModel([{ tools: [{ name: 'submit_result', input: { outcome: 'needs_more_info', root_cause: '-', summary: '-', pr_title: '-', confidence: 'low', tests_added: false } }] }]);
    await runFixAgent(pid, logRun.body.runId, { model: () => lm, openRepo: async () => fakeRepo().repo as never });
    const lbrief = JSON.stringify(lm.seen[0][0].content);
    expect(lbrief).toContain('(an error log)');
    expect(lbrief).toContain('cart total failed');
    expect(lbrief).toContain(`The whole trace (${TRACE})`);
    expect((await call('GET', `/api/projects/${pid}/fixes/${logRun.body.runId}`)).body.status).toBe('no_fix');
  });

  it('routes each error to the repository that fixes it', async () => {
    const { writeRows } = await import('../src/lib/store/write');
    const TRACE = 'ef'.repeat(16), at = Date.now() - 200_000;
    await writeRows('spans', [{
      project_id: pid, start_time: new Date(at), span_id: '4444444444444444', trace_id: TRACE, parent_span_id: null, name: 'charge', kind: 2, service: 'billing-api',
      end_time: new Date(at + 10), duration_ms: 10, status_code: 2, status_message: 'card processor down', attributes: {}, resource: {}, events: [],
    }]);
    const target = { kind: 'span', traceId: TRACE, spanId: '4444444444444444', at: new Date(at).toISOString() };
    // billing-* is acme/api's; JavaScript errors are acme/shop's (the browser one)
    expect((await call('GET', `/api/projects/${pid}/fixes/for`, undefined, target)).body.repo).toBe('acme/api');
    const routed = await call('POST', `/api/projects/${pid}/fixes`, target);
    expect(routed.body.repo).toBe('acme/api');
    await call('POST', `/api/projects/${pid}/fixes/${routed.body.runId}/cancel`, {});
    // a person can pick another of the project's repositories, not any repository
    expect((await call('POST', `/api/projects/${pid}/fixes`, { ...target, repo: 'acme/elsewhere' })).body.error).toMatch(/isn’t one of this project’s repositories/);
    const picked = await call('POST', `/api/projects/${pid}/fixes`, { ...target, repo: 'acme/shop' });
    expect(picked.body.repo).toBe('acme/shop');
    // the agent works in the run's repository, with that repository's settings
    await patchRepos([{ fullName: 'acme/shop', browser: true, rootPath: 'web/' }, { fullName: 'acme/api', services: ['billing-*'], instructions: 'Go code lives in cmd/.' }]);
    const r2 = (await call('POST', `/api/projects/${pid}/fixes/${picked.body.runId}/cancel`, {}), await call('POST', `/api/projects/${pid}/fixes`, target)).body;
    const m = new ScriptedModel([{ tools: [{ name: 'submit_result', input: { outcome: 'needs_more_info', root_cause: '-', summary: '-', pr_title: '-', confidence: 'low', tests_added: false } }] }]);
    let opened = '';
    await runFixAgent(pid, r2.runId, { model: () => m, openRepo: async (_i, name) => { opened = name; return fakeRepo().repo as never; } });
    expect(opened).toBe('acme/api');
    expect(JSON.stringify(m.seen[0][0].content)).toContain('Go code lives in cmd/.');
    // a repository removed after the run was queued: the run fails and says so
    const r3 = (await call('POST', `/api/projects/${pid}/fixes`, { ...target, repo: 'acme/shop' })).body;
    await patchRepos([{ fullName: 'acme/api', services: ['billing-*'] }]);
    await runFixAgent(pid, r3.runId, { model: () => m, openRepo: async () => fakeRepo().repo as never });
    expect((await call('GET', `/api/projects/${pid}/fixes/${r3.runId}`)).body).toMatchObject({ status: 'failed', error: expect.stringMatching(/acme\/shop was removed/) });
  });

  it('forgets everything when the project is deleted', async () => {
    expect((await call('DELETE', `/api/projects/${pid}`)).status).toBe(200);
    expect(await query('SELECT 1 FROM fix_settings WHERE project_id = $1', [pid])).toEqual([]);
    const { purgeDeletedProjects } = await import('../src/lib/purge');
    await query(`UPDATE deleted_projects SET deleted_at = now() - interval '2 hours' WHERE id = $1`, [pid]);
    await purgeDeletedProjects(Date.now() + 60_000);
    expect(await query('SELECT 1 FROM fix_runs WHERE project_id = $1', [pid])).toEqual([]);
  });
});
