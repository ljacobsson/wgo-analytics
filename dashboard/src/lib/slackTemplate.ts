import type { AnalyticsEvent, FilterScope, LogRecord, SlackTemplate, Span, TriggerKind, TriggerMetric, TriggerWebhookPayload } from '../api/contract';

/**
 * Slack messages of triggers: the default one, and a trigger's own design (SlackTemplate: Block Kit blocks with
 * {{variables}}). Pure code, copied verbatim to dashboard/src/lib/slackTemplate.ts so the message designer previews
 * exactly what is sent (test/slackTemplate.test.ts checks the copies match).
 */

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------- describing rows and numbers

export function describe(e: AnalyticsEvent): string {
  const where = [e.path, e.city && e.country ? `${e.city}, ${e.country}` : e.country].filter(Boolean).join(' · ');
  const what =
    e.type === 'click' ? `click “${e.trackName || e.elementText || e.selector || '?'}”`
    : e.type === 'error' ? `error: ${e.errorMessage ?? ''}`
    : e.type === 'http_error' ? `${e.httpMethod} ${e.httpRoute ?? e.httpUrl} → ${e.httpStatus}`
    : e.type === 'custom' ? `${e.name}`
    : e.type === 'pageview' ? `pageview ${e.path ?? ''}`
    : e.type;
  return where ? `${what}  (${where})` : what;
}

const SEVERITY: Array<[number, string]> = [[21, 'FATAL'], [17, 'ERROR'], [13, 'WARN'], [9, 'INFO'], [5, 'DEBUG'], [0, 'TRACE']];
const severityName = (n: number) => SEVERITY.find(([min]) => n >= min)![1];

export function describeLog(l: LogRecord): string {
  return `[${l.severityText || severityName(l.severityNumber)}] ${l.service}: ${l.body.replace(/\s+/g, ' ')}`;
}

export function describeSpan(s: Span): string {
  const ms = s.durationMs >= 1000 ? `${(s.durationMs / 1000).toFixed(2)} s` : `${Math.round(s.durationMs)} ms`;
  return `${s.service}: ${s.name} · ${ms}${s.statusCode === 2 ? ` · error${s.statusMessage ? `: ${s.statusMessage}` : ''}` : ''}`;
}

const NOUN: Record<FilterScope, string> = { events: 'event', logs: 'log record', spans: 'span' };

const AGG_LABEL: Record<TriggerMetric['agg'], string> = {
  count: 'Count', sessions: 'Sessions', session_rate: 'Share of sessions', avg: 'Average', p75: 'p75', p95: 'p95',
};
export const fmtValue = (v: number | null | undefined, m?: TriggerMetric) => {
  if (v == null) return 'no data';
  if (m?.agg === 'session_rate') return `${(v * 100).toFixed(1)}%`;
  if (m?.field && /duration|ms$|lcp|inp|fcp|ttfb/i.test(m.field)) return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
  return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2);
};
const windowText = (min?: number) => (!min ? '' : min < 60 ? `${min} minutes` : min === 60 ? 'hour' : min < 1440 ? `${min / 60} hours` : '24 hours');

/** "Count in the last 15 minutes is 34, above 20" / "… is 3, unusually low (usually 9–15)" / "… is back to normal: 12". */
export function describeAggregate(p: Pick<TriggerWebhookPayload, 'kind' | 'state' | 'value' | 'metric' | 'condition' | 'windowMinutes' | 'baseline'>): string {
  const m = p.metric;
  const what = `${m ? AGG_LABEL[m.agg] : 'Value'}${m?.field ? ` of ${m.field}` : ''} in the last ${windowText(p.windowMinutes)}`;
  const v = fmtValue(p.value, m);
  if (p.state === 'resolved') return `${what} is back to normal: ${v}.`;
  const c = p.condition;
  if (c && 'op' in c) return `${what} is ${v}, ${c.op} ${fmtValue(c.value, m)}.`;
  const b = p.baseline;
  const usual = b ? ` (usually ${fmtValue(b.low, m)} to ${fmtValue(b.high, m)})` : '';
  const dir = b && p.value != null && p.value < b.median ? 'low' : 'high';
  return `${what} is ${v}, unusually ${dir}${usual}.`;
}

// ---------------------------------------------------------------- variables

/** A variable's text as plain text, and (when it carries formatting) as Slack mrkdwn. */
interface Value { plain: string; mrkdwn?: string }
type Vars = Record<string, Value>;

