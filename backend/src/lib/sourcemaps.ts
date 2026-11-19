import { TraceMap, originalPositionFor, sourceContentFor } from '@jridgewell/trace-mapping';
import type { AnalyticsEvent, StackFrame } from '../contract';
import { stackReleases } from './errorStacks';
import { location } from './store/files';

/**
 * Symbolication of JavaScript error stacks with source maps uploaded from CI (POST /sourcemaps/upload-url, the
 * `wgo-sourcemaps` CLI). Maps live in the data bucket as
 *   sourcemaps/project_id=<pid>/release=<release or _>/<minified file name>.map
 * Stacks are mapped when read, never when stored, so a map uploaded after the error still helps.
 */

// ---------------- names and keys (shared with the upload handler) ----------------

export const NO_RELEASE = '_';
const SAFE_NAME = /^[A-Za-z0-9._~@+=-]{1,200}$/;
const SAFE_RELEASE = /^[A-Za-z0-9._~@+=-]{1,100}$/;

/** `index-abc.js` for `index-abc.js`, `index-abc.js.map` or `/assets/index-abc.js?v=1`; null when not a plain file name. */
export function normalizeMapFile(file: unknown): string | null {
  if (typeof file !== 'string') return null;
  const name = (file.split(/[?#]/)[0].split(/[\\/]/).pop() ?? '').replace(/\.map$/i, '');
  return SAFE_NAME.test(name) && name !== '.' && name !== '..' ? name : null;
}

/** A release label (git sha, version); `_` when none, null when not usable as one path segment. */
export function normalizeRelease(release: unknown): string | null {
  if (release === undefined || release === null || release === '') return NO_RELEASE;
  return typeof release === 'string' && SAFE_RELEASE.test(release) && release !== '.' && release !== '..' ? release : null;
}

export function mapKey(projectId: string, release: string, file: string): string {
  return `sourcemaps/project_id=${projectId}/release=${release}/${file}.map`;
}

// ---------------- stack parsing ----------------

export interface ParsedFrame {
  /** index of the line in the stack text */
  index: number;
  fn: string | null;
  url: string;
  line: number;
  col: number;
  /** rebuilds the line with another location and function name, in the format the line had */
  render(fn: string | null, file: string, line: number, col: number): string;
}

// Chrome / Node: "    at fn (url:1:2)", "    at async fn (url:1:2)", "    at url:1:2"
const CHROME = /^(\s*at\s+)(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
// Firefox / Safari: "fn@url:1:2", "@url:1:2"
const FIREFOX = /^(.*?)@(.+?):(\d+):(\d+)\s*$/;

export function parseStack(stack: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  stack.split('\n').forEach((text, index) => {
    const c = CHROME.exec(text);
    if (c) {
      const [, lead, fn, url, line, col] = c;
      frames.push({
        index, fn: fn ?? null, url, line: +line, col: +col,
        render: (f, file, l, cc) => (f ? `${lead}${f} (${file}:${l}:${cc})` : `${lead}${file}:${l}:${cc}`),
      });
      return;
    }
    const f = FIREFOX.exec(text);
    if (f) {
      const [, fn, url, line, col] = f;
      frames.push({ index, fn: fn || null, url, line: +line, col: +col, render: (name, file, l, cc) => `${name ?? ''}@${file}:${l}:${cc}` });
    }
  });
  return frames;
}

/** File name of a script URL (query and fragment dropped), as it is named in the upload. */
export function scriptName(url: string): string | null {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* not absolute: use as is */
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep */
  }
  return normalizeMapFile(path);
}

// ---------------- map cache ----------------

/** Least recently used cache bounded by the total size of its entries. */
export class Lru<V> {
  private m = new Map<string, { v: V; size: number }>();
  private total = 0;
  constructor(private maxBytes: number) {}
  get(key: string): V | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    this.m.delete(key);
    this.m.set(key, e);
    return e.v;
  }
  set(key: string, v: V, size: number): void {
    this.delete(key);
    if (size > this.maxBytes) return;
    this.m.set(key, { v, size });
    this.total += size;
    for (const [k, e] of this.m) {
      if (this.total <= this.maxBytes) break;
      this.m.delete(k);
      this.total -= e.size;
    }
  }
  delete(key: string): void {
    const e = this.m.get(key);
    if (e) {
      this.m.delete(key);
      this.total -= e.size;
    }
  }
  clear(): void {
    this.m.clear();
    this.total = 0;
  }
  get bytes(): number {
    return this.total;
  }
  get size(): number {
    return this.m.size;
  }
}

const CACHE_BYTES = 50 * 1024 * 1024;
const MISS_TTL_MS = 60_000;
const MISS_SIZE = 200;
const cache = new Lru<{ map: TraceMap | null; exp: number }>(CACHE_BYTES);

export function clearSourcemapCache(): void {
  cache.clear();
}

async function loadMap(pid: string, release: string, file: string, now: number): Promise<TraceMap | null> {
  const key = mapKey(pid, release, file);
  const hit = cache.get(key);
  if (hit && hit.exp > now) return hit.map;
  let map: TraceMap | null = null;
  let size = MISS_SIZE;
  let exp = now + MISS_TTL_MS;
  try {
    const bytes = await location().get(key);
    if (bytes) {
      map = new TraceMap(Buffer.from(bytes).toString('utf8'));
      size = bytes.byteLength * 3; // parsed form is bigger than the file
      exp = Infinity;
    }
  } catch {
    map = null; // unreadable or malformed map: leave the stack as it is
  }
  cache.set(key, { map, exp }, size);
  return map;
}

/** The map for a script: the stack's release first, then maps uploaded without one. */
async function mapFor(pid: string, release: string | null, file: string, now: number): Promise<TraceMap | null> {
  const rel = normalizeRelease(release);
  if (rel && rel !== NO_RELEASE) {
    const m = await loadMap(pid, rel, file, now);
    if (m) return m;
  }
  return loadMap(pid, NO_RELEASE, file, now);
}

// ---------------- symbolication ----------------

export interface Symbolicated {
  /** the stack with mapped frames rewritten; equal to the input when nothing was mapped */
  stack: string;
  /** the input stack, only when mapping changed something */
  minified: string | null;
  /** parsed frames of `stack`; only when mapping changed something */
  frames?: StackFrame[];
}

const CONTEXT = 3;
const MAX_LINE = 300;
// short generated names like `t` or `Ab`: the only ones worth replacing with the name from the map
const MINIFIED_NAME = /^[A-Za-z_$]{1,2}$/;

function context(content: string | null | undefined, line: number): StackFrame['context'] {
  if (!content) return undefined;
  const lines = content.split(/\r?\n/);
  if (line < 1 || line > lines.length) return undefined;
  const start = Math.max(1, line - CONTEXT);
  return { start, lines: lines.slice(start - 1, Math.min(lines.length, line + CONTEXT)).map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) + '…' : l)) };
}

