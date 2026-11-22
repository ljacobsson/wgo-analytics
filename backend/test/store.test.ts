/**
 * The Parquet store on a local directory (test/setup.ts): typed round trips through DuckDB, deduplication of
 * files not merged yet, merging, whole-day deletion, and the event queue's message chunking.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { duckQuery, filesFor, rawQuery } from '../src/lib/store/duck';
import { location } from '../src/lib/store/files';
import { compactProject, deleteDaysBefore, firstDay, mergeBatches, mergeFiles } from '../src/lib/store/maintain';
import { chunkJson, eventsFromMessages } from '../src/lib/store/queue';
import { projectPrefix } from '../src/lib/store/tables';
import { writeRows } from '../src/lib/store/write';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 16, 12);
const all = { from: new Date(now - 30 * DAY), to: new Date(now + DAY) };

const event = (pid: string, ts: number, o: Record<string, unknown> = {}) => ({
  project_id: pid, ts: new Date(ts), id: randomUUID(), type: 'pageview', session_id: 's1', props: {}, ...o,
});

describe('parquet store', () => {
  it('round-trips every column type', async () => {
    const pid = randomUUID();
    await writeRows('metric_points', [{
      project_id: pid, ts: new Date(now), id: 'm1', name: 'queue.depth', type: 'gauge', unit: '{msg}', description: null,
      service: 'api', value: 12.5, count: 9_007_199_254, attributes: { 'http.route': '/x', nested: { a: [1, 2] } },
    }]);
    const [row] = await rawQuery(pid, all, `SELECT * FROM metric_points WHERE project_id = $1`, [pid]);
    expect(row).toMatchObject({
      ts: new Date(now), id: 'm1', name: 'queue.depth', type: 'gauge', unit: '{msg}', description: null, service: 'api',
      value: 12.5, count: 9_007_199_254, attributes: { 'http.route': '/x', nested: { a: [1, 2] } }, project_id: pid,
    });
  });

  it('reads only the project and days asked for, and answers empty ranges with typed empty tables', async () => {
    const a = randomUUID(), b = randomUUID();
    await writeRows('events', [event(a, now), event(a, now - 3 * DAY), event(b, now)]);
    const count = async (pid: string, w: { from: Date; to: Date }) =>
      (await rawQuery<{ n: number }>(pid, w, `SELECT count(*)::int AS n FROM events WHERE project_id = $1`, [pid]))[0].n;
    expect(await count(a, all)).toBe(2);
    expect(await count(a, { from: new Date(now - DAY), to: new Date(now + DAY) })).toBe(1);
    expect((await filesFor('events', a, { from: new Date(now - DAY), to: new Date(now + DAY) })).length).toBe(1);
    expect(await count(randomUUID(), all)).toBe(0);
    // a table without any files still has its columns (and JSON functions work on them)
    expect(await rawQuery(randomUUID(), all, `SELECT json_extract_string(attributes, '$.x') AS x, count(*) AS n FROM logs GROUP BY 1`)).toEqual([]);
  });

  it('drops duplicate rows of files not merged yet (a retried batch)', async () => {
    const pid = randomUUID();
    const rows = [event(pid, now), event(pid, now + 1000)];
    await writeRows('events', rows);
    await writeRows('events', rows);
    const [{ n }] = await rawQuery<{ n: number }>(pid, all, `SELECT count(*)::int AS n FROM events`);
    expect(n).toBe(2);
  });

  it('merges small files into one sorted, deduplicated file', async () => {
    const pid = randomUUID();
    const rows = Array.from({ length: 50 }, (_, i) => event(pid, now - i * 60_000, { props: { i, nested: { ok: true } } }));
    for (let i = 0; i < 50; i += 10) await writeRows('events', rows.slice(i, i + 10));
    await writeRows('events', rows.slice(0, 5)); // duplicates
    const before = await location().list(projectPrefix('events', pid));
    expect(before).toHaveLength(6);

    const res = await compactProject(pid, Date.now() + 60_000, now);
    expect(res).toEqual({ done: true, merged: 6, failed: 0 });
    const after = await location().list(projectPrefix('events', pid));
    expect(after).toHaveLength(1);
    expect(after[0].key).toMatch(/\/dt=2026-11-16\/c\d+-[0-9a-f]+\.parquet$/);
    const read = await rawQuery<{ ts: Date; props: { i: number; nested: { ok: boolean } } }>(pid, all, `SELECT ts, props FROM events ORDER BY ts DESC`);
    expect(read).toHaveLength(50);
    expect(read[0]).toEqual({ ts: new Date(now), props: { i: 0, nested: { ok: true } } });

    // a merged file merges again with newer small files
    await writeRows('events', [event(pid, now + 1000)]);
    const files = await location().list(projectPrefix('events', pid));
    await mergeFiles('events', pid, '2026-11-16', files);
    expect(await location().list(projectPrefix('events', pid))).toHaveLength(1);
    expect((await rawQuery<{ n: number }>(pid, all, `SELECT count(*)::int AS n FROM events`))[0].n).toBe(51);
  });

  it('splits a backlog into merges that each fit the function', () => {
    const MB = 1024 * 1024;
    const files = Array.from({ length: 10 }, (_, i) => ({ key: `f${i}`, size: 15 * MB }));
    expect(mergeBatches(files).map((b) => b.length)).toEqual([4, 4, 2]);
    expect(mergeBatches(Array.from({ length: 4500 }, (_, i) => ({ key: `f${i}`, size: 10 }))).map((b) => b.length)).toEqual([2000, 2000, 500]);
    expect(mergeBatches([])).toEqual([]);
  });

  it('keeps merging other tables when one merge fails', async () => {
    const pid = randomUUID();
    // events merge first and fail on an unreadable file; the logs after them still merge
    await writeRows('events', [event(pid, now)]);
    await location().put(`${projectPrefix('events', pid)}dt=2026-11-16/1-broken.parquet`, new TextEncoder().encode('not parquet'));
    for (let i = 0; i < 3; i++) {
      await writeRows('logs', [{ project_id: pid, ts: new Date(now), id: randomUUID(), severity_number: 9, body: `x${i}`, service: 'api' }]);
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await compactProject(pid, Date.now() + 60_000, now);
    errors.mockRestore();
    expect(res).toEqual({ done: true, merged: 3, failed: 1 });
    expect(await location().list(projectPrefix('events', pid))).toHaveLength(2);
    expect(await location().list(projectPrefix('logs', pid))).toHaveLength(1);
  });

  it('deletes whole days and finds the first stored day', async () => {
    const pid = randomUUID();
    await writeRows('logs', [-5, -3, -1, 0].map((d) => ({
      project_id: pid, ts: new Date(now + d * DAY), id: randomUUID(), severity_number: 9, severity_text: 'INFO', body: `day ${d}`,
      service: 'api', trace_id: null, span_id: null, attributes: {}, resource: {},
    })));
    expect(await firstDay('logs', pid)).toBe('2026-11-11');
    expect(await deleteDaysBefore('logs', pid, '2026-11-15')).toBe(2);
    expect(await firstDay('logs', pid)).toBe('2026-11-15');
    expect((await rawQuery<{ body: string }>(pid, all, `SELECT body FROM logs ORDER BY ts`)).map((r) => r.body)).toEqual(['day -1', 'day 0']);
    expect(await firstDay('spans', pid)).toBeNull();
  });

  it('reuses cached S3 files without revalidating them (keys are never rewritten)', async () => {
    const [s] = await duckQuery<Record<string, unknown>>(
      `SELECT current_setting('validate_external_file_cache') AS validate, current_setting('enable_http_metadata_cache') AS http,
              current_setting('parquet_metadata_cache') AS footers, current_setting('enable_external_file_cache') AS files`,
    );
    expect(s).toEqual({ validate: 'NO_VALIDATION', http: true, footers: true, files: true });
  });

  it('chunks queued events below the message size and revives their dates', () => {
    const rows = Array.from({ length: 30 }, (_, i) => event('p', now + i, { title: 'x'.repeat(100) }));
    const chunks = chunkJson(rows, 1500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1500);
    const back = eventsFromMessages(chunks);
    expect(back).toHaveLength(30);
    expect(back[29].ts).toEqual(new Date(now + 29));
    // a row bigger than the limit still goes, alone
    expect(chunkJson([{ big: 'y'.repeat(3000) }, { small: 1 }], 1500)).toHaveLength(2);
  });
});
