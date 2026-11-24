import { gzipSync } from 'node:zlib';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { createHandler, toMessage, type QueuedMessage } from '../src/handlers/intake';
import { parseQueuedBatch } from '../src/handlers/ingest';
import { parseQueuedRequest } from '../src/handlers/otlp';

const SECRET = 'edge-secret';

function event(o: { method?: string; path: string; headers?: Record<string, string>; query?: Record<string, string>; body?: Buffer | string; binary?: boolean }): APIGatewayProxyEventV2 {
  const body = o.body == null ? undefined : o.binary ? Buffer.from(o.body).toString('base64') : o.body.toString();
  return {
    version: '2.0', routeKey: '$default', rawPath: o.path, rawQueryString: '',
    headers: { 'x-wgo-edge': SECRET, ...o.headers },
    queryStringParameters: o.query,
    requestContext: { http: { method: o.method ?? 'POST', path: o.path } } as never,
    body, isBase64Encoded: !!o.binary,
  } as APIGatewayProxyEventV2;
}

function handlerWith(fail?: number) {
  const sent: QueuedMessage[] = [];
  const handler = createHandler(async (m) => {
    if (fail) throw Object.assign(new Error('sqs'), { name: 'SqsError', $metadata: { httpStatusCode: fail } });
    sent.push(m);
  }, SECRET);
  return { sent, call: async (e: APIGatewayProxyEventV2) => (await handler(e)) as APIGatewayProxyStructuredResultV2 };
}

describe('intake function', () => {
  const batch = { k: 'wk_body', a: 'anon', sentAt: 1, e: [] };

  it('queues SDK batches with the query key, user agent and geolocation, as the consumer reads them', async () => {
    const { sent, call } = handlerWith();
    for (const [body, binary] of [[JSON.stringify(batch), false], [gzipSync(JSON.stringify(batch)), true]] as const) {
      const res = await call(event({
        path: '/ingest', body, binary, query: { k: 'wk_query' },
        headers: { 'content-type': 'text/plain', 'user-agent': 'Amazon CloudFront', 'cloudfront-viewer-country': 'SE', 'cloudfront-viewer-city': 'G%C3%B6teborg', cookie: 'not=forwarded' },
      }));
      expect(res.statusCode).toBe(202);
      expect(res.headers?.['access-control-allow-origin']).toBe('*');
    }
    expect(sent).toHaveLength(2);
    for (const m of sent) {
      expect(m.queue).toBe('ingest');
      expect(m.meta).not.toContain('cookie');
      const req = parseQueuedBatch(m.body, m.meta);
      expect(req.batch()).toEqual(batch);
      expect(req).toMatchObject({ queryKey: 'wk_query', userAgent: 'Amazon CloudFront' });
      expect(parseQueuedBatch(m.body, m.meta).geo).toMatchObject({ country: 'SE', city: 'Göteborg' });
    }
  });

  it('queues OTLP requests with the signal and key headers, and answers in the request encoding', async () => {
    const { sent, call } = handlerWith();
    const proto = await call(event({ path: '/v1/traces', body: Buffer.from([0x0a, 0x00]), binary: true, headers: { 'content-type': 'application/x-protobuf', 'x-wgo-key': 'wk_header' }, query: { key: 'wk_query' } }));
    expect(proto).toMatchObject({ statusCode: 200, body: '', headers: { 'content-type': 'application/x-protobuf' } });
    const json = await call(event({ path: '/v1/logs', body: '{"resourceLogs":[]}', headers: { 'content-type': 'application/json', authorization: 'Bearer wk_bearer' } }));
    expect(json).toMatchObject({ statusCode: 200, body: '{}' });

    const traces = parseQueuedRequest(sent[0].body, sent[0].meta);
    expect(sent[0].queue).toBe('otlp');
    expect(traces).toMatchObject({ signal: 'traces', protobuf: true, writeKey: 'wk_header' });
    expect([...traces.body()]).toEqual([0x0a, 0x00]);
    const logs = parseQueuedRequest(sent[1].body, sent[1].meta);
    expect(logs).toMatchObject({ signal: 'logs', protobuf: false, writeKey: 'wk_bearer' });
    expect(logs.body().toString()).toBe('{"resourceLogs":[]}');
  });

  it('only accepts requests that came through CloudFront', async () => {
    const { sent, call } = handlerWith();
    const res = await call(event({ path: '/ingest', body: '{}', headers: { 'x-wgo-edge': 'forged' } }));
    expect(res.statusCode).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('answers CORS preflights without queueing anything', async () => {
    const { sent, call } = handlerWith();
    const res = await call(event({ method: 'OPTIONS', path: '/ingest' }));
    expect(res).toMatchObject({ statusCode: 204, headers: { 'access-control-allow-methods': 'POST,OPTIONS', 'access-control-allow-headers': 'content-type,content-encoding,x-wgo-key', 'access-control-max-age': '86400' } });
    expect(sent).toHaveLength(0);
  });

  it('rejects empty, oversized and misrouted requests', async () => {
    const { sent, call } = handlerWith();
    expect((await call(event({ path: '/ingest' }))).statusCode).toBe(400);
    expect((await call(event({ path: '/ingest', body: Buffer.alloc(800 * 1024), binary: true }))).statusCode).toBe(400);
    expect((await call(event({ path: '/v1/profiles', body: '{}' }))).statusCode).toBe(404);
    expect((await call(event({ path: '/other', body: '{}' }))).statusCode).toBe(404);
    expect((await call(event({ method: 'GET', path: '/ingest' }))).statusCode).toBe(405);
    expect(sent).toHaveLength(0);
  });

  it('maps SQS failures to 400 (rejected) or 503 (retry)', async () => {
    expect((await handlerWith(400).call(event({ path: '/ingest', body: '{}' }))).statusCode).toBe(400);
    expect((await handlerWith(500).call(event({ path: '/ingest', body: '{}' }))).statusCode).toBe(503);
  });

  it('keeps line breaks in values from adding meta lines', () => {
    const msg = toMessage(event({ path: '/ingest', body: '{}', query: { k: 'wk\nx-wgo-edge=forged' } }));
    expect('meta' in msg && msg.meta.split('\n').filter((l) => l.startsWith('x-wgo-edge=')).length).toBe(1);
  });
});
