import { describe, expect, it } from 'vitest';
import { buildFlows, parseSteps, type FlowRow } from '../src/lib/flows';

const row = (r: Partial<FlowRow> & Pick<FlowRow, 'kind'>): FlowRow => ({ i: null, a: null, b: null, n: 0, m: null, en: null, em: null, ...r });

describe('parseSteps', () => {
  it('defaults to 5 and clamps to 3-7', () => {
    expect(parseSteps(undefined)).toBe(5);
    expect(parseSteps('')).toBe(5);
    expect(parseSteps('x')).toBe(5);
    expect(parseSteps('2.5')).toBe(5);
    expect(parseSteps('1')).toBe(3);
    expect(parseSteps('6')).toBe(6);
    expect(parseSteps('40')).toBe(7);
  });
});

describe('buildFlows', () => {
  const f = buildFlows([
    row({ kind: 'total', n: 30 }),
    row({ kind: 'link', i: 1, a: '(other)', b: '/a', n: 4 }),
    row({ kind: 'link', i: 1, a: '/', b: '/a', n: 10 }),
    row({ kind: 'link', i: 1, a: '/', b: null, n: 6 }),
    row({ kind: 'link', i: 1, a: '/x', b: null, n: 10 }),
    row({ kind: 'link', i: 2, a: '/a', b: '/b', n: 9 }),
    row({ kind: 'link', i: 2, a: '/a', b: null, n: 5 }),
    row({ kind: 'link', i: 3, a: '/b', b: '(other)', n: 7 }), // last step: goes on past the chart
    row({ kind: 'link', i: 3, a: '/b', b: null, n: 2 }),
    row({ kind: 'nerr', i: 2, a: '/a', n: 3, m: 2 }),
    row({ kind: 'terr', i: 2, a: '/a', b: 'B', n: 1 }),
    row({ kind: 'terr', i: 2, a: '/a', b: 'A', n: 3 }),
    row({ kind: 'exit', a: '/x', n: 10, m: 12, en: 0, em: 0 }),
    row({ kind: 'exit', a: '/a', n: 5, m: 14, en: 3, em: 2 }),
  ], null, 3);

  it('sums a node over its outgoing rows, exits being the rows without a next page', () => {
    expect(f.sessions).toBe(30);
    expect(f.nodes.map((n) => [n.step, n.key, n.sessions, n.exits])).toEqual([
      [0, '/', 16, 6], [0, '/x', 10, 10], [0, '(other)', 4, 0], // (other) last in its step
      [1, '/a', 14, 5],
      [2, '/b', 9, 2],
    ]);
  });

  it('keeps links between charted steps only, and errors on their node', () => {
    expect(f.links).toEqual([
      { step: 0, from: '/', to: '/a', sessions: 10 }, { step: 0, from: '(other)', to: '/a', sessions: 4 },
      { step: 1, from: '/a', to: '/b', sessions: 9 },
    ]);
    expect(f.nodes.find((n) => n.key === '/a')).toMatchObject({ errors: 3, errorExits: 2, topErrors: [{ key: 'A', sessions: 3 }, { key: 'B', sessions: 1 }] });
  });

  it('ranks exit pages by exits, with their rate', () => {
    expect(f.exitPages.map((p) => [p.path, p.exits, p.rate])).toEqual([['/x', 10, 10 / 12], ['/a', 5, 5 / 14]]);
    expect(f.exitPages[1]).toMatchObject({ errorViews: 3, errorExits: 2 });
  });
});
