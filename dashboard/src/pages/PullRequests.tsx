import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react';
import type { FixRun, PrState } from '../api/contract';
import { useFeatures, usePullRequests } from '../api/hooks';
import { relTime } from '../lib/format';
import { lastSeen, markSeen, openedAt, useLastSeen } from '../lib/prSeen';
import { useProject } from '../lib/project';
import { Card, EmptyState, ErrorState, Segmented, Skeleton } from '../ui/kit';
import { runHref } from './FixAgent';

/** The pull requests the GitHub Agent opened in this project. Opening the page marks them as seen. */

type Filter = 'all' | PrState;

const STATE: Record<PrState, { icon: typeof GitPullRequest; color: string; label: string }> = {
  open: { icon: GitPullRequest, color: 'text-accent', label: 'Open' },
  merged: { icon: GitMerge, color: 'text-good', label: 'Merged' },
  closed: { icon: GitPullRequestClosed, color: 'text-faint', label: 'Closed' },
};

const usd = (n: number | null) => (n === null ? '' : n < 0.01 ? '< $0.01' : `$${n.toFixed(2)}`);
const kind = (r: FixRun) => (r.kind === 'span' ? 'failed span' : r.kind === 'log' ? 'error log' : 'JavaScript error');

/** The menu's count: pull requests opened since the page was last opened. */
export function PullRequestCount({ collapsed }: { collapsed: boolean }) {
  const { project } = useProject();
  const on = useFeatures().fixAgent;
  const prs = usePullRequests(project.id, on);
  const seen = useLastSeen(project.id);
  const n = (prs.data ?? []).filter((r) => !seen || openedAt(r) > seen).length;
  if (!n) return null;
  const label = `${n} new pull request${n === 1 ? '' : 's'}`;
  if (collapsed) return <i className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent" aria-label={label} title={label} />;
  return <span className="ml-auto min-w-[18px] rounded-full bg-accent px-1.5 text-center text-[10.5px] font-semibold leading-[18px] text-white tnum" title={label}>{n > 99 ? '99+' : n}</span>;
}

export function PullRequestsPage() {
  const { project } = useProject();
  const on = useFeatures().fixAgent;
  const prs = usePullRequests(project.id, on);
  const [filter, setFilter] = useState<Filter>('all');
  // what counted as new when the page opened stays marked during this visit
  const [seenBefore] = useState(() => lastSeen(project.id));
  useEffect(() => { if (prs.data) markSeen(project.id); }, [prs.data, project.id]);

  const all = prs.data ?? [];
  const counts = useMemo(() => ({
    all: all.length,
    open: all.filter((r) => r.prState === 'open').length,
    merged: all.filter((r) => r.prState === 'merged').length,
    closed: all.filter((r) => r.prState === 'closed').length,
  }), [all]);
  const shown = filter === 'all' ? all : all.filter((r) => r.prState === filter);

  if (!on) {
    return <Card><EmptyState icon={<GitPullRequest size={22} />} title="The GitHub Agent is off">Its pull requests show up here once an admin turns it on on the <a className="text-accent hover:underline" href={`#/p/${project.id}/fix-agent`}>GitHub Agent page</a>.</EmptyState></Card>;
  }
  if (prs.isError) return <ErrorState error={prs.error} retry={() => prs.refetch()} />;

  return (
    <div className="mx-auto max-w-[1100px] space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<Filter> value={filter} onChange={setFilter} options={(['all', 'open', 'merged', 'closed'] as const).map((f) => ({ value: f, label: `${f === 'all' ? 'All' : STATE[f].label} ${counts[f]}` }))} />
        <span className="ml-auto text-[12px] text-faint">Pull requests the GitHub Agent opened in {project.name}. States are checked with GitHub every few minutes.</span>
      </div>
      <Card className="overflow-hidden">
        {prs.isPending ? <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          : !shown.length ? (
            <EmptyState icon={<GitPullRequest size={22} />} title={all.length ? `No ${filter} pull requests` : 'No pull requests yet'}>
              {all.length ? 'Try another filter.' : <>When the agent finds a fix for an error, its draft pull request shows up here. Start one with <span className="text-fg">Fix with agent</span> on an error, a failed span or an error log.</>}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line/60">
              {shown.map((r) => {
                const st = STATE[r.prState ?? 'open'];
                const Icon = st.icon;
                const isNew = !seenBefore || openedAt(r) > seenBefore;
                return (
                  <li key={r.runId} className="flex items-start gap-3 px-4 py-3 text-[13px]">
                    <Icon size={16} className={`mt-0.5 shrink-0 ${st.color}`} aria-label={st.label} />
                    <div className="min-w-0 flex-1">
                      <a href={r.prUrl ?? '#'} target="_blank" rel="noreferrer" className="group inline-flex max-w-full items-center gap-1.5 font-medium hover:text-accent">
                        {isNew && <i className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="New since your last visit" title="New since your last visit" />}
                        <span className="truncate">{r.result?.prTitle ?? r.message ?? `Fix for ${r.fingerprint}`}</span>
                        <ExternalLink size={11} className="shrink-0 text-faint group-hover:text-accent" />
                      </a>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-faint">
                        <span>#{r.prNumber} in <span className="font-mono text-[11.5px] text-muted">{r.repo}</span></span>
                        <span>·</span>
                        <span>{st.label.toLowerCase()}, opened {relTime(openedAt(r))} {r.trigger === 'auto' ? 'automatically' : `for ${r.requestedBy ?? 'someone'}`}</span>
                      </div>
                      {r.result?.rootCause && <p className="mt-1 line-clamp-2 text-[12.5px] text-muted">{r.result.rootCause}</p>}
                    </div>
                    <div className="hidden shrink-0 flex-col items-end gap-0.5 text-right text-[12px] sm:flex">
                      <a className="text-accent hover:underline" href={runHref(project.id, r)}>View {kind(r)}</a>
                      <span className="text-faint tnum">{usd(r.costUsd)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
      </Card>
    </div>
  );
}
