import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Search, Clock, FolderKanban, LayoutGrid, Moon, LogOut, RefreshCw, Plus, Bookmark } from 'lucide-react';
import { useViews } from '../api/hooks';
import { viewHref } from '../ui/FilterBar';
import { PAGES, useProject } from '../lib/project';
import { navigate, pageHref, useRoute, useSetParams } from '../lib/router';
import { PRESETS, useTime } from '../lib/time';
import { Kbd } from '../ui/kit';
import { PageIcon } from './icons';
import { signOut } from '../auth/cognito';
import { cn } from '../lib/format';
import { projectsHref } from '../pages/Projects';

interface Cmd { id: string; label: string; group: string; icon: ReactNode; hint?: string; run: () => void }

export function CommandPalette({ open, onClose, toggleTheme }: { open: boolean; onClose: () => void; toggleTheme: () => void }) {
  const { project, projects } = useProject();
  const route = useRoute();
  const setParams = useSetParams();
  const { setAuto, auto, refresh } = useTime();
  const views = useViews(project.id, open);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQ(''); setIdx(0); setTimeout(() => inputRef.current?.focus(), 10); } }, [open]);

  const cmds = useMemo<Cmd[]>(() => [
    ...PAGES.map((p) => ({ id: 'p-' + p.id, label: `Go to ${p.label}`, group: 'Pages', icon: <PageIcon id={p.id} size={15} />, hint: `g ${p.key}`, run: () => navigate(pageHref(project.id, p.id, route.params)) })),
    { id: 'p-settings', label: 'Go to Settings', group: 'Pages', icon: <PageIcon id="settings" size={15} />, hint: 'g s', run: () => navigate(pageHref(project.id, 'settings', route.params)) },
    { id: 'p-kiosks', label: 'Kiosks: show the dashboard on a TV', group: 'Pages', icon: <PageIcon id="kiosks" size={15} />, run: () => navigate(pageHref(project.id, 'kiosks', route.params)) },
    { id: 'p-widget', label: 'Android widget: download & connect', group: 'Pages', icon: <PageIcon id="widget" size={15} />, run: () => navigate(pageHref(project.id, 'widget', route.params)) },
    { id: 'p-mcp', label: 'AI assistants: connect Claude, VS Code or Cursor over MCP', group: 'Pages', icon: <PageIcon id="mcp" size={15} />, run: () => navigate(pageHref(project.id, 'mcp', route.params)) },
    ...(views.data ?? []).map((v) => ({ id: 'v-' + v.id, label: `Open view: ${v.name} · ${PAGES.find((p) => p.id === v.page)?.label ?? v.page}`, group: 'Saved views', icon: <Bookmark size={15} />, run: () => navigate(viewHref(project.id, v, route.params)) })),
    ...PRESETS.map((r) => ({ id: 'r-' + r, label: `Time range: last ${r}`, group: 'Time range', icon: <Clock size={15} />, run: () => setParams({ range: r === '24h' ? null : r, from: null, to: null }) })),
    { id: 'all-projects', label: 'All projects', group: 'Projects', icon: <LayoutGrid size={15} />, run: () => navigate(projectsHref(route.params)) },
    ...projects.map((p) => ({ id: 'pr-' + p.id, label: `Switch to ${p.name}`, group: 'Projects', icon: <FolderKanban size={15} />, run: () => navigate(`/p/${p.id}/overview`) })),
    { id: 'new', label: 'New project…', group: 'Projects', icon: <Plus size={15} />, run: () => navigate('/new') },
    { id: 'refresh', label: 'Refresh data', group: 'Actions', icon: <RefreshCw size={15} />, run: refresh },
    { id: 'auto', label: auto ? 'Turn auto-refresh off' : 'Turn auto-refresh on', group: 'Actions', icon: <RefreshCw size={15} />, run: () => setAuto(!auto) },
    { id: 'theme', label: 'Toggle light / dark theme', group: 'Actions', icon: <Moon size={15} />, run: toggleTheme },
    { id: 'out', label: 'Sign out', group: 'Actions', icon: <LogOut size={15} />, run: () => void signOut() },
  ], [project.id, projects, route.params, auto, views.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return cmds.filter((c) => terms.every((t) => (c.label + ' ' + c.group).toLowerCase().includes(t)));
  }, [q, cmds]);
  useEffect(() => setIdx(0), [q]);
  useEffect(() => { document.querySelector(`[data-cmd="${idx}"]`)?.scrollIntoView({ block: 'nearest' }); }, [idx]);

  if (!open) return null;
  const exec = (c?: Cmd) => { if (c) { onClose(); c.run(); } };
  let last = '';
  return createPortal(
    <div className="fixed inset-0 z-[70] flex justify-center pt-[14vh]" onKeyDown={(e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(list.length - 1, i + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
      else if (e.key === 'Enter') exec(list[idx]);
      else if (e.key === 'Escape') onClose();
    }}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm anim-fade" onClick={onClose} />
      <div className="anim-pop relative h-fit w-[560px] max-w-[92vw] overflow-hidden rounded-2xl border border-line bg-[var(--raised)] shadow-2xl">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search size={16} className="text-faint" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to a page, project or time range…" className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint" />
          <Kbd>esc</Kbd>
        </div>
        <div className="max-h-[360px] overflow-y-auto p-1.5">
          {list.length === 0 && <div className="px-4 py-8 text-center text-muted">No matches</div>}
          {list.map((c, i) => {
            const head = c.group !== last; last = c.group;
            return (
              <div key={c.id}>
                {head && <div className="px-3 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">{c.group}</div>}
                <button data-cmd={i} onMouseMove={() => setIdx(i)} onClick={() => exec(c)}
                  className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] cursor-pointer', i === idx ? 'bg-accent/15 text-fg' : 'text-muted')}>
                  <span className={i === idx ? 'text-accent' : 'text-faint'}>{c.icon}</span><span className="flex-1">{c.label}</span>
                  {c.hint && <span className="flex gap-1">{c.hint.split(' ').map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>, document.body);
}
