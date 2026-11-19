import type { Filter, ReleaseHealth, ReleaseMarker, ReleasesResponse, ServiceVersionHealth, Verdict } from '../contract';
import { parseRange } from './analytics';
import { buildInsert, query } from './db';
import type { EventRow } from './events';
import { filtersFrom, jsonPath } from './filters';
import { wilson } from './funnel';
import { listGoals, matchedEvents } from './goals';
import type { SpanRow } from './otlp/normalize';
import { inList, rawQuery } from './store/duck';

/**
 * Releases: the versions a project runs, with when each was first seen, and how healthy each one is compared with
 * the one before it. Web versions come from the SDK's `release` option (props.$ctx.release on every event),
 * service versions from OpenTelemetry's `service.version` resource attribute.
 *
 * First and last seen are kept in DSQL (`releases`), updated from the ingest paths at most every few minutes per
 * version and container: deploy markers then don't depend on the range shown, and outlive raw data.
 */

export type ReleaseKind = 'web' | 'service';
export interface Seen { project_id: string; kind: ReleaseKind; service: string; version: string; ts: Date }

const MAX_VERSION = 100;
const REFRESH_MS = 10 * 60_000;
const fresh = new Map<string, number>();

/** SQL for an event's web release (`props.$ctx.release`). */
export const RELEASE_SQL = `json_extract_string(props, '${jsonPath(['$ctx', 'release'])}')`;
/** SQL for a span's service version. */
const VERSION_SQL = `json_extract_string(resource, '${jsonPath(['service.version'])}')`;

const versionOf = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s && s.length <= MAX_VERSION ? s : null;
};

export function seenInEvents(rows: EventRow[]): Seen[] {
  const out: Seen[] = [];
  for (const r of rows) {
    if (r.bot) continue;
    const v = versionOf((r.props?.$ctx as Record<string, unknown> | undefined)?.release);
    if (v) out.push({ project_id: r.project_id, kind: 'web', service: '', version: v, ts: r.ts });
  }
  return out;
}

export function seenInSpans(rows: SpanRow[]): Seen[] {
  const out: Seen[] = [];
  for (const r of rows) {
    const v = versionOf(r.resource?.['service.version']);
    if (v) out.push({ project_id: r.project_id, kind: 'service', service: r.service, version: v, ts: r.start_time });
  }
  return out;
}

/**
 * Upsert first/last seen of the versions in a batch. Each version is written at most every REFRESH_MS per
 * container (last seen is coarse on purpose). Never throws: releases are a nice-to-have on the ingest path.
 */
export async function recordReleases(seen: Seen[], now = Date.now()): Promise<void> {
  if (!seen.length) return;
  const by = new Map<string, { s: Seen; first: number; last: number }>();
  for (const s of seen) {
    const k = `${s.project_id}|${s.kind}|${s.service}|${s.version}`;
    if ((fresh.get(k) ?? 0) > now) continue;
    const t = s.ts.getTime();
    const cur = by.get(k);
    if (cur) { cur.first = Math.min(cur.first, t); cur.last = Math.max(cur.last, t); } else by.set(k, { s, first: t, last: t });
  }
  if (!by.size) return;
  const rows = [...by.values()].map(({ s, first, last }) => [s.project_id, s.kind, s.service, s.version, new Date(first), new Date(last)]);
  try {
    const { sql, params } = buildInsert('releases', ['project_id', 'kind', 'service', 'version', 'first_seen', 'last_seen'], rows, {},
      `ON CONFLICT (project_id, kind, service, version) DO UPDATE SET
         first_seen = LEAST(releases.first_seen, EXCLUDED.first_seen), last_seen = GREATEST(releases.last_seen, EXCLUDED.last_seen)`);
    await query(sql, params);
    for (const k of by.keys()) fresh.set(k, now + REFRESH_MS);
    if (fresh.size > 5000) for (const [k, exp] of fresh) if (exp <= now) fresh.delete(k);
  } catch (err) {
    console.warn('recording releases failed', err); // retried with the next batch
  }
}
export const forgetReleaseCache = () => fresh.clear();

