import { randomUUID } from 'node:crypto';
import type { UptimeBucket, UptimeCheck, UptimeCheckInput, UptimeIncident, UptimeResults, UptimeRunResult, UptimeState } from '../contract';
import { query } from './db';
import { toApiEvent, type EventRow } from './events';
import { HttpError } from './http';
import { pool } from './rollups';
import { rawQuery } from './store/duck';
import { writeRows } from './store/write';
import { assertPublicHttpUrl, evaluateTriggers, isPublicHost } from './triggers';

/**
 * Uptime checks: a scheduled function (handlers/uptime.ts) fetches each enabled check's URL when it is due and
 * records the result as a row of the `checks` raw table. A check goes `down` after 2 failures in a row and `up`
 * after 1 success; each state change is a custom event `wgo.uptime`, run through the triggers like an ingested
 * event, so "name = wgo.uptime AND props.state = down" notifies Slack or a webhook.
 */
export const MAX_CHECKS = 20;
export const INTERVALS = [60, 300, 900] as const;
const FAILS_TO_DOWN = 2;
const MAX_REDIRECTS = 5;
const MAX_BODY = 1_000_000;
const SLACK_MS = 5000;
const STRIP_BUCKETS = 90;
const USER_AGENT = 'WGO-Uptime/1';

// ---------------------------------------------------------------- validation

export function validExpect(v: string): boolean {
  if (v === '2xx' || v === '3xx') return true;
  return /^[1-5]\d\d$/.test(v);
}

/** Whether `status` is what the check expects: '2xx', '3xx' or an exact code. */
export function matchesExpect(expect: string, status: number): boolean {
  if (expect === '2xx') return status >= 200 && status < 300;
  if (expect === '3xx') return status >= 300 && status < 400;
  return String(status) === expect;
}

interface CheckFields {
  name: string; url: string; method: 'GET' | 'HEAD'; expect: string; keyword: string | null; intervalSeconds: number; timeoutMs: number; enabled: boolean;
}

/** Validate a full input, or a partial one laid over `base` (PATCH). Throws 400 with a readable message. */
export function validateInput(input: Partial<UptimeCheckInput>, base?: CheckFields): CheckFields {
  const o = { ...(base ?? { method: 'GET', expect: '2xx', keyword: null, intervalSeconds: 300, timeoutMs: 10_000, enabled: true }), ...input } as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name || name.length > 120) throw new HttpError(400, 'Name must be 1-120 characters');
  const url = typeof o.url === 'string' ? o.url.trim() : '';
  assertPublicHttpUrl(url, 'URL');
  if (url.length > 2000) throw new HttpError(400, 'URL is too long');
  const method = o.method;
  if (method !== 'GET' && method !== 'HEAD') throw new HttpError(400, 'method must be GET or HEAD');
  const expect = typeof o.expect === 'string' ? o.expect.trim() : '';
  if (!validExpect(expect)) throw new HttpError(400, "expect must be '2xx', '3xx' or a status code such as '200'");
  const keyword = typeof o.keyword === 'string' && o.keyword !== '' ? o.keyword : null;
  if (keyword && keyword.length > 200) throw new HttpError(400, 'Keyword is longer than 200 characters');
  if (keyword && method === 'HEAD') throw new HttpError(400, 'A keyword needs method GET');
  const intervalSeconds = Number(o.intervalSeconds);
  if (!(INTERVALS as readonly number[]).includes(intervalSeconds)) throw new HttpError(400, 'intervalSeconds must be 60, 300 or 900');
  const timeoutMs = Number(o.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) throw new HttpError(400, 'timeoutMs must be between 1000 and 30000');
  return { name, url, method, expect, keyword, intervalSeconds, timeoutMs, enabled: o.enabled !== false };
}

// ---------------------------------------------------------------- state machine

export interface StateIn { state: UptimeState | null; failStreak: number }
export interface StateOut extends StateIn {
  /** the state changed; `record` says whether it is written as a wgo.uptime event (not for null to up) */
  changed: boolean;
  record: boolean;
}

