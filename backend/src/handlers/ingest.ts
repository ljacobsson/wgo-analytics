import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { fillMissingIds, normalizeBatch, toApiEvent, type WireBatch } from '../lib/events';
import { gunzipIfNeeded, handleError, header, json, jsonBody, metaFields } from '../lib/http';
import { storeErrorStacks } from '../lib/errorStacks';
import { recordReleases, seenInEvents } from '../lib/releases';
import { dropSuppressed } from '../lib/suppressions';
import { collectionPaused } from '../lib/budgets';
import { geoFromHeaders, type Geo } from '../lib/geo';
import { fanOut } from '../lib/live';
import { projectIdForWriteKey } from '../lib/projects';
import { replayRows } from '../lib/recordings';
import { storeEvents, storeReplays } from '../lib/store/queue';
import { evaluateTriggers } from '../lib/triggers';

/**
 * Deployed, SDK batches don't wait for this code: the intake function (handlers/intake.ts) writes each one to an
 * SQS queue and answers 202 straight away, and `queueHandler` processes them.
 * `handler` serves POST /ingest synchronously for the local dev server and the tests.
 */

/** Normalizes one SDK batch, pushes it live, queues it for the Parquet writer and evaluates triggers. */
async function ingestBatch(projectId: string, batch: WireBatch, receivedAt: number, userAgent: string | undefined, geo: Geo): Promise<number> {
  // a cost budget stopped collection for this project (lib/budgets.ts): drop everything, recordings included
  if (await collectionPaused(projectId)) return 0;
  // session recording chunks (their own table; only for sessions holding a recording slot, see lib/recordings.ts)
  const replays = await replayRows(projectId, batch, receivedAt);
  await storeReplays(replays);
  // errors matching the project's suppression rules are dropped here: never stored, counted, sent live or alerted on
  const rows = await dropSuppressed(projectId, normalizeBatch(projectId, batch, receivedAt, userAgent, geo));
  if (!rows.length) return replays.length;

  // Live fan-out runs alongside the write: the dashboard should see a click as soon as we do.
  // A fan-out failure must never fail the batch (a retry would duplicate stored events).
  // bots are stored (flagged) but never light up live watches or fire triggers
  const apiEvents = rows.filter((r) => !r.bot).map(toApiEvent);
  const live = fanOut(projectId, apiEvents).catch((err) => console.warn('fan-out failed', err));
  // stacks are stored once per error group (before the events, so a visible error always has one)
  await storeErrorStacks(rows);
  await recordReleases(seenInEvents(rows)); // never throws
  // queued for the Parquet writer (written directly when there is no queue: dev server, tests)
  await storeEvents(rows.map((r) => ({ ...r, error_stack: null })));
  // triggers only after the events are safely queued, so a retried batch can't notify twice for events we dropped
  await Promise.all([live, evaluateTriggers(projectId, apiEvents).catch((err) => console.warn('trigger evaluation failed', err))]);
  return rows.length + replays.length;
}

/** POST /ingest — SDK batches. Write key travels in the body (sendBeacon can't set headers). */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const batch = jsonBody<WireBatch>(event);
    const projectId = await projectIdForWriteKey(batch.k ?? event.queryStringParameters?.k);
    if (!projectId) return json(401, { error: 'Unknown write key' });
    const accepted = await ingestBatch(projectId, batch, Date.now(), header(event, 'user-agent'), geoFromHeaders(event.headers));
    return json(202, { accepted });
  } catch (err) {
    return handleError(err);
  }
}

/**
 * An SQS message written by the intake function (handlers/intake.ts, POST /ingest): the body is the request
 * body, base64-encoded; the `meta` attribute holds `name=value` lines with the write key from the query string (`k`)
 * and the request headers that matter (user agent, CloudFront geolocation, edge secret), lower-cased.
 */
export function parseQueuedBatch(body: string, meta: string | undefined) {
  const fields = metaFields(meta);
  return {
    queryKey: fields.get('k'),
    userAgent: fields.get('user-agent'),
    geo: geoFromHeaders(Object.fromEntries(fields)),
    batch: (): WireBatch => {
      const buf = gunzipIfNeeded(Buffer.from(body, 'base64'));
      return (buf.length ? JSON.parse(buf.toString('utf8')) : {}) as WireBatch;
    },
  };
}

async function processRecord(record: SQSRecord): Promise<void> {
  const req = parseQueuedBatch(record.body, record.messageAttributes?.meta?.stringValue);
  const drop = (reason: string) => console.warn(JSON.stringify({ msg: 'dropping SDK batch', reason, messageId: record.messageId }));
  let batch: WireBatch;
  try {
    batch = req.batch();
  } catch {
    return drop('invalid JSON body');
  }
  const projectId = await projectIdForWriteKey(batch?.k ?? req.queryKey);
  if (!projectId) return drop('missing or unknown write key');
  fillMissingIds(batch, record.messageId);
  // when the intake queued it, not when we got to it: clock-skew correction and the age limits depend on it
  const receivedAt = Number(record.attributes?.SentTimestamp) || Date.now();
  await ingestBatch(projectId, batch, receivedAt, req.userAgent, req.geo);
}

/**
 * Processes queued SDK batches. Batches that can never be stored (unknown write key, invalid JSON) are logged and
 * dropped. Failed ones are returned for redelivery; events keep their ids, so compaction drops any duplicates.
 */
export async function queueHandler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failed: string[] = [];
  await Promise.all(
    event.Records.map((record) =>
      processRecord(record).catch((err) => {
        console.error('ingesting batch failed', record.messageId, err);
        failed.push(record.messageId);
      }),
    ),
  );
  return { batchItemFailures: failed.map((itemIdentifier) => ({ itemIdentifier })) };
}
