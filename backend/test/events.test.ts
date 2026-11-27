import { describe, expect, it } from 'vitest';
import type { Watch } from '../src/contract';
import { buildInsert } from '../src/lib/db';
import { errorFingerprint, EVENT_COLUMNS, eventRowValues, normalizeBatch, normalizeRoute, toApiEvent, type WireBatch } from '../src/lib/events';
import { chunkBySize, selectForConnection } from '../src/lib/live';
import { matchesWatch, sanitizeWatches } from '../src/lib/match';
import { parseUserAgent } from '../src/lib/ua';
import { bucketStarts, parseRange, pickBucket } from '../src/lib/analytics';

const PID = '00000000-0000-4000-8000-000000000001';
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const batch = (e: WireBatch['e'], extra: Partial<WireBatch> = {}): WireBatch => ({
  k: 'wk_test', a: 'anon-1', sentAt: NOW, ctx: { sdk: 'wgo-js/0.1.0', ua: UA, lang: 'en' }, e, ...extra,
});
const base = { s: 'sess-1', url: 'https://shop.test/cart?x=1', path: '/cart', ts: NOW - 1000 };

describe('normalizeBatch', () => {
  it('maps each event type onto columns', () => {
    const rows = normalizeBatch(PID, batch([
      { ...base, id: '3f2c1a9e-8b7d-4c6e-9f10-112233445566', t: 'click', d: { sel: 'button.buy', tag: 'button', text: 'Buy now', name: 'buy-cta', x: 1, y: 2, vw: 3, vh: 4, rage: 4 } },
      { ...base, id: 'x', t: 'error', d: { msg: 'TypeError: x is undefined', stack: 'TypeError\n    at foo (https://shop.test/app.js:10:20)', kind: 'error', count: 3 } },
      { ...base, id: 'y', t: 'http_error', d: { method: 'post', url: 'https://api.shop.test/orders/12345/items', status: 503, dur: 812.4, kind: 'fetch' } },
      { ...base, id: 'z', t: 'custom', d: { name: 'checkout_started', props: { total: 10 } } },
      { ...base, id: 'p', t: 'pageview', ref: 'https://google.com/' },
    ]), NOW);

    expect(rows).toHaveLength(5);
    const [click, err, http, custom, pv] = rows;
    expect(click).toMatchObject({ project_id: PID, type: 'click', selector: 'button.buy', element_text: 'Buy now', track_name: 'buy-cta', element_tag: 'button', session_id: 'sess-1', anon_id: 'anon-1', browser: 'Chrome', os: 'macOS', device: 'desktop' });
    expect(click.id).toBe('3f2c1a9e-8b7d-4c6e-9f10-112233445566');
    expect(click.props).toMatchObject({ rage: 4, $ctx: { lang: 'en' } });
    expect(err.id).toMatch(/^[0-9a-f-]{36}$/); // invalid ids are replaced
    expect(err).toMatchObject({ error_message: 'TypeError: x is undefined', fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(http).toMatchObject({ http_method: 'POST', http_status: 503, duration_ms: 812, http_route: 'api.shop.test/orders/:id/items' });
    expect(custom.name).toBe('checkout_started');
    expect(pv.referrer).toBe('https://google.com/');
    expect(click.referrer).toBeNull();
  });

  it('corrects large client clock skew in stable steps, so retries keep the same ts', () => {
    const ev = [{ ...base, id: 'a', t: 'pageview' as const, ts: NOW - 3600_000 - 500 }];
    const [first] = normalizeBatch(PID, batch(ev, { sentAt: NOW - 3600_000 }), NOW);
    const [retry] = normalizeBatch(PID, batch(ev, { sentAt: NOW - 3600_000 + 4000 }), NOW + 4000 + 700);
    expect(first.ts.getTime()).toBe(NOW - 500);
    expect(retry.ts.getTime()).toBe(first.ts.getTime());
    const [small] = normalizeBatch(PID, batch([{ ...base, id: 'b', t: 'pageview', ts: NOW - 500 }], { sentAt: NOW - 5000 }), NOW);
    expect(small.ts.getTime()).toBe(NOW - 500); // small skew is left alone
  });

  it('clamps absurd timestamps and drops unknown types', () => {
    const rows = normalizeBatch(PID, batch([
      { ...base, id: 'a', t: 'pageview', ts: NOW + 86400_000 },
      { ...base, id: 'b', t: 'bogus' as never },
    ]), NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].ts.getTime()).toBe(NOW);
  });

  it('ignores garbage input', () => {
    expect(normalizeBatch(PID, {} as WireBatch, NOW)).toEqual([]);
    expect(normalizeBatch(PID, batch([null as never]), NOW)).toEqual([]);
  });

  it('round-trips through the API representation', () => {
    const [row] = normalizeBatch(PID, batch([{ ...base, id: 'a', t: 'click', d: { sel: 'a', tag: 'a', text: 'Home' } }]), NOW);
    const api = toApiEvent(row);
    expect(api).toMatchObject({ type: 'click', selector: 'a', elementText: 'Home', sessionId: 'sess-1', ts: new Date(NOW - 1000).toISOString() });
    expect(eventRowValues(row)).toHaveLength(EVENT_COLUMNS.length);
  });
});

describe('errorFingerprint', () => {
  it('groups errors that differ only in volatile values and line numbers', () => {
    const a = errorFingerprint('Cannot read "foo" of item 12', 'Error\n    at render (https://x.test/app.abc.js:1:2345)', null, 'error');
    const b = errorFingerprint('Cannot read "bar" of item 99', 'Error\n    at render (https://x.test/app.abc.js:1:9999)', null, 'error');
    const c = errorFingerprint('Something else entirely', null, null, 'error');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('groups Dart stacks from the Flutter SDK by their first frame', () => {
    const at = (fn: string, line: number) => `#0      ${fn} (package:shop/cart.dart:${line}:7)\n#1      _InkResponseState.handleTap (package:flutter/src/material/ink_well.dart:1170:21)`;
    const a = errorFingerprint('Bad state: cart empty', at('CartPage.checkout', 42), null, 'error');
    expect(errorFingerprint('Bad state: cart empty', at('CartPage.checkout', 57), null, 'error')).toBe(a);
    expect(errorFingerprint('Bad state: cart empty', at('CartPage.clear', 42), null, 'error')).not.toBe(a);
  });
});

describe('normalizeRoute', () => {
  it.each([
    ['/api/users/123', '/api/users/:id'],
    ['https://api.test/v1/orders/9f8e7d6c-5b4a-4c3d-8e2f-112233445566?x=1', 'api.test/v1/orders/:id'],
    ['/api/items/abcdef0123456789', '/api/items/:id'],
    ['/api/health', '/api/health'],
  ])('%s -> %s', (input, expected) => expect(normalizeRoute(input)).toBe(expected));
});

describe('parseUserAgent', () => {
  it('classifies common agents', () => {
    expect(parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'))
      .toEqual({ browser: 'Safari', os: 'iOS', device: 'mobile' });
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0')).toEqual({ browser: 'Firefox', os: 'Windows', device: 'desktop' });
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131 Safari/537.36 Edg/131')).toMatchObject({ browser: 'Edge' });
  });

  it('reads the Flutter SDK\'s user agents', () => {
    expect(parseUserAgent('wgo-flutter/0.1.0 (Linux; Android; Mobile)')).toEqual({ browser: 'Flutter app', os: 'Android', device: 'mobile' });
    expect(parseUserAgent('wgo-flutter/0.1.0 (Linux; Android)')).toEqual({ browser: 'Flutter app', os: 'Android', device: 'tablet' });
    expect(parseUserAgent('wgo-flutter/0.1.0 (iPhone; iOS)')).toEqual({ browser: 'Flutter app', os: 'iOS', device: 'mobile' });
    expect(parseUserAgent('wgo-flutter/0.1.0 (iPad; iOS)')).toEqual({ browser: 'Flutter app', os: 'iOS', device: 'tablet' });
    expect(parseUserAgent('wgo-flutter/0.1.0 (Macintosh; Mac OS X)')).toEqual({ browser: 'Flutter app', os: 'macOS', device: 'desktop' });
    expect(parseUserAgent('wgo-flutter/0.1.0 (Windows)')).toEqual({ browser: 'Flutter app', os: 'Windows', device: 'desktop' });
    expect(parseUserAgent('wgo-flutter/0.1.0 (X11; Linux)')).toEqual({ browser: 'Flutter app', os: 'Linux', device: 'desktop' });
  });
});

describe('watch matching', () => {
  const [row] = normalizeBatch(PID, batch([{ ...base, id: 'a', t: 'click', d: { sel: 'main > button.signup', tag: 'button', text: 'Sign up free', name: 'signup-cta' } }]), NOW);
  const event = toApiEvent(row);

  it('matches case-insensitive substrings with omitted fields as wildcards', () => {
    expect(matchesWatch({ id: '1', label: '', type: 'click', name: 'SIGNUP' }, event)).toBe(true);
    expect(matchesWatch({ id: '1', label: '', type: 'click', selector: 'button.signup', text: 'sign up' }, event)).toBe(true);
    expect(matchesWatch({ id: '1', label: '', type: 'click', path: '/checkout' }, event)).toBe(false);
    expect(matchesWatch({ id: '1', label: '', type: 'error' }, event)).toBe(false);
  });

  it('selects matching events per connection, or everything with firehose', () => {
    const watches: Watch[] = [{ id: 'w1', label: 'signup', type: 'click', name: 'signup' }, { id: 'w2', label: 'other', type: 'click', text: 'nope' }];
    expect(selectForConnection({ watches, firehose: false }, [event])).toEqual([{ ...event, matches: ['w1'] }]);
    expect(selectForConnection({ watches: [watches[1]], firehose: false }, [event])).toEqual([]);
    expect(selectForConnection({ watches: [], firehose: true }, [event])).toEqual([{ ...event, matches: [] }]);
  });

  it('sanitizes client-provided watches', () => {
    expect(sanitizeWatches([{ id: 'a', type: 'click', selector: '  .btn ' }, { nope: 1 }, 'x'])).toEqual([
      { id: 'a', label: 'a', type: 'click', selector: '.btn', text: undefined, name: undefined, path: undefined },
    ]);
    expect(sanitizeWatches('bad')).toEqual([]);
  });
});

describe('helpers', () => {
  it('chunks frames by size', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ i, pad: 'x'.repeat(40) }));
    const chunks = chunkBySize(items, 120);
    expect(chunks.flat()).toEqual(items);
    expect(chunks.every((c) => Buffer.byteLength(JSON.stringify(c)) < 200)).toBe(true);
  });

  it('builds multi-row inserts with casts', () => {
    const { sql, params } = buildInsert('t', ['a', 'b'], [[1, '{}'], [2, '[]']], { b: '::jsonb' });
    expect(sql).toBe('INSERT INTO t (a,b) VALUES ($1,$2::jsonb),($3,$4::jsonb) ON CONFLICT DO NOTHING');
    expect(params).toEqual([1, '{}', 2, '[]']);
  });

  it('picks sensible buckets and validates ranges', () => {
    const r = parseRange({ from: '2026-11-16T00:00:00Z', to: '2026-11-17T00:00:00Z' });
    expect(pickBucket(r)).toBe(900);
    expect(bucketStarts(r, 900)).toHaveLength(96);
    expect(pickBucket(parseRange({ from: '2026-11-16T11:00:00Z', to: '2026-11-16T12:00:00Z' }))).toBe(60);
    expect(() => parseRange({ from: '2026-11-17T00:00:00Z', to: '2026-11-16T00:00:00Z' })).toThrow();
    expect(() => parseRange({ from: 'garbage' })).toThrow();
  });
});
