import type { SQSEvent } from 'aws-lambda';
import { recordIdentities } from '../lib/identities';
import { rowsFromMessages } from '../lib/store/queue';
import { writeRows } from '../lib/store/write';

/**
 * Writes queued browser events (lib/store/queue.ts) as Parquet: the whole batch becomes one file per project
 * and day. A failed write fails the batch, which SQS redelivers; rows keep their ids, so compaction drops any
 * duplicates from files that did get written.
 */
export async function eventsHandler(event: SQSEvent): Promise<{ written: number }> {
  const { events, replays } = rowsFromMessages(event.Records.map((r) => r.body));
  await Promise.all([writeRows('events', events), recordIdentities(events), writeRows('replays', replays)]);
  return { written: events.length + replays.length };
}
