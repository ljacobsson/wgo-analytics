import type { RecordingSummary } from '../contract';
import { aliasMap } from './clickAliases';
import { query } from './db';
import { HttpError } from './http';
import { matchesFilters, parseFilters, recordingsWindow, summarize, type RecordingRow } from './recordings';
import { inList, rawQuery } from './store/duck';

/**
 * Finds session recordings by what the visitor did (and didn't do): "hovered the buy button but never clicked
 * it", "saw /pricing, then hit an error", "rage-clicked and never reached /thank-you".
 *
 * Clicks, pageviews, custom events and errors come from the `events` table; hovers only exist in recordings,
 * as `[7, t, selector, ms, text?, name?]` records in the `replays` chunks (sdk/src/replay/recorder.ts).
 * Every condition is checked over the recording's window (see recordingsWindow), not the whole visit.
 */

const DAY = 86_400_000;
export type BehaviorAction = 'hover' | 'click' | 'rage_click' | 'pageview' | 'event' | 'error';
export const BEHAVIOR_ACTIONS: BehaviorAction[] = ['hover', 'click', 'rage_click', 'pageview', 'event', 'error'];

export interface Behavior {
  action: BehaviorAction;
  /**
   * hover, click, rage_click: case-insensitive substring of the element's selector, label, tracked name
   * (data-track) or click alias. pageview: path, `*` as wildcard (`/checkout*`) or else a substring. event: custom
   * event name substring. error: substring of the error message or the failed request's URL. Empty: any.
   */
  target?: string;
  /** hover only: lasted at least this many milliseconds (recorded hovers last 300 ms or more) */
  minMs?: number;
  /** hover only: the visitor never clicked the hovered element during the recording */
  notClicked?: boolean;
}

export interface Moment {
  action: BehaviorAction;
  /** when it first happened */
  at: string;
  /** milliseconds into the recording; negative when it happened before the recording's first frame */
  offsetMs: number;
  /** the element: its alias, tracked name, label or selector */
  element?: string;
  selector?: string;
  path?: string | null;
  /** the error message, failed request or event name */
  detail?: string | null;
  /** how long the hover lasted */
  hoverMs?: number;
}

export interface FoundRecording extends RecordingSummary {
  /** the first match of each `did` condition, in the order given */
  moments: Moment[];
}

export interface RecordingSearch {
  did?: Behavior[];
  didNot?: Behavior[];
  /** ISO-8601 window of recording start times (default: the 7 days before `to`) */
  from?: string;
  to?: string;
  /** pagination cursor: nextBefore of the previous page */
  before?: string;
  limit?: number;
  /** the list filters of the dashboard (parseFilters): minDuration, maxDuration, device, identified, ... */
  filters?: Record<string, string | undefined>;
}

export interface RecordingSearchResult {
  recordings: FoundRecording[];
  /** recordings looked at */
  scanned: number;
  /** more recordings to look at: pass as `before` */
  nextBefore: string | null;
}

const MAX_CONDITIONS = 5;
const MAX_SCAN = 1000;
const SCAN_BATCH = 200;

function validate(b: Behavior, negated: boolean): Behavior {
  if (!b || !BEHAVIOR_ACTIONS.includes(b.action)) throw new HttpError(400, `Unknown action: ${String(b?.action)}`);
  const target = typeof b.target === 'string' ? b.target.trim() : '';
  if (target.length > 200) throw new HttpError(400, 'A target can be at most 200 characters');
  if (b.action !== 'hover' && (b.minMs !== undefined || b.notClicked)) throw new HttpError(400, '`minMs` and `notClicked` only apply to hovers');
  if (negated && b.notClicked) throw new HttpError(400, '`notClicked` only applies to a `did` hover');
  if (b.minMs !== undefined && (!Number.isFinite(b.minMs) || b.minMs < 0)) throw new HttpError(400, '`minMs` must be 0 or more');
  return { action: b.action, target: target || undefined, minMs: b.minMs, notClicked: b.notClicked === true };
}

const date = (v: string | undefined, name: string): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `Invalid \`${name}\``);
  return d;
};

// ---------------------------------------------------------------- SQL pieces

/** `x` matches when one of the columns contains the target, or the selector has an alias that does. */
function elementCond(params: unknown[], target: string | undefined, cols: { sel: string; text: string; name: string }, aliases: Map<string, string>): string {
  if (!target) return 'TRUE';
  const t = target.toLowerCase();
  const i = `$${params.push(t)}`;
  const parts = [cols.sel, cols.text, cols.name].map((c) => `coalesce(contains(lower(${c}), ${i}), false)`);
  const aliased = [...aliases].filter(([, a]) => a.toLowerCase().includes(t)).map(([s]) => s);
  if (aliased.length) parts.push(`coalesce(${cols.sel} IN ${inList(params, aliased)}, false)`);
  return `(${parts.join(' OR ')})`;
}

