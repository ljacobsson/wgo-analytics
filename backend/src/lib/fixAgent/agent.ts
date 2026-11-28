import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AfterToolCallEvent, Agent, BedrockModel, NullConversationManager, type Model } from '@strands-agents/sdk';
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic';
import type { FixResult, FixStep } from '../../contract';
import { execute, query } from '../db';
import { apiKey, effectiveConfig, type EffectiveConfig } from '../fixConfig';
import { runRow, runSettings, type RunSettings } from '../fixes';
import { Repo } from '../github';
import { HttpError } from '../http';
import { buildBackendBrief, buildBrief, errorGroup } from './context';
import { resolveBackend } from './targets';
import { firstMessage, SYSTEM_PROMPT } from './prompt';
import { fixTools, stepSummary, type SubmittedResult } from './tools';
import { Workspace } from './workspace';

/**
 * One GitHub Agent run (invoked asynchronously by lib/fixes.ts startRun): download the repository, give the error to a
 * Strands agent with the tools in tools.ts, and turn its changes into a draft pull request.
 *
 * Bounded three ways: model turns and tokens (Strands limits), wall-clock time (stops itself before the Lambda's
 * 15 minutes) and cancellation from the dashboard (checked after every tool call).
 */

const DEADLINE_MS = 13.5 * 60_000;
const FLUSH_MS = 4000;
const MAX_STEPS = 200;

const env = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** List prices per million tokens [input, output, cache read, cache write], for the run's cost estimate. */
const PRICES: Array<[RegExp, [number, number, number, number]]> = [
  [/fable-5-2/, [8, 40, 0.2, 10]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus-(5|4-[678])/, [5, 25, 0.5, 6.25]],
  [/sonnet-5/, [2, 10, 0.1, 2.5]],
  [/sonnet-4/, [3, 15, 0.3, 3.75]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.125]],
  [/haiku-4-5/, [1, 5, 0.1, 1.25]],
];

export interface Usage { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number }

export function estimateCost(modelId: string, u: Usage): number | null {
  const p = PRICES.find(([re]) => re.test(modelId))?.[1];
  if (!p) return null;
  const read = u.cacheReadInputTokens ?? 0, write = u.cacheWriteInputTokens ?? 0;
  // Bedrock's inputTokens leaves out cached tokens
  return Math.round(((u.inputTokens * p[0] + u.outputTokens * p[1] + read * p[2] + write * p[3]) / 1e6) * 10_000) / 10_000;
}

/** The model the install's settings name (lib/fixConfig.ts): Claude on Bedrock, or the Claude API with the saved key. */
export async function makeModel(cfg: EffectiveConfig): Promise<Model> {
  const effort = cfg.effort ? { output_config: { effort: cfg.effort } } : null;
  if (cfg.provider === 'anthropic') {
    const key = await apiKey();
    if (!key) throw new HttpError(409, 'The GitHub Agent is set to use the Claude API but no API key is saved. An admin adds one on the GitHub Agent page');
    return new AnthropicModel({ apiKey: key, modelId: cfg.modelId, maxTokens: 32_000, cacheConfig: {}, ...(effort ? { params: effort } : {}) });
  }
  return new BedrockModel({
    region: process.env.AWS_REGION,
    modelId: cfg.modelId,
    maxTokens: 32_000,
    // inference profile ids aren't recognized by 'auto'; every model this runs with is a Claude model
    cacheConfig: { strategy: 'anthropic' },
    ...(effort ? { additionalRequestFields: effort } : {}),
  });
}

/** Seam for tests: everything that talks to the outside world. */
export interface Deps {
  model: (cfg: EffectiveConfig) => Model | Promise<Model>;
  openRepo: (installationId: number, fullName: string) => Promise<Pick<Repo, 'defaultBranch' | 'head' | 'download' | 'commit' | 'openPr'>>;
}

const DEFAULT_DEPS: Deps = {
  model: makeModel,
  openRepo: (id, name) => Repo.open(id, name),
};

async function status(pid: string, id: string): Promise<string | null> {
  return (await query<{ status: string }>('SELECT status FROM fix_runs WHERE project_id = $1 AND id = $2', [pid, id]))[0]?.status ?? null;
}

/** Final update; never overwrites a run the dashboard cancelled. */
async function finish(pid: string, id: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  const set = keys.map((k, i) => `${k} = $${i + 3}${k === 'result' || k === 'steps' ? '::jsonb' : ''}`).join(', ');
  await execute(
    `UPDATE fix_runs SET ${set}, finished_at = now() WHERE project_id = $1 AND id = $2 AND status = 'running'`,
    [pid, id, ...keys.map((k) => (k === 'result' || k === 'steps' ? JSON.stringify(fields[k]) : fields[k]))],
  );
}

