import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { CostExplorerClient, GetCostAndUsageCommand, type GetCostAndUsageCommandOutput, type ResultByTime } from '@aws-sdk/client-cost-explorer';
import type { CostCategory, CostsResponse, IngestionPaths, SignalCounts } from '../contract';
import { readClusterStats } from './cluster';
import { CATEGORIES, classify, ingestPaths, readShares, type IngestPath, type SplitShares } from './costSplit';
import { query } from './db';
import { isUuid } from './projects';

/**
 * What the install costs: AWS Cost Explorer for the resources of this stack (tag aws:cloudformation:stack-name,
 * which has to be activated as a cost allocation tag in the Billing console), next to usage numbers. Cost
 * Explorer charges $0.01 per request, so one DAILY query grouped by SERVICE and USAGE_TYPE over [first of last
 * month, today] feeds everything, and the whole result is cached (cost_cache) for 12 hours; a "setup needed" result
 * for 1 hour. The split into storage, ingestion, querying and other is lib/costSplit.ts.
 */
export const CACHE_MS = 12 * 3600_000;
export const SETUP_CACHE_MS = 3600_000;
const CACHE_ID = 'stack';
const DAY = 86_400_000;
const TAG = 'aws:cloudformation:stack-name';

export interface CostDeps {
  ce?: { send: (cmd: GetCostAndUsageCommand) => Promise<GetCostAndUsageCommandOutput> };
  usage?: (now: number) => Promise<Pick<CostsResponse['usage'], 'dataBucketBytes' | 'dsqlStorageBytes'>>;
  shares?: (start: number, end: number) => Promise<SplitShares>;
}

const dayStr = (t: number) => new Date(t).toISOString().slice(0, 10);
const monthStart = (t: number) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const prevMonthStart = (t: number) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1); };
const daysInMonth = (t: number) => { const d = new Date(t); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); };
const round = (n: number) => Math.round(n * 10_000) / 10_000;
const noShares = (): SplitShares => ({ lambda: new Map(), dsql: new Map() });
const zeros = (): Record<CostCategory, number> => ({ storage: 0, ingestion: 0, querying: 0, other: 0 });
const roundPaths = (p: IngestionPaths): IngestionPaths => ({ events: round(p.events), otel: round(p.otel) });
/** The first day the report covers: the daily series (30 days) and the month so far. */
const windowStart = (now: number) => Math.min(monthStart(now), now - 30 * DAY);

const emptyUsage = { eventsThisMonth: 0, dataBucketBytes: null, dsqlStorageBytes: null };

export function setupResponse(reason: string, now: number): CostsResponse {
  return { setup: true, reason, currency: 'USD', monthToDate: 0, lastMonth: 0, daily: [], services: [], categories: [], usage: { ...emptyUsage }, fetchedAt: new Date(now).toISOString() };
}

/**
 * Turns Cost Explorer's daily results (grouped by service and usage type) into the response, split by category
 * with `shares`. No cost data at all means setup is needed.
 */
export function shapeCosts(results: ResultByTime[], now: number, shares: SplitShares = noShares()): CostsResponse {
  const thisMonth = dayStr(monthStart(now));
  const lastMonth = dayStr(prevMonthStart(now));
  const since = dayStr(now - 30 * DAY);
  let mtd = 0, prev = 0;
  const daily = new Map<string, Record<CostCategory, number>>();
  const dailyPaths = new Map<string, IngestionPaths>();
  const monthPaths: IngestionPaths = { events: 0, otel: 0 };
  const services = new Map<string, number>();
  const categories = new Map<CostCategory, Map<string, number>>(CATEGORIES.map((c) => [c, new Map()]));
  const monthDays = new Set<string>();
  let currency = 'USD';
  for (const r of results) {
    const day = r.TimePeriod?.Start;
    if (!day) continue;
    const groups = r.Groups?.length ? r.Groups : r.Total?.UnblendedCost ? [{ Keys: ['Total'], Metrics: r.Total }] : [];
    let total = 0;
    const byCategory = daily.get(day) ?? zeros();
    const paths = dailyPaths.get(day) ?? { events: 0, otel: 0 };
    for (const g of groups) {
      const m = g.Metrics?.UnblendedCost;
      const amount = Number(m?.Amount ?? 0);
      if (!Number.isFinite(amount)) continue;
      if (m?.Unit) currency = m.Unit;
      total += amount;
      const service = g.Keys?.[0] ?? 'Other';
      const split = classify(service, g.Keys?.[1] ?? '', day, shares);
      const weight = Object.values(split).reduce((a, b) => a + (b ?? 0), 0);
      for (const [c, w] of Object.entries(split) as Array<[CostCategory, number]>) {
        const part = weight > 0 ? (amount * w) / weight : 0;
        byCategory[c] += part;
        if (day >= thisMonth) categories.get(c)!.set(service, (categories.get(c)!.get(service) ?? 0) + part);
        if (c !== 'ingestion' || !(part > 0)) continue;
        // ingestion once more, by what was taken in
        const by = ingestPaths(service, day, shares);
        const total = Object.values(by).reduce((a, b) => a + (b ?? 0), 0);
        for (const [p, pw] of Object.entries(by) as Array<[IngestPath, number]>) {
          if (p === 'other' || !(total > 0)) continue;
          paths[p] += (part * pw) / total;
          if (day >= thisMonth) monthPaths[p] += (part * pw) / total;
        }
      }
      if (day >= thisMonth) services.set(service, (services.get(service) ?? 0) + amount);
    }
    if (day >= thisMonth) { mtd += total; monthDays.add(day); }
    else if (day >= lastMonth) prev += total;
    if (day >= since) { daily.set(day, byCategory); dailyPaths.set(day, paths); }
  }
  const sorted = (m: Map<string, number>) => [...m].filter(([, a]) => round(a) > 0).sort((a, b) => b[1] - a[1]).map(([service, amount]) => ({ service, amount: round(amount) }));
  if (mtd === 0 && prev === 0) return setupResponse('Cost Explorer returned no costs for this stack yet.', now);
  const elapsed = Math.max(1, monthDays.size);
  return {
    setup: false,
    currency,
    monthToDate: round(mtd),
    lastMonth: round(prev),
    forecast: round((mtd / elapsed) * daysInMonth(now)),
    daily: [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([day, c]) => ({
      day,
      amount: round(CATEGORIES.reduce((a, k) => a + c[k], 0)),
      byCategory: Object.fromEntries(CATEGORIES.map((k) => [k, round(c[k])])) as Record<CostCategory, number>,
      ingestion: roundPaths(dailyPaths.get(day)!),
    })),
    services: sorted(services),
    categories: CATEGORIES.map((category) => {
      const list = sorted(categories.get(category)!);
      return { category, amount: round([...categories.get(category)!.values()].reduce((a, b) => a + b, 0)), services: list };
    }),
    ingestionPaths: roundPaths(monthPaths),
    usage: { ...emptyUsage },
    fetchedAt: new Date(now).toISOString(),
  };
}

