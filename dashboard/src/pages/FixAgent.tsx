import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, CircleAlert, CircleCheck, CircleSlash, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, Loader2, Plus, Square, Trash2 } from 'lucide-react';
import type { ErrorGroup, FixAutoSettings, FixRepo, FixRun, FixSettings, FixSummary, FixTarget, GithubRepo, LogRecord, Span } from '../api/contract';
import type { TimeRange } from '../lib/time';
import { githubInstallUrl, githubManifest, useCancelFix, useFixRuns, useFixSettings, useFeatures, useFixTarget, useGithubApp, useGithubRepos, useSaveFixSettings, useServices, useStartFix } from '../api/hooks';
import { fmtNum, relTime } from '../lib/format';
import { useProject } from '../lib/project';
import { useRoute, useSetParams } from '../lib/router';
import { Button, Card, CardHeader, Field, Skeleton, Switch, useToast } from '../ui/kit';

/**
 * The opt-in GitHub Agent: an AI agent that reads the project's GitHub repository and opens draft pull requests for
 * errors. Everything here renders nothing unless an admin turned it on for the install (Me.features.fixAgent).
 */
/** Whether an admin turned the GitHub Agent on for this WGO. */
export const useFixAgentOn = () => useFeatures().fixAgent;

const LIVE = (r: Pick<FixSummary, 'status'> | null | undefined) => r?.status === 'queued' || r?.status === 'running';
const usd = (n: number | null) => (n === null ? null : n < 0.01 ? '< $0.01' : `$${n.toFixed(2)}`);
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

// ---------------------------------------------------------------- the Errors page

/** A small icon in an error row when the group has a fix in progress or a pull request. */
export function FixIcon({ fix }: { fix?: FixSummary | null }) {
  if (!fix) return null;
  if (LIVE(fix)) return <span title="The GitHub Agent is working on this error"><Loader2 size={12} className="shrink-0 animate-spin text-accent" /></span>;
  if (fix.prState === 'merged') return <span title={`Fixed in pull request #${fix.prNumber} (merged)`}><GitMerge size={12} className="shrink-0 text-good" /></span>;
  if (fix.prState === 'open') return <span title={`Pull request #${fix.prNumber} is open`}><GitPullRequest size={12} className="shrink-0 text-accent" /></span>;
  return null;
}

function PrLine({ run }: { run: FixRun }) {
  if (!run.prUrl) return null;
  const Icon = run.prState === 'merged' ? GitMerge : run.prState === 'closed' ? GitPullRequestClosed : GitPullRequest;
  const state = run.prState === 'merged' ? 'merged' : run.prState === 'closed' ? 'closed' : 'open, waiting for review';
  return (
    <a href={run.prUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px] hover:bg-[var(--hl)]">
      <Icon size={15} className={run.prState === 'merged' ? 'text-good' : run.prState === 'closed' ? 'text-faint' : 'text-accent'} />
      <span className="font-medium">Pull request #{run.prNumber}</span>
      <span className="text-muted">{run.repo}, {state}</span>
      <ExternalLink size={12} className="ml-auto text-faint" />
    </a>
  );
}

const OUTCOME: Record<string, string> = {
  fixed: 'Fix proposed',
  not_fixable: 'No fix: the cause is outside what it may change',
  needs_more_info: 'No fix: not enough to go on',
};