const isAggregate = (p: Pick<TriggerWebhookPayload, 'kind'>) => !!p.kind && p.kind !== 'match';

/** When it fired: in mrkdwn a Slack date, shown in each reader's own time zone ("Today 14:05"); elsewhere UTC. */
function firedTime(iso: string): Value {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return { plain: iso };
  const utc = `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return { plain: utc, mrkdwn: `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} {time}|${utc}>` };
}

/** The variables of a notification (see SLACK_TEMPLATE_VARIABLES), except row fields (resolved on demand). */
export function templateVars(p: TriggerWebhookPayload): Vars {
  const test = p.test ? '[test] ' : '';
  const common: Vars = {
    'trigger.name': { plain: p.trigger.name },
    'project.name': { plain: p.project.name },
    url: { plain: p.url },
    firedAt: { plain: p.firedAt },
    time: firedTime(p.firedAt),
    scope: { plain: p.scope ?? 'events' },
  };
  if (isAggregate(p)) {
    const line = describeAggregate(p);
    const explanation = p.explanation && p.state !== 'resolved' ? p.explanation : '';
    return {
      ...common,
      headline: { plain: `${test}${p.state === 'resolved' ? '✅ Resolved' : '🔔'} ${p.trigger.name}` },
      summary: { plain: `${line} Project ${p.project.name}.`, mrkdwn: `${esc(line)} Project *${esc(p.project.name)}*.` },
      state: { plain: p.state ?? '' },
      value: { plain: fmtValue(p.value, p.metric) },
      explanation: { plain: explanation, mrkdwn: esc(explanation).slice(0, 2900) },
      matches_list: { plain: '' },
      matches: { plain: '' },
    };
  }
  const what = `${p.matches} matching ${NOUN[p.scope ?? 'events']}${p.matches === 1 ? '' : 's'}`;
  const described = p.logs ? p.logs.map(describeLog) : p.spans ? p.spans.map(describeSpan) : p.events.map(describe);
  const recent = described.slice(-5).reverse();
  return {
    ...common,
    headline: { plain: `🔔 ${test}${p.trigger.name}` },
    summary: { plain: `${what} in ${p.project.name}`, mrkdwn: `${what} in *${esc(p.project.name)}*` },
    matches_list: { plain: recent.map((d) => `• ${d.slice(0, 180)}`).join('\n'), mrkdwn: recent.map((d) => `• ${esc(d).slice(0, 180)}`).join('\n').slice(0, 2900) },
    matches: { plain: String(p.matches) },
    state: { plain: '' },
    value: { plain: '' },
    explanation: { plain: '' },
  };
}

/** `obj` at a dotted path; keys may contain dots themselves (attributes["http.route"]), longest key first. */
function at(obj: unknown, segs: string[]): unknown {
  if (!segs.length) return obj;
  if (obj === null || typeof obj !== 'object') return undefined;
  for (let i = segs.length; i > 0; i--) {
    const key = segs.slice(0, i).join('.');
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const v = at((obj as Record<string, unknown>)[key], segs.slice(i));
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

const ROWS = { event: 'events', log: 'logs', span: 'spans' } as const;

/** A variable's value: a named one, or a field of the most recent matching row ("event.path", "span.attributes.http.route"). */
function lookup(name: string, vars: Vars, p: TriggerWebhookPayload): Value {
  if (vars[name]) return vars[name];
  const [head, ...rest] = name.split('.');
  const list = head in ROWS ? (p[ROWS[head as keyof typeof ROWS]] as unknown[] | undefined) : undefined;
  if (!list?.length || !rest.length) return { plain: '' };
  const v = at(list[list.length - 1], rest);
  return { plain: v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v) };
}

const VAR = /\{\{\s*([\w.\-]+)\s*\}\}/g;

// ---------------------------------------------------------------- rendering

type Json = unknown;
type Obj = Record<string, Json>;
const isObj = (v: Json): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isHttp = (v: Json) => typeof v === 'string' && /^https?:\/\/\S+$/.test(v);

/** Replace {{variables}} in every string: as mrkdwn (escaped, with formatting) in mrkdwn text objects, else as plain text. */
function fill(v: Json, sub: (s: string, mrkdwn: boolean) => string, mrkdwn = false): Json {
  if (typeof v === 'string') return sub(v, mrkdwn);
  if (Array.isArray(v)) return v.map((x) => fill(x, sub));
  if (!isObj(v)) return v;
  const md = v.type === 'mrkdwn';
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, sub, md && k === 'text')]));
}

/** A text object with something in it, cut to `max`; null when empty (Slack rejects empty text). */
function text(t: Json, max: number): Obj | null {
  if (!isObj(t) || typeof t.text !== 'string' || !t.text.trim()) return null;
  return t.text.length > max ? { ...t, text: t.text.slice(0, max) } : t;
}

/** A button with text and (when it has one) a working link; null otherwise. */
function button(b: Json): Obj | null {
  if (!isObj(b) || b.type !== 'button') return isObj(b) ? b : null;
  const t = text(b.text, 75);
  if (!t || ('url' in b && !isHttp(b.url))) return null;
  return { ...b, text: t };
}

/**
 * Make a rendered block fit Slack: cut text to its limits and leave out what would make Slack reject the message
 * (empty text, links that came out empty). Null drops the block.
 */
function tidy(b: Json): Obj | null {
  if (!isObj(b)) return null;
  switch (b.type) {
    case 'header': {
      const t = text(b.text, 150);
      return t ? { ...b, text: t } : null;
    }
    case 'section': {
      const t = text(b.text, 3000);
      const fields = Array.isArray(b.fields) ? b.fields.map((f) => text(f, 2000)).filter(Boolean).slice(0, 10) : [];
      const accessory = b.accessory === undefined ? undefined : button(b.accessory);
      if (!t && !fields.length) return null;
      const { text: _t, fields: _f, accessory: _a, ...rest } = b;
      return { ...rest, ...(t ? { text: t } : {}), ...(fields.length ? { fields } : {}), ...(accessory ? { accessory } : {}) };
    }
    case 'context': {
      const elements = Array.isArray(b.elements) ? b.elements.map((e) => (isObj(e) && e.type === 'image' ? (isHttp(e.image_url) ? e : null) : text(e, 3000))).filter(Boolean) : [];
      return elements.length ? { ...b, elements } : null;
    }
    case 'actions': {
      const elements = Array.isArray(b.elements) ? b.elements.map(button).filter(Boolean) : [];
      return elements.length ? { ...b, elements } : null;
    }
    case 'image':
      return isHttp(b.image_url) ? { ...b, alt_text: typeof b.alt_text === 'string' && b.alt_text.trim() ? b.alt_text.slice(0, 2000) : 'image' } : null;
    default:
      return b;
  }
}

/** The text Slack shows in notifications and where blocks can't be shown. */
export function fallbackText(p: TriggerWebhookPayload): string {
  if (isAggregate(p)) return `${p.test ? '[test] ' : ''}${p.state === 'resolved' ? '✅ Resolved' : '🔔'} ${p.trigger.name}: ${describeAggregate(p)}`;
  return `🔔 ${p.test ? '[test] ' : ''}${p.trigger.name}: ${p.matches} matching ${NOUN[p.scope ?? 'events']}${p.matches === 1 ? '' : 's'}`;
}

/** The message of a notification designed with `template`. No blocks left after rendering: null. */
export function renderSlackTemplate(template: SlackTemplate, p: TriggerWebhookPayload): { text: string; blocks: Obj[] } | null {
  const vars = templateVars(p);
  const sub = (s: string, mrkdwn: boolean) => s.replace(VAR, (_, name: string) => {
    const v = lookup(name, vars, p);
    return mrkdwn ? v.mrkdwn ?? esc(v.plain) : v.plain;
  });
  const blocks = (fill(template.blocks, sub) as Json[]).map(tidy).filter((b): b is Obj => !!b).slice(0, 50);
  return blocks.length ? { text: fallbackText(p), blocks } : null;
}

/** The default message's design, as a template to start from. */
export function defaultSlackTemplate(kind: TriggerKind = 'match'): SlackTemplate {
  const md = (t: string) => ({ type: 'section', text: { type: 'mrkdwn', text: t } });
  return {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '{{headline}}', emoji: true } },
      md('{{summary}}'),
      md(kind === 'match' ? '{{matches_list}}' : '{{explanation}}'),
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in WGO' }, url: '{{url}}' }] },
    ],
  };
}

/** Slack Block Kit message for a notification: its trigger's design, or the default one. */
export function slackMessage(p: TriggerWebhookPayload, template?: SlackTemplate | null): { text: string; blocks: Obj[] } {
  return (template && renderSlackTemplate(template, p)) ?? renderSlackTemplate(defaultSlackTemplate(isAggregate(p) ? 'threshold' : 'match'), p)!;
}

// ---------------------------------------------------------------- validation

export const SLACK_BLOCK_TYPES = ['header', 'section', 'context', 'divider', 'actions', 'image', 'rich_text'] as const;
const MAX_TEMPLATE_BYTES = 20_000;

/** Why `v` isn't a usable SlackTemplate, or null. Slack checks the details when sending (and on "Send test"). */
export function slackTemplateProblem(v: unknown): string | null {
  if (!isObj(v) || !Array.isArray(v.blocks)) return 'A Slack message must be { "blocks": [...] }';
  if (!v.blocks.length) return 'A Slack message needs at least one block';
  if (v.blocks.length > 50) return 'Slack allows at most 50 blocks';
  for (const [i, b] of v.blocks.entries()) {
    if (!isObj(b) || typeof b.type !== 'string') return `Block ${i + 1} needs a "type"`;
    if (!(SLACK_BLOCK_TYPES as readonly string[]).includes(b.type)) return `Block ${i + 1}: "${b.type}" blocks aren't supported (use ${SLACK_BLOCK_TYPES.join(', ')})`;
  }
  if (JSON.stringify(v).length > MAX_TEMPLATE_BYTES) return 'The Slack message is too large (at most 20 KB of JSON)';
  return null;
}

