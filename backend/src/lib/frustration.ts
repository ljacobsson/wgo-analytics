import type { FrustrationRow, FrustrationSample, HeatmapResponse } from '../contract';
import { parseRange } from './analytics';
import { aliasMap } from './clickAliases';
import { query } from './db';
import { filtersFrom } from './filters';
import { HttpError } from './http';
import { inList, rawQuery } from './store/duck';

type Params = Record<string, string | undefined>;

/** Frustration signals per click target, and click heatmaps of a page. */

const ERROR_WINDOW_S = 2;
const MAX_RECORDED = 2000; // recorded sessions considered for samples / the heatmap snapshot
const MAX_POINTS = 5000;
export const BUCKET_PX = 8;
export const VW_STEP = 100;

export const limitOf = (v: string | undefined, def: number, max: number) => {
  const n = Number(v ?? def);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
};

/**
 * Device column values behind the heatmap's device switch: "mobile" covers phones and tablets (both are touch,
 * narrow-ish layouts), "desktop" is desktop only. Anything else is rejected.
 */
export function devicesFor(device: string | undefined): string[] {
  if (device === undefined || device === '' || device === 'desktop') return ['desktop'];
  if (device === 'mobile') return ['mobile', 'tablet'];
  throw new HttpError(400, 'device must be desktop or mobile');
}

export const bucketOf = (v: number, size = BUCKET_PX) => Math.floor(v / size) * size;

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).getTime();

/** Sessions with a recording that started around the range, newest first. */
async function recordedSessions(pid: string, from: Date, to: Date): Promise<string[]> {
  const rows = await query<{ session_id: string }>(
    'SELECT session_id FROM recordings WHERE project_id = $1 AND started_at >= $2 AND started_at < $3 ORDER BY started_at DESC LIMIT $4',
    [pid, new Date(from.getTime() - 24 * 3600_000), to, MAX_RECORDED],
  );
  return rows.map((r) => r.session_id);
}

export async function frustration(pid: string, p: Params): Promise<FrustrationRow[]> {
  const r = parseRange(p);
  const names = await aliasMap(pid);
  const limit = limitOf(p.limit, 50, 200);
  const params: unknown[] = [pid, r.from, r.to, new Date(r.to.getTime() + ERROR_WINDOW_S * 1000)];
  const F = filtersFrom(p, 'events', params);
  const merged = names.size ? `selector IN ${inList(params, [...names.keys()])}` : 'false';
  const gText = `CASE WHEN ${merged} THEN NULL ELSE element_text END`;
  const gName = `CASE WHEN ${merged} THEN NULL ELSE track_name END`;
  // errors are looked up per session and not narrowed by the filters (a selector filter would hide them)
  const base = `WITH clk AS (
      SELECT selector, element_text, track_name, element_tag, session_id, ts, props FROM events
       WHERE project_id = $1 AND type = 'click' AND ts >= $2 AND ts < $3 AND selector IS NOT NULL AND session_id IS NOT NULL${F}),
    errs AS (
      SELECT session_id, ts FROM events
       WHERE project_id = $1 AND type IN ('error', 'http_error') AND ts >= $2 AND ts < $4
         AND session_id IN (SELECT session_id FROM clk)),
    f AS (
      SELECT c.*,
             COALESCE(TRY_CAST(json_extract_string(c.props, '$.rage') AS DOUBLE), 0) >= 3 AS is_rage,
             COALESCE(json_extract_string(c.props, '$.dead') = '1', false) AS is_dead,
             EXISTS (SELECT 1 FROM errs e WHERE e.session_id = c.session_id AND e.ts >= c.ts AND e.ts <= c.ts + INTERVAL ${ERROR_WINDOW_S} SECOND) AS is_err
        FROM clk c)`;
  const win = { from: r.from, to: new Date(r.to.getTime() + ERROR_WINDOW_S * 1000) };
  const limitIdx = params.push(limit);
  type Row = {
    selector: string; element_text: string | null; track_name: string | null; element_tag: string | null; clicks: number;
    rage: number; rage_s: number; dead: number; dead_s: number; err: number; err_s: number;
  };
  const rows = await rawQuery<Row>(pid, win,
    `${base}
     SELECT selector,
            CASE WHEN count(DISTINCT element_text) > 1 THEN NULL ELSE max(element_text) END AS element_text,
            CASE WHEN count(DISTINCT track_name) > 1 THEN NULL ELSE max(track_name) END AS track_name,
            max(element_tag) AS element_tag, count(*)::int AS clicks,
            count(*) FILTER (WHERE is_rage)::int AS rage, count(DISTINCT session_id) FILTER (WHERE is_rage)::int AS rage_s,
            count(*) FILTER (WHERE is_dead)::int AS dead, count(DISTINCT session_id) FILTER (WHERE is_dead)::int AS dead_s,
            count(*) FILTER (WHERE is_err)::int AS err, count(DISTINCT session_id) FILTER (WHERE is_err)::int AS err_s
       FROM f
      GROUP BY selector, ${gText}, ${gName}
     HAVING count(*) FILTER (WHERE is_rage OR is_dead OR is_err) > 0
      ORDER BY (rage + dead + err) DESC, clicks DESC LIMIT $${limitIdx}`,
    params,
  );
  if (!rows.length) return [];

  // up to 3 recorded sessions per target (same grouping as above)
  const samples = new Map<string, FrustrationSample[]>();
  const recorded = await recordedSessions(pid, r.from, r.to);
  if (recorded.length) {
    const sp = [...params.slice(0, limitIdx - 1)];
    const idList = inList(sp, recorded);
    const key = (s: string, t: string | null, n: string | null) => JSON.stringify([s, t, n]);
    const hits = await rawQuery<{ selector: string; gt: string | null; gn: string | null; session_id: string; at: Date }>(pid, win,
      `${base}
       SELECT selector, ${gText} AS gt, ${gName} AS gn, session_id, max(ts) AS at FROM f
        WHERE (is_rage OR is_dead OR is_err) AND session_id IN ${idList}
        GROUP BY selector, ${gText}, ${gName}, session_id
       QUALIFY row_number() OVER (PARTITION BY selector, ${gText}, ${gName} ORDER BY max(ts) DESC) <= 3`,
      sp,
    );
    for (const h of hits) {
      const k = key(h.selector, h.gt, h.gn);
      const list = samples.get(k) ?? [];
      list.push({ sessionId: h.session_id, at: iso(h.at) });
      samples.set(k, list);
    }
    for (const list of samples.values()) list.sort((a, b) => b.at - a.at);
    return rows.map((x) => build(x, names, samples.get(key(x.selector, namesHas(names, x.selector) ? null : x.element_text, namesHas(names, x.selector) ? null : x.track_name)) ?? []));
  }
  return rows.map((x) => build(x, names, []));
}

