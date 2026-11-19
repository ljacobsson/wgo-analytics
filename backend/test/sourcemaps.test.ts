import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { Lru, clearSourcemapCache, mapKey, normalizeMapFile, normalizeRelease, parseStack, scriptName, symbolicate } from '../src/lib/sourcemaps';
import { location } from '../src/lib/store/files';

vi.mock('../src/lib/errorStacks', () => ({ stackReleases: async () => new Map() }));
vi.mock('../src/lib/projects', () => ({ projectIdForUploadKey: async (k?: string) => (k === 'uk_validvalidvalidvalidvalid' ? 'p-1' : null) }));

const FIX = join(import.meta.dirname, 'fixtures');
const js = readFileSync(join(FIX, 'app-abc123.js'), 'utf8');
const map = readFileSync(join(FIX, 'app-abc123.js.map'));
const col = js.indexOf('new Error') + 1;
const PID = '11111111-1111-1111-1111-111111111111';

describe('stack parsing', () => {
  it('parses Chrome frames', () => {
    const f = parseStack(`Error: x\n    at o (https://a.test/assets/app.js:1:50)\n    at async n (https://a.test/app.js?v=2:3:4)\n    at https://a.test/app.js:7:8`);
    expect(f.map((x) => [x.index, x.fn, x.url, x.line, x.col])).toEqual([
      [1, 'o', 'https://a.test/assets/app.js', 1, 50],
      [2, 'async n', 'https://a.test/app.js?v=2', 3, 4],
      [3, null, 'https://a.test/app.js', 7, 8],
    ]);
    expect(f[0].render('checkout', 'src/cart.ts', 4, 11)).toBe('    at checkout (src/cart.ts:4:11)');
    expect(f[2].render(null, 'src/a.ts', 1, 1)).toBe('    at src/a.ts:1:1');
  });
  it('parses Firefox and Safari frames', () => {
    const f = parseStack('o@https://a.test/app.js:1:50\n@https://a.test/app.js:2:3\nglobal code');
    expect(f.map((x) => [x.fn, x.url, x.line, x.col])).toEqual([['o', 'https://a.test/app.js', 1, 50], [null, 'https://a.test/app.js', 2, 3]]);
    expect(f[0].render('checkout', 'src/cart.ts', 4, 11)).toBe('checkout@src/cart.ts:4:11');
  });
  it('names scripts and maps safely', () => {
    expect(scriptName('https://a.test/assets/index-abc.js?x=1#y')).toBe('index-abc.js');
    expect(normalizeMapFile('dist/assets/index-abc.js.map')).toBe('index-abc.js');
    expect(normalizeMapFile('a b.js')).toBeNull();
    expect(normalizeMapFile('..')).toBeNull();
    expect(normalizeRelease(undefined)).toBe('_');
    expect(normalizeRelease('v1.2.3')).toBe('v1.2.3');
    expect(normalizeRelease('a/b')).toBeNull();
    expect(mapKey(PID, '_', 'a.js')).toBe(`sourcemaps/project_id=${PID}/release=_/a.js.map`);
  });
});

describe('Lru', () => {
  it('evicts least recently used entries over the byte cap', () => {
    const c = new Lru<number>(10);
    c.set('a', 1, 4); c.set('b', 2, 4);
    c.get('a');
    c.set('c', 3, 4);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.bytes).toBe(8);
    c.set('big', 9, 11);
    expect(c.get('big')).toBeUndefined();
  });
});

describe('symbolicate', () => {
  beforeEach(() => clearSourcemapCache());
  const stack = () => `Error: too expensive\n    at o (https://shop.test/assets/app-abc123.js:1:${col})\n    at n (https://shop.test/assets/app-abc123.js:1:${js.indexOf('return o(e)') + 1})\n    at https://cdn.test/other.js:1:1`;

  it('maps frames with a release-less map and keeps unmapped ones', async () => {
    await location().put(mapKey(PID, '_', 'app-abc123.js'), map);
    const r = await symbolicate(PID, 'v9', stack());
    expect(r.minified).toBe(stack());
    const lines = r.stack.split('\n');
    expect(lines[1]).toMatch(/^ {4}at (checkout|o) \(.*src\/cart\.ts:4:/);
    expect(lines[2]).toMatch(/src\/app\.ts:3:/);
    expect(lines[3]).toBe('    at https://cdn.test/other.js:1:1');
    expect(r.frames![0]).toMatchObject({ mapped: true, file: expect.stringContaining('cart.ts'), line: 4 });
    expect(r.frames![0].context!.lines.join('\n')).toContain('too expensive');
    expect(r.frames![2]).toMatchObject({ mapped: false });
  });

  it('prefers the release folder and caches misses', async () => {
    const other = Buffer.from(JSON.stringify({ version: 3, sources: ['rel.ts'], names: [], mappings: 'AAAA' }));
    await location().put(mapKey(PID, 'v1', 'app-abc123.js'), other);
    const r = await symbolicate(PID, 'v1', `at o (https://x.test/app-abc123.js:1:1)`);
    expect(r.stack).toContain('rel.ts:1:1');
    const miss = await symbolicate(PID, null, 'at o (https://x.test/nomap.js:1:1)');
    expect(miss).toEqual({ stack: 'at o (https://x.test/nomap.js:1:1)', minified: null });
  });
});

describe('POST /sourcemaps/upload-url', () => {
  const call = async (headers: Record<string, string>, body: unknown, method = 'POST') => {
    const { handler } = await import('../src/handlers/sourcemaps');
    return (await handler({
      rawPath: '/sourcemaps/upload-url', headers, body: typeof body === 'string' ? body : JSON.stringify(body), isBase64Encoded: false,
      requestContext: { http: { method } },
    } as unknown as APIGatewayProxyEventV2)) as { statusCode: number; body: string };
  };
  const auth = { 'x-wgo-upload-key': 'uk_validvalidvalidvalidvalid', host: 'wgo.test' };

  it('rejects missing and unknown keys', async () => {
    expect((await call({}, { file: 'a.js' })).statusCode).toBe(401);
    expect((await call({ 'x-wgo-upload-key': 'wk_nope' }, { file: 'a.js' })).statusCode).toBe(401);
    expect((await call(auth, {}, 'GET')).statusCode).toBe(405);
  });
  it('validates release and file', async () => {
    expect((await call(auth, { file: 'b c.js' })).statusCode).toBe(400);
    expect((await call(auth, { file: 'a.js', release: 'x/y' })).statusCode).toBe(400);
    expect((await call(auth, { file: 'a.js', release: 'r'.repeat(101) })).statusCode).toBe(400);
    expect((await call(auth, 'not json')).statusCode).toBe(400);
  });
  it('returns an upload url and the object key', async () => {
    const r = await call(auth, { file: 'dist/assets/index-abc123.js.map', release: 'v1.2.3' });
    expect(r.statusCode).toBe(200);
    const b = JSON.parse(r.body);
    expect(b.key).toBe('sourcemaps/project_id=p-1/release=v1.2.3/index-abc123.js.map');
    expect(b.url).toBe(`http://wgo.test/sourcemaps/put/${b.key}`); // local store: no S3 to presign for
    expect(JSON.parse((await call(auth, { file: 'index.js' })).body).key).toContain('release=_/index.js.map');
  });
});