// ---------------------------------------------------------------- samples ("Send test" and the designer's preview)

export function sampleEvent(now = new Date().toISOString()): AnalyticsEvent {
  return {
    id: crypto.randomUUID(), type: 'click', ts: now, sessionId: 'test', anonId: null, userId: null, url: null, path: '/example',
    title: null, referrer: null, selector: 'button#example', elementText: 'Example button', elementTag: 'button', trackName: 'example',
    errorMessage: null, errorStack: null, errorSource: null, fingerprint: null, httpMethod: null, httpUrl: null, httpRoute: null, httpStatus: null,
    durationMs: null, name: null, props: {}, browser: 'Chrome', os: 'macOS', device: 'desktop', country: 'SE', region: null, city: 'Stockholm', lat: null, lon: null, bot: null,
  };
}

/** One example matching row of `scope`. */
export function sampleRows(scope: FilterScope, now = new Date().toISOString()): Pick<TriggerWebhookPayload, 'events' | 'logs' | 'spans'> {
  if (scope === 'logs') return { events: [], logs: [{ id: crypto.randomUUID(), ts: now, severityNumber: 17, severityText: 'ERROR', body: 'Example log message', service: 'example-service', traceId: null, spanId: null, attributes: {}, resource: {} }] };
  if (scope === 'spans') return { events: [], spans: [{ traceId: '0'.repeat(32), spanId: '0'.repeat(16), parentSpanId: null, name: 'GET /example', kind: 2, service: 'example-service', start: now, end: now, durationMs: 1234, statusCode: 2, statusMessage: 'Example failure', attributes: {}, resource: {}, events: [] }] };
  return { events: [sampleEvent(now)] };
}

/** What a threshold/anomaly trigger's test notification reports. */
export function sampleAggregate(t: { kind: TriggerKind; scope: FilterScope; metric: TriggerMetric | null; condition: TriggerWebhookPayload['condition'] | null; windowMinutes: number | null }, state: 'firing' | 'resolved' = 'firing'): Partial<TriggerWebhookPayload> {
  const c = t.condition;
  const value = state === 'resolved' ? (c && 'op' in c ? (c.op === 'above' ? Math.max(0, Math.floor(c.value / 2)) : c.value * 2 || 1) : 12) : c && 'op' in c ? (c.op === 'above' ? c.value * 1.5 || 1 : 0) : 42;
  return {
    events: [], logs: undefined, spans: undefined, kind: t.kind, state, value, metric: t.metric ?? undefined, condition: c ?? undefined,
    windowMinutes: t.windowMinutes ?? 60, baseline: c && 'op' in c ? null : { median: 12, low: 8, high: 17, days: 7 },
    ...(t.scope === 'events' ? { explanation: 'Example: 80% of the increase is on /checkout, which was 10% of the total before. It started around 14:05 UTC, 2 minutes after release 1.4.2 was first seen.' } : {}),
  };
}
