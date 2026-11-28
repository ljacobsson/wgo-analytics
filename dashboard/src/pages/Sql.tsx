import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditorView } from '@codemirror/view';
import type { EditorState, Extension, StateEffect } from '@codemirror/state';
import { setDiagnostics } from '@codemirror/lint';
import {
  AlertTriangle, BarChart3, BookOpen, ChevronRight, Clock, Copy, Database, Download, History, Loader2, Play, Search, Square, Table2, Trash2,
} from 'lucide-react';
import type { SqlResult, SqlSchema } from '../api/contract';
import { exportSql, runSql, useFields, useSqlSchema } from '../api/hooks';
import { useProject } from '../lib/project';
import { useTime } from '../lib/time';
import { cn, copy, fmtNum, relTime } from '../lib/format';
import { Button, Card, CopyButton, Dialog, Drawer, EmptyState, Kbd, Segmented, useToast } from '../ui/kit';
import { Popover } from '../ui/Popover';
import { editorExtensions, editorState, runnable, type CompletionData } from '../sql/editor';
import { TabBar, type TabInfo } from '../sql/TabBar';
import { ResultsGrid, cellText } from '../sql/ResultsGrid';
import { errorRange, isBlank } from '../sql/statements';
import { resolveChart, suggestChart, tileSql, type ChartSpec } from '../sql/chart';
import { ChartConfig } from '../sql/ChartConfig';
import { takeHandoff } from '../sql/handoff';
import { SqlChart } from '../sql/SqlChart';
import { AddToDashboard } from '../dashboards/AddToDashboard';

// ---------------------------------------------------------------- saved state (per project, in this browser)

const store = {
  get<T>(key: string, fallback: T): T {
    try { const v = localStorage.getItem(key); return v === null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
  },
  set(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* full or disabled */ } },
};

interface HistoryEntry { sql: string; at: number; ms?: number; rows?: number; truncated?: boolean; error?: string }
const MAX_HISTORY = 100;

const EXAMPLES: Array<{ title: string; sql: string }> = [
  { title: 'Most viewed pages', sql: `SELECT path, count(*) AS views, count(DISTINCT anon_id) AS visitors
FROM events
WHERE type = 'pageview'
GROUP BY path
ORDER BY views DESC
LIMIT 20;` },
  { title: 'Visitors and sessions per day', sql: `SELECT date_trunc('day', ts) AS day,
       count(DISTINCT anon_id) AS visitors,
       count(DISTINCT session_id) AS sessions
FROM events
WHERE bot IS NULL
GROUP BY ALL
ORDER BY day;` },
  { title: 'Custom events and their properties', sql: `SELECT ts, name, props->'props' AS properties, user_id
FROM events
WHERE type = 'custom'
ORDER BY ts DESC
LIMIT 100;` },
  { title: 'Most frequent JavaScript errors', sql: `SELECT fingerprint, any_value(error_message) AS message,
       count(*) AS errors, count(DISTINCT session_id) AS sessions
FROM events
WHERE type = 'error'
GROUP BY fingerprint
ORDER BY errors DESC
LIMIT 20;` },
  { title: 'Web Vitals at p75 per page', sql: `SELECT path,
       quantile_cont((props->>'lcp')::DOUBLE, 0.75) AS lcp_ms,
       quantile_cont((props->>'inp')::DOUBLE, 0.75) AS inp_ms,
       quantile_cont((props->>'cls')::DOUBLE, 0.75) AS cls,
       count(*) AS samples
FROM events
WHERE type = 'vitals'
GROUP BY path
ORDER BY samples DESC;` },
  { title: 'Slowest server endpoints (p95)', sql: `SELECT service, name, count(*) AS spans,
       round(quantile_cont(duration_ms, 0.95), 1) AS p95_ms
FROM spans
WHERE kind = 2 -- server spans
GROUP BY ALL
ORDER BY p95_ms DESC
LIMIT 20;` },
  { title: 'Error logs per service and hour', sql: `SELECT time_bucket(INTERVAL 1 HOUR, ts) AS hour, service, count(*) AS errors
FROM logs
WHERE severity_number >= 17
GROUP BY ALL
ORDER BY hour DESC, errors DESC;` },
];

const STARTER = `-- DuckDB SQL over this project's data, for the time range picked at the top.
-- Tables: events, logs, spans, metric_points, checks, replays, visitor_days, identities.
-- Put the cursor in a query and press ⌘↵ (Ctrl+Enter) to run it. Ctrl+Space suggests names.

${EXAMPLES[0].sql}

${EXAMPLES[1].sql}
`;