/** Down after 2 failures in a row, up after 1 success; a new check is up on its first success. */
export function nextState(prev: StateIn, ok: boolean): StateOut {
  const failStreak = ok ? 0 : prev.failStreak + 1;
  const state: UptimeState | null = ok ? 'up' : failStreak >= FAILS_TO_DOWN ? 'down' : prev.state;
  const changed = state !== prev.state;
  return { state, failStreak, changed, record: changed && !(prev.state === null && state === 'up') };
}

// ---------------------------------------------------------------- probing

export interface ProbeDeps {
  fetch?: typeof fetch;
  isPublic?: (hostname: string) => boolean;
}

export interface ProbeResult { ok: boolean; status: number | null; error: string | null; durationMs: number }

const errorText = (err: unknown): string => {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  return (e?.cause?.code ?? e?.cause?.message ?? e?.message ?? 'request failed').slice(0, 200);
};

async function readBody(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (size < MAX_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      text += dec.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return text;
}

/** One check: follows up to 5 redirects itself, re-checking every Location host. Never throws. */
export async function probe(c: Pick<CheckFields, 'url' | 'method' | 'expect' | 'keyword' | 'timeoutMs'>, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const doFetch = deps.fetch ?? fetch;
  const isPublic = deps.isPublic ?? isPublicHost;
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const signal = AbortSignal.timeout(c.timeoutMs);
  let url = c.url;
  try {
    for (let hop = 0; ; hop++) {
      const u = new URL(url);
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !isPublic(u.hostname)) {
        return { ok: false, status: null, error: hop ? 'redirected to a non-public address' : 'not a public http(s) address', durationMs: elapsed() };
      }
      const res = await doFetch(u, { method: c.method, redirect: 'manual', signal, headers: { 'user-agent': USER_AGENT, accept: '*/*' } });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location && !matchesExpect(c.expect, res.status)) {
        void res.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) return { ok: false, status: res.status, error: 'too many redirects', durationMs: elapsed() };
        url = new URL(location, u).toString();
        continue;
      }
      if (!matchesExpect(c.expect, res.status)) {
        void res.body?.cancel().catch(() => undefined);
        return { ok: false, status: res.status, error: `expected ${c.expect}, got ${res.status}`, durationMs: elapsed() };
      }
      if (c.keyword && c.method === 'GET') {
        const body = await readBody(res);
        const durationMs = elapsed();
        return body.includes(c.keyword)
          ? { ok: true, status: res.status, error: null, durationMs }
          : { ok: false, status: res.status, error: 'keyword not found', durationMs };
      }
      void res.body?.cancel().catch(() => undefined);
      return { ok: true, status: res.status, error: null, durationMs: elapsed() };
    }
  } catch (err) {
    return { ok: false, status: null, error: errorText(err) === 'timeout' ? `timeout after ${c.timeoutMs} ms` : errorText(err), durationMs: elapsed() };
  }
}

// ---------------------------------------------------------------- storage

interface CheckRow {
  project_id: string; id: string; name: string; url: string; method: 'GET' | 'HEAD'; expect: string; keyword: string | null;
  interval_seconds: number; timeout_ms: number; enabled: boolean; state: UptimeState | null; state_since: Date | null;
  last_checked_at: Date | null; fail_streak: number; last_status: number | null; last_error: string | null; last_duration_ms: number | null;
  created_by: string; created_at: Date;
}

const toCheck = (r: CheckRow, strip: Array<number | null> = []): UptimeCheck => ({
  id: r.id, name: r.name, url: r.url, method: r.method, expect: r.expect, keyword: r.keyword, intervalSeconds: r.interval_seconds as UptimeCheck['intervalSeconds'],
  timeoutMs: r.timeout_ms, enabled: r.enabled, state: r.state, stateSince: r.state_since?.toISOString() ?? null,
  lastCheckedAt: r.last_checked_at?.toISOString() ?? null, failStreak: r.fail_streak, lastStatus: r.last_status, lastError: r.last_error,
  lastDurationMs: r.last_duration_ms, createdBy: r.created_by, createdAt: r.created_at.toISOString(), strip,
});

