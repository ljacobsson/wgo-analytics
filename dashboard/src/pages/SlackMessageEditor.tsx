import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Braces, Copy, ExternalLink, GripVertical, Plus, Send, Trash2 } from 'lucide-react';
import { SLACK_TEMPLATE_VARIABLES } from '../api/contract';
import type { FilterScope, SlackTemplate, TriggerCondition, TriggerKind, TriggerMetric, TriggerWebhookPayload } from '../api/contract';
import { useTestTrigger } from '../api/hooks';
import { cn } from '../lib/format';
import { BUILTIN } from '../lib/filterMatch';
import { defaultSlackTemplate, renderSlackTemplate, sampleAggregate, sampleRows, slackTemplateProblem } from '../lib/slackTemplate';
import { useProject } from '../lib/project';
import { Popover } from '../ui/Popover';
import { Button, Dialog, Segmented, useToast } from '../ui/kit';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const textOf = (t: unknown) => (isObj(t) ? str(t.text) : '');

/** What the trigger being designed for is like: its variables and sample data depend on it. */
export interface SlackDesignContext {
  name: string;
  kind: TriggerKind;
  scope: FilterScope;
  metric: TriggerMetric | null;
  condition: TriggerCondition | null;
  windowMinutes: number | null;
  /** A saved trigger that posts to Slack: "Send test" sends the draft through it. */
  testTriggerId?: string;
}

const ROW_PREFIX: Record<FilterScope, string> = { events: 'event', logs: 'log', spans: 'span' };
const ROW_NOUN: Record<FilterScope, string> = { events: 'event', logs: 'log record', spans: 'span' };

// ---------------------------------------------------------------- blocks the visual editor knows

type Kind = 'header' | 'text' | 'matches' | 'context' | 'divider' | 'actions' | 'image' | 'other';
type NewKind = Exclude<Kind, 'other'> | 'fields';

function kindOf(b: Obj): Kind {
  switch (b.type) {
    case 'header': return 'header';
    case 'section': return !b.fields && !b.accessory && textOf(b.text).trim() === '{{matches_list}}' ? 'matches' : 'text';
    case 'context': return Array.isArray(b.elements) && b.elements.every((e) => isObj(e) && (e.type === 'mrkdwn' || e.type === 'plain_text')) ? 'context' : 'other';
    case 'divider': return 'divider';
    case 'actions': return Array.isArray(b.elements) && b.elements.every((e) => isObj(e) && e.type === 'button') ? 'actions' : 'other';
    case 'image': return 'image';
    default: return 'other';
  }
}

const LABEL: Record<Kind, string> = {
  header: 'Header', text: 'Text', matches: 'List of matches', context: 'Small print', divider: 'Divider', actions: 'Buttons', image: 'Image', other: 'Block',
};

const md = (text: string) => ({ type: 'mrkdwn', text });
const button = (text: string, url: string) => ({ type: 'button', text: { type: 'plain_text', text }, url });

/** New blocks, with content that makes sense for the trigger. */
function newBlock(k: NewKind, c: SlackDesignContext): Obj {
  const p = ROW_PREFIX[c.scope];
  const match = c.kind === 'match';
  switch (k) {
    case 'header': return { type: 'header', text: { type: 'plain_text', text: '{{headline}}', emoji: true } };
    case 'text': return { type: 'section', text: md(match ? '{{summary}}' : '*{{trigger.name}}* is {{state}}: {{value}}') };
    case 'matches': return { type: 'section', text: md('{{matches_list}}') };
    case 'context': return { type: 'context', elements: [md('{{project.name}} · {{time}}')] };
    case 'divider': return { type: 'divider' };
    case 'actions': return { type: 'actions', elements: [button('Open in WGO', '{{url}}')] };
    case 'image': return { type: 'image', image_url: '', alt_text: '' };
    case 'fields': {
      const pairs = !match ? [['Value', '{{value}}'], ['State', '{{state}}']]
        : c.scope === 'logs' ? [['Service', `{{${p}.service}}`], ['Severity', `{{${p}.severityText}}`]]
        : c.scope === 'spans' ? [['Service', `{{${p}.service}}`], ['Duration', `{{${p}.durationMs}} ms`]]
        : [['Page', `{{${p}.path}}`], ['Where', `{{${p}.city}}, {{${p}.country}}`]];
      return { type: 'section', fields: pairs.map(([l, v]) => md(`*${l}*\n${v}`)) };
    }
  }
}

