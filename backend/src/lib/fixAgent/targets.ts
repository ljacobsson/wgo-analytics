import { createHash } from 'node:crypto';
import type { FixTarget, LogRecord, Span } from '../../contract';
import * as A from '../analytics';
import { HttpError } from '../http';
import { rawQuery } from '../store/duck';

/**
 * Backend errors the GitHub Agent can work on: a failed span (status ERROR, or an `exception` event) and an error log
 * record (severity ERROR or FATAL). Each is turned into a message, a stack when there is one, and a fingerprint
 * that's the same for every occurrence of the error, so repeats share one run and one pull request.
 */

export interface BackendError {
  target: Extract<FixTarget, { kind: 'span' | 'log' }>;
  fingerprint: string;
  message: string;
  service: string;
  stack: string | null;
  span?: Span;
  spans?: Span[]; // the whole trace, when known
  log?: LogRecord;
}

const ERROR_SEVERITY = 17; // OTLP: 17-20 error, 21-24 fatal
const TRACE_ID = /^[0-9a-f]{32}$/i;
const SPAN_ID = /^[0-9a-f]{16}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

/** The first frame of a stack in the common formats (JavaScript, Python, Java, Go, .NET, Ruby), without line numbers. */
export function topFrame(stack: string | null): string | null {
  for (const raw of (stack ?? '').split('\n')) {
    const l = raw.trim();
    if (/^at |@\S+:\d+|^File "|\.(py|go|java|kt|rb|cs|php|ts|js|mjs|cjs)[:(]\d+/.test(l)) {
      return l.replace(/:\d+ \+0x[0-9a-f]+$/i, '').replace(/:\d+(?::\d+)?(\)?)$/, '$1').replace(/, line \d+/, '').replace(/\(([^()]*?):\d+\)/, '($1)').slice(0, 300);
    }
  }
  return null;
}

/** Like the browser's errorFingerprint (lib/events.ts): volatile parts of the message erased, plus service and top frame. */
export function backendFingerprint(kind: 'span' | 'log', service: string, message: string, stack: string | null): string {
  const msg = message.split('\n')[0]
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/(["'`]).*?\1/g, '<str>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, '<n>')
    .slice(0, 300);
  return `${kind}:${createHash('sha1').update([service, msg, topFrame(stack) ?? ''].join('|')).digest('hex').slice(0, 16)}`;
}

function spanError(span: Span): { message: string; stack: string | null } | null {
  const exc = span.events.find((e) => e.name === 'exception');
  const type = str(exc?.attributes?.['exception.type']);
  const text = str(exc?.attributes?.['exception.message']);
  const stack = str(exc?.attributes?.['exception.stacktrace']);
  if (!exc && span.statusCode !== 2) return null;
  const message = type && text ? `${type}: ${text}` : text ?? type ?? span.statusMessage ?? `${span.name} failed`;
  return { message: message.slice(0, 2000), stack: stack?.slice(0, 8000) ?? null };
}

function logError(log: LogRecord): { message: string; stack: string | null } {
  const type = str(log.attributes['exception.type']);
  const text = str(log.attributes['exception.message']);
  let stack = str(log.attributes['exception.stacktrace']);
  // a body that is itself a stack trace (a logged Error)
  if (!stack && log.body.split('\n').length > 2 && topFrame(log.body)) stack = log.body;
  const first = log.body.split('\n')[0];
  const message = type && text ? `${type}: ${text}` : text ?? first;
  return { message: message.slice(0, 2000), stack: stack?.slice(0, 8000) ?? null };
}

/** One log record, looked up around `at` (logs are stored by time). */
export async function logById(pid: string, id: string, at: string): Promise<LogRecord | null> {
  const t = Date.parse(at);
  if (!UUID.test(id) || Number.isNaN(t)) throw new HttpError(400, 'A log needs its id and time');
  type Row = { id: string; ts: Date; severity_number: number; severity_text: string | null; body: string; service: string; trace_id: string | null; span_id: string | null; attributes: Record<string, unknown> | null; resource: Record<string, unknown> | null };
  const w = { from: new Date(t - 120_000), to: new Date(t + 120_000) };
  const [r] = await rawQuery<Row>(pid, w,
    `SELECT id, ts, severity_number, severity_text, body, service, trace_id, span_id, attributes, resource
       FROM logs WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND id = $4 LIMIT 1`,
    [pid, w.from, w.to, id.toLowerCase()],
  );
  if (!r) return null;
  return {
    id: r.id, ts: r.ts.toISOString(), severityNumber: r.severity_number, severityText: r.severity_text, body: r.body, service: r.service,
    traceId: r.trace_id, spanId: r.span_id, attributes: r.attributes ?? {}, resource: r.resource ?? {},
  };
}

/** The error a span or log target stands for; null when it isn't stored any more. Throws for targets that aren't errors. */
export async function resolveBackend(pid: string, target: FixTarget): Promise<BackendError | null> {
  if (target.kind === 'span') {
    if (!TRACE_ID.test(target.traceId) || !SPAN_ID.test(target.spanId)) throw new HttpError(400, 'A span needs its trace id and span id');
    let spans: Span[];
    try {
      spans = (await A.trace(pid, target.traceId, target.at ? { at: target.at } : {})).spans;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
    const span = spans.find((s) => s.spanId === target.spanId.toLowerCase() && s.service !== 'browser');
    if (!span) return null;
    const e = spanError(span);
    if (!e) throw new HttpError(400, 'That span didn’t fail: the GitHub Agent works on spans with an error status or an exception');
    const t = { kind: 'span' as const, traceId: span.traceId, spanId: span.spanId, at: span.start };
    return { target: t, fingerprint: backendFingerprint('span', span.service, e.message, e.stack), message: e.message, service: span.service, stack: e.stack, span, spans };
  }
  if (target.kind === 'log') {
    const log = await logById(pid, target.logId, target.at);
    if (!log) return null;
    if (log.severityNumber < ERROR_SEVERITY) throw new HttpError(400, 'The GitHub Agent works on ERROR and FATAL logs');
    const e = logError(log);
    let spans: Span[] | undefined;
    if (log.traceId) spans = await A.trace(pid, log.traceId, { at: log.ts }).then((t) => t.spans, () => undefined);
    return {
      target: { kind: 'log', logId: log.id, at: log.ts }, fingerprint: backendFingerprint('log', log.service, e.message, e.stack),
      message: e.message, service: log.service, stack: e.stack, log, spans,
    };
  }
  throw new HttpError(400, 'Not a span or log');
}

/** A FixTarget from a request body: {fingerprint} (browser, as before) or {kind: 'span'|'log', …}. */
export function parseTarget(body: Record<string, unknown>): FixTarget {
  const kind = body.kind ?? 'browser';
  if (kind === 'browser') {
    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : '';
    if (!fingerprint || fingerprint.length > 200) throw new HttpError(400, 'fingerprint is required');
    return { kind: 'browser', fingerprint };
  }
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  if (kind === 'span') return { kind: 'span', traceId: s('traceId'), spanId: s('spanId'), ...(s('at') ? { at: s('at') } : {}) };
  if (kind === 'log') return { kind: 'log', logId: s('logId'), at: s('at') };
  throw new HttpError(400, 'kind must be browser, span or log');
}