function RunDetail({ run, onCancel, cancelling }: { run: FixRun; onCancel?: () => void; cancelling?: boolean }) {
  const [showSteps, setShowSteps] = useState(false);
  const live = LIVE(run);
  const cost = usd(run.costUsd);
  const head = live
    ? <span className="flex items-center gap-2 text-[13px] font-medium"><Loader2 size={14} className="animate-spin text-accent" />{run.status === 'queued' ? 'Starting…' : 'Working on it…'}</span>
    : run.status === 'pr_opened'
      ? <span className="flex items-center gap-2 text-[13px] font-medium"><CircleCheck size={14} className="text-good" />{OUTCOME.fixed}</span>
      : run.status === 'no_fix'
        ? <span className="flex items-center gap-2 text-[13px] font-medium"><CircleSlash size={14} className="text-faint" />{OUTCOME[run.result?.outcome ?? ''] ?? 'No fix'}</span>
        : run.status === 'cancelled'
          ? <span className="flex items-center gap-2 text-[13px] font-medium"><Square size={13} className="text-faint" />Cancelled</span>
          : <span className="flex items-center gap-2 text-[13px] font-medium"><CircleAlert size={14} className="text-bad" />The run failed</span>;
  const steps = run.steps.filter((s) => s.tool !== 'submit_result');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {head}
        <span className="text-[12px] text-faint">in <span className="font-mono text-[11.5px]">{run.repo}</span>, {run.trigger === 'auto' ? 'started automatically' : `started by ${run.requestedBy ?? 'someone'}`} {relTime(run.createdAt)}</span>
        {live && onCancel && <Button size="sm" variant="ghost" className="ml-auto" disabled={cancelling} onClick={onCancel}><Square size={12} />Stop</Button>}
      </div>
      {live && steps.length > 0 && (
        <ol className="space-y-1 font-mono text-[11.5px] text-muted">
          {steps.slice(-6).map((s, i) => <li key={i} className={s.error ? 'text-bad' : ''}><span className="text-faint">{s.tool}</span> {s.summary}</li>)}
        </ol>
      )}
      <PrLine run={run} />
      {run.error && <p className="text-[12.5px] text-bad">{run.error}</p>}
      {run.result && (
        <div className="space-y-2 text-[12.5px] leading-relaxed">
          {run.result.rootCause && <p><span className="font-medium text-fg">Cause: </span><span className="text-muted">{run.result.rootCause}</span></p>}
          <p className="whitespace-pre-wrap text-muted">{run.result.summary}</p>
          {run.result.files.length > 0 && <p className="text-faint">Changed {run.result.files.map((f, i) => <span key={f}>{i ? ', ' : ''}<span className="font-mono text-[11.5px] text-muted">{f}</span></span>)}. Confidence {run.result.confidence}{run.result.testsAdded ? ', with a regression test' : ''}.</p>}
        </div>
      )}
      {!live && (
        <div className="flex flex-wrap items-center gap-x-3 text-[11.5px] text-faint">
          {(run.inputTokens > 0 || run.outputTokens > 0) && <span>{tokens(run.inputTokens + run.outputTokens)} tokens{cost ? `, about ${cost}` : ''}</span>}
          {steps.length > 0 && <button className="cursor-pointer hover:text-fg" onClick={() => setShowSteps(!showSteps)}>{showSteps ? 'Hide' : 'Show'} {steps.length} steps</button>}
        </div>
      )}
      {!live && showSteps && (
        <ol className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-line p-2 font-mono text-[11px] text-muted">
          {steps.map((s, i) => <li key={i} className={s.error ? 'text-bad' : ''}><span className="text-faint">{s.tool}</span> {s.summary}</li>)}
        </ol>
      )}
    </div>
  );
}

interface PanelProps {
  runs: FixRun[] | undefined;
  pending: boolean;
  error?: unknown;
  start: Record<string, unknown>; // POST /fixes body: {fingerprint, message} or a span/log FixTarget
  canStart: boolean;
  cannotTitle?: string;
  what: string; // "this error", "this failed span", "this error log"
  defaultRepo?: string | null; // where the server routes it (spans and logs); browser errors go to the web app's repository
}

