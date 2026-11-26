import { useEffect, useState } from 'react';
import { ExternalLink, KeyRound, ShieldCheck } from 'lucide-react';
import { useDeleteSlackApp, useFeatures, useFixAgentAdmin, useInstall, useMe, useSaveFixAgentAdmin, useSetMcp, useSetSlackApp } from '../api/hooks';
import { Button, Card, CardHeader, CopyButton, Field, Mono, Switch, useToast } from '../ui/kit';

/**
 * Install-wide switches for admins, each on the page of what it turns on: MCP (AI assistants page), the GitHub Agent
 * (GitHub Agent page) and the install's Slack app (Triggers page). They used to be deploy settings.
 */

const useIsAdmin = () => !!useMe().data?.admin;

/** AI assistants page: turn MCP on or off for everyone. */
export function McpSwitchCard() {
  const admin = useIsAdmin();
  const f = useFeatures();
  const set = useSetMcp();
  const toast = useToast();
  if (!admin) return null;
  const flip = (on: boolean) => set.mutate(on, {
    onSuccess: () => toast({ title: on ? 'MCP is on' : 'MCP is off', body: on ? 'AI assistants can connect now.' : 'Assistants can’t connect or register any more.', tone: 'good' }),
    onError: (er) => toast({ title: 'Couldn’t change MCP', body: (er as Error).message, tone: 'bad' }),
  });
  return (
    <Card>
      <CardHeader title="MCP for this WGO" sub="Only admins see this." right={<Switch checked={f.mcp} onChange={(v) => !set.isPending && flip(v)} label={<span className="text-[12.5px] text-fg">{set.isPending ? 'Changing…' : f.mcp ? 'On' : 'Off'}</span>} />} />
      <div className="flex gap-2.5 px-4 pb-4 text-[12.5px] leading-relaxed text-muted">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-accent" />
        <p>
          Turning it on serves the MCP server at <Mono>/mcp</Mono> and lets MCP clients register themselves with your Cognito user pool, so people can
          connect without an API key. People still sign in with their WGO account and only see their own projects, read-only. A client that tricks someone
          into signing in gets the same read access, so leave it off if nobody uses it.
        </p>
      </div>
    </Card>
  );
}

/** Triggers page: one Slack app for every project, so "Add to Slack" works without each project creating an app. */
export function SlackAppCard() {
  const admin = useIsAdmin();
  const install = useInstall(admin);
  const set = useSetSlackApp();
  const del = useDeleteSlackApp();
  const toast = useToast();
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const s = install.data?.slack;
  useEffect(() => { if (s?.clientId) setClientId(s.clientId); }, [s?.clientId]);
  if (!admin || !s) return null;
  const save = () => set.mutate({ clientId: clientId.trim(), ...(secret.trim() ? { clientSecret: secret.trim() } : {}) }, {
    onSuccess: () => { setSecret(''); toast({ title: 'Slack app saved', body: '“Add to Slack” now works in every project.', tone: 'good' }); },
    onError: (er) => toast({ title: 'Couldn’t save the Slack app', body: (er as Error).message, tone: 'bad' }),
  });
  const remove = () => del.mutate(undefined, {
    onSuccess: () => { setClientId(''); setSecret(''); toast({ title: 'Slack app removed', body: 'Projects connect Slack with a bot token again.', tone: 'good' }); },
  });
  const saved = !!s.clientId && s.secretSet;
  return (
    <Card>
      <CardHeader title="Slack app for every project" sub="Only admins see this. Without it, each project connects Slack by pasting a bot token, which takes about a minute." />
      <div className="space-y-3 px-4 pb-4 text-[12.5px] leading-relaxed text-muted">
        {s.fromEnv && <p>This WGO uses a Slack app from the <Mono>SLACK_CLIENT_ID</Mono> environment variable. Saving one here replaces it.</p>}
        {!saved && (
          <ol className="list-decimal space-y-1 pl-5">
            <li><a className="inline-flex items-center gap-1 text-accent hover:underline" href={s.createAppUrl} target="_blank" rel="noreferrer">Create the WGO Slack app<ExternalLink size={11} /></a> from the pre-filled manifest.</li>
            <li>Under <span className="text-fg">Manage Distribution</span>, activate public distribution, so other workspaces can install it.</li>
            <li>Copy the client ID and client secret from <span className="text-fg">Basic Information → App Credentials</span> into the fields below.</li>
          </ol>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Client ID"><input className="field font-mono text-[12px]" value={clientId} placeholder="1234567890.1234567890" onChange={(e) => setClientId(e.target.value)} /></Field>
          <Field label="Client secret" hint={saved ? 'Saved. Leave empty to keep it.' : 'Kept in AWS Secrets Manager.'}>
            <input className="field font-mono text-[12px]" type="password" autoComplete="off" value={secret} placeholder={saved ? '••••••••••••••••' : ''} onChange={(e) => setSecret(e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-faint"><KeyRound size={13} />Redirect URL <Mono className="text-muted">{s.redirectUrl}</Mono><CopyButton text={s.redirectUrl} /></span>
          <span className="ml-auto flex gap-2">
            {saved && <Button variant="ghost" disabled={del.isPending} onClick={remove}>Remove</Button>}
            <Button variant="primary" disabled={set.isPending || !clientId.trim() || (!saved && !secret.trim()) || (saved && clientId.trim() === s.clientId && !secret.trim())} onClick={save}>{set.isPending ? 'Checking…' : 'Save'}</Button>
          </span>
        </div>
      </div>
    </Card>
  );
}

/** GitHub Agent page: turn the agent on or off for the whole install. */
export function AgentSwitchCard() {
  const admin = useIsAdmin();
  const f = useFeatures();
  const a = useFixAgentAdmin(admin);
  const save = useSaveFixAgentAdmin();
  const toast = useToast();
  if (!admin) return null;
  const on = a.data?.enabled ?? f.fixAgent;
  const flip = (v: boolean) => save.mutate({ enabled: v }, {
    onSuccess: () => toast({ title: v ? 'GitHub Agent is on' : 'GitHub Agent is off', body: v ? 'Project owners can connect their repositories now.' : 'No new runs start, and members don’t see it.', tone: 'good' }),
    onError: (er) => toast({ title: 'Couldn’t change the GitHub Agent', body: (er as Error).message, tone: 'bad' }),
  });
  return (
    <Card>
      <CardHeader title="GitHub Agent for this WGO" sub="Only admins see this. Off: no runs start, and members don’t see the agent anywhere."
        right={<Switch checked={on} onChange={(v) => !save.isPending && flip(v)} label={<span className="text-[12.5px] text-fg">{on ? 'On' : 'Off'}</span>} />} />
      {!on && (
        <p className="px-4 pb-4 text-[12.5px] leading-relaxed text-muted">
          An AI agent that reads a project’s GitHub repository and opens draft pull requests fixing its errors. It runs on Claude, on Amazon Bedrock in this
          AWS account (turn on model access for the model first) or through the Claude API with your own key. Nothing runs until a project owner connects a repository.
        </p>
      )}
    </Card>
  );
}
