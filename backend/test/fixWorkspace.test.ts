import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DENIED_PATHS } from '../src/lib/fixes';
import { globRegExp, Workspace, WorkspaceError } from '../src/lib/fixAgent/workspace';

describe('globRegExp', () => {
  const m = (glob: string, path: string) => globRegExp(glob).test(path);
  it('matches folders, names and alternatives', () => {
    expect(m('src/**/*.ts', 'src/a.ts')).toBe(true);
    expect(m('src/**/*.ts', 'src/lib/deep/a.ts')).toBe(true);
    expect(m('src/**/*.ts', 'test/a.ts')).toBe(false);
    expect(m('*.test.tsx', 'dashboard/src/pages/Errors.test.tsx')).toBe(true);
    expect(m('src/*.ts', 'src/lib/a.ts')).toBe(false);
    expect(m('**/*.{ts,tsx}', 'a/b.tsx')).toBe(true);
    expect(m('**/*.{ts,tsx}', 'a/b.js')).toBe(false);
    expect(m('dashboard/', 'dashboard/src/x.ts')).toBe(true);
    expect(m('a?.js', 'ab.js')).toBe(true);
    expect(m('a.js', 'aXjs')).toBe(false); // dots are literal
  });

  it('covers what the default protected paths mean', () => {
    const denied = DEFAULT_DENIED_PATHS.map(globRegExp);
    const isDenied = (p: string) => denied.some((re) => re.test(p));
    for (const p of ['.github/workflows/ci.yml', 'package.json', 'dashboard/package.json', 'package-lock.json', 'scripts/deploy.sh',
      'Dockerfile', 'infra/main.tf', 'backend/template.yaml', '.env', '.env.production', '.husky/pre-commit', '.gitlab-ci.yml', '.npmrc']) {
      expect(isDenied(p), p).toBe(true);
    }
    for (const p of ['src/cart.ts', 'dashboard/src/pages/Errors.tsx', 'src/package.ts', 'README.md', 'src/environment.ts']) {
      expect(isDenied(p), p).toBe(false);
    }
  });
});

