import type {
  RecordingChunk, RecordingResponse, RecordingSettings, RecordingSettingsResponse, RecordingsResponse, RecordingSummary, RecordingTrigger,
  RecordingTriggerType,
} from '../contract';
import { query } from './db';
import { eventTime, clockSkew, type WireBatch } from './events';
import { HttpError } from './http';
import { projectIdForWriteKey } from './projects';
import { projectRetention, RECORDING_RETENTION_DAYS } from './retention';
import { inList, rawQuery } from './store/duck';

/**
 * Session recordings (the SDK's recorder: sdk/src/replay). Off until a project owner turns them on.
 *
 * - GET /replay/config tells the SDK whether and what to record (sample rate, triggers, masking).
 * - POST /replay/start asks for a slot for one session. The hourly and daily limits are checked here, against
 *   the `recordings` table (one row per granted session). Two visitors asking at the same moment can both get
 *   the last slot: the limits are approximate by up to a few sessions.
 * - The recorder sends its chunks as `replay` events to /ingest. Chunks of sessions without a slot (or of a
 *   project that stopped recording) are dropped there; the rest are stored as Parquet (the `replays` table).
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MAX_TRIGGERS = 20;
const MAX_LIMIT = 1_000_000;
/** a chunk bigger than this is dropped (the SDK keeps snapshots below it): it must fit an SQS message */
export const MAX_CHUNK_CHARS = 160_000;
const TRIGGER_TYPES = new Set<RecordingTriggerType>(['page', 'click', 'event', 'error']);
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_SETTINGS: RecordingSettings = { enabled: false, samplePercent: 10, triggers: [], maxPerHour: 100, maxPerDay: 1000, maskAllText: false };

interface SettingsRow {
  enabled: boolean; sample_percent: number; triggers: RecordingTrigger[] | string; max_per_hour: number | null; max_per_day: number | null;
  mask_text: boolean; updated_by: string; updated_at: Date;
}

const toSettings = (r: SettingsRow): RecordingSettings => ({
  enabled: r.enabled,
  samplePercent: Number(r.sample_percent),
  triggers: typeof r.triggers === 'string' ? JSON.parse(r.triggers) : r.triggers ?? [],
  maxPerHour: r.max_per_hour,
  maxPerDay: r.max_per_day,
  maskAllText: r.mask_text,
});

// ---------------------------------------------------------------- settings

/** Settings per project, cached per container for 30 s (read on every SDK config request and ingest batch). */
const cache = new Map<string, { s: RecordingSettings; exp: number }>();

export async function settingsOf(pid: string): Promise<RecordingSettings> {
  const hit = cache.get(pid);
  if (hit && hit.exp > Date.now()) return hit.s;
  const [row] = await query<SettingsRow>('SELECT * FROM recording_settings WHERE project_id = $1', [pid]);
  const s = row ? toSettings(row) : DEFAULT_SETTINGS;
  cache.set(pid, { s, exp: Date.now() + 30_000 });
  if (cache.size > 1000) cache.delete(cache.keys().next().value!);
  return s;
}

function limit(v: unknown, name: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_LIMIT) throw new HttpError(400, `${name} must be a whole number from 1 to ${MAX_LIMIT}, or empty for no limit`);
  return v;
}

export function validateSettings(body: Partial<RecordingSettings>): RecordingSettings {
  const b = body ?? {};
  if (typeof b.enabled !== 'boolean') throw new HttpError(400, '`enabled` must be true or false');
  const pct = b.samplePercent;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) throw new HttpError(400, 'The share of sessions must be from 0 to 100 %');
  if (!Array.isArray(b.triggers) || b.triggers.length > MAX_TRIGGERS) throw new HttpError(400, `At most ${MAX_TRIGGERS} triggers`);
  const triggers = b.triggers.map((t): RecordingTrigger => {
    const type = t?.type as RecordingTriggerType;
    const value = typeof t?.value === 'string' ? t.value.trim() : '';
    if (!TRIGGER_TYPES.has(type)) throw new HttpError(400, `Unknown trigger type: ${String(t?.type)}`);
    if (value.length > 300) throw new HttpError(400, 'A trigger value can be at most 300 characters');
    if (!value && type !== 'error') throw new HttpError(400, `A ${type} trigger needs a value`);
    return { type, value };
  });
  const maxPerHour = limit(b.maxPerHour, 'Recordings per hour');
  const maxPerDay = limit(b.maxPerDay, 'Recordings per day');
  return { enabled: b.enabled, samplePercent: Math.round(pct * 100) / 100, triggers, maxPerHour, maxPerDay, maskAllText: b.maskAllText === true };
}

