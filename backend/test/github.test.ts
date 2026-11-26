import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appJwt, appName, GithubError, manifest, Repo, signState, validBranch, verifyState } from '../src/lib/github';

afterEach(() => vi.unstubAllGlobals());

describe('callback state', () => {
  const s = { kind: 'install' as const, pid: 'p1', email: 'o@example.com', returnTo: 'https://wgo.example.com' };
  it('round-trips and checks kind, signature and expiry', () => {
    const st = signState('secret', s, 1000);
    expect(verifyState('secret', st, 'install', 2000)).toEqual(s);
    expect(() => verifyState('other', st, 'install', 2000)).toThrow(/signature/);
    expect(() => verifyState('secret', st, 'manifest', 2000)).toThrow(/Bad state/);
    expect(() => verifyState('secret', st, 'install', 1000 + 31 * 60_000)).toThrow(/expired/);
    const [data, sig] = st.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(data, 'base64url').toString()), p: 'p2' })).toString('base64url');
    expect(() => verifyState('secret', `${forged}.${sig}`, 'install', 2000)).toThrow(/signature/);
  });
});

describe('the app', () => {
  it('asks only for contents, pull requests and metadata (never workflows)', () => {
    const m = manifest('abc123.execute-api.eu-north-1.amazonaws.com', 'https://wgo.example.com') as { default_permissions: object; redirect_url: string; setup_url: string; request_oauth_on_install: boolean; public: boolean; hook_attributes: { active: boolean } };
    expect(m.default_permissions).toEqual({ contents: 'write', pull_requests: 'write', metadata: 'read' });
    expect(m.redirect_url).toBe('https://abc123.execute-api.eu-north-1.amazonaws.com/github/manifest');
    expect(m.setup_url).toBe('https://abc123.execute-api.eu-north-1.amazonaws.com/github/setup');
    expect(m.request_oauth_on_install).toBe(true);
    expect(m.public).toBe(false);
    expect(m.hook_attributes.active).toBe(false);
    expect(appName('a-very-long-api-id-that-goes-on-and-on.execute-api.x').length).toBeLessThanOrEqual(34);
  });

  it('signs an RS256 JWT GitHub accepts', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const jwt = appJwt('12345', privateKey, 1_700_000_000_000);
    const [h, p, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 - 60 + 600, iss: '12345' });
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(createPublicKey(privateKey), Buffer.from(sig, 'base64url'));
    expect(ok).toBe(true);
  });

  it('validates branch names', () => {
    for (const b of ['main', 'release/1.2', 'wgo-fix/abc-123']) expect(validBranch(b), b).toBe(true);
    for (const b of ['../x', 'a..b', '/main', 'main/', 'a//b', 'x.lock', 'a b', 'a@{1}']) expect(validBranch(b), b).toBe(false);
  });
});

