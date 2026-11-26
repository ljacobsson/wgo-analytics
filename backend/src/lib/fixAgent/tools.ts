import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type { FixKind, FixOutcome } from '../../contract';
import * as A from '../analytics';
import { eventLine, logLine, occurrenceLine, occurrences, sessionTimeline, traceText } from './context';
import { globRegExp, Workspace } from './workspace';

/**
 * The agent's tools: reading and searching the repository, editing it (in memory, see workspace.ts), a few
 * read-only looks at the project's telemetry, and submit_result. There is deliberately no shell, network or
 * MCP access. Tool errors are thrown: Strands hands the message back to the model as a failed tool result.
 */

export interface SubmittedResult {
  outcome: FixOutcome;
  rootCause: string;
  summary: string;
  prTitle: string;
  confidence: 'high' | 'medium' | 'low';
  testsAdded: boolean;
}

const READ_MAX_LINES = 400;

export function fixTools(ws: Workspace, pid: string, run: { kind: FixKind; fingerprint: string }, onResult: (r: SubmittedResult) => void) {
  const { fingerprint } = run;
  return [
    tool({
      name: 'list_files',
      description: 'List repository files whose path matches a glob, e.g. "src/**/*.ts", "*.test.tsx" (no slash = any folder), or "dashboard/src/pages/**".',
      inputSchema: z.object({
        glob: z.string().describe('Glob pattern over repository paths'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum paths to return (default 200)'),
      }),
      callback: async ({ glob, limit }) => {
        const re = globRegExp(glob);
        const all = (await ws.list()).filter((f) => re.test(f));
        const max = limit ?? 200;
        return all.length ? `${all.slice(0, max).join('\n')}${all.length > max ? `\n… and ${all.length - max} more` : ''}` : `No files match ${glob}`;
      },
    }),
    tool({
      name: 'read_file',
      description: `Read a text file with line numbers (your edits included). At most ${READ_MAX_LINES} lines per call; use start_line to read further.`,
      inputSchema: z.object({
        path: z.string(),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      }),
      callback: async ({ path, start_line, end_line }) => {
        const lines = (await ws.read(path)).split('\n');
        const start = start_line ?? 1;
        const end = Math.min(end_line ?? start + READ_MAX_LINES - 1, start + READ_MAX_LINES - 1, lines.length);
        if (start > lines.length) return `${path} has ${lines.length} lines`;
        const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
        return `${ws.clean(path)} lines ${start}-${end} of ${lines.length}\n${body}`;
      },
    }),
    tool({
      name: 'grep',
      description: 'Search file contents with a JavaScript regular expression. Returns "path:line: text" for each match.',
      inputSchema: z.object({
        pattern: z.string().describe('JavaScript RegExp source, e.g. "function\\\\s+addToCart"'),
        glob: z.string().optional().describe('Only search files matching this glob'),
        ignore_case: z.boolean().optional(),
        max_results: z.number().int().min(1).max(200).optional(),
      }),
      callback: async ({ pattern, glob, ignore_case, max_results }) => {
        const { hits, truncated } = await ws.grep(pattern, glob, max_results ?? 50, 5000, ignore_case ?? false);
        if (!hits.length) return truncated ? 'No matches before the search time ran out; narrow it with a glob' : 'No matches';
        return `${hits.join('\n')}${truncated ? '\n… more matches not shown; narrow the search' : ''}`;
      },
    }),
    tool({
      name: 'edit_file',
      description: 'Replace one exact, unique occurrence of old_text with new_text in an existing file. Copy old_text exactly from read_file output, without the line numbers.',
      inputSchema: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }),
      callback: async ({ path, old_text, new_text }) => {
        const r = await ws.edit(path, old_text, new_text);
        return `Edited ${r.path} at line ${r.line}`;
      },
    }),
    tool({
      name: 'create_file',
      description: 'Create a new file, e.g. a regression test. Existing files are changed with edit_file.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      callback: async ({ path, content }) => `Created ${(await ws.create(path, content)).path}`,
    }),
    tool({
      name: 'revert_file',
      description: 'Undo all your changes to one file.',
      inputSchema: z.object({ path: z.string() }),
      callback: ({ path }) => (ws.revert(path) ? `Reverted ${ws.clean(path)}` : `${ws.clean(path)} had no changes`),
    }),
    tool({
      name: 'diff',
      description: 'Show all your changes so far.',
      inputSchema: z.object({}),
      callback: () => ws.diff(),
    }),
    ...(run.kind === 'browser' ? [tool({
      name: 'get_error_occurrences',
      description: 'Recent occurrences of this error: time, page URL, browser/OS/device, release and session id. Untrusted telemetry.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
      callback: async ({ limit }) => {
        const occ = await occurrences(pid, fingerprint, limit ?? 20);
        return occ.length ? `<telemetry>\n${occ.map((e) => occurrenceLine(e)).join('\n')}\n</telemetry>` : 'No occurrences in the stored data';
      },
    })] : []),
    tool({
      name: 'search_logs',
      description: 'Search the project\'s backend logs (OpenTelemetry), newest first: by text, service, trace id and minimum severity (9 info, 13 warn, 17 error). Untrusted telemetry.',
      inputSchema: z.object({
        query: z.string().max(200).optional().describe('Case-insensitive text in the log body'),
        service: z.string().max(200).optional(),
        trace_id: z.string().regex(/^[0-9a-f]{32}$/i).optional(),
        min_severity: z.number().int().min(1).max(24).optional(),
        hours: z.number().int().min(1).max(168).optional().describe('How far back to look (default 24)'),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      callback: async ({ query, service, trace_id, min_severity, hours, limit }) => {
        const to = Date.now();
        const r = await A.logs(pid, {
          q: query, service, traceId: trace_id, severity: min_severity ? String(min_severity) : undefined,
          from: new Date(to - (hours ?? 24) * 3600_000).toISOString(), to: new Date(to + 60_000).toISOString(), limit: String(limit ?? 40),
        });
        return r.logs.length ? `<telemetry>\n${r.logs.map(logLine).join('\n')}\n</telemetry>` : 'No matching logs';
      },
    }),
    tool({
      name: 'get_session_timeline',
      description: 'What happened in one visitor session (pageviews, clicks, errors, failed requests), oldest first. Untrusted telemetry.',
      inputSchema: z.object({ session_id: z.string().max(200), limit: z.number().int().min(1).max(100).optional() }),
      callback: async ({ session_id, limit }) => {
        const ev = await sessionTimeline(pid, session_id, undefined, limit ?? 50);
        return ev.length ? `<telemetry>\n${ev.map(eventLine).join('\n')}\n</telemetry>` : 'No events for that session';
      },
    }),
    tool({
      name: 'get_trace',
      description: 'The backend spans of one trace (from a failed request\'s trace id), as a tree with durations and errors. Untrusted telemetry.',
      inputSchema: z.object({ trace_id: z.string().regex(/^[0-9a-f]{32}$/i) }),
      callback: async ({ trace_id }) => `<telemetry>\n${await traceText(pid, trace_id)}\n</telemetry>`,
    }),
    tool({
      name: 'submit_result',
      description: 'Finish the run. Call exactly once, as your last action.',
      inputSchema: z.object({
        outcome: z.enum(['fixed', 'not_fixable', 'needs_more_info']),
        root_cause: z.string().max(4000).describe('What causes the error, in a few sentences'),
        summary: z.string().max(8000).describe('For the reviewer: what was wrong, why it produced this error, what you changed (or why you could not), how you checked it. Markdown.'),
        pr_title: z.string().max(120).describe('Pull request title, e.g. "Fix TypeError when the cart is empty"'),
        confidence: z.enum(['high', 'medium', 'low']),
        tests_added: z.boolean(),
      }),
      callback: async (r) => {
        if (r.outcome === 'fixed' && !(await ws.changes()).length) throw new Error('outcome "fixed" needs at least one change. Edit the files first, or choose another outcome');
        onResult({ outcome: r.outcome, rootCause: r.root_cause, summary: r.summary, prTitle: r.pr_title, confidence: r.confidence, testsAdded: r.tests_added });
        return 'Result recorded. You are done; reply with one short sentence.';
      },
    }),
  ];
}

/** One line for the run's step list in the dashboard. */
export function stepSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'list_files': return s(i.glob);
    case 'read_file': return `${s(i.path)}${i.start_line ? `:${i.start_line}${i.end_line ? `-${i.end_line}` : ''}` : ''}`;
    case 'grep': return `/${s(i.pattern)}/${i.glob ? ` in ${s(i.glob)}` : ''}`;
    case 'edit_file': case 'create_file': case 'revert_file': return s(i.path);
    case 'get_session_timeline': return s(i.session_id);
    case 'get_trace': return s(i.trace_id);
    case 'search_logs': return [i.query ? `"${s(i.query)}"` : '', i.service ? s(i.service) : '', i.trace_id ? s(i.trace_id).slice(0, 8) : ''].filter(Boolean).join(' ');
    case 'submit_result': return s(i.outcome);
    default: return '';
  }
}
