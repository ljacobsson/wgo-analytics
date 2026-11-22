import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Hash, Lock, Slack } from 'lucide-react';
import type { DestinationLevel, SlackChannel } from '../api/contract';
import { startSlackInstall, useAddSlackChannel, useSaveSlackApp, useSlackChannels, useSlackSetup } from '../api/hooks';
import { useProject } from '../lib/project';
import { Button, Dialog, Skeleton, useToast } from '../ui/kit';

/**
 * Slack on a self-hosted WGO: Slack ties every "Add to Slack" button to a Slack app, so the first time, someone
 * creates the WGO app (pre-filled; Slack only asks which workspace) and pastes its credentials (SlackAppSetup).
 * "Add to Slack" then connects a workspace, and channels are picked from a list (SlackChannelDialog), as often as
 * you like, without going back to Slack.
 */

/** Go to Slack's consent screen to connect a workspace, for the project or (`account`) for the user's own channels. */
function useConnectWorkspace(level: DestinationLevel) {
  const { project } = useProject();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reset = () => { setBusy(false); setError(''); };
  // Back from Slack's consent screen restores this page from the back/forward cache, still busy
  useEffect(() => {
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);
  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      await startSlackInstall(project.id, level);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return { connect, busy, error, reset };
}

/** Add a Slack channel as a destination: pick a connected workspace (or connect one), then a channel. */
export function SlackChannelDialog({ level, onClose }: { level: DestinationLevel | null; onClose: () => void }) {
  const { project } = useProject();
  const setup = useSlackSetup(project.id);
  const open = level !== null;
  const workspaces = useMemo(() => setup.data?.workspaces.filter((w) => w.level === level) ?? [], [setup.data, level]);
  const [wid, setWid] = useState<string | null>(null);
  const [find, setFind] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setFind(''); setError(''); reset();
    setWid((cur) => (workspaces.some((w) => w.id === cur) ? cur : workspaces[0]?.id ?? null));
  }, [open, workspaces]);
  const channels = useSlackChannels(project.id, open ? wid : null);
  const add = useAddSlackChannel(project.id);
  const toast = useToast();
  const { connect, busy, error: connectError, reset } = useConnectWorkspace(level ?? 'project');
  const configured = !!setup.data?.configured;

  const shown = useMemo(() => {
    const q = find.trim().replace(/^#/, '').toLowerCase();
    return (channels.data ?? []).filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [channels.data, find]);
  const pick = async (c: SlackChannel) => {
    setError('');
    try {
      const d = await add.mutateAsync({ workspaceId: wid!, channelId: c.id });
      toast({ title: `${d.name} added`, body: 'Pick it as the destination of any trigger.', tone: 'good' });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const title = level === 'account' ? 'Add a Slack channel of your own' : 'Add a Slack channel to this project';
  if (setup.isPending) return <Dialog open={open} onClose={onClose} title={title}><Skeleton className="h-24" /></Dialog>;
  if (!workspaces.length) {
    return (
      <Dialog open={open} onClose={onClose} title={title} width={configured ? 460 : 560}
        footer={configured ? <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => void connect()}><Slack size={14} />Connect Slack</Button></> : undefined}>
        {configured ? (
          <div className="space-y-2 text-[12.5px] text-muted">
            <p>
              First connect a Slack workspace{level === 'account' ? ' for your own channels' : ' for this project'}. Slack asks which
              workspace to add WGO to; back here, you pick channels from a list, as many as you like.
            </p>
            {connectError && <p className="text-bad">{connectError}</p>}
          </div>
        ) : <SlackAppSetup />}
      </Dialog>
    );
  }
  return (
    <Dialog open={open} onClose={onClose} title={title} width={500}
      footer={<>
        {configured && <Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => void connect()}><Slack size={14} />Another workspace</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </>}>
      <div className="space-y-3 text-[12.5px]">
        {workspaces.length > 1 && (
          <select className="field" value={wid ?? ''} onChange={(e) => setWid(e.target.value)}>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.teamName ?? 'Slack workspace'}</option>)}
          </select>
        )}
        <input autoFocus className="field" placeholder={`Find a channel${workspaces.length === 1 && workspaces[0].teamName ? ` in ${workspaces[0].teamName}` : ''}`} value={find} onChange={(e) => setFind(e.target.value)} />
        <div className="max-h-72 overflow-y-auto rounded-lg border border-line">
          {channels.isPending ? <div className="space-y-1.5 p-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-7" />)}</div>
            : channels.isError ? <p className="p-3 text-bad">{(channels.error as Error).message}</p>
            : shown.length ? shown.map((c) => (
              <button key={c.id} disabled={add.isPending} onClick={() => void pick(c)}
                className="flex w-full items-center gap-2 border-t border-line/60 px-3 py-1.5 text-left first:border-t-0 hover:bg-[var(--hl)] cursor-pointer disabled:cursor-wait">
                {c.private ? <Lock size={12} className="text-faint" /> : <Hash size={12} className="text-faint" />}
                <span>{c.name.replace(/^#/, '')}</span>
              </button>
            ))
            : <p className="p-3 text-faint">{find.trim() ? 'No channel matches.' : 'No channels.'}</p>}
        </div>
        {(error || connectError) && <p className="text-bad">{error || connectError}</p>}
        <p className="text-[11.5px] text-faint">A private channel shows up here once WGO is in it: type <span className="font-mono">/invite @WGO</span> in that channel.</p>
      </div>
    </Dialog>
  );
}

