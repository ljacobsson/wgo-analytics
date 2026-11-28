import { describe, expect, it } from 'vitest';
import { compileDevHosts, isDevHost, isDevUrl, normalizeHostPattern, parseDevTraffic } from '../src/lib/devTraffic';
import { normalizeBatch } from '../src/lib/events';
import { flaggedSql } from '../src/lib/filters';

describe('isDevHost', () => {
  it('flags localhost, loopback, private addresses and local-only names', () => {
    for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '0.0.0.0', '10.1.2.3', '192.168.1.20', '172.20.0.5',
      '169.254.1.1', '[::1]', '[fd00::1]', 'devbox', 'mysite.local', 'api.internal', 'nas.lan', 'localhost.']) {
      expect(isDevHost(h), h).toBe(true);
    }
  });
  it('keeps public hosts (and reserved test TLDs, which projects add themselves)', () => {
    for (const h of ['pingis.net', 'www.acme.com', '8.8.8.8', '172.32.0.1', 'testing.io', 'local.com', 'shop.test']) expect(isDevHost(h), h).toBe(false);
  });
});

describe('isDevUrl', () => {
  const extra = compileDevHosts({ hosts: ['*.vercel.app', 'staging.acme.com', '*.test'] });

  it('matches built-in development hosts and pages opened from disk', () => {
    expect(isDevUrl('http://localhost:5173/cart?x=1')).toBe(true);
    expect(isDevUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isDevUrl('http://[::1]:3000/')).toBe(true);
    expect(isDevUrl('file:///Users/me/site/index.html')).toBe(true);
    expect(isDevUrl('https://acme.com/')).toBe(false);
  });
  it('matches the project\'s host patterns', () => {
    expect(isDevUrl('https://my-branch-acme.vercel.app/pricing', extra)).toBe(true);
    expect(isDevUrl('https://STAGING.acme.com/', extra)).toBe(true);
    expect(isDevUrl('http://shop.test/', extra)).toBe(true);
    expect(isDevUrl('https://acme.com/', extra)).toBe(false);
    expect(isDevUrl('https://shop.test/')).toBe(false); // not without the pattern
  });
  it('never matches mobile screens, junk or missing URLs', () => {
    expect(isDevUrl('app:/settings', extra)).toBe(false);
    expect(isDevUrl('not a url', extra)).toBe(false);
    expect(isDevUrl(null, extra)).toBe(false);
  });
});

describe('flagging at ingest', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36';
  const batch = (url: string, ctx: object = {}) => ({
    k: 'k', a: 'a', sentAt: Date.now(), ctx: { ua, ...ctx },
    e: [{ id: crypto.randomUUID(), t: 'pageview', ts: Date.now(), s: 's', url, path: '/' }],
  }) as never;
  it('flags events from development pages per event, ahead of other bot reasons', () => {
    expect(normalizeBatch('p', batch('http://localhost:5173/'))[0].bot).toBe('development');
    expect(normalizeBatch('p', batch('http://localhost:5173/', { wd: true }))[0].bot).toBe('development'); // your own e2e tests
    expect(normalizeBatch('p', batch('https://acme.com/', { wd: true }))[0].bot).toBe('automation');
    expect(normalizeBatch('p', batch('https://pr-1.vercel.app/'), Date.now(), undefined, undefined, compileDevHosts({ hosts: ['*.vercel.app'] }))[0].bot).toBe('development');
    expect(normalizeBatch('p', batch('https://acme.com/'))[0].bot).toBeNull();
    expect(normalizeBatch('p', batch('app:/home'))[0].bot).toBeNull();
  });
});

describe('flaggedSql', () => {
  it('leaves out the flagged traffic a request does not include', () => {
    expect(flaggedSql({})).toBe(' AND bot IS NULL');
    expect(flaggedSql({ bots: '1' })).toBe(" AND (bot IS NULL OR bot <> 'development')");
    expect(flaggedSql({ dev: '1' })).toBe(" AND (bot IS NULL OR bot = 'development')");
    expect(flaggedSql({ bots: '1', dev: 'true' })).toBe('');
  });
});

describe('host patterns', () => {
  it('reduces pasted URLs to a hostname pattern', () => {
    expect(normalizeHostPattern(' https://Staging.Acme.com:8443/path?q#h ')).toBe('staging.acme.com');
    expect(normalizeHostPattern('*.vercel.app')).toBe('*.vercel.app');
    expect(normalizeHostPattern('user:pw@preview.acme.dev')).toBe('preview.acme.dev');
    expect(normalizeHostPattern('[::1]:3000')).toBe('[::1]');
    expect(normalizeHostPattern('*')).toBeNull();
    expect(normalizeHostPattern('bad host')).toBeNull();
    expect(normalizeHostPattern('')).toBeNull();
  });
  it('validates settings from the API', () => {
    expect(parseDevTraffic({ hosts: ['A.com', 'a.com', ' ', 'https://b.com/x'] })).toEqual({ hosts: ['a.com', 'b.com'] });
    expect(parseDevTraffic({})).toEqual({ hosts: [] });
    expect(() => parseDevTraffic(null)).toThrow();
    expect(() => parseDevTraffic({ hosts: 'a.com' })).toThrow();
    expect(() => parseDevTraffic({ hosts: ['*'] })).toThrow();
    expect(() => parseDevTraffic({ hosts: Array.from({ length: 51 }, (_, i) => `h${i}.com`) })).toThrow();
  });
});
