import type { AnalyticsEvent, ErrorGroup, Span } from '../../contract';
import * as A from '../analytics';
import type { BackendError } from './targets';
import type { Workspace } from './workspace';

/**
 * What the agent is told about the error, read with the same functions the dashboard uses. Everything here came
 * from browsers (messages, URLs, stacks, element text) and is handed to the model as untrusted data.
 */

const DAY_MS = 86_400_000;
const LOOKBACK_MS = 7 * DAY_MS;

const cut = (s: string | null | undefined, n: number) => (s == null ? '' : s.length > n ? `${s.slice(0, n)}…` : s);
const fpFilter = (fingerprint: string) => JSON.stringify([{ field: 'fingerprint', op: 'eq', value: fingerprint }]);

export async function errorGroup(pid: string, fingerprint: string, now = Date.now()): Promise<ErrorGroup | null> {
  const groups = await A.errors(pid, { from: new Date(now - LOOKBACK_MS).toISOString(), to: new Date(now).toISOString(), filters: fpFilter(fingerprint), limit: '1', bots: '1' });
  return groups.find((g) => g.fingerprint === fingerprint) ?? null;
}

export async function occurrences(pid: string, fingerprint: string, limit = 20): Promise<AnalyticsEvent[]> {
  return (await A.events(pid, { type: 'error', fingerprint, limit: String(Math.min(Math.max(limit, 1), 50)) })).events;
}

/** The session's events up to (and just after) `at`, oldest first. */
export async function sessionTimeline(pid: string, sessionId: string, at?: string, limit = 40): Promise<AnalyticsEvent[]> {
  const before = at ? new Date(new Date(at).getTime() + 5000).toISOString() : undefined;
  const r = await A.events(pid, { sessionId, ...(before ? { before } : {}), limit: String(Math.min(Math.max(limit, 1), 100)) });
  return r.events.reverse();
}

export function eventLine(e: AnalyticsEvent): string {
  const t = e.ts.slice(11, 19);
  switch (e.type) {
    case 'pageview': return `${t} pageview ${cut(e.path ?? e.url, 200)}`;
    case 'click': return `${t} click ${cut(e.selector, 160)}${e.elementText ? ` "${cut(e.elementText, 60)}"` : ''} on ${cut(e.path, 120)}`;
    case 'error': return `${t} error ${cut(e.errorMessage, 300)} on ${cut(e.path, 120)}`;
    case 'http_error': return `${t} failed request ${e.httpMethod ?? 'GET'} ${cut(e.httpUrl, 200)} → ${e.httpStatus ?? 0}${e.durationMs != null ? ` in ${e.durationMs} ms` : ''}${typeof e.props?.trace === 'string' ? ` (trace ${e.props.trace})` : ''}`;
    case 'custom': return `${t} event ${cut(e.name, 100)} on ${cut(e.path, 120)}`;
    default: return `${t} ${e.type} on ${cut(e.path, 120)}`;
  }
}

export function occurrenceLine(e: AnalyticsEvent): string {
  const release = (e.props?.$ctx as { release?: unknown } | undefined)?.release;
  return [e.ts.slice(0, 19).replace('T', ' '), cut(e.url, 200), [e.browser, e.os, e.device].filter(Boolean).join(' / '),
    typeof release === 'string' ? `release ${cut(release, 60)}` : '', e.sessionId ? `session ${e.sessionId}` : ''].filter(Boolean).join(' · ');
}

export function spanLines(spans: Span[], max = 60): string {
  const byParent = new Map<string | null, Span[]>();
  for (const s of spans) byParent.set(s.parentSpanId, [...(byParent.get(s.parentSpanId) ?? []), s]);
  const ids = new Set(spans.map((s) => s.spanId));
  const out: string[] = [];
  const walk = (s: Span, depth: number) => {
    if (out.length >= max) return;
    const status = s.statusCode === 2 ? ` ERROR${s.statusMessage ? `: ${cut(s.statusMessage, 200)}` : ''}` : '';
    const exc = s.events.find((e) => e.name === 'exception');
    const excText = exc ? ` exception: ${cut(String(exc.attributes?.['exception.message'] ?? ''), 200)}` : '';
    out.push(`${'  '.repeat(depth)}${s.service} ${cut(s.name, 120)} ${Math.round(s.durationMs)} ms${status}${excText}`);
    for (const c of (byParent.get(s.spanId) ?? []).sort((a, b) => a.start.localeCompare(b.start))) walk(c, depth + 1);
  };
  for (const root of spans.filter((s) => !s.parentSpanId || !ids.has(s.parentSpanId)).sort((a, b) => a.start.localeCompare(b.start))) walk(root, 0);
  return out.join('\n') || 'No spans.';
}

export async function traceText(pid: string, traceId: string): Promise<string> {
  const t = await A.trace(pid, traceId);
  return spanLines(t.spans);
}

