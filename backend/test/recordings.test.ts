import { describe, expect, it } from 'vitest';
import type { RecordingSummary } from '../src/contract';
import { MAX_CHUNK_CHARS, matchesFilters, normalizeReplays, parseFilters, validateSettings } from '../src/lib/recordings';
import { chunkJson, eventsFromMessages, rowsFromMessages } from '../src/lib/store/queue';

const ok = { enabled: true, samplePercent: 5, triggers: [], maxPerHour: 10, maxPerDay: null, maskAllText: false };
const id = () => crypto.randomUUID();

describe('recording settings', () => {
  it('accepts valid settings and normalizes them', () => {
    expect(validateSettings({ ...ok, samplePercent: 12.3456, triggers: [{ type: 'page', value: ' /checkout* ' }, { type: 'error', value: '' }] }))
      .toEqual({ ...ok, samplePercent: 12.35, triggers: [{ type: 'page', value: '/checkout*' }, { type: 'error', value: '' }] });
  });

  it.each([
    [{ ...ok, enabled: 'yes' }, /enabled/],
    [{ ...ok, samplePercent: 101 }, /0 to 100/],
    [{ ...ok, samplePercent: -1 }, /0 to 100/],
    [{ ...ok, maxPerHour: 0 }, /per hour/],
    [{ ...ok, maxPerDay: 2.5 }, /per day/],
    [{ ...ok, triggers: [{ type: 'hover', value: 'x' }] }, /Unknown trigger/],
    [{ ...ok, triggers: [{ type: 'click', value: ' ' }] }, /needs a value/],
    [{ ...ok, triggers: Array.from({ length: 21 }, () => ({ type: 'error', value: '' })) }, /At most 20/],
  ])('rejects %j', (body, msg) => {
    expect(() => validateSettings(body as never)).toThrow(msg);
  });
});

describe('replay chunks from an SDK batch', () => {
  const now = Date.now();
  const chunk = (extra: object = {}) => ({ id: id(), t: 'replay', ts: now - 1000, s: 'sess-1', url: 'https://shop.test/a', path: '/a', d: { p: 'page-1', q: 3, dur: 900, r: [[1, 0, 5, 6]] }, ...extra });

  it('keeps replay events only, with their data as JSON text', () => {
    const c = chunk();
    const rows = normalizeReplays('pid', { k: 'k', a: 'anon', sentAt: now, e: [c, { id: id(), t: 'click', ts: now, s: 'sess-1', url: '', path: '/' }] } as never, now);
    expect(rows).toEqual([{
      project_id: 'pid', ts: new Date(now - 1000), id: c.id, session_id: 'sess-1', anon_id: 'anon', page_id: 'page-1', seq: 3, dur: 900,
      url: 'https://shop.test/a', data: '[[1,0,5,6]]',
    }]);
  });

  it('drops malformed and oversized chunks', () => {
    const e = [
      chunk({ id: 'not-a-uuid' }),
      chunk({ s: '' }),
      chunk({ d: { r: [] } }),
      chunk({ d: { r: 'nope' } }),
      chunk({ d: { r: [[0, 0, { z: 'x'.repeat(MAX_CHUNK_CHARS) }]] } }),
    ];
    expect(normalizeReplays('pid', { k: 'k', a: 'a', sentAt: now, e } as never, now)).toEqual([]);
  });

  it('corrects a client clock that is far off, like events', () => {
    const c = chunk({ ts: now - 3600_000 - 1000 });
    const [row] = normalizeReplays('pid', { k: 'k', a: 'a', sentAt: now - 3600_000, e: [c] } as never, now);
    expect(row.ts.getTime()).toBe(now - 1000);
  });
});

describe('the events queue', () => {
  it('carries replay chunks next to events, and reads older plain-array messages', () => {
    const ev = { project_id: 'p', ts: new Date(1000).toISOString(), id: 'e1' };
    const rp = { project_id: 'p', ts: new Date(2000).toISOString(), id: 'r1', data: '[[1,0,1,1]]' };
    const bodies = [...chunkJson([ev]), ...chunkJson([rp]).map((b) => `{"replays":${b}}`)];
    const { events, replays } = rowsFromMessages(bodies);
    expect(events).toEqual([{ ...ev, ts: new Date(1000) }]);
    expect(replays).toEqual([{ ...rp, ts: new Date(2000) }]);
    expect(eventsFromMessages(bodies)).toEqual(events);
  });
});

describe('recording filters', () => {
  const rec = (over: Partial<RecordingSummary> = {}): RecordingSummary => ({
    sessionId: 's', startedAt: '2026-11-18T10:00:00Z', endedAt: '2026-11-18T10:01:00Z', durationMs: 60_000, reason: 'sample',
    anonId: 'anon-1', userId: null, entryPath: '/', pages: 2, clicks: 4, rageClicks: 0, errors: 0, paths: ['/', '/checkout/pay'],
    browser: 'Chrome', os: 'macOS', device: 'desktop', country: 'SE', city: 'Stockholm', ...over,
  });
  const ok = (q: Record<string, string>, over: Partial<RecordingSummary> = {}) => matchesFilters(rec(over), parseFilters(q));

  it('never lists recordings under 3 seconds, or without data', () => {
    expect(ok({}, { durationMs: 2999 })).toBe(false);
    expect(ok({}, { durationMs: 3000 })).toBe(true);
    expect(ok({}, { endedAt: null, durationMs: 0 })).toBe(false);
  });

  it('filters by length in seconds', () => {
    expect(ok({ minDuration: '30' })).toBe(true);
    expect(ok({ minDuration: '61' })).toBe(false);
    expect(ok({ maxDuration: '59' })).toBe(false);
    expect(ok({ minDuration: 'abc' })).toBe(true); // ignored
  });

  it('matches pages by substring or * pattern, against every page viewed', () => {
    expect(ok({ page: 'checkout' })).toBe(true);
    expect(ok({ page: '/CHECKOUT*' })).toBe(true);
    expect(ok({ page: '/pay*' })).toBe(false);
    expect(ok({ page: '*pay' })).toBe(true);
    expect(ok({ page: 'pricing' })).toBe(false);
  });

  it('filters by errors, rage clicks, known user, device and reason', () => {
    expect(ok({ errors: '1' })).toBe(false);
    expect(ok({ errors: '1' }, { errors: 2 })).toBe(true);
    expect(ok({ rage: '1' }, { rageClicks: 3 })).toBe(true);
    expect(ok({ identified: '1' })).toBe(false);
    expect(ok({ identified: '1' }, { userId: 'alice@x.com' })).toBe(true);
    expect(ok({ device: 'Mobile' })).toBe(false);
    expect(ok({ device: 'desktop' })).toBe(true);
    expect(ok({ reason: 'trigger' })).toBe(false);
    expect(ok({ reason: 'trigger' }, { reason: 'trigger:error' })).toBe(true);
    expect(ok({ reason: 'sample' }, { reason: 'trigger:page:/x' })).toBe(false);
  });

  it('searches user, pages, location and browser', () => {
    expect(ok({ q: 'stockholm' })).toBe(true);
    expect(ok({ q: 'pay' })).toBe(true);
    expect(ok({ q: 'alice' }, { userId: 'Alice@x.com' })).toBe(true);
    expect(ok({ q: 'firefox' })).toBe(false);
  });
});