/** The GitHub Agent section: start a run, follow it, see the pull request. Shared by errors, spans and logs. */
function FixPanel({ runs, pending, error, start: body, canStart, cannotTitle, what, defaultRepo }: PanelProps) {
  const { project } = useProject();
  const toast = useToast();
  const settings = useFixSettings(project.id);
  const [picked, setPicked] = useState<string | null>(null);
  const start = useStartFix(project.id);
  const cancel = useCancelFix(project.id);
  const heading = <h4 className="flex items-center gap-2 text-[13px] font-semibold"><Bot size={15} className="text-muted" />GitHub Agent</h4>;
  if (settings.isPending || pending) return <div className="space-y-2">{heading}<Skeleton className="h-9" /></div>;
  const s = settings.data;
  // a run just started shows at once, before the list has been fetched again
  const fresh = start.data && !runs?.some((r) => r.runId === start.data!.runId) ? start.data : null;
  const list = fresh ? [fresh, ...(runs ?? [])] : runs ?? [];
  const latest = list[0] ?? null;
  const earlier = list.slice(1);
  const blocked = start.isPending || LIVE(latest) || latest?.prState === 'open';
  if (!s?.enabled && !latest) {
    return (
      <div className="space-y-1.5">
        {heading}
        <p className="text-[12.5px] text-muted">An AI agent can look for the cause in your GitHub repository and open a draft pull request for you to review. {project.role === 'owner' ? <a className="text-accent hover:underline" href={`#/p/${project.id}/fix-agent`}>Set it up</a> : <>A project owner sets it up on the <a className="text-accent hover:underline" href={`#/p/${project.id}/fix-agent`}>GitHub Agent page</a>.</>}</p>
      </div>
    );
  }
  if (error) return <div className="space-y-1.5">{heading}<p className="text-[12.5px] text-muted">{(error as Error).message}</p></div>;
  const repos = s?.repos ?? [];
  const routed = defaultRepo ?? (repos.find((r) => r.browser) ?? repos[0])?.fullName ?? null;
  const repo = picked && repos.some((r) => r.fullName === picked) ? picked : routed;
  const go = () => start.mutate({ ...body, ...(repo ? { repo } : {}) }, {
    onError: (er) => toast({ title: 'Couldn’t start the GitHub Agent', body: (er as Error).message, tone: 'bad' }),
  });
  return (
    <div className="space-y-3 rounded-xl border border-line p-4">
      <div className="flex items-center gap-3">
        {heading}
        {s?.enabled && !blocked && repos.length > 1 && (
          <select className="field ml-auto !w-auto !py-1 text-[12px]" value={repo ?? ''} onChange={(e) => setPicked(e.target.value)} aria-label="Repository" title="The repository the agent works in">
            {repos.map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}</option>)}
          </select>
        )}
        {s?.enabled && !blocked && (
          <Button size="sm" variant={latest ? 'secondary' : 'primary'} className={repos.length > 1 ? '' : 'ml-auto'} disabled={start.isPending || !canStart} onClick={go}
            title={canStart ? `Reads ${repo} and opens a draft pull request if it finds a fix` : cannotTitle}>
            <Bot size={13} />{latest ? 'Try again' : 'Fix with agent'}
          </Button>
        )}
      </div>
      {start.isPending && <span className="flex items-center gap-2 text-[13px] font-medium"><Loader2 size={14} className="animate-spin text-accent" />Starting…</span>}
      {!latest && !start.isPending && <p className="text-[12.5px] text-muted">The agent reads <span className="font-mono text-[11.5px]">{repo}</span>, looks for the cause of {what} and, if it finds a fix, opens a draft pull request. It takes a few minutes and never merges anything.</p>}
      {latest && !start.isPending && <RunDetail run={latest} onCancel={() => cancel.mutate(latest.runId)} cancelling={cancel.isPending} />}
      {earlier.length > 0 && (
        <details className="text-[12px] text-faint">
          <summary className="cursor-pointer hover:text-fg">{earlier.length} earlier run{earlier.length === 1 ? '' : 's'}</summary>
          <ul className="mt-2 space-y-1">
            {earlier.map((r) => <li key={r.runId}>{relTime(r.createdAt)}: {r.status === 'pr_opened' ? <a className="text-accent hover:underline" href={r.prUrl ?? '#'} target="_blank" rel="noreferrer">#{r.prNumber} ({r.prState})</a> : r.status === 'no_fix' ? OUTCOME[r.result?.outcome ?? ''] ?? 'no fix' : r.status}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The Errors drawer: one JavaScript error group. */
export function FixSection({ g }: { g: ErrorGroup }) {
  const { project } = useProject();
  const on = useFixAgentOn();
  const runs = useFixRuns(project.id, g.fingerprint, on);
  if (!on) return null;
  return <FixPanel runs={runs.data} pending={runs.isPending} start={{ fingerprint: g.fingerprint, message: g.message }} canStart={!!g.sampleStack} cannotTitle="This error has no stack to start from" what="this error" />;
}

/** A failed span in the trace view (status ERROR or an exception event). */
export function SpanFix({ span }: { span: Span }) {
  const { project } = useProject();
  const on = useFixAgentOn() && span.service !== 'browser' && (span.statusCode === 2 || span.events.some((e) => e.name === 'exception'));
  const target: FixTarget = { kind: 'span', traceId: span.traceId, spanId: span.spanId, at: span.start };
  const info = useFixTarget(project.id, target, on);
  if (!on) return null;
  return <FixPanel runs={info.data?.runs} pending={info.isPending} error={info.error} start={target} canStart what="this failed span" defaultRepo={info.data?.repo} />;
}

/** An ERROR or FATAL log record. */
export function LogFix({ log }: { log: LogRecord }) {
  const { project } = useProject();
  const on = useFixAgentOn() && log.severityNumber >= 17;
  const target: FixTarget = { kind: 'log', logId: log.id, at: log.ts };
  const info = useFixTarget(project.id, target, on);
  if (!on) return null;
  return <FixPanel runs={info.data?.runs} pending={info.isPending} error={info.error} start={target} canStart what="this error log" defaultRepo={info.data?.repo} />;
}

/** Where a run's error is shown in the dashboard. */
export function runHref(pid: string, r: FixRun): string {
  if (r.target.kind === 'span') return `#/p/${pid}/traces/${r.target.traceId}${r.target.at ? `?at=${encodeURIComponent(r.target.at)}` : ''}`;
  if (r.target.kind === 'log') return `#/p/${pid}/logs?q=${encodeURIComponent((r.message ?? '').replace(/^[^:]+: /, '').slice(0, 60))}`;
  return `#/p/${pid}/errors?fp=${encodeURIComponent(r.fingerprint)}`;
}

// ---------------------------------------------------------------- Settings

function submitManifest(action: string, manifest: string) {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = action;
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = manifest;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}

interface RepoDraft { fullName: string; baseBranch: string; rootPath: string; instructions: string; deniedPaths: string; browser: boolean; services: string }
interface Draft { enabled: boolean; repos: RepoDraft[]; auto: FixAutoSettings }
const DEFAULT_DENIED = ['.github/**', '.circleci/**', '.gitlab-ci.yml', '.husky/**', '**/package.json', '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/Dockerfile', '**/*.sh', '**/*.tf', '**/template.yaml', '**/.env*', '**/.npmrc'];
const repoDraft = (r: FixRepo): RepoDraft => ({
  fullName: r.fullName, baseBranch: r.baseBranch ?? '', rootPath: r.rootPath ?? '', instructions: r.instructions ?? '',
  deniedPaths: r.deniedPaths.join('\n'), browser: r.browser, services: r.services.join(', '),
});
const draftOf = (s: FixSettings): Draft => ({ enabled: s.enabled, repos: s.repos.map(repoDraft), auto: s.auto });
const toRepo = (r: RepoDraft): FixRepo => ({
  fullName: r.fullName, baseBranch: r.baseBranch.trim() || null, rootPath: r.rootPath.trim() || null, instructions: r.instructions.trim() || null,
  deniedPaths: r.deniedPaths.split('\n').map((x) => x.trim()).filter(Boolean), browser: r.browser,
  services: r.services.split(',').map((x) => x.trim()).filter(Boolean),
});

/** One repository in the settings: which errors it fixes and how the agent works in it. */
function RepoEditor({ r, index, owner, available, services, onChange, onRemove }: {
  r: RepoDraft; index: number; owner: boolean; available: GithubRepo[] | undefined; services: string[];
  onChange: (p: Partial<RepoDraft>) => void; onRemove: () => void;
}) {
  const known = available ?? (r.fullName ? [{ fullName: r.fullName, defaultBranch: '', private: true }] : []);
  // suggestions complete the last name in the list
  const listed = r.services.split(',').map((x) => x.trim());
  const prefix = r.services.includes(',') ? `${r.services.slice(0, r.services.lastIndexOf(',') + 1)} ` : '';
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <div className="flex items-center gap-2">
        <select className="field" disabled={!owner} value={r.fullName} onChange={(e) => onChange({ fullName: e.target.value })} aria-label="Repository">
          <option value="">{owner && !available ? 'Loading…' : 'Choose a repository'}</option>
          {known.map((x) => <option key={x.fullName} value={x.fullName}>{x.fullName}</option>)}
        </select>
        {owner && <Button variant="ghost" onClick={onRemove} title="Remove this repository"><Trash2 size={14} /></Button>}
      </div>
      <div className="space-y-1.5">
        <div className="text-[11.5px] font-medium text-muted">Fixes</div>
        <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" disabled={!owner} checked={r.browser} onChange={(e) => onChange({ browser: e.target.checked })} />JavaScript errors from the web app</label>
        <input className="field" disabled={!owner} list={`fix-services-${index}`} value={r.services} placeholder="Backend services, comma-separated, e.g. checkout-api, billing-*" onChange={(e) => onChange({ services: e.target.value })} aria-label="Backend services" />
        <datalist id={`fix-services-${index}`}>{services.filter((x) => !listed.includes(x)).map((x) => <option key={x} value={`${prefix}${x}`} />)}</datalist>
        <p className="text-[11.5px] text-faint">Failed spans and error logs from these services ({'*'} matches anything).{index === 0 ? ' Errors no repository claims come here too.' : ''}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Base branch" hint="Empty: the repository's default branch">
          <input className="field" disabled={!owner} value={r.baseBranch} placeholder={available?.find((x) => x.fullName === r.fullName)?.defaultBranch || 'main'} onChange={(e) => onChange({ baseBranch: e.target.value })} />
        </Field>
        <Field label="App folder" hint="For a monorepo: where the code for these errors lives, e.g. web/">
          <input className="field" disabled={!owner} value={r.rootPath} placeholder="The whole repository" onChange={(e) => onChange({ rootPath: e.target.value })} />
        </Field>
      </div>
      <details className="group" open={!!r.instructions}>
        <summary className="cursor-pointer text-[12px] text-muted hover:text-fg">Instructions and protected paths</summary>
        <div className="mt-3 space-y-3">
          <Field label="Instructions for the agent" hint="Conventions it should follow in this repository, e.g. where tests live and how they're written. Up to 4000 characters.">
            <textarea className="field min-h-[72px]" disabled={!owner} value={r.instructions} maxLength={4000} placeholder="Tests use vitest and live next to the file as *.test.ts." onChange={(e) => onChange({ instructions: e.target.value })} />
          </Field>
          <Field label="Protected paths, one per line" hint="The agent can't change files matching these. Keep CI, build files, dependencies and secrets here.">
            <textarea className="field min-h-[96px] font-mono text-[12px]" disabled={!owner} value={r.deniedPaths} onChange={(e) => onChange({ deniedPaths: e.target.value })} />
          </Field>
        </div>
      </details>
    </div>
  );
}

const Step = ({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) => (
  <div className="flex gap-3 border-t border-line px-4 py-3.5">
    <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11.5px] font-semibold ${done ? 'bg-good/15 text-good' : 'bg-[var(--line-strong)] text-muted'}`}>{done ? '✓' : n}</span>
    <div className="min-w-0 flex-1 space-y-2"><div className="text-[13px] font-medium">{title}</div>{children}</div>
  </div>
);

export function FixAgentSettings() {
  const { project } = useProject();
  const toast = useToast();
  const route = useRoute();
  const setParams = useSetParams();
  const qc = useQueryClient();
  const owner = project.role === 'owner';
  const app = useGithubApp();
  const settings = useFixSettings(project.id);
  const installed = !!settings.data?.installed;
  const repos = useGithubRepos(project.id, owner && installed);
  const svc = useServices(project.id, { from: new Date(Date.now() - 7 * 86400e3).toISOString(), to: new Date().toISOString() } as TimeRange);
  const serviceNames = (svc.data ?? []).map((x) => x.service).filter((x) => x !== 'browser');
  const save = useSaveFixSettings(project.id);
  const runs = useFixRuns(project.id, undefined, installed);
  const [org, setOrg] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  // back from GitHub
  const result = route.params.get('github');
  useEffect(() => {
    if (!result) return;
    void qc.invalidateQueries({ queryKey: ['github-app'] });
    void qc.invalidateQueries({ queryKey: ['fix-settings', project.id] });
    toast(result === 'created' ? { title: 'GitHub App created', body: 'Now install it on your repository.', tone: 'good' }
      : result === 'installed' ? { title: 'GitHub App installed', body: 'Pick the repository and turn the agent on.', tone: 'good' }
        : { title: 'GitHub didn’t finish connecting', tone: 'bad' });
    setParams({ github: null }, true);
    document.getElementById('fix-agent')?.scrollIntoView({ block: 'start' });
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (settings.data && !draft) setDraft(draftOf(settings.data)); }, [settings.data, draft]);

  const a = app.data;
  const s = settings.data;
  const fail = (title: string) => (er: unknown) => { setBusy(false); toast({ title, body: (er as Error).message, tone: 'bad' }); };
  const createApp = () => { setBusy(true); githubManifest(project.id, org.trim() || undefined).then((f) => submitManifest(f.action, f.manifest), fail('Couldn’t start creating the app')); };
  const install = () => { setBusy(true); githubInstallUrl(project.id).then((url) => { location.href = url; }, fail('Couldn’t start the installation')); };
  const d = draft;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((x) => (x ? { ...x, [k]: v } : x));
  const setRepo = (i: number, p: Partial<RepoDraft>) => setDraft((x) => (x ? { ...x, repos: x.repos.map((r, k) => (k === i ? { ...r, ...p } : r)) } : x));
  const addRepo = () => setDraft((x) => (x ? { ...x, repos: [...x.repos, { fullName: '', baseBranch: '', rootPath: '', instructions: '', deniedPaths: DEFAULT_DENIED.join('\n'), browser: !x.repos.some((r) => r.browser), services: '' }] } : x));
  const removeRepo = (i: number) => setDraft((x) => (x ? { ...x, repos: x.repos.filter((_, k) => k !== i) } : x));
  const setAuto = (p: Partial<FixAutoSettings>) => setDraft((x) => (x ? { ...x, auto: { ...x.auto, ...p } } : x));
  const dirty = !!(d && s && JSON.stringify(d) !== JSON.stringify(draftOf(s)));
  const submit = () => d && save.mutate({
    enabled: d.enabled, repos: d.repos.filter((r) => r.fullName).map(toRepo),
    auto: { ...d.auto, minEvents: Number(d.auto.minEvents), minSessions: Number(d.auto.minSessions), maxPerDay: Number(d.auto.maxPerDay) },
  }, {
    onSuccess: (n) => { setDraft(draftOf(n)); toast({ title: 'GitHub Agent settings saved', tone: 'good' }); },
    onError: fail('Couldn’t save the settings'),
  });

  return (
    <Card id="fix-agent">
      <CardHeader title="This project" sub={`Where ${project.name}'s errors get fixed: the repository, what the agent may change and whether it starts runs by itself. A person always reviews and merges its pull requests.`} />
      {app.isPending || settings.isPending ? <div className="space-y-2 px-4 pb-4"><Skeleton className="h-9" /><Skeleton className="h-9" /></div> : (
        <>
          <Step n={1} title="Create WGO's GitHub App" done={!!a?.app}>
            {a?.app ? (
              <p className="text-[12.5px] text-muted"><a className="text-accent hover:underline" href={a.app.htmlUrl} target="_blank" rel="noreferrer">{a.app.slug}</a>{a.app.owner ? ` on ${a.app.owner}` : ''}, created by {a.app.createdBy}. It can read code and open pull requests, and can't change workflows.</p>
            ) : a?.canCreate ? (
              <>
                <p className="text-[12.5px] text-muted">One app for the whole WGO install. GitHub asks you to confirm its name; it gets access to code and pull requests only. Leave the organization empty to create it on your own account.</p>
                <div className="flex flex-wrap gap-2">
                  <input className="field !w-64" placeholder="GitHub organization (optional)" value={org} onChange={(e) => setOrg(e.target.value)} />
                  <Button variant="primary" disabled={busy} onClick={createApp}>Create on GitHub</Button>
                </div>
              </>
            ) : <p className="text-[12.5px] text-muted">An admin of this WGO creates the app once for every project.</p>}
          </Step>
          <Step n={2} title="Install it on the repository" done={installed}>
            {installed ? (
              <p className="text-[12.5px] text-muted">Installed on {s?.account}. {owner && a?.app && <button className="cursor-pointer text-accent hover:underline" onClick={install}>Change which repositories it can see</button>}</p>
            ) : owner ? (
              <>
                <p className="text-[12.5px] text-muted">Pick the repository this project's code lives in. GitHub then asks you to authorize the app, so WGO can check the installation is yours.</p>
                <Button variant="primary" disabled={busy || !a?.app} onClick={install}>Install on GitHub</Button>
              </>
            ) : <p className="text-[12.5px] text-muted">A project owner installs it.</p>}
          </Step>
          <Step n={3} title="Choose what it works on" done={!!s?.enabled}>
            {!installed || !d ? <p className="text-[12.5px] text-faint">After installing.</p> : (
              <div className="space-y-4">
                <div className="space-y-2">
                  {d.repos.map((r, k) => <RepoEditor key={k} r={r} index={k} owner={owner} available={repos.data} services={serviceNames} onChange={(p) => setRepo(k, p)} onRemove={() => removeRepo(k)} />)}
                  {!d.repos.length && <p className="text-[12.5px] text-muted">Add the repository this project's code lives in. With several (a web app and backend services in different repositories), say which errors each one fixes.</p>}
                  {owner && d.repos.length < 10 && <Button variant={d.repos.length ? 'ghost' : 'secondary'} onClick={addRepo}><Plus size={14} />Add repository</Button>}
                </div>
                <div className="space-y-2.5 rounded-lg border border-line p-3">
                  <Switch checked={d.auto.enabled} onChange={(v) => owner && setAuto({ enabled: v })} label={<span className="text-[12.5px] text-fg">Start runs automatically</span>} />
                  <p className="text-[12px] text-muted">For JavaScript error groups that reach these numbers within an hour and never had a run. Off: runs start only from “Fix with agent” on an error, a failed span or an error log.</p>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Events in an hour"><input className="field" type="number" min={1} disabled={!owner} value={d.auto.minEvents} onChange={(e) => setAuto({ minEvents: Number(e.target.value) })} /></Field>
                    <Field label="Sessions in an hour"><input className="field" type="number" min={1} disabled={!owner} value={d.auto.minSessions} onChange={(e) => setAuto({ minSessions: Number(e.target.value) })} /></Field>
                    <Field label="Automatic runs per day" hint="Runs people start aren’t limited"><input className="field" type="number" min={1} max={50} disabled={!owner} value={d.auto.maxPerDay} onChange={(e) => setAuto({ maxPerDay: Number(e.target.value) })} /></Field>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Switch checked={d.enabled} onChange={(v) => owner && set('enabled', v)} label={<span className="text-[12.5px] text-fg">GitHub Agent on for this project</span>} />
                  {owner && <Button variant="primary" className="ml-auto" disabled={!dirty || save.isPending} onClick={submit}>Save</Button>}
                </div>
                <p className="text-[12px] leading-relaxed text-faint">Each run is billed {s?.model.provider === 'anthropic' ? 'to the install’s Claude API account' : 'to this AWS account through Bedrock'}, typically under a dollar; every run shows its cost. Error messages, stacks and logs can hold text anyone could send, so the agent treats them as untrusted, can't run code, can't touch protected paths, and only opens drafts for review. Keep reviews and CI required before merging.</p>
              </div>
            )}
          </Step>
          {installed && !!runs.data?.length && (
            <div className="border-t border-line px-4 py-3">
              <div className="mb-2 text-[13px] font-medium">Recent runs</div>
              <ul className="divide-y divide-line/60 text-[12.5px]">
                {runs.data.slice(0, 8).map((r) => (
                  <li key={r.runId} className="flex items-center gap-3 py-1.5">
                    <a className="min-w-0 flex-1 truncate hover:text-fg text-muted" href={runHref(project.id, r)}>{r.message ?? r.fingerprint}</a>
                    <span className="shrink-0 text-faint">{r.status === 'pr_opened' ? <a className="text-accent hover:underline" href={r.prUrl ?? '#'} target="_blank" rel="noreferrer">#{r.prNumber} {r.prState}</a> : r.status === 'no_fix' ? 'no fix' : r.status.replace('_', ' ')}</span>
                    <span className="w-20 shrink-0 text-right text-faint">{relTime(r.createdAt)}</span>
                    <span className="w-14 shrink-0 text-right text-faint tnum">{usd(r.costUsd) ?? ''}</span>
                  </li>
                ))}
              </ul>
              {s?.auto.enabled && <p className="mt-2 text-[11.5px] text-faint">{fmtNum(s.autoRunsToday)} of {s.auto.maxPerDay} automatic runs used today.</p>}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