const ADDABLE: Array<{ k: NewKind; label: string; hint: string; matchOnly?: boolean }> = [
  { k: 'header', label: 'Header', hint: 'Large bold title' },
  { k: 'text', label: 'Text', hint: 'A paragraph with formatting and links' },
  { k: 'fields', label: 'Fields', hint: 'Label and value pairs in two columns' },
  { k: 'matches', label: 'List of matches', hint: 'The most recent matches, one per line', matchOnly: true },
  { k: 'context', label: 'Small print', hint: 'Small grey text' },
  { k: 'divider', label: 'Divider', hint: 'A line between blocks' },
  { k: 'actions', label: 'Buttons', hint: 'Links shown as buttons' },
  { k: 'image', label: 'Image', hint: 'A picture from a public URL' },
];

// ---------------------------------------------------------------- variables

interface Var { name: string; description: string }

function variablesFor(c: SlackDesignContext): Array<{ group: string; vars: Var[] }> {
  const fits = (v: { kinds?: TriggerKind[] }) => !v.kinds || v.kinds.includes(c.kind);
  const named = SLACK_TEMPLATE_VARIABLES.filter((v) => fits(v) && !v.name.includes('<'));
  const groups = [{ group: 'Notification', vars: named.map(({ name, description }) => ({ name, description })) }];
  if (c.kind === 'match') {
    const p = ROW_PREFIX[c.scope];
    const extra = c.scope === 'events' ? `also ${p}.props.<name>` : `also ${p}.attributes.<key>`;
    groups.push({ group: `Most recent matching ${ROW_NOUN[c.scope]} (${extra})`, vars: BUILTIN[c.scope].map((f) => ({ name: `${p}.${f}`, description: '' })) });
  }
  return groups;
}

/** A text input or textarea with an "insert variable" menu that inserts at the cursor. */
function VarText({ value, onChange, ctx, multiline, placeholder, mono }: {
  value: string; onChange: (v: string) => void; ctx: SlackDesignContext; multiline?: boolean; placeholder?: string; mono?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => variablesFor(ctx), [ctx]);
  const insert = (name: string) => {
    const el = multiline ? area.current : input.current;
    const at = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? at;
    const token = `{{${name}}}`;
    onChange(value.slice(0, at) + token + value.slice(end));
    setOpen(false);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + token.length, at + token.length); });
  };
  const cls = cn('field pr-9 text-[12.5px]', mono && 'font-mono', multiline && 'resize-y leading-[1.45]');
  return (
    <div className="relative">
      {multiline
        ? <textarea ref={area} className={cls} rows={Math.min(8, Math.max(2, value.split('\n').length))} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        : <input ref={input} className={cls} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />}
      <button ref={anchor} type="button" onClick={() => setOpen((x) => !x)} title="Insert a variable"
        className={cn('absolute right-1.5 rounded-md p-1 text-faint hover:bg-[var(--hl)] hover:text-fg cursor-pointer', multiline ? 'top-1.5' : 'top-1/2 -translate-y-1/2')}>
        <Braces size={14} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={340}>
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.group}>
              <div className="mb-1 px-2 text-[11.5px] font-medium text-muted">{g.group}</div>
              <div className="space-y-px">
                {g.vars.map((v) => (
                  <button key={v.name} type="button" onClick={() => insert(v.name)} className="block w-full rounded-md px-2 py-1 text-left hover:bg-[var(--hl)] cursor-pointer">
                    <span className="font-mono text-[12px]">{v.name}</span>
                    {v.description && <span className="block text-[11.5px] leading-snug text-faint">{v.description}</span>}
                  </button>))}
              </div>
            </div>))}
        </div>
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------- block cards

