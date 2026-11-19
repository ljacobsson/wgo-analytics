import { describe, expect, it } from 'vitest';
import { bucketOf, devicesFor, limitOf } from '../src/lib/frustration';

describe('frustration helpers', () => {
  it('maps the heatmap device switch to device column values', () => {
    expect(devicesFor(undefined)).toEqual(['desktop']);
    expect(devicesFor('desktop')).toEqual(['desktop']);
    expect(devicesFor('mobile')).toEqual(['mobile', 'tablet']);
    expect(() => devicesFor('tv')).toThrow(/desktop or mobile/);
  });

  it('buckets coordinates to 8 px', () => {
    expect([0, 7, 8, 15, 16, 1003].map((v) => bucketOf(v))).toEqual([0, 0, 8, 8, 16, 1000]);
  });

  it('clamps the limit', () => {
    expect(limitOf(undefined, 50, 200)).toBe(50);
    expect(limitOf('500', 50, 200)).toBe(200);
    expect(limitOf('x', 50, 200)).toBe(50);
    expect(limitOf('10', 50, 200)).toBe(10);
  });
});
