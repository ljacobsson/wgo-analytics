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
 *
 * Ingestion is split once more, by what was taken in (ingestPaths): browser events or OpenTelemetry.
 * - Lambda: by each ingestion function's GB-seconds. IngestFunction and EventsWriterFunction take in events,
 *   OtlpFunction OpenTelemetry; IntakeFunction serves both, so its share is divided like the front door below.
 * - SQS: by messages sent to each queue (IngestQueue and EventsQueue: events; OtlpQueue: OpenTelemetry).
 * - The rest (CloudFront, the intake API, S3 writes, DSQL writes) is the front door: divided by requests, which
 *   are the messages sent to IngestQueue and OtlpQueue (the intake writes one per request).
 * Recordings and source maps (ReplayFunction, SourcemapFunction) are in neither.
 */

export const CATEGORIES: CostCategory[] = ['storage', 'ingestion', 'querying', 'other'];
export type Split = Partial<Record<CostCategory, number>>;
/** Per day (YYYY-MM-DD) and for the whole window ('all'): how a shared service's cost divides, as weights. */
export type Shares = Map<string, Split>;
/** What the ingestion cost was for: browser events, OpenTelemetry (spans, logs, metric points) or something else. */
export type IngestPath = 'events' | 'otel' | 'other';
export type PathSplit = Partial<Record<IngestPath, number>>;
/** What an ingestion function or queue serves; 'both': events and OpenTelemetry (the intake). */
type Feeds = IngestPath | 'both';
export interface PathShares {
  lambda: Map<string, Partial<Record<Feeds, number>>>; // GB-seconds of the ingestion functions
  queues: Map<string, PathSplit>; // messages sent per queue
  requests: Map<string, PathSplit>; // requests through the intake: messages sent to IngestQueue and OtlpQueue
}
export interface SplitShares { lambda: Shares; dsql: Shares; paths?: PathShares }

/**
 * Every function in template.yaml: what it does and its MemorySize (test/costSplit.test.ts keeps this in step
 * with the template).
 */
export const FUNCTIONS: Record<string, { category: CostCategory; memoryMb: number; feeds?: Feeds }> = {
  IngestFunction: { category: 'ingestion', memoryMb: 512, feeds: 'events' },
  IntakeFunction: { category: 'ingestion', memoryMb: 256, feeds: 'both' },
  OtlpFunction: { category: 'ingestion', memoryMb: 1024, feeds: 'otel' },
  EventsWriterFunction: { category: 'ingestion', memoryMb: 1024, feeds: 'events' },
  ReplayFunction: { category: 'ingestion', memoryMb: 512, feeds: 'other' },
  SourcemapFunction: { category: 'ingestion', memoryMb: 512, feeds: 'other' },
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
  // named `${stack}-FixAgentFunction-run` (see template.yaml), so it matches like the generated names
  FixAgentFunction: { category: 'other', memoryMb: 2048 },
  GithubFunction: { category: 'other', memoryMb: 256 },
};

/** The queues the intake writes to and the events writer reads, and what they carry (dead-letter queues aren't counted). */
export const QUEUES: Record<string, 'events' | 'otel'> = { IngestQueue: 'events', EventsQueue: 'events', OtlpQueue: 'otel' };

/**
 * The template's logical ID (one of `ids`) in a resource name `${stack}-${LogicalId}-${suffix}` (CloudFormation may
 * shorten the logical ID when the name gets long). Null for resources of other stacks.
 */
function logicalIdFor(name: string, stack: string, ids: string[]): string | null {
  if (!name.startsWith(`${stack}-`)) return null;
  const rest = name.slice(stack.length + 1);
  const dash = rest.lastIndexOf('-');
  if (dash <= 0) return null;
  const id = rest.slice(0, dash);
  if (ids.includes(id)) return id;
  const matches = ids.filter((k) => k.startsWith(id));
  return matches.length === 1 ? matches[0] : null;
}
export const functionFor = (name: string, stack: string) => logicalIdFor(name, stack, Object.keys(FUNCTIONS));
export const queueFor = (name: string, stack: string) => logicalIdFor(name, stack, Object.keys(QUEUES));

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

const sum = (s: Partial<Record<string, number>>) => Object.values(s).reduce<number>((a, b) => a + (b ?? 0), 0);
const pick = <K extends string>(m: Map<string, Partial<Record<K, number>>> | undefined, day: string) => m?.get(day) ?? m?.get('all');

/**
 * How the ingestion part of one Cost Explorer line (service, usage type) on `day` divides between browser events,
 * OpenTelemetry and other. Weights; without CloudWatch numbers, all of it is other.
 */
