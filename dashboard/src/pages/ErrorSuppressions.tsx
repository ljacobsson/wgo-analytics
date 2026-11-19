import { useEffect, useMemo, useState } from 'react';
import { EyeOff, Plus, Trash2 } from 'lucide-react';
import type { ErrorGroup, ErrorKind, ErrorSuppression, ErrorSuppressionInput } from '../api/contract';
import { useDeleteSuppression, useSaveSuppression, useSuppressions } from '../api/hooks';
import { fmtNum, relTime } from '../lib/format';
import { useProject } from '../lib/project';
import { Button, Dialog, Drawer, EmptyState, Field, Mono, Skeleton, useToast } from '../ui/kit';

/**
 * Error suppression rules: errors matching one are dropped when they arrive. Patterns use `*` as a wildcard and match
 * the whole value, case-insensitively (the same rules as the backend's lib/suppressions.ts).
 */

const KINDS: Array<{ v: ErrorKind | ''; label: string }> = [
  { v: '', label: 'Any kind' }, { v: 'error', label: 'error' }, { v: 'rejection', label: 'rejection' }, { v: 'resource', label: 'resource' }, { v: 'manual', label: 'manual' },
];

export function wildcard(pattern: string): RegExp {
  const body = pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 'is');
}
const sourceMatches = (re: RegExp, url: string) => {
  if (re.test(url)) return true;
  try { const u = new URL(url); return re.test(u.pathname) || re.test(u.host + u.pathname); } catch { return false; }
};

/** Whether a rule covers a group (page patterns can't be checked against a group, which spans pages). */
export function covers(r: ErrorSuppressionInput, g: ErrorGroup): boolean {
  if (r.page) return false;
  if (r.kind && r.kind !== g.kind) return false;
  if (r.message && !wildcard(r.message).test(g.message)) return false;
  if (r.source && !(g.source && sourceMatches(wildcard(r.source), g.source))) return false;
  return !!(r.kind || r.message || r.source);
}

/**
 * A starting point for "errors like this one": a failed resource by its URL with the last part as a wildcard
 * (one rule for all the missing product images), anything else by its kind and message.
 */