function Label({ children }: { children: ReactNode }) {
  return <span className="mb-1 block text-[11.5px] font-medium text-muted">{children}</span>;
}

const linkCls = 'inline-flex items-center gap-1 hover:text-fg cursor-pointer';

function ButtonsEditor({ buttons, onChange, ctx, max }: { buttons: Obj[]; onChange: (b: Obj[]) => void; ctx: SlackDesignContext; max: number }) {
  const set = (i: number, b: Obj) => onChange(buttons.map((x, j) => (j === i ? b : x)));
  return (
    <div className="space-y-1.5">
      {buttons.map((b, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)_auto_auto] items-center gap-1.5">
          <input className="field text-[12.5px]" value={textOf(b.text)} placeholder="Button text" onChange={(e) => set(i, { ...b, text: { type: 'plain_text', text: e.target.value } })} />
          <VarText value={str(b.url)} onChange={(url) => set(i, { ...b, url })} ctx={ctx} placeholder="https://… or {{url}}" mono />
          <select className="field w-auto text-[12.5px]" value={str(b.style)} title="Colour"
            onChange={(e) => { const { style: _s, ...rest } = b; set(i, e.target.value ? { ...rest, style: e.target.value } : rest); }}>
            <option value="">Plain</option><option value="primary">Green</option><option value="danger">Red</option>
          </select>
          <button type="button" onClick={() => onChange(buttons.filter((_, j) => j !== i))} className="rounded-md p-1.5 text-faint hover:bg-bad/15 hover:text-bad cursor-pointer" title="Remove button"><Trash2 size={13} /></button>
        </div>))}
      {buttons.length < max && (
        <button type="button" className={cn(linkCls, 'text-[12px] text-muted')} onClick={() => onChange([...buttons, button('Open in WGO', '{{url}}')])}><Plus size={12} />Add a button</button>)}
    </div>
  );
}

