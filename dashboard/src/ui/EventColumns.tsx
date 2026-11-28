import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Check, Columns3, UserRound } from 'lucide-react';
import type { AnalyticsEvent } from '../api/contract';
import { userLabel } from '../lib/events';
import { cn, shortId } from '../lib/format';
import { flag } from '../lib/geo';
import { Popover } from './Popover';
import { Button } from './kit';
import { httpUrl, NewTabLink } from './ExternalUrl';

/** Optional columns of the event lists (Events page, Live firehose). Time, type and the event title always show. */
export type EventColumn = 'user' | 'path' | 'selector' | 'browser' | 'os' | 'device' | 'location' | 'session';

export const EVENT_COLUMNS: Array<{ id: EventColumn; label: string }> = [
  { id: 'user', label: 'User' },
  { id: 'path', label: 'Page' },
  { id: 'selector', label: 'Selector' },
  { id: 'browser', label: 'Browser' },
  { id: 'os', label: 'OS' },
  { id: 'device', label: 'Device' },
  { id: 'location', label: 'Location' },
  { id: 'session', label: 'Session' },
];

/** The visible columns of one list, saved in this browser (localStorage) so they survive reloads. */
export function useEventColumns(list: 'events' | 'firehose', defaults: EventColumn[]): [EventColumn[], (next: EventColumn[]) => void] {
  const key = `wgo.columns.${list}`;
  const [cols, setCols] = useState<EventColumn[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
      if (Array.isArray(saved)) return EVENT_COLUMNS.map((c) => c.id).filter((id) => saved.includes(id));
    } catch { /* fall back to the defaults */ }
    return defaults;
  });
  const save = useCallback((next: EventColumn[]) => {
    const ordered = EVENT_COLUMNS.map((c) => c.id).filter((id) => next.includes(id));
    setCols(ordered);
    localStorage.setItem(key, JSON.stringify(ordered));
  }, [key]);
  return [cols, save];
}

export function ColumnsMenu({ value, onChange, defaults }: { value: EventColumn[]; onChange: (next: EventColumn[]) => void; defaults: EventColumn[] }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const toggle = (id: EventColumn) => onChange(value.includes(id) ? value.filter((c) => c !== id) : [...value, id]);
  return (
    <>
      <span ref={anchor} className="inline-flex">
        <Button size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Choose which columns to show">
          <Columns3 size={13} />Columns
        </Button>
      </span>
      <Popover anchor={anchor} open={open} onClose={close} width={220}>
        <p className="mb-2 px-1 text-[11.5px] font-medium text-faint">Show columns</p>
        <div className="space-y-0.5">
          {EVENT_COLUMNS.map((c) => {
            const on = value.includes(c.id);
            return (
              <button key={c.id} role="menuitemcheckbox" aria-checked={on} onClick={() => toggle(c.id)}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--hl)] cursor-pointer">
                <span className={cn('grid size-4 place-items-center rounded border', on ? 'border-accent bg-accent text-white' : 'border-[var(--line-strong)]')}>
                  {on && <Check size={11} strokeWidth={3} />}
                </span>
                {c.label}
              </button>
            );
          })}
        </div>
        <button onClick={() => onChange(defaults)} className="mt-2 w-full rounded-md px-2 py-1.5 text-left text-[12px] text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer">
          Reset to default
        </button>
      </Popover>
    </>
  );
}

/** The user an event came from: the identified user id, else the end of the anonymous id. */
export function UserCell({ e, onClick, className }: { e: Pick<AnalyticsEvent, 'userId' | 'anonId'>; onClick?: () => void; className?: string }) {
  const u = userLabel(e);
  if (!u) return <span className={cn('text-faint', className)}>–</span>;
  const title = u.identified ? `User ${u.text}${onClick ? ' · show this user\'s events' : ''}` : `Anonymous visitor ${e.anonId}${onClick ? ' · show this visitor\'s events' : ''}`;
  const body = u.identified
    ? <><UserRound size={12} className="shrink-0" /><span className="truncate">{u.text}</span></>
    : <span className="truncate font-mono text-[11.5px]">{u.text}</span>;
  const cls = cn('inline-flex min-w-0 items-center gap-1', u.identified ? 'text-muted' : 'text-faint', onClick && 'hover:text-accent cursor-pointer', className);
  return onClick
    ? <button title={title} onClick={(x) => { x.stopPropagation(); onClick(); }} className={cls}>{body}</button>
    : <span title={title} className={cls}>{body}</span>;
}

/** A filter that selects every event of the user (or anonymous visitor) behind `e`. */
export const userFilter = (e: Pick<AnalyticsEvent, 'userId' | 'anonId'>) =>
  e.userId ? { field: 'userId', op: 'eq' as const, value: e.userId } : e.anonId ? { field: 'anonId', op: 'eq' as const, value: e.anonId } : null;

const COL_BASIS: Record<EventColumn, number> = { user: 132, path: 180, selector: 200, browser: 64, os: 64, device: 64, location: 130, session: 72 };
/** Narrowest an event row may get before its list scrolls sideways: the fixed parts plus every chosen column. */
export const eventRowMinWidth = (cols: EventColumn[], fixed: number) => fixed + cols.reduce((s, c) => s + COL_BASIS[c] + 12, 0);

/** One optional cell: a fixed basis so rows line up, shrinking only when the list is narrow. */
export function EventCell({ col, e, onUser, onSession }: {
  col: EventColumn; e: AnalyticsEvent; onUser?: () => void; onSession?: (sessionId: string) => void;
}): ReactNode {
  const base = 'min-w-[48px] shrink grow-0 truncate'; // shrinks before the event title does
  switch (col) {
    case 'user': return <UserCell key={col} e={e} onClick={onUser} className={cn(base, 'basis-[132px]')} />;
    case 'path': {
      const cls = cn(base, 'basis-[180px] font-mono text-[11.5px] text-faint');
      const shown = e.type !== 'pageview' ? e.path ?? '' : '';
      const href = shown ? httpUrl(e.url) : null;
      return href
        ? <NewTabLink key={col} href={href} title={`Open ${e.url} in a new tab`} className={cls}>{shown}</NewTabLink>
        : <span key={col} title={e.path ?? undefined} className={cls}>{shown}</span>;
    }
    case 'selector': return <span key={col} title={e.selector ?? undefined} className={cn(base, 'basis-[200px] font-mono text-[11.5px] text-muted')}>{e.selector ?? ''}</span>;
    case 'browser': return <span key={col} className={cn(base, 'basis-16 text-faint')}>{e.browser ?? ''}</span>;
    case 'os': return <span key={col} className={cn(base, 'basis-16 text-faint')}>{e.os ?? ''}</span>;
    case 'device': return <span key={col} className={cn(base, 'basis-16 text-faint')}>{e.device ?? ''}</span>;
    case 'location': {
      const place = [e.city, e.country].filter(Boolean).join(', ');
      return <span key={col} title={place || undefined} className={cn(base, 'basis-[130px] text-faint')}>{e.country ? `${flag(e.country)} ${e.city ?? e.country}` : ''}</span>;
    }
    case 'session': return e.sessionId && onSession
      ? <button key={col} onClick={(x) => { x.stopPropagation(); onSession(e.sessionId!); }} title="Session timeline" className={cn(base, 'basis-[72px] text-left font-mono text-[11.5px] text-faint hover:text-accent cursor-pointer')}>{shortId(e.sessionId)}</button>
      : <span key={col} className={cn(base, 'basis-[72px] font-mono text-[11.5px] text-faint')}>{shortId(e.sessionId)}</span>;
  }
}
