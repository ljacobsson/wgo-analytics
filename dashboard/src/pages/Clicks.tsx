import { useEffect, useMemo, useState } from 'react';
import { clickLabel, shortSelector } from '../lib/events';
import { Eye, MousePointerClick, Pencil, Search, Siren } from 'lucide-react';
import { useClicks, useSetClickAlias } from '../api/hooks';
import type { ClickRow } from '../api/contract';
import { useProject } from '../lib/project';
import { useTime } from '../lib/time';
import { useLive } from '../live/store';
import { navigate, pageHref, useRoute } from '../lib/router';
import { Badge, Button, Card, Dialog, EmptyState, ErrorState, Field, Mono, useToast } from '../ui/kit';
import { RowsSkeleton, TableHead } from './common';
import { fmtNum, relTime } from '../lib/format';

import { FilterBar } from '../ui/FilterBar';
import { RowActions } from '../ui/RowActions';
import { clickConditions } from '../lib/rowFilters';
/** Name a click target: the alias replaces its text or selector wherever clicks are listed, for every member. */
function AliasDialog({ row, onClose }: { row: ClickRow | null; onClose: () => void }) {
  const { project } = useProject();
  const save = useSetClickAlias(project.id);
  const toast = useToast();
  const [alias, setAlias] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (row) { setAlias(row.alias ?? ''); setError(''); } }, [row]);

  const submit = async (value: string) => {
    if (!row) return;
    setError('');
    try {
      await save.mutateAsync({ selector: row.selector, alias: value });
      toast({ title: value.trim() ? 'Alias saved' : 'Alias removed', body: value.trim() || clickLabel({ ...row, alias: null }), tone: 'good' });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const changed = alias.trim() !== (row?.alias ?? '');

  return (
    <Dialog open={!!row} onClose={onClose} width={520} title={row?.alias ? 'Rename click target' : 'Name this click target'}
      footer={<>
        {row?.alias && <Button variant="ghost" className="mr-auto" disabled={save.isPending} onClick={() => submit('')}>Remove alias</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!alias.trim() || !changed || save.isPending} onClick={() => submit(alias)}>Save</Button>
      </>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (alias.trim() && changed) void submit(alias); }}>
        <Field label="Alias" hint="Names every click on this selector, whatever the element says (a price, a count), and counts them as one target. Everyone in this project sees it.">
          <input autoFocus className="field" maxLength={80} value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={row ? clickLabel({ ...row, alias: null }) : ''} />
        </Field>
        <div>
          <div className="mb-1 text-[11.5px] font-medium text-muted">Selector</div>
          <Mono className="block break-all rounded-lg border border-line px-3 py-2 text-[12px] text-muted">{row?.selector}</Mono>
        </div>
        {error && <p className="rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{error}</p>}
      </form>
    </Dialog>
  );
}

const COLS = 'grid-cols-[minmax(160px,1.3fr)_minmax(90px,.7fr)_minmax(180px,1.5fr)_minmax(150px,1.2fr)_70px_80px_80px_160px]';

export function ClicksPage() {
  const { project } = useProject(); const { range } = useTime(); const route = useRoute();
  const live = useLive(); const toast = useToast();
  const { data, isPending, isError, error, refetch } = useClicks(project.id, range);
  const [q, setQ] = useState('');
  const [naming, setNaming] = useState<ClickRow | null>(null);
  const rows = useMemo(() => (data ?? []).filter((r) => !q || [r.selector, r.elementText, r.trackName, r.alias].join(' ').toLowerCase().includes(q.toLowerCase())), [data, q]);
  const max = Math.max(1, ...rows.map((r) => r.count));
  const watch = (r: NonNullable<typeof data>[number]) => {
    const label = clickLabel(r);
    live.addWatch({ label, type: 'click', selector: r.selector, ...(r.trackName ? { name: r.trackName } : {}) });
    toast({ title: 'Watch created', body: label, tone: 'good' });
    navigate(pageHref(project.id, 'live', route.params));
  };
  if (isError) return <ErrorState error={error} retry={() => refetch()} />;
  return (
    <div className="space-y-4">
      <FilterBar scope="events" />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="relative w-full sm:w-72"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" /><input className="field !pl-8" placeholder="Filter by alias, text, name or selector" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <span className="whitespace-nowrap text-[12.5px] text-muted tnum">{data ? `${fmtNum(data.reduce((a, r) => a + r.count, 0))} clicks · ${data.length} elements` : ''}</span>
      </div>
      <Card className="@container overflow-x-auto">
        <div className="min-w-[960px]">
          <TableHead className={COLS} cols={['Element', 'Track name', 'Selector', ['Clicks', ''], ['Sessions', 'text-right'], ['Rage', 'text-right'], ['Last seen', 'text-right'], '']} />
          {isPending ? <RowsSkeleton /> : rows.length === 0 ? (
            <EmptyState pinned icon={<MousePointerClick size={22} />} title={q ? 'No clicks match' : 'No clicks recorded'} action={!q && <Button variant="primary" onClick={() => navigate(pageHref(project.id, 'settings', route.params))}>Install the snippet</Button>}>Clicks are captured automatically once the SDK is on your site.</EmptyState>
          ) : rows.map((r) => (
            <div key={JSON.stringify([r.selector, r.elementText, r.trackName])} className={`group grid ${COLS} items-center gap-4 border-b border-line/60 px-4 py-2.5 text-[13px] transition-colors hover:bg-[var(--hl)]`}>
              <div className="flex min-w-0 items-center gap-1.5">
                <div className="min-w-0">
                  <div className="truncate font-medium" title={r.alias ?? r.elementText ?? undefined}>{r.alias || r.elementText || <span className="font-mono text-[12px] text-muted">{shortSelector(r.selector)}</span>}</div>
                  {(r.elementTag || (r.alias && r.elementText)) && <div className="truncate text-[11px] text-faint">{[r.alias && r.elementText, r.elementTag && `<${r.elementTag}>`].filter(Boolean).join(' · ')}</div>}
                </div>
                <button onClick={() => setNaming(r)} className="shrink-0 rounded-md p-1 text-muted opacity-0 transition-opacity hover:bg-[var(--hl)] hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 cursor-pointer" title={r.alias ? 'Rename' : 'Give it a name'} aria-label={r.alias ? 'Rename click target' : 'Name click target'}><Pencil size={13} /></button>
              </div>
              <div>{r.trackName ? <Badge tone="accent">{r.trackName}</Badge> : <span className="text-faint">–</span>}</div>
              <Mono className="truncate text-muted" title={r.selector}>{r.selector}</Mono>
              <div className="flex items-center gap-2.5"><span className="w-12 tnum font-medium">{fmtNum(r.count)}</span><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--hl)]"><div className="h-full rounded-full transition-all duration-500" style={{ width: `${(r.count / max) * 100}%`, background: 'var(--s3)' }} /></div></div>
              <div className="text-right tnum text-muted">{fmtNum(r.sessions)}</div>
              <div className="text-right">{r.rageClicks > 0 ? <Badge tone="bad"><Siren size={11} />{r.rageClicks}</Badge> : <span className="text-faint">–</span>}</div>
              <div className="text-right text-[12px] text-faint">{relTime(r.lastSeen)}</div>
              <div className="flex items-center justify-end gap-1"><RowActions scope="events" conditions={clickConditions(r)} /><Button size="sm" className="opacity-60 group-hover:opacity-100" onClick={() => watch(r)}><Eye size={13} />Watch live</Button></div>
            </div>
          ))}
        </div>
      </Card>
      <AliasDialog row={naming} onClose={() => setNaming(null)} />
    </div>
  );
}