export async function symbolicate(pid: string, release: string | null | undefined, stack: string, now = Date.now()): Promise<Symbolicated> {
  const parsed = parseStack(stack);
  if (!parsed.length) return { stack, minified: null };
  const lines = stack.split('\n');
  const frames: StackFrame[] = [];
  let changed = false;
  for (const f of parsed) {
    const name = scriptName(f.url);
    const map = name ? await mapFor(pid, release ?? null, name, now) : null;
    const pos = map ? originalPositionFor(map, { line: f.line, column: Math.max(0, f.col - 1) }) : null;
    if (map && pos && pos.source !== null && pos.line !== null) {
      changed = true;
      const col = (pos.column ?? 0) + 1;
      const fn = f.fn && MINIFIED_NAME.test(f.fn) && pos.name ? pos.name : f.fn;
      const file = pos.source.replace(/^(?:\.{1,2}\/)+/, ''); // bundlers write ../src/x.ts relative to the build folder
      lines[f.index] = f.render(fn, file, pos.line, col);
      frames.push({ fn, file, line: pos.line, col, mapped: true, context: context(sourceContentFor(map, pos.source), pos.line) });
    } else {
      frames.push({ fn: f.fn, file: f.url, line: f.line, col: f.col, mapped: false });
    }
  }
  return changed ? { stack: lines.join('\n'), minified: stack, frames } : { stack, minified: null };
}

/** Symbolicated sample stacks of error groups, by fingerprint. */
export async function symbolicateGroups(pid: string, stacks: Map<string, string>): Promise<Map<string, Symbolicated>> {
  const out = new Map<string, Symbolicated>();
  if (!stacks.size) return out;
  const releases = await stackReleases(pid, [...stacks.keys()]).catch(() => new Map<string, string>());
  for (const [fp, stack] of stacks) out.set(fp, await symbolicate(pid, releases.get(fp), stack));
  return out;
}

/** Rewrites the stacks of error events in place, using each event's own release. */
export async function symbolicateEvents(events: AnalyticsEvent[], pid: string): Promise<void> {
  for (const e of events) {
    if (e.type !== 'error' || !e.errorStack) continue;
    const ctx = (e.props as { $ctx?: { release?: unknown } } | null)?.$ctx;
    const release = typeof ctx?.release === 'string' ? ctx.release : null;
    e.errorStack = (await symbolicate(pid, release, e.errorStack)).stack;
  }
}
