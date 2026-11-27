import { EditorState, Prec, RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration, EditorView, ViewPlugin, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, placeholder, rectangularSelection, tooltips, type DecorationSet, type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import {
  autocompletion, closeBrackets, closeCompletion, closeBracketsKeymap, completionKeymap, snippetCompletion,
  type Completion, type CompletionContext, type CompletionResult,
} from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { SQLDialect } from '@codemirror/lang-sql';
import { tags as t } from '@lezer/highlight';
import type { SqlSchema } from '../api/contract';
import { splitStatements, statementAt } from './statements';

// ---------------------------------------------------------------- dialect

const KEYWORDS = `select from where group by having order limit offset with recursive as on using join inner left right full outer cross
natural semi anti asof positional lateral union all except intersect distinct and or not in is null true false like ilike glob similar
between case when then else end cast try_cast exists any some qualify window over partition rows range groups preceding following
unbounded current row filter within pivot unpivot for into values insert update delete create table view temp temporary replace drop
alter describe summarize show explain analyze pragma set reset copy to asc desc nulls first last collate escape interval at time zone
exclude columns struct map list array macro function returning conflict do nothing default primary key references unique check
constraint index sequence schema if attach detach use install load export import begin commit rollback transaction call sample
tablesample by`;
const TYPES = `bigint binary bit bitstring blob bool boolean bpchar bytea char date datetime decimal double enum float float4 float8 hugeint
int int1 int2 int4 int8 integer json long numeric real short signed smallint string text time timestamp timestamptz timestamp_s
timestamp_ms timestamp_ns tinyint ubigint uhugeint uinteger usmallint utinyint uuid varbinary varchar`;

export const duckdb = SQLDialect.define({
  keywords: KEYWORDS.replace(/\s+/g, ' '),
  types: TYPES.replace(/\s+/g, ' '),
  operatorChars: '*+-%<>!=&|~^/:',
  doubleDollarQuotedStrings: true,
  caseInsensitiveIdentifiers: true,
  specialVar: '?$',
});

// ---------------------------------------------------------------- look

const MONO = 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace';

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent', color: 'var(--fg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: MONO, lineHeight: '1.65' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0 24px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--faint)', border: 'none', paddingLeft: '4px' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '30px', paddingRight: '10px', fontSize: '11.5px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--muted)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--fg) 3%, transparent)' },
  '.cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent) !important' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 32%, transparent) !important' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent2) 16%, transparent)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)', color: 'inherit', outline: 'none' },
  '.cm-nonmatchingBracket': { color: 'var(--bad)' },
  '.cm-placeholder': { color: 'var(--faint)' },
  // the statement ⌘↵ runs, when the document holds several
  '.cm-stmt': { boxShadow: 'inset 2px 0 0 color-mix(in srgb, var(--accent) 70%, transparent)', backgroundColor: 'color-mix(in srgb, var(--accent) 4%, transparent)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--bad)', textUnderlineOffset: '3px', textDecorationSkipInk: 'none' },
  '.cm-tooltip': {
    backgroundColor: 'var(--raised)', color: 'var(--fg)', border: '1px solid var(--line-strong)', borderRadius: '10px',
    boxShadow: '0 16px 40px -12px rgba(0,0,0,.45)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { borderRadius: '9px', fontFamily: MONO, fontSize: '12.5px', maxHeight: '18em', minWidth: '300px', maxWidth: '520px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 10px 3px 8px', lineHeight: '1.55' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'color-mix(in srgb, var(--accent) 20%, transparent)', color: 'var(--fg)' },
  '.cm-completionLabel': { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent)', fontWeight: '600' },
  '.cm-completionDetail': { marginLeft: 'auto', paddingLeft: '16px', color: 'var(--faint)', fontStyle: 'normal', fontSize: '11.5px', whiteSpace: 'nowrap' },
  '.cm-tooltip.cm-completionInfo': { padding: '9px 11px', maxWidth: '380px', fontSize: '12px', lineHeight: '1.5', marginLeft: '4px' },
  '.cm-sql-kind': { width: '14px', flexShrink: '0', textAlign: 'center', fontSize: '11px', fontWeight: '600' },
  '.cm-sql-sig': { fontFamily: MONO, fontSize: '11.5px', color: 'var(--fg)', wordBreak: 'break-word' },
  '.cm-sql-doc': { marginTop: '5px', color: 'var(--muted)' },
  '.cm-panels': { backgroundColor: 'var(--raised)', color: 'var(--fg)', borderColor: 'var(--line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-search input, .cm-search button': { fontSize: '12px' },
  '.cm-textfield': { backgroundColor: 'var(--hl)', border: '1px solid var(--line)', borderRadius: '6px', color: 'var(--fg)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--hl)', border: '1px solid var(--line)', borderRadius: '6px', color: 'var(--fg)' },
});

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--accent)', fontWeight: '500' },
  { tag: [t.typeName, t.standard(t.name)], color: 'var(--s5)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--good)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--warn)' },
  { tag: [t.lineComment, t.blockComment], color: 'var(--faint)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation, t.paren, t.bracket, t.brace], color: 'var(--muted)' },
  { tag: t.special(t.name), color: 'var(--accent2)' },
  { tag: t.quote, color: 'var(--fg)' },
]);

