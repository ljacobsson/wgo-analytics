import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Hash, Lock, Slack } from 'lucide-react';
import type { DestinationLevel, SlackChannel, SlackWorkspace } from '../api/contract';
import { startSlackInstall, useAddSlackChannel, useConnectSlackToken, useSlackChannels, useSlackSetup } from '../api/hooks';
import { useProject } from '../lib/project';
import { Button, Dialog, Skeleton, useToast } from '../ui/kit';

/**
 * Slack channels are picked from a list of a connected workspace (SlackChannelDialog), as often as you like, without
 * going back to Slack. A workspace is connected once: with the bot token of a WGO Slack app you create from a
 * pre-filled manifest (SlackTokenSetup), or, when the instance has a Slack app of its own, with "Add to Slack".
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
  const [another, setAnother] = useState(false); // connecting another workspace with a token
  useEffect(() => {
    if (!open) return;
    setFind(''); setError(''); reset();
    setWid((cur) => (workspaces.some((w) => w.id === cur) ? cur : workspaces[0]?.id ?? null));
  }, [open, workspaces]);
  useEffect(() => { if (!open) setAnother(false); }, [open]);
  const channels = useSlackChannels(project.id, open ? wid : null);
  const add = useAddSlackChannel(project.id);
  const toast = useToast();
  const { connect, busy, error: connectError, reset } = useConnectWorkspace(level ?? 'project');
  const addToSlack = !!setup.data?.addToSlack;
  const connected = (w: SlackWorkspace) => { setWid(w.id); setAnother(false); };

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
  if (!workspaces.length && addToSlack) {
    return (
      <Dialog open={open} onClose={onClose} title={title} width={460}
        footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => void connect()}><Slack size={14} />Connect Slack</Button></>}>
        <div className="space-y-2 text-[12.5px] text-muted">
          <p>
            First connect a Slack workspace{level === 'account' ? ' for your own channels' : ' for this project'}. Slack asks which
            workspace to add WGO to; back here, you pick channels from a list, as many as you like.
          </p>
          {connectError && <p className="text-bad">{connectError}</p>}
        </div>
      </Dialog>
    );
  }
  if (!workspaces.length || another) {
    return (
      <Dialog open={open} onClose={onClose} title={workspaces.length ? 'Connect another Slack workspace' : title} width={580}
        footer={workspaces.length ? <Button variant="ghost" onClick={() => setAnother(false)}>Back to channels</Button> : <Button variant="ghost" onClick={onClose}>Cancel</Button>}>
        <SlackTokenSetup level={level ?? 'project'} onConnected={connected} />
      </Dialog>
    );
  }
  return (
    <Dialog open={open} onClose={onClose} title={title} width={500}
      footer={<>
        <Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => (addToSlack ? void connect() : setAnother(true))}><Slack size={14} />Another workspace</Button>
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

/**
 * Connect a workspace with the bot token of a WGO Slack app: created from a pre-filled manifest, installed from its
 * own page. The token field is plain text with password managers told to leave it alone: a password field makes
 * browsers treat the form as a login and fill in your WGO credentials.
 */
export function SlackTokenSetup({ level, onConnected }: { level: DestinationLevel; onConnected: (w: SlackWorkspace) => void }) {
  const { project } = useProject();
  const setup = useSlackSetup(project.id);
  const save = useConnectSlackToken(project.id);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    try {
      onConnected(await save.mutateAsync({ token: token.trim(), level }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const step = 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[11px] font-semibold text-accent';
  if (!setup.data) return <Skeleton className="h-40" />;
  return (
    <div className="space-y-3 text-[12.5px]">
      <p className="text-muted">
        WGO posts to Slack as an app of yours. Create it once per Slack workspace, then pick channels from a list here,
        as many as you like. {level === 'account' ? 'The workspace is yours: only you add its channels, in any of your projects.' : `Any member of ${project.name} can add its channels.`}
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
        <p className="text-muted">In the app, open <b>OAuth &amp; Permissions</b>, click <b>Install to</b> your workspace, then <b>Allow</b>.</p>
      </div>
      <div className="flex gap-2.5">
        <span className={step}>3</span>
        <form className="min-w-0 flex-1 space-y-1.5" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (token.trim() && !save.isPending) void submit(); }}>
          <p className="text-muted">Copy the <b>Bot User OAuth Token</b> on that page and paste it here:</p>
          <div className="flex gap-2">
            <input className="field min-w-0 flex-1 font-mono !text-[12px]" placeholder="xoxb-…" type="text" name="slack-bot-token" autoComplete="off"
              spellCheck={false} data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"
              value={token} onChange={(e) => setToken(e.target.value)} />
            <Button variant="primary" size="sm" type="submit" disabled={!token.trim() || save.isPending}>{save.isPending ? 'Checking with Slack…' : 'Connect'}</Button>
          </div>
          {error && <p className="text-bad">{error}</p>}
        </form>
      </div>
    </div>
  );
}
