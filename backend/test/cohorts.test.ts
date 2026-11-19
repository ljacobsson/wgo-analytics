import { describe, expect, it } from 'vitest';
import { addPeriods, buildMatrix, periodStart, type MatrixRow } from '../src/lib/cohorts';

const t = (s: string) => Date.parse(s);
const iso = (ms: number) => new Date(ms).toISOString();

describe('period bucketing', () => {
  it('floors to the UTC day', () => {
    expect(iso(periodStart(t('2026-11-19T23:59:59Z'), 'day'))).toBe('2026-11-19T00:00:00.000Z');
  });

  it('floors to the Monday of the ISO week, also from a Sunday and across a month or year edge', () => {
    expect(iso(periodStart(t('2026-11-19T10:00:00Z'), 'week'))).toBe('2026-11-16T00:00:00.000Z'); // Thursday
    expect(iso(periodStart(t('2026-11-16T00:00:00Z'), 'week'))).toBe('2026-11-16T00:00:00.000Z'); // Monday
    expect(iso(periodStart(t('2026-11-22T23:00:00Z'), 'week'))).toBe('2026-11-16T00:00:00.000Z'); // Sunday
    expect(iso(periodStart(t('2027-01-01T12:00:00Z'), 'week'))).toBe('2026-12-28T00:00:00.000Z');
  });

  it('floors to the first of the month', () => {
    expect(iso(periodStart(t('2026-02-28T23:00:00Z'), 'month'))).toBe('2026-02-01T00:00:00.000Z');
  });

  it('adds periods, months of different lengths and across years', () => {
    expect(iso(addPeriods(t('2026-11-16T00:00:00Z'), 'week', 2))).toBe('2026-11-30T00:00:00.000Z');
    expect(iso(addPeriods(t('2026-11-19T00:00:00Z'), 'day', -19))).toBe('2026-10-31T00:00:00.000Z');
    expect(iso(addPeriods(t('2026-11-01T00:00:00Z'), 'month', 3))).toBe('2027-02-01T00:00:00.000Z');
    expect(iso(addPeriods(t('2026-01-01T00:00:00Z'), 'month', -1))).toBe('2025-12-01T00:00:00.000Z');
  });
});

describe('retention matrix', () => {
  const w1 = t('2026-11-02T00:00:00Z');
  const w2 = t('2026-11-09T00:00:00Z');
  const w3 = t('2026-11-16T00:00:00Z');
  const now = t('2026-11-19T12:00:00Z'); // inside week 3
  const rows: MatrixRow[] = [
    { cohort: w1, split: 'mobile', k: -1, n: 60 }, { cohort: w1, split: 'desktop', k: -1, n: 40 },
    { cohort: w1, split: 'mobile', k: 0, n: 60 }, { cohort: w1, split: 'desktop', k: 0, n: 40 },
    { cohort: w1, split: 'mobile', k: 1, n: 12 }, { cohort: w1, split: 'desktop', k: 1, n: 28 },
    { cohort: w1, split: 'desktop', k: 2, n: 5 }, // week 3 is not over: dropped
    { cohort: w2, split: 'mobile', k: -1, n: 100 }, { cohort: w2, split: 'mobile', k: 0, n: 100 }, { cohort: w2, split: 'mobile', k: 1, n: 10 },
    { cohort: w3, split: 'mobile', k: -1, n: 50 }, { cohort: w3, split: 'mobile', k: 0, n: 50 },
  ];
  const m = buildMatrix(rows, { period: 'week', first: w1, last: w3, now });

  it('has one cohort per period with values, counts and only the periods that are over', () => {
    expect(m.cohorts.map((c) => c.start)).toEqual([iso(w1), iso(w2), iso(w3)]);
    expect(m.cohorts[0]).toMatchObject({ size: 100, counts: [100, 40], values: [1, 0.4] });
    expect(m.cohorts[1]).toMatchObject({ size: 100, counts: [100], values: [1] }); // its week 2 is still running
    expect(m.cohorts[2]).toMatchObject({ size: 50, counts: [50], values: [1] });
  });

  it('averages weighted by size, only over cohorts old enough', () => {
    // period 1: 40 / 100, only the first cohort has a finished period 1
    expect(m.average).toEqual([1, 0.4]);
  });

  it('gives each split its own average, biggest first', () => {
    expect(m.splits).toEqual([
      { key: 'mobile', size: 210, average: [1, 0.2] },
      { key: 'desktop', size: 40, average: [1, 0.7] },
    ]);
  });

  it('has no splits for a single unnamed group and keeps empty cohorts', () => {
    const one = buildMatrix([{ cohort: w1, split: '', k: -1, n: 4 }, { cohort: w1, split: '', k: 0, n: 4 }], { period: 'week', first: w1, last: w2, now });
    expect(one.splits).toBeUndefined();
    expect(one.cohorts[1]).toMatchObject({ size: 0, values: [0] });
  });

  it('caps splits at five', () => {
    const many: MatrixRow[] = Array.from({ length: 8 }, (_, i) => ({ cohort: w1, split: `s${i}`, k: -1, n: 10 + i }));
    expect(buildMatrix(many, { period: 'week', first: w1, last: w1, now }).splits).toHaveLength(5);
  });

  it('counts months by calendar length', () => {
    const sep = t('2026-09-01T00:00:00Z');
    const r = buildMatrix([{ cohort: sep, split: '', k: -1, n: 10 }, { cohort: sep, split: '', k: 1, n: 3 }, { cohort: sep, split: '', k: 2, n: 2 }], { period: 'month', first: sep, last: sep, now });
    expect(r.cohorts[0].counts).toEqual([0, 3]); // October is over, November is not
  });
});
