import { describe, expect, it } from 'vitest';
import { compile, matchRule, wildcard } from '../src/lib/suppressions';

describe('wildcard', () => {
  it('matches the whole value, case-insensitively, with * as anything', () => {
    expect(wildcard('TypeError: *').test('TypeError: x is undefined')).toBe(true);
    expect(wildcard('TypeError: *').test('Uncaught TypeError: x')).toBe(false);
    expect(wildcard('*resizeobserver loop*').test('ResizeObserver loop limit exceeded')).toBe(true);
    expect(wildcard('/admin/*').test('/admin/users/1')).toBe(true);
    expect(wildcard('/admin/*').test('/administrator')).toBe(false);
  });
  it('treats regex characters literally', () => {
    expect(wildcard('a.b (c)?').test('a.b (c)?')).toBe(true);
    expect(wildcard('a.b').test('axb')).toBe(false);
    expect(wildcard('*[object Object]*').test('Error: [object Object] thrown')).toBe(true);
  });
});

describe('matchRule', () => {
  const rubber = compile({ id: 'r1', kind: 'resource', message: null, source: 'https://api.pingis.net/materials/image/rubber/*', page: null });
  const anyImg = compile({ id: 'r2', kind: null, message: null, source: '/img/*', page: null });
  const admin = compile({ id: 'r3', kind: 'error', message: 'TypeError: *', source: null, page: '/admin/*' });
  const err = (o: object) => ({ kind: 'resource', message: 'Failed to load <img>', source: null, page: '/', ...o });

  it('matches the failing URL by its full URL or its path', () => {
    expect(matchRule([rubber], err({ source: 'https://api.pingis.net/materials/image/rubber/stiga-carbo' }))?.id).toBe('r1');
    expect(matchRule([rubber], err({ source: 'https://api.pingis.net/materials/image/blade/x' }))).toBeNull();
    expect(matchRule([anyImg], err({ source: 'https://cdn.example.com/img/hero.webp' }))?.id).toBe('r2');
  });
  it('needs every pattern the rule sets', () => {
    expect(matchRule([rubber], err({ kind: 'error', source: 'https://api.pingis.net/materials/image/rubber/x' }))).toBeNull();
    expect(matchRule([admin], { kind: 'error', message: 'TypeError: x', source: null, page: '/admin/users' })?.id).toBe('r3');
    expect(matchRule([admin], { kind: 'error', message: 'TypeError: x', source: null, page: '/shop' })).toBeNull();
    expect(matchRule([admin], { kind: 'error', message: 'TypeError: x', source: null, page: null })).toBeNull();
  });
});
