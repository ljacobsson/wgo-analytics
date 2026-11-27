import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';

/**
 * Where the Parquet files live. STORE_URL is `s3://bucket` (deployed) or a local directory (dev server and
 * tests), so everything above this file works the same against both.
 */
export interface StoredFile {
  key: string;
  size: number;
}

export interface Location {
  /** what DuckDB reads: s3://bucket/key or an absolute path */
  url(key: string): string;
  put(key: string, body: Uint8Array): Promise<void>;
  /** the object's bytes, or null when it doesn't exist */
  get(key: string): Promise<Uint8Array | null>;
  /** presigned URL for a client PUT of `key`; null when there is no S3 (local directory) */
  presignPut(key: string, expiresInSeconds: number): Promise<string | null>;
  /** presigned URL that downloads `key` as an attachment named `filename`; null when there is no S3 (local directory) */
  presignGet(key: string, expiresInSeconds: number, filename: string): Promise<string | null>;
  /** keys under `prefix` in lexicographic order, after `startAfter`, until `until` returns true for a key */
  list(prefix: string, opts?: { startAfter?: string; until?: (key: string) => boolean }): Promise<StoredFile[]>;
  remove(keys: string[]): Promise<void>;
  readonly s3: boolean;
}

let cached: { url: string; loc: Location } | null = null;

export function location(): Location {
  const url = process.env.STORE_URL;
  if (!url) throw new Error('STORE_URL not set');
  if (cached?.url === url) return cached.loc;
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(url);
  const loc = m ? s3Location(m[1], m[2].replace(/\/?$/, m[2] ? '/' : '')) : localLocation(resolve(url));
  cached = { url, loc };
  return loc;
}

function localLocation(root: string): Location {
  const path = (key: string) => join(root, ...key.split('/'));
  async function walk(dir: string, out: StoredFile[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p, out);
      else if (e.name.endsWith('.parquet')) out.push({ key: relative(root, p).split(sep).join('/'), size: (await stat(p)).size });
    }
  }
  return {
    s3: false,
    url: path,
    async put(key, body) {
      const p = path(key);
      await mkdir(dirname(p), { recursive: true });
      // write, then rename: a reader never sees half a file (S3 puts are atomic too)
      await writeFile(p + '.tmp', body);
      await rename(p + '.tmp', p);
    },
    async get(key) {
      try {
        return await readFile(path(key));
      } catch {
        return null;
      }
    },
    async presignPut() {
      return null;
    },
    async presignGet() {
      return null;
    },
    async list(prefix, opts = {}) {
      const base = prefix.endsWith('/') ? prefix : prefix.slice(0, prefix.lastIndexOf('/') + 1);
      const out: StoredFile[] = [];
      await walk(path(base), out);
      out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const res: StoredFile[] = [];
      for (const f of out) {
        if (!f.key.startsWith(prefix) || (opts.startAfter && f.key <= opts.startAfter)) continue;
        if (opts.until?.(f.key)) break;
        res.push(f);
      }
      return res;
    },
    async remove(keys) {
      await Promise.all(keys.map((k) => rm(path(k), { force: true })));
    },
  };
}

function s3Location(bucket: string, root: string): Location {
  let client: S3Client | null = null;
  const s3 = async () => {
    if (!client) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      client = new S3Client({});
    }
    return client;
  };
  return {
    s3: true,
    url: (key) => `s3://${bucket}/${root}${key}`,
    async put(key, body) {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      await (await s3()).send(new PutObjectCommand({ Bucket: bucket, Key: root + key, Body: body, ContentType: 'application/vnd.apache.parquet' }));
    },
    async get(key) {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      try {
        const res = await (await s3()).send(new GetObjectCommand({ Bucket: bucket, Key: root + key }));
        return (await res.Body?.transformToByteArray()) ?? null;
      } catch (err) {
        const name = (err as { name?: string }).name;
        // a missing object reads as AccessDenied when the role can't list the bucket
        if (name === 'NoSuchKey' || name === 'NotFound' || name === 'AccessDenied') return null;
        throw err;
      }
    },
    async presignPut(key, expiresInSeconds) {
      const [{ PutObjectCommand }, { getSignedUrl }] = await Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner')]);
      return getSignedUrl(await s3(), new PutObjectCommand({ Bucket: bucket, Key: root + key }), { expiresIn: expiresInSeconds });
    },
    async presignGet(key, expiresInSeconds, filename) {
      const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner')]);
      const disposition = `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`;
      return getSignedUrl(await s3(), new GetObjectCommand({ Bucket: bucket, Key: root + key, ResponseContentDisposition: disposition }), { expiresIn: expiresInSeconds });
    },
    async list(prefix, opts = {}) {
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const out: StoredFile[] = [];
      let token: string | undefined;
      do {
        const res = await (await s3()).send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: root + prefix, ContinuationToken: token,
          StartAfter: token ? undefined : opts.startAfter ? root + opts.startAfter : undefined,
        }));
        for (const o of res.Contents ?? []) {
          const key = o.Key!.slice(root.length);
          if (!key.endsWith('.parquet')) continue;
          if (opts.until?.(key)) return out;
          out.push({ key, size: o.Size ?? 0 });
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async remove(keys) {
      const { DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
      for (let i = 0; i < keys.length; i += 1000) {
        const res = await (await s3()).send(new DeleteObjectsCommand({
          Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000).map((k) => ({ Key: root + k })), Quiet: true },
        }));
        if (res.Errors?.length) throw new Error(`S3 delete failed for ${res.Errors.length} objects: ${res.Errors[0].Code} ${res.Errors[0].Message}`);
      }
    },
  };
}
