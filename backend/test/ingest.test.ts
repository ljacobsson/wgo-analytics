import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseQueuedBatch } from '../src/handlers/ingest';
import { fillMissingIds, type WireBatch } from '../src/lib/events';

describe('parseQueuedBatch (SDK batch queued by the intake function)', () => {
  const batch = { k: 'wk_body', a: 'anon', sentAt: 1, e: [] };

  it('reads plain and gzipped bodies, the query key, user agent and geolocation', () => {
    const meta = 'source=sdk\nuser-agent=Amazon CloudFront\ncloudfront-viewer-country=SE\ncloudfront-viewer-city=G%C3%B6teborg\nk=wk_query\nk=ignored';
    for (const body of [Buffer.from(JSON.stringify(batch)), gzipSync(JSON.stringify(batch))]) {
      const req = parseQueuedBatch(body.toString('base64'), meta);
      expect(req.batch()).toEqual(batch);
      expect(req).toMatchObject({ queryKey: 'wk_query', userAgent: 'Amazon CloudFront' });
      expect(req.geo).toMatchObject({ country: 'SE', city: 'Göteborg' });
    }
  });

  it('handles empty bodies and missing meta', () => {
    const req = parseQueuedBatch('', undefined);
    expect(req.batch()).toEqual({});
    expect(req.queryKey).toBeUndefined();
    expect(req.geo.country).toBeNull();
  });

  it('throws on invalid JSON (the consumer drops the message)', () => {
    expect(() => parseQueuedBatch(Buffer.from('{nope').toString('base64'), 'source=sdk').batch()).toThrow();
  });
});

describe('fillMissingIds', () => {
  it('derives stable ids for events without a valid one and keeps the rest', () => {
    const kept = '0b0e8a4e-6f1c-4d2a-9b3e-1c2d3e4f5a6b';
    const make = (): WireBatch => ({ k: 'k', a: 'a', sentAt: 1, e: [{ id: kept }, { id: 'nope' }, {}] as never });
    const a = make();
    const b = make();
    fillMissingIds(a, 'msg-1');
    fillMissingIds(b, 'msg-1');
    expect(a.e[0].id).toBe(kept);
    expect(a.e[1].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.e.map((e) => e.id)).toEqual(b.e.map((e) => e.id));
    expect(a.e[1].id).not.toBe(a.e[2].id);
  });
});
