import { describe, expect, it } from 'vitest';
import { compileDevTraffic, isDevHost, isDevUrl, normalizeHostPattern, parseDevTraffic } from '../src/lib/devTraffic';

describe('isDevHost', () => {
  it('flags localhost, loopback, private addresses and local-only names', () => {
    for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '0.0.0.0', '10.1.2.3', '192.168.1.20', '172.20.0.5',
      '169.254.1.1', '[::1]', '[fd00::1]', 'devbox', 'mysite.local', 'shop.test', 'api.internal', 'x.example', 'localhost.']) {
      expect(isDevHost(h), h).toBe(true);
    }
  });
  it('keeps public hosts', () => {
    for (const h of ['pingis.net', 'www.acme.com', '8.8.8.8', '172.32.0.1', 'testing.io', 'local.com']) expect(isDevHost(h), h).toBe(false);
  });
});

describe('isDevUrl', () => {
  const builtIn = compileDevTraffic({ ignore: true, hosts: [] });
  const custom = compileDevTraffic({ ignore: false, hosts: ['*.vercel.app', 'staging.acme.com'] });
  const off = compileDevTraffic({ ignore: false, hosts: [] });

  it('matches page URLs and origins on development hosts when ignore is on', () => {
    expect(isDevUrl(builtIn, 'http://localhost:5173/cart?x=1')).toBe(true);
    expect(isDevUrl(builtIn, 'http://127.0.0.1:8080')).toBe(true);
    expect(isDevUrl(builtIn, 'http://[::1]:3000/')).toBe(true);
    expect(isDevUrl(builtIn, 'file:///Users/me/site/index.html')).toBe(true);
    expect(isDevUrl(builtIn, 'https://acme.com/')).toBe(false);
  });
  it('never matches mobile screens, junk or missing URLs', () => {
    for (const f of [builtIn, custom]) {
      expect(isDevUrl(f, 'app:/settings')).toBe(false);
      expect(isDevUrl(f, 'not a url')).toBe(false);
      expect(isDevUrl(f, null)).toBe(false);
    }
  });
  it('matches custom host patterns whether or not ignore is on', () => {
    expect(isDevUrl(custom, 'https://my-branch-acme.vercel.app/pricing')).toBe(true);
    expect(isDevUrl(custom, 'https://STAGING.acme.com/')).toBe(true);
    expect(isDevUrl(custom, 'https://acme.com/')).toBe(false);
    expect(isDevUrl(custom, 'http://localhost:5173/')).toBe(false); // the built-in list is off
  });
  it('matches nothing when off', () => {
    expect(isDevUrl(off, 'http://localhost:5173/')).toBe(false);
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
    expect(parseDevTraffic({ ignore: true, hosts: ['A.com', 'a.com', ' ', 'https://b.com/x'] })).toEqual({ ignore: true, hosts: ['a.com', 'b.com'] });
    expect(parseDevTraffic({})).toEqual({ ignore: false, hosts: [] });
    expect(() => parseDevTraffic(null)).toThrow();
    expect(() => parseDevTraffic({ ignore: 'yes' })).toThrow();
    expect(() => parseDevTraffic({ hosts: 'a.com' })).toThrow();
    expect(() => parseDevTraffic({ hosts: ['*'] })).toThrow();
    expect(() => parseDevTraffic({ hosts: Array.from({ length: 51 }, (_, i) => `h${i}.com`) })).toThrow();
  });
});
