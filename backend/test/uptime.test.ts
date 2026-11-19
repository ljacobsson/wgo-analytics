import { describe, expect, it } from 'vitest';
import { shapeCosts } from '../src/lib/costs';
import { incidents, matchesExpect, nextState, probe, validateInput, type StateIn } from '../src/lib/uptime';
import { assertPublicHttpsUrl, assertPublicHttpUrl } from '../src/lib/triggers';

describe('uptime URL validation', () => {
  it('accepts public http and https URLs', () => {
    expect(assertPublicHttpUrl('http://example.com/health').protocol).toBe('http:');
    expect(assertPublicHttpUrl('https://example.com:8443/x').port).toBe('8443');
  });
  it.each(['http://localhost/x', 'http://127.0.0.1/', 'https://10.1.2.3/', 'http://169.254.169.254/latest', 'http://intranet/', 'ftp://example.com/', 'https://u:p@example.com/', 'nope'])(
    'rejects %s', (url) => expect(() => assertPublicHttpUrl(url)).toThrow(),
  );
  it('keeps the webhook rule https only', () => {
    expect(() => assertPublicHttpsUrl('http://example.com/hook')).toThrow('Webhook URL must use https');
  });
  it('validates a whole input and applies defaults', () => {
    const v = validateInput({ name: ' Site ', url: 'https://example.com' });
    expect(v).toMatchObject({ name: 'Site', method: 'GET', expect: '2xx', keyword: null, intervalSeconds: 300, timeoutMs: 10000, enabled: true });
    expect(() => validateInput({ name: 'x', url: 'https://example.com', intervalSeconds: 30 as never })).toThrow();
    expect(() => validateInput({ name: 'x', url: 'https://example.com', timeoutMs: 500 })).toThrow();
    expect(() => validateInput({ name: 'x', url: 'https://example.com', expect: '9xx' })).toThrow();
    expect(() => validateInput({ name: 'x', url: 'https://example.com', method: 'HEAD', keyword: 'ok' })).toThrow('GET');
    expect(() => validateInput({ name: 'x', url: 'http://localhost' })).toThrow();
  });
});

describe('expect matching', () => {
  it('matches classes and exact codes', () => {
    expect(matchesExpect('2xx', 204)).toBe(true);
    expect(matchesExpect('2xx', 301)).toBe(false);
    expect(matchesExpect('3xx', 302)).toBe(true);
    expect(matchesExpect('200', 200)).toBe(true);
    expect(matchesExpect('200', 204)).toBe(false);
    expect(matchesExpect('404', 404)).toBe(true);
  });
});

describe('state machine', () => {
  const run = (results: boolean[]) => {
    let s: StateIn = { state: null, failStreak: 0 };
    return results.map((ok) => {
      const n = nextState(s, ok);
      s = n;
      return { state: n.state, record: n.record };
    });
  };
  it('null goes up on the first success without an event', () => {
    expect(run([true])).toEqual([{ state: 'up', record: false }]);
  });
  it('one failure keeps the state, two make it down with an event', () => {
    expect(run([true, false, false, false])).toEqual([
      { state: 'up', record: false }, { state: 'up', record: false }, { state: 'down', record: true }, { state: 'down', record: false },
    ]);
  });
  it('recovers on one success with an event', () => {
    expect(run([true, false, false, true]).at(-1)).toEqual({ state: 'up', record: true });
  });
  it('null goes down after two failures, with an event', () => {
    expect(run([false, false])).toEqual([{ state: null, record: false }, { state: 'down', record: true }]);
  });
  it('a single failure between successes never changes anything', () => {
    expect(run([true, false, true, false, true]).every((r) => !r.record)).toBe(true);
  });
});

const res = (status: number, headers: Record<string, string> = {}, body = '') => new Response(body, { status, headers });

