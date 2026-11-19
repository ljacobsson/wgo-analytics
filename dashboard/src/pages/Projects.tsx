import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, LogOut, Moon, Plus, Search, Sun } from 'lucide-react';
import type { Project, StatsResponse, Totals } from '../api/contract';
import { usePreviousTotals, useSite, useSiteImage, useStats } from '../api/hooks';
import { signOut } from '../auth/cognito';
import { Sparkline } from '../charts/Sparkline';
import { cn, fmtNum } from '../lib/format';
import { navigate, pageHref, useRoute, useSetParams } from '../lib/router';
import { resolveRange, type TimeRange } from '../lib/time';
import { useTheme } from '../shell/Shell';
import { Button, Card, Delta, Segmented, Skeleton } from '../ui/kit';
import { Logo } from '../ui/Logo';
import { ProjectAvatar } from '../ui/ProjectAvatar';

const RANGES = ['24h', '7d', '30d'] as const;

/** Link to the "All projects" page, keeping the time range of the current URL. */
export function projectsHref(params: URLSearchParams) {
  const r = params.get('range');
  return r && r !== '24h' && r !== 'custom' ? `/projects?range=${r}` : '/projects';
}

function Stat({ label, cur, prev, invert }: { label: string; cur?: number; prev?: number; invert?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] text-faint">{label}</div>
      <div className="mt-1.5 truncate">{cur == null ? <Skeleton className="h-5 w-14" /> : <span className="kpi text-[19px] font-semibold leading-none tracking-tight tnum">{fmtNum(cur)}</span>}</div>
      <div className="mt-1 h-4">{cur != null && prev != null && <Delta cur={cur} prev={prev} invert={invert} />}</div>
    </div>
  );
}

/** The site's homepage screenshot behind the card: visible at the top, fading out under the numbers and the chart. */
function SiteBackdrop({ src }: { src: string }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <img src={src} alt="" className="anim-fade h-full w-full object-cover object-top opacity-55 transition-opacity duration-300 group-hover:opacity-70" />
      <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, color-mix(in srgb, var(--bg) 35%, transparent) 0%, color-mix(in srgb, var(--bg) 62%, transparent) 38%, color-mix(in srgb, var(--bg) 84%, transparent) 70%, color-mix(in srgb, var(--bg) 92%, transparent) 100%)' }} />
    </div>
  );
}

function ProjectCard({ project, range, onLoaded }: { project: Project; range: TimeRange; onLoaded: (id: string, t: Totals) => void }) {
  const route = useRoute();
  const stats = useStats(project.id, range);
  const prev = usePreviousTotals(project.id, range);
  const s: StatsResponse | undefined = stats.data;
  const p = prev.data;
  const site = useSite(project.id);
  const shot = useSiteImage(project.id, site.data?.image?.day ?? null);
  const host = site.data?.origin ? new URL(site.data.origin).host : null;
  useEffect(() => { if (s) onLoaded(project.id, s.totals); }, [s, project.id, onLoaded]);
  const empty = s && s.totals.events === 0;
  const href = '#' + pageHref(project.id, 'overview', route.params);
  return (
    <a href={href} className="group block rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
      <Card hover className="relative h-full overflow-hidden p-4">
        {shot.data && <SiteBackdrop src={shot.data} />}
        <div className="relative flex h-full flex-col">
          <div className="flex items-center gap-3">
            <ProjectAvatar project={project} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14.5px] font-semibold tracking-tight">{project.name}</div>
              <div className={cn('truncate text-[11.5px]', shot.data ? 'text-muted' : 'text-faint')}>{host ? <>{host} · </> : null}{project.role === 'owner' ? 'Owner' : 'Member'}{host ? null : <> · {project.retention.days} day retention</>}</div>
            </div>
            <ArrowRight size={16} className="shrink-0 text-faint transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-fg" />
          </div>

          {stats.isError ? (
            <p className="mt-5 text-[12.5px] text-bad">Could not load this project’s numbers.</p>
          ) : (
            <>
              <div className="mt-5 grid grid-cols-4 gap-3">
                <Stat label="Users" cur={s?.totals.users} prev={p?.users} />
                <Stat label="Pageviews" cur={s?.totals.pageviews} prev={p?.pageviews} />
                <Stat label="Errors" cur={s?.totals.errors} prev={p?.errors} invert />
                <Stat label="HTTP errors" cur={s?.totals.httpErrors} prev={p?.httpErrors} invert />
              </div>
              <div className="mt-4 h-10">
                {!s ? <Skeleton className="h-10" />
                  : empty ? <p className="pt-3 text-[12px] text-faint">No events in this range.</p>
                  : <Sparkline data={s.series.map((b) => b.pageview)} color="var(--s1)" height={40} />}
              </div>
            </>
          )}
        </div>
      </Card>
    </a>
  );
}