const LIMITS = [100, 1000, 10000] as const;
const firstLine = (s: string) => s.split('\n')[0];
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
const fmtSecs = (ms: number) => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);

type RunState =
  | { status: 'idle' }
  | { status: 'running'; sql: string; startedAt: number }
  | { status: 'done'; sql: string; from: string; to: string; result: SqlResult }
  | { status: 'error'; sql: string; message: string };
const IDLE: RunState = { status: 'idle' };

/** How a tab shows its results: the rows, or a chart (`chart`: the columns chosen; the rest is picked from the result). */
interface TabView { view: 'table' | 'chart'; chart?: ChartSpec; chartFor?: string }
/** The result columns a chart was chosen for: a query with other columns gets a suggested chart again. */
const columnsKey = (r: SqlResult) => r.columns.map((c) => c.name).join('\u0000');
interface SavedTab extends Partial<TabView> { id: string; name: string; doc: string; cursor?: number }
interface SavedTabs { active: string; tabs: SavedTab[] }

/** The project's tabs as this browser saved them; the first visit gets one tab with the starter queries. */
function loadTabs(pid: string): SavedTabs {
  const saved = store.get<SavedTabs | null>(`wgo.sql.tabs.${pid}`, null);
  const tabs = (Array.isArray(saved?.tabs) ? saved!.tabs : [])
    .filter((t) => t && typeof t.id === 'string' && typeof t.doc === 'string')
    .map((t) => ({ ...t, name: typeof t.name === 'string' && t.name.trim() ? t.name : 'Query' }));
  if (tabs.length) return { active: tabs.some((t) => t.id === saved!.active) ? saved!.active : tabs[0].id, tabs };
  // before tabs, the editor kept a single document
  const doc = store.get<string>(`wgo.sql.doc.${pid}`, STARTER);
  const first = doc.search(/^(select|from|with)\b/im);
  return { active: 'q1', tabs: [{ id: 'q1', name: 'Query 1', doc, cursor: first > 0 ? first : 0 }] };
}

/** "Query n" with the next free number */
function nextName(tabs: TabInfo[]): string {
  const used = tabs.map((t) => Number(/^Query (\d+)$/.exec(t.name)?.[1] ?? 0));
  return `Query ${Math.max(0, ...used) + 1}`;
}

// ---------------------------------------------------------------- page