/** `/checkout*` → ILIKE '/checkout%'; without `*`, a substring. */
function pathCond(params: unknown[], target: string | undefined): string {
  if (!target) return 'TRUE';
  if (!target.includes('*')) return `coalesce(contains(lower(path), $${params.push(target.toLowerCase())}), false)`;
  const like = target.replace(/[\\%_]/g, (c) => '\\' + c).replace(/\*/g, '%');
  return `coalesce(path ILIKE $${params.push(like)} ESCAPE '\\', false)`;
}

function textCond(params: unknown[], target: string | undefined, cols: string[]): string {
  if (!target) return 'TRUE';
  const i = `$${params.push(target.toLowerCase())}`;
  return `(${cols.map((c) => `coalesce(contains(lower(${c}), ${i}), false)`).join(' OR ')})`;
}

const label = (sel: string | null, text: string | null, name: string | null, aliases: Map<string, string>) =>
  (sel && aliases.get(sel)) || name || text || sel || undefined;

type Window = { from: Date; to: Date };
type Found = Map<string, Omit<Moment, 'offsetMs'>>;

// ---------------------------------------------------------------- conditions

/** Sessions among `sids` with an event matching `b`, with the first match. */
async function eventMatches(pid: string, w: Window, sids: string[], b: Behavior, aliases: Map<string, string>): Promise<Found> {
  const params: unknown[] = [pid, w.from, w.to];
  const ids = inList(params, sids);
  const el = { sel: 'selector', text: 'element_text', name: 'track_name' };
  // functions: only the chosen condition may push its params
  const cond = {
    click: () => `type = 'click' AND ${elementCond(params, b.target, el, aliases)}`,
    rage_click: () => `type = 'click' AND TRY_CAST(json_extract_string(props, '$.rage') AS INTEGER) >= 3 AND ${elementCond(params, b.target, el, aliases)}`,
    pageview: () => `type = 'pageview' AND ${pathCond(params, b.target)}`,
    event: () => `type = 'custom' AND ${textCond(params, b.target, ['name'])}`,
    error: () => `type IN ('error', 'http_error') AND ${textCond(params, b.target, ['error_message', 'http_url', 'http_route'])}`,
  }[b.action as Exclude<BehaviorAction, 'hover'>]();
  const rows = await rawQuery<{ session_id: string; ts: Date; selector: string | null; element_text: string | null; track_name: string | null; path: string | null; detail: string | null }>(pid, w,
    `SELECT session_id, ts, selector, element_text, track_name, path,
            coalesce(name, error_message, CASE WHEN http_status IS NOT NULL THEN concat(http_method, ' ', coalesce(http_route, http_url), ' → ', http_status) END) AS detail
       FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND session_id IN ${ids} AND ${cond}
     QUALIFY row_number() OVER (PARTITION BY session_id ORDER BY ts) = 1`, params);
  const isElement = b.action === 'click' || b.action === 'rage_click';
  return new Map(rows.map((r) => [r.session_id, {
    action: b.action,
    at: new Date(r.ts).toISOString(),
    path: r.path,
    ...(isElement ? { element: label(r.selector, r.element_text, r.track_name, aliases), selector: r.selector ?? undefined } : {}),
    ...(r.detail && !isElement ? { detail: r.detail } : {}),
  }]));
}

/** Sessions among `sids` whose recording has a hover matching `b`, with the first one (that was never clicked). */
async function hoverMatches(pid: string, w: Window, sids: string[], b: Behavior, aliases: Map<string, string>): Promise<Found> {
  const params: unknown[] = [pid, w.from, w.to];
  const ids = inList(params, sids);
  const minMs = `$${params.push(Math.round(b.minMs ?? 0))}`;
  const cond = elementCond(params, b.target, { sel: 'selector', text: 'txt', name: 'nm' }, aliases);
  const rows = await rawQuery<{ session_id: string; selector: string; first: Date; ms: number; txt: string | null; nm: string | null }>(pid, w,
    `SELECT session_id, selector, min(started) AS first, max(ms) AS ms, any_value(txt) AS txt, any_value(nm) AS nm FROM (
       SELECT session_id, r->>2 AS selector, TRY_CAST(r->>3 AS BIGINT) AS ms, r->>4 AS txt, r->>5 AS nm,
              ts + to_milliseconds(TRY_CAST(r->>1 AS BIGINT) - TRY_CAST(r->>3 AS BIGINT)) AS started
         FROM (SELECT session_id, ts, unnest(from_json(data, '["JSON"]')) AS r FROM replays
                WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND session_id IN ${ids} AND contains(data, '[7,'))
        WHERE r->>0 = '7'
     ) WHERE selector IS NOT NULL AND ms >= ${minMs} AND ${cond}
     GROUP BY session_id, selector`, params);

  let hovers = rows;
  if (b.notClicked && rows.length) {
    const cp: unknown[] = [pid, w.from, w.to];
    const clicked = await rawQuery<{ session_id: string; selector: string }>(pid, w,
      `SELECT DISTINCT session_id, selector FROM events
        WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND type = 'click'
          AND session_id IN ${inList(cp, [...new Set(rows.map((r) => r.session_id))])} AND selector IN ${inList(cp, [...new Set(rows.map((r) => r.selector))])}`, cp);
    const done = new Set(clicked.map((c) => `${c.session_id}\u0000${c.selector}`));
    hovers = rows.filter((r) => !done.has(`${r.session_id}\u0000${r.selector}`));
  }

  const out: Found = new Map();
  for (const r of hovers.sort((a, z) => new Date(a.first).getTime() - new Date(z.first).getTime())) {
    if (out.has(r.session_id)) continue;
    out.set(r.session_id, {
      action: 'hover', at: new Date(r.first).toISOString(), element: label(r.selector, r.txt, r.nm, aliases), selector: r.selector, hoverMs: r.ms,
    });
  }
  return out;
}

