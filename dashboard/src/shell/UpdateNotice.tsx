import { useEffect, useState } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import { fetchConfig, getConfig } from '../api/config';
import type { RuntimeConfig } from '../api/contract';
import { REPO_URL } from '../site/Site';
import { CopyButton } from '../ui/kit';

/**
 * Tells whoever is signed in when main on GitHub has commits newer than this install, and how to update.
 *
 * Every 30 minutes, and when the tab comes back into view, it re-reads config.json (so a redeploy clears the notice
 * without a reload) and compares it with the latest commit on main. GitHub is asked at most every 6 hours per
 * browser: the answer is cached in localStorage and shared by all tabs, well inside the unauthenticated API limit.
 * Off with UPDATE_CHECK=false, and when config.json has no deploy info (local dev, mock mode, older deploys).
 */

const REPO = REPO_URL.replace('https://github.com/', '');
const POLL_MS = 30 * 60_000;
const GITHUB_EVERY_MS = 6 * 3600_000;
const SNOOZE_MS = 7 * 86400_000;
const CACHE_KEY = 'wgo.update.latest';
const SNOOZE_KEY = 'wgo.update.snoozedUntil';
const UPDATE_CMD = 'git pull && npm run deploy';

interface Latest { sha: string; date: string; checkedAt: number }
interface Behind { latest: Latest; deployedAt: string; commit?: string }

function readCache(): Latest | null {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as Latest | null; } catch { return null; }
}

/** The newest commit on main, from the cache when it's recent enough. */
async function latestOnMain(): Promise<Latest | null> {
  const cached = readCache();
  if (cached && Date.now() - cached.checkedAt < GITHUB_EVERY_MS) return cached.sha ? cached : null;
  let next: Latest = { sha: cached?.sha ?? '', date: cached?.date ?? '', checkedAt: Date.now() };
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, { headers: { Accept: 'application/vnd.github+json' } });
    if (res.ok) {
      const j = (await res.json()) as { sha: string; commit: { committer: { date: string } } };
      next = { sha: j.sha, date: j.commit.committer.date, checkedAt: Date.now() };
    }
  } catch { /* offline or blocked: keep what we had, and don't ask again until the next window */ }
  localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  return next.sha ? next : null;
}

/** Behind when main has a different commit that is newer than the deployed one (or than the deploy, without git info). */
function isBehind(c: Pick<RuntimeConfig, 'deployedAt' | 'commit' | 'commitDate'>, latest: Pick<Latest, 'sha' | 'date'>) {
  if (!c.deployedAt) return false;
  if (c.commit && c.commit === latest.sha) return false;
  const ours = Date.parse(c.commitDate || c.deployedAt);
  return Number.isFinite(ours) && Date.parse(latest.date) > ours;
}

async function check(): Promise<Behind | null> {
  if (Date.now() < Number(localStorage.getItem(SNOOZE_KEY) ?? 0)) return null;
  let c: RuntimeConfig;
  try { c = await fetchConfig(); } catch { c = getConfig(); }
  if (c.devEmail || c.updateCheck === false || !c.deployedAt) return null;
  const latest = await latestOnMain();
  return latest && isBehind(c, latest) ? { latest, deployedAt: c.deployedAt, commit: c.commit || undefined } : null;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function UpdateNotice() {
  const [behind, setBehind] = useState<Behind | null>(null);

  useEffect(() => {
    let alive = true;
    const run = () => { void check().then((b) => { if (alive) setBehind(b); }).catch(() => {}); };
    const onVisible = () => { if (document.visibilityState === 'visible') run(); };
    const first = setTimeout(run, 4000); // after the page's own data has loaded
    const every = setInterval(run, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; clearTimeout(first); clearInterval(every); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  if (!behind) return null;
  const dismiss = () => { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); setBehind(null); };
  const changes = behind.commit ? `${REPO_URL}/compare/${behind.commit}...main` : `${REPO_URL}/commits/main`;

  return (
    <div role="status" className="anim-pop fixed bottom-4 right-4 z-[70] w-[340px] max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-[var(--raised)] p-4 shadow-2xl">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13.5px] font-semibold">A newer version of WGO is available</p>
        <button onClick={dismiss} aria-label="Dismiss for a week" title="Dismiss for a week" className="-mr-1.5 -mt-1 grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-faint hover:bg-[var(--hl)] hover:text-fg"><X size={15} /></button>
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
        This install was deployed on {day(behind.deployedAt)}. The latest change on GitHub is from {day(behind.latest.date)}. To update, run this in your WGO checkout:
      </p>
      <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-line bg-[var(--hl)] py-1.5 pl-3 pr-1.5">
        <code className="truncate font-mono text-[12px]">{UPDATE_CMD}</code>
        <CopyButton text={UPDATE_CMD} />
      </div>
      <a href={changes} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline">See what changed<ArrowUpRight size={13} /></a>
    </div>
  );
}
