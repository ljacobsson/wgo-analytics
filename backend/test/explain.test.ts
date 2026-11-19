import { describe, expect, it } from 'vitest';
import { changePoint, countDrivers, countSignificant, rateDrivers, summarize } from '../src/lib/explain';

describe('countDrivers', () => {
  it('finds the segment that grew beyond the overall growth, not the big one that grew in line', () => {
    // errors 100 → 300: Chrome (70% before) grew 2×, Safari (10% before) grew 13×
    const rows = [
      { dim: 'browser' as const, key: 'Chrome', current: 140, previous: 70 },
      { dim: 'browser' as const, key: 'Safari', current: 130, previous: 10 },
      { dim: 'browser' as const, key: 'Firefox', current: 30, previous: 20 },
    ];
    const d = countDrivers(rows, 300, 100);
    expect(d.map((x) => x.key)).toEqual(['Safari']);
    expect(d[0].share).toBeCloseTo(0.6);
    expect(d[0].before).toBeCloseTo(0.1);
  });
  it('handles decreases and ignores tiny or opposite moves and (none)', () => {
    const rows = [
      { dim: 'path' as const, key: '/checkout', current: 10, previous: 90 },
      { dim: 'path' as const, key: '/', current: 98, previous: 100 },
      { dim: 'path' as const, key: '(none)', current: 0, previous: 50 },
      { dim: 'release' as const, key: '2.0', current: 20, previous: 2 },
    ];
    expect(countDrivers(rows, 128, 242).map((x) => x.key)).toEqual(['/checkout']);
  });
  it('treats a metric that was zero before as all new', () => {
    const d = countDrivers([{ dim: 'release', key: '3.1', current: 40, previous: 0 }], 40, 0);
    expect(d).toEqual([expect.objectContaining({ key: '3.1', share: 1, before: 0 })]);
  });
});

describe('rateDrivers', () => {
  it('keeps segments whose rate clearly dropped with the total', () => {
    const rows = [
      { dim: 'device' as const, key: 'mobile', current: 1000, previous: 1000, convCurrent: 20, convPrevious: 60 },
      { dim: 'device' as const, key: 'desktop', current: 1000, previous: 1000, convCurrent: 50, convPrevious: 52 },
      { dim: 'device' as const, key: 'tablet', current: 10, previous: 10, convCurrent: 0, convPrevious: 5 },
    ];
    const d = rateDrivers(rows, { cur: 2010, prev: 2010, rateCur: 70 / 2010, ratePrev: 117 / 2010 });
    expect(d.map((x) => x.key)).toEqual(['mobile']);
    expect(d[0].rate).toEqual({ current: 0.02, previous: 0.06 });
    expect(d[0].share).toBeGreaterThan(0.8);
  });
  it('compares a segment that is new in this window with the overall baseline', () => {
    const rows = [{ dim: 'release' as const, key: '2.0', current: 300, previous: 0, convCurrent: 0, convPrevious: 0 }];
    const d = rateDrivers(rows, { cur: 600, prev: 300, rateCur: 0.1, ratePrev: 0.2 });
    expect(d).toEqual([expect.objectContaining({ key: '2.0', rate: { current: 0, previous: 0.2 } })]);
  });
});

describe('changePoint', () => {
  it('finds a level shift', () => {
    const v = [10, 12, 9, 11, 10, 12, 11, 40, 42, 39, 41];
    expect(changePoint(v)).toMatchObject({ index: 7 });
  });
  it('ignores noise and tiny counts', () => {
    expect(changePoint([10, 12, 9, 11, 10, 13, 9, 12, 11, 10])).toBeNull();
    expect(changePoint([0, 1, 0, 0, 1, 0, 2, 1])).toBeNull();
    expect(changePoint([1, 2])).toBeNull();
  });
});

describe('countSignificant', () => {
  it('is false for changes within Poisson noise', () => {
    expect(countSignificant(110, 100)).toBe(false);
    expect(countSignificant(300, 100)).toBe(true);
    expect(countSignificant(4, 0)).toBe(false);
  });
});

describe('summarize', () => {
  const base = { metric: 'events' as const, label: 'Errors', bucketSeconds: 3600, series: [], baseFrom: '', from: '', ratio: null, startedAt: null, release: null, drivers: [] };
  it('writes the change, the driver, the start and the release', () => {
    const s = summarize({
      ...base, current: 412, previous: 133, significant: true, startedAt: '2026-11-19T14:05:00.000Z',
      release: { kind: 'web', service: '', version: '1.42.0', firstSeen: '2026-11-19T14:03:00.000Z' },
      drivers: [{ dim: 'browser', key: 'Safari', current: 300, previous: 20, share: 1.0, before: 0.15 }, { dim: 'path', key: '/checkout', current: 250, previous: 10, share: 0.86, before: 0.07 }],
    });
    expect(s).toBe('Errors are up 3.1× (412 vs 133 before). 100% of the increase is in Safari, which was 15% of the total before, mostly on /checkout. It started around 14:05 UTC, 2 minutes after release 1.42.0 was first seen.');
  });
  it('says when a change is just noise', () => {
    expect(summarize({ ...base, current: 105, previous: 100, significant: false })).toBe("Errors are up 5% (105 vs 100 before). That's within the normal ups and downs for numbers this size.");
  });
  it('describes conversion rates', () => {
    const s = summarize({ ...base, metric: 'goal', label: 'Signup conversion', current: 0.031, previous: 0.044, significant: true,
      drivers: [{ dim: 'device', key: 'mobile', current: 900, previous: 880, share: 0.9, before: 0.4, rate: { current: 0.012, previous: 0.04 } }] });
    expect(s).toBe('Signup conversion is down 30% (3.1% vs 4.4% before). The biggest drop is on mobile (4.0% → 1.2%).');
  });
});
