import { describe, expect, it } from 'vitest';
import type { SurveyQuestion, SurveyResponse } from '../src/contract';
import { aggregate, parseDisplay, parseQuestions, parseTargeting, validateAnswers } from '../src/lib/surveys';

const Q: SurveyQuestion[] = parseQuestions([
  { type: 'single', title: 'Role', options: ['Dev', 'PM', 'Other'], required: true },
  { type: 'multi', title: 'Uses', options: ['A', 'B', 'C'] },
  { type: 'text', title: 'Why?', long: true },
  { type: 'yesno', title: 'Recommend?' },
  { type: 'rating', title: 'Docs', scale: 5 },
  { id: 'score', type: 'nps', title: 'NPS' },
]);

describe('survey validation', () => {
  it('assigns ids, keeps per-type fields and drops the rest', () => {
    expect(Q.map((q) => q.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'score']);
    expect(Q[0]).toEqual({ id: 'q1', type: 'single', title: 'Role', options: ['Dev', 'PM', 'Other'], required: true });
    expect(Q[2]).toEqual({ id: 'q3', type: 'text', title: 'Why?', long: true, required: false });
    expect(Q[4].scale).toBe(5);
    expect(parseQuestions([{ type: 'yesno', title: 'x', options: ['a', 'b'] }])[0].options).toBeUndefined();
  });

  it('rejects broken questions', () => {
    expect(() => parseQuestions([])).toThrow(/at least one question/);
    expect(() => parseQuestions([{ type: 'slider', title: 'x' }])).toThrow(/unknown type/);
    expect(() => parseQuestions([{ type: 'single', title: 'x', options: ['a'] }])).toThrow(/at least 2 options/);
    expect(() => parseQuestions([{ type: 'single', title: 'x', options: ['a', 'a'] }])).toThrow(/same option twice/);
    expect(() => parseQuestions([{ type: 'text', title: ' ' }])).toThrow(/title is required/);
    expect(() => parseQuestions([{ id: 'a', type: 'text', title: 'x' }, { id: 'a', type: 'text', title: 'y' }])).toThrow(/repeats/);
  });

  it('defaults display and targeting, and requires a selector inline', () => {
    expect(parseDisplay({})).toEqual({ mode: 'popover', layout: 'steps', theme: 'auto', position: 'bottom-right' });
    expect(parseDisplay({ mode: 'inline', selector: '#fb' })).toEqual({ mode: 'inline', layout: 'form', theme: 'auto', selector: '#fb' });
    expect(() => parseDisplay({ mode: 'inline' })).toThrow(/selector/);
    expect(parseDisplay({ collapse: 'always' }).collapse).toBe('always');
    expect(parseDisplay({ collapse: 'mobile' }).collapse).toBeUndefined();
    expect(parseDisplay({ mode: 'inline', selector: '#x', collapse: 'always' }).collapse).toBeUndefined();
    expect(() => parseDisplay({ accent: 'red' })).toThrow(/#4f46e5/);
    expect(parseTargeting({})).toEqual({ paths: [], frequency: 'once' });
    expect(parseTargeting({ paths: ['/a', '/a', '/docs/*'], delaySec: '5', scrollPct: 50, frequency: 'always' }))
      .toEqual({ paths: ['/a', '/docs/*'], delaySec: 5, scrollPct: 50, frequency: 'always' });
    expect(() => parseTargeting({ paths: ['pricing'] })).toThrow(/start with \//);
    const click = [{ field: 'type', op: 'eq', value: 'click' }, { field: 'trackName', op: 'eq', value: 'signup' }, { field: 'props.props.plan', op: 'set' }];
    expect(parseTargeting({ trigger: click }).trigger).toEqual(click);
    expect(parseTargeting({ trigger: [] }).trigger).toBeUndefined();
    expect(() => parseTargeting({ trigger: [{ field: 'country', op: 'eq', value: 'SE' }] })).toThrow(/can't be checked in the browser/);
    expect(() => parseTargeting({ trigger: [{ field: 'nope', op: 'eq', value: 'x' }] })).toThrow(/can't be checked|Unknown/);
    // surveys from before trigger filters
    expect(parseTargeting({ event: 'paid' }).trigger).toEqual([{ field: 'type', op: 'eq', value: 'custom' }, { field: 'name', op: 'eq', value: 'paid' }]);
    expect(() => parseTargeting({ scrollPct: 150 })).toThrow(/between 1 and 100/);
  });

  it('checks answers against the questions', () => {
    expect(validateAnswers(Q, { q1: 'Dev', q2: ['C', 'A', 'A'], q3: '  because  ', q4: false, q5: 4, score: 0, junk: 1 }))
      .toEqual({ q1: 'Dev', q2: ['A', 'C'], q3: 'because', q4: false, q5: 4, score: 0 });
    expect(validateAnswers(Q, { q1: 'PM', q3: '   ' })).toEqual({ q1: 'PM' });
    expect(() => validateAnswers(Q, { q2: ['A'] })).toThrow(/"Role" is required/);
    expect(() => validateAnswers(Q, { q1: 'CEO' })).toThrow(/Invalid answer to "Role"/);
    expect(() => validateAnswers(Q, { q1: 'Dev', q5: 6 })).toThrow(/Invalid answer/);
    expect(() => validateAnswers(Q, { q1: 'Dev', score: 11 })).toThrow(/Invalid answer/);
    expect(() => validateAnswers(Q, { q1: 'Dev', q4: 'yes' })).toThrow(/Invalid answer/);
  });
});

describe('survey results', () => {
  const r = (id: string, answers: SurveyResponse['answers']): SurveyResponse =>
    ({ id, createdAt: `2026-11-28T10:00:0${id}.000Z`, anonId: null, userId: null, sessionId: null, path: null, answers });
  const res = aggregate(Q, [
    r('3', { q1: 'Dev', q2: ['A', 'B'], q3: 'newest', q4: true, q5: 5, score: 10 }),
    r('2', { q1: 'Dev', q2: ['A'], q4: false, q5: 3, score: 9 }),
    r('1', { q1: 'PM', q3: 'oldest', score: 3 }),
  ]);

  it('counts choices in option order', () => {
    expect(res[0]).toEqual({ id: 'q1', answered: 3, counts: [{ value: 'Dev', n: 2 }, { value: 'PM', n: 1 }, { value: 'Other', n: 0 }] });
    expect(res[1].counts).toEqual([{ value: 'A', n: 2 }, { value: 'B', n: 1 }, { value: 'C', n: 0 }]);
    expect(res[3].counts).toEqual([{ value: 'Yes', n: 1 }, { value: 'No', n: 1 }]);
  });

  it('averages ratings and scores NPS', () => {
    expect(res[4].average).toBe(4);
    expect(res[4].counts?.map((c) => c.value)).toEqual(['1', '2', '3', '4', '5']);
    expect(res[5].counts).toHaveLength(11);
    expect(res[5].nps).toBe(33); // 2 promoters, 1 detractor of 3
  });

  it('lists text answers newest first', () => {
    expect(res[2].texts?.map((t) => t.text)).toEqual(['newest', 'oldest']);
    expect(res[2].answered).toBe(2);
  });
});