/** The brief for one run: the error group, where in the repository its frames point, and what visitors did before it. */
export async function buildBrief(pid: string, g: ErrorGroup, ws: Workspace): Promise<string> {
  const occ = await occurrences(pid, g.fingerprint, 15);
  const withSession = occ.find((e) => e.sessionId);
  const timeline = withSession ? await sessionTimeline(pid, withSession.sessionId!, withSession.ts, 30) : [];

  const frames: string[] = [];
  for (const f of (g.stackFrames ?? []).slice(0, 15)) {
    const repoFile = f.mapped ? await ws.resolveFrame(f.file) : null;
    frames.push(`- ${f.fn ?? '<anonymous>'} at ${cut(f.file, 200)}:${f.line}:${f.col}${f.mapped ? '' : ' (not source-mapped)'}${repoFile ? ` → repository file ${repoFile}` : ''}`);
  }
  const lines = [
    `Error group ${g.fingerprint}: ${g.count} events in ${g.sessions} sessions over the last 7 days (first ${g.firstSeen}, last ${g.lastSeen}).`,
    g.missingSourcemaps ? `The stack is minified: no source map was uploaded for ${g.missingSourcemaps.files.join(', ')}${g.missingSourcemaps.release ? ` (release ${g.missingSourcemaps.release})` : ''}. Frame positions are in minified code.` : '',
    '',
    '<telemetry>',
    `Kind: ${g.kind ?? 'error'}`,
    `Message: ${cut(g.message, 1000)}`,
    g.source ? `Source: ${cut(g.source, 300)}` : '',
    '',
    'Stack trace (source-mapped where possible):',
    cut(g.sampleStack ?? 'No stack captured.', 6000),
    '',
    frames.length ? `Frames:\n${frames.join('\n')}` : '',
    '',
    occ.length ? `Recent occurrences (newest first):\n${occ.map((e) => `- ${occurrenceLine(e)}`).join('\n')}` : '',
    '',
    timeline.length ? `What one visitor did before the error (session ${withSession!.sessionId}, oldest first):\n${timeline.map((e) => `- ${eventLine(e)}`).join('\n')}` : '',
    '</telemetry>',
  ];
  return lines.filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
}

// ---------------------------------------------------------------- backend errors (spans and logs)

const SEV = (n: number) => (n >= 21 ? 'FATAL' : n >= 17 ? 'ERROR' : n >= 13 ? 'WARN' : n >= 9 ? 'INFO' : 'DEBUG');
const json = (v: unknown, n: number) => cut(JSON.stringify(v ?? {}), n);

export function logLine(l: { ts: string; severityNumber: number; service: string; body: string }): string {
  return `${l.ts.slice(11, 23)} ${SEV(l.severityNumber)} ${l.service}: ${cut(l.body.replace(/\s*\n\s*/g, ' ⏎ '), 300)}`;
}

/** File paths (with a line) in a stack of any common language: `src/a.ts:12`, `File "app/x.py", line 3`, `(Foo.java:40)`. */
export function stackFiles(stack: string): Array<{ file: string; line: number }> {
  const out: Array<{ file: string; line: number }> = [];
  const re = /([\w@.~+\-/\\]+\.(?:tsx?|jsx?|mjs|cjs|py|go|java|kt|rb|cs|php|rs|swift|scala|ex|exs))(?::(\d+)|", line (\d+)|\((\d+)\))/g;
  for (const m of stack.matchAll(re)) {
    const file = m[1].replace(/^file:\/\//, '');
    if (/node_modules|site-packages|dist-packages|\/usr\/lib\/|<frozen|internal\//.test(file)) continue;
    const line = Number(m[2] ?? m[3] ?? m[4]);
    if (!out.some((x) => x.file === file && x.line === line)) out.push({ file, line });
  }
  return out;
}

/** The brief for a failed span or an error log: the exception, where it points in the repository, the trace and its logs. */
export async function buildBackendBrief(pid: string, e: BackendError, ws: Workspace): Promise<string> {
  const frames: string[] = [];
  for (const f of stackFiles(e.stack ?? '').slice(0, 15)) {
    const repoFile = await ws.resolveFrame(f.file);
    frames.push(`- ${cut(f.file, 200)}:${f.line}${repoFile ? ` → repository file ${repoFile}` : ''}`);
  }
  const traceId = e.span?.traceId ?? e.log?.traceId ?? null;
  const at = e.span?.start ?? e.log?.ts ?? new Date().toISOString();
  const logs = traceId
    ? (await A.logs(pid, { traceId, from: new Date(Date.parse(at) - DAY_MS).toISOString(), to: new Date(Date.parse(at) + DAY_MS).toISOString(), limit: '40' }).catch(() => ({ logs: [] }))).logs.reverse()
    : [];
  const what = e.span
    ? [`Span: ${cut(e.span.name, 200)} in service ${e.span.service}, ${Math.round(e.span.durationMs)} ms, status ${e.span.statusCode === 2 ? 'ERROR' : 'not set'}${e.span.statusMessage ? `: ${cut(e.span.statusMessage, 500)}` : ''}`,
      `Span attributes: ${json(e.span.attributes, 3000)}`, `Resource: ${json(e.span.resource, 1000)}`]
    : [`Log record (${e.log!.severityText ?? SEV(e.log!.severityNumber)}) from service ${e.log!.service} at ${e.log!.ts}:`, cut(e.log!.body, 3000),
      `Log attributes: ${json(e.log!.attributes, 3000)}`, `Resource: ${json(e.log!.resource, 1000)}`];
  const lines = [
    `A backend error in service ${e.service}${e.span ? ' (a failed span)' : ' (an error log)'}, from the project's OpenTelemetry data.`,
    ws.rootPath ? `The project's web app lives in ${ws.rootPath}; this service's code may be elsewhere in the repository: find it from the stack, the service name and the span or log text.` : '',
    '',
    '<telemetry>',
    ...what,
    '',
    `Error: ${cut(e.message, 1000)}`,
    e.stack ? `Stack trace:\n${cut(e.stack, 8000)}` : 'No stack trace was recorded.',
    '',
    frames.length ? `Files in the stack:\n${frames.join('\n')}` : '',
    '',
    e.spans?.length ? `The whole trace (${traceId}):\n${spanLines(e.spans)}` : '',
    '',
    logs.length ? `Logs in this trace, oldest first:\n${logs.map((l) => `- ${logLine(l)}`).join('\n')}` : '',
    '</telemetry>',
  ];
  return lines.filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
}