const namesHas = (names: Map<string, string>, s: string) => names.has(s);

function build(x: { selector: string; element_text: string | null; track_name: string | null; element_tag: string | null; clicks: number; rage: number; rage_s: number; dead: number; dead_s: number; err: number; err_s: number }, names: Map<string, string>, samples: FrustrationSample[]): FrustrationRow {
  return {
    selector: x.selector, elementText: x.element_text, trackName: x.track_name, elementTag: x.element_tag, alias: names.get(x.selector) ?? null,
    clicks: x.clicks, rageClicks: x.rage, rageSessions: x.rage_s, deadClicks: x.dead, deadSessions: x.dead_s, errorClicks: x.err, errorSessions: x.err_s, samples,
  };
}

export async function heatmap(pid: string, p: Params): Promise<HeatmapResponse> {
  const path = p.path;
  if (!path) throw new HttpError(400, '`path` is required');
  const r = parseRange(p);
  const devices = devicesFor(p.device);
  const params: unknown[] = [pid, r.from, r.to, path];
  const dev = inList(params, devices);
  const F = filtersFrom(p, 'events', params);
  const vwOf = `round(TRY_CAST(json_extract_string(props, '$.vw') AS DOUBLE) / ${VW_STEP}) * ${VW_STEP}`;
  const where = `project_id = $1 AND type = 'click' AND ts >= $2 AND ts < $3 AND path = $4 AND device IN ${dev}${F}
        AND TRY_CAST(json_extract_string(props, '$.x') AS DOUBLE) IS NOT NULL AND TRY_CAST(json_extract_string(props, '$.y') AS DOUBLE) IS NOT NULL
        AND TRY_CAST(json_extract_string(props, '$.vw') AS DOUBLE) > 0`;
  const [modal] = await rawQuery<{ b: number; vw: number }>(pid, r,
    `SELECT ${vwOf} AS b, round(median(TRY_CAST(json_extract_string(props, '$.vw') AS DOUBLE)))::int AS vw FROM events WHERE ${where} GROUP BY 1 ORDER BY count(*) DESC, b DESC LIMIT 1`,
    params,
  );
  if (!modal) return { vw: 0, points: [], total: 0, snapshot: await snapshotFor(pid, r, path, devices, p) };
  const pp = [...params, modal.b, MAX_POINTS];
  const bx = `CAST(floor(TRY_CAST(json_extract_string(props, '$.x') AS DOUBLE) / ${BUCKET_PX}) AS INTEGER) * ${BUCKET_PX}`;
  const by = `CAST(floor(TRY_CAST(json_extract_string(props, '$.y') AS DOUBLE) / ${BUCKET_PX}) AS INTEGER) * ${BUCKET_PX}`;
  const pts = await rawQuery<{ x: number; y: number; n: number; total: number }>(pid, r,
    `SELECT ${bx} AS x, ${by} AS y, count(*)::int AS n, (sum(count(*)) OVER ())::int AS total FROM events
      WHERE ${where} AND ${vwOf} = $${params.length + 1}
      GROUP BY 1, 2 HAVING x >= 0 AND y >= 0 ORDER BY n DESC, y, x LIMIT $${params.length + 2}`,
    pp,
  );
  return {
    vw: modal.vw,
    points: pts.map(({ x, y, n }) => ({ x, y, n })),
    total: pts[0]?.total ?? 0,
    snapshot: await snapshotFor(pid, r, path, devices, p),
  };
}

/** The newest recorded session of this device type that viewed `path` in the range. */
async function snapshotFor(pid: string, r: { from: Date; to: Date }, path: string, devices: string[], p: Params): Promise<{ sessionId: string; at: number } | null> {
  const recorded = await recordedSessions(pid, r.from, r.to);
  if (!recorded.length) return null;
  const params: unknown[] = [pid, r.from, r.to, path];
  const dev = inList(params, devices);
  const ids = inList(params, recorded);
  const [row] = await rawQuery<{ session_id: string; ts: Date }>(pid, r,
    `SELECT session_id, ts FROM events
      WHERE project_id = $1 AND type = 'pageview' AND ts >= $2 AND ts < $3 AND path = $4 AND device IN ${dev} AND session_id IN ${ids}
      ORDER BY ts DESC LIMIT 1`,
    params,
  );
  void p;
  return row ? { sessionId: row.session_id, at: iso(row.ts) } : null;
}