export interface Range { from: Date; to: Date }

/** `from`/`to` query params; default the last 24 hours. */
export function parseWindow(q: Record<string, string | undefined>): Range {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 86_400_000);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) throw new HttpError(400, 'Invalid from/to');
  if (from >= to) throw new HttpError(400, '`from` must be before `to`');
  if (to.getTime() - from.getTime() > 92 * 86_400_000) throw new HttpError(400, 'Range too large (max 92 days)');
  return { from, to };
}

interface BucketRow { b: number; n: number; f: number; p50: number | null; p95: number | null }

async function bucketRows(pid: string, ids: string[] | null, r: Range, seconds: number): Promise<Array<BucketRow & { check_id: string }>> {
  const idFilter = ids ? `AND check_id IN (${ids.map((_, i) => `$${i + 4}`).join(', ')})` : '';
  return rawQuery(pid, r,
    `SELECT check_id, floor(epoch(ts) / $1::double)::float8 * $1::double AS b, count(*)::float8 AS n, sum(1 - ok)::float8 AS f,
            quantile_cont(duration_ms, 0.5)::float8 AS p50, quantile_cont(duration_ms, 0.95)::float8 AS p95
       FROM checks WHERE ts >= $2 AND ts < $3 ${idFilter}
      GROUP BY 1, 2 ORDER BY 2`,
    [seconds, r.from, r.to, ...(ids ?? [])],
  );
}

const bucketSize = (r: Range, count: number) => Math.max(1, Math.ceil((r.to.getTime() - r.from.getTime()) / 1000 / count));

export async function listChecks(pid: string, r: Range = parseWindow({})): Promise<UptimeCheck[]> {
  const rows = await query<CheckRow>('SELECT * FROM uptime_checks WHERE project_id = $1 ORDER BY created_at', [pid]);
  if (!rows.length) return [];
  const seconds = bucketSize(r, STRIP_BUCKETS);
  const start = Math.floor(r.from.getTime() / 1000 / seconds) * seconds;
  const data = await bucketRows(pid, rows.map((x) => x.id), r, seconds).catch((err) => {
    console.warn('uptime strip failed', err);
    return [];
  });
  return rows.map((row) => {
    const strip: Array<number | null> = Array.from({ length: STRIP_BUCKETS }, () => null);
    for (const d of data) {
      if (d.check_id !== row.id) continue;
      const i = Math.floor((d.b - start) / seconds);
      if (i >= 0 && i < STRIP_BUCKETS) strip[i] = (d.n - d.f) / d.n;
    }
    return toCheck(row, strip);
  });
}

async function getRow(pid: string, id: string): Promise<CheckRow> {
  const [row] = await query<CheckRow>('SELECT * FROM uptime_checks WHERE project_id = $1 AND id = $2', [pid, id]);
  if (!row) throw new HttpError(404, 'Check not found');
  return row;
}

