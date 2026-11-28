import type {
  Survey, SurveyAnswer, SurveyInput, SurveyQuestion, SurveyQuestionResult, SurveyResponse, SurveyResponsesPage, SurveyResults,
} from '../api/contract';
import { hash, pick, rnd, uuidOf } from './rng';

/** Mock surveys: stored in the mock DB; responses are made up deterministically from the survey id and the clock. */
export type StoredSurvey = Omit<Survey, 'responses' | 'lastResponseAt'>;

const DAY = 86400e3;
const seedOf = (id: string) => hash(...[...id].map((c) => c.charCodeAt(0)));

export function seedSurveys(now: number, email: string): StoredSurvey[] {
  const at = new Date(now - 34 * DAY).toISOString();
  return [
    {
      id: '5b1c0a3e-6f2d-4c1e-9a7b-2d4e6f8a0b1c', name: 'Checkout NPS', status: 'active', createdBy: email, createdAt: at, updatedAt: at,
      questions: [
        { id: 'q1', type: 'nps', title: 'How likely are you to recommend Acme to a friend?', required: true, lowLabel: 'Not likely', highLabel: 'Very likely' },
        { id: 'q2', type: 'text', title: 'What is the main reason for your score?', required: false, long: true, placeholder: 'Tell us more' },
      ],
      display: { mode: 'popover', position: 'bottom-right', layout: 'steps', theme: 'auto', accent: '#6d5ce8' },
      targeting: { paths: ['/checkout/success'], delaySec: 3, frequency: 'once' },
    },
    {
      id: '9e2f4d6a-1b3c-4e5f-8a9b-0c1d2e3f4a5b', name: 'Docs feedback', status: 'active', createdBy: email, createdAt: at, updatedAt: at,
      questions: [
        { id: 'q1', type: 'yesno', title: 'Was this page helpful?', required: true },
        { id: 'q2', type: 'single', title: 'What were you looking for?', required: false, options: ['Getting started', 'API reference', 'Pricing', 'Something else'] },
        { id: 'q3', type: 'rating', title: 'How clear was the writing?', required: false, scale: 5 },
        { id: 'q4', type: 'text', title: 'How could we make it better?', required: false },
      ],
      display: { mode: 'inline', selector: '#page-feedback', layout: 'form', theme: 'auto', submitLabel: 'Send feedback' },
      targeting: { paths: ['/docs/*'], frequency: 'always' },
    },
  ];
}

const TEXTS = [
  'Fast checkout, no fuss.', 'Shipping costs were a surprise at the end.', 'Love the product range.', 'The coupon field was hard to find.',
  'Delivery was quicker than expected.', 'Would like Apple Pay.', 'Great support when my order was late.', 'Prices are a bit high.',
  'The search could be better.', 'More code examples please.', 'Could not find the webhook docs.', 'Clear and to the point.',
];
const PATHS: Record<string, string[]> = { '/docs/*': ['/docs/getting-started', '/docs/api', '/docs/webhooks', '/docs/sdk'] };

function answer(q: SurveyQuestion, s: number, i: number): SurveyAnswer | undefined {
  const r = rnd(s, i, seedOf(q.id));
  if (!q.required && r < 0.25) return undefined;
  switch (q.type) {
    case 'single': return pick(q.options ?? [''], s, i, 1);
    case 'multi': { const o = (q.options ?? []).filter((_, k) => rnd(s, i, k, 2) < 0.45); return o.length ? o : undefined; }
    case 'yesno': return r < 0.78;
    case 'rating': { const n = q.scale ?? 5; return Math.max(1, Math.min(n, Math.round(n * (0.55 + 0.45 * rnd(s, i, 3))))); }
    case 'nps': return Math.min(10, Math.floor(11 * Math.sqrt(rnd(s, i, 4))));
    case 'text': return rnd(s, i, 5) < 0.55 ? pick(TEXTS, s, i, 6) : undefined;
  }
}

/** Every made-up response of a survey up to `now`, newest first. Drafts get none. */
function responsesOf(sv: StoredSurvey, now: number): SurveyResponse[] {
  if (sv.status === 'draft') return [];
  const s = seedOf(sv.id);
  const start = Date.parse(sv.createdAt);
  const perDay = 6 + (s % 14);
  const n = Math.floor(((now - start) / DAY) * perDay);
  const out: SurveyResponse[] = [];
  for (let i = 0; i < Math.min(n, 5000); i++) {
    const at = start + ((i + rnd(s, i)) / perDay) * DAY;
    if (at > now) break;
    const answers: Record<string, SurveyAnswer> = {};
    for (const q of sv.questions) { const v = answer(q, s, i); if (v !== undefined) answers[q.id] = v; }
    if (!Object.keys(answers).length) continue;
    const glob = sv.targeting.paths[0] ?? '/';
    out.push({
      id: uuidOf(s, i, 9), createdAt: new Date(at).toISOString(), anonId: uuidOf(s, i, 10),
      userId: rnd(s, i, 11) < 0.35 ? `${pick(['ana', 'ben', 'chloe', 'dev', 'emil', 'fatima', 'gus'], s, i, 12)}${i % 97}@example.com` : null,
      sessionId: uuidOf(s, i, 13), path: PATHS[glob] ? pick(PATHS[glob], s, i, 14) : glob.replace('*', 'page'), answers,
    });
  }
  return out.reverse();
}