function BlockFields({ block, onChange, ctx }: { block: Obj; onChange: (b: Obj) => void; ctx: SlackDesignContext }) {
  const k = kindOf(block);
  const without = (key: string) => { const copy = { ...block }; delete copy[key]; return copy; };
  if (k === 'header') {
    return <VarText value={textOf(block.text)} ctx={ctx} placeholder="{{headline}}" onChange={(text) => onChange({ ...block, text: { type: 'plain_text', text, emoji: true } })} />;
  }
  if (k === 'matches') return <p className="text-[12px] text-faint">Up to 5 of the most recent matching {ROW_NOUN[ctx.scope]}s, newest first, one line each.</p>;
  if (k === 'divider') return null;
  if (k === 'context') {
    const elements = (block.elements as Obj[]) ?? [];
    return (
      <div className="space-y-1.5">
        {elements.map((e, i) => (
          <VarText key={i} value={textOf(e)} ctx={ctx} multiline placeholder="{{project.name}} · {{time}}"
            onChange={(text) => onChange({ ...block, elements: elements.map((x, j) => (j === i ? { ...x, text } : x)) })} />))}
      </div>
    );
  }
  if (k === 'actions') return <ButtonsEditor buttons={(block.elements as Obj[]) ?? []} max={5} ctx={ctx} onChange={(elements) => onChange({ ...block, elements })} />;
  if (k === 'image') {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="sm:col-span-2"><Label>Image URL</Label><VarText value={str(block.image_url)} ctx={ctx} mono placeholder="https://example.com/chart.png" onChange={(image_url) => onChange({ ...block, image_url })} /></div>
        <label className="block"><Label>Description for screen readers</Label><input className="field text-[12.5px]" value={str(block.alt_text)} onChange={(e) => onChange({ ...block, alt_text: e.target.value })} /></label>
        <label className="block"><Label>Title (optional)</Label><input className="field text-[12.5px]" value={textOf(block.title)}
          onChange={(e) => onChange(e.target.value ? { ...block, title: { type: 'plain_text', text: e.target.value } } : without('title'))} /></label>
      </div>
    );
  }
  if (k === 'text') {
    const fields = Array.isArray(block.fields) ? (block.fields as Obj[]) : [];
    const accessory = isObj(block.accessory) ? block.accessory : null;
    const hasText = block.text !== undefined;
    return (
      <div className="space-y-2.5">
        {(hasText || !fields.length) && (
          <VarText value={textOf(block.text)} ctx={ctx} multiline placeholder="*Bold*, _italic_, `code`, <https://example.com|a link>"
            onChange={(text) => onChange({ ...block, text: md(text) })} />)}
        {fields.length > 0 && (
          <div>
            <Label>Fields, shown in two columns</Label>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {fields.map((f, i) => (
                <div key={i} className="group/f relative">
                  <VarText value={textOf(f)} ctx={ctx} multiline placeholder={'*Label*\nvalue'}
                    onChange={(text) => onChange({ ...block, fields: fields.map((x, j) => (j === i ? md(text) : x)) })} />
                  <button type="button" onClick={() => onChange(fields.length > 1 || hasText ? { ...block, fields: fields.filter((_, j) => j !== i) } : without('fields'))}
                    className="absolute bottom-1.5 right-1.5 rounded-md p-1 text-faint opacity-0 hover:bg-bad/15 hover:text-bad group-hover/f:opacity-100 focus:opacity-100 cursor-pointer" title="Remove field"><Trash2 size={12} /></button>
                </div>))}
            </div>
          </div>)}
        {accessory?.type === 'button' && (
          <div><Label>Button on the right</Label>
            <ButtonsEditor buttons={[accessory]} max={1} ctx={ctx} onChange={([b]) => onChange(b ? { ...block, accessory: b } : without('accessory'))} />
          </div>)}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
          {fields.length < 10 && <button type="button" className={linkCls} onClick={() => onChange({ ...block, fields: [...fields, md('*Label*\nvalue')] })}><Plus size={12} />Add a field</button>}
          {!accessory && <button type="button" className={linkCls} onClick={() => onChange({ ...block, accessory: button('Open', '{{url}}') })}><Plus size={12} />Add a button on the right</button>}
          {fields.length > 0 && !hasText && <button type="button" className={linkCls} onClick={() => onChange({ ...block, text: md('') })}><Plus size={12} />Add text above</button>}
          {fields.length > 0 && hasText && <button type="button" className={linkCls} onClick={() => onChange(without('text'))}>Remove the text</button>}
        </div>
      </div>
    );
  }
  return (
    <div>
      <p className="mb-1.5 text-[12px] text-faint">A <span className="font-mono">{str(block.type)}</span> block. It is sent as it is; change it in the JSON tab.</p>
      <pre className="max-h-32 overflow-auto rounded-lg bg-[var(--hl)] p-2 font-mono text-[11px] text-muted">{JSON.stringify(block, null, 2)}</pre>
    </div>
  );
}

// ---------------------------------------------------------------- Slack-style preview

const EMOJI: Record<string, string> = {
  bell: '🔔', white_check_mark: '✅', warning: '⚠️', rotating_light: '🚨', fire: '🔥', x: '❌', red_circle: '🔴', large_green_circle: '🟢',
  chart_with_upwards_trend: '📈', chart_with_downwards_trend: '📉', eyes: '👀', rocket: '🚀', tada: '🎉', bug: '🐛', zap: '⚡', hourglass: '⌛', point_right: '👉',
};
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const emoji = (s: string) => s.replace(/:([a-z0-9_+-]+):/g, (m, n: string) => EMOJI[n] ?? m);