export async function createCheck(pid: string, email: string, body: Partial<UptimeCheckInput>): Promise<UptimeCheck> {
  const v = validateInput(body);
  const [{ n }] = await query<{ n: string }>('SELECT count(*) AS n FROM uptime_checks WHERE project_id = $1', [pid]);
  if (Number(n) >= MAX_CHECKS) throw new HttpError(400, `A project can have at most ${MAX_CHECKS} checks`);
  const id = randomUUID();
  const [row] = await query<CheckRow>(
    `INSERT INTO uptime_checks (project_id, id, name, url, method, expect, keyword, interval_seconds, timeout_ms, enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [pid, id, v.name, v.url, v.method, v.expect, v.keyword, v.intervalSeconds, v.timeoutMs, v.enabled, email],
  );
  return toCheck(row);
}

export async function updateCheck(pid: string, id: string, body: Partial<UptimeCheckInput>): Promise<UptimeCheck> {
  const cur = await getRow(pid, id);
  const v = validateInput(body, {
    name: cur.name, url: cur.url, method: cur.method, expect: cur.expect, keyword: cur.keyword, intervalSeconds: cur.interval_seconds,
    timeoutMs: cur.timeout_ms, enabled: cur.enabled,
  });
  const [row] = await query<CheckRow>(
    `UPDATE uptime_checks SET name = $3, url = $4, method = $5, expect = $6, keyword = $7, interval_seconds = $8, timeout_ms = $9, enabled = $10
      WHERE project_id = $1 AND id = $2 RETURNING *`,
    [pid, id, v.name, v.url, v.method, v.expect, v.keyword, v.intervalSeconds, v.timeoutMs, v.enabled],
  );
  return toCheck(row);
}

export async function deleteCheck(pid: string, id: string): Promise<void> {
  await getRow(pid, id);
  await query('DELETE FROM uptime_checks WHERE project_id = $1 AND id = $2', [pid, id]);
}

// ---------------------------------------------------------------- running

const region = () => process.env.AWS_REGION ?? null;

function stateEvent(c: CheckRow, state: UptimeState, r: ProbeResult, ts: Date): EventRow {
  return {
    project_id: c.project_id, ts, id: randomUUID(), type: 'custom', session_id: null, anon_id: null, user_id: null, url: null, path: null,
    title: null, referrer: null, selector: null, element_text: null, element_tag: null, track_name: null, error_message: null,
    error_stack: null, error_source: null, fingerprint: null, http_method: null, http_url: null, http_route: null, http_status: null,
    duration_ms: null, name: 'wgo.uptime',
    props: { check: c.name, checkId: c.id, url: c.url, state, status: r.status, error: r.error, durationMs: Math.round(r.durationMs) },
    browser: null, os: null, device: null, country: null, region: null, city: null, lat: null, lon: null, bot: null,
  };
}

/** Probe one check, record the result, update its row and report a state change. */
export async function runCheck(c: CheckRow, now = new Date(), deps: ProbeDeps = {}): Promise<UptimeRunResult> {
  const r = await probe({ url: c.url, method: c.method, expect: c.expect, keyword: c.keyword, timeoutMs: c.timeout_ms }, deps);
  await writeRows('checks', [{
    project_id: c.project_id, ts: now, id: randomUUID(), check_id: c.id, ok: r.ok ? 1 : 0, status: r.status, duration_ms: r.durationMs, error: r.error, region: region(),
  }]);
  const next = nextState({ state: c.state, failStreak: c.fail_streak }, r.ok);
  await query(
    `UPDATE uptime_checks SET fail_streak = $3, state = $4, state_since = CASE WHEN $5::boolean THEN $2 ELSE state_since END,
            last_checked_at = $2, last_status = $6, last_error = $7, last_duration_ms = $8
      WHERE project_id = $1 AND id = $9`,
    [c.project_id, now, next.failStreak, next.state, next.changed, r.status, r.error, r.durationMs, c.id],
  );
  if (next.record && next.state) {
    const row = stateEvent(c, next.state, r, now);
    await writeRows('events', [row]);
    await evaluateTriggers(c.project_id, [toApiEvent(row)]).catch((err) => console.warn('trigger evaluation failed', err));
  }
  return { ok: r.ok, status: r.status, error: r.error, durationMs: r.durationMs };
}

export async function runNow(pid: string, id: string, deps: ProbeDeps = {}): Promise<UptimeRunResult> {
  return runCheck(await getRow(pid, id), new Date(), deps);
}

/** Runs the checks that are due (a few seconds early still counts). Returns how many ran. */
export async function runChecks(now = Date.now(), deps: ProbeDeps = {}): Promise<number> {
  const rows = await query<CheckRow>('SELECT * FROM uptime_checks WHERE enabled');
  const due = rows.filter((c) => !c.last_checked_at || c.last_checked_at.getTime() + c.interval_seconds * 1000 <= now + SLACK_MS);
  await pool(due, 10, async (c) => {
    try {
      await runCheck(c, new Date(now), deps);
    } catch (err) {
      console.warn('uptime check failed to run', c.id, err);
    }
  });
  return due.length;
}

// ---------------------------------------------------------------- results

const RESULT_BUCKETS = 90;

export async function results(pid: string, id: string, r: Range): Promise<UptimeResults> {
  await getRow(pid, id);
  const seconds = bucketSize(r, RESULT_BUCKETS);
  const rows = await bucketRows(pid, [id], r, seconds);
  const buckets: UptimeBucket[] = rows.map((d) => ({
    t: new Date(d.b * 1000).toISOString(), checks: d.n, failures: d.f, uptime: d.n ? (d.n - d.f) / d.n : null, p50: d.p50, p95: d.p95,
  }));
  const [total] = await rawQuery<{ n: number; f: number; p50: number | null; p95: number | null }>(pid, r,
    `SELECT count(*)::float8 AS n, coalesce(sum(1 - ok), 0)::float8 AS f, quantile_cont(duration_ms, 0.5)::float8 AS p50, quantile_cont(duration_ms, 0.95)::float8 AS p95
       FROM checks WHERE ts >= $1 AND ts < $2 AND check_id = $3`,
    [r.from, r.to, id]);
  const runs = await rawQuery<{ ts: Date; ok: number; error: string | null }>(pid, r,
    `SELECT ts, ok, error FROM checks WHERE ts >= $1 AND ts < $2 AND check_id = $3 ORDER BY ts`,
    [r.from, r.to, id]);
  return {
    buckets,
    incidents: incidents(runs),
    uptime: total?.n ? (total.n - total.f) / total.n : null,
    p50: total?.p50 ?? null,
    p95: total?.p95 ?? null,
  };
}

/** Incidents follow the state machine: they start at the first failure of a down streak (2 in a row), end at the next success. */
export function incidents(runs: Array<{ ts: Date; ok: number; error: string | null }>): UptimeIncident[] {
  const out: UptimeIncident[] = [];
  let streak: Array<{ ts: Date; error: string | null }> = [];
  let open: UptimeIncident | null = null;
  for (const run of runs) {
    if (run.ok) {
      if (open) open.to = new Date(run.ts).toISOString();
      open = null;
      streak = [];
    } else {
      streak.push({ ts: new Date(run.ts), error: run.error });
      if (!open && streak.length >= FAILS_TO_DOWN) {
        open = { from: streak[0].ts.toISOString(), to: null, error: run.error ?? streak[0].error };
        out.push(open);
      }
    }
  }
  return out.reverse();
}

/** For the MCP tool: each check with its uptime over the range. */
export async function summary(pid: string, r: Range): Promise<Array<{ id: string; name: string; url: string; state: UptimeState | null; stateSince: string | null; uptime: number | null; lastError: string | null; lastCheckedAt: string | null }>> {
  const rows = await query<CheckRow>('SELECT * FROM uptime_checks WHERE project_id = $1 ORDER BY created_at', [pid]);
  if (!rows.length) return [];
  const data = await rawQuery<{ check_id: string; n: number; f: number }>(pid, r,
    `SELECT check_id, count(*)::float8 AS n, coalesce(sum(1 - ok), 0)::float8 AS f FROM checks WHERE ts >= $1 AND ts < $2 GROUP BY 1`,
    [r.from, r.to]);
  const by = new Map(data.map((d) => [d.check_id, d]));
  return rows.map((c) => {
    const d = by.get(c.id);
    return {
      id: c.id, name: c.name, url: c.url, state: c.state, stateSince: c.state_since?.toISOString() ?? null,
      uptime: d?.n ? (d.n - d.f) / d.n : null, lastError: c.last_error, lastCheckedAt: c.last_checked_at?.toISOString() ?? null,
    };
  });
}