function aggregate(questions: SurveyQuestion[], responses: SurveyResponse[]): SurveyQuestionResult[] {
  return questions.map((q) => {
    const vals = responses.map((r) => ({ v: r.answers[q.id], r })).filter((x) => x.v !== undefined);
    const out: SurveyQuestionResult = { id: q.id, answered: vals.length };
    const tally = (keys: string[], of: (v: SurveyAnswer) => string[]) => {
      const n = new Map(keys.map((k) => [k, 0]));
      for (const { v } of vals) for (const k of of(v)) if (n.has(k)) n.set(k, n.get(k)! + 1);
      out.counts = keys.map((value) => ({ value, n: n.get(value)! }));
    };
    if (q.type === 'single') tally(q.options ?? [], (v) => [String(v)]);
    if (q.type === 'multi') tally(q.options ?? [], (v) => (Array.isArray(v) ? v : []));
    if (q.type === 'yesno') tally(['Yes', 'No'], (v) => [v ? 'Yes' : 'No']);
    if (q.type === 'rating' || q.type === 'nps') {
      const [lo, hi] = q.type === 'nps' ? [0, 10] : [1, q.scale ?? 5];
      tally(Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i)), (v) => [String(v)]);
      const nums = vals.map((x) => Number(x.v));
      if (nums.length) out.average = Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
      if (q.type === 'nps' && nums.length) out.nps = Math.round(((nums.filter((x) => x >= 9).length - nums.filter((x) => x <= 6).length) / nums.length) * 100);
    }
    if (q.type === 'text') out.texts = vals.slice(0, 50).map(({ v, r }) => ({ text: String(v), at: r.createdAt, responseId: r.id }));
    return out;
  });
}

export class SurveyError extends Error { constructor(public status: number, m: string) { super(m); } }

const withStats = (sv: StoredSurvey, now: number): Survey => {
  const all = responsesOf(sv, now);
  return { ...sv, responses: all.length, lastResponseAt: all[0]?.createdAt ?? null };
};

function check(input: Partial<SurveyInput>) {
  if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 120)) throw new SurveyError(400, 'Survey name must be 1-120 characters');
  if (input.questions !== undefined) {
    if (!input.questions.length) throw new SurveyError(400, 'A survey needs at least one question');
    input.questions.forEach((q, i) => {
      if (!q.title?.trim()) throw new SurveyError(400, `Question ${i + 1}'s title is required`);
      if ((q.type === 'single' || q.type === 'multi') && (q.options?.filter((o) => o.trim()).length ?? 0) < 2) throw new SurveyError(400, `Question ${i + 1} needs at least 2 options`);
    });
  }
  if (input.display?.mode === 'inline' && !input.display.selector?.trim()) throw new SurveyError(400, 'The CSS selector of an inline survey is required');
}

export function surveysApi(list: StoredSurvey[], method: string, id: string | undefined, action: string | undefined, body: unknown,
  q: { from: number; to: number; before?: string; limit: number }, email: string, save: () => void): unknown {
  const now = Date.now();
  const input = (body ?? {}) as Partial<SurveyInput>;
  if (!id && method === 'GET') return list.map((s) => withStats(s, now));
  if (!id && method === 'POST') {
    check(input);
    if (!input.name || !input.questions || !input.display || !input.targeting) throw new SurveyError(400, 'A survey needs a name, questions, display and targeting');
    const at = new Date().toISOString();
    const sv: StoredSurvey = { id: crypto.randomUUID(), name: input.name.trim(), status: input.status ?? 'draft', questions: input.questions, display: input.display, targeting: input.targeting, createdBy: email, createdAt: at, updatedAt: at };
    list.unshift(sv); save();
    return withStats(sv, now);
  }
  const sv = list.find((s) => s.id === id);
  if (!sv) throw new SurveyError(404, 'Survey not found');
  if (!action && method === 'GET') return withStats(sv, now);
  if (!action && method === 'PATCH') {
    check(input);
    Object.assign(sv, Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)), { updatedAt: new Date().toISOString() });
    if (input.name) sv.name = input.name.trim();
    save();
    return withStats(sv, now);
  }
  if (!action && method === 'DELETE') { list.splice(list.indexOf(sv), 1); save(); return { ok: true }; }
  const inRange = responsesOf(sv, now).filter((r) => { const t = Date.parse(r.createdAt); return t >= q.from && t < q.to; });
  if (action === 'results') {
    const step = (q.to - q.from) / 24;
    const series = new Array<number>(24).fill(0);
    for (const r of inRange) { const b = Math.floor((Date.parse(r.createdAt) - q.from) / step); if (b >= 0 && b < 24) series[b]++; }
    const shown = Math.round(inRange.length * (2.6 + (seedOf(sv.id) % 10) / 10));
    return { responses: inRange.length, shown, dismissed: Math.round((shown - inRange.length) * 0.7), questions: aggregate(sv.questions, inRange), series, truncated: false } satisfies SurveyResults;
  }
  if (action === 'responses') {
    const start = q.before ? inRange.findIndex((r) => `${r.createdAt}|${r.id}` === q.before) + 1 : 0;
    const page = inRange.slice(start, start + q.limit);
    const last = page[page.length - 1];
    return { responses: page, next: start + q.limit < inRange.length && last ? `${last.createdAt}|${last.id}` : null } satisfies SurveyResponsesPage;
  }
  throw new SurveyError(404, 'Not found');
}
