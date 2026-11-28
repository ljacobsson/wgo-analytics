import { useState } from 'react';
import { Database, Eye, EyeOff, KeyRound, RotateCw, Trash2, UserPlus } from 'lucide-react';
import { useDeleteProject, useInviteMember, useMembers, useRemoveMember, useRenameProject, useRotateKey, useRotateUploadKey, useSetDevTraffic, useSetRetention, useUploadKey } from '../api/hooks';
import type { Project } from '../api/contract';
import { useProject } from '../lib/project';
import { Badge, Button, Card, CardHeader, CopyButton, Dialog, Skeleton, useToast } from '../ui/kit';
import { Install } from './Install';
import { relTime } from '../lib/format';

export function SettingsPage() {
  const { project, email } = useProject();
  const toast = useToast();
  const owner = project.role === 'owner';
  const [name, setName] = useState(project.name);
  const rename = useRenameProject(project.id);
  const rotate = useRotateKey(project.id);
  const members = useMembers(project.id);
  const invite = useInviteMember(project.id);
  const remove = useRemoveMember(project.id);
  const [reveal, setReveal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [inv, setInv] = useState('');
  const key = project.writeKey;
  return (
    <div className="mx-auto max-w-[920px] space-y-4">
      <Card>
        <CardHeader title="General" sub="Project name shown in the switcher" />
        <form className="flex gap-3 px-4 pb-4" onSubmit={(e) => { e.preventDefault(); if (name.trim() && name !== project.name) rename.mutate(name.trim(), { onSuccess: () => toast({ title: 'Project renamed', tone: 'good' }) }); }}>
          <input className="field" disabled={!owner} value={name} onChange={(e) => setName(e.target.value)} />
          <Button variant="primary" disabled={!owner || !name.trim() || name === project.name || rename.isPending}>Save</Button>
        </form>
        <div className="border-t border-line px-4 py-3 text-[12px] text-faint">Project ID <span className="ml-1 font-mono text-muted">{project.id}</span>{!owner && <span className="ml-3">Only owners can change settings.</span>}</div>
      </Card>

      <RetentionCard project={project} owner={owner} />

      <DevTrafficCard project={project} owner={owner} />

      <Card>
        <CardHeader title="Write key" sub="Public key used by the SDK and OpenTelemetry exporters. Safe to ship in client code." />
        <div className="flex flex-wrap items-center gap-3 px-4 pb-4">
          <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-line bg-[var(--hl)] px-3 py-2"><KeyRound size={14} className="text-faint" /><code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{reveal ? key : key.slice(0, 6) + '•'.repeat(Math.max(8, key.length - 10)) + key.slice(-4)}</code>
            <button onClick={() => setReveal(!reveal)} className="text-faint hover:text-fg cursor-pointer">{reveal ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>
          <CopyButton text={key} className="!py-2" />
          {owner && <Button variant="danger" onClick={() => setConfirm(true)}><RotateCw size={14} />Rotate key</Button>}
        </div>
      </Card>

      {owner && <SourceMapsCard pid={project.id} />}

      <Card>
        <CardHeader title="Members" sub={<>Invited people get access the next time they sign in with that email. New users create an account at <span className="font-mono">{location.origin + location.pathname}#/signup</span>.</>} />
        {owner && <form className="flex gap-3 px-4 pb-3" onSubmit={(e) => { e.preventDefault(); const v = inv.trim(); if (v) { invite.mutate(v, { onError: (er) => toast({ title: 'Invite failed', body: (er as Error).message, tone: 'bad' }) }); setInv(''); } }}>
          <input className="field" type="email" placeholder="teammate@company.com" value={inv} onChange={(e) => setInv(e.target.value)} /><Button variant="primary" disabled={!inv.trim()}><UserPlus size={14} />Invite</Button></form>}
        <div className="divide-y divide-line/60 border-t border-line">
          {members.isPending ? <div className="space-y-2 p-4"><Skeleton className="h-8" /><Skeleton className="h-8" /></div> : members.data?.map((m) => (
            <div key={m.email} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--line-strong)] text-[11px] font-semibold">{m.email.slice(0, 1).toUpperCase()}</span>
              <span className="flex-1 truncate">{m.email}{m.email === email && <span className="ml-2 text-faint">(you)</span>}</span>
              <span className="text-[12px] text-faint">{relTime(m.createdAt)}</span><Badge tone={m.role === 'owner' ? 'accent' : 'neutral'}>{m.role}</Badge>
              {owner && m.role !== 'owner' ? <button onClick={() => remove.mutate(m.email, { onError: (er) => toast({ title: 'Could not remove', body: (er as Error).message, tone: 'bad' }) })} className="rounded-md p-1.5 text-faint hover:bg-bad/15 hover:text-bad cursor-pointer" title="Remove"><Trash2 size={14} /></button> : <span className="w-7" />}
            </div>))}
        </div>
      </Card>

      <Card id="install">
        <CardHeader title="Install" sub="Ready-to-paste snippets with your write key filled in." />
        <div className="px-4 pb-4"><Install project={project} /></div>
      </Card>

      {owner && <DeleteProjectCard project={project} />}

      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Rotate write key?"
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" disabled={rotate.isPending} onClick={() => rotate.mutate(undefined, { onSuccess: () => { setConfirm(false); toast({ title: 'Write key rotated', body: 'Update your snippets and exporters.', tone: 'good' }); } })}>Rotate key</Button></>}>
        <p className="text-[13px] text-muted">The current key stops working immediately. Any site or service still using it will stop sending data until you deploy the new key.</p>
      </Dialog>
    </div>
  );
}

const RETENTION_CHOICES = [1, 3, 7, 14, 30, 60, 90, 180, 365];

function RetentionCard({ project, owner }: { project: Project; owner: boolean }) {
  const toast = useToast();
  const save = useSetRetention(project.id);
  const { days, defaultDays, maxDays } = project.retention;
  const [value, setValue] = useState(days);
  const choices = [...new Set([...RETENTION_CHOICES.filter((d) => d <= maxDays), days, maxDays])].sort((a, b) => a - b);
  const label = (d: number) => `${d} day${d === 1 ? '' : 's'}${d === defaultDays ? ' (default)' : ''}`;
  return (
    <Card>
      <CardHeader title="Data retention" sub="How long raw events, logs, traces and metric points are kept" />
      <form className="flex gap-3 px-4 pb-3" onSubmit={(e) => { e.preventDefault(); save.mutate(value, { onSuccess: () => toast({ title: `Raw data is now kept for ${label(value).replace(' (default)', '')}`, tone: 'good' }), onError: (er) => toast({ title: 'Could not change retention', body: (er as Error).message, tone: 'bad' }) }); }}>
        <select className="field !w-56" disabled={!owner} value={value} onChange={(e) => setValue(Number(e.target.value))}>
          {choices.map((d) => <option key={d} value={d}>{label(d)}</option>)}
        </select>
        <Button variant="primary" disabled={!owner || value === days || save.isPending}>Save</Button>
      </form>
      <div className="space-y-2 px-4 pb-4 text-[12.5px] leading-relaxed text-muted">
        <p>Raw data older than this is deleted once a day, a whole day at a time. The Overview (KPIs, the events chart, top pages and breakdowns) keeps working for longer ranges: it reads hourly aggregates that are kept for 13 months. Clicks, errors, the map, events, logs, traces and metrics only go back as far as the raw data.</p>
        <div className="flex gap-2.5 rounded-lg border border-line bg-[var(--hl)] px-3 py-2.5">
          <Database size={15} className="mt-0.5 shrink-0 text-accent" />
          <p><span className="font-medium text-fg">Raw data is stored as compressed Parquet files in S3, in your AWS account.</span> What you store grows with your traffic times this setting, but at S3 prices a long retention stays cheap; queries read only the days they cover. Your deployment allows up to {maxDays} days (the stack's <code className="font-mono text-[11.5px]">MaxRetentionDays</code> parameter).</p>
        </div>
      </div>
    </Card>
  );
}

const hostLines = (text: string) => text.split(/[\n,]/).map((h) => h.trim()).filter(Boolean);

function DevTrafficCard({ project, owner }: { project: Project; owner: boolean }) {
  const toast = useToast();
  const save = useSetDevTraffic(project.id);
  const saved = project.devTraffic.hosts;
  const [hosts, setHosts] = useState(saved.join('\n'));
  const changed = hostLines(hosts).join('\n') !== saved.join('\n');
  const submit = () => save.mutate({ hosts: hostLines(hosts) }, {
    // show the hosts as stored (pasted URLs reduced to host names), unless they were edited while saving
    onSuccess: (p) => { setHosts((cur) => (cur === hosts ? p.devTraffic.hosts.join('\n') : cur)); toast({ title: 'Development hosts saved', body: 'New events from them count as development traffic within a minute.', tone: 'good' }); },
    onError: (er) => toast({ title: 'Could not save', body: (er as Error).message, tone: 'bad' }),
  });
  return (
    <Card>
      <CardHeader title="Development hosts" sub="Traffic from these hosts is left out of the numbers, like bots, unless you include development traffic in the filter bar" />
      <form className="space-y-3 px-4 pb-4" onSubmit={(e) => { e.preventDefault(); if (owner && changed) submit(); }}>
        <p className="text-[12.5px] leading-relaxed text-muted">Always included: <span className="font-mono text-[11.5px]">localhost</span>, <span className="font-mono text-[11.5px]">127.0.0.1</span> and other loopback, private-network and link-local addresses, names without a dot, local-only domains such as <span className="font-mono text-[11.5px]">.local</span> and <span className="font-mono text-[11.5px]">.internal</span>, and pages opened from disk. Add staging sites, preview deployments or a local domain like <span className="font-mono text-[11.5px]">*.test</span> here.</p>
        <textarea className="field min-h-[84px] font-mono text-[12.5px]" disabled={!owner} value={hosts} onChange={(e) => setHosts(e.target.value)}
          placeholder={'*.vercel.app\nstaging.example.com'} spellCheck={false} aria-label="Development hosts" />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={!owner || !changed || save.isPending}>Save</Button>
          <p className="min-w-[240px] flex-1 text-[12px] leading-relaxed text-faint">One per line, * as a wildcard. Applies to events that arrive after saving; mobile app events are never development traffic.</p>
        </div>
      </form>
    </Card>
  );
}

function DeleteProjectCard({ project }: { project: Project }) {
  const toast = useToast();
  const del = useDeleteProject(project.id);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === project.name.trim();
  const close = () => { setOpen(false); setTyped(''); };
  const submit = () => {
    if (!matches || del.isPending) return;
    del.mutate(undefined, {
      onSuccess: () => toast({ title: `Deleted ${project.name}`, tone: 'good' }),
      onError: (er) => toast({ title: 'Could not delete the project', body: (er as Error).message, tone: 'bad' }),
    });
  };
  return (
    <Card>
      <CardHeader title="Delete project" sub="Removes the project and everything it has collected" />
      <div className="flex flex-wrap items-center gap-3 px-4 pb-4">
        <p className="min-w-[260px] flex-1 text-[12.5px] leading-relaxed text-muted">Members lose access, the write key stops working, and kiosks, triggers and Slack connections stop at once. Events, logs, traces, metrics and recordings are deleted from the database and S3 over the next few minutes. This can't be undone.</p>
        <Button variant="danger" onClick={() => setOpen(true)}><Trash2 size={14} />Delete project</Button>
      </div>
      <Dialog open={open} onClose={close} title={`Delete ${project.name}?`}
        footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="danger" disabled={!matches || del.isPending} onClick={submit}><Trash2 size={14} />Delete project</Button></>}>
        <form className="space-y-3 text-[13px] text-muted" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <p>All of this project's data, settings and members are deleted for good. Sites and services still sending to its write key are refused.</p>
          <label className="block space-y-1.5">
            <span>Type <span className="font-medium text-fg">{project.name}</span> to confirm</span>
            <input className="field" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Project name" />
          </label>
        </form>
      </Dialog>
    </Card>
  );
}

function SourceMapsCard({ pid }: { pid: string }) {
  const toast = useToast();
  const uk = useUploadKey(pid, true);
  const rotate = useRotateUploadKey(pid);
  const [reveal, setReveal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const key = uk.data?.uploadKey;
  const cmd = `npx wgo-sourcemaps --endpoint ${location.origin} --key ${key ?? 'uk_…'} --release 1.4.0 dist/`;
  return (
    <Card>
      <CardHeader title="Source maps" sub="Upload source maps from your build so error stacks show your original code. The upload key is a secret: keep it in CI, not in client code." />
      <div className="flex flex-wrap items-center gap-3 px-4 pb-3">
        <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-line bg-[var(--hl)] px-3 py-2"><KeyRound size={14} className="text-faint" />
          {key ? <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{reveal ? key : key.slice(0, 6) + '•'.repeat(Math.max(8, key.length - 10)) + key.slice(-4)}</code> : <Skeleton className="h-4 flex-1" />}
          <button onClick={() => setReveal(!reveal)} className="text-faint hover:text-fg cursor-pointer">{reveal ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>
        {key && <CopyButton text={key} className="!py-2" />}
        <Button variant="danger" onClick={() => setConfirm(true)}><RotateCw size={14} />Rotate key</Button>
      </div>
      <div className="space-y-3 px-4 pb-4 text-[12.5px] leading-relaxed text-muted">
        <p>Build with hidden source maps, then upload them after each deploy. Use the same <span className="font-mono text-[11.5px]">release</span> you pass to <span className="font-mono text-[11.5px]">wgo.init</span>.</p>
        <div className="flex items-center gap-2 rounded-lg border border-line bg-[var(--hl)] px-3 py-2"><code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11.5px]">{cmd}</code><CopyButton text={cmd} /></div>
        <p>Vite: <span className="font-mono text-[11.5px]">build: {'{ sourcemap: \'hidden\' }'}</span>. webpack: <span className="font-mono text-[11.5px]">devtool: 'hidden-source-map'</span>.</p>
        <p>Don't deploy the <span className="font-mono text-[11.5px]">.map</span> files to your site. Anyone could read your source from them. Delete them after uploading.</p>
      </div>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Rotate upload key?"
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" disabled={rotate.isPending} onClick={() => rotate.mutate(undefined, { onSuccess: () => { setConfirm(false); toast({ title: 'Upload key rotated', body: 'Update the key in your CI.', tone: 'good' }); } })}>Rotate key</Button></>}>
        <p className="text-[13px] text-muted">The current key stops working immediately. Update it in your CI before the next upload.</p>
      </Dialog>
    </Card>
  );
}