/** Create the WGO Slack app on Slack and save its credentials: as your own, or (owners) for this project. */
export function SlackAppSetup({ onDone }: { onDone?: () => void }) {
  const { project } = useProject();
  const setup = useSlackSetup(project.id);
  const save = useSaveSlackApp(project.id);
  const owner = project.role === 'owner';
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [where, setWhere] = useState<DestinationLevel>('account');
  const [error, setError] = useState('');

  const saveCreds = async () => {
    setError('');
    try {
      await save.mutateAsync({ clientId, clientSecret, level: owner ? where : 'account' });
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const step = 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[11px] font-semibold text-accent';
  if (!setup.data) return <Skeleton className="h-40" />;
  return (
    <div className="space-y-3 rounded-lg border border-line bg-[var(--hl)] p-3.5 text-[12.5px]">
      <p className="text-muted">
        One-time setup. Slack connects “Add to Slack” to an app, so WGO needs its own. One app works for all your
        projects: set it up once, then connect a workspace and pick its channels anywhere.
      </p>
      <div className="flex gap-2.5">
        <span className={step}>1</span>
        <div className="space-y-1.5">
          <a href={setup.data.createAppUrl} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-[var(--raised)] px-3 py-1.5 font-medium hover:border-[var(--line-strong)]">
            <Slack size={13} />Create the WGO Slack app<ExternalLink size={12} className="text-faint" />
          </a>
          <p className="text-faint">Everything is pre-filled. Slack asks which workspace to create it in. Pick yours and click Create.</p>
        </div>
      </div>
      <div className="flex gap-2.5">
        <span className={step}>2</span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-muted">On the app’s <b>Basic Information</b> page, copy the <b>Client ID</b> and <b>Client Secret</b> (click Show) here:</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input className="field font-mono !text-[12px]" placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />
            <input className="field font-mono !text-[12px]" placeholder="Client Secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
          </div>
          {error && <p className="text-bad">{error}</p>}
        </div>
      </div>
      <div className="flex gap-2.5">
        <span className={step}>3</span>
        <div className="min-w-0 flex-1 space-y-2">
          {owner && (
            <div className="space-y-1">
              <label className="flex cursor-pointer items-start gap-2">
                <input type="radio" className="mt-0.5" checked={where === 'account'} onChange={() => setWhere('account')} />
                <span><b>For me, in all my projects.</b> <span className="text-faint">Only you use it, in every project you’re a member of that has no app of its own.</span></span>
              </label>
              <label className="flex cursor-pointer items-start gap-2">
                <input type="radio" className="mt-0.5" checked={where === 'project'} onChange={() => setWhere('project')} />
                <span><b>For everyone in {project.name}.</b> <span className="text-faint">Any member can connect channels with it here.</span></span>
              </label>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2.5">
            <Button variant="primary" size="sm" disabled={!clientId.trim() || !clientSecret.trim() || save.isPending} onClick={() => void saveCreds()}>
              {save.isPending ? 'Checking with Slack…' : 'Save'}
            </Button>
            <span className="text-faint">
              {owner ? 'Then' : 'It’s saved as your own app, for all your projects. Then'} connect your Slack workspace and pick channels from a list.
            </span>
          </div>
        </div>
      </div>
      <p className="border-t border-line pt-2.5 text-[11.5px] text-faint">
        Want channels in more than one Slack workspace? In the app’s settings, turn on <b>Manage Distribution</b>.
      </p>
    </div>
  );
}