/** A Slack date token, <!date^unix^format|fallback>, as Slack shows it to the reader (in their time zone). */
function slackDate(unix: number, format: string): string {
  const d = new Date(unix * 1000);
  const day = (offset: number) => { const x = new Date(); x.setDate(x.getDate() + offset); return x.toDateString() === d.toDateString(); };
  const short = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  const long = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const pretty = (s: string) => (day(0) ? 'Today' : day(-1) ? 'Yesterday' : day(1) ? 'Tomorrow' : s);
  const parts: Record<string, string> = {
    date_num: d.toISOString().slice(0, 10), date: d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }), date_short: short, date_long: long,
    date_pretty: pretty(d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })), date_short_pretty: pretty(short), date_long_pretty: pretty(long),
    time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), time_secs: d.toLocaleTimeString(),
  };
  return format.replace(/\{(\w+)\}/g, (m, k: string) => parts[k] ?? m);
}

const INLINE = /```([\s\S]+?)```|`([^`\n]+)`|<!date\^(\d+)\^([^|>]+)(?:\|[^>]*)?>|<([^>|\s]+)(?:\|([^>]+))?>|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|(?<![\w~])~([^~\n]+)~(?![\w~])/g;

/** Slack mrkdwn, close to how Slack shows it: bold, italic, strike, code, links and a few emoji. */
function Mrkdwn({ text, plain }: { text: string; plain?: boolean }): ReactNode {
  if (plain) return emoji(text);
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(emoji(unescape(text.slice(last, m.index))));
    if (m[1] !== undefined) out.push(<pre className="my-1 whitespace-pre-wrap rounded border border-line bg-[var(--hl)] p-2 font-mono text-[12px]">{unescape(m[1])}</pre>);
    else if (m[2] !== undefined) out.push(<code className="rounded border border-line bg-[var(--hl)] px-1 font-mono text-[12px] text-[#e01e5a]">{unescape(m[2])}</code>);
    else if (m[3] !== undefined) out.push(slackDate(Number(m[3]), m[4]));
    else if (m[5] !== undefined) {
      const target = m[5];
      const label = m[6] ?? target.replace(/^mailto:/, '');
      out.push(<a href={/^https?:/.test(target) ? target : undefined} target="_blank" rel="noreferrer" className="text-[#1d9bd1] hover:underline"><Mrkdwn text={label} /></a>);
    } else if (m[7] !== undefined) out.push(<b className="font-bold"><Mrkdwn text={m[7]} /></b>);
    else if (m[8] !== undefined) out.push(<i><Mrkdwn text={m[8]} /></i>);
    else if (m[9] !== undefined) out.push(<s><Mrkdwn text={m[9]} /></s>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(emoji(unescape(text.slice(last))));
  return <>{out.map((x, i) => <Fragment key={i}>{x}</Fragment>)}</>;
}

const TextObj = ({ t }: { t: unknown }) => <Mrkdwn text={textOf(t)} plain={isObj(t) && t.type === 'plain_text'} />;

function SlackButton({ b }: { b: Obj }) {
  const style = b.style === 'primary' ? 'border-[#007a5a] bg-[#007a5a] text-white' : b.style === 'danger' ? 'border-[#e01e5a] bg-[#e01e5a] text-white' : 'border-[var(--line-strong)] text-fg';
  return <a href={str(b.url) || undefined} target="_blank" rel="noreferrer" className={cn('inline-flex h-7 shrink-0 items-center rounded-md border px-3 text-[13px] font-bold', style)}><TextObj t={b.text} /></a>;
}

function PreviewBlock({ b }: { b: Obj }) {
  switch (b.type) {
    case 'header': return <div className="pt-1 text-[18px] font-black leading-snug"><TextObj t={b.text} /></div>;
    case 'section': return (
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          {b.text !== undefined && <div className="whitespace-pre-wrap break-words"><TextObj t={b.text} /></div>}
          {Array.isArray(b.fields) && <div className="grid grid-cols-2 gap-x-4 gap-y-2">{b.fields.map((f, i) => <div key={i} className="whitespace-pre-wrap break-words"><TextObj t={f} /></div>)}</div>}
        </div>
        {isObj(b.accessory) && b.accessory.type === 'button' && <SlackButton b={b.accessory} />}
      </div>
    );
    case 'context': return (
      <div className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
        {(b.elements as Obj[]).map((e, i) => (e.type === 'image' ? <img key={i} src={str(e.image_url)} alt={str(e.alt_text)} className="h-4 w-4 rounded" /> : <span key={i} className="whitespace-pre-wrap"><TextObj t={e} /></span>))}
      </div>
    );
    case 'divider': return <hr className="border-line" />;
    case 'actions': return <div className="flex flex-wrap gap-2">{(b.elements as Obj[]).map((e, i) => (e.type === 'button' ? <SlackButton key={i} b={e} /> : <span key={i} className="text-[12px] text-faint">({str(e.type)})</span>))}</div>;
    case 'image': return (
      <div>
        {isObj(b.title) && <div className="mb-1 text-[13px] text-muted"><TextObj t={b.title} /></div>}
        <img src={str(b.image_url)} alt={str(b.alt_text)} className="max-h-64 max-w-full rounded-lg border border-line" />
      </div>
    );
    default: return <div className="rounded-md border border-dashed border-[var(--line-strong)] px-2 py-1.5 text-[12px] text-faint">A {str(b.type)} block: Slack shows it, this preview doesn’t.</div>;
  }
}

function SlackPreview({ blocks, time }: { blocks: Obj[] | null; time: string }) {
  return (
    <div className="flex gap-2.5 text-[14.5px] leading-[1.46]">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#14141c] text-[13px] font-bold text-white ring-1 ring-[var(--line)]">W</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2"><span className="font-black">WGO</span><span className="text-[12px] text-faint">{time}</span></div>
        <div className="mt-1 space-y-2.5">
          {blocks?.length ? blocks.map((b, i) => <PreviewBlock key={i} b={b} />) : <p className="text-[13px] text-faint">Every block came out empty, so Slack would get the default message.</p>}
        </div>
      </div>
    </div>
  );
}

/** A notification as "Send test" sends it, to fill in the preview. */
function samplePayload(c: SlackDesignContext, projectId: string, projectName: string, state: 'firing' | 'resolved'): TriggerWebhookPayload {
  const page = c.scope === 'spans' ? 'traces' : c.scope;
  const base: TriggerWebhookPayload = {
    trigger: { id: 'preview', name: c.name.trim() || 'Untitled trigger' }, project: { id: projectId, name: projectName }, firedAt: new Date().toISOString(),
    scope: c.scope, matches: 1, url: `${location.origin}${location.pathname}#/p/${projectId}/${page}`, ...sampleRows(c.scope),
  };
  return c.kind === 'match' ? base : { ...base, ...sampleAggregate({ kind: c.kind, scope: c.scope, metric: c.metric, condition: c.condition, windowMinutes: c.windowMinutes }, state) };
}