interface ReleaseRow { kind: ReleaseKind; service: string; version: string; first_seen: Date; last_seen: Date }

/** Versions first seen in [from, to) (deploys), oldest first. */
export async function releaseMarkers(pid: string, from: Date, to: Date): Promise<ReleaseMarker[]> {
  const rows = await query<ReleaseRow>(
    'SELECT kind, service, version, first_seen, last_seen FROM releases WHERE project_id = $1 AND first_seen >= $2 AND first_seen < $3 ORDER BY first_seen LIMIT 200',
    [pid, from, to],
  );
  return rows.map((r) => ({ kind: r.kind, service: r.service, version: r.version, firstSeen: r.first_seen.toISOString() }));
}

/** The latest version of each kind/service first seen in [from, to], e.g. the deploy right before a change. */
export async function releasesBetween(pid: string, from: Date, to: Date): Promise<ReleaseMarker[]> {
  return (await releaseMarkers(pid, from, to)).reverse();
}

// ---------------------------------------------------------------- comparison

/** A rate where lower is better (errors): worse when the 95% intervals don't overlap upwards. */
export function rateVerdict(cur: [number, number], prev: [number, number], higherIsBetter = false): Verdict {
  const [cc, cn] = cur, [pc, pn] = prev;
  if (cn < 20 || pn < 20) return null;
  const [cl, ch] = wilson(cc, cn), [pl, ph] = wilson(pc, pn);
  const up = cl > ph, down = ch < pl;
  if (!up && !down) return null;
  return up === higherIsBetter ? 'better' : 'worse';
}

/** A p75 timing or score (lower is better): a 10% change with at least 50 samples on both sides. */
export function p75Verdict(cur: number | null, prev: number | null, curN: number, prevN: number): Verdict {
  if (cur == null || prev == null || curN < 50 || prevN < 50 || prev <= 0) return null;
  if (cur > prev * 1.1) return 'worse';
  if (cur < prev / 1.1) return 'better';
  return null;
}

// ---------------------------------------------------------------- GET /releases

type Q = Record<string, string | undefined>;
const MAX_RELEASES = 20;
const NEW_ERRORS = 5;

/** Each item's predecessor: the one with the latest firstSeen before it in the same group. */
function predecessors<T extends { firstSeen: string }>(list: T[], group: (x: T) => string): Map<T, T> {
  const out = new Map<T, T>();
  const by = new Map<string, T[]>();
  for (const x of list) (by.get(group(x)) ?? by.set(group(x), []).get(group(x))!).push(x);
  for (const g of by.values()) {
    g.sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen));
    for (let i = 1; i < g.length; i++) out.set(g[i], g[i - 1]);
  }
  return out;
}

