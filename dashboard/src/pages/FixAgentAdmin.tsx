import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { ApiError } from '../api/client';
import type { FixAgentAdmin, FixAgentConfigInput, FixEffort, FixProvider } from '../api/contract';
import { FIX_EFFORTS } from '../api/contract';
import { useFeatures, useFixAgentAdmin, useFixSettings, useMe, useSaveFixAgentAdmin } from '../api/hooks';
import { useProject } from '../lib/project';
import { FixAgentSettings } from './FixAgent';
import { AgentSwitchCard } from './InstallAdmin';
import { fmtNum, relTime } from '../lib/format';
import { Button, Card, CardHeader, EmptyState, ErrorState, Field, Segmented, Skeleton, useToast } from '../ui/kit';

/**
 * Admins: which model the GitHub Agent uses for every project (Claude on Bedrock or the Claude API with the install's
 * own key), and what it did and cost this month.
 */

const EFFORT_NOTE: Record<FixEffort, string> = {
  low: 'Fewest tokens; fine for obvious one-line fixes.',
  medium: 'A balance of cost and care.',
  high: 'Recommended: reads around the error before changing anything.',
  xhigh: 'More thorough on bugs that span several files, at a higher cost.',
  max: 'Most thorough and most expensive.',
};

interface Draft { provider: FixProvider; modelId: string; custom: boolean; effort: FixEffort; apiKey: string; removeKey: boolean }

const draftOf = (d: FixAgentAdmin): Draft => ({
  provider: d.config.provider, modelId: d.config.modelId, effort: d.config.effort, apiKey: '', removeKey: false,
  custom: !d.models.some((m) => m.provider === d.config.provider && m.modelId === d.config.modelId),
});

const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '< $0.01' : `$${n.toFixed(2)}`);

/** The GitHub Agent page: this project's setup for every member (owners edit), then the install-wide model and usage for admins. */
export function GithubAgentPage() {
  const me = useMe();
  const on = useFeatures().fixAgent;
  const admin = !!me.data?.admin;
  if (!on && !admin) return <EmptyState title="The GitHub Agent is off">An AI agent that opens pull requests fixing this project’s errors. An admin of this WGO turns it on on this page.</EmptyState>;
  return (
    <div className="mx-auto max-w-[920px] space-y-4">
      <AgentSwitchCard />
      {on && <FixAgentSettings />}
      {admin ? <InstallSettings /> : <ModelNote />}
    </div>
  );
}

/** Members who aren't admins: which model runs use. */
function ModelNote() {
  const { project } = useProject();
  const s = useFixSettings(project.id);
  return (
    <Card>
      <CardHeader title="Model" sub="Admins choose it for every project." />
      <p className="px-4 pb-4 text-[12.5px] text-muted">{s.data ? <>Runs use {s.data.model.label}.</> : <Skeleton className="h-4 w-64" />}</p>
    </Card>
  );
}