export function ingestPaths(service: string, day: string, shares: SplitShares): PathSplit {
  const req = pick(shares.paths?.requests, day);
  const front: PathSplit = req && sum(req) > 0 ? req : { other: 1 };
  if (/Lambda/i.test(service)) {
    const fns = pick(shares.paths?.lambda, day);
    if (!fns || !(sum(fns) > 0)) return { other: 1 };
    const { both = 0, ...out } = fns;
    const fw = sum(front);
    for (const [k, w] of Object.entries(front) as Array<[IngestPath, number]>) out[k] = (out[k] ?? 0) + (both * w) / fw;
    return out;
  }
  if (/Queue Service|SQS/i.test(service)) {
    const q = pick(shares.paths?.queues, day);
    return q && sum(q) > 0 ? q : { other: 1 };
  }
  return front;
}

const DAY = 86_400_000;
const dayStr = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Adds a day's weights into the per-day map and into 'all'. */
function add<K extends string>(shares: Map<string, Partial<Record<K, number>>>, day: string, key: K, n: number) {
  if (!(n > 0)) return;
  for (const d of [day, 'all']) {
    const s: Partial<Record<K, number>> = shares.get(d) ?? {};
    s[key] = (s[key] ?? 0) + n;
    shares.set(d, s);
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

/**
 * Each of the stack's functions' GB-seconds per day, by category and (ingestion functions) by what they take in.
 * Empty when CloudWatch has nothing.
 */
export async function lambdaShares(stack: string, start: number, end: number): Promise<{ shares: Shares; paths: PathShares['lambda'] }> {
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
  const paths: PathShares['lambda'] = new Map();
  if (!fns.length) return { shares, paths };
  const results = await metricData(fns.map(([name], i) => ({
    Id: `f${i}`,
    MetricStat: { Metric: { Namespace: 'AWS/Lambda', MetricName: 'Duration', Dimensions: [{ Name: 'FunctionName', Value: name }] }, Period: 86400, Stat: 'Sum' },
  })), start, end);
  for (const r of results) {
    const fn = FUNCTIONS[fns[Number(r.id.slice(1))][1]];
    r.values.forEach((ms, k) => {
      const gbs = (ms / 1000) * (fn.memoryMb / 1024);
      add(shares, r.days[k], fn.category, gbs);
      if (fn.feeds) add(paths, r.days[k], fn.feeds, gbs);
    });
  }
  return { shares, paths };
}

/** Messages sent to the stack's queues per day: for SQS by queue, and IngestQueue vs OtlpQueue as the intake's requests. */
export async function queueShares(stack: string, start: number, end: number): Promise<Pick<PathShares, 'queues' | 'requests'>> {
  cw ??= new CloudWatchClient({});
  const names = new Map<string, string>(); // queue name -> logical ID
  let token: string | undefined;
  do {
    const res = await cw.send(new ListMetricsCommand({ Namespace: 'AWS/SQS', MetricName: 'NumberOfMessagesSent', NextToken: token }));
    for (const m of res.Metrics ?? []) {
      if (m.Dimensions?.length !== 1 || m.Dimensions[0].Name !== 'QueueName') continue;
      const id = queueFor(m.Dimensions[0].Value!, stack);
      if (id) names.set(m.Dimensions[0].Value!, id);
    }
    token = res.NextToken;
  } while (token);
  const qs = [...names];
  const queues: PathShares['queues'] = new Map();
  const requests: PathShares['requests'] = new Map();
  if (!qs.length) return { queues, requests };
  const results = await metricData(qs.map(([name], i) => ({
    Id: `q${i}`,
    MetricStat: { Metric: { Namespace: 'AWS/SQS', MetricName: 'NumberOfMessagesSent', Dimensions: [{ Name: 'QueueName', Value: name }] }, Period: 86400, Stat: 'Sum' },
  })), start, end);
  for (const r of results) {
    const id = qs[Number(r.id.slice(1))][1];
    r.values.forEach((n, k) => {
      add(queues, r.days[k], QUEUES[id], n);
      if (id !== 'EventsQueue') add(requests, r.days[k], QUEUES[id], n);
    });
  }
  return { queues, requests };
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
  const noLambda = () => ({ shares: new Map() as Shares, paths: new Map() as PathShares['lambda'] });
  const noQueues = () => ({ queues: new Map() as PathShares['queues'], requests: new Map() as PathShares['requests'] });
  const [lambda, dsql, queues] = await Promise.all([
    stack ? lambdaShares(stack, day0, end).catch((err) => { console.warn('lambda split failed', err); return noLambda(); }) : noLambda(),
    clusterId ? dsqlShares(clusterId, day0, end).catch((err) => { console.warn('dsql split failed', err); return new Map() as Shares; }) : new Map() as Shares,
    stack ? queueShares(stack, day0, end).catch((err) => { console.warn('queue split failed', err); return noQueues(); }) : noQueues(),
  ]);
  return { lambda: lambda.shares, dsql, paths: { lambda: lambda.paths, ...queues } };
}