async function fetchCe(client: NonNullable<CostDeps['ce']>, stack: string, now: number): Promise<ResultByTime[]> {
  const results: ResultByTime[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: dayStr(prevMonthStart(now)), End: dayStr(now + DAY) },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }, { Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
      Filter: { Tags: { Key: TAG, Values: [stack] } },
      NextPageToken: token,
    }));
    results.push(...(res.ResultsByTime ?? []));
    token = res.NextPageToken;
  } while (token);
  return results;
}

let cw: CloudWatchClient | undefined;

/** Size of the data bucket (daily CloudWatch metric, last value) and of the DSQL cluster. Each is null when unavailable. */
async function readUsage(now: number): Promise<Pick<CostsResponse['usage'], 'dataBucketBytes' | 'dsqlStorageBytes'>> {
  const bucket = process.env.STORE_URL?.match(/^s3:\/\/([^/]+)/)?.[1];
  const clusterId = process.env.DSQL_CLUSTER_ID;
  const [dataBucketBytes, dsqlStorageBytes] = await Promise.all([
    bucket ? (async () => {
      cw ??= new CloudWatchClient({});
      const res = await cw.send(new GetMetricDataCommand({
        StartTime: new Date(now - 4 * DAY), EndTime: new Date(now), ScanBy: 'TimestampDescending',
        MetricDataQueries: [{ Id: 's', MetricStat: { Metric: { Namespace: 'AWS/S3', MetricName: 'BucketSizeBytes', Dimensions: [{ Name: 'BucketName', Value: bucket }, { Name: 'StorageType', Value: 'StandardStorage' }] }, Period: 86400, Stat: 'Average' } }],
      }));
      return res.MetricDataResults?.[0]?.Values?.[0] ?? null;
    })().catch(() => null) : null,
    clusterId ? readClusterStats(clusterId, now).then((s) => s.storageBytes).catch(() => null) : null,
  ]);
  return { dataBucketBytes, dsqlStorageBytes };
}

export const noSignals = (): SignalCounts => ({ events: 0, spans: 0, logs: 0, metricPoints: 0 });
/** Everything in `c`: what a project's share of the cost is measured in. */
export const signalTotal = (c: SignalCounts) => c.events + c.spans + c.logs + c.metricPoints;
const SIGNAL_FIELD: Record<string, keyof SignalCounts> = { events: 'events', spans: 'spans', logs: 'logs', metric_points: 'metricPoints' };

/**
 * What the install (or project `pid`) took in per UTC day (YYYY-MM-DD) from `since` on, from the hourly rollups:
 * browser events (dim 'type') and spans, logs and metric points (dim 'signal', rollups.ts runSignalCounts).
 */
async function signalsByDay(since: number, pid?: string): Promise<Map<string, SignalCounts>> {
  const params: unknown[] = [new Date(since)];
  if (pid) params.push(pid);
  const rows = await query<{ hour: Date; k: string; n: string }>(
    `SELECT hour, CASE WHEN dim = 'type' THEN 'events' ELSE key END AS k, sum(events) AS n FROM rollups
      WHERE dim IN ('type', 'signal') AND hour >= $1${pid ? ' AND project_id = $2' : ''} GROUP BY 1, 2`,
    params,
  );
  const out = new Map<string, SignalCounts>();
  for (const r of rows) {
    const field = SIGNAL_FIELD[r.k];
    if (!field) continue;
    const day = dayStr(r.hour.getTime());
    const c = out.get(day) ?? noSignals();
    c[field] += Number(r.n);
    out.set(day, c);
  }
  return out;
}