export async function releases(pid: string, p: Q): Promise<ReleasesResponse> {
  const r = parseRange(p, 7 * 86_400_000);
  // charts only need the deploy markers: skip the health queries
  if (p.markers === '1') return { web: [], services: [], markers: await releaseMarkers(pid, r.from, r.to) };
  const [known, web, services, markers] = await Promise.all([
    query<ReleaseRow>('SELECT kind, service, version, first_seen, last_seen FROM releases WHERE project_id = $1 AND last_seen >= $2', [pid, new Date(r.from.getTime() - 3600_000)]),
    webReleases(pid, r, p),
    serviceVersions(pid, r, p),
    releaseMarkers(pid, r.from, r.to),
  ]);
  const seen = new Map(known.map((k) => [`${k.kind}|${k.service}|${k.version}`, k]));
  // stored first/last seen win over the range's own (which start at `from` for a version older than the range)
  for (const w of web) {
    const k = seen.get(`web||${w.version}`);
    if (k) { w.firstSeen = k.first_seen.toISOString(); w.lastSeen = new Date(Math.max(k.last_seen.getTime(), Date.parse(w.lastSeen))).toISOString(); }
  }
  for (const s of services) {
    const k = seen.get(`service|${s.service}|${s.version}`);
    if (k) { s.firstSeen = k.first_seen.toISOString(); s.lastSeen = new Date(Math.max(k.last_seen.getTime(), Date.parse(s.lastSeen))).toISOString(); }
  }

  const webPrev = predecessors(web, () => '');
  for (const w of web) {
    const prev = webPrev.get(w);
    if (!prev) continue;
    w.previous = prev.version;
    w.verdicts.errorSessions = rateVerdict([w.errorSessions, w.sessions], [prev.errorSessions, prev.sessions]);
    w.verdicts.failedRequestSessions = rateVerdict([w.failedRequestSessions, w.sessions], [prev.failedRequestSessions, prev.sessions]);
    for (const k of ['lcp', 'inp', 'cls'] as const) w.verdicts[k] = p75Verdict(w.vitals[k], prev.vitals[k], w.vitals.samples, prev.vitals.samples);
    for (const g of w.goals) {
      const pg = prev.goals.find((x) => x.id === g.id);
      if (pg) w.verdicts[`goal:${g.id}`] = rateVerdict([g.converted, w.sessions], [pg.converted, prev.sessions], true);
    }
    // an error group is new when it never happened under the release before (and this one was deployed in the range)
    if (Date.parse(w.firstSeen) < r.from.getTime()) w.newErrors = [];
  }
  const svcPrev = predecessors(services, (s) => s.service);
  for (const s of services) {
    const prev = svcPrev.get(s);
    if (!prev) continue;
    s.previous = prev.version;
    s.verdicts.errorRate = rateVerdict([s.errors, s.spans], [prev.errors, prev.spans]);
    s.verdicts.p95 = p75Verdict(s.p95Ms, prev.p95Ms, s.spans, prev.spans);
  }
  const newest = (a: { firstSeen: string }, b: { firstSeen: string }) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen);
  return {
    web: web.sort(newest).slice(0, MAX_RELEASES),
    services: services.sort((a, b) => a.service.localeCompare(b.service) || newest(a, b)),
    markers,
  };
}