describe('Repo', () => {
  type Call = { url: string; method: string; body: unknown; auth: string | null };
  function stub(handler: (c: Call) => { status?: number; json?: unknown; body?: ReadableStream } | undefined) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const c = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined, auth: headers.authorization ?? null };
      calls.push(c);
      const r = handler(c) ?? { status: 404, json: { message: 'Not Found' } };
      if (r.body) return new Response(r.body, { status: r.status ?? 200 });
      return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }));
    return calls;
  }

  it('commits changes as a new branch on top of the base commit', async () => {
    let blob = 0;
    const calls = stub((c) => {
      if (c.url.endsWith('/git/blobs')) return { status: 201, json: { sha: `blob${++blob}` } };
      if (c.url.endsWith('/git/trees')) return { status: 201, json: { sha: 'tree2' } };
      if (c.url.endsWith('/git/commits')) return { status: 201, json: { sha: 'commit2' } };
      if (c.url.endsWith('/git/refs')) return { status: 201, json: {} };
    });
    const repo = new Repo('acme/shop', 'tok');
    const sha = await repo.commit({ sha: 'commit1', tree: 'tree1' }, 'wgo-fix/abc-1', 'Fix it', [
      { path: 'src/cart.ts', content: 'x', executable: false },
      { path: 'bin/run', content: 'y', executable: true },
    ]);
    expect(sha).toBe('commit2');
    expect(calls.every((c) => c.auth === 'Bearer tok')).toBe(true);
    const tree = calls.find((c) => c.url.endsWith('/git/trees'))!.body as { base_tree: string; tree: Array<{ path: string; mode: string; sha: string }> };
    expect(tree.base_tree).toBe('tree1');
    expect(tree.tree.map((t) => [t.path, t.mode])).toEqual([['src/cart.ts', '100644'], ['bin/run', '100755']]);
    expect(calls.find((c) => c.url.endsWith('/git/commits'))!.body).toEqual({ message: 'Fix it', tree: 'tree2', parents: ['commit1'] });
    expect(calls.find((c) => c.url.endsWith('/git/refs'))!.body).toEqual({ ref: 'refs/heads/wgo-fix/abc-1', sha: 'commit2' });
  });

  it('opens a draft pull request, or a regular one where drafts are not available', async () => {
    const calls = stub((c) => {
      if (!c.url.endsWith('/pulls')) return;
      if ((c.body as { draft: boolean }).draft) return { status: 422, json: { message: 'Draft pull requests are not supported in this repository.' } };
      return { status: 201, json: { number: 7, html_url: 'https://github.com/acme/shop/pull/7' } };
    });
    const pr = await new Repo('acme/shop', 'tok').openPr({ title: 't', body: 'b', head: 'h', base: 'main' });
    expect(pr).toEqual({ number: 7, url: 'https://github.com/acme/shop/pull/7' });
    expect(calls.map((c) => (c.body as { draft: boolean }).draft)).toEqual([true, false]);
  });

  it('reports GitHub errors', async () => {
    stub(() => ({ status: 422, json: { message: 'Reference already exists' } }));
    const err = await new Repo('acme/shop', 'tok').openPr({ title: 't', body: 'b', head: 'h', base: 'main' }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect(err.message).toBe('GitHub 422: Reference already exists');
  });

  it('rejects odd repository names', () => {
    expect(() => new Repo('acme/../x', 't')).toThrow();
    expect(() => new Repo('acme', 't')).toThrow();
  });

  it('unpacks the tarball: regular files only, nothing outside the folder', async () => {
    const src = await mkdtemp(join(tmpdir(), 'wgo-tar-src-'));
    const top = join(src, 'acme-shop-abc123');
    await mkdir(join(top, 'src'), { recursive: true });
    await mkdir(join(top, 'node_modules/react'), { recursive: true });
    await writeFile(join(top, 'src/cart.ts'), 'export {}\n');
    await writeFile(join(top, 'node_modules/react/index.js'), 'x');
    await writeFile(join(top, 'big.bin'), Buffer.alloc(2000));
    await symlink('/etc/hostname', join(top, 'src/link'));
    const chunks: Buffer[] = [];
    for await (const c of tar.c({ gzip: true, cwd: src }, ['acme-shop-abc123'])) chunks.push(c as Buffer);
    const gz = Buffer.concat(chunks);
    stub((c) => (c.url.includes('/tarball/abc123') ? { body: new Blob([gz]).stream() } : undefined));

    const out = await mkdtemp(join(tmpdir(), 'wgo-tar-out-'));
    const r = await new Repo('acme/shop', 'tok').download('abc123', out, 1000);
    expect(r).toEqual({ files: 1, bytes: 10, truncated: false });
    expect(await readFile(join(out, 'src/cart.ts'), 'utf8')).toBe('export {}\n');
    expect(existsSync(join(out, 'node_modules'))).toBe(false);
    expect(existsSync(join(out, 'src/link'))).toBe(false);
    expect(existsSync(join(out, 'big.bin'))).toBe(false);
  });
});
