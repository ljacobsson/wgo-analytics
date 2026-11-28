import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlignLeft, ArrowDown, ArrowLeft, ArrowUp, CircleDot, Copy, Gauge, ListChecks, Plus, Star, ThumbsUp, Trash2,
} from 'lucide-react';
import type { SurveyDisplay, SurveyInput, SurveyQuestion, SurveyQuestionType, SurveyStatus, SurveyTargeting } from '../api/contract';
import { useSaveSurvey, useSurvey } from '../api/hooks';
import { cn } from '../lib/format';
import { useProject } from '../lib/project';
import { navigate, pageHref, useRoute } from '../lib/router';
import { CodeBlock } from '../ui/CodeBlock';
import { Button, Card, ErrorState, Field, Segmented, Skeleton, Switch, useToast } from '../ui/kit';
import { Popover } from '../ui/Popover';
import { SurveyPreview } from '../ui/SurveyPreview';

export const QUESTION_TYPES: { type: SurveyQuestionType; label: string; hint: string; icon: ReactNode }[] = [
  { type: 'single', label: 'Single choice', hint: 'Pick one option', icon: <CircleDot size={15} /> },
  { type: 'multi', label: 'Multiple choice', hint: 'Pick any number of options', icon: <ListChecks size={15} /> },
  { type: 'text', label: 'Text', hint: 'A short or long written answer', icon: <AlignLeft size={15} /> },
  { type: 'yesno', label: 'Yes / no', hint: 'Two buttons', icon: <ThumbsUp size={15} /> },
  { type: 'rating', label: 'Rating', hint: '1 to 5 stars, or 1 to 10', icon: <Star size={15} /> },
  { type: 'nps', label: 'Net Promoter Score', hint: '0 to 10, how likely to recommend', icon: <Gauge size={15} /> },
];
export const typeLabel = (t: SurveyQuestionType) => QUESTION_TYPES.find((x) => x.type === t)?.label ?? t;

const nextId = (qs: SurveyQuestion[]) => {
  let n = qs.length + 1;
  const ids = new Set(qs.map((q) => q.id));
  while (ids.has(`q${n}`)) n++;
  return `q${n}`;
};

function newQuestion(type: SurveyQuestionType, qs: SurveyQuestion[]): SurveyQuestion {
  const q: SurveyQuestion = { id: nextId(qs), type, title: '', required: false };
  if (type === 'single' || type === 'multi') q.options = ['', ''];
  if (type === 'rating') q.scale = 5;
  if (type === 'nps') { q.title = 'How likely are you to recommend us to a friend or colleague?'; q.lowLabel = 'Not at all likely'; q.highLabel = 'Extremely likely'; q.required = true; }
  return q;
}

/** Changing the type keeps the title and drops what the new type doesn't use. */
function retype(q: SurveyQuestion, type: SurveyQuestionType): SurveyQuestion {
  const out: SurveyQuestion = { id: q.id, type, title: q.title, required: q.required };
  if (q.description) out.description = q.description;
  if (type === 'single' || type === 'multi') out.options = q.options?.length ? q.options : ['', ''];
  if (type === 'rating') out.scale = q.scale ?? 5;
  if ((type === 'rating' || type === 'nps') && (q.type === 'rating' || q.type === 'nps')) { out.lowLabel = q.lowLabel; out.highLabel = q.highLabel; }
  if (type === 'text') { out.long = q.long; out.placeholder = q.placeholder; }
  return out;
}

const TEMPLATES: { name: string; label: string; build: () => Pick<SurveyInput, 'questions' | 'display'> }[] = [
  {
    name: 'NPS', label: 'Net Promoter Score',
    build: () => ({
      questions: [
        { ...newQuestion('nps', []), id: 'q1' },
        { id: 'q2', type: 'text', title: 'What is the main reason for your score?', required: false, long: true },
      ],
      display: { mode: 'popover', position: 'bottom-right', layout: 'steps', theme: 'auto' },
    }),
  },
  {
    name: 'Page feedback', label: 'Was this page helpful?',
    build: () => ({
      questions: [
        { id: 'q1', type: 'yesno', title: 'Was this page helpful?', required: true },
        { id: 'q2', type: 'text', title: 'How could we improve it?', required: false },
      ],
      display: { mode: 'inline', selector: '#feedback', layout: 'form', theme: 'auto', submitLabel: 'Send feedback' },
    }),
  },
  {
    name: 'Product feedback', label: 'A short product survey',
    build: () => ({
      questions: [
        { id: 'q1', type: 'single', title: 'What best describes you?', required: true, options: ['Developer', 'Product manager', 'Designer', 'Something else'] },
        { id: 'q2', type: 'multi', title: 'Which features do you use?', required: false, options: ['Dashboards', 'Alerts', 'Reports', 'Integrations'] },
        { id: 'q3', type: 'rating', title: 'How satisfied are you overall?', required: true, scale: 5 },
        { id: 'q4', type: 'text', title: 'What should we build next?', required: false, long: true },
      ],
      display: { mode: 'popover', position: 'bottom-right', layout: 'steps', theme: 'auto' },
    }),
  },
];