/** Admins: the model for every project, and what the agent did and cost this month across projects. */
function InstallSettings() {
  const admin = useFixAgentAdmin();
  const save = useSaveFixAgentAdmin();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { if (admin.data && !draft) setDraft(draftOf(admin.data)); }, [admin.data, draft]);

  if (admin.isPending) return <><Skeleton className="h-72" /><Skeleton className="h-48" /></>;
  if (admin.isError) {
    if (admin.error instanceof ApiError && admin.error.status === 403) return <ModelNote />;
    return <ErrorState error={admin.error} retry={() => admin.refetch()} />;
  }
  const d = admin.data;
  const x = draft ?? draftOf(d);
  const set = (p: Partial<Draft>) => setDraft({ ...x, ...p });
  const options = d.models.filter((m) => m.provider === x.provider);
  const keySaved = d.config.apiKey && !x.removeKey;
  const needsKey = x.provider === 'anthropic' && !keySaved && !x.apiKey.trim();
  const dirty = x.provider !== d.config.provider || x.modelId !== d.config.modelId || x.effort !== d.config.effort || !!x.apiKey.trim() || x.removeKey;
  const pickProvider = (p: FixProvider) => {
    if (p === x.provider) return;
    const same = d.models.find((m) => m.provider === p && m.modelId === d.config.modelId);
    set({ provider: p, modelId: p === d.config.provider ? d.config.modelId : (same ?? d.models.find((m) => m.provider === p)!).modelId, custom: false });
  };
  const submit = () => {
    const body: Partial<FixAgentConfigInput> = { provider: x.provider, modelId: x.modelId.trim(), effort: x.effort };
    if (x.apiKey.trim()) body.apiKey = x.apiKey.trim();
    else if (x.removeKey) body.apiKey = null;
    save.mutate(body, {
      onSuccess: (n) => { setDraft(draftOf(n)); toast({ title: 'GitHub Agent model saved', body: 'New runs in every project use it.', tone: 'good' }); },
      onError: (er) => toast({ title: 'Couldn’t save', body: (er as Error).message, tone: 'bad' }),
    });
  };

  const u = d.usage;
  return (
    <>
      <Card>
        <CardHeader title="Model, for every project" sub="What the GitHub Agent runs on in all projects. Runs already going finish on the model they started with." />
        <div className="space-y-5 px-4 pb-4">
          <div className="space-y-2">
            <Segmented<FixProvider> value={x.provider} onChange={pickProvider} options={[{ value: 'bedrock', label: 'Amazon Bedrock' }, { value: 'anthropic', label: 'Claude API, your own key' }]} />
            <p className="max-w-[720px] text-[12.5px] leading-relaxed text-muted">
              {x.provider === 'bedrock'
                ? <>Claude runs in this AWS account and is billed on your AWS bill, so the Costs page and budgets include it. Turn on <a className="text-accent hover:underline" href="https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html" target="_blank" rel="noreferrer">model access</a> for the model in Bedrock first.</>
                : <>Runs call Anthropic’s API with your key. Repository code and error details leave this AWS account, and the cost is billed to the key’s Anthropic account, so WGO’s budgets don’t see it (each run still shows an estimate). New models are available there first.</>}
            </p>
          </div>

          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-[11.5px] font-medium text-muted">Model</legend>
            {options.map((m) => (
              <label key={m.modelId} className="flex cursor-pointer items-start gap-3 rounded-lg border border-line px-3 py-2.5 hover:bg-[var(--hl)]">
                <input type="radio" name="fix-model" className="mt-1" checked={!x.custom && x.modelId === m.modelId} onChange={() => set({ modelId: m.modelId, custom: false })} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-3"><span className="text-[13px] font-medium">{m.label}</span>
                    {m.pricePerMTok && <span className="text-[11.5px] text-faint">${m.pricePerMTok[0]} / ${m.pricePerMTok[1]} per million tokens in / out</span>}</span>
                  <span className="block text-[12px] text-muted">{m.note}</span>
                </span>
              </label>
            ))}
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line px-3 py-2.5 hover:bg-[var(--hl)]">
              <input type="radio" name="fix-model" className="mt-1" checked={x.custom} onChange={() => set({ custom: true, modelId: x.custom ? x.modelId : '' })} />
              <span className="min-w-0 flex-1 space-y-1.5">
                <span className="block text-[13px] font-medium">Another model id</span>
                {x.custom && <input className="field font-mono text-[12px]" autoFocus value={x.modelId} placeholder={x.provider === 'bedrock' ? 'us.anthropic.claude-opus-5-5' : 'claude-opus-5-5'} onChange={(e) => set({ modelId: e.target.value })} />}
                <span className="block text-[12px] text-muted">{x.provider === 'bedrock' ? 'A Claude model or inference profile id in this account, e.g. a regional profile.' : 'Any Claude model your key can use.'}</span>
              </span>
            </label>
          </fieldset>

          <div className="space-y-1.5">
            <div className="text-[11.5px] font-medium text-muted">Effort</div>
            <Segmented<FixEffort> value={x.effort} onChange={(e) => set({ effort: e })} options={FIX_EFFORTS.map((e) => ({ value: e, label: e }))} />
            <p className="text-[12px] text-muted">{EFFORT_NOTE[x.effort]}</p>
          </div>

          {x.provider === 'anthropic' && (
            <Field label="Claude API key" hint="WGO checks it with Anthropic when you save. It’s kept in AWS Secrets Manager, readable only by the agent, and never shown again.">
              {keySaved && !x.apiKey ? (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-[var(--hl)] px-3 py-2 text-[12.5px]">
                  <KeyRound size={14} className="text-faint" />
                  <span className="font-mono">sk-ant-…{d.config.apiKey!.hint}</span>
                  <span className="text-faint">saved by {d.config.apiKey!.setBy} {relTime(d.config.apiKey!.setAt)}</span>
                  <span className="ml-auto flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => set({ apiKey: ' ' })}>Replace</Button>
                  </span>
                </div>
              ) : (
                <input className="field font-mono text-[12px]" type="password" autoComplete="off" placeholder="sk-ant-api03-…" value={x.apiKey.trim() ? x.apiKey : ''} onChange={(e) => set({ apiKey: e.target.value, removeKey: false })} />
              )}
            </Field>
          )}
          {x.provider === 'bedrock' && d.config.apiKey && (
            <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
              <KeyRound size={13} className="text-faint" />A Claude API key ending in {d.config.apiKey.hint} is still saved.
              <button className="cursor-pointer text-accent hover:underline" onClick={() => set({ removeKey: !x.removeKey })}>{x.removeKey ? 'Keep it' : 'Remove it'}</button>
              {x.removeKey && <span className="text-faint">It’s deleted when you save.</span>}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <span className="text-[12px] text-faint">{d.config.updatedBy ? `Changed by ${d.config.updatedBy} ${relTime(d.config.updatedAt!)}.` : 'The deploy settings’ default, until you save.'}</span>
            <Button variant="ghost" className="ml-auto" disabled={!dirty || save.isPending} onClick={() => setDraft(draftOf(d))}>Undo</Button>
            <Button variant="primary" disabled={!dirty || needsKey || (x.custom && !x.modelId.trim()) || save.isPending} onClick={submit}>{save.isPending && x.provider === 'anthropic' ? 'Checking…' : 'Save'}</Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="This month, all projects" sub={`Runs since ${new Date(u.since).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })} in every project; ${d.projectsOn === 1 ? '1 project has' : `${fmtNum(d.projectsOn)} projects have`} the agent on. Costs are estimates from list prices.`} />
        <div className="grid grid-cols-2 gap-3 px-4 pb-4 sm:grid-cols-4">
          {[['Runs', fmtNum(u.total.runs)], ['Pull requests', fmtNum(u.total.prsOpened)], ['Merged', fmtNum(u.total.prsMerged)], ['Cost', usd(u.total.costUsd)]].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-line bg-[var(--hl)] p-3"><div className="text-[11px] text-faint">{k}</div><div className="mt-0.5 text-[18px] font-semibold tnum">{v}</div></div>
          ))}
        </div>
        {u.projects.length > 0 ? (
          <div className="border-t border-line">
            <div className="grid grid-cols-[minmax(160px,1fr)_70px_110px_80px_90px_80px] gap-3 px-4 py-2 text-[11.5px] text-faint">
              <span>Project</span><span className="text-right">Runs</span><span className="text-right">Pull requests</span><span className="text-right">Merged</span><span className="text-right">Tokens</span><span className="text-right">Cost</span>
            </div>
            {u.projects.map((p) => (
              <div key={p.projectId ?? 'other'} className="grid grid-cols-[minmax(160px,1fr)_70px_110px_80px_90px_80px] gap-3 border-t border-line/60 px-4 py-2 text-[12.5px]">
                {p.projectId ? <a className="truncate hover:text-accent" href={`#/p/${p.projectId}/settings`}>{p.name}</a> : <span className="truncate text-muted">{p.name}</span>}
                <span className="text-right tnum">{fmtNum(p.runs)}</span><span className="text-right tnum">{fmtNum(p.prsOpened)}</span><span className="text-right tnum">{fmtNum(p.prsMerged)}</span>
                <span className="text-right tnum text-muted">{p.tokens >= 1e6 ? `${(p.tokens / 1e6).toFixed(1)}M` : `${Math.round(p.tokens / 1000)}k`}</span><span className="text-right tnum">{usd(p.costUsd)}</span>
              </div>
            ))}
          </div>
        ) : <p className="border-t border-line px-4 py-3 text-[12.5px] text-muted">No runs yet this month.</p>}
      </Card>

    </>
  );
}
