import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, Check, Plus, Search, RefreshCw, Sun, Moon, LogOut, PanelLeft, History, Menu, X } from 'lucide-react';
import { Logo, LogoMark } from '../ui/Logo';
import { PAGES, useProject } from '../lib/project';
import { navigate, pageHref, useRoute } from '../lib/router';
import { resolveRange, TimeCtx, type TimeRange } from '../lib/time';
import { prefetchPage } from '../api/hooks';
import { PageIcon } from './icons';
import { TimePicker } from './TimePicker';
import { CommandPalette } from './CommandPalette';
import { UpdateNotice } from './UpdateNotice';
import { ShowOnKioskButton } from '../kiosk/ShowOnKiosk';
import { signOut } from '../auth/cognito';
import { Kbd, Switch } from '../ui/kit';
import { cn } from '../lib/format';
import { useLive } from '../live/store';

function useTheme() {
  const [t, setT] = useState<'dark' | 'light'>(() => (document.documentElement.dataset.theme as 'dark' | 'light') || 'dark');
  const toggle = () => {
    const n = t === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = n; localStorage.setItem('wgo.theme', n); setT(n);
  };
  return [t, toggle] as const;
}

function ProjectSwitcher({ collapsed }: { collapsed: boolean }) {
  const { project, projects } = useProject();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-[var(--hl)] p-2 text-left transition-colors hover:border-[var(--line-strong)] cursor-pointer">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg grad-bg text-[12px] font-bold text-white">{project.name.slice(0, 1).toUpperCase()}</span>
        {!collapsed && <><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{project.name}</span><span className="block text-[11px] text-faint">{project.role}</span></span><ChevronsUpDown size={14} className="text-faint" /></>}
      </button>
      {open && (
        <div className="anim-pop absolute left-0 top-12 z-40 w-60 rounded-xl border border-line bg-[var(--raised)] p-1.5 shadow-2xl">
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">Projects</div>
          {projects.map((p) => (
            <button key={p.id} onClick={() => { setOpen(false); navigate(`/p/${p.id}/overview`); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--hl)] cursor-pointer">
              <span className="flex-1 truncate">{p.name}</span>{p.id === project.id && <Check size={14} className="text-accent" />}
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          <button onClick={() => { setOpen(false); navigate('/new'); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer"><Plus size={14} />New project…</button>
        </div>
      )}
    </div>
  );
}

function LiveDot() {
  const live = useLive();
  const c = live.status === 'connected' ? 'bg-good' : 'bg-warn';
  return <i title={`Live: ${live.status}`} className={cn('ml-auto h-1.5 w-1.5 rounded-full', c, live.status !== 'connected' && 'pulse-dot')} />;
}

export function Shell({ page, children }: { page: string; children: ReactNode }) {
  const { project, email } = useProject();
  const route = useRoute();
  const qc = useQueryClient();
  const [theme, toggleTheme] = useTheme();
  const [cmdOpen, setCmdOpen] = useState(false);
  const [auto, setAuto] = useState(false);
  const [tick, setTick] = useState(0);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1180px)').matches);
  const [forceOpen, setForceOpen] = useState<boolean | null>(null);
  useEffect(() => {
    const m = window.matchMedia('(max-width: 1180px)');
    const h = () => { setNarrow(m.matches); setForceOpen(null); };
    m.addEventListener('change', h); return () => m.removeEventListener('change', h);
  }, []);
  // Phones get the sidebar as a slide-in menu instead of a permanent rail.
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    const m = window.matchMedia('(max-width: 767px)');
    const h = () => { setMobile(m.matches); setNavOpen(false); };
    m.addEventListener('change', h); return () => m.removeEventListener('change', h);
  }, []);
  useEffect(() => { setNavOpen(false); }, [route.raw]);
  const collapsed = mobile ? false : forceOpen === null ? narrow : !forceOpen;

  const paramsKey = route.params.toString();
  const range = useMemo(() => resolveRange(route.params, Date.now()), [paramsKey, tick, page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!auto) return; const t = setInterval(() => setTick((x) => x + 1), 15_000); return () => clearInterval(t); }, [auto]);
  const refresh = () => { setTick((x) => x + 1); void qc.invalidateQueries(); };
  const timeCtx = useMemo(() => ({ range, refresh, auto, setAuto }), [range, auto]); // eslint-disable-line react-hooks/exhaustive-deps

  // keyboard: cmd+k, g <key>
  useEffect(() => {
    let gAt = 0;
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdOpen((o) => !o); return; }
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g') { gAt = Date.now(); return; }
      if (gAt && Date.now() - gAt < 1200) {
        gAt = 0;
        const target = e.key === 's' ? 'settings' : PAGES.find((p) => p.key === e.key)?.id;
        if (target) navigate(pageHref(project.id, target, route.params));
      }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [project.id, paramsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = page === 'settings' ? 'Settings' : page === 'widget' ? 'Mobile widget' : page === 'kiosks' ? 'Kiosks' : page === 'mcp' ? 'AI assistants (MCP)' : PAGES.find((p) => p.id === page)?.label ?? '';
  const groups = ['Product', 'Observability'] as const;

  const navItem = (id: string, label: string) => (
    <a key={id} href={'#' + pageHref(project.id, id, route.params)} title={collapsed ? label : undefined}
      onMouseEnter={() => prefetchPage(qc, project.id, id, range)}
      className={cn('group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium transition-all duration-150', page === id ? 'bg-accent/14 text-fg' : 'text-muted hover:bg-[var(--hl)] hover:text-fg', collapsed && 'justify-center px-0')}>
      {page === id && <i className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r grad-bg" />}
      <span className={page === id ? 'text-accent' : 'text-faint group-hover:text-muted'}><PageIcon id={id} /></span>
      {!collapsed && <span>{label}</span>}
      {!collapsed && id === 'live' && <LiveDot />}
    </a>
  );

  return (
    <TimeCtx.Provider value={timeCtx}>
      <div className="bg-atmos flex h-full">
        {mobile && navOpen && <div className="anim-fade fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" onClick={() => setNavOpen(false)} />}
        <aside className={cn('z-30 flex shrink-0 flex-col border-r border-line backdrop-blur-xl',
          mobile ? cn('fixed inset-y-0 left-0 z-50 w-[260px] max-w-[85vw] bg-[var(--raised)] p-3 shadow-2xl transition-transform duration-200', navOpen ? 'translate-x-0' : '-translate-x-full')
            : cn('relative bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] transition-[width] duration-200', collapsed ? 'w-[60px] p-2' : 'w-[232px] p-3'))}>
          <div className={cn('mb-4 flex items-center px-1 pt-1', collapsed ? 'justify-center' : 'justify-between')}>
            {collapsed ? <LogoMark /> : <Logo />}
            {mobile ? <button onClick={() => setNavOpen(false)} className="rounded-md p-1 text-faint hover:text-fg cursor-pointer" title="Close menu"><X size={17} /></button>
              : !collapsed && <button onClick={() => setForceOpen(false)} className="rounded-md p-1 text-faint hover:text-fg cursor-pointer" title="Collapse"><PanelLeft size={15} /></button>}
          </div>
          <ProjectSwitcher collapsed={collapsed} />
          <nav className="mt-5 flex-1 space-y-5 overflow-y-auto">
            {groups.map((g) => (
              <div key={g}>
                {!collapsed && <div className="mb-1 px-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">{g}</div>}
                <div className="space-y-0.5">{PAGES.filter((p) => p.group === g).map((p) => navItem(p.id, p.label))}</div>
              </div>
            ))}
          </nav>
          <div className="space-y-1 border-t border-line pt-3">
            {navItem('kiosks', 'Kiosks')}
            {navItem('widget', 'Mobile widget')}
            {navItem('mcp', 'AI assistants (MCP)')}
            {navItem('settings', 'Settings')}
            <div className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5', collapsed && 'justify-center px-0')}>
              {collapsed ? (
                <button onClick={() => void signOut()} title={`Sign out (${email})`} className="text-faint hover:text-fg cursor-pointer"><LogOut size={15} /></button>
              ) : (<>
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--line-strong)] text-[11px] font-semibold">{email.slice(0, 1).toUpperCase()}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={email}>{email}</span>
                {mobile && <button onClick={toggleTheme} title="Toggle theme" className="rounded-md p-1 text-faint hover:text-fg cursor-pointer">{theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}</button>}
                <button onClick={() => void signOut()} title="Sign out" className="rounded-md p-1 text-faint hover:text-fg cursor-pointer"><LogOut size={14} /></button>
              </>)}
            </div>
            {collapsed && <button onClick={() => setForceOpen(true)} className="mx-auto mt-1 block rounded-md p-1 text-faint hover:text-fg cursor-pointer" title="Expand"><PanelLeft size={15} /></button>}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="relative z-30 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] px-3 backdrop-blur-xl sm:gap-4 md:px-6">
            <div className="flex min-w-0 items-center gap-1.5">
              {mobile && <button onClick={() => setNavOpen(true)} title="Menu" className="-ml-1 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted hover:text-fg cursor-pointer"><Menu size={19} /></button>}
              <h1 className="truncate text-[16px] font-semibold tracking-tight md:text-[17px]">{title}</h1>
            </div>
            <div className="flex shrink-0 items-center gap-2 md:gap-2.5">
              <button onClick={() => setCmdOpen(true)} className="hidden h-8 items-center gap-2 rounded-lg border border-line bg-[var(--hl)] pl-2.5 pr-1.5 text-[12.5px] text-faint transition-colors hover:border-[var(--line-strong)] hover:text-muted md:flex cursor-pointer">
                <Search size={14} />Jump to…<span className="ml-4 flex gap-1"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
              </button>
              {!mobile && <ShowOnKioskButton page={page} />}
              <TimePicker />
              <div className="flex h-8 items-center gap-2 rounded-lg border border-line bg-[var(--hl)] px-1 sm:pr-2.5">
                <button onClick={refresh} title="Refresh now" className="rounded-md p-1.5 text-muted hover:text-fg cursor-pointer"><RefreshCw size={14} /></button>
                <span className="hidden sm:contents"><Switch checked={auto} onChange={setAuto} label="Auto" /></span>
              </div>
              {!mobile && <button onClick={toggleTheme} title="Toggle theme" className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-[var(--hl)] text-muted hover:text-fg cursor-pointer">{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button>}
            </div>
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto"><div key={page} className="page-in mx-auto w-full max-w-[1680px] p-3 sm:p-4 md:p-6"><RetentionNote page={page} range={range} />{children}</div></main>
        </div>
      </div>
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} toggleTheme={toggleTheme} />
      <UpdateNotice />
    </TimeCtx.Provider>
  );
}

const NO_HISTORY_PAGES = new Set(['settings', 'widget', 'live', 'mcp']);

/** Shown when the range reaches back past the project's raw data. */
function RetentionNote({ page, range }: { page: string; range: TimeRange }) {
  const { project } = useProject();
  const days = project.retention.days;
  if (NO_HISTORY_PAGES.has(page) || Date.parse(range.from) >= Date.now() - days * 86400e3) return null;
  const href = '#' + pageHref(project.id, 'settings', new URLSearchParams());
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-line bg-[var(--hl)] px-3 py-2 text-[12.5px] text-muted">
      <History size={15} className="mt-0.5 shrink-0 text-faint" />
      <p>Raw data is kept for {days} day{days === 1 ? '' : 's'}, so this range reaches past it.{' '}
        {page === 'overview'
          ? `KPIs, the events chart, top pages and breakdowns come from hourly aggregates (when no filters are set); the other panels show only the last ${days} day${days === 1 ? '' : 's'}.`
          : `This page shows only the last ${days} day${days === 1 ? '' : 's'}.`}{' '}
        <a href={href} className="text-accent hover:underline">Retention settings</a></p>
    </div>
  );
}
