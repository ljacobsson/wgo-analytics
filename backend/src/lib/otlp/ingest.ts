import { stableUuid } from '../events';
import type { LogRecord, Span } from '../../contract';
import { HttpError } from '../http';
import { recordReleases, seenInSpans } from '../releases';
import { writeRows } from '../store/write';
import { evaluateTriggers } from '../triggers';
import { decodeProtobuf, ExportLogsServiceRequest, ExportMetricsServiceRequest, ExportTraceServiceRequest } from './proto';
import {
  normalizeLogs, normalizeMetrics, normalizeTraces,
  type LogRow, type MetricRow, type SpanRow,
} from './normalize';

/** OTLP decoding and storage shared by the HTTP handler (local dev, tests) and the SQS consumer (deployed). */
const SIGNALS = {
  traces: { schema: ExportTraceServiceRequest, normalize: normalizeTraces, table: 'spans' },
  logs: { schema: ExportLogsServiceRequest, normalize: normalizeLogs, table: 'logs' },
  metrics: { schema: ExportMetricsServiceRequest, normalize: normalizeMetrics, table: 'metric_points' },
} as const;

export type Signal = keyof typeof SIGNALS;
export type OtlpRow = SpanRow | LogRow | MetricRow;

export const isSignal = (s: string | undefined): s is Signal => !!s && Object.hasOwn(SIGNALS, s);
export const isProtobuf = (contentType: string | undefined) => /protobuf/i.test(contentType ?? '');

/**
 * The write key from (lower-cased) request headers or the `key` query parameter.
 * Only x-wgo-key and ?key= make it through CloudFront; the rest are kept for direct and older clients.
 */
export function writeKeyFrom(header: (name: string) => string | undefined, queryKey?: string): string | undefined {
  const auth = header('authorization');
  return (
    header('x-wgo-key') ??
    (auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined) ??
    queryKey
  );
}

/** Decode an (already un-gzipped) OTLP request body into rows. Throws HttpError(400) when it can't be decoded. */
export function decodeOtlp(signal: Signal, projectId: string, body: Buffer, protobuf: boolean): OtlpRow[] {
  const cfg = SIGNALS[signal];
  let req: unknown;
  try {
    req = protobuf ? decodeProtobuf(body, cfg.schema) : JSON.parse(body.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, `Could not decode OTLP ${protobuf ? 'protobuf' : 'JSON'} payload`);
  }
  return (cfg.normalize as (p: string, r: unknown) => OtlpRow[])(projectId, req);
}

/**
 * Give log and metric rows ids derived from where they came from instead of random ones, so storing
 * the same message twice (an SQS redelivery) produces the same rows, which compaction then drops.
 * Spans are already keyed by their trace and span ids.
 */
export function assignStableIds(rows: OtlpRow[], sourceId: string): void {
  rows.forEach((row, i) => {
    if (!('id' in row)) return;
    row.id = stableUuid(`${sourceId}:${i}`);
  });
}

/** Store rows as Parquet: one file per project and day for the whole batch. */
export async function storeOtlpRows(signal: Signal, rows: OtlpRow[]): Promise<void> {
  await writeRows(SIGNALS[signal].table, rows);
  if (signal === 'traces') await recordReleases(seenInSpans(rows as SpanRow[])); // service.version; never throws
}

const toLogRecord = (r: LogRow): LogRecord => ({
  id: r.id, ts: r.ts.toISOString(), severityNumber: r.severity_number, severityText: r.severity_text, body: r.body, service: r.service,
  traceId: r.trace_id, spanId: r.span_id, attributes: r.attributes ?? {}, resource: r.resource ?? {},
});

const toSpan = (r: SpanRow): Span => ({
  traceId: r.trace_id, spanId: r.span_id, parentSpanId: r.parent_span_id, name: r.name, kind: r.kind, service: r.service,
  start: r.start_time.toISOString(), end: r.end_time.toISOString(), durationMs: r.duration_ms, statusCode: r.status_code,
  statusMessage: r.status_message, attributes: r.attributes ?? {}, resource: r.resource ?? {}, events: r.events ?? [],
});

/**
 * Run log and span triggers over rows that were just stored (metrics have no triggers). Call it only after the
 * insert succeeded, so a redelivered batch can't notify for rows we never kept. Never throws.
 */
export async function evaluateOtlpTriggers(signal: Signal, rows: OtlpRow[]): Promise<void> {
  if (signal === 'metrics' || !rows.length) return;
  const byProject = new Map<string, OtlpRow[]>();
  for (const r of rows) byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), r]);
  await Promise.all(
    [...byProject].map(([pid, list]) =>
      (signal === 'logs'
        ? evaluateTriggers(pid, (list as LogRow[]).map(toLogRecord), 'logs')
        : evaluateTriggers(pid, (list as SpanRow[]).map(toSpan), 'spans')
      ).catch((err) => console.warn(`${signal} trigger evaluation failed`, err)),
    ),
  );
}
