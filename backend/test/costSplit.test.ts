import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectShare, shapeCosts } from '../src/lib/costs';
import { classify, FUNCTIONS, functionFor, ingestPaths, queueFor, type SplitShares } from '../src/lib/costSplit';

const none: SplitShares = { lambda: new Map(), dsql: new Map() };

describe('function map', () => {
  it('has every function in template.yaml with its memory size', () => {
    const yaml = readFileSync(join(__dirname, '../template.yaml'), 'utf8');
    const globalMemory = Number(yaml.match(/^Globals:\n  Function:\n(?:    .*\n)*?    MemorySize: (\d+)/m)![1]);
    const found: Record<string, number> = {};
    // each top-level resource: its `  Name:` line up to the next line indented by two spaces or less
    for (const block of yaml.split(/\n(?=  ?\S)/)) {
      const m = block.match(/^  (\w+):\n    Type: AWS::Serverless::Function\n/);
      if (!m) continue;
      const memory = block.match(/^      MemorySize: (\d+)/m);
      found[m[1]] = memory ? Number(memory[1]) : globalMemory;
    }
    expect(Object.keys(found).length).toBeGreaterThan(10);
    expect(Object.fromEntries(Object.entries(FUNCTIONS).map(([k, v]) => [k, v.memoryMb]))).toEqual(found);
  });

  it('finds the logical ID in a function name', () => {
    expect(functionFor('wgo-ApiFunction-AbC123', 'wgo')).toBe('ApiFunction');
    expect(functionFor('wgo-McpAuthFunction-AbC123', 'wgo')).toBe('McpAuthFunction');
    expect(functionFor('wgo-EventsWriterFun-AbC123', 'wgo')).toBe('EventsWriterFunction'); // shortened by CloudFormation
    expect(functionFor('wgo-staging-ApiFunction-AbC123', 'wgo')).toBeNull(); // another stack
    expect(functionFor('other-ApiFunction-AbC123', 'wgo')).toBeNull();
    expect(queueFor('wgo-OtlpQueue-aazVucYkr779', 'wgo')).toBe('OtlpQueue');
    expect(queueFor('wgo-OtlpDeadLetterQueue-FZHnQNxfEaYo', 'wgo')).toBeNull(); // dead letters aren't counted
  });
});

describe('cost categories', () => {
  it('sorts usage types into categories', () => {
    expect(classify('Amazon Simple Storage Service', 'USE1-TimedStorage-ByteHrs', 'd', none)).toEqual({ storage: 1 });
    expect(classify('Amazon Simple Storage Service', 'USE1-Requests-Tier1', 'd', none)).toEqual({ ingestion: 1 });
    expect(classify('Amazon Simple Storage Service', 'USE1-Requests-Tier2', 'd', none)).toEqual({ querying: 1 });
    expect(classify('Amazon Aurora DSQL', 'USE1-DSQL-Storage', 'd', none)).toEqual({ storage: 1 });
    expect(classify('Amazon API Gateway', 'USE1-ApiGatewayRequest', 'd', none)).toEqual({ ingestion: 1 });
    expect(classify('Amazon API Gateway', 'USE1-ApiGatewayHttpRequest', 'd', none)).toEqual({ querying: 1 });
    expect(classify('Amazon Simple Queue Service', 'USE1-Requests-RBP', 'd', none)).toEqual({ ingestion: 1 });
    expect(classify('AmazonCloudWatch', 'USE1-TimedStorage-ByteHrs', 'd', none)).toEqual({ storage: 1 });
    expect(classify('Amazon Cognito', 'USE1-CognitoUserPoolsMAU', 'd', none)).toEqual({ other: 1 });
  });

  it('splits Lambda and DSQL compute by their shares, per day, else over the window, else into other', () => {
    const shares: SplitShares = {
      lambda: new Map([['2026-11-01', { ingestion: 3, querying: 1 }], ['all', { ingestion: 1, querying: 1 }]]),
      dsql: new Map(),
    };
    expect(classify('AWS Lambda', 'USE1-Lambda-GB-Second-ARM', '2026-11-01', shares)).toEqual({ ingestion: 3, querying: 1 });
    expect(classify('AWS Lambda', 'USE1-Lambda-GB-Second-ARM', '2026-11-02', shares)).toEqual({ ingestion: 1, querying: 1 });
    expect(classify('Amazon Aurora DSQL', 'USE1-DSQL-DPU', '2026-11-01', shares)).toEqual({ other: 1 });
  });

  it('adds the split into the month and the daily series', () => {
    const now = Date.UTC(2026, 10, 19, 10);
    const day = (d: string, groups: Array<[string, string, number]>) => ({
      TimePeriod: { Start: d, End: d }, Total: {}, Estimated: false,
      Groups: groups.map(([s, u, a]) => ({ Keys: [s, u], Metrics: { UnblendedCost: { Amount: String(a), Unit: 'USD' } } })),
    });
    const shares: SplitShares = { lambda: new Map([['all', { ingestion: 3, querying: 1 }]]), dsql: new Map() };
    const out = shapeCosts([
      day('2026-11-01', [['AWS Lambda', 'USE1-Lambda-GB-Second-ARM', 0.4], ['Amazon Simple Storage Service', 'USE1-TimedStorage-ByteHrs', 0.1]]),
      day('2026-11-02', [['Amazon Simple Storage Service', 'USE1-Requests-Tier2', 0.05], ['Amazon Cognito', 'USE1-CognitoUserPoolsMAU', 0.01]]),
    ], now, shares);
    expect(out.monthToDate).toBeCloseTo(0.56, 6);
    expect(out.categories).toEqual([
      { category: 'storage', amount: 0.1, services: [{ service: 'Amazon Simple Storage Service', amount: 0.1 }] },
      { category: 'ingestion', amount: 0.3, services: [{ service: 'AWS Lambda', amount: 0.3 }] },
      { category: 'querying', amount: 0.15, services: [{ service: 'AWS Lambda', amount: 0.1 }, { service: 'Amazon Simple Storage Service', amount: 0.05 }] },
      { category: 'other', amount: 0.01, services: [{ service: 'Amazon Cognito', amount: 0.01 }] },
    ]);
    expect(out.daily).toEqual([
      { day: '2026-11-01', amount: 0.5, byCategory: { storage: 0.1, ingestion: 0.3, querying: 0.1, other: 0 }, ingestion: { events: 0, otel: 0 } },
      { day: '2026-11-02', amount: 0.06, byCategory: { storage: 0, ingestion: 0, querying: 0.05, other: 0.01 }, ingestion: { events: 0, otel: 0 } },
    ]);
  });
});