async function webReleases(pid: string, r: { from: Date; to: Date }, p: Q): Promise<ReleaseHealth[]> {
  const params: unknown[] = [pid, r.from, r.to];
  const F = filtersFrom(p, 'events', params);
  const rows = await rawQuery<{ rel: string; sessions: number; err: number; fail: number; errors: number; first: Date; last: Date }>(pid, r,
    `WITH s AS (
       SELECT session_id, max(${RELEASE_SQL}) AS rel, min(ts) AS first, max(ts) AS last,
              max(CASE WHEN type = 'error' THEN 1 ELSE 0 END) AS err,
              max(CASE WHEN type = 'http_error' AND (http_status >= 500 OR http_status = 0) THEN 1 ELSE 0 END) AS fail,
              sum(CASE WHEN type = 'error' THEN COALESCE(TRY_CAST(json_extract_string(props, '$.count') AS INTEGER), 1) ELSE 0 END) AS errors
         FROM events WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND session_id IS NOT NULL${F}
        GROUP BY session_id)
     SELECT rel, count(*)::int AS sessions, sum(err)::int AS err, sum(fail)::int AS fail, sum(errors)::int AS errors, min(first) AS first, max(last) AS last
       FROM s WHERE rel IS NOT NULL GROUP BY rel ORDER BY max(last) DESC LIMIT ${MAX_RELEASES * 2}`,
    params,
  );
  if (!rows.length) return [];
  const versions = rows.map((x) => x.rel);

  const vParams: unknown[] = [pid, r.from, r.to];
  const VF = filtersFrom(p, 'events', vParams);
  const pct = (k: string) => `percentile_cont(0.75) WITHIN GROUP (ORDER BY TRY_CAST(json_extract_string(props, '$.${k}') AS DOUBLE)) AS ${k}`;
  const vitals = rawQuery<{ rel: string; samples: number; lcp: number | null; inp: number | null; cls: number | null }>(pid, r,
    `SELECT ${RELEASE_SQL} AS rel, count(*)::int AS samples, ${['lcp', 'inp', 'cls'].map(pct).join(', ')}
       FROM events WHERE project_id = $1 AND type = 'vitals' AND ts >= $2 AND ts < $3${VF} AND ${RELEASE_SQL} IN ${inList(vParams, versions)}
      GROUP BY 1`,
    vParams,
  );

  // error groups, each with the release it first happened under in the range
  const eParams: unknown[] = [pid, r.from, r.to];
  const EF = filtersFrom(p, 'events', eParams);
  const errs = rawQuery<{ fingerprint: string; rel: string | null; message: string; count: number }>(pid, r,
    `SELECT fingerprint, arg_min(${RELEASE_SQL}, ts) AS rel, max(error_message) AS message,
            sum(COALESCE(TRY_CAST(json_extract_string(props, '$.count') AS INTEGER), 1))::int AS count
       FROM events WHERE project_id = $1 AND type = 'error' AND ts >= $2 AND ts < $3 AND fingerprint IS NOT NULL${EF}
      GROUP BY fingerprint`,
    eParams,
  );

  const goals = await listGoals(pid);
  const gParams: unknown[] = [pid, r.from, r.to];
  const conv = goals.length
    ? rawQuery<{ i: number; rel: string; n: number }>(pid, r,
        `SELECT goal.i AS i, ${RELEASE_SQL} AS rel, count(DISTINCT session_id)::int AS n
           ${matchedEvents(goals, gParams, filtersFrom(p, 'events', gParams))}
          GROUP BY 1, 2`,
        gParams,
      )
    : Promise.resolve([]);

  const [v, e, c] = await Promise.all([vitals, errs, conv]);
  return rows.map((x) => {
    const vit = v.find((y) => y.rel === x.rel);
    return {
      version: x.rel, firstSeen: x.first.toISOString(), lastSeen: x.last.toISOString(),
      sessions: x.sessions, errorSessions: x.err, failedRequestSessions: x.fail, errors: x.errors,
      vitals: { samples: vit?.samples ?? 0, lcp: vit?.lcp ?? null, inp: vit?.inp ?? null, cls: vit?.cls ?? null },
      goals: goals.map((g, i) => {
        const converted = c.find((y) => y.i === i && y.rel === x.rel)?.n ?? 0;
        return { id: g.id, name: g.name, converted, rate: x.sessions ? converted / x.sessions : 0 };
      }),
      newErrors: e.filter((y) => y.rel === x.rel).sort((a, b) => b.count - a.count).slice(0, NEW_ERRORS)
        .map((y) => ({ fingerprint: y.fingerprint, message: y.message, count: y.count })),
      previous: null,
      verdicts: {},
    };
  });
}

async function serviceVersions(pid: string, r: { from: Date; to: Date }, p: Q): Promise<ServiceVersionHealth[]> {
  const params: unknown[] = [pid, r.from, r.to];
  const F = filtersFrom(p.spanFilters ? { filters: p.spanFilters } : {}, 'spans', params);
  const rows = await rawQuery<{ service: string; ver: string; spans: number; errors: number; p50: number | null; p95: number | null; sp50: number | null; sp95: number | null; first: Date; last: Date }>(pid, r,
    `SELECT service, ${VERSION_SQL} AS ver, count(*)::int AS spans, sum(CASE WHEN status_code = 2 THEN 1 ELSE 0 END)::int AS errors,
            quantile_cont(duration_ms, 0.5) AS p50, quantile_cont(duration_ms, 0.95) AS p95,
            quantile_cont(CASE WHEN kind = 2 THEN duration_ms END, 0.5) AS sp50, quantile_cont(CASE WHEN kind = 2 THEN duration_ms END, 0.95) AS sp95,
            min(start_time) AS first, max(start_time) AS last
       FROM spans WHERE project_id = $1 AND start_time >= $2 AND start_time < $3${F} AND ${VERSION_SQL} IS NOT NULL
      GROUP BY 1, 2 ORDER BY max(start_time) DESC LIMIT 100`,
    params,
  );
  return rows.map((x) => ({
    service: x.service, version: x.ver, firstSeen: x.first.toISOString(), lastSeen: x.last.toISOString(), spans: x.spans, errors: x.errors,
    p50Ms: x.sp50 ?? x.p50, p95Ms: x.sp95 ?? x.p95, previous: null, verdicts: {},
  }));
}

export type { Filter };