const matches = (pid: string, w: Window, sids: string[], b: Behavior, aliases: Map<string, string>) =>
  (b.action === 'hover' ? hoverMatches : eventMatches)(pid, w, sids, b, aliases);

// ---------------------------------------------------------------- search

/**
 * Recordings that started in [from, to), newest first, where every `did` condition happened and no `didNot`
 * condition did, that also pass the list filters. Like listRecordings, looks at up to MAX_SCAN recordings per
 * call; `nextBefore` continues from the last one looked at.
 */
export async function findRecordings(pid: string, s: RecordingSearch): Promise<RecordingSearchResult> {
  const did = (s.did ?? []).map((b) => validate(b, false));
  const didNot = (s.didNot ?? []).map((b) => validate(b, true));
  if (did.length > MAX_CONDITIONS || didNot.length > MAX_CONDITIONS) throw new HttpError(400, `At most ${MAX_CONDITIONS} conditions of each kind`);
  const to = date(s.before, 'before') ?? date(s.to, 'to') ?? new Date(Date.now() + 60_000);
  const from = date(s.from, 'from') ?? new Date(to.getTime() - 7 * DAY);
  const limit = Math.min(Math.max(Math.floor(s.limit ?? 20), 1), 100);
  const filters = parseFilters(s.filters ?? {});
  const aliases = did.length || didNot.length ? await aliasMap(pid) : new Map<string, string>();
  // event conditions first: they're cheaper than reading recordings and leave fewer sessions for the hovers
  const order = did.map((b, i) => ({ b, i })).sort((x, y) => Number(x.b.action === 'hover') - Number(y.b.action === 'hover'));

  const recordings: FoundRecording[] = [];
  let before = to;
  let scanned = 0;
  let more = true;
  while (recordings.length < limit && more && scanned < MAX_SCAN) {
    const rows = await query<RecordingRow>(
      `SELECT session_id, started_at, anon_id, reason FROM recordings
        WHERE project_id = $1 AND started_at >= $2 AND started_at < $3 ORDER BY started_at DESC LIMIT $4`,
      [pid, from, before, SCAN_BATCH],
    );
    more = rows.length === SCAN_BATCH;
    if (!rows.length) break;
    const w = recordingsWindow(rows);

    let cand = rows.map((r) => r.session_id);
    const moments = new Map<string, Array<Omit<Moment, 'offsetMs'>>>(cand.map((sid) => [sid, new Array(did.length)]));
    for (const { b, i } of order) {
      if (!cand.length) break;
      const m = await matches(pid, w, cand, b, aliases);
      cand = cand.filter((sid) => m.has(sid));
      for (const sid of cand) moments.get(sid)![i] = m.get(sid)!;
    }
    for (const b of didNot) {
      if (!cand.length) break;
      const m = await matches(pid, w, cand, b, aliases);
      cand = cand.filter((sid) => !m.has(sid));
    }

    const keep = new Set(cand);
    const summaries = new Map((await summarize(pid, rows.filter((r) => keep.has(r.session_id)))).map((r) => [r.sessionId, r]));
    for (const [i, row] of rows.entries()) {
      scanned++;
      before = row.started_at;
      const r = summaries.get(row.session_id);
      if (r && matchesFilters(r, filters)) {
        // the player's timeline starts at the first frame (matchesFilters made sure there is one)
        const start = new Date(r.endedAt!).getTime() - r.durationMs;
        recordings.push({ ...r, moments: moments.get(r.sessionId)!.map((m) => ({ ...m, offsetMs: new Date(m.at).getTime() - start })) });
      }
      if (recordings.length === limit) { more = more || i < rows.length - 1; break; }
    }
  }
  return { recordings, scanned, nextBefore: more ? before.toISOString() : null };
}
