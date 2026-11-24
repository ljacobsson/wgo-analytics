import { describe, expect, it } from 'vitest';
import { localHours } from '../src/lib/analytics';

const at = (iso: string) => Date.parse(iso);

describe('localHours', () => {
  it('uses the zone offset, including daylight saving time', () => {
    expect(localHours([at('2026-01-15T23:30:00Z'), at('2026-07-15T23:30:00Z')], 'Europe/Stockholm')).toEqual([0, 1]);
  });
  it('maps midnight to 0, not 24', () => {
    expect(localHours([at('2026-03-01T00:10:00Z')], 'UTC')).toEqual([0]);
  });
  it('rounds half-hour zones by the time given (callers pass the hour midpoint)', () => {
    expect(localHours([at('2026-03-01T00:30:00Z')], 'Asia/Kolkata')).toEqual([6]);
  });
});
