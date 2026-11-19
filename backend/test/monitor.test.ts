import { describe, expect, it } from 'vitest';
import { fires, usualRange } from '../src/lib/monitor';
import { describeAggregate, slackMessage } from '../src/lib/triggers';

describe('usualRange', () => {
  it('needs 3 days and is robust to one odd day', () => {
    expect(usualRange([10, 12], true, 'medium')).toBeNull();
    const r = usualRange([10, 12, 11, 9, 200, 10, 11], true, 'medium')!;
    expect(r.median).toBe(11);
    expect(r.high).toBeLessThan(30);
    expect(r.days).toBe(7);
  });
  it('uses at least Poisson noise for counts', () => {
    const r = usualRange([4, 4, 4, 4], true, 'medium')!;
    expect(r.high).toBeCloseTo(4 + 3 * 2);
    expect(r.low).toBe(0);
  });
});

describe('fires', () => {
  const count = { agg: 'count' as const };
  it('thresholds', () => {
    expect(fires(21, { op: 'above', value: 20 }, count, null)).toBe(true);
    expect(fires(20, { op: 'above', value: 20 }, count, null)).toBe(false);
    expect(fires(0, { op: 'below', value: 1 }, count, null)).toBe(true);
    expect(fires(null, { op: 'below', value: 1 }, { agg: 'p95', field: 'durationMs' }, null)).toBe(false);
  });
  it('anomalies need a baseline, the right direction and a meaningful change for counts', () => {
    const b = { median: 2, low: 0, high: 6, days: 7 };
    const up = { direction: 'up' as const, sensitivity: 'medium' as const };
    expect(fires(30, up, count, b)).toBe(true);
    expect(fires(30, up, count, null)).toBe(false);
    expect(fires(30, { direction: 'down', sensitivity: 'medium' }, count, b)).toBe(false);
    // above the band but only 5 more than usual is the minimum
    expect(fires(6.5, up, count, b)).toBe(false);
    expect(fires(900, up, { agg: 'p95', field: 'durationMs' }, { median: 300, low: 200, high: 400, days: 5 })).toBe(true);
  });
});

describe('aggregate notifications', () => {
  const base = { trigger: { id: 't', name: 'Checkout errors' }, project: { id: 'p', name: 'Shop' }, firedAt: '', scope: 'events' as const, matches: 0, events: [], url: 'https://wgo.test/#/x' };
  it('describe threshold, anomaly and resolved states', () => {
    expect(describeAggregate({ kind: 'threshold', state: 'firing', value: 34, metric: { agg: 'count' }, condition: { op: 'above', value: 20 }, windowMinutes: 15 }))
      .toBe('Count in the last 15 minutes is 34, above 20.');
    expect(describeAggregate({ kind: 'anomaly', state: 'firing', value: 1840, metric: { agg: 'p95', field: 'durationMs' }, condition: { direction: 'up', sensitivity: 'medium' }, windowMinutes: 60, baseline: { median: 400, low: 300, high: 520, days: 7 } }))
      .toBe('p95 of durationMs in the last hour is 1.84 s, unusually high (usually 300 ms to 520 ms).');
    expect(describeAggregate({ kind: 'threshold', state: 'resolved', value: 0.021, metric: { agg: 'session_rate' }, condition: { op: 'above', value: 0.05 }, windowMinutes: 1440 }))
      .toBe('Share of sessions in the last 24 hours is back to normal: 2.1%.');
  });
  it('renders a Slack message with the explanation', () => {
    const m = slackMessage({ ...base, kind: 'threshold', state: 'firing', value: 34, metric: { agg: 'count' }, condition: { op: 'above', value: 20 }, windowMinutes: 15, explanation: '90% of the increase is on /checkout.' }) as { text: string; blocks: Array<{ text?: { text: string } }> };
    expect(m.text).toBe('🔔 Checkout errors: Count in the last 15 minutes is 34, above 20.');
    expect(m.blocks.map((b) => b.text?.text)).toContain('90% of the increase is on /checkout.');
    const r = slackMessage({ ...base, kind: 'threshold', state: 'resolved', value: 3, metric: { agg: 'count' }, condition: { op: 'above', value: 20 }, windowMinutes: 15, explanation: 'x' }) as { text: string; blocks: unknown[] };
    expect(r.text.startsWith('✅ Resolved Checkout errors')).toBe(true);
    expect(JSON.stringify(r.blocks)).not.toContain('"x"');
  });
});
