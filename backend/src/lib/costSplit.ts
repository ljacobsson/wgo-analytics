import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import type { CostCategory } from '../contract';

/**
 * Splits the install's cost into storage, ingestion, querying and other. Cost Explorer only knows services and
 * usage types, so:
 * - storage is every storage usage type (S3, DSQL, DynamoDB and CloudWatch Logs storage);
 * - a service that does one job goes to that job (SQS: ingestion; the REST intake API: ingestion; the HTTP and
 *   WebSocket APIs: querying; CloudFront: ingestion, since most of its requests are events coming in);
 * - S3 requests: writes (Tier1) are ingestion, reads (Tier2) and transfer out are querying;
 * - Lambda is shared by every function, so it is split by each function's GB-seconds (CloudWatch Duration times
 *   the function's memory), per day;
 * - DSQL compute is split by its own CloudWatch metrics: WriteDPU is ingestion, ReadDPU and ComputeDPU querying.
 * Anything without a split (no metrics yet) goes to other.
 */

export const CATEGORIES: CostCategory[] = ['storage', 'ingestion', 'querying', 'other'];
export type Split = Partial<Record<CostCategory, number>>;
/** Per day (YYYY-MM-DD) and for the whole window ('all'): how a shared service's cost divides, as weights. */
export type Shares = Map<string, Split>;
export interface SplitShares { lambda: Shares; dsql: Shares }

/**
 * Every function in template.yaml: what it does and its MemorySize (test/costSplit.test.ts keeps this in step
 * with the template).
 */
export const FUNCTIONS: Record<string, { category: CostCategory; memoryMb: number }> = {
  IngestFunction: { category: 'ingestion', memoryMb: 512 },
  OtlpFunction: { category: 'ingestion', memoryMb: 1024 },
  EventsWriterFunction: { category: 'ingestion', memoryMb: 1024 },
  ReplayFunction: { category: 'ingestion', memoryMb: 512 },
  SourcemapFunction: { category: 'ingestion', memoryMb: 512 },
  ApiFunction: { category: 'querying', memoryMb: 2048 },
  McpFunction: { category: 'querying', memoryMb: 2048 },
  McpAuthFunction: { category: 'querying', memoryMb: 256 },
  WidgetFunction: { category: 'querying', memoryMb: 2048 },
  KioskFunction: { category: 'querying', memoryMb: 2048 },
  WsFunction: { category: 'querying', memoryMb: 1024 },
  MaintenanceFunction: { category: 'other', memoryMb: 3008 },
  MonitorFunction: { category: 'other', memoryMb: 1024 },
  TriggerFunction: { category: 'other', memoryMb: 256 },
  SlackFunction: { category: 'other', memoryMb: 256 },
  PreSignUpFunction: { category: 'other', memoryMb: 256 },
  UptimeFunction: { category: 'other', memoryMb: 256 },
  ScreenshotFunction: { category: 'other', memoryMb: 2048 },
  MigrateFunction: { category: 'other', memoryMb: 1024 },
};

/**
 * The template's logical ID in a function name `${stack}-${LogicalId}-${suffix}` (CloudFormation may shorten the
 * logical ID when the name gets long). Null for functions of other stacks.
 */
export function functionFor(name: string, stack: string): string | null {
  if (!name.startsWith(`${stack}-`)) return null;
  const rest = name.slice(stack.length + 1);
  const dash = rest.lastIndexOf('-');
  if (dash <= 0) return null;
  const id = rest.slice(0, dash);
  if (FUNCTIONS[id]) return id;
  const matches = Object.keys(FUNCTIONS).filter((k) => k.startsWith(id));
  return matches.length === 1 ? matches[0] : null;
}

const STORAGE = /TimedStorage|ByteHrs|Storage/i;

/**
 * How one Cost Explorer line (service, usage type) on `day` divides between the categories. Weights, not
 * amounts; they need not add up to 1.
 */
export function classify(service: string, usageType: string, day: string, shares: SplitShares): Split {
  if (STORAGE.test(usageType) && !/Request/i.test(usageType)) return { storage: 1 };
  if (/Lambda/i.test(service)) return shares.lambda.get(day) ?? shares.lambda.get('all') ?? { other: 1 };
  if (/DSQL/i.test(service)) return shares.dsql.get(day) ?? shares.dsql.get('all') ?? { other: 1 };
  if (/Queue Service|SQS/i.test(service)) return { ingestion: 1 };
  if (/API Gateway/i.test(service)) {
    if (/ApiGatewayHttp|ApiGatewayMessage|ApiGatewayMinute/i.test(usageType)) return { querying: 1 };
    if (/ApiGatewayRequest/i.test(usageType)) return { ingestion: 1 };
    return { other: 1 };
  }
  if (/CloudFront/i.test(service)) return { ingestion: 1 };
  if (/Simple Storage Service|^Amazon S3$/i.test(service)) {
    if (/Requests-Tier1/i.test(usageType)) return { ingestion: 1 };
    if (/Requests-Tier2|DataTransfer|Select/i.test(usageType)) return { querying: 1 };
    return { other: 1 };
  }
  if (/DynamoDB/i.test(service)) return { querying: 1 }; // the live view's WebSocket connections
  return { other: 1 };
}

