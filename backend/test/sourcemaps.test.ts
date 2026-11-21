import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { AnalyticsEvent } from '../src/contract';
import { Lru, appScriptName, clearSourcemapCache, mapKey, normalizeMapFile, normalizeRelease, parseStack, scriptName, symbolicate, symbolicateEvents } from '../src/lib/sourcemaps';
import { sourcemapUploads } from '../src/lib/mcp/tools';
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
  it('tells the app\'s own scripts from ones a map cannot fix', () => {
    expect(appScriptName('https://a.test/assets/index-abc.js?v=1')).toBe('index-abc.js');
    expect(appScriptName('https://a.test/chunk.mjs')).toBe('chunk.mjs');
    expect(appScriptName('http://localhost:5173/node_modules/.vite/deps/react.js')).toBeNull();
    expect(appScriptName('http://127.0.0.1:8080/app.js')).toBeNull();
    expect(appScriptName('https://a.test/node_modules/react-dom/cjs/react-dom.production.js')).toBeNull();
    expect(appScriptName('chrome-extension://abc/content.js')).toBeNull();
    expect(appScriptName('https://a.test/src/App.tsx')).toBeNull();
    expect(appScriptName('<anonymous>')).toBeNull();
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
    expect(miss).toEqual({ stack: 'at o (https://x.test/nomap.js:1:1)', minified: null, missing: { release: null, files: ['nomap.js'] } });
  });

  it('reports missing maps only when none of the app\'s frames mapped', async () => {
    const s = 'TypeError: x\n    at a (https://x.test/assets/main-1.js:1:1)\n    at b (https://x.test/assets/vendor-2.js:1:1)\n    at c (https://x.test/assets/main-1.js:2:2)';
    expect((await symbolicate(PID, 'v7', s)).missing).toEqual({ release: 'v7', files: ['main-1.js', 'vendor-2.js'] });
    expect((await symbolicate(PID, 'bad/release', s)).missing?.release).toBeNull();
    // nothing a map could fix: dev server, dependencies, native code
    expect((await symbolicate(PID, null, 'E\n    at a (http://localhost:5173/src/main.js:1:1)\n    at b (<anonymous>)')).missing).toBeUndefined();
    expect((await symbolicate(PID, null, 'E\n    at a (https://x.test/node_modules/lib/index.js:1:1)')).missing).toBeUndefined();
    expect((await symbolicate(PID, null, 'no frames here')).missing).toBeUndefined();
    // one mapped frame: maps are uploaded, the rest is third-party code
    await location().put(mapKey(PID, '_', 'app-abc123.js'), map);
    expect((await symbolicate(PID, null, stack())).missing).toBeUndefined();
  });

  it('marks error events whose stacks lack maps', async () => {
    const ev = (stack: string, release?: string) => ({ type: 'error', errorStack: stack, props: release ? { $ctx: { release } } : {} }) as unknown as AnalyticsEvent;
    const events = [ev('E\n    at a (https://x.test/nomap-9.js:1:1)', 'r2'), ev('E\n    at a (http://localhost:3000/a.js:1:1)')];
    await symbolicateEvents(events, PID);
    expect(events[0].missingSourcemaps).toEqual({ release: 'r2', files: ['nomap-9.js'] });
    expect(events[1].missingSourcemaps).toBeUndefined();
  });
});

describe('upload_sourcemaps (MCP)', () => {
  it('returns one curl PUT per map, quoted for the shell', async () => {
    const r = await sourcemapUploads(PID, { release: 'v1.2.3', files: ['dist/assets/index-abc.js.map', "Bob's app/out/main-1.mjs.map"] }, 'http://localhost:8787');
    expect(r.release).toBe('v1.2.3');
    expect(r.files).toEqual([{ path: 'dist/assets/index-abc.js.map', script: 'index-abc.js' }, { path: "Bob's app/out/main-1.mjs.map", script: 'main-1.mjs' }]);
    const lines = r.command.split(' &&\n');
    expect(lines[0]).toBe(`curl -fsS -T 'dist/assets/index-abc.js.map' 'http://localhost:8787/sourcemaps/put/sourcemaps/project_id=${PID}/release=v1.2.3/index-abc.js.map'`);
    expect(lines[1]).toMatch(/^curl -fsS -T 'Bob'\\''s app\/out\/main-1\.mjs\.map' '.*\/release=v1\.2\.3\/main-1\.mjs\.map'$/);
    expect(lines.at(-1)).toBe("echo 'Uploaded 2 source maps'");
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });
  it('uploads without a release as the fallback for every release', async () => {
    const r = await sourcemapUploads(PID, { files: ['main.js.map'] }, 'http://localhost:8787');
    expect(r.release).toBeNull();
    expect(r.command).toContain('/release=_/main.js.map');
    expect(r.command).toContain("echo 'Uploaded 1 source map'");
  });
  it('rejects paths that are not uniquely named source maps', async () => {
    await expect(sourcemapUploads(PID, { files: ['dist/main.js'] }, 'http://x')).rejects.toThrow(/Not a source map/);
    await expect(sourcemapUploads(PID, { files: ['dist/a b.js.map'] }, 'http://x')).rejects.toThrow(/Not a source map/);
    await expect(sourcemapUploads(PID, { files: ['a/main.js.map', 'b/main.js.map'] }, 'http://x')).rejects.toThrow(/same file name/);
    await expect(sourcemapUploads(PID, { release: 'a/b', files: ['main.js.map'] }, 'http://x')).rejects.toThrow(/release must be/);
  });
  it('needs S3 or a public origin to upload to', async () => {
    await expect(sourcemapUploads(PID, { files: ['main.js.map'] }, undefined)).rejects.toThrow(/cannot sign uploads/);
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