// ---------------------------------------------------------------- completion

export interface CompletionData {
  tables: SqlSchema['tables'];
  functions: SqlSchema['functions'];
  keywords: string[];
  /** JSON keys seen under `column` (then `path`) of `table`, most common first */
  jsonKeys: (table: string, column: string, path: string[]) => string[];
}

const NOT_ALIAS = new Set(('where on using join left right inner outer full cross natural semi anti asof positional lateral group order limit '
  + 'qualify having window union except intersect select as tablesample sample offset pivot unpivot').split(' '));

/** Tables the statement reads, with their aliases. */
function tablesInScope(text: string, known: Map<string, CompletionData['tables'][number]>) {
  const out: Array<{ table: CompletionData['tables'][number]; alias: string | null }> = [];
  const re = /\b(?:from|join)\s+"?([a-z_]\w*)"?(?:\s+(?:as\s+)?"?([a-z_]\w*)"?)?/gi;
  for (const m of text.matchAll(re)) {
    const table = known.get(m[1].toLowerCase());
    if (!table) continue;
    const alias = m[2] && !NOT_ALIAS.has(m[2].toLowerCase()) ? m[2] : null;
    out.push({ table, alias });
  }
  return out;
}

const KIND_MARK: Record<string, [string, string]> = {
  table: ['T', 'var(--accent2)'], column: ['c', 'var(--s3)'], function: ['ƒ', 'var(--s5)'], keyword: ['k', 'var(--faint)'], key: ['{}', 'var(--warn)'],
};

function infoNode(title: string, doc?: string | null): () => Node {
  return () => {
    const el = document.createElement('div');
    const sig = el.appendChild(document.createElement('div'));
    sig.className = 'cm-sql-sig';
    sig.textContent = title;
    if (doc) {
      const d = el.appendChild(document.createElement('div'));
      d.className = 'cm-sql-doc';
      d.textContent = doc;
    }
    return el;
  };
}

/** Completion inside a string after `column->'` or `column->>'`: keys seen in that JSON column. */
function jsonKeyCompletion(ctx: CompletionContext, data: CompletionData, scope: ReturnType<typeof tablesInScope>): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const m = /([a-z_]\w*)((?:\s*->>?\s*'[^']*')*)\s*->>?\s*'([^']*)$/i.exec(before);
  if (!m) return null;
  const column = m[1].toLowerCase();
  const path = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  const owner = scope.find((s) => s.table.columns.some((c) => c.name === column && c.type === 'JSON'))?.table
    ?? data.tables.find((tb) => tb.columns.some((c) => c.name === column && c.type === 'JSON'));
  if (!owner) return null;
  const keys = data.jsonKeys(owner.name, column, path);
  if (!keys.length) return null;
  return {
    from: ctx.pos - m[3].length,
    options: keys.map((k, i) => ({ label: k, type: 'key', detail: `${owner.name}.${[column, ...path].join('.')}`, boost: -i / keys.length })),
    validFor: /^[^']*$/,
  };
}

export function sqlCompletion(getData: () => CompletionData | null) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const data = getData();
    if (!data) return null;
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    if (node.name === 'LineComment' || node.name === 'BlockComment') return null;

    const doc = ctx.state.doc.toString();
    const stmt = statementAt(doc, ctx.pos);
    const known = new Map(data.tables.map((tb) => [tb.name, tb]));
    const scope = tablesInScope(stmt?.text ?? '', known);

    if (node.name === 'String') return jsonKeyCompletion(ctx, data, scope);

    // alias.col or table.col
    const dotted = ctx.matchBefore(/"?([a-z_]\w*)"?\.\w*$/i);
    if (dotted) {
      const q = /^"?([a-z_]\w*)"?\./i.exec(dotted.text)![1].toLowerCase();
      const hit = scope.find((s) => s.alias?.toLowerCase() === q) ?? scope.find((s) => s.table.name === q) ?? (known.get(q) ? { table: known.get(q)! } : null);
      if (!hit) return null;
      return {
        from: dotted.from + dotted.text.lastIndexOf('.') + 1,
        options: hit.table.columns.map((c) => ({ label: c.name, type: 'column', detail: c.type, info: infoNode(`${hit.table.name}.${c.name} ${c.type}`, c.description) })),
        validFor: /^\w*$/,
      };
    }

    const word = ctx.matchBefore(/\w*/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    const head = doc.slice(stmt && stmt.from < word.from ? stmt.from : Math.max(0, word.from - 400), word.from);
    const afterFrom = /\b(from|join)\s+$/i.test(head);

    const options: Completion[] = [];
    for (const tb of data.tables) {
      options.push({ label: tb.name, type: 'table', detail: 'table', boost: afterFrom ? 20 : 1, info: infoNode(tb.name, tb.description) });
    }
    if (afterFrom) {
      for (const f of data.functions) {
        if (f.kind !== 'table' && f.kind !== 'table_macro') continue;
        options.push(snippetCompletion(`${f.name}(\${})`, { label: f.name, type: 'function', detail: 'table function', boost: 2, info: infoNode(f.signature, f.description) }));
      }
      return { from: word.from, options, validFor: /^\w*$/ };
    }

    // columns: of the tables the statement reads, else of every table
    const cols = new Map<string, { type: string; tables: string[]; description?: string }>();
    for (const tb of scope.length ? scope.map((s) => s.table) : data.tables) {
      for (const c of tb.columns) {
        const e = cols.get(c.name);
        if (e) { if (!e.tables.includes(tb.name)) e.tables.push(tb.name); }
        else cols.set(c.name, { type: c.type, tables: [tb.name], description: c.description });
      }
    }
    for (const [name, c] of cols) {
      options.push({
        label: name, type: 'column', boost: scope.length ? 10 : -1,
        detail: scope.length > 1 ? `${c.type} · ${c.tables.join(', ')}` : c.type,
        info: infoNode(`${c.tables.length === 1 ? c.tables[0] + '.' : ''}${name} ${c.type}`, c.description ?? (c.tables.length > 1 ? `In ${c.tables.join(', ')}` : null)),
      });
    }
    for (const f of data.functions) {
      if (f.kind === 'table' || f.kind === 'table_macro' || f.kind === 'pragma') continue;
      options.push(snippetCompletion(`${f.name}(\${})`, {
        label: f.name, type: 'function', boost: f.kind === 'aggregate' ? 0 : -2,
        detail: f.kind === 'aggregate' ? 'aggregate' : f.kind === 'macro' ? 'macro' : undefined,
        info: infoNode(f.signature, f.description),
      }));
    }
    for (const k of data.keywords) options.push({ label: k, type: 'keyword', boost: -4 });
    return { from: word.from, options, validFor: /^\w*$/ };
  };
}

// ---------------------------------------------------------------- the statement that runs

const activeStatement = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(u: ViewUpdate) { if (u.docChanged || u.selectionSet || u.focusChanged) this.decorations = this.build(u.view); }
  build(view: EditorView): DecorationSet {
    const doc = view.state.doc.toString();
    const sel = view.state.selection.main;
    if (!sel.empty || splitStatements(doc).length < 2) return Decoration.none;
    const s = statementAt(doc, sel.head);
    if (!s) return Decoration.none;
    const b = new RangeSetBuilder<Decoration>();
    const first = view.state.doc.lineAt(s.from).number, last = view.state.doc.lineAt(s.to).number;
    for (let l = first; l <= last; l++) { const line = view.state.doc.line(l); b.add(line.from, line.from, Decoration.line({ class: 'cm-stmt' })); }
    return b.finish();
  }
}, { decorations: (v) => v.decorations });