export function prBody(r: SubmittedResult, ctx: { message: string; detail: string; link: string | null; runId: string; modelId: string }): string {
  return [
    r.summary.trim(),
    '',
    '### Root cause',
    r.rootCause.trim(),
    '',
    '---',
    `**Error:** \`${ctx.message.replace(/`/g, "'").slice(0, 300)}\` (${ctx.detail})${ctx.link ? `. [Open in WGO](${ctx.link})` : ''}`,
    `**Confidence:** ${r.confidence}. **Regression test:** ${r.testsAdded ? 'added' : 'none'}.`,
    '',
    `Opened by WGO's GitHub Agent (run \`${ctx.runId}\`, ${ctx.modelId}). It never ran this code: review the change and let CI run before merging.`,
  ].join('\n');
}

export async function runFixAgent(pid: string, runId: string, deps: Deps = DEFAULT_DEPS): Promise<void> {
  const started = await execute(`UPDATE fix_runs SET status = 'running', started_at = now() WHERE project_id = $1 AND id = $2 AND status = 'queued'`, [pid, runId]);
  if (!started) return; // cancelled before it started, or a duplicate invocation
  const run = await runRow(pid, runId);
  // the install's model now (an admin may have changed it since the run was queued)
  const cfg = await effectiveConfig();
  if (cfg.modelId !== run.model_id) {
    await execute('UPDATE fix_runs SET model_id = $3 WHERE project_id = $1 AND id = $2', [pid, runId, cfg.modelId]);
    run.model_id = cfg.modelId;
  }
  const dir = join(tmpdir(), `fix-${runId}`);
  const steps: FixStep[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  const cancel = new AbortController();
  const step = (tool: string, summary: string, error = false) => {
    if (steps.length < MAX_STEPS) steps.push({ ts: new Date().toISOString(), tool, summary: summary.slice(0, 200), ...(error ? { error } : {}) });
  };
  let flushed = 0;
  const flush = async (force = false) => {
    if (!force && Date.now() - flushed < FLUSH_MS) return;
    flushed = Date.now();
    const u = usage;
    await execute(`UPDATE fix_runs SET steps = $3::jsonb, input_tokens = $4, output_tokens = $5 WHERE project_id = $1 AND id = $2`,
      [pid, runId, JSON.stringify(steps), u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheWriteInputTokens ?? 0), u.outputTokens]);
    if ((await status(pid, runId)) === 'cancelled') cancel.abort();
  };
  const addUsage = (u?: Partial<Usage>) => {
    if (!u) return;
    usage.inputTokens += u.inputTokens ?? 0;
    usage.outputTokens += u.outputTokens ?? 0;
    usage.cacheReadInputTokens! += u.cacheReadInputTokens ?? 0;
    usage.cacheWriteInputTokens! += u.cacheWriteInputTokens ?? 0;
  };
  const costFields = () => ({
    input_tokens: usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0),
    output_tokens: usage.outputTokens,
    cost_usd: estimateCost(run.model_id, usage),
  });

  try {
    const s: RunSettings | null = await runSettings(pid, run.repo);
    if (!s) throw new HttpError(409, `The GitHub Agent was turned off for this project, or ${run.repo} was removed from it`);
    const repo = await deps.openRepo(s.installationId, run.repo);
    const branch = s.baseBranch ?? (await repo.defaultBranch());
    const base = await repo.head(branch);
    step('download', `${run.repo}@${branch} (${base.sha.slice(0, 7)})`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const tree = await repo.download(base.sha, dir);
    const ws = new Workspace(dir, s.deniedPaths, s.rootPath);

    // what the run is about, and how the pull request refers back to it
    const kind = run.kind ?? 'browser';
    let subject: { brief: string; message: string; detail: string; linkPath: string } | null = null;
    if (kind === 'browser') {
      const group = await errorGroup(pid, run.fingerprint);
      if (group) subject = { brief: await buildBrief(pid, group, ws), message: group.message, detail: `${group.count} events in ${group.sessions} sessions over the last 7 days`, linkPath: `errors?fp=${encodeURIComponent(run.fingerprint)}` };
    } else if (run.target && run.target.kind !== 'browser') {
      const e = await resolveBackend(pid, run.target);
      if (e) {
        const traceId = e.span?.traceId ?? e.log?.traceId;
        subject = {
          brief: await buildBackendBrief(pid, e, ws), message: e.message,
          detail: e.span ? `a failed span in ${e.service}` : `an error log from ${e.service}`,
          linkPath: e.span ? `traces/${e.span.traceId}?at=${encodeURIComponent(e.span.start)}` : traceId ? `logs?traceId=${traceId}` : 'logs',
        };
      }
    }
    if (!subject) {
      const summary = kind === 'browser' ? 'This error hasn’t happened in the last 7 days, so there is nothing recent to work from.' : 'That span or log isn’t stored any more (it’s older than the project’s retention), so there is nothing to work from.';
      await finish(pid, runId, { status: 'no_fix', steps, result: { outcome: 'needs_more_info', rootCause: '', summary, confidence: 'low', testsAdded: false, files: [] } satisfies FixResult });
      return;
    }
    const brief = firstMessage(subject.brief, s, branch, tree);
    await flush(true);

    let result: SubmittedResult | null = null;
    const agent = new Agent({
      model: await deps.model(cfg),
      systemPrompt: SYSTEM_PROMPT,
      tools: fixTools(ws, pid, { kind, fingerprint: run.fingerprint }, (r) => { result = r; }),
      conversationManager: new NullConversationManager(),
      printer: false,
      name: 'wgo-fix-agent',
    });
    agent.addHook(AfterToolCallEvent, async (e) => {
      step(e.toolUse.name, stepSummary(e.toolUse.name, e.toolUse.input), e.result.status === 'error');
      await flush();
    });
    const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(DEADLINE_MS)]);
    const limits = { turns: env('FIX_MAX_TURNS', 50), totalTokens: env('FIX_MAX_TOTAL_TOKENS', 4_000_000) };
    const first = await agent.invoke(brief, { limits, cancelSignal: signal });
    addUsage(first.metrics?.accumulatedUsage);
    // it stopped without submitting (a limit, or it just ended its turn): ask once more, briefly
    if (!result && !signal.aborted && first.stopReason !== 'cancelled') {
      const again = await agent.invoke('Stop investigating now and call submit_result with what you know. If your changes are incomplete, revert them and choose needs_more_info.', { limits: { turns: 3 }, cancelSignal: signal });
      addUsage(again.metrics?.accumulatedUsage);
    }
    if (cancel.signal.aborted || (await status(pid, runId)) === 'cancelled') {
      await execute('UPDATE fix_runs SET steps = $3::jsonb, input_tokens = $4, output_tokens = $5, cost_usd = $6 WHERE project_id = $1 AND id = $2',
        [pid, runId, JSON.stringify(steps), costFields().input_tokens, costFields().output_tokens, costFields().cost_usd]);
      return;
    }
    const r = result as SubmittedResult | null;
    if (!r) throw new Error(signal.aborted ? 'The agent ran out of time before it finished' : `The agent stopped without a result (${first.stopReason})`);

    const changes = await ws.changes();
    const fixResult: FixResult = {
      outcome: r.outcome, rootCause: r.rootCause, summary: r.summary, confidence: r.confidence, testsAdded: r.testsAdded,
      files: r.outcome === 'fixed' ? changes.map((c) => c.path) : [],
    };
    if (r.outcome !== 'fixed' || !changes.length) {
      await finish(pid, runId, { status: 'no_fix', steps, result: fixResult, ...costFields() });
      return;
    }

    const head = `wgo-fix/${run.fingerprint.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'error'}-${runId.slice(0, 8)}`;
    const title = (r.prTitle.trim() || `Fix: ${subject.message}`).replace(/\s+/g, ' ').slice(0, 120);
    await repo.commit(base, head, `${title}\n\nFixes the WGO error ${run.fingerprint}.\nProposed by WGO's GitHub Agent (run ${runId}).`, changes);
    step('commit', `${changes.length} file${changes.length === 1 ? '' : 's'} on ${head}`);
    const origin = s.dashboardUrl || process.env.DASHBOARD_URL || null;
    const link = origin ? `${origin.replace(/\/$/, '')}/#/p/${pid}/${subject.linkPath}` : null;
    const pr = await repo.openPr({
      title, head, base: branch,
      body: prBody(r, { message: subject.message, detail: subject.detail, link, runId, modelId: run.model_id }),
    });
    step('pull_request', `#${pr.number}`);
    await finish(pid, runId, { status: 'pr_opened', steps, result: { ...fixResult, prTitle: title }, branch: head, pr_number: pr.number, pr_url: pr.url, pr_state: 'open', ...costFields() });
  } catch (err) {
    console.error(JSON.stringify({ msg: 'GitHub Agent run failed', run: runId, error: String(err), stack: (err as Error)?.stack }));
    const message = err instanceof HttpError ? err.message : `The run failed: ${String((err as Error)?.message ?? err).slice(0, 300)}`;
    await finish(pid, runId, { status: 'failed', error: message, steps, ...costFields() }).catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