export default function SqlPage() {
  const { project } = useProject();
  const { range } = useTime();
  const toast = useToast();
  const pid = project.id;
  const schema = useSqlSchema(pid);
  const fieldsEvents = useFields(pid, range, 'events');
  const fieldsLogs = useFields(pid, range, 'logs');
  const fieldsSpans = useFields(pid, range, 'spans');
  const fieldsMetrics = useFields(pid, range, 'metrics');

  const tabsKey = `wgo.sql.tabs.${pid}`, historyKey = `wgo.sql.history.${pid}`;
  const initial = useMemo(() => loadTabs(pid), [pid]);
  const [tabs, setTabs] = useState<TabInfo[]>(() => initial.tabs.map(({ id, name }) => ({ id, name })));
  const [active, setActive] = useState(initial.active);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [views, setViews] = useState<Record<string, TabView>>(() => Object.fromEntries(initial.tabs.map((t) => [t.id, { view: t.view === 'chart' ? 'chart' : 'table', chart: t.chart, chartFor: t.chartFor }])));
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const [closing, setClosing] = useState<TabInfo | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(() => store.get(historyKey, []));
  const [limit, setLimit] = useState<number>(() => store.get('wgo.sql.limit', 1000));
  const [editorH, setEditorH] = useState<number>(() => store.get('wgo.sql.editorH', 300));
  const [selected, setSelected] = useState<number | null>(null);
  const [exporting, setExporting] = useState<'csv' | 'ndjson' | null>(null);
  const [panel, setPanel] = useState<'tables' | 'history'>('tables');
  const run = runs[active] ?? IDLE;
  const setRunFor = useCallback((id: string, r: RunState) => setRuns((m) => ({ ...m, [id]: r })), []);

  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const layout = useRef<HTMLDivElement>(null);
  // the tabs, as refs for the editor's callbacks (created once)
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(active);
  activeRef.current = active;
  /** editor state of every tab opened in this visit (the active tab's live state is view.state) */
  const states = useRef(new Map<string, EditorState>());
  /** saved tabs not opened yet: their text and cursor */
  const unopened = useRef(new Map(initial.tabs.map((t) => [t.id, t])));
  const scrolls = useRef(new Map<string, StateEffect<unknown>>());
  const extensions = useRef<Extension[]>([]);
  const aborts = useRef(new Map<string, AbortController>());
  /** tabs whose editor shows an error underline */
  const marked = useRef(new Set<string>());

  // what autocomplete knows: tables, functions, keywords, and JSON keys seen in the data
  const data = useRef<CompletionData | null>(null);
  useEffect(() => {
    if (!schema.data) return;
    const discovered: Record<string, string[]> = {
      events: fieldsEvents.data?.discovered.map((f) => f.field) ?? [],
      logs: fieldsLogs.data?.discovered.map((f) => f.field) ?? [],
      spans: fieldsSpans.data?.discovered.map((f) => f.field) ?? [],
      metric_points: fieldsMetrics.data?.discovered.map((f) => f.field) ?? [],
    };
    data.current = {
      tables: schema.data.tables, functions: schema.data.functions, keywords: schema.data.keywords,
      jsonKeys: (table, column, path) => {
        const prefix = [column, ...path].join('.') + '.';
        const keys: string[] = [];
        for (const f of discovered[table] ?? []) {
          if (!f.startsWith(prefix)) continue;
          // event props nest (props.props.plan); OTel attribute keys keep their dots (http.route)
          const k = table === 'events' ? f.slice(prefix.length).split('.')[0] : f.slice(prefix.length);
          if (!keys.includes(k)) keys.push(k);
        }
        return keys;
      },
    };
  }, [schema.data, fieldsEvents.data, fieldsLogs.data, fieldsSpans.data, fieldsMetrics.data]);

  // ---------------- tabs: kept in this browser, per project

  const stateFor = useCallback((id: string): EditorState => {
    const s = states.current.get(id);
    if (s) return s;
    const t = unopened.current.get(id);
    const st = editorState(t?.doc ?? '', t?.cursor, extensions.current);
    states.current.set(id, st);
    unopened.current.delete(id);
    return st;
  }, []);

  const textOf = (id: string) => {
    const st = id === activeRef.current && view.current ? view.current.state : states.current.get(id);
    return st ? { doc: st.doc.toString(), cursor: st.selection.main.head } : { doc: unopened.current.get(id)?.doc ?? '', cursor: unopened.current.get(id)?.cursor };
  };

  const save = useCallback(() => {
    store.set(tabsKey, { active: activeRef.current, tabs: tabsRef.current.map((t) => ({ id: t.id, name: t.name, ...textOf(t.id), ...viewsRef.current[t.id] })) } satisfies SavedTabs);
    try { localStorage.removeItem(`wgo.sql.doc.${pid}`); } catch { /* disabled */ } // the single editor before tabs
  }, [tabsKey, pid]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveSoon = useCallback(() => { clearTimeout(saveTimer.current); saveTimer.current = setTimeout(save, 300); }, [save]);
  useEffect(() => { save(); }, [tabs, active, views, save]);

  const switchTo = useCallback((id: string) => {
    const v = view.current;
    if (id !== activeRef.current) {
      if (v) {
        states.current.set(activeRef.current, v.state);
        scrolls.current.set(activeRef.current, v.scrollSnapshot());
        const next = stateFor(id);
        v.setState(next);
        v.dispatch({ effects: scrolls.current.get(id) ?? EditorView.scrollIntoView(next.selection.main.head, { y: 'center' }) });
      }
      activeRef.current = id;
      setActive(id);
      setSelected(null);
    }
    v?.focus();
  }, [stateFor]);

  const newTab = useCallback((doc = '', name?: string) => {
    const id = Math.random().toString(36).slice(2, 10);
    unopened.current.set(id, { id, name: '', doc, cursor: doc.length });
    const next = [...tabsRef.current, { id, name: name ?? nextName(tabsRef.current) }];
    tabsRef.current = next;
    setTabs(next);
    switchTo(id);
  }, [switchTo]);

  const newTabRef = useRef(newTab);
  newTabRef.current = newTab;

  const closeTab = useCallback((id: string, confirmed = false) => {
    const ts = tabsRef.current;
    const tab = ts.find((t) => t.id === id);
    if (!tab) return;
    if (!confirmed && !isBlank(textOf(id).doc)) { setClosing(tab); return; }
    aborts.current.get(id)?.abort();
    aborts.current.delete(id);
    const rest = ts.filter((t) => t.id !== id);
    if (!rest.length) { // there's always a tab
      const nid = Math.random().toString(36).slice(2, 10);
      unopened.current.set(nid, { id: nid, name: '', doc: '' });
      rest.push({ id: nid, name: 'Query 1' });
    }
    tabsRef.current = rest;
    if (id === activeRef.current) switchTo(rest[Math.min(ts.indexOf(tab), rest.length - 1)].id);
    for (const m of [states.current, unopened.current, scrolls.current]) m.delete(id);
    marked.current.delete(id);
    setRuns((m) => { const n = { ...m }; delete n[id]; return n; });
    setViews((m) => { const n = { ...m }; delete n[id]; return n; });
    setTabs(rest);
  }, [switchTo]); // eslint-disable-line react-hooks/exhaustive-deps

  const renameTab = (id: string, name: string) => {
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (clean) setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, name: clean } : t)));
  };
  const moveTab = (id: string, to: number) => setTabs((ts) => {
    const from = ts.findIndex((t) => t.id === id);
    if (from < 0 || to === from || to === from + 1) return ts;
    const next = [...ts];
    const [t] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, t);
    return next;
  });

  // ---------------- running

  const pushHistory = useCallback((e: HistoryEntry) => {
    setHistory((h) => {
      const next = [e, ...h.filter((x) => x.sql !== e.sql)].slice(0, MAX_HISTORY);
      store.set(historyKey, next);
      return next;
    });
  }, [historyKey]);

  /** Run the statement at the cursor (or `text`). The result belongs to the tab it was started in. */
  const execute = useCallback(async (text?: string) => {
    const v = view.current;
    if (!v) return;
    const tabId = activeRef.current;
    const target = text !== undefined ? { from: -1, to: -1, text } : runnable(v.state);
    if (!target || isBlank(target.text)) { toast({ title: 'Nothing to run', body: 'Put the cursor in a query, or select one.' }); return; }
    aborts.current.get(tabId)?.abort();
    const ctrl = new AbortController();
    aborts.current.set(tabId, ctrl);
    if (marked.current.delete(tabId)) v.dispatch(setDiagnostics(v.state, []));
    const sql = target.text, from = range.from, to = range.to;
    setSelected(null);
    setRunFor(tabId, { status: 'running', sql, startedAt: performance.now() });
    try {
      const result = await runSql(pid, { sql, from, to, limit }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setRunFor(tabId, { status: 'done', sql, from, to, result });
      pushHistory({ sql, at: Date.now(), ms: result.elapsedMs, rows: result.rows.length, truncated: result.truncated });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const message = (e as Error).message || 'The query failed';
      setRunFor(tabId, { status: 'error', sql, message });
      pushHistory({ sql, at: Date.now(), error: firstLine(message) });
      const ed = view.current;
      const at = ed && activeRef.current === tabId && target.from >= 0 && ed.state.sliceDoc(target.from, target.to) === sql ? errorRange(sql, message) : null;
      if (ed && at) {
        ed.dispatch(setDiagnostics(ed.state, [{ from: target.from + at.from, to: target.from + at.to, severity: 'error', message: firstLine(message) }]));
        marked.current.add(tabId);
      }
    } finally {
      if (aborts.current.get(tabId) === ctrl) aborts.current.delete(tabId);
    }
  }, [pid, range.from, range.to, limit, pushHistory, toast, setRunFor]);
  const executeRef = useRef(execute);
  executeRef.current = execute;

  const cancel = () => {
    const id = activeRef.current;
    aborts.current.get(id)?.abort();
    aborts.current.delete(id);
    setRunFor(id, IDLE);
  };

  // the editor lives outside React: one view, and an EditorState per tab
  useEffect(() => {
    if (!host.current) return;
    extensions.current = editorExtensions({
      onRun: () => void executeRef.current(),
      onChange: (docChanged) => {
        saveSoon();
        const id = activeRef.current;
        // the underline was for the text as it ran
        if (docChanged && marked.current.has(id)) {
          setTimeout(() => { const v = view.current; if (v && activeRef.current === id && marked.current.delete(id)) v.dispatch(setDiagnostics(v.state, [])); });
        }
      },
      data: () => data.current,
    });
    const ed = new EditorView({ parent: host.current, state: stateFor(activeRef.current) });
    ed.dispatch({ effects: EditorView.scrollIntoView(ed.state.selection.main.head, { y: 'center' }) });
    view.current = ed;
    ed.focus();
    // a query sent here from a dashboard tile opens in a tab of its own
    const handoff = takeHandoff(pid);
    if (handoff) newTabRef.current(handoff.query.trimEnd() + '\n', handoff.name);
    return () => {
      clearTimeout(saveTimer.current);
      save();
      states.current.set(activeRef.current, ed.state);
      ed.destroy();
      view.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { for (const c of aborts.current.values()) c.abort(); }, []);

  /** Put text in the editor: at the cursor, or as a new statement at the end of the document. */
  const insert = useCallback((text: string, asStatement = false) => {
    const v = view.current;
    if (!v) return;
    if (asStatement) {
      const doc = v.state.doc.toString();
      const sep = !doc.trim() ? '' : doc.endsWith('\n\n') ? '' : doc.endsWith('\n') ? '\n' : '\n\n';
      const at = doc.length + sep.length;
      v.dispatch({ changes: { from: doc.length, insert: sep + text }, selection: { anchor: at, head: at + text.length }, scrollIntoView: true });
    } else {
      v.dispatch(v.state.replaceSelection(text));
    }
    v.focus();
  }, []);

  const doExport = async (format: 'csv' | 'ndjson') => {
    if (run.status !== 'done') return;
    setExporting(format);
    try {
      const r = await exportSql(pid, { sql: run.sql, from: run.from, to: run.to, format });
      const a = document.createElement('a');
      let blobUrl: string | null = null;
      if (r.url) a.href = r.url;
      else a.href = blobUrl = URL.createObjectURL(new Blob([r.content ?? ''], { type: format === 'csv' ? 'text/csv' : 'application/x-ndjson' }));
      a.download = r.filename;
      document.body.appendChild(a); a.click(); a.remove();
      if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl!), 10_000);
      toast({ title: `Exported ${fmtNum(r.rows)} row${r.rows === 1 ? '' : 's'}`, body: r.filename, tone: 'good' });
    } catch (e) {
      toast({ title: 'Export failed', body: (e as Error).message, tone: 'bad' });
    } finally {
      setExporting(null);
    }
  };

  const copyTsv = () => {
    if (run.status !== 'done') return;
    const { columns, rows } = run.result;
    const clean = (v: unknown) => (v === null || v === undefined ? '' : cellText(v).replace(/[\t\n\r]+/g, ' '));
    void copy([columns.map((c) => c.name).join('\t'), ...rows.map((r) => r.map(clean).join('\t'))].join('\n'));
    toast({ title: `Copied ${fmtNum(rows.length)} rows`, body: 'Tab-separated, ready to paste into a spreadsheet', tone: 'good' });
  };

  // drag the bar between editor and results
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY, startH = editorH;
    const max = (layout.current?.clientHeight ?? 800) - 180;
    let h = startH;
    const move = (ev: PointerEvent) => { h = Math.max(120, Math.min(max, startH + ev.clientY - startY)); setEditorH(h); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); store.set('wgo.sql.editorH', h); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const result = run.status === 'done' ? run.result : null;
  const tabView = views[active] ?? { view: 'table' };
  const setView = (p: Partial<TabView>) => setViews((m) => ({ ...m, [active]: { ...(m[active] ?? { view: 'table' }), ...p } }));
  const pinned = result && tabView.chart && tabView.chartFor === columnsKey(result) ? tabView.chart : undefined;
  const resolved = useMemo(() => (result ? resolveChart(result, pinned ?? suggestChart(result)) : null), [result, pinned]);
  /** The tile "Add to dashboard" saves: this query, shown as the chart (or as a table from the table view). */
  const dashboardTile = () => {
    const sql = run.status === 'done' ? run.sql : '';
    const tab = tabs.find((t) => t.id === active);
    const title = tab && !/^Query \d+$/.test(tab.name) ? tab.name : undefined;
    const spec: ChartSpec = tabView.view === 'chart' && resolved ? resolved : { viz: 'table' };
    return { viz: spec.viz, measures: [], ...(title ? { title } : {}), sql: tileSql(sql, spec) };
  };
  const row = result && selected !== null ? result.rows[selected] : null;

  return (
    <div className="flex h-[calc(100dvh-56px-1.5rem)] min-h-[560px] gap-3 sm:h-[calc(100dvh-56px-2rem)] md:h-[calc(100dvh-56px-3rem)]">
      <Card className="hidden w-[250px] shrink-0 flex-col overflow-hidden lg:flex">
        <div className="border-b border-line p-2">
          <Segmented value={panel} onChange={setPanel} options={[
            { value: 'tables', label: <span className="inline-flex items-center gap-1.5"><Database size={13} />Tables</span> },
            { value: 'history', label: <span className="inline-flex items-center gap-1.5"><History size={13} />History</span> },
          ]} />
        </div>
        {panel === 'tables'
          ? <SchemaPanel schema={schema.data} loading={schema.isPending} error={schema.error} insert={insert} preview={(t) => void execute(`SELECT * FROM ${t} LIMIT 100`)} />
          : <HistoryPanel history={history} open={(sql) => insert(sql.trimEnd().endsWith(';') ? sql : sql + ';', true)}
              clear={() => { setHistory([]); store.set(historyKey, []); }} />}
      </Card>

      <div ref={layout} className="flex min-w-0 flex-1 flex-col">
        <Card className="flex shrink-0 flex-col overflow-hidden" style={{ height: editorH }}>
          <TabBar tabs={tabs} active={active} onSelect={switchTo} onNew={() => newTab()} onClose={(id) => closeTab(id)} onRename={renameTab} onMove={moveTab}
            running={new Set(Object.keys(runs).filter((id) => runs[id].status === 'running'))}
            failed={new Set(Object.keys(runs).filter((id) => runs[id].status === 'error'))} />
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            {run.status === 'running'
              ? <Button variant="secondary" size="sm" onClick={cancel} title="Stop waiting for this query"><Square size={12} className="fill-current" />Cancel</Button>
              : <Button variant="primary" size="sm" onClick={() => void execute()} title="Run the query at the cursor, or the selection"><Play size={13} className="fill-current" />Run<span className="ml-1 text-[11px] opacity-80">⌘↵</span></Button>}
            <label className="flex items-center gap-1.5 text-[12px] text-muted">
              <span className="hidden sm:inline">Rows</span>
              <select className="field !h-7 !w-auto !py-0 !pl-2 !pr-7 !text-[12px]" value={limit}
                onChange={(e) => { const n = Number(e.target.value); setLimit(n); store.set('wgo.sql.limit', n); }}>
                {LIMITS.map((n) => <option key={n} value={n}>{fmtNum(n)}</option>)}
              </select>
            </label>
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-faint" title="Every table holds only the rows of this time range. Change it with the time picker at the top.">
              <Clock size={13} className="shrink-0" /><span className="truncate">Data from {range.label.replace(/^Last/, 'the last')}</span>
            </span>
            <div className="ml-auto flex items-center gap-1">
              <ExamplesMenu onPick={(e) => newTab(e.sql + '\n', e.title)} />
            </div>
          </div>
          <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
        </Card>

        <div onPointerDown={startResize} title="Drag to resize" className="group flex h-3 shrink-0 cursor-row-resize items-center justify-center">
          <i className="h-[3px] w-10 rounded-full bg-[var(--line-strong)] transition-colors group-hover:bg-accent" />
        </div>

        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-[42px] flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5">
            {result && result.columns.length > 0 && result.rows.length > 0 && (
              <Segmented value={tabView.view} onChange={(v) => setView({ view: v })} options={[
                { value: 'table', label: <span className="inline-flex items-center gap-1.5"><Table2 size={13} />Table</span> },
                { value: 'chart', label: <span className="inline-flex items-center gap-1.5"><BarChart3 size={13} />Chart</span> },
              ]} />)}
            <ResultStatus run={run} />
            {result && result.columns.length > 0 && (
              <div className="ml-auto flex items-center gap-1.5">
                <AddToDashboard label tile={() => dashboardTile()} />
                <Button size="sm" variant="ghost" onClick={copyTsv} title="Copy the rows shown, tab-separated"><Copy size={13} />Copy</Button>
                <Button size="sm" onClick={() => void doExport('csv')} disabled={!!exporting} title="Download every row of this query as CSV">
                  {exporting === 'csv' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}CSV
                </Button>
                <Button size="sm" onClick={() => void doExport('ndjson')} disabled={!!exporting} title="Download every row of this query as newline-delimited JSON">
                  {exporting === 'ndjson' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}NDJSON
                </Button>
              </div>
            )}
          </div>
          {run.status === 'error' ? (
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <div className="flex items-start gap-2.5 rounded-lg border border-bad/30 bg-bad/8 p-3">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-bad" />
                <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-fg">{run.message}</pre>
              </div>
            </div>
          ) : result ? (
            result.columns.length === 0
              ? <EmptyState icon={<Table2 size={22} />} title="Done">The statement ran and returned no columns.</EmptyState>
              : result.rows.length === 0
                ? <EmptyState icon={<Table2 size={22} />} title="No rows">The query returned no rows for {range.label.toLowerCase()}. Try a longer time range.</EmptyState>
                : tabView.view === 'chart' && resolved
                  ? (
                    <>
                      <div className="border-b border-line"><ChartConfig columns={result.columns} spec={pinned ?? resolved} resolved={resolved} onChange={(chart) => setView({ chart, chartFor: columnsKey(result) })} /></div>
                      <Measured>{(h) => <SqlChart result={result} spec={resolved} height={h} />}</Measured>
                    </>)
                  : <ResultsGrid columns={result.columns} rows={result.rows} selected={selected} onSelect={setSelected} />
          ) : run.status === 'running' ? (
            <div className="grid flex-1 place-items-center text-[12.5px] text-muted"><span className="flex items-center gap-2"><Loader2 size={15} className="animate-spin text-accent" />Running…</span></div>
          ) : (
            <EmptyState icon={<Play size={20} />} title="Run a query to see results">
              Press <Kbd>⌘</Kbd> <Kbd>↵</Kbd> (<Kbd>Ctrl</Kbd> <Kbd>↵</Kbd>) to run the query at the cursor. Results can be exported as CSV or NDJSON.
            </EmptyState>
          )}
        </Card>
      </div>

      <Dialog open={!!closing} onClose={() => setClosing(null)} title={`Close “${closing?.name ?? ''}”?`}
        footer={<>
          <Button onClick={() => setClosing(null)}>Keep it</Button>
          <Button variant="danger" autoFocus onClick={() => { if (closing) closeTab(closing.id, true); setClosing(null); }}>Close tab</Button>
        </>}>
        <p className="text-[13px] text-muted">The queries in this tab aren't saved anywhere else. Queries you ran stay in History.</p>
      </Dialog>

      <Drawer open={!!row} onClose={() => setSelected(null)} width={560}
        title={<span className="flex items-center gap-3">Row {selected !== null ? fmtNum(selected + 1) : ''}{result && row && <CopyButton label="Copy as JSON" text={JSON.stringify(Object.fromEntries(result.columns.map((c, i) => [c.name, row[i]])), null, 2)} />}</span>}>
        {result && row && (
          <div className="divide-y divide-line">
            {result.columns.map((c, i) => <RowField key={i} name={c.name} type={c.type} value={row[i]} />)}
          </div>
        )}
      </Drawer>
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function ResultStatus({ run }: { run: RunState }) {
  const [now, setNow] = useState(performance.now());
  useEffect(() => {
    if (run.status !== 'running') return;
    const t = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(t);
  }, [run.status]);
  if (run.status === 'running') return <span className="text-[12.5px] text-muted tnum">Running · {fmtSecs(now - run.startedAt)}</span>;
  if (run.status === 'error') return <span className="text-[12.5px] font-medium text-bad">Query failed</span>;
  if (run.status !== 'done') return <span className="text-[12.5px] text-faint">Results</span>;
  const r = run.result;
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12.5px] text-muted tnum">
      <span className="font-semibold text-fg">{r.truncated ? 'First ' : ''}{fmtNum(r.rows.length)} row{r.rows.length === 1 ? '' : 's'}</span>
      {r.truncated && <span className="text-warn" title="Raise the row limit to see more, or export: exports have every row.">more not shown</span>}
      <span className="text-faint">·</span><span>{fmtSecs(r.elapsedMs)}</span>
      {r.scanned.files > 0 && <><span className="text-faint">·</span><span title="Parquet files behind the tables the query read">{fmtNum(r.scanned.files)} file{r.scanned.files === 1 ? '' : 's'}, {fmtBytes(r.scanned.bytes)}</span></>}
    </span>
  );
}

