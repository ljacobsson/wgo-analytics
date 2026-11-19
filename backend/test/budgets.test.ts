import { describe, expect, it } from 'vitest';
import { budgetMessage, nextState } from '../src/lib/budgets';

const NOV = Date.UTC(2026, 10, 19, 12);
const DEC = Date.UTC(2026, 11, 2, 12);
const budget = (o: object = {}) => ({ monthly_limit: 100, alert_at: [50, 80, 100], alert_on_forecast: true, pause_at_limit: true, state: null, ...o });

describe('nextState', () => {
  it('alerts each threshold once a month, the highest crossed in one message', () => {
    const a = nextState(budget(), 85, 120, false, NOV);
    expect(a.events).toEqual([{ event: 'threshold', percent: 80 }, { event: 'forecast', percent: null }]);
    expect(a.state).toMatchObject({ month: '2026-11', alerted: [50, 80], forecastAlerted: true, paused: false });
    const b = nextState(budget({ state: a.state }), 90, 120, false, NOV);
    expect(b.events).toEqual([]);
  });
  it('pauses at the limit and stays paused', () => {
    const a = nextState(budget(), 100, 130, false, NOV);
    expect(a.events.map((e) => e.event)).toEqual(['threshold', 'paused']);
    expect(a.state.paused).toBe(true);
    expect(nextState(budget({ state: a.state }), 104, 130, false, NOV).events).toEqual([]);
  });
  it('unpauses when the limit is raised, the pause is turned off, or a new month starts', () => {
    const paused = nextState(budget(), 100, null, false, NOV).state;
    expect(nextState(budget({ state: paused, monthly_limit: 200 }), 100, null, false, NOV)).toMatchObject({ state: { paused: false }, events: [{ event: 'resumed' }] });
    expect(nextState(budget({ state: paused, pause_at_limit: false }), 100, null, false, NOV).state.paused).toBe(false);
    const dec = nextState(budget({ state: paused }), 3, null, false, DEC);
    expect(dec.state).toMatchObject({ month: '2026-12', paused: false, alerted: [], resumed: false });
  });
  it('a hand resume holds for the rest of the month', () => {
    const resumed = { ...nextState(budget(), 100, null, false, NOV).state, paused: false, resumed: true };
    expect(nextState(budget({ state: resumed }), 150, null, false, NOV).state.paused).toBe(false);
  });
  it('does nothing without Cost Explorer data', () => {
    expect(nextState(budget(), null, null, false, NOV)).toMatchObject({ events: [], state: { spent: null, paused: false } });
  });
  it('alerts alone never pause', () => {
    expect(nextState(budget({ pause_at_limit: false }), 500, null, false, NOV).state.paused).toBe(false);
  });
});

describe('budgetMessage', () => {
  it('says what happened in plain words', () => {
    const s = nextState(budget(), 104.5, null, true, NOV).state;
    expect(budgetMessage({ scope: 'project', monthly_limit: 100 }, 'Shop', s, 'paused', null))
      .toBe('Project Shop reached its $100.00 budget ($104.50 (estimated from its share of events)). WGO has stopped storing new data for it until next month. Raise the limit or resume on the Costs page to collect again.');
    expect(budgetMessage({ scope: 'install', monthly_limit: 20 }, '', { ...s, estimated: false, spent: 10 }, 'threshold', 50))
      .toBe('The WGO install has spent $10.00 this month: 50% of its $20.00 budget.');
  });
});
