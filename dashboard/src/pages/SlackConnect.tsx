import { useState } from 'react';
import { ExternalLink, Slack } from 'lucide-react';
import { startSlackInstall, useSaveSlackApp, useSlackSetup } from '../api/hooks';
import { useProject } from '../lib/project';
import { Button, Skeleton } from '../ui/kit';

/**
 * "Add to Slack", plus the one-time setup it needs on a self-hosted WGO: Slack ties every "Add to Slack" button
 * to a Slack app, so the first time, an owner creates the WGO app (pre-filled; Slack only asks which workspace)
 * and pastes its credentials here. After that it's one click for everyone in the project.
 */
export function SlackConnect({ compact, label = 'Add to Slack' }: { compact?: boolean; label?: string }) {
  const { project } = useProject();
  const setup = useSlackSetup(project.id);
  const save = useSaveSlackApp(project.id);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      await startSlackInstall(project.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (setup.isPending) return <Skeleton className="h-9 w-36" />;
  if (setup.data?.configured) {
    return (
      <span className="inline-flex flex-col items-end gap-1">
        <Button variant="primary" size={compact ? 'sm' : 'md'} disabled={busy} onClick={() => void add()}><Slack size={14} />{label}</Button>
        {error && <span className="text-[11.5px] text-bad">{error}</span>}
      </span>
    );
  }
  if (project.role !== 'owner') {
    return <p className="text-[12.5px] text-muted">Slack isn’t set up for this project yet. A project owner can do it in about a minute, here on the Triggers page.</p>;
  }

  const saveCreds = async () => {
    setError('');
    try {
      await save.mutateAsync({ clientId, clientSecret });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const step = 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[11px] font-semibold text-accent';
  return (
    <div className="space-y-3 rounded-lg border border-line bg-[var(--hl)] p-3.5 text-[12.5px]">
      <p className="text-muted">
        One-time setup for this project. Slack connects “Add to Slack” to an app, so WGO needs its own. After this,
        anyone here connects a channel with one click.
      </p>
      <div className="flex gap-2.5">
        <span className={step}>1</span>
        <div className="space-y-1.5">
          <a href={setup.data!.createAppUrl} target="_blank" rel="noreferrer"
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
      <div className="flex items-center gap-2.5">
        <span className={step}>3</span>
        <Button variant="primary" size="sm" disabled={!clientId.trim() || !clientSecret.trim() || save.isPending} onClick={() => void saveCreds()}>
          {save.isPending ? 'Checking with Slack…' : 'Save'}
        </Button>
        <span className="text-faint">Then <b>Add to Slack</b> appears: pick the workspace and channel, and you’re done.</span>
      </div>
      <p className="border-t border-line pt-2.5 text-[11.5px] text-faint">
        Want channels in more than one Slack workspace? In the app’s settings, turn on <b>Manage Distribution</b>.
      </p>
    </div>
  );
}