describe('ingestion by what was taken in', () => {
  const shares: SplitShares = {
    lambda: new Map([['all', { ingestion: 1 }]]),
    dsql: new Map(),
    paths: {
      // GB-seconds: the intake ('both') is divided like its requests
      lambda: new Map([['2026-11-01', { events: 2, otel: 1, both: 3, other: 1 }]]),
      queues: new Map([['2026-11-01', { events: 5, otel: 1 }]]),
      requests: new Map([['2026-11-01', { events: 1, otel: 2 }], ['all', { events: 1, otel: 1 }]]),
    },
  };

  it('divides Lambda by function, SQS by queue and the front door by requests', () => {
    expect(ingestPaths('AWS Lambda', '2026-11-01', shares)).toEqual({ events: 3, otel: 3, other: 1 });
    expect(ingestPaths('Amazon Simple Queue Service', '2026-11-01', shares)).toEqual({ events: 5, otel: 1 });
    expect(ingestPaths('Amazon CloudFront', '2026-11-01', shares)).toEqual({ events: 1, otel: 2 });
    // another day: the window's requests; no Lambda or queue numbers that day or over the window
    expect(ingestPaths('Amazon CloudFront', '2026-11-02', shares)).toEqual({ events: 1, otel: 1 });
    expect(ingestPaths('AWS Lambda', '2026-11-02', shares)).toEqual({ other: 1 });
    expect(ingestPaths('Amazon Simple Queue Service', '2026-11-02', shares)).toEqual({ other: 1 });
    // without CloudWatch numbers nothing is attributed
    expect(ingestPaths('Amazon CloudFront', '2026-11-01', { lambda: new Map(), dsql: new Map() })).toEqual({ other: 1 });
  });

  it('adds it into the month and the daily series', () => {
    const now = Date.UTC(2026, 10, 19, 10);
    const day = (d: string, groups: Array<[string, string, number]>) => ({
      TimePeriod: { Start: d, End: d }, Total: {}, Estimated: false,
      Groups: groups.map(([s, u, a]) => ({ Keys: [s, u], Metrics: { UnblendedCost: { Amount: String(a), Unit: 'USD' } } })),
    });
    const out = shapeCosts([
      day('2026-11-01', [['AWS Lambda', 'USE1-Lambda-GB-Second-ARM', 0.7], ['Amazon Simple Queue Service', 'USE1-Requests-RBP', 0.06], ['Amazon CloudFront', 'EU-Requests-Tier1', 0.3]]),
    ], now, shares);
    // Lambda 0.7 as 3:3:1, SQS 0.06 as 5:1, CloudFront 0.3 as 1:2
    expect(out.daily[0].ingestion).toEqual({ events: 0.45, otel: 0.51 });
    expect(out.ingestionPaths).toEqual({ events: 0.45, otel: 0.51 });
  });
});

describe("a project's share of the cost", () => {
  const all = { events: 1000, spans: 8000, logs: 1000, metricPoints: 1000 };
  const project = { events: 100, spans: 8000, logs: 1000, metricPoints: 1000 }; // 10% of events, all of OpenTelemetry

  it('weighs its share of events and of OpenTelemetry items by what taking each in cost', () => {
    expect(projectShare(all, project, { events: 3, otel: 1 })).toBeCloseTo((3 * 0.1 + 1 * 1) / 4, 6);
    expect(projectShare(all, { ...project, spans: 0, logs: 0, metricPoints: 0 }, { events: 3, otel: 1 })).toBeCloseTo(0.075, 6);
  });

  it('without the ingestion split, counts everything that came in', () => {
    expect(projectShare(all, project, { events: 0, otel: 0 })).toBeCloseTo(10_100 / 11_000, 6);
    expect(projectShare(all, project)).toBeCloseTo(10_100 / 11_000, 6);
    expect(projectShare({ events: 0, spans: 0, logs: 0, metricPoints: 0 }, project)).toBe(0);
  });
});
