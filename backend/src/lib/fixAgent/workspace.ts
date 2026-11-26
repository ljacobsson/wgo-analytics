import { lstat, readdir, readFile } from 'node:fs/promises';
import { posix, resolve, sep } from 'node:path';

/**
 * The repository as the agent sees it: the files unpacked from GitHub's tarball, plus the agent's edits kept in
 * memory (nothing on disk changes). Everything the agent asks for goes through `clean`, so it can't name a file
 * outside the repository, and every write checks the project's protected paths. These rules are enforced here, in
 * code, not only asked for in the prompt: error telemetry is written by browsers and may try to steer the agent.
 */

export class WorkspaceError extends Error {}

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;

/**
 * A glob as a RegExp over repository paths: `**` any number of folders, `*` within one name, `?` one character,
 * `{a,b}` alternatives. A pattern without a slash matches a file or folder name at any depth (like .gitignore).
 */
export function globRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, '').replace(/^\/+/, '');
  if (!g.includes('/')) g = `**/${g}`;
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i++; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end < 0) { re += '\\{'; continue; }
      re += `(?:${g.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  // a pattern naming a folder also covers everything in it
  return new RegExp(`^${re}(?:/.*)?$`);
}

export interface Change { path: string; content: string | null; executable: boolean }

export class Workspace {
  private files: string[] | null = null;
  private readonly overlay = new Map<string, string>();
  private readonly denied: RegExp[];
  /** The edits in order, for diff(). */
  private readonly log: Array<{ path: string; old: string | null; new: string }> = [];

  constructor(private readonly dir: string, deniedPaths: string[], public readonly rootPath: string | null = null) {
    this.denied = deniedPaths.map(globRegExp);
  }

  /** A repository path (`src/a.ts`) for what the agent wrote; throws for anything outside the repository. */
  clean(p: string): string {
    if (typeof p !== 'string' || !p.trim() || p.includes('\0')) throw new WorkspaceError('Give a file path inside the repository');
    const norm = posix.normalize(p.trim().replace(/\\/g, '/').replace(/^\/+/, ''));
    if (norm === '.' || norm === '..' || norm.startsWith('../') || posix.isAbsolute(norm)) throw new WorkspaceError(`${p} is outside the repository`);
    if (/(^|\/)\.git(\/|$)/.test(norm)) throw new WorkspaceError('.git is not part of the workspace');
    return norm.replace(/\/$/, '');
  }

  private abs(rel: string): string {
    const root = resolve(this.dir);
    const full = resolve(root, rel);
    if (full !== root && !full.startsWith(root + sep)) throw new WorkspaceError(`${rel} is outside the repository`);
    return full;
  }

  isDenied(rel: string): boolean {
    return this.denied.some((re) => re.test(rel));
  }

  /** Every file path, sorted (the agent's new files included). */
  async list(): Promise<string[]> {
    if (!this.files) {
      const out: string[] = [];
      const walk = async (rel: string) => {
        for (const e of await readdir(this.abs(rel || '.'), { withFileTypes: true })) {
          const child = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(child);
          else if (e.isFile()) out.push(child);
        }
      };
      await walk('');
      this.files = out.sort();
    }
    const extra = [...this.overlay.keys()].filter((k) => !this.files!.includes(k));
    return extra.length ? [...this.files, ...extra].sort() : this.files;
  }

  async exists(rel: string): Promise<boolean> {
    return this.overlay.has(rel) || (await this.list()).includes(rel);
  }

  async isExecutable(rel: string): Promise<boolean> {
    try {
      return ((await lstat(this.abs(rel))).mode & 0o111) !== 0;
    } catch {
      return false;
    }
  }

  /** A text file's content as it is now (with the agent's edits). */
  async read(p: string): Promise<string> {
    const rel = this.clean(p);
    const edited = this.overlay.get(rel);
    if (edited !== undefined) return edited;
    if (!(await this.list()).includes(rel)) throw new WorkspaceError(`${rel} doesn’t exist (paths are relative to the repository root; use list_files)`);
    const st = await lstat(this.abs(rel));
    if (!st.isFile()) throw new WorkspaceError(`${rel} is not a file`);
    if (st.size > MAX_READ_BYTES) throw new WorkspaceError(`${rel} is too large to read (${Math.round(st.size / 1024)} KB)`);
    const buf = await readFile(this.abs(rel));
    if (buf.includes(0)) throw new WorkspaceError(`${rel} is a binary file`);
    return buf.toString('utf8');
  }

  private checkWritable(rel: string, content: string) {
    if (this.isDenied(rel)) throw new WorkspaceError(`${rel} is protected: this project doesn’t let the agent change it. If the fix needs it, explain that in the result instead`);
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new WorkspaceError('That file would be too large');
    if (content.includes('\0')) throw new WorkspaceError('Binary content is not allowed');
  }

  /** Replace one exact, unique occurrence of `oldText` with `newText`. */
  async edit(p: string, oldText: string, newText: string): Promise<{ path: string; line: number }> {
    const rel = this.clean(p);
    const cur = await this.read(rel);
    if (!oldText) throw new WorkspaceError('old_text must not be empty');
    if (oldText === newText) throw new WorkspaceError('old_text and new_text are the same');
    const at = cur.indexOf(oldText);
    if (at < 0) throw new WorkspaceError(`old_text was not found in ${rel}. Read the file again and copy the text exactly, including whitespace`);
    if (cur.indexOf(oldText, at + 1) >= 0) throw new WorkspaceError(`old_text appears more than once in ${rel}: include more surrounding lines so it is unique`);
    const next = cur.slice(0, at) + newText + cur.slice(at + oldText.length);
    this.checkWritable(rel, next);
    this.overlay.set(rel, next);
    this.log.push({ path: rel, old: oldText, new: newText });
    return { path: rel, line: cur.slice(0, at).split('\n').length };
  }

  /** Create a new file (existing files are changed with edit). */
  async create(p: string, content: string): Promise<{ path: string }> {
    const rel = this.clean(p);
    if (await this.exists(rel)) throw new WorkspaceError(`${rel} already exists: change it with edit_file`);
    this.checkWritable(rel, content);
    this.overlay.set(rel, content);
    this.log.push({ path: rel, old: null, new: content });
    return { path: rel };
  }

  /** Undo every change to one file. */
  revert(p: string): boolean {
    const rel = this.clean(p);
    const had = this.overlay.delete(rel);
    for (let i = this.log.length - 1; i >= 0; i--) if (this.log[i].path === rel) this.log.splice(i, 1);
    return had;
  }

  async changes(): Promise<Change[]> {
    const out: Change[] = [];
    for (const [path, content] of [...this.overlay].sort(([a], [b]) => a.localeCompare(b))) {
      out.push({ path, content, executable: await this.isExecutable(path) });
    }
    return out;
  }

  /** The edits so far, as -/+ blocks per file. */
  diff(maxChars = 20_000): string {
    if (!this.log.length) return 'No changes yet.';
    const parts: string[] = [];
    for (const e of this.log) {
      const minus = e.old === null ? '' : e.old.split('\n').map((l) => `-${l}`).join('\n') + '\n';
      const plus = e.new.split('\n').map((l) => `+${l}`).join('\n');
      parts.push(`${e.old === null ? `new file ${e.path}` : `--- ${e.path}`}\n${minus}${plus}`);
    }
    const all = parts.join('\n\n');
    return all.length > maxChars ? `${all.slice(0, maxChars)}\n… (diff cut at ${maxChars} characters)` : all;
  }

  /**
   * Lines matching `pattern` (a JavaScript RegExp) in files matching `glob`, as `path:line: text`. Stops at
   * `max` hits or after `budgetMs` (the regex comes from the model, so it can be slow).
   */
  async grep(pattern: string, glob: string | undefined, max = 50, budgetMs = 5000, ignoreCase = false): Promise<{ hits: string[]; truncated: boolean }> {
    let re: RegExp;
    try {
      re = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (err) {
      throw new WorkspaceError(`Invalid regular expression: ${(err as Error).message}`);
    }
    const only = glob ? globRegExp(glob) : null;
    const hits: string[] = [];
    const until = Date.now() + budgetMs;
    for (const f of await this.list()) {
      if (only && !only.test(f)) continue;
      if (Date.now() > until) return { hits, truncated: true };
      let text: string;
      try {
        text = await this.read(f);
      } catch {
        continue; // binary or too large
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].length > 2000 ? lines[i].slice(0, 2000) : lines[i];
        if (!re.test(line)) continue;
        hits.push(`${f}:${i + 1}: ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`);
        if (hits.length >= max) return { hits, truncated: true };
      }
    }
    return { hits, truncated: false };
  }

  /**
   * The repository file a source-mapped stack frame most likely points at: `webpack://app/./src/a.ts`,
   * `../../src/a.ts` and `/src/a.ts` all end in `src/a.ts`. Prefers files under the project's root folder.
   */
  async resolveFrame(file: string): Promise<string | null> {
    const tail = file.replace(/^[a-z]+:\/\/[^/]*\//i, '').replace(/[?#].*$/, '').split('/').filter((p) => p && p !== '.' && p !== '..');
    if (!tail.length || tail.includes('node_modules')) return null;
    const files = await this.list();
    for (let n = tail.length; n >= 1; n--) {
      const suffix = tail.slice(-n).join('/');
      const found = files.filter((f) => f === suffix || f.endsWith(`/${suffix}`));
      if (found.length === 1) return found[0];
      if (found.length > 1) {
        const inRoot = this.rootPath ? found.filter((f) => f.startsWith(this.rootPath!)) : [];
        if (inRoot.length === 1) return inRoot[0];
        // the whole path matched several places (src/a.ts and packages/x/src/a.ts): take the shortest; a bare name is too weak
        if (n === tail.length && n >= 2) return found.sort((a, b) => a.length - b.length)[0];
        return null;
      }
      if (n <= 2) break; // a bare file name alone is too weak
    }
    return null;
  }
}