const sumSignals = (days: Iterable<SignalCounts>) => {
  const out = noSignals();
  for (const d of days) for (const k of Object.keys(out) as Array<keyof SignalCounts>) out[k] += d[k];
  return out;
};

/**
 * A project's share of the install's cost (0-1): its share of the events and of the OpenTelemetry items, weighted by
 * what taking each in cost this month (`paths`). Without that split, its share of everything that came in.
 */
export function projectShare(all: SignalCounts, project: SignalCounts, paths?: IngestionPaths): number {
  const otel = (c: SignalCounts) => c.spans + c.logs + c.metricPoints;
  const parts: Array<[number, number, number]> = [[paths?.events ?? 0, project.events, all.events], [paths?.otel ?? 0, otel(project), otel(all)]];
  const weighted = parts.filter(([cost, , n]) => cost > 0 && n > 0);
  const weight = weighted.reduce((a, [cost]) => a + cost, 0);
  if (weight > 0) return Math.min(1, weighted.reduce((a, [cost, p, n]) => a + (cost * p) / n, 0) / weight);
  const total = signalTotal(all);
  return total > 0 ? Math.min(1, signalTotal(project) / total) : 0;
}

/** What the install (or project `pid`) took in this month. */
export async function signalsThisMonth(now: number, pid?: string): Promise<SignalCounts> {
  return sumSignals((await signalsByDay(monthStart(now), pid)).values());
}

async function readCache(): Promise<CostsResponse | null> {
  const [row] = await query<{ data: CostsResponse; fetched_at: Date }>('SELECT data, fetched_at FROM cost_cache WHERE id = $1', [CACHE_ID]);
  return row ? { ...row.data, fetchedAt: row.fetched_at.toISOString() } : null;
}

async function writeCache(data: CostsResponse, now: number): Promise<void> {
  await query(
    `INSERT INTO cost_cache (id, data, fetched_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, fetched_at = EXCLUDED.fetched_at`,
    [CACHE_ID, JSON.stringify(data), new Date(now)],
  );
}

/** The cost report, from the cache while it is fresh, with what came in. `pid` adds what that project took in this month. */
export async function getCosts(pid: string | undefined, now = Date.now(), deps: CostDeps = {}): Promise<CostsResponse> {
  let base = await readCache();
  const age = base ? now - new Date(base.fetchedAt).getTime() : Infinity;
  // a report cached before the category split (no `categories`) or the ingestion split (no `ingestionPaths`) is refetched
  if (!base || age >= (base.setup ? SETUP_CACHE_MS : CACHE_MS) || age < 0 || (!base.setup && (!base.categories || !base.ingestionPaths))) {
    try {
      const stack = process.env.STACK_NAME;
      if (!stack) throw new Error('STACK_NAME is not set');
      const ce = deps.ce ?? new CostExplorerClient({ region: 'us-east-1' });
      const results = await fetchCe(ce, stack, now);
      base = shapeCosts(results, now);
      // CloudWatch is only asked once Cost Explorer has numbers (the cost allocation tag is active)
      if (!base.setup) base = shapeCosts(results, now, await (deps.shares ?? readShares)(windowStart(now), now + DAY));
    } catch (err) {
      console.warn('cost explorer failed', err);
      base = setupResponse(`Cost Explorer could not be read: ${(err as Error).message}`, now);
    }
    if (!base.setup) base.usage = { eventsThisMonth: 0, ...(await (deps.usage ?? readUsage)(now)) };
    base.fetchedAt = new Date(now).toISOString();
    await writeCache(base, now);
  }
  const out: CostsResponse = { ...base, usage: { ...base.usage } };
  if (out.setup) return out;
  // what came in is read on every request (a few thousand rollup rows), so it is never older than the rollups
  const thisMonth = dayStr(monthStart(now));
  const first = out.daily[0]?.day ?? thisMonth;
  const [days, project] = await Promise.all([
    signalsByDay(Date.parse(`${first < thisMonth ? first : thisMonth}T00:00:00Z`)),
    pid && isUuid(pid) ? signalsThisMonth(now, pid) : undefined,
  ]);
  out.daily = out.daily.map((d) => ({ ...d, signals: days.get(d.day) ?? noSignals() }));
  const month = sumSignals([...days].filter(([day]) => day >= thisMonth).map(([, c]) => c));
  out.usage.signalsThisMonth = month;
  out.usage.eventsThisMonth = month.events;
  if (project) {
    out.usage.projectSignalsThisMonth = project;
    out.usage.projectEventsThisMonth = project.events;
    out.usage.projectShare = Math.round(projectShare(month, project, out.ingestionPaths) * 10_000) / 10_000;
  }
  return out;
}