describe('Workspace', () => {
  let dir: string;
  let ws: Workspace;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wgo-ws-'));
    await mkdir(join(dir, 'src/lib'), { recursive: true });
    await mkdir(join(dir, '.github/workflows'), { recursive: true });
    await writeFile(join(dir, 'src/cart.ts'), 'export function total(cart) {\n  return cart.items.reduce((a, i) => a + i.price, 0);\n}\n');
    await writeFile(join(dir, 'src/lib/cart.ts'), 'export const x = 1;\n');
    await writeFile(join(dir, 'run.sh'), 'echo hi\n');
    await chmod(join(dir, 'run.sh'), 0o755);
    await writeFile(join(dir, '.github/workflows/ci.yml'), 'on: push\n');
    await writeFile(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0, 1, 2]));
    await writeFile(join(dir, 'outside.txt'), 'secret');
    ws = new Workspace(dir, DEFAULT_DENIED_PATHS, 'src/');
  });

  it('keeps every path inside the repository', async () => {
    for (const p of ['../outside', 'src/../../x', '..', '.git/config', 'a\0b', '']) {
      expect(() => ws.clean(p), p).toThrow(WorkspaceError);
    }
    // a leading slash means the repository root, never the filesystem's
    expect(ws.clean('/src/cart.ts')).toBe('src/cart.ts');
    expect(ws.clean('/etc/passwd')).toBe('etc/passwd');
    await expect(ws.read('/etc/passwd')).rejects.toThrow(/doesn’t exist/);
    expect(ws.clean('./src//lib/../cart.ts')).toBe('src/cart.ts');
    await expect(ws.read('../../etc/passwd')).rejects.toThrow(/outside the repository/);
  });

  it('does not follow symlinks out of the repository', async () => {
    await symlink('/etc/hostname', join(dir, 'src/link.txt'));
    const fresh = new Workspace(dir, [], null);
    expect(await fresh.list()).not.toContain('src/link.txt');
    await expect(fresh.read('src/link.txt')).rejects.toThrow(/doesn’t exist/);
  });

  it('edits in memory, never on disk', async () => {
    const r = await ws.edit('src/cart.ts', 'cart.items.reduce', '(cart?.items ?? []).reduce');
    expect(r).toEqual({ path: 'src/cart.ts', line: 2 });
    expect(await ws.read('src/cart.ts')).toContain('(cart?.items ?? []).reduce');
    expect(await readFile(join(dir, 'src/cart.ts'), 'utf8')).toContain('return cart.items.reduce');
    expect(ws.diff()).toContain('--- src/cart.ts\n-cart.items.reduce\n+(cart?.items ?? []).reduce');
    expect((await ws.changes()).map((c) => c.path)).toEqual(['src/cart.ts']);
  });

  it('requires a unique, exact match', async () => {
    await expect(ws.edit('src/cart.ts', 'nope', 'x')).rejects.toThrow(/not found/);
    await expect(ws.edit('src/cart.ts', 'a', 'b')).rejects.toThrow(/more than once/);
    await expect(ws.edit('src/cart.ts', '', 'b')).rejects.toThrow(/empty/);
  });

  it('refuses protected paths, in edits and new files', async () => {
    await expect(ws.edit('.github/workflows/ci.yml', 'push', 'pull_request')).rejects.toThrow(/protected/);
    await expect(ws.create('package.json', '{}')).rejects.toThrow(/protected/);
    await expect(ws.create('deploy/x.sh', 'curl evil')).rejects.toThrow(/protected/);
    await expect(ws.create('src/cart.ts', 'x')).rejects.toThrow(/already exists/);
    expect(await ws.changes()).toEqual([]);
  });

  it('creates and reverts files, and lists them', async () => {
    await ws.create('src/cart.test.ts', 'test("empty", () => {});\n');
    expect(await ws.list()).toContain('src/cart.test.ts');
    expect(await ws.read('src/cart.test.ts')).toContain('empty');
    expect(ws.revert('src/cart.test.ts')).toBe(true);
    expect(await ws.changes()).toEqual([]);
    expect(ws.diff()).toBe('No changes yet.');
  });

  it('keeps executable modes', async () => {
    const open = new Workspace(dir, [], null);
    await open.edit('run.sh', 'hi', 'hello');
    expect(await open.changes()).toEqual([{ path: 'run.sh', content: 'echo hello\n', executable: true }]);
  });

  it('greps text files, skipping binaries', async () => {
    const r = await ws.grep('reduce|const', undefined);
    expect(r.hits).toEqual(['src/cart.ts:2:   return cart.items.reduce((a, i) => a + i.price, 0);', 'src/lib/cart.ts:1: export const x = 1;']);
    expect((await ws.grep('x', 'src/lib/**')).hits).toEqual(['src/lib/cart.ts:1: export const x = 1;']);
    expect((await ws.grep('CART', '*.ts', 50, 5000, true)).hits).toHaveLength(2);
    await expect(ws.grep('(', undefined)).rejects.toThrow(/Invalid regular expression/);
    await expect(ws.read('logo.png')).rejects.toThrow(/binary/);
  });

  it('resolves source-mapped frames to repository files', async () => {
    expect(await ws.resolveFrame('webpack://shop/./src/cart.ts')).toBe('src/cart.ts');
    expect(await ws.resolveFrame('../../src/lib/cart.ts')).toBe('src/lib/cart.ts');
    // two cart.ts files: only a longer suffix decides, and the bare name alone isn't enough
    expect(await ws.resolveFrame('cart.ts')).toBeNull();
    expect(await ws.resolveFrame('https://cdn.example.com/node_modules/react/index.js')).toBeNull();
  });
});
