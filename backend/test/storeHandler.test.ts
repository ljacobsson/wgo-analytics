import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

/**
 * The events writer must store a batch even when DSQL is unreachable: identities are a side job. (No DATABASE_URL
 * and no DSQL_ENDPOINT here, so every query throws, like the access-denied errors of a missing IAM permission.)
 */
describe('events writer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes events and recording chunks when recording identities fails', async () => {
    const saved = { url: process.env.DATABASE_URL, dsql: process.env.DSQL_ENDPOINT };
    delete process.env.DATABASE_URL;
    delete process.env.DSQL_ENDPOINT;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { eventsHandler } = await import('../src/handlers/store');
      const pid = crypto.randomUUID();
      const ts = new Date().toISOString();
      const event = { project_id: pid, ts, id: crypto.randomUUID(), type: 'pageview', session_id: 's', anon_id: 'a', user_id: 'alice@x.com', props: {} };
      const chunk = { project_id: pid, ts, id: crypto.randomUUID(), session_id: 's', anon_id: 'a', page_id: 'p', seq: 0, dur: 0, url: null, data: '[[1,0,1,1]]' };
      const sqs = { Records: [{ body: JSON.stringify([event]) }, { body: JSON.stringify({ replays: [chunk] }) }] } as unknown as SQSEvent;
      await expect(eventsHandler(sqs)).resolves.toEqual({ written: 2 });
      const files = (table: string) => readdirSync(join(process.env.STORE_URL!, table, `project_id=${pid}`), { recursive: true }).filter((f) => String(f).endsWith('.parquet'));
      expect(files('events')).toHaveLength(1);
      expect(files('replays')).toHaveLength(1);
      expect(logged.mock.calls[0][0]).toMatch(/recording identities failed/);
    } finally {
      if (saved.url) process.env.DATABASE_URL = saved.url;
      if (saved.dsql) process.env.DSQL_ENDPOINT = saved.dsql;
    }
  });
});