function RowField({ name, type, value }: { name: string; type: string; value: unknown }) {
  const text = value === null || value === undefined ? 'NULL' : typeof value === 'object' ? JSON.stringify(value, null, 2) : cellText(value);
  return (
    <div className="group px-5 py-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[12.5px] font-semibold">{name}</span>
        <span className="font-mono text-[11px] text-faint">{type}</span>
        {value !== null && value !== undefined && <CopyButton text={text} className="ml-auto opacity-0 transition-opacity group-hover:opacity-100" />}
      </div>
      <pre className={cn('max-h-[360px] overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed', value === null || value === undefined ? 'italic text-faint' : 'text-fg')}>{text}</pre>
    </div>
  );
}

function SchemaPanel({ schema, loading, error, insert, preview }: {
  schema: SqlSchema | undefined; loading: boolean; error: unknown; insert: (text: string) => void; preview: (table: string) => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set(['events']));
  const needle = q.trim().toLowerCase();
  const tables = useMemo(() => (schema?.tables ?? []).map((t) => ({
    ...t,
    shown: needle ? t.columns.filter((c) => c.name.includes(needle)) : t.columns,
  })).filter((t) => !needle || t.name.includes(needle) || t.shown.length), [schema, needle]);
  if (loading) return <div className="space-y-2 p-3">{Array.from({ length: 7 }, (_, i) => <div key={i} className="skeleton h-6" />)}</div>;
  if (error) return <p className="p-3 text-[12px] text-bad">{(error as Error).message}</p>;
  return (
    <>
      <div className="relative border-b border-line p-2">
        <Search size={13} className="absolute left-4 top-1/2 -translate-y-1/2 text-faint" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a column…" className="field !h-8 !pl-7 !text-[12px]" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {tables.map((t) => {
          const expanded = !!needle || open.has(t.name);
          return (
            <div key={t.name}>
              <div className="group flex items-center gap-1 px-1.5">
                <button onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(t.name)) n.delete(t.name); else n.add(t.name); return n; })}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-[var(--hl)] cursor-pointer" title={t.description}>
                  <ChevronRight size={13} className={cn('shrink-0 text-faint transition-transform', expanded && 'rotate-90')} />
                  <Table2 size={13} className="shrink-0 text-accent2" />
                  <span className="truncate font-mono text-[12.5px] font-medium">{t.name}</span>
                </button>
                <button onClick={() => insert(t.name)} title={`Insert “${t.name}” at the cursor`} className="rounded p-1 text-faint opacity-0 hover:text-fg group-hover:opacity-100 cursor-pointer"><ChevronRight size={12} className="-rotate-90" /></button>
                <button onClick={() => preview(t.name)} title={`Run SELECT * FROM ${t.name} LIMIT 100`} className="rounded p-1 text-faint opacity-0 hover:text-accent group-hover:opacity-100 cursor-pointer"><Play size={12} /></button>
              </div>
              {expanded && (
                <div className="mb-1 ml-[26px] border-l border-line pl-1.5">
                  {!needle && <p className="px-1.5 pb-1 pt-0.5 text-[11px] leading-snug text-faint">{t.description}</p>}
                  {t.shown.map((c) => (
                    <button key={c.name} onClick={() => insert(c.name)} title={`${c.description ? c.description + '\n' : ''}Click to insert at the cursor`}
                      className="flex w-full items-baseline gap-2 rounded px-1.5 py-[3px] text-left hover:bg-[var(--hl)] cursor-pointer">
                      <span className={cn('min-w-0 flex-1 truncate font-mono text-[12px]', c.name === t.timeColumn ? 'text-fg' : 'text-muted')}>{c.name}</span>
                      <span className="shrink-0 font-mono text-[10.5px] text-faint">{c.type.toLowerCase()}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {!tables.length && <p className="px-3 py-4 text-[12px] text-faint">No table or column matches “{q}”.</p>}
      </div>
      <a href="https://duckdb.org/docs/stable/sql/introduction" target="_blank" rel="noopener noreferrer"
        className="flex items-center gap-1.5 border-t border-line px-3 py-2 text-[12px] text-muted hover:text-fg">
        <BookOpen size={13} />DuckDB SQL reference
      </a>
    </>
  );
}

function HistoryPanel({ history, open, clear }: { history: HistoryEntry[]; open: (sql: string) => void; clear: () => void }) {
  if (!history.length) return <p className="p-4 text-[12px] leading-relaxed text-faint">Queries you run show up here, newest first. Only this browser keeps them.</p>;
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {history.map((h) => (
          <button key={h.at + h.sql} onClick={() => open(h.sql)} title="Add to the editor"
            className="block w-full border-b border-line/60 px-3 py-2 text-left hover:bg-[var(--hl)] cursor-pointer">
            <code className="line-clamp-3 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-fg">{h.sql}</code>
            <span className={cn('mt-1 block truncate text-[11px]', h.error ? 'text-bad' : 'text-faint')}>
              {relTime(h.at)} · {h.error ? h.error : `${fmtNum(h.rows ?? 0)}${h.truncated ? '+' : ''} rows · ${fmtSecs(h.ms ?? 0)}`}
            </span>
          </button>
        ))}
      </div>
      <button onClick={clear} className="flex items-center gap-1.5 border-t border-line px-3 py-2 text-[12px] text-muted hover:text-bad cursor-pointer"><Trash2 size={13} />Clear history</button>
    </>
  );
}

function ExamplesMenu({ onPick }: { onPick: (example: (typeof EXAMPLES)[number]) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  return (<>
    <span ref={anchor}><Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}><BookOpen size={13} />Examples</Button></span>
    <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="end" width={300}>
      <div className="w-[300px] p-1.5">
        {EXAMPLES.map((e) => (
          <MenuItem key={e.title} onClick={() => { setOpen(false); onPick(e); }}>
            <span className="block text-[12.5px] text-fg">{e.title}</span>
            <span className="block truncate font-mono text-[11px] text-faint">{e.sql.replace(/\s+/g, ' ')}</span>
          </MenuItem>
        ))}
      </div>
    </Popover>
  </>);
}

function MenuItem({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button onClick={onClick} className="block w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-[var(--hl)] cursor-pointer">{children}</button>;
}

/** Gives its child the pixel height it has. */
function Measured({ children }: { children: (height: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <div ref={ref} className="min-h-0 flex-1 overflow-hidden pt-3">{h > 0 && children(h - 12)}</div>;
}
