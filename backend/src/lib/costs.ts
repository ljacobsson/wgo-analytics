import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { CostExplorerClient, GetCostAndUsageCommand, type GetCostAndUsageCommandOutput, type ResultByTime } from '@aws-sdk/client-cost-explorer';
import type { CostCategory, CostsResponse } from '../contract';
import { readClusterStats } from './cluster';
import { CATEGORIES, classify, readShares, type SplitShares } from './costSplit';
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
      }
      if (day >= thisMonth) services.set(service, (services.get(service) ?? 0) + amount);
    }
    if (day >= thisMonth) { mtd += total; monthDays.add(day); }
    else if (day >= lastMonth) prev += total;
    if (day >= since) daily.set(day, byCategory);
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
    })),
    services: sorted(services),
    categories: CATEGORIES.map((category) => {
      const list = sorted(categories.get(category)!);
      return { category, amount: round([...categories.get(category)!.values()].reduce((a, b) => a + b, 0)), services: list };
    }),
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

export async function eventsThisMonth(now: number, pid?: string): Promise<number> {
  const params: unknown[] = [new Date(monthStart(now))];
  if (pid) params.push(pid);
  const [row] = await query<{ n: string | null }>(`SELECT sum(events) AS n FROM rollups WHERE dim = 'type' AND hour >= $1${pid ? ' AND project_id = $2' : ''}`, params);
  return Number(row?.n ?? 0);
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

/** The cost report, from the cache while it is fresh. `pid` adds that project's events this month. */
export async function getCosts(pid: string | undefined, now = Date.now(), deps: CostDeps = {}): Promise<CostsResponse> {
  let base = await readCache();
  const age = base ? now - new Date(base.fetchedAt).getTime() : Infinity;
  // a report cached before the category split (no `categories`) is refetched
  if (!base || age >= (base.setup ? SETUP_CACHE_MS : CACHE_MS) || age < 0 || (!base.setup && !base.categories)) {
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
    if (!base.setup) {
      const [events, usage] = await Promise.all([eventsThisMonth(now), (deps.usage ?? readUsage)(now)]);
      base.usage = { eventsThisMonth: events, ...usage };
    }
    base.fetchedAt = new Date(now).toISOString();
    await writeCache(base, now);
  }
  const out: CostsResponse = { ...base, usage: { ...base.usage } };
  if (pid && isUuid(pid) && !out.setup) out.usage.projectEventsThisMonth = await eventsThisMonth(now, pid);
  return out;
}