/** What ⌘↵ runs: the selection when there is one, else the statement at the cursor. */
export function runnable(state: EditorState): { from: number; to: number; text: string } | null {
  const sel = state.selection.main;
  if (!sel.empty) return { from: sel.from, to: sel.to, text: state.sliceDoc(sel.from, sel.to) };
  return statementAt(state.doc.toString(), sel.head);
}

// ---------------------------------------------------------------- editor

export interface EditorOptions {
  onRun: (view: EditorView) => void;
  /** the text or the cursor changed (the text when `docChanged`) */
  onChange: (docChanged: boolean) => void;
  data: () => CompletionData | null;
}

/** An editor state for a tab: its text and cursor, with the extensions every tab shares. */
export function editorState(doc: string, cursor: number | undefined, extensions: Extension[]): EditorState {
  const at = Math.max(0, Math.min(cursor ?? doc.length, doc.length));
  return EditorState.create({ doc, selection: { anchor: at }, extensions });
}

/** The extensions of the SQL editor. Create them once and share them between tabs (each tab is an EditorState). */
export function editorExtensions(o: EditorOptions): Extension[] {
  const run =(view: EditorView) => { closeCompletion(view); o.onRun(view); return true; };
  const extensions: Extension[] = [
    lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(), rectangularSelection(),
    crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(), EditorView.lineWrapping,
    duckdb.language, syntaxHighlighting(highlight), theme, activeStatement,
    // the editor sits in a card that clips its overflow: completion lists and their docs float above the page
    tooltips({ parent: document.body }),
    placeholder('SELECT … FROM events   (⌘↵ to run)'),
    autocompletion({
      override: [sqlCompletion(o.data)], icons: false, activateOnTypingDelay: 60, maxRenderedOptions: 80,
      addToOptions: [{
        position: 20,
        render: (c) => {
          const [mark, color] = KIND_MARK[c.type ?? ''] ?? ['', ''];
          const el = document.createElement('span');
          el.className = 'cm-sql-kind';
          el.textContent = mark;
          el.style.color = color;
          return el;
        },
      }],
    }),
    Prec.highest(keymap.of([{ key: 'Mod-Enter', run, preventDefault: true }])),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab, { key: 'Mod-/', run: toggleComment }]),
    EditorView.updateListener.of((u) => { if (u.docChanged || u.selectionSet) o.onChange(u.docChanged); }),
  ];
  return extensions;
}
