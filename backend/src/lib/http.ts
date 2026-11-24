import { gunzipSync } from 'node:zlib';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

export function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  // HTTP API lower-cases header names in payload v2
  return event.headers?.[name.toLowerCase()];
}

/** Raw request body as bytes, transparently un-gzipping (detected by magic bytes, not headers). */
export function rawBody(event: APIGatewayProxyEventV2): Buffer {
  if (!event.body) return Buffer.alloc(0);
  return gunzipIfNeeded(event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'utf8'));
}

/** Un-gzip when the bytes start with the gzip magic number; Content-Encoding isn't forwarded by CloudFront. */
export function gunzipIfNeeded(buf: Buffer): Buffer {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf, { maxOutputLength: 20 * 1024 * 1024 }) : buf;
}

/**
 * The `meta` attribute of a message the intake function (handlers/intake.ts) queued: `name=value`
 * lines, names lower-cased. The first value of a name wins.
 */
export function metaFields(meta: string | undefined): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of (meta ?? '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !fields.has(line.slice(0, i))) fields.set(line.slice(0, i), line.slice(i + 1));
  }
  return fields;
}

export function jsonBody<T = unknown>(event: APIGatewayProxyEventV2): T {
  const buf = rawBody(event);
  if (!buf.length) return {} as T;
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export function handleError(err: unknown): APIGatewayProxyResultV2 {
  if (err instanceof HttpError) return json(err.status, { error: err.message });
  console.error(err);
  return json(500, { error: 'Internal error' });
}