describe('probe', () => {
  const base = { url: 'https://example.com/', method: 'GET' as const, expect: '2xx', keyword: null, timeoutMs: 2000 };
  it('succeeds on an expected status', async () => {
    const r = await probe(base, { fetch: async () => res(200) });
    expect(r).toMatchObject({ ok: true, status: 200, error: null });
  });
  it('fails on an unexpected status', async () => {
    const r = await probe(base, { fetch: async () => res(503) });
    expect(r).toMatchObject({ ok: false, status: 503, error: 'expected 2xx, got 503' });
  });
  it('follows redirects and checks every host', async () => {
    const seen: string[] = [];
    const ok = await probe(base, {
      fetch: (async (u: URL) => { seen.push(String(u)); return seen.length === 1 ? res(301, { location: '/next' }) : res(200); }) as never,
    });
    expect(ok.ok).toBe(true);
    expect(seen).toEqual(['https://example.com/', 'https://example.com/next']);
    const bad = await probe(base, { fetch: async () => res(302, { location: 'http://localhost:8080/admin' }) });
    expect(bad).toMatchObject({ ok: false, error: 'redirected to a non-public address' });
  });
  it('gives up after 5 redirects', async () => {
    const r = await probe(base, { fetch: async () => res(302, { location: '/again' }) });
    expect(r.error).toBe('too many redirects');
  });
  it('stops at a redirect when it is the expected status', async () => {
    const r = await probe({ ...base, expect: '301' }, { fetch: async () => res(301, { location: '/x' }) });
    expect(r.ok).toBe(true);
  });
  it('looks for a keyword in the body', async () => {
    const withKw = { ...base, keyword: 'All systems go' };
    expect((await probe(withKw, { fetch: async () => res(200, {}, '<p>All systems go</p>') })).ok).toBe(true);
    expect(await probe(withKw, { fetch: async () => res(200, {}, 'oops') })).toMatchObject({ ok: false, error: 'keyword not found' });
  });
  it('rejects a non-public start URL and reports timeouts and network errors', async () => {
    expect((await probe({ ...base, url: 'http://127.0.0.1/' }, { fetch: async () => res(200) })).ok).toBe(false);
    const slow = await probe({ ...base, timeoutMs: 1000 }, {
      fetch: ((_u: URL, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as never,
    });
    expect(slow.error).toBe('timeout after 1000 ms');
    const down = await probe(base, { fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
    expect(down.error).toBe('ECONNREFUSED');
  });
});

describe('incidents', () => {
  const t = (m: number) => new Date(Date.UTC(2026, 10, 19, 12, m));
  it('starts at the first failure of a down streak and ends at the next success', () => {
    const runs = [
      { ts: t(0), ok: 1, error: null }, { ts: t(1), ok: 0, error: 'a' }, { ts: t(2), ok: 1, error: null },
      { ts: t(3), ok: 0, error: 'b' }, { ts: t(4), ok: 0, error: 'c' }, { ts: t(5), ok: 1, error: null }, { ts: t(6), ok: 0, error: 'd' }, { ts: t(7), ok: 0, error: 'e' },
    ];
    expect(incidents(runs)).toEqual([
      { from: t(6).toISOString(), to: null, error: 'e' },
      { from: t(3).toISOString(), to: t(5).toISOString(), error: 'c' },
    ]);
  });
});

describe('cost response shaping', () => {
  const now = Date.UTC(2026, 10, 19, 10); // 19 November 2026
  const day = (d: string, groups: Array<[string, number]>) => ({
    TimePeriod: { Start: d, End: d }, Total: {}, Estimated: false,
    Groups: groups.map(([s, a]) => ({ Keys: [s], Metrics: { UnblendedCost: { Amount: String(a), Unit: 'USD' } } })),
  });
  it('totals the month, last month, the daily series and services', () => {
    const out = shapeCosts([
      day('2026-10-30', [['AWS Lambda', 0.5], ['Amazon S3', 0.25]]),
      day('2026-11-01', [['AWS Lambda', 0.1], ['Amazon S3', 0.05]]),
      day('2026-11-02', [['AWS Lambda', 0.2], ['Amazon S3', 0.05]]),
    ], now);
    expect(out).toMatchObject({ setup: false, currency: 'USD', monthToDate: 0.4, lastMonth: 0.75 });
    expect(out.services).toEqual([{ service: 'AWS Lambda', amount: 0.3 }, { service: 'Amazon S3', amount: 0.1 }]);
    expect(out.daily.map((d) => d.day)).toEqual(['2026-10-30', '2026-11-01', '2026-11-02']);
    expect(out.forecast).toBeCloseTo((0.4 / 2) * 30, 3);
  });
  it('asks for setup when there are no costs', () => {
    expect(shapeCosts([], now).setup).toBe(true);
    expect(shapeCosts([day('2026-11-01', [])], now)).toMatchObject({ setup: true, daily: [], services: [] });
  });
});