// ---------------------------------------------------------------- the editor

interface Item { key: number; block: Obj }
let nextKey = 1;
const itemsOf = (t: SlackTemplate): Item[] => t.blocks.map((block) => ({ key: nextKey++, block }));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const iconBtn = 'rounded-md p-1 text-faint enabled:hover:bg-[var(--hl)] enabled:hover:text-fg enabled:cursor-pointer disabled:opacity-30';

/**
 * Design a trigger's Slack message: its blocks (or their JSON) on the left, a preview with sample data on the right.
 * `value` null is the default message; a design equal to the default is saved as null, so it follows future defaults.
 */
export function SlackMessageEditor({ open, value, ctx, onClose, onSave }: {
  open: boolean; value: SlackTemplate | null; ctx: SlackDesignContext; onClose: () => void; onSave: (t: SlackTemplate | null) => void;
}) {
  const { project } = useProject();
  const toast = useToast();
  const test = useTestTrigger(project.id);
  const [items, setItems] = useState<Item[]>([]);
  const [tab, setTab] = useState<'visual' | 'json'>('visual');
  const [json, setJson] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [state, setState] = useState<'firing' | 'resolved'>('firing');
  const [dragging, setDragging] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLSpanElement>(null);
  const fallback = useMemo(() => defaultSlackTemplate(ctx.kind), [ctx.kind]);

  useEffect(() => {
    if (!open) return;
    setItems(itemsOf(value ?? fallback)); setTab('visual'); setJsonError(''); setState('firing');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const template: SlackTemplate = useMemo(() => ({ blocks: items.map((i) => i.block) }), [items]);
  const problem = slackTemplateProblem(template);
  const payload = useMemo(() => samplePayload(ctx, project.id, project.name, state), [ctx, project.id, project.name, state]);
  const rendered = useMemo(() => (problem ? null : renderSlackTemplate(template, payload)), [template, payload, problem]);
  const time = useMemo(() => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (key: number, block: Obj) => setItems((l) => l.map((i) => (i.key === key ? { ...i, block } : i)));
  const move = (from: number, to: number) => setItems((l) => {
    if (to < 0 || to >= l.length || from === to) return l;
    const copy = [...l];
    const [x] = copy.splice(from, 1);
    copy.splice(to, 0, x);
    return copy;
  });
  const add = (k: NewKind) => { setItems((l) => [...l, { key: nextKey++, block: newBlock(k, ctx) }]); setAdding(false); };
  const showTab = (t: 'visual' | 'json') => {
    if (t === 'json') { setJson(JSON.stringify(template, null, 2)); setJsonError(''); }
    setTab(t);
  };
  const editJson = (text: string) => {
    setJson(text);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) { setJsonError((e as Error).message); return; }
    const t = Array.isArray(parsed) ? { blocks: parsed } : parsed; // a bare blocks array, as some examples have it
    const p = slackTemplateProblem(t);
    if (p) { setJsonError(p); return; }
    setJsonError('');
    setItems(itemsOf(t as SlackTemplate));
  };
  const isDefault = same(template, fallback);
  const save = () => { onSave(isDefault ? null : template); onClose(); };
  const sendTest = async () => {
    if (!ctx.testTriggerId) return;
    try {
      const r = await test.mutateAsync({ id: ctx.testTriggerId, slackTemplate: template });
      toast({ title: r.ok ? 'Test message sent to Slack' : 'Slack didn’t take it as designed', body: r.status, tone: r.ok ? 'good' : 'bad' });
    } catch (e) {
      toast({ title: 'Test failed', body: (e as Error).message, tone: 'bad' });
    }
  };
  const builderUrl = `https://app.slack.com/block-kit-builder#${encodeURIComponent(JSON.stringify({ blocks: rendered?.blocks ?? template.blocks }))}`;

  return (
    <Dialog open={open} onClose={onClose} width={1120} title="Slack message"
      footer={<>
        <Button variant="ghost" className="mr-auto" disabled={isDefault} onClick={() => setItems(itemsOf(fallback))} title="Go back to WGO’s default message">Reset to default</Button>
        {ctx.testTriggerId && <Button onClick={() => void sendTest()} disabled={!!problem || test.isPending} title="Send this design to the trigger’s saved Slack channel, marked as a test"><Send size={13} />Send test</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!!problem || (tab === 'json' && !!jsonError)} onClick={save}>Done</Button>
      </>}>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <Segmented value={tab} onChange={showTab} options={[{ value: 'visual', label: 'Blocks' }, { value: 'json', label: 'JSON' }]} />
            <a href={builderUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-fg" title="Open the message, with sample data, in Slack’s Block Kit Builder">
              Open in Block Kit Builder<ExternalLink size={12} />
            </a>
          </div>
          {tab === 'json' ? (
            <div>
              <textarea className="field min-h-[440px] font-mono text-[12px] leading-[1.5]" spellCheck={false} value={json} onChange={(e) => editJson(e.target.value)} />
              <p className={cn('mt-1.5 text-[12px]', jsonError ? 'text-bad' : 'text-faint')}>
                {jsonError || 'Block Kit JSON, as in Slack’s Block Kit Builder: paste a design from there, or copy this one to it. Any text may contain {{variables}}.'}
              </p>
            </div>
          ) : (
            <div className="max-h-[62vh] space-y-2 overflow-y-auto pr-1">
              {items.map((it, i) => {
                const k = kindOf(it.block);
                const label = k === 'text' && Array.isArray(it.block.fields) ? 'Fields' : LABEL[k];
                return (
                  <div key={it.key} draggable={armed === it.key}
                    onDragStart={(e) => { setDragging(i); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragEnd={() => { setDragging(null); setOver(null); setArmed(null); }}
                    onDragOver={(e) => { if (dragging === null) return; e.preventDefault(); setOver(i); }}
                    onDrop={(e) => { e.preventDefault(); if (dragging !== null) move(dragging, i); setDragging(null); setOver(null); }}
                    className={cn('rounded-xl border bg-[var(--raised)] transition-colors', over === i && dragging !== i ? 'border-accent' : 'border-line', dragging === i && 'opacity-50')}>
                    <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                      <span onMouseDown={() => setArmed(it.key)} onMouseUp={() => setArmed(null)} className="cursor-grab rounded p-0.5 text-faint hover:text-fg active:cursor-grabbing" title="Drag to move">
                        <GripVertical size={14} />
                      </span>
                      <span className="text-[12.5px] font-semibold">{label}</span>
                      <span className="ml-auto flex items-center">
                        <button type="button" disabled={i === 0} onClick={() => move(i, i - 1)} className={iconBtn} title="Move up"><ArrowUp size={13} /></button>
                        <button type="button" disabled={i === items.length - 1} onClick={() => move(i, i + 1)} className={iconBtn} title="Move down"><ArrowDown size={13} /></button>
                        <button type="button" onClick={() => setItems((l) => { const c = [...l]; c.splice(i + 1, 0, { key: nextKey++, block: structuredClone(it.block) }); return c; })} className={iconBtn} title="Duplicate"><Copy size={13} /></button>
                        <button type="button" onClick={() => setItems((l) => l.filter((x) => x.key !== it.key))} className="rounded-md p-1 text-faint hover:bg-bad/15 hover:text-bad cursor-pointer" title="Remove"><Trash2 size={13} /></button>
                      </span>
                    </div>
                    {k !== 'divider' && <div className="px-3 pb-3"><BlockFields block={it.block} ctx={ctx} onChange={(b) => update(it.key, b)} /></div>}
                  </div>
                );
              })}
              {!items.length && <p className="py-6 text-center text-[12.5px] text-faint">No blocks. Add one, or reset to the default message.</p>}
              <span ref={addRef} className="inline-block">
                <Button size="sm" onClick={() => setAdding((x) => !x)} disabled={items.length >= 50}><Plus size={13} />Add block</Button>
              </span>
              <Popover anchor={addRef} open={adding} onClose={() => setAdding(false)} align="start" width={300}>
                <div className="space-y-px">
                  {ADDABLE.filter((a) => !a.matchOnly || ctx.kind === 'match').map((a) => (
                    <button key={a.k} type="button" onClick={() => add(a.k)} className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-[var(--hl)] cursor-pointer">
                      <span className="text-[13px] font-medium">{a.label}</span>
                      <span className="block text-[11.5px] text-faint">{a.hint}</span>
                    </button>))}
                </div>
              </Popover>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="mb-3 flex min-h-[30px] flex-wrap items-center justify-between gap-2">
            <span className="text-[12.5px] font-medium text-muted">Preview with sample data</span>
            {ctx.kind !== 'match' && <Segmented value={state} onChange={setState} options={[{ value: 'firing', label: 'Firing' }, { value: 'resolved', label: 'Resolved' }]} />}
          </div>
          <div className="rounded-xl border border-line bg-[var(--bg)] p-4">
            {problem ? <p className="text-[12.5px] text-bad">{problem}</p> : <SlackPreview blocks={rendered?.blocks ?? null} time={time} />}
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-faint">
            Blocks whose text comes out empty are left out. If Slack rejects the design, WGO sends its default message instead and the trigger’s status says why.
            {ctx.kind !== 'match' && ' The same design is used when it starts firing and when it resolves: {{headline}}, {{state}} and {{explanation}} tell them apart.'}
          </p>
        </div>
      </div>
    </Dialog>
  );
}