export function ProjectsPage({ projects, email }: { projects: Project[]; email: string }) {
  const route = useRoute();
  const setParams = useSetParams();
  const [theme, toggleTheme] = useTheme();
  const [q, setQ] = useState('');
  const [totals, setTotals] = useState<Record<string, Totals>>({});
  const rangeParam = route.params.get('range');
  const preset = (RANGES as readonly string[]).includes(rangeParam ?? '') ? (rangeParam as (typeof RANGES)[number]) : '24h';
  // re-resolved only when the preset changes, so the cards' query keys stay stable between renders
  const range = useMemo(() => resolveRange(new URLSearchParams({ range: preset }), Date.now()), [preset]);

  const sorted = useMemo(() => [...projects].sort((a, b) => a.name.localeCompare(b.name)), [projects]);
  const shown = q ? sorted.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) : sorted;
  const onLoaded = useCallback((id: string, t: Totals) => setTotals((m) => (m[id] === t ? m : { ...m, [id]: t })), []);
  const loaded = projects.filter((p) => totals[p.id]);
  const sum = (k: keyof Totals) => loaded.reduce((n, p) => n + totals[p.id][k], 0);

  return (
    <div className="bg-atmos h-full overflow-y-auto">
      <header className="sticky top-0 z-30 border-b border-line bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-[1280px] items-center justify-between gap-3 px-4 md:px-6">
          <Logo />
          <div className="flex items-center gap-2">
            <button onClick={toggleTheme} title="Toggle theme" className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-[var(--hl)] text-muted hover:text-fg cursor-pointer">{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button>
            <span className="hidden max-w-[220px] truncate text-[12px] text-muted sm:block" title={email}>{email}</span>
            <button onClick={() => void signOut()} title="Sign out" className="grid h-8 w-8 place-items-center rounded-lg text-faint hover:text-fg cursor-pointer"><LogOut size={15} /></button>
          </div>
        </div>
      </header>

      <main className="page-in mx-auto w-full max-w-[1280px] p-4 md:p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">Projects</h1>
            <p className="mt-1 text-[13px] text-muted">
              {projects.length} project{projects.length === 1 ? '' : 's'}
              {loaded.length === projects.length && <> · {fmtNum(sum('users'))} users, {fmtNum(sum('pageviews'))} pageviews and {fmtNum(sum('errors') + sum('httpErrors'))} errors in the last {preset}</>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {projects.length > 6 && (
              <label className="flex h-8 items-center gap-2 rounded-lg border border-line bg-[var(--hl)] px-2.5 text-[12.5px] text-faint focus-within:border-[var(--line-strong)]">
                <Search size={14} />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a project" className="w-36 bg-transparent text-fg outline-none placeholder:text-faint" />
              </label>
            )}
            <Segmented value={preset} onChange={(v) => setParams({ range: v === '24h' ? null : v })} options={RANGES.map((r) => ({ value: r, label: `Last ${r}` }))} />
            <Button variant="primary" size="sm" onClick={() => navigate('/new')} className="h-8"><Plus size={14} />New project</Button>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((p) => <ProjectCard key={p.id} project={p} range={range} onLoaded={onLoaded} />)}
        </div>
        {!shown.length && <p className="mt-10 text-center text-[13px] text-muted">No project matches “{q}”.</p>}
      </main>
    </div>
  );
}
