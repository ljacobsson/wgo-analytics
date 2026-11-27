import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { cn } from '../lib/format';

export interface TabInfo {
  id: string;
  name: string;
}

/**
 * Query tabs: click to switch, double-click to rename, middle-click or × to close, drag to reorder.
 * Double-clicking the empty part of the bar opens a new tab.
 */
export function TabBar({ tabs, active, running, failed, onSelect, onNew, onClose, onRename, onMove }: {
  tabs: TabInfo[];
  active: string;
  running: Set<string>;
  failed: Set<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, toIndex: number) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  // keep the active tab in view
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(active)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);

  const drop = (index: number) => {
    if (dragging) onMove(dragging, index);
    setDragging(null);
    setOver(null);
  };

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-[color-mix(in_srgb,var(--fg)_2%,transparent)]">
      <div ref={strip} role="tablist" className="flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none]"
        onDragOver={(e) => { if (dragging) e.preventDefault(); }} onDrop={() => drop(tabs.length)}>
        {tabs.map((t, i) => {
          const on = t.id === active;
          return (
            <div key={t.id} data-tab={t.id} role="tab" aria-selected={on} draggable={editing !== t.id}
              onClick={() => onSelect(t.id)}
              onDoubleClick={() => setEditing(t.id)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(t.id); } }}
              onDragStart={(e) => { setDragging(t.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.name); }}
              onDragEnd={() => { setDragging(null); setOver(null); }}
              onDragOver={(e) => { if (!dragging) return; e.preventDefault(); e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setOver(e.clientX < r.left + r.width / 2 ? i : i + 1); }}
              onDrop={(e) => { e.stopPropagation(); drop(over ?? i); }}
              title={`${t.name}\nDouble-click to rename`}
              className={cn('group relative flex min-w-[90px] max-w-[200px] shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-line pl-3 pr-1.5 text-[12.5px] transition-colors',
                on ? 'bg-[var(--raised)] text-fg' : 'text-muted hover:bg-[var(--hl)] hover:text-fg', dragging === t.id && 'opacity-50')}>
              {on && <i className="absolute inset-x-0 top-0 h-[2px] grad-bg" />}
              {over === i && dragging && dragging !== t.id && <i className="absolute inset-y-1 left-0 w-[2px] bg-accent" />}
              {over === i + 1 && i === tabs.length - 1 && dragging && dragging !== t.id && <i className="absolute inset-y-1 right-0 w-[2px] bg-accent" />}
              {running.has(t.id)
                ? <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
                : failed.has(t.id) && <i className="h-1.5 w-1.5 shrink-0 rounded-full bg-bad" title="The last query in this tab failed" />}
              {editing === t.id
                ? <RenameInput name={t.name} onDone={(name) => { setEditing(null); if (name !== null) onRename(t.id, name); }} />
                : <span className="min-w-0 flex-1 truncate">{t.name}</span>}
              <button onClick={(e) => { e.stopPropagation(); onClose(t.id); }} title="Close tab" aria-label={`Close ${t.name}`}
                className={cn('grid h-5 w-5 shrink-0 place-items-center rounded text-faint hover:bg-[var(--line)] hover:text-fg cursor-pointer', on ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button onClick={onNew} title="New tab" aria-label="New tab" className="grid w-9 shrink-0 place-items-center text-faint hover:bg-[var(--hl)] hover:text-fg cursor-pointer"><Plus size={15} /></button>
      <div className="min-w-4 flex-1" onDoubleClick={onNew} />
    </div>
  );
}

function RenameInput({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(name);
  const done = useRef(false);
  const finish = (value: string | null) => { if (done.current) return; done.current = true; onDone(value); };
  return (
    <input autoFocus value={v} maxLength={60} onChange={(e) => setV(e.target.value)} onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') finish(v); if (e.key === 'Escape') finish(null); }}
      onBlur={() => finish(v)}
      className="min-w-0 flex-1 rounded border border-accent bg-[var(--bg)] px-1 py-0 text-[12.5px] text-fg outline-none" />
  );
}