export function blankSurvey(): SurveyInput {
  return {
    name: '',
    status: 'draft',
    questions: [newQuestion('single', [])],
    display: { mode: 'popover', position: 'bottom-right', layout: 'steps', theme: 'auto' },
    targeting: { paths: [], frequency: 'once' },
  };
}

/** What's wrong with the survey before saving, if anything (the API checks it again). */
export function problems(s: SurveyInput): string[] {
  const out: string[] = [];
  if (!s.name.trim()) out.push('Give the survey a name.');
  if (!s.questions.length) out.push('Add at least one question.');
  s.questions.forEach((q, i) => {
    if (!q.title.trim()) out.push(`Question ${i + 1} needs a title.`);
    if (q.type === 'single' || q.type === 'multi') {
      const opts = (q.options ?? []).map((o) => o.trim());
      if (opts.filter(Boolean).length < 2 || opts.some((o) => !o)) out.push(`Question ${i + 1} needs at least 2 options, none empty.`);
      else if (new Set(opts).size !== opts.length) out.push(`Question ${i + 1} has the same option twice.`);
    }
  });
  if (s.display.mode === 'inline') {
    const sel = s.display.selector?.trim();
    if (!sel) out.push('An inline survey needs the CSS selector of the element to render into.');
    else { try { document.createDocumentFragment().querySelector(sel); } catch { out.push(`“${sel}” isn’t a valid CSS selector.`); } }
  }
  if (s.targeting.paths.some((p) => !p.startsWith('/') && !p.startsWith('*'))) out.push('Paths start with /, e.g. /pricing or /docs/*.');
  return out;
}

/** Trims what the visitor sees; leaves empty optional text out. */
function cleaned(s: SurveyInput): SurveyInput {
  return {
    ...s,
    name: s.name.trim(),
    questions: s.questions.map((q) => ({
      ...q,
      title: q.title.trim(),
      description: q.description?.trim() || undefined,
      options: q.options?.map((o) => o.trim()),
      placeholder: q.placeholder?.trim() || undefined,
      lowLabel: q.lowLabel?.trim() || undefined,
      highLabel: q.highLabel?.trim() || undefined,
    })),
    display: { ...s.display, selector: s.display.selector?.trim() || undefined, submitLabel: s.display.submitLabel?.trim() || undefined, thankYou: s.display.thankYou?.trim() || undefined },
    targeting: { ...s.targeting, paths: s.targeting.paths.map((p) => p.trim()).filter(Boolean), event: s.targeting.event?.trim() || undefined },
  };
}

const iconBtn = 'rounded-md p-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent';