export function suggestRule(g: ErrorGroup): ErrorSuppressionInput {
  if (g.kind === 'resource' && g.source) {
    const url = g.source.replace(/[?#].*$/, '');
    return { kind: 'resource', source: /\/[^/]+$/.test(url.replace(/^[a-z]+:\/\/[^/]+/i, '')) ? url.replace(/\/[^/]*$/, '/*') : url, message: null, page: null };
  }
  return { kind: (g.kind as ErrorKind) ?? null, message: g.message, source: null, page: null };
}

export function describeRule(r: ErrorSuppressionInput): string {
  const parts = [r.kind ? `${r.kind} errors` : 'errors'];
  if (r.message) parts.push(`with message ${r.message}`);
  if (r.source) parts.push(`from ${r.source}`);
  if (r.page) parts.push(`on pages ${r.page}`);
  return parts.join(' ');
}

export function SuppressDialog({ open, initial, groups, onClose }: { open: boolean; initial: ErrorSuppressionInput | null; groups: ErrorGroup[]; onClose: () => void }) {
  const { project } = useProject();
  const save = useSaveSuppression(project.id);
  const toast = useToast();
  const [kind, setKind] = useState<ErrorKind | ''>('');
  const [message, setMessage] = useState('');
  const [source, setSource] = useState('');
  const [page, setPage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setKind(initial?.kind ?? ''); setMessage(initial?.message ?? ''); setSource(initial?.source ?? ''); setPage(initial?.page ?? ''); setError('');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const rule: ErrorSuppressionInput = { kind: kind || null, message: message.trim() || null, source: source.trim() || null, page: page.trim() || null };
  const empty = !rule.kind && !rule.message && !rule.source && !rule.page;
  const matched = useMemo(() => (empty ? [] : groups.filter((g) => covers(rule, g))), [groups, kind, message, source, page]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => {
    setError('');
    try {
      await save.mutateAsync(rule);
      toast({ title: 'Errors suppressed', body: describeRule(rule), tone: 'good' });
      onClose();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <Dialog open={open} onClose={onClose} width={600} title="Suppress errors"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={empty || save.isPending} onClick={() => void submit()}><EyeOff size={14} />Suppress</Button></>}>
      <div className="space-y-4">
        <p className="text-[12.5px] text-muted">Matching errors are dropped when they arrive: they aren't stored, counted or sent to triggers. Ones already stored are left out of the Overview and hidden here. Use <Mono>*</Mono> as a wildcard; a pattern matches the whole value, ignoring case. Leave a field empty to match anything.</p>
        <Field label="Kind">
          <select className="field" value={kind} onChange={(e) => setKind(e.target.value as ErrorKind | '')}>{KINDS.map((k) => <option key={k.v} value={k.v}>{k.label}</option>)}</select>
        </Field>
        <Field label="Failing URL" hint="The resource that didn't load or the script that threw. A path alone matches any host: /img/*">
          <input className="field font-mono" value={source} onChange={(e) => setSource(e.target.value)} placeholder="https://cdn.example.com/images/*" />
        </Field>
        <Field label="Message" hint="The error type is at the start: TypeError: *">
          <input className="field font-mono" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="*ResizeObserver loop*" />
        </Field>
        <Field label="Page" hint="The page the error happened on">
          <input className="field font-mono" value={page} onChange={(e) => setPage(e.target.value)} placeholder="/admin/*" />
        </Field>
        <p className="text-[12.5px] text-muted">
          {empty ? 'Set at least one field.' : rule.page ? 'Rules with a page apply to new errors only; groups on this page stay listed.'
            : <>Covers {matched.length === 1 ? '1 error group' : `${fmtNum(matched.length)} error groups`} in the current list{matched.length > 0 && ` (${fmtNum(matched.reduce((a, g) => a + g.count, 0))} events)`}. They'll be hidden there.</>}
        </p>
        {error && <p className="rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{error}</p>}
      </div>
    </Dialog>
  );
}

function RuleRow({ r }: { r: ErrorSuppression }) {
  const { project } = useProject();
  const del = useDeleteSuppression(project.id);
  const fields: Array<[string, string | null | undefined]> = [['Kind', r.kind], ['Failing URL', r.source], ['Message', r.message], ['Page', r.page]];
  return (
    <div className="flex items-start gap-3 border-b border-line/60 px-4 py-3 text-[12.5px]">
      <div className="min-w-0 flex-1 space-y-0.5">
        {fields.filter(([, v]) => v).map(([k, v]) => <div key={k} className="flex gap-2"><span className="w-24 shrink-0 text-faint">{k}</span><Mono className="min-w-0 break-all text-fg">{v}</Mono></div>)}
        <div className="pt-1 text-[11.5px] text-faint">{r.hits ? `Dropped ${fmtNum(r.hits)} ${r.hits === 1 ? 'error' : 'errors'}, last ${relTime(r.lastHitAt!)}` : 'Nothing dropped yet'} · added by {r.createdBy} {relTime(r.createdAt)}</div>
      </div>
      <button onClick={() => { if (confirm('Delete this rule? Matching errors are stored again from now on, and the ones already stored show up again.')) del.mutate(r.id); }}
        className="rounded-md p-1.5 text-muted hover:bg-bad/15 hover:text-bad cursor-pointer" title="Delete rule"><Trash2 size={14} /></button>
    </div>
  );
}

export function SuppressionRules({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: () => void }) {
  const { project } = useProject();
  const rules = useSuppressions(project.id);
  return (
    <Drawer open={open} onClose={onClose} width={600} title={<span className="flex items-center gap-2"><EyeOff size={16} className="text-muted" />Suppressed errors</span>}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <p className="text-[12.5px] text-muted">Errors matching a rule are dropped when they arrive, and stored ones are left out of the Overview. Deleting a rule brings back the stored ones; dropped errors are gone.</p>
        <Button size="sm" onClick={onAdd}><Plus size={13} />Rule</Button>
      </div>
      {rules.isPending ? <div className="space-y-2 p-4"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
        : !rules.data?.length ? <EmptyState icon={<EyeOff size={22} />} title="No suppressed errors">Open an error and click Suppress errors like this, or add a rule here.</EmptyState>
        : <div className="border-t border-line/60">{rules.data.map((r) => <RuleRow key={r.id} r={r} />)}</div>}
    </Drawer>
  );
}