async function usage(pid: string, now = Date.now()): Promise<{ lastHour: number; lastDay: number }> {
  const [r] = await query<{ hour: number; day: number }>(
    `SELECT COALESCE(SUM(CASE WHEN started_at >= $2 THEN 1 ELSE 0 END), 0)::int AS hour, count(*)::int AS day
       FROM recordings WHERE project_id = $1 AND started_at >= $3`,
    [pid, new Date(now - HOUR), new Date(now - DAY)],
  );
  return { lastHour: r?.hour ?? 0, lastDay: r?.day ?? 0 };
}

export async function recordingRetention(pid: string): Promise<number> {
  return Math.min(RECORDING_RETENTION_DAYS, await projectRetention(pid));
}

export async function getSettings(pid: string): Promise<RecordingSettingsResponse> {
  const [[row], use, retentionDays] = await Promise.all([
    query<SettingsRow>('SELECT * FROM recording_settings WHERE project_id = $1', [pid]),
    usage(pid),
    recordingRetention(pid),
  ]);
  return {
    settings: row ? toSettings(row) : DEFAULT_SETTINGS,
    usage: use,
    retentionDays,
    updatedAt: row?.updated_at.toISOString() ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

export async function saveSettings(pid: string, email: string, body: Partial<RecordingSettings>): Promise<RecordingSettingsResponse> {
  const s = validateSettings(body);
  await query(
    `INSERT INTO recording_settings (project_id, enabled, sample_percent, triggers, max_per_hour, max_per_day, mask_text, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (project_id) DO UPDATE SET enabled = EXCLUDED.enabled, sample_percent = EXCLUDED.sample_percent, triggers = EXCLUDED.triggers,
       max_per_hour = EXCLUDED.max_per_hour, max_per_day = EXCLUDED.max_per_day, mask_text = EXCLUDED.mask_text,
       updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [pid, s.enabled, s.samplePercent, JSON.stringify(s.triggers), s.maxPerHour, s.maxPerDay, s.maskAllText, email],
  );
  cache.delete(pid);
  return getSettings(pid);
}

// ---------------------------------------------------------------- the SDK's endpoints

/** Wire shape of GET /replay/config (sdk/src/types.ts ReplayConfig). */
export interface PublicConfig { on: boolean; rate?: number; trg?: RecordingTrigger[]; mask?: boolean }

export async function publicConfig(writeKey: string | undefined): Promise<PublicConfig> {
  const pid = await projectIdForWriteKey(writeKey);
  if (!pid) return { on: false };
  const s = await settingsOf(pid);
  if (!s.enabled || (s.samplePercent <= 0 && !s.triggers.length)) return { on: false };
  return { on: true, rate: s.samplePercent / 100, trg: s.triggers, mask: s.maskAllText };
}

const granted = new Map<string, number>();
const grantKey = (pid: string, sid: string) => `${pid}|${sid}`;
const remember = (pid: string, sid: string) => {
  granted.set(grantKey(pid, sid), Date.now() + 10 * 60_000);
  if (granted.size > 20_000) granted.delete(granted.keys().next().value!);
};

/**
 * Grants one session a recording slot when the project records and its limits allow another. A session that
 * already has one keeps it (every page of a recorded session asks again only after the tab's storage is gone).
 */
export async function startRecording(body: { k?: unknown; s?: unknown; a?: unknown; r?: unknown }, now = Date.now()): Promise<{ ok: boolean }> {
  const pid = await projectIdForWriteKey(typeof body?.k === 'string' ? body.k : undefined);
  const sid = typeof body?.s === 'string' ? body.s.slice(0, 64) : '';
  if (!pid || !sid) return { ok: false };
  const s = await settingsOf(pid);
  if (!s.enabled) return { ok: false };
  const [existing] = await query<{ n: number }>('SELECT 1 AS n FROM recordings WHERE project_id = $1 AND session_id = $2', [pid, sid]);
  if (existing) return { ok: true };
  if (s.maxPerHour !== null || s.maxPerDay !== null) {
    const u = await usage(pid, now);
    if ((s.maxPerHour !== null && u.lastHour >= s.maxPerHour) || (s.maxPerDay !== null && u.lastDay >= s.maxPerDay)) return { ok: false };
  }
  const reason = typeof body.r === 'string' && /^(sample|trigger:)/.test(body.r) ? body.r.slice(0, 200) : 'sample';
  await query(
    `INSERT INTO recordings (project_id, session_id, started_at, anon_id, reason) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id, session_id) DO NOTHING`,
    [pid, sid, new Date(now), typeof body.a === 'string' ? body.a.slice(0, 64) : null, reason],
  );
  remember(pid, sid);
  return { ok: true };
}

/** The sessions among `sids` that hold a recording slot. */
async function grantedSessions(pid: string, sids: string[]): Promise<Set<string>> {
  const now = Date.now();
  const out = new Set(sids.filter((s) => (granted.get(grantKey(pid, s)) ?? 0) > now));
  const ask = sids.filter((s) => !out.has(s));
  if (ask.length) {
    const rows = await query<{ session_id: string }>('SELECT session_id FROM recordings WHERE project_id = $1 AND session_id = ANY($2::text[])', [pid, ask]);
    for (const r of rows) { out.add(r.session_id); remember(pid, r.session_id); }
  }
  return out;
}

// ---------------------------------------------------------------- ingest

/** One row of the `replays` table. */
export interface ReplayRow {
  project_id: string;
  ts: Date;
  id: string;
  session_id: string;
  anon_id: string | null;
  page_id: string | null;
  seq: number;
  dur: number;
  url: string | null;
  data: string;
}

/** The `replay` events of an SDK batch as rows; malformed ones are dropped. Doesn't check slots. */
export function normalizeReplays(pid: string, batch: WireBatch, receivedAt = Date.now()): ReplayRow[] {
  if (!batch || !Array.isArray(batch.e)) return [];
  const skew = clockSkew(batch, receivedAt);
  const rows: ReplayRow[] = [];
  for (const e of batch.e as unknown as Array<Omit<WireBatch['e'][number], 't'> & { t: string }>) {
    if (!e || e.t !== 'replay' || typeof e.s !== 'string' || !e.s) continue;
    const d = (e.d ?? {}) as { p?: unknown; q?: unknown; dur?: unknown; r?: unknown };
    if (!Array.isArray(d.r) || !d.r.length) continue;
    const data = JSON.stringify(d.r);
    if (data.length > MAX_CHUNK_CHARS) continue;
    if (typeof e.id !== 'string' || !uuidRe.test(e.id)) continue;
    rows.push({
      project_id: pid,
      ts: new Date(eventTime(e.ts, skew, receivedAt)),
      id: e.id.toLowerCase(),
      session_id: e.s.slice(0, 64),
      anon_id: typeof batch.a === 'string' ? batch.a.slice(0, 64) : null,
      page_id: typeof d.p === 'string' ? d.p.slice(0, 64) : null,
      seq: Number.isInteger(d.q) ? (d.q as number) : 0,
      dur: typeof d.dur === 'number' && Number.isFinite(d.dur) ? Math.max(0, Math.round(d.dur)) : 0,
      url: typeof e.url === 'string' ? e.url.slice(0, 2048) : null,
      data,
    });
  }
  return rows;
}

/** Replay rows of a batch worth storing: the project records and the session holds a slot. */
export async function replayRows(pid: string, batch: WireBatch, receivedAt = Date.now()): Promise<ReplayRow[]> {
  if (!batch || !Array.isArray(batch.e) || !batch.e.some((e) => (e as { t?: string })?.t === 'replay')) return [];
  const rows = normalizeReplays(pid, batch, receivedAt);
  if (!rows.length || !(await settingsOf(pid)).enabled) return [];
  const ok = await grantedSessions(pid, [...new Set(rows.map((r) => r.session_id))]);
  return rows.filter((r) => ok.has(r.session_id));
}

// ---------------------------------------------------------------- reading

interface RecordingRow { session_id: string; started_at: Date; anon_id: string | null; reason: string }

/** Event and replay aggregates for the given sessions, over a window that covers them. */
async function summarize(pid: string, recs: RecordingRow[]): Promise<RecordingSummary[]> {
  if (!recs.length) return [];
  const starts = recs.map((r) => r.started_at.getTime());
  const w = { from: new Date(Math.min(...starts) - 10 * 60_000), to: new Date(Math.min(Date.now() + 60_000, Math.max(...starts) + DAY)) };
  const params: unknown[] = [pid, w.from, w.to];
  const ids = inList(params, recs.map((r) => r.session_id));
  const [replays, events] = await Promise.all([
    rawQuery<{ session_id: string; first: Date; last: Date }>(pid, w,
      `SELECT session_id, min(ts) AS first, max(ts + to_milliseconds(dur::BIGINT)) AS last
         FROM replays WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND session_id IN ${ids} GROUP BY session_id`, params),
    rawQuery<{ session_id: string; pages: number; clicks: number; errors: number; user_id: string | null; entry: string | null;
      browser: string | null; os: string | null; device: string | null; country: string | null; city: string | null }>(pid, w,
      `SELECT session_id,
              count(*) FILTER (WHERE type = 'pageview') AS pages,
              count(*) FILTER (WHERE type = 'click') AS clicks,
              count(*) FILTER (WHERE type IN ('error', 'http_error')) AS errors,
              max(user_id) AS user_id,
              arg_min(path, ts) FILTER (WHERE type = 'pageview') AS entry,
              any_value(browser) AS browser, any_value(os) AS os, any_value(device) AS device,
              any_value(country) AS country, any_value(city) AS city
         FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND session_id IN ${ids} GROUP BY session_id`, params),
  ]);
  const rep = new Map(replays.map((r) => [r.session_id, r]));
  const ev = new Map(events.map((r) => [r.session_id, r]));
  return recs.map((r): RecordingSummary => {
    const x = rep.get(r.session_id);
    const e = ev.get(r.session_id);
    const first = x ? new Date(x.first) : null;
    const last = x ? new Date(x.last) : null;
    return {
      sessionId: r.session_id,
      startedAt: (first && first < r.started_at ? first : r.started_at).toISOString(),
      endedAt: last?.toISOString() ?? null,
      durationMs: first && last ? Math.max(0, last.getTime() - first.getTime()) : 0,
      reason: r.reason,
      anonId: r.anon_id,
      userId: e?.user_id ?? null,
      entryPath: e?.entry ?? null,
      pages: e?.pages ?? 0,
      clicks: e?.clicks ?? 0,
      errors: e?.errors ?? 0,
      browser: e?.browser ?? null,
      os: e?.os ?? null,
      device: e?.device ?? null,
      country: e?.country ?? null,
      city: e?.city ?? null,
    };
  });
}

const date = (v: string | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Recordings that started in [from, to), newest first. Sessions that got a slot but never sent anything are left
 * out once they're a few minutes old (the visitor left before the first chunk).
 */
export async function listRecordings(pid: string, q: Record<string, string | undefined>): Promise<RecordingsResponse> {
  const to = date(q.before) ?? date(q.to) ?? new Date(Date.now() + 60_000);
  const from = date(q.from) ?? new Date(to.getTime() - 7 * DAY);
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const rows = await query<RecordingRow>(
    `SELECT session_id, started_at, anon_id, reason FROM recordings
      WHERE project_id = $1 AND started_at >= $2 AND started_at < $3 ORDER BY started_at DESC LIMIT $4`,
    [pid, from, to, limit],
  );
  const recent = Date.now() - 5 * 60_000;
  const recordings = (await summarize(pid, rows)).filter((r, i) => r.endedAt || rows[i].started_at.getTime() > recent);
  return { recordings, nextBefore: rows.length === limit ? rows[rows.length - 1].started_at.toISOString() : null };
}

/** Up to this many characters of chunk data per response; the dashboard asks for the rest with `after`. */
const PAGE_CHARS = 3_000_000;

export async function getRecording(pid: string, sid: string, q: Record<string, string | undefined>): Promise<RecordingResponse> {
  const [row] = await query<RecordingRow>('SELECT session_id, started_at, anon_id, reason FROM recordings WHERE project_id = $1 AND session_id = $2', [pid, sid]);
  if (!row) throw new HttpError(404, 'No recording of that session');
  // the recorder sends up to a minute from before the slot was granted (what led up to a trigger)
  const w = { from: new Date(row.started_at.getTime() - 10 * 60_000), to: new Date(Math.min(Date.now() + 60_000, row.started_at.getTime() + DAY)) };
  const params: unknown[] = [pid, w.from, w.to, sid];
  let cursor = '';
  const [afterTs, afterId] = (q.after ?? '').split('|');
  if (date(afterTs) && afterId) {
    params.push(date(afterTs), afterId);
    cursor = ' AND (ts > $5 OR (ts = $5 AND id > $6))';
  }
  const [summary] = await summarize(pid, [row]);
  const rows = await rawQuery<{ ts: Date; id: string; page_id: string | null; seq: number; dur: number; url: string | null; data: string }>(pid, w,
    `SELECT ts, id, page_id, seq, dur, url, data FROM replays
      WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND session_id = $4${cursor} ORDER BY ts, id LIMIT 500`, params);
  const chunks: RecordingChunk[] = [];
  let chars = 0;
  let last: (typeof rows)[number] | undefined;
  for (const r of rows) {
    if (chunks.length && chars + r.data.length > PAGE_CHARS) break;
    chars += r.data.length;
    last = r;
    let recs: unknown[][];
    try { recs = JSON.parse(r.data); } catch { continue; }
    chunks.push({ ts: new Date(r.ts).toISOString(), page: r.page_id ?? '', seq: r.seq, dur: r.dur, url: r.url, r: recs });
  }
  const more = last && (rows.length === 500 || last !== rows[rows.length - 1]);
  return { recording: summary, chunks, nextAfter: more ? `${new Date(last!.ts).toISOString()}|${last!.id}` : null };
}
