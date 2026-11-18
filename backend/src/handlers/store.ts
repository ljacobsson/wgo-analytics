import type { SQSEvent } from 'aws-lambda';
import { recordIdentities } from '../lib/identities';
import { rowsFromMessages } from '../lib/store/queue';
import { writeRows } from '../lib/store/write';

/**
 * Writes queued browser events and recording chunks (lib/store/queue.ts) as Parquet: the whole batch becomes one
 * file per table, project and day. A failed write fails the batch, which SQS redelivers; rows keep their ids, so
 * compaction drops any duplicates from files that did get written.
 *
 * Recording identities (DSQL) comes after, and its failure doesn't fail the batch: a batch holds the events of
 * every project, and redelivering it all for an identity would delay them, and after five tries drop them. A
 * missed pair is recorded with the user's next event (they keep carrying the user id).
 */
export async function eventsHandler(event: SQSEvent): Promise<{ written: number }> {
  const { events, replays } = rowsFromMessages(event.Records.map((r) => r.body));
  await Promise.all([writeRows('events', events), writeRows('replays', replays)]);
  try {
    await recordIdentities(events);
  } catch (err) {
    console.error(JSON.stringify({ msg: 'recording identities failed; events were written', error: String((err as Error)?.message ?? err) }));
  }
  return { written: events.length + replays.length };
}