function AddQuestion({ onAdd }: { onAdd: (t: SurveyQuestionType) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <span ref={ref} className="inline-block"><Button onClick={() => setOpen(true)}><Plus size={14} />Add question</Button></span>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align="start" width={280}>
        <div className="p-1">
          {QUESTION_TYPES.map((t) => (
            <button key={t.type} onClick={() => { onAdd(t.type); setOpen(false); }} className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-[var(--hl)] cursor-pointer">
              <span className="mt-0.5 text-muted">{t.icon}</span>
              <span><span className="block text-[13px] font-medium">{t.label}</span><span className="block text-[11.5px] text-faint">{t.hint}</span></span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

function QuestionEditor({ q, i, n, active, onFocus, onChange, onMove, onDuplicate, onDelete }: {
  q: SurveyQuestion; i: number; n: number; active: boolean; onFocus: () => void; onChange: (q: SurveyQuestion) => void;
  onMove: (d: -1 | 1) => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const set = (patch: Partial<SurveyQuestion>) => onChange({ ...q, ...patch });
  const [showDesc, setShowDesc] = useState(!!q.description);
  const opts = q.options ?? [];
  const setOpt = (j: number, v: string) => set({ options: opts.map((o, k) => (k === j ? v : o)) });
  return (
    <div onFocusCapture={onFocus} onClick={onFocus}
      className={cn('rounded-xl border p-3.5 transition-colors', active ? 'border-accent/50 bg-accent/[.04]' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-6 text-[12px] font-semibold tnum text-faint">{i + 1}.</span>
        <select className="field !w-auto !py-1 text-[12.5px]" value={q.type} onChange={(e) => onChange(retype(q, e.target.value as SurveyQuestionType))} aria-label="Question type">
          {QUESTION_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
        <span className="ml-1"><Switch checked={q.required} onChange={(b) => set({ required: b })} label="Required" /></span>
        <div className="ml-auto flex items-center">
          <button className={iconBtn} disabled={i === 0} onClick={() => onMove(-1)} title="Move up"><ArrowUp size={14} /></button>
          <button className={iconBtn} disabled={i === n - 1} onClick={() => onMove(1)} title="Move down"><ArrowDown size={14} /></button>
          <button className={iconBtn} onClick={onDuplicate} title="Duplicate"><Copy size={14} /></button>
          <button className={cn(iconBtn, 'hover:!bg-bad/15 hover:!text-bad')} disabled={n === 1} onClick={onDelete} title="Delete"><Trash2 size={14} /></button>
        </div>
      </div>
      <div className="mt-3 space-y-2.5 pl-8">
        <input className="field text-[13.5px] font-medium" value={q.title} onChange={(e) => set({ title: e.target.value })} placeholder="Question" maxLength={300} />
        {showDesc
          ? <input className="field text-[12.5px]" value={q.description ?? ''} onChange={(e) => set({ description: e.target.value })} placeholder="Description (optional)" maxLength={500} />
          : <button className="text-[12px] text-muted hover:text-fg cursor-pointer" onClick={() => setShowDesc(true)}>Add a description</button>}

        {(q.type === 'single' || q.type === 'multi') && (
          <div className="space-y-1.5">
            {opts.map((o, j) => (
              <div key={j} className="flex items-center gap-2">
                <span className={cn('h-3.5 w-3.5 shrink-0 border border-[var(--line-strong)]', q.type === 'single' ? 'rounded-full' : 'rounded-[3px]')} />
                <input className="field !py-1.5 text-[12.5px]" value={o} onChange={(e) => setOpt(j, e.target.value)} placeholder={`Option ${j + 1}`} maxLength={200}
                  onKeyDown={(e) => { if (e.key === 'Enter' && opts.length < 20) { e.preventDefault(); set({ options: [...opts.slice(0, j + 1), '', ...opts.slice(j + 1)] }); } }} />
                <button className={iconBtn} disabled={opts.length <= 2} onClick={() => set({ options: opts.filter((_, k) => k !== j) })} title="Remove option"><Trash2 size={13} /></button>
              </div>
            ))}
            {opts.length < 20 && <button className="ml-5.5 text-[12px] text-muted hover:text-fg cursor-pointer" onClick={() => set({ options: [...opts, ''] })}>Add option</button>}
          </div>
        )}
        {q.type === 'text' && (
          <div className="flex flex-wrap items-center gap-3">
            <Segmented value={q.long ? 'long' : 'short'} onChange={(v) => set({ long: v === 'long' || undefined })} options={[{ value: 'short', label: 'One line' }, { value: 'long', label: 'Paragraph' }]} />
            <input className="field !w-auto min-w-[200px] flex-1 !py-1.5 text-[12.5px]" value={q.placeholder ?? ''} onChange={(e) => set({ placeholder: e.target.value })} placeholder="Placeholder (optional)" maxLength={200} />
          </div>
        )}
        {(q.type === 'rating' || q.type === 'nps') && (
          <div className="flex flex-wrap items-center gap-2">
            {q.type === 'rating' && <Segmented value={String(q.scale ?? 5) as '5' | '10'} onChange={(v) => set({ scale: Number(v) as 5 | 10 })} options={[{ value: '5', label: '5 stars' }, { value: '10', label: '1 to 10' }]} />}
            <input className="field !w-auto min-w-[140px] flex-1 !py-1.5 text-[12.5px]" value={q.lowLabel ?? ''} onChange={(e) => set({ lowLabel: e.target.value })} placeholder="Label under the lowest (optional)" maxLength={60} />
            <input className="field !w-auto min-w-[140px] flex-1 !py-1.5 text-[12.5px]" value={q.highLabel ?? ''} onChange={(e) => set({ highLabel: e.target.value })} placeholder="Label under the highest (optional)" maxLength={60} />
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-4 sm:p-5">
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {sub && <p className="mt-0.5 text-[12.5px] text-muted">{sub}</p>}
      <div className="mt-4">{children}</div>
    </Card>
  );
}

function Choice<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; hint: string }[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={cn('rounded-lg border px-3 py-2.5 text-left transition-colors cursor-pointer', value === o.value ? 'border-accent/60 bg-accent/[.06]' : 'border-line hover:bg-[var(--hl)]')}>
          <span className="block text-[12.5px] font-medium">{o.label}</span>
          <span className="mt-0.5 block text-[11.5px] leading-snug text-faint">{o.hint}</span>
        </button>
      ))}
    </div>
  );
}

function DisplayEditor({ d, set }: { d: SurveyDisplay; set: (p: Partial<SurveyDisplay>) => void }) {
  return (
    <div className="space-y-4">
      <Choice value={d.mode} onChange={(mode) => set(mode === 'inline' ? { mode, layout: 'form', selector: d.selector ?? '#feedback' } : { mode, layout: 'steps', position: d.position ?? 'bottom-right' })} options={[
        { value: 'popover', label: 'Floating card', hint: 'Slides in at the bottom corner of the page; visitors can close it.' },
        { value: 'inline', label: 'Inside an element', hint: 'Rendered into an element of your page, like a form you placed there.' },
      ]} />
      <div className="grid gap-4 sm:grid-cols-2">
        {d.mode === 'inline'
          ? <Field label="CSS selector of the element" hint="The survey is added at the end of the first element that matches."><input className="field font-mono text-[12.5px]" value={d.selector ?? ''} onChange={(e) => set({ selector: e.target.value })} placeholder="#feedback" maxLength={300} /></Field>
          : <Field label="Corner"><Segmented value={d.position ?? 'bottom-right'} onChange={(position) => set({ position })} options={[{ value: 'bottom-left', label: 'Bottom left' }, { value: 'bottom-right', label: 'Bottom right' }]} /></Field>}
        <Field label="Questions"><Segmented value={d.layout} onChange={(layout) => set({ layout })} options={[{ value: 'steps', label: 'One at a time' }, { value: 'form', label: 'All on one form' }]} /></Field>
        <Field label="Colours"><Segmented value={d.theme} onChange={(theme) => set({ theme })} options={[{ value: 'auto', label: 'Match visitor' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} /></Field>
        <Field label="Accent">
          <div className="flex items-center gap-2">
            <input type="color" className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-line bg-transparent p-0.5" value={d.accent ?? '#4f46e5'} onChange={(e) => set({ accent: e.target.value })} aria-label="Accent colour" />
            <input className="field font-mono text-[12.5px]" value={d.accent ?? ''} onChange={(e) => set({ accent: e.target.value || undefined })} placeholder="#4f46e5" maxLength={7} />
          </div>
        </Field>
        <Field label="Submit button"><input className="field" value={d.submitLabel ?? ''} onChange={(e) => set({ submitLabel: e.target.value })} placeholder="Submit" maxLength={40} /></Field>
        <Field label="Thank-you message"><input className="field" value={d.thankYou ?? ''} onChange={(e) => set({ thankYou: e.target.value })} placeholder="Thanks for your feedback!" maxLength={300} /></Field>
      </div>
    </div>
  );
}

function TargetingEditor({ t, set }: { t: SurveyTargeting; set: (p: Partial<SurveyTargeting>) => void }) {
  const [paths, setPaths] = useState(t.paths.join('\n'));
  useEffect(() => { if (paths.split('\n').map((p) => p.trim()).filter(Boolean).join('\n') !== t.paths.join('\n')) setPaths(t.paths.join('\n')); }, [t.paths]); // eslint-disable-line react-hooks/exhaustive-deps
  const num = (v: string) => (v.trim() === '' ? undefined : Math.max(0, Math.round(Number(v)) || 0));
  return (
    <div className="space-y-4">
      <Field label="Pages" hint="One path per line; * matches anything, e.g. /docs/*. Leave empty for every page.">
        <textarea className="field min-h-[72px] font-mono text-[12.5px]" value={paths} placeholder={'/pricing\n/docs/*'}
          onChange={(e) => { setPaths(e.target.value); set({ paths: e.target.value.split('\n').map((p) => p.trim()).filter(Boolean) }); }} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="After seconds on the page"><input className="field" inputMode="numeric" value={t.delaySec ?? ''} onChange={(e) => set({ delaySec: num(e.target.value) })} placeholder="Right away" /></Field>
        <Field label="After scrolling (% of page)"><input className="field" inputMode="numeric" value={t.scrollPct ?? ''} onChange={(e) => set({ scrollPct: num(e.target.value) && Math.min(100, num(e.target.value)!) })} placeholder="No need" /></Field>
        <Field label="After this custom event"><input className="field font-mono text-[12.5px]" value={t.event ?? ''} onChange={(e) => set({ event: e.target.value || undefined })} placeholder="checkout_completed" maxLength={200} /></Field>
      </div>
      <p className="-mt-1 text-[11.5px] text-faint">All the conditions you set must be met on the same page. The event is the name your page sends with <code>WGO.track('…')</code>.</p>
      <Field label="How often">
        <Choice value={t.frequency} onChange={(frequency) => set({ frequency })} options={[
          { value: 'once', label: 'Once per visitor', hint: 'Never again after they answer or close it.' },
          { value: 'until_answered', label: 'Until answered', hint: 'A closed survey comes back in their next session.' },
          { value: 'always', label: 'Every time', hint: 'On every matching page view, e.g. a feedback form.' },
        ]} />
      </Field>
    </div>
  );
}

/** /surveys/new and /surveys/{id}/edit */
export function SurveyEditor({ id }: { id: string | null }) {
  const { project } = useProject();
  const route = useRoute();
  const existing = useSurvey(project.id, id);
  const save = useSaveSurvey(project.id);
  const toast = useToast();
  const [draft, setDraft] = useState<SurveyInput | null>(id ? null : blankSurvey());
  const [saved, setSaved] = useState<string>(id ? '' : JSON.stringify(blankSurvey()));
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!id || !existing.data || draft) return;
    const { name, status, questions, display, targeting } = existing.data;
    const s = { name, status, questions, display, targeting };
    setDraft(s);
    setSaved(JSON.stringify(s));
  }, [existing.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const issues = useMemo(() => (draft ? problems(draft) : []), [draft]);
  const dirty = !!draft && JSON.stringify(draft) !== saved;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (id && existing.isError) return <ErrorState error={existing.error} retry={() => existing.refetch()} />;
  if (!draft) return <div className="space-y-4"><Skeleton className="h-10 w-80" /><Skeleton className="h-[60vh]" /></div>;

  const set = (patch: Partial<SurveyInput>) => setDraft((d) => ({ ...d!, ...patch }));
  const setQ = (i: number, q: SurveyQuestion) => set({ questions: draft.questions.map((x, k) => (k === i ? q : x)) });
  const back = () => {
    if (dirty && !confirm('Leave without saving your changes?')) return;
    navigate(pageHref(project.id, id ? `surveys/${id}` : 'surveys', route.params));
  };
  const submit = async (status?: SurveyStatus) => {
    setTried(true);
    if (issues.length) return;
    setError('');
    const input = cleaned(status ? { ...draft, status } : draft);
    try {
      const s = await save.mutateAsync({ id: id ?? undefined, input });
      const next = { name: s.name, status: s.status, questions: s.questions, display: s.display, targeting: s.targeting };
      setDraft(next);
      setSaved(JSON.stringify(next));
      toast({ title: id ? 'Survey saved' : 'Survey created', body: s.status === 'active' ? 'Live on your site within a minute.' : s.name, tone: 'good' });
      if (!id) navigate(pageHref(project.id, `surveys/${s.id}`, route.params), true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const isNew = !id;
  const live = draft.status === 'active';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={back} className="rounded-lg p-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="Back"><ArrowLeft size={17} /></button>
        <input className="field !w-auto min-w-[240px] flex-1 !bg-transparent !border-transparent hover:!border-line focus:!border-accent text-[17px] font-semibold"
          value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Survey name (only you see it)" maxLength={120} autoFocus={isNew} />
        <div className="flex items-center gap-2">
          <Segmented value={draft.status} onChange={(status) => set({ status })} options={[{ value: 'draft', label: 'Draft' }, { value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }]} />
          <Button variant="primary" disabled={save.isPending || (!dirty && !isNew)} onClick={() => submit()}>{isNew ? (live ? 'Create and publish' : 'Create survey') : 'Save'}</Button>
        </div>
      </div>
      {(error || (tried && issues.length > 0)) && (
        <div className="rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">
          {error || <ul className="list-inside list-disc space-y-0.5">{issues.map((x) => <li key={x}>{x}</li>)}</ul>}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="min-w-0 space-y-4">
          <Section title="Questions" sub={isNew ? <>Start from scratch or from {TEMPLATES.map((t, i) => (
            <span key={t.name}>{i > 0 && (i === TEMPLATES.length - 1 ? ' or ' : ', ')}<button className="font-medium text-accent hover:underline cursor-pointer" title={t.label}
              onClick={() => { const b = t.build(); set({ ...b, name: draft.name || t.name }); setActive(0); }}>{t.name === 'NPS' ? t.name : t.name.toLowerCase()}</button></span>
          ))}.</> : undefined}>
            <div className="space-y-2.5">
              {draft.questions.map((q, i) => (
                <QuestionEditor key={q.id} q={q} i={i} n={draft.questions.length} active={i === active}
                  onFocus={() => setActive(i)} onChange={(nq) => setQ(i, nq)}
                  onMove={(d) => { const qs = [...draft.questions]; [qs[i], qs[i + d]] = [qs[i + d], qs[i]]; set({ questions: qs }); setActive(i + d); }}
                  onDuplicate={() => { const qs = [...draft.questions]; qs.splice(i + 1, 0, { ...q, id: nextId(qs) }); set({ questions: qs }); setActive(i + 1); }}
                  onDelete={() => { set({ questions: draft.questions.filter((_, k) => k !== i) }); setActive(Math.max(0, i - 1)); }} />
              ))}
            </div>
            {draft.questions.length < 20 && <div className="mt-3"><AddQuestion onAdd={(t) => { set({ questions: [...draft.questions, newQuestion(t, draft.questions)] }); setActive(draft.questions.length); }} /></div>}
          </Section>

          <Section title="Appearance">
            <DisplayEditor d={draft.display} set={(p) => set({ display: { ...draft.display, ...p } })} />
          </Section>

          <Section title="Who sees it, and when">
            <TargetingEditor t={draft.targeting} set={(p) => set({ targeting: { ...draft.targeting, ...p } })} />
          </Section>

          <Section title="On your site" sub="Surveys are shown by the WGO script you already installed, so there’s nothing to deploy. Once a survey is active, it reaches visitors within about a minute.">
            <div className="space-y-3 text-[12.5px] text-muted">
              {draft.display.mode === 'inline' && <>
                <p>Add the element the survey goes into wherever it should appear:</p>
                <CodeBlock lang="html" code={elementFor(draft.display.selector)} />
              </>}
              <p>To open it from your own code, e.g. after a purchase, whatever its pages and conditions say{isNew ? ' (the id appears once it’s created)' : ''}:</p>
              <CodeBlock lang="js" code={`WGO.showSurvey('${id ?? '<survey id>'}')`} />
              <p className="text-[11.5px] text-faint">Showing, closing and answering it also send the custom events <code>survey_shown</code>, <code>survey_dismissed</code> and <code>survey_sent</code> (with <code>survey_id</code> and <code>survey_name</code>), so you can use them in goals, funnels and triggers.</p>
            </div>
          </Section>
        </div>

        <div className="min-w-0 xl:sticky xl:top-4 xl:self-start">
          <SurveyPreview survey={draft} step={draft.display.layout === 'steps' ? active : 0} path={draft.targeting.paths[0]?.replace(/\*/g, 'page')} />
        </div>
      </div>
    </div>
  );
}

/** An element the selector matches: `#feedback` → <div id="feedback">, `.survey` → <div class="survey">. */
function elementFor(sel: string | undefined): string {
  const s = sel?.trim() ?? '';
  const id = /^#([\w-]+)$/.exec(s);
  if (id) return `<div id="${id[1]}"></div>`;
  const cls = /^\.([\w-]+)$/.exec(s);
  if (cls) return `<div class="${cls[1]}"></div>`;
  const attr = /^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/.exec(s);
  if (attr) return attr[2] ? `<div ${attr[1]}="${attr[2]}"></div>` : `<div ${attr[1]}></div>`;
  return `<!-- any element matching ${s || 'your selector'} -->`;
}