const DAY = 86_400_000;
const dayStr = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Adds a day's weights into the per-day map and into 'all'. */
function add(shares: Shares, day: string, category: CostCategory, n: number) {
  if (!(n > 0)) return;
  for (const key of [day, 'all']) {
    const s = shares.get(key) ?? {};
    s[category] = (s[category] ?? 0) + n;
    shares.set(key, s);
  }
}

let cw: CloudWatchClient | undefined;

async function metricData(queries: MetricDataQuery[], start: number, end: number) {
  cw ??= new CloudWatchClient({});
  const out: Array<{ id: string; days: string[]; values: number[] }> = [];
  for (let i = 0; i < queries.length; i += 500) {
    let token: string | undefined;
    do {
      const res = await cw.send(new GetMetricDataCommand({
        StartTime: new Date(start), EndTime: new Date(end), MetricDataQueries: queries.slice(i, i + 500), NextToken: token,
      }));
      for (const r of res.MetricDataResults ?? []) {
        let entry = out.find((o) => o.id === r.Id);
        if (!entry) out.push(entry = { id: r.Id!, days: [], values: [] });
        entry.days.push(...(r.Timestamps ?? []).map((t) => dayStr(t.getTime())));
        entry.values.push(...(r.Values ?? []));
      }
      token = res.NextToken;
    } while (token);
  }
  return out;
}

/** Each of the stack's functions' GB-seconds per day, by category. Empty when CloudWatch has nothing. */
export async function lambdaShares(stack: string, start: number, end: number): Promise<Shares> {
  cw ??= new CloudWatchClient({});
  const names = new Map<string, string>(); // function name -> logical ID
  let token: string | undefined;
  do {
    const res = await cw.send(new ListMetricsCommand({ Namespace: 'AWS/Lambda', MetricName: 'Duration', NextToken: token }));
    for (const m of res.Metrics ?? []) {
      if (m.Dimensions?.length !== 1 || m.Dimensions[0].Name !== 'FunctionName') continue;
      const name = m.Dimensions[0].Value!;
      const id = functionFor(name, stack);
      if (id) names.set(name, id);
    }
    token = res.NextToken;
  } while (token);
  const fns = [...names];
  const shares: Shares = new Map();
  if (!fns.length) return shares;
  const results = await metricData(fns.map(([name], i) => ({
    Id: `f${i}`,
    MetricStat: { Metric: { Namespace: 'AWS/Lambda', MetricName: 'Duration', Dimensions: [{ Name: 'FunctionName', Value: name }] }, Period: 86400, Stat: 'Sum' },
  })), start, end);
  for (const r of results) {
    const fn = FUNCTIONS[fns[Number(r.id.slice(1))][1]];
    r.values.forEach((ms, k) => add(shares, r.days[k], fn.category, (ms / 1000) * (fn.memoryMb / 1024)));
  }
  return shares;
}

/** The cluster's DPUs per day: writes are ingestion, reads and compute querying. Empty when CloudWatch has nothing. */
export async function dsqlShares(clusterId: string, start: number, end: number): Promise<Shares> {
  cw ??= new CloudWatchClient({});
  const parts: Array<[string, CostCategory]> = [['WriteDPU', 'ingestion'], ['ReadDPU', 'querying'], ['ComputeDPU', 'querying']];
  const queries: MetricDataQuery[] = [];
  for (const [metric] of parts) {
    // the dimension name isn't fixed in the docs, so it is looked up (as in lib/cluster.ts)
    const res = await cw.send(new ListMetricsCommand({ Namespace: 'AWS/AuroraDSQL', MetricName: metric }));
    const dims = res.Metrics?.find((x) => x.Dimensions?.length === 1 && x.Dimensions[0].Value === clusterId)?.Dimensions;
    if (dims) queries.push({ Id: metric.toLowerCase(), MetricStat: { Metric: { Namespace: 'AWS/AuroraDSQL', MetricName: metric, Dimensions: dims }, Period: 86400, Stat: 'Sum' } });
  }
  const shares: Shares = new Map();
  if (!queries.length) return shares;
  for (const r of await metricData(queries, start, end)) {
    const category = parts.find(([m]) => m.toLowerCase() === r.id)![1];
    r.values.forEach((n, k) => add(shares, r.days[k], category, n));
  }
  return shares;
}

/** Both splits from CloudWatch; each is empty (so its cost goes to other) when it can't be read. */
export async function readShares(start: number, end: number): Promise<SplitShares> {
  const stack = process.env.STACK_NAME;
  const clusterId = process.env.DSQL_CLUSTER_ID;
  const day0 = Math.floor(start / DAY) * DAY;
  const [lambda, dsql] = await Promise.all([
    stack ? lambdaShares(stack, day0, end).catch((err) => { console.warn('lambda split failed', err); return new Map() as Shares; }) : new Map() as Shares,
    clusterId ? dsqlShares(clusterId, day0, end).catch((err) => { console.warn('dsql split failed', err); return new Map() as Shares; }) : new Map() as Shares,
  ]);
  return { lambda, dsql };
}
