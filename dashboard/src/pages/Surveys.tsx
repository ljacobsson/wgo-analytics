import { useState } from 'react';
import { ArrowLeft, BarChart3, Download, ListTree, MessageSquareText, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import type { Survey, SurveyAnswer, SurveyQuestion, SurveyQuestionResult, SurveyResponse, SurveyResults, SurveyStatus } from '../api/contract';
import { fetchAllSurveyResponses, useDeleteSurvey, useSaveSurvey, useSurvey, useSurveyResponses, useSurveyResults, useSurveys } from '../api/hooks';
import { BarList } from '../charts/BarList';
import { Sparkline } from '../charts/Sparkline';
import { cn, fmtDateTime, fmtNum, relTime, shortId } from '../lib/format';
import { describeFilter, FILTER_PARAM } from '../lib/filters';
import { useProject } from '../lib/project';
import { navigate, pageHref, useRoute } from '../lib/router';
import { useTime } from '../lib/time';
import { Button, Card, CardHeader, EmptyState, ErrorState, Skeleton, useToast } from '../ui/kit';
import { InfoTip } from '../ui/InfoTip';
import { RowsSkeleton, TableHead } from './common';
import { SurveyEditor, typeLabel } from './SurveyEditor';

/** /surveys, /surveys/new, /surveys/{id}, /surveys/{id}/edit */
export function SurveysPage({ sub }: { sub?: string }) {
  const route = useRoute();
  const action = route.segments[4];
  if (sub === 'new') return <SurveyEditor key="new" id={null} />;
  if (sub && action === 'edit') return <SurveyEditor key={sub} id={sub} />;
  if (sub) return <SurveyResultsPage id={sub} />;
  return <SurveyList />;
}

const STATUS: Record<SurveyStatus, { label: string; dot: string }> = {
  active: { label: 'Active', dot: 'bg-good' },
  paused: { label: 'Paused', dot: 'bg-warn' },
  draft: { label: 'Draft', dot: 'bg-[var(--line-strong)]' },
};
function Status({ s }: { s: SurveyStatus }) {
  return <span className="inline-flex items-center gap-1.5 text-[12.5px]"><i className={cn('h-1.5 w-1.5 rounded-full', STATUS[s].dot)} />{STATUS[s].label}</span>;
}

/** "Floating card on /pricing, after 5 s" */
export function whereText(s: Pick<Survey, 'display' | 'targeting'>): string {
  const t = s.targeting;
  const how = s.display.mode === 'inline' ? `Inside ${s.display.selector}` : 'Floating card';
  const where = t.paths.length ? ` on ${t.paths.slice(0, 2).join(', ')}${t.paths.length > 2 ? ` +${t.paths.length - 2}` : ''}` : ' on every page';
  const when = [t.delaySec && `after ${t.delaySec} s`, t.scrollPct && `at ${t.scrollPct}% scrolled`, t.trigger?.length && `after ${t.trigger.map(describeFilter).join(' and ')}`].filter(Boolean).join(', ');
  return how + where + (when ? `, ${when}` : '');
}

const COLS = 'grid-cols-[minmax(240px,2fr)_100px_110px_130px_128px]';

function SurveyRow({ s }: { s: Survey }) {
  const { project } = useProject(); const route = useRoute();
  const del = useDeleteSurvey(project.id);
  const save = useSaveSurvey(project.id);
  const open = () => navigate(pageHref(project.id, `surveys/${s.id}`, route.params));
  return (
    <div className={`group grid ${COLS} items-center gap-4 border-b border-line/60 px-4 py-3 text-[13px] transition-colors hover:bg-[var(--hl)]`}>
      <div className="min-w-0">
        <button onClick={open} className="block max-w-full truncate text-left font-medium hover:text-accent hover:underline cursor-pointer">{s.name}</button>
        <div className="mt-0.5 truncate text-[12px] text-faint">{s.questions.length} question{s.questions.length === 1 ? '' : 's'} · {whereText(s)}</div>
      </div>
      <Status s={s.status} />
      <div className="text-right tnum">{fmtNum(s.responses)}</div>
      <div className="text-right text-[12.5px] text-muted" title={s.lastResponseAt ? fmtDateTime(s.lastResponseAt) : undefined}>{s.lastResponseAt ? relTime(s.lastResponseAt) : '–'}</div>
      <div className="flex items-center justify-end gap-0.5">
        <button onClick={open} className="rounded-md p-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="Results"><BarChart3 size={14} /></button>
        {s.status === 'active'
          ? <button onClick={() => save.mutate({ id: s.id, input: { status: 'paused' } })} className="rounded-md p-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="Pause: stop showing it"><Pause size={14} /></button>
          : <button onClick={() => save.mutate({ id: s.id, input: { status: 'active' } })} className="rounded-md p-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="Activate: show it on your site"><Play size={14} /></button>}
        <button onClick={() => navigate(pageHref(project.id, `surveys/${s.id}/edit`, route.params))} className="rounded-md p-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="Edit"><Pencil size={14} /></button>
        <button onClick={() => { if (confirm(`Delete survey “${s.name}” and its ${fmtNum(s.responses)} responses?`)) del.mutate(s.id); }} className="rounded-md p-1.5 text-muted hover:bg-bad/15 hover:text-bad cursor-pointer" title="Delete"><Trash2 size={14} /></button>
      </div>
    </div>
  );
}

function SurveyList() {
  const { project } = useProject(); const route = useRoute();
  const list = useSurveys(project.id);
  const create = () => navigate(pageHref(project.id, 'surveys/new', route.params));
  if (list.isError) return <ErrorState error={list.error} retry={() => list.refetch()} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p className="max-w-3xl text-[13px] text-muted">
          Ask your visitors questions right on your site: a floating card or a form inside your page, on the pages and at the moment you choose. The WGO script shows them, so there’s nothing to deploy.
        </p>
        <Button variant="primary" className="shrink-0" onClick={create}><Plus size={15} />New survey</Button>
      </div>
      <Card className="@container overflow-x-auto">
        <div className="min-w-[760px]">
          <TableHead className={COLS} cols={['Survey', 'Status', ['Responses', 'text-right'], ['Last response', 'text-right'], '']} />
          {!list.data ? <RowsSkeleton n={3} />
            : list.data.length === 0 ? (
              <EmptyState pinned icon={<MessageSquareText size={22} />} title="No surveys yet"
                action={<Button variant="primary" onClick={create}><Plus size={15} />Create a survey</Button>}>
                Build a survey with multiple choice, text, yes/no, rating and NPS questions, preview it, and turn it on. Answers show up here as they come in.
              </EmptyState>)
            : list.data.map((s) => <SurveyRow key={s.id} s={s} />)}
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- results

const fmtRate = (r: number | null) => (r == null ? '–' : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`);

export function answerText(q: SurveyQuestion | undefined, v: SurveyAnswer | undefined): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.join('; ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (q?.type === 'rating') return `${v} / ${q.scale ?? 5}`;
  return String(v);
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function responsesCsv(s: Pick<Survey, 'questions'>, rows: SurveyResponse[]): string {
  const head = ['Submitted at', 'Response id', 'User id', 'Anonymous id', 'Session id', 'Page', ...s.questions.map((q) => q.title)];
  const body = rows.map((r) => [r.createdAt, r.id, r.userId ?? '', r.anonId ?? '', r.sessionId ?? '', r.path ?? '', ...s.questions.map((q) => answerText(q, r.answers[q.id]))]);
  return [head, ...body].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function Stat({ label, value, sub, children }: { label: string; value: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className="mt-1 flex items-end justify-between gap-3">
        <div><div className="tnum text-[24px] font-semibold tracking-tight">{value}</div>{sub && <div className="text-[11.5px] text-faint">{sub}</div>}</div>
        {children}
      </div>
    </Card>
  );
}

function QuestionResult({ q, r, i }: { q: SurveyQuestion; r: SurveyQuestionResult | undefined; i: number }) {
  const answered = r?.answered ?? 0;
  const pct = (n: number) => (answered ? `${Math.round((n / answered) * 100)}%` : '');
  const header = <CardHeader title={<span className="flex items-baseline gap-2"><span className="tnum text-faint">{i + 1}.</span><span>{q.title}</span></span>} sub={`${typeLabel(q.type)} · ${fmtNum(answered)} answered`} />;
  let body: React.ReactNode = null;
  if (!answered) body = <p className="px-4 pb-4 text-[12.5px] text-faint">No answers in this range.</p>;
  else if (q.type === 'text') {
    body = (
      <ul className="max-h-[320px] divide-y divide-line/60 overflow-y-auto px-4 pb-2">
        {r!.texts!.map((t) => <li key={t.responseId} className="py-2 text-[13px]"><p className="whitespace-pre-wrap break-words">{t.text}</p><p className="mt-0.5 text-[11px] text-faint">{relTime(t.at)}</p></li>)}
        {answered > r!.texts!.length && <li className="py-2 text-[11.5px] text-faint">The newest {r!.texts!.length} of {fmtNum(answered)}. Export CSV for all of them.</li>}
      </ul>
    );
  } else {
    const rows = (r!.counts ?? []).map((c) => ({ key: c.value, label: q.type === 'rating' && (q.scale ?? 5) === 5 ? `${'★'.repeat(Number(c.value))}` : c.value, value: c.n, sub: pct(c.n) }));
    const nps = q.type === 'nps' && r!.nps !== undefined;
    const group = (lo: number, hi: number) => (r!.counts ?? []).filter((c) => Number(c.value) >= lo && Number(c.value) <= hi).reduce((a, c) => a + c.n, 0);
    body = (
      <>
        {(r!.average !== undefined) && (
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-4 pb-3">
            {nps && <div><span className="tnum text-[26px] font-semibold tracking-tight">{r!.nps! > 0 ? '+' : ''}{r!.nps}</span><span className="ml-1.5 text-[12px] text-muted">NPS</span></div>}
            <div><span className="tnum text-[18px] font-semibold">{r!.average.toFixed(1)}</span><span className="ml-1.5 text-[12px] text-muted">average{q.type === 'rating' ? ` of ${q.scale ?? 5}` : ''}</span></div>
            {nps && <div className="text-[12px] text-muted">{pct(group(9, 10))} promoters · {pct(group(7, 8))} passives · {pct(group(0, 6))} detractors</div>}
          </div>
        )}
        <BarList rows={rows} color="var(--s5)" />
      </>
    );
  }
  return <Card className={cn(q.type === 'nps' || q.type === 'rating' ? 'lg:row-span-1' : '')}>{header}{body}</Card>;
}

function Responses({ s }: { s: Survey }) {
  const { project } = useProject(); const route = useRoute(); const { range } = useTime();
  const res = useSurveyResponses(project.id, s.id, range);
  const rows = res.data?.pages.flatMap((p) => p.responses) ?? [];
  const shown = s.questions.slice(0, 3);
  // whole class names, so Tailwind finds them
  const cols = [
    'grid-cols-[150px_minmax(140px,1fr)_minmax(120px,1fr)_minmax(140px,1.4fr)_40px]',
    'grid-cols-[150px_minmax(140px,1fr)_minmax(120px,1fr)_minmax(140px,1.4fr)_minmax(140px,1.4fr)_40px]',
    'grid-cols-[150px_minmax(140px,1fr)_minmax(120px,1fr)_minmax(140px,1.4fr)_minmax(140px,1.4fr)_minmax(140px,1.4fr)_40px]',
  ][shown.length - 1];
  const sessionHref = (sid: string) => pageHref(project.id, 'events', route.params, { [FILTER_PARAM.events]: JSON.stringify([{ field: 'sessionId', op: 'eq', value: sid }]) });
  return (
    <Card className="overflow-x-auto">
      <CardHeader title="Responses" sub="Newest first" />
      <div className="min-w-[760px]">
        <TableHead className={cols} cols={['Submitted', 'Visitor', 'Page', ...shown.map((q) => q.title), '']} />
        {res.isLoading ? <RowsSkeleton n={4} />
          : !rows.length ? <p className="px-4 py-6 text-center text-[12.5px] text-faint">No responses in this range.</p>
          : rows.map((r) => (
            <div key={r.id} className={`grid ${cols} items-start gap-4 border-b border-line/60 px-4 py-2.5 text-[12.5px]`}>
              <span className="text-muted" title={fmtDateTime(r.createdAt)}>{relTime(r.createdAt)}</span>
              <span className="truncate" title={r.userId ?? r.anonId ?? ''}>{r.userId ?? <span className="font-mono text-faint">{shortId(r.anonId)}</span>}</span>
              <span className="truncate font-mono text-[12px] text-muted">{r.path ?? '–'}</span>
              {shown.map((q) => <span key={q.id} className="line-clamp-2 break-words">{answerText(q, r.answers[q.id]) || <span className="text-faint">–</span>}</span>)}
              <span className="flex justify-end">{r.sessionId && <button onClick={() => navigate(sessionHref(r.sessionId!))} className="rounded-md p-1 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="This visitor’s session in Events"><ListTree size={14} /></button>}</span>
            </div>
          ))}
        {res.hasNextPage && <div className="p-3 text-center"><Button size="sm" disabled={res.isFetchingNextPage} onClick={() => res.fetchNextPage()}>Load more</Button></div>}
        {s.questions.length > 3 && rows.length > 0 && <p className="px-4 py-2 text-[11.5px] text-faint">The table shows the first three questions. Export CSV for every answer.</p>}
      </div>
    </Card>
  );
}

function SurveyResultsPage({ id }: { id: string }) {
  const { project } = useProject(); const route = useRoute(); const { range } = useTime();
  const survey = useSurvey(project.id, id);
  const results = useSurveyResults(project.id, id, range);
  const save = useSaveSurvey(project.id);
  const del = useDeleteSurvey(project.id);
  const toast = useToast();
  const [exporting, setExporting] = useState(false);

  if (survey.isError) return <ErrorState error={survey.error} retry={() => survey.refetch()} />;
  const s = survey.data;
  if (!s) return <div className="space-y-4"><Skeleton className="h-10 w-80" /><div className="grid gap-4 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div><Skeleton className="h-64" /></div>;
  const r: SurveyResults | undefined = results.data;
  const rate = r && r.shown ? Math.min(1, r.responses / r.shown) : null;

  const exportCsv = async () => {
    setExporting(true);
    try {
      const rows = await fetchAllSurveyResponses(project.id, id, range);
      const url = URL.createObjectURL(new Blob([responsesCsv(s, rows)], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${s.name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'survey'}-responses.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast({ title: 'Export failed', body: (e as Error).message, tone: 'bad' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <button onClick={() => navigate(pageHref(project.id, 'surveys', route.params))} className="mt-0.5 rounded-lg p-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer" title="All surveys"><ArrowLeft size={17} /></button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-semibold tracking-tight">{s.name}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted"><Status s={s.status} /><span>{whereText(s)}</span></div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {s.status === 'active'
            ? <Button onClick={() => save.mutate({ id, input: { status: 'paused' } })}><Pause size={14} />Pause</Button>
            : <Button onClick={() => save.mutate({ id, input: { status: 'active' } }, { onSuccess: () => toast({ title: 'Survey active', body: 'Live on your site within a minute.', tone: 'good' }) })}><Play size={14} />Activate</Button>}
          <Button onClick={() => navigate(pageHref(project.id, `surveys/${id}/edit`, route.params))}><Pencil size={14} />Edit</Button>
          <Button disabled={exporting || !r?.responses} onClick={exportCsv}><Download size={14} />{exporting ? 'Exporting…' : 'Export CSV'}</Button>
          <button onClick={() => { if (confirm(`Delete survey “${s.name}” and all ${fmtNum(s.responses)} responses?`)) { del.mutate(id); navigate(pageHref(project.id, 'surveys', route.params)); } }}
            className="rounded-lg p-2 text-muted hover:bg-bad/15 hover:text-bad cursor-pointer" title="Delete"><Trash2 size={15} /></button>
        </div>
      </div>

      {results.isError ? <ErrorState error={results.error} retry={() => results.refetch()} /> : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Responses" value={r ? fmtNum(r.responses) : '…'} sub={`${fmtNum(s.responses)} all time`}>
              {r && r.responses > 0 && <div className="h-9 w-28"><Sparkline data={r.series} color="var(--s5)" height={36} /></div>}
            </Stat>
            <Stat label="Shown" value={r ? fmtNum(r.shown) : '…'} sub="times it appeared" />
            <Stat label="Response rate" value={fmtRate(rate)} sub={<span className="inline-flex items-center gap-1">responses ÷ shown
              <InfoTip label="How is it counted?">Shown and closed come from the <code>survey_shown</code> and <code>survey_dismissed</code> events the SDK sends, which are raw events: ranges older than the project’s retention count fewer. Responses are kept until you delete the survey.</InfoTip></span>} />
            <Stat label="Closed without answering" value={r ? fmtNum(r.dismissed) : '…'} sub={r && r.shown ? `${fmtRate(r.dismissed / r.shown)} of views` : undefined} />
          </div>
          {r?.truncated && <p className="text-[12px] text-warn">More than 20,000 responses in this range: the numbers below cover the newest 20,000. Pick a shorter range for exact numbers.</p>}
          {s.status === 'draft' && !s.responses && (
            <Card className="p-4 text-[13px] text-muted">This survey is a draft, so nobody sees it yet. <button className="font-medium text-accent hover:underline cursor-pointer" onClick={() => save.mutate({ id, input: { status: 'active' } })}>Activate it</button> to show it on your site.</Card>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            {s.questions.map((q, i) => <QuestionResult key={q.id} q={q} i={i} r={r?.questions.find((x) => x.id === q.id)} />)}
          </div>
          <Responses s={s} />
        </>
      )}
    </div>
  );
}
