import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { gunzipIfNeeded, handleError, header, HttpError, json, metaFields, rawBody } from '../lib/http';
import { assignStableIds, decodeOtlp, evaluateOtlpTriggers, isProtobuf, isSignal, storeOtlpRows, writeKeyFrom, type OtlpRow, type Signal } from '../lib/otlp/ingest';
import { projectIdForWriteKey } from '../lib/projects';
import { collectionPaused } from '../lib/budgets';

/**
 * Deployed, OTLP senders don't wait for this code: the intake function (handlers/intake.ts) writes each request
 * to an SQS queue and answers straight away, and `queueHandler` stores them.
 * `handler` serves the same paths synchronously for the local dev server and the tests.
 */

/** POST /v1/traces | /v1/logs | /v1/metrics — OTLP/HTTP with JSON or protobuf bodies. */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const signal = event.rawPath.split('/').pop();
  const protobuf = isProtobuf(header(event, 'content-type'));
  // OTLP spec: respond in the request's encoding; an empty protobuf message is zero bytes.
  const ok = () =>
    protobuf ? { statusCode: 200, headers: { 'content-type': 'application/x-protobuf' }, body: '' } : json(200, {});
  try {
    if (!isSignal(signal)) throw new HttpError(404, 'Unknown OTLP signal');
    const projectId = await projectIdForWriteKey(writeKeyFrom((n) => header(event, n), event.queryStringParameters?.key));
    if (!projectId) return json(401, { error: 'Missing or unknown write key (send header x-wgo-key)' });
    if (await collectionPaused(projectId)) return json(200, {}); // a cost budget stopped collection
    const rows = decodeOtlp(signal, projectId, rawBody(event), protobuf);
    await storeOtlpRows(signal, rows);
    await evaluateOtlpTriggers(signal, rows);
    return ok();
  } catch (err) {
    return handleError(err);
  }
}

/**
 * An SQS message written by the intake function (handlers/intake.ts, POST /v1/{signal}): the body is the request
 * body, base64-encoded; the `meta` attribute holds `name=value` lines with the signal (from the path), the
 * write key (`key` from the query string) and the request headers that matter, lower-cased.
 */
export function parseQueuedRequest(body: string, meta: string | undefined) {
  const fields = metaFields(meta);
  return {
    signal: fields.get('signal'),
    protobuf: isProtobuf(fields.get('content-type')),
    writeKey: writeKeyFrom((n) => fields.get(n), fields.get('key')),
    body: () => gunzipIfNeeded(Buffer.from(body, 'base64')),
  };
}

/**
 * Stores queued OTLP requests: each signal of a batch becomes one Parquet file per project and day (the event
 * source collects messages for up to WriteBufferSeconds). Requests that can never be stored (unknown write key
 * or signal, undecodable body) are logged and dropped. When a write fails, only the records that went into it
 * are returned for redelivery; redelivered records reuse their row ids, so compaction drops the duplicates.
 */
export async function queueHandler(event: SQSEvent): Promise<SQSBatchResponse> {
  const groups = new Map<Signal, { rows: OtlpRow[]; messageIds: string[] }>();
  let dropped = 0;
  for (const record of event.Records) {
    const req = parseQueuedRequest(record.body, record.messageAttributes?.meta?.stringValue);
    const drop = (reason: string) => {
      dropped++;
      console.warn(JSON.stringify({ msg: 'dropping OTLP request', reason, signal: req.signal, messageId: record.messageId }));
    };
    if (!isSignal(req.signal)) { drop('unknown signal'); continue; }
    const projectId = await projectIdForWriteKey(req.writeKey);
    if (!projectId) { drop('missing or unknown write key'); continue; }
    if (await collectionPaused(projectId)) { drop('collection paused by a cost budget'); continue; }
    let rows: OtlpRow[];
    try {
      rows = decodeOtlp(req.signal, projectId, req.body(), req.protobuf);
    } catch {
      drop(`could not decode ${req.protobuf ? 'protobuf' : 'JSON'} payload`);
      continue;
    }
    assignStableIds(rows, record.messageId);
    const group = groups.get(req.signal) ?? { rows: [], messageIds: [] };
    group.rows.push(...rows);
    group.messageIds.push(record.messageId);
    groups.set(req.signal, group);
  }

  const failed: string[] = [];
  await Promise.all(
    [...groups].map(async ([signal, group]) => {
      try {
        await storeOtlpRows(signal, group.rows);
      } catch (err) {
        console.error(`storing ${signal} failed`, err);
        failed.push(...group.messageIds);
        return;
      }
      await evaluateOtlpTriggers(signal, group.rows);
    }),
  );
  if (dropped || failed.length) console.log(JSON.stringify({ records: event.Records.length, dropped, failed: failed.length }));
  return { batchItemFailures: failed.map((itemIdentifier) => ({ itemIdentifier })) };
}
