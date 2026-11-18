import type { SQSClient } from '@aws-sdk/client-sqs';
import type { EventRow } from '../events';
import type { ReplayRow } from '../recordings';
import { recordIdentities } from '../identities';
import { writeRows } from './write';

/**
 * Browser events reach storage through a queue: the ingest function answers the SDK straight away, and the
 * writer (handlers/store.ts) turns everything that arrived within WriteBufferSeconds into one Parquet file per
 * project and day. Without EVENTS_QUEUE_URL (dev server, tests) events are written directly.
 */
const MAX_MESSAGE_BYTES = 200 * 1024; // SQS allows 256 KiB per message

let sqs: SQSClient | null = null;

/** Split rows into JSON arrays of at most `max` bytes each (a single bigger row gets a message of its own). */
export function chunkJson(rows: unknown[], max = MAX_MESSAGE_BYTES): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = 2;
  for (const r of rows) {
    const s = JSON.stringify(r);
    if (cur.length && size + s.length + 1 > max) {
      out.push(`[${cur.join(',')}]`);
      cur = [];
      size = 2;
    }
    cur.push(s);
    size += s.length + 1;
  }
  if (cur.length) out.push(`[${cur.join(',')}]`);
  return out;
}

async function send(bodies: string[]): Promise<void> {
  const url = process.env.EVENTS_QUEUE_URL!;
  const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
  sqs ??= new SQSClient({});
  await Promise.all(bodies.map((body) => sqs!.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body }))));
}

export async function storeEvents(rows: EventRow[]): Promise<void> {
  if (!rows.length) return;
  if (!process.env.EVENTS_QUEUE_URL) {
    await Promise.all([writeRows('events', rows), recordIdentities(rows)]);
    return;
  }
  await send(chunkJson(rows));
}

/** Session recording chunks take the same queue, as `{"replays": [...]}` messages (events are plain arrays). */
export async function storeReplays(rows: ReplayRow[]): Promise<void> {
  if (!rows.length) return;
  if (!process.env.EVENTS_QUEUE_URL) {
    await writeRows('replays', rows);
    return;
  }
  await send(chunkJson(rows).map((b) => `{"replays":${b}}`));
}

/** Rows from queued message bodies (dates arrive as ISO strings). */
export function rowsFromMessages(bodies: string[]): { events: EventRow[]; replays: ReplayRow[] } {
  const events: EventRow[] = [];
  const replays: ReplayRow[] = [];
  for (const b of bodies) {
    const v = JSON.parse(b) as EventRow[] | { replays: ReplayRow[] };
    if (Array.isArray(v)) for (const r of v) events.push({ ...r, ts: new Date(r.ts) });
    else for (const r of v.replays ?? []) replays.push({ ...r, ts: new Date(r.ts) });
  }
  return { events, replays };
}

export const eventsFromMessages = (bodies: string[]): EventRow[] => rowsFromMessages(bodies).events;
