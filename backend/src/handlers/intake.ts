import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 as Result } from 'aws-lambda';
import { EDGE_HEADER } from '../lib/geo';

/**
 * The intake: CloudFront → this function (a Lambda function URL) → SQS. It writes each SDK batch (POST /ingest) and
 * OTLP request (POST /v1/{signal}) to its queue as it arrived and answers straight away; IngestFunction and
 * OtlpFunction process the messages (handlers/ingest.ts and otlp.ts). Nothing here touches DSQL or S3, so it stays
 * small and fast: the write key is checked by the consumers, which drop requests with an unknown key.
 *
 * Messages: the body is the request body, base64-encoded (SDK batches may be gzipped, OTLP may be protobuf); the
 * `meta` attribute holds `name=value` lines with the query-string key and the request headers that matter,
 * lower-cased (parsed by parseQueuedBatch and parseQueuedRequest).
 *
 * The function URL is public (CloudFront's origin access control can't sign POST bodies the SDK sends), so it only
 * accepts requests carrying the secret header CloudFront adds on the way to the origin.
 */

/** The OTLP signals the consumer stores (lib/otlp/ingest.ts); kept here so the bundle stays free of the storage code. */
const SIGNALS = new Set(['traces', 'logs', 'metrics']);

/** SQS's limit covers the body and the attributes. */
const MAX_MESSAGE_BYTES = 1024 * 1024;

const CORS = { 'access-control-allow-origin': '*' };
const PREFLIGHT = {
  ...CORS,
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'content-type,content-encoding,x-wgo-key',
  'access-control-max-age': '86400',
};

const json = (statusCode: number, body: unknown): Result => ({ statusCode, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify(body) });

export type Queue = 'ingest' | 'otlp';
export interface QueuedMessage { queue: Queue; body: string; meta: string }
export type Send = (msg: QueuedMessage) => Promise<void>;

/** A header or query value on one meta line: no line breaks (they would start a new name=value line). */
const line = (name: string, value: string | undefined) => (value == null ? null : `${name}=${value.replace(/[\r\n]+/g, ' ')}`);

const headerLines = (event: APIGatewayProxyEventV2, keep: (name: string) => boolean) =>
  Object.entries(event.headers ?? {})
    .filter(([name]) => keep(name.toLowerCase()))
    .map(([name, value]) => line(name.toLowerCase(), value));

/**
 * A function URL passes text types (application/json, text/*) to the function as a string, which mangles a
 * gzipped JSON body (OTLP exporters send those). So CloudFront (IntakeBodyFunction in template.yaml) sends every
 * body as application/octet-stream, which arrives base64-encoded byte for byte, and moves the request's own
 * Content-Type into this query parameter.
 */
export const CONTENT_TYPE_PARAM = 'wgo-ct';

/** The Content-Type the sender used. */
export function contentType(event: APIGatewayProxyEventV2): string | undefined {
  const moved = event.queryStringParameters?.[CONTENT_TYPE_PARAM];
  if (moved == null) return event.headers?.['content-type'];
  try {
    return moved.includes('%') ? decodeURIComponent(moved) : moved; // in case it arrives encoded twice
  } catch {
    return moved;
  }
}

/** The request body as base64, whether the function URL handed it over as text or base64. */
const base64Body = (event: APIGatewayProxyEventV2) => (!event.body ? '' : event.isBase64Encoded ? event.body : Buffer.from(event.body, 'utf8').toString('base64'));

/** What to queue for a request, or the response to send instead. */
export function toMessage(event: APIGatewayProxyEventV2): QueuedMessage | Result {
  const path = event.rawPath;
  let queue: Queue;
  let lines: Array<string | null>;
  if (path === '/ingest') {
    queue = 'ingest';
    lines = ['source=sdk', ...headerLines(event, (n) => n === 'user-agent' || n === EDGE_HEADER || n.startsWith('cloudfront-viewer-')), line('k', event.queryStringParameters?.k)];
  } else if (path.startsWith('/v1/')) {
    const signal = path.slice(4);
    if (!SIGNALS.has(signal)) return json(404, { error: 'Unknown OTLP signal' });
    queue = 'otlp';
    lines = [line('signal', signal), line('content-type', contentType(event)), ...headerLines(event, (n) => n === 'x-wgo-key' || n === 'authorization'), line('key', event.queryStringParameters?.key)];
  } else {
    return json(404, { error: 'Not found' });
  }
  const body = base64Body(event);
  const meta = lines.filter((l): l is string => l !== null).join('\n');
  // same answers as SQS gave through API Gateway: an empty body or one over the limit is rejected
  if (!body || Buffer.byteLength(body) + Buffer.byteLength(meta) + 4 > MAX_MESSAGE_BYTES) return json(400, { error: 'Request rejected: empty, or larger than the queue accepts' });
  return { queue, body, meta };
}

/** OTLP spec: answer in the request's encoding; an empty protobuf message is zero bytes. */
function accepted(event: APIGatewayProxyEventV2, queue: Queue): Result {
  if (queue === 'ingest') return json(202, {});
  const protobuf = (contentType(event) ?? '').toLowerCase().includes('protobuf');
  return protobuf ? { statusCode: 200, headers: { 'content-type': 'application/x-protobuf', ...CORS }, body: '' } : json(200, {});
}

export function createHandler(send: Send, edgeSecret = process.env.EDGE_SECRET) {
  return async (event: APIGatewayProxyEventV2): Promise<Result> => {
    if (edgeSecret && event.headers?.[EDGE_HEADER] !== edgeSecret) return json(403, { error: 'Forbidden' });
    const method = event.requestContext?.http?.method;
    if (method === 'OPTIONS') return { statusCode: 204, headers: PREFLIGHT };
    if (method !== 'POST') return json(405, { error: 'Method not allowed' });
    const msg = toMessage(event);
    if (!('queue' in msg)) return msg;
    try {
      await send(msg);
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 500;
      console.error(JSON.stringify({ msg: 'could not queue request', queue: msg.queue, status, error: (err as Error).name }));
      return status >= 400 && status < 500 ? json(400, { error: 'Request rejected: empty, or larger than the queue accepts' }) : json(503, { error: 'Could not queue the request, please retry' });
    }
    return accepted(event, msg.queue);
  };
}

let sqsSend: Send | null = null;

/** SendMessage to the queue's URL, with one client per container (it keeps connections alive). */
async function sendToSqs(msg: QueuedMessage): Promise<void> {
  if (!sqsSend) {
    const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
    const sqs = new SQSClient({});
    const urls: Record<Queue, string | undefined> = { ingest: process.env.INGEST_QUEUE_URL, otlp: process.env.OTLP_QUEUE_URL };
    sqsSend = async (m) => {
      await sqs.send(new SendMessageCommand({
        QueueUrl: urls[m.queue],
        MessageBody: m.body,
        MessageAttributes: m.meta ? { meta: { DataType: 'String', StringValue: m.meta } } : undefined,
      }));
    };
  }
  return sqsSend(msg);
}

export const handler = createHandler(sendToSqs);
