import { randomUUID } from 'node:crypto';
import { SURVEY_TRIGGER_FIELDS, type Filter } from '../contract';
import type {
  Survey, SurveyAnswer, SurveyDisplay, SurveyInput, SurveyQuestion, SurveyQuestionResult, SurveyResponse, SurveyResponsesPage,
  SurveyResults, SurveyStatus, SurveyTargeting,
} from '../contract';
import { parseRange } from './analytics';
import { execute, query } from './db';
import { parseFilters } from './filters';
import { HttpError } from './http';
import { isUuid, projectIdForWriteKey } from './projects';
import { rawQuery } from './store/duck';

/**
 * Surveys: built in the dashboard, shown by the browser SDK (sdk/src/surveys) on the project's site. The SDK learns
 * that a project has active surveys from GET /replay/config (`sv`), loads wgo-surveys.js, which fetches the
 * definitions from GET /surveys/config and posts answers to POST /surveys/respond. Responses live here in DSQL,
 * not with the raw events, so they're kept until the survey is deleted. The SDK also sends survey_shown,
 * survey_dismissed and survey_sent custom events (props survey_id, survey_name), which goals, funnels and the
 * response rate use.
 */

export const MAX_SURVEYS = 50;
export const MAX_QUESTIONS = 20;
export const MAX_OPTIONS = 20;
export const MAX_TEXT = 2000;
/** Responses aggregated per results request; older ones in the range are left out (`truncated`). */
const MAX_AGGREGATED = 20_000;
const SPARK_BUCKETS = 24;
const TEXTS_SHOWN = 50;

const TYPES = ['single', 'multi', 'text', 'yesno', 'rating', 'nps'] as const;
const STATUSES: SurveyStatus[] = ['draft', 'active', 'paused'];

// ---------------------------------------------------------------- validation

const bad = (msg: string): never => { throw new HttpError(400, msg); };
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** A trimmed string of at most `max` characters, or undefined when empty / absent. */
function optStr(v: unknown, max: number, what: string): string | undefined {
  if (v == null) return undefined;
  if (typeof v !== 'string') return bad(`${what} must be text`);
  const s = v.trim();
  if (s.length > max) bad(`${what} can be at most ${max} characters`);
  return s || undefined;
}

function reqStr(v: unknown, max: number, what: string): string {
  return optStr(v, max, what) ?? bad(`${what} is required`);
}

const surveyName = (v: unknown) => reqStr(v, 120, 'Survey name');

export function parseQuestions(v: unknown): SurveyQuestion[] {
  if (!Array.isArray(v) || !v.length) bad('A survey needs at least one question');
  const list = v as unknown[];
  if (list.length > MAX_QUESTIONS) bad(`A survey can have at most ${MAX_QUESTIONS} questions`);
  const ids = new Set<string>();
  return list.map((raw, i) => {
    const q = obj(raw);
    const n = `Question ${i + 1}`;
    const type = q.type as SurveyQuestion['type'];
    if (!TYPES.includes(type)) bad(`${n} has an unknown type: ${String(q.type)}`);
    let id = typeof q.id === 'string' ? q.id.trim() : '';
    if (!id) { let k = i + 1; while (ids.has(`q${k}`)) k++; id = `q${k}`; }
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) bad(`${n} has an invalid id (1-40 letters, digits, _ or -)`);
    if (ids.has(id)) bad(`${n} repeats the id ${id}`);
    ids.add(id);
    const out: SurveyQuestion = { id, type, title: reqStr(q.title, 300, `${n}'s title`), required: q.required === true };
    const description = optStr(q.description, 500, `${n}'s description`);
    if (description) out.description = description;
    if (type === 'single' || type === 'multi') {
      if (!Array.isArray(q.options)) bad(`${n} needs options`);
      const options = (q.options as unknown[]).map((o, j) => reqStr(o, 200, `${n}, option ${j + 1}`));
      if (options.length < 2) bad(`${n} needs at least 2 options`);
      if (options.length > MAX_OPTIONS) bad(`${n} can have at most ${MAX_OPTIONS} options`);
      if (new Set(options).size !== options.length) bad(`${n} has the same option twice`);
      out.options = options;
    }
    if (type === 'text') {
      if (q.long === true) out.long = true;
      const placeholder = optStr(q.placeholder, 200, `${n}'s placeholder`);
      if (placeholder) out.placeholder = placeholder;
    }
    if (type === 'rating') out.scale = q.scale === 10 ? 10 : 5;
    if (type === 'rating' || type === 'nps') {
      const low = optStr(q.lowLabel, 60, `${n}'s low label`);
      const high = optStr(q.highLabel, 60, `${n}'s high label`);
      if (low) out.lowLabel = low;
      if (high) out.highLabel = high;
    }
    return out;
  });
}

export function parseDisplay(v: unknown): SurveyDisplay {
  const d = obj(v);
  const mode = d.mode === 'inline' ? 'inline' : 'popover';
  const out: SurveyDisplay = {
    mode,
    layout: d.layout === 'form' ? 'form' : d.layout === 'steps' ? 'steps' : mode === 'inline' ? 'form' : 'steps',
    theme: d.theme === 'light' || d.theme === 'dark' ? d.theme : 'auto',
  };
  if (mode === 'inline') out.selector = reqStr(d.selector, 300, 'The CSS selector of an inline survey');
  else {
    out.position = d.position === 'bottom-left' ? 'bottom-left' : 'bottom-right';
    if (d.collapse === 'always' || d.collapse === 'never') out.collapse = d.collapse; // absent: 'mobile'
  }
  if (d.accent != null && d.accent !== '') {
    if (typeof d.accent !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(d.accent)) bad('The accent colour must look like #4f46e5');
    out.accent = (d.accent as string).toLowerCase();
  }
  const submitLabel = optStr(d.submitLabel, 40, 'The submit label');
  const thankYou = optStr(d.thankYou, 300, 'The thank-you message');
  if (submitLabel) out.submitLabel = submitLabel;
  if (thankYou) out.thankYou = thankYou;
  return out;
}

export function parseTargeting(v: unknown): SurveyTargeting {
  const t = obj(v);
  const paths = t.paths == null ? [] : Array.isArray(t.paths) ? t.paths : bad('paths must be a list');
  if (paths.length > 20) bad('A survey can target at most 20 paths');
  const out: SurveyTargeting = {
    paths: [...new Set(paths.map((p, i) => {
      const s = reqStr(p, 200, `Path ${i + 1}`);
      return s.startsWith('/') || s.startsWith('*') ? s : bad(`Path ${i + 1} must start with / (e.g. /pricing or /docs/*)`);
    }))],
    frequency: t.frequency === 'always' || t.frequency === 'until_answered' ? t.frequency : 'once',
  };
  const num = (x: unknown, what: string, min: number, max: number) => {
    if (x == null || x === '') return undefined;
    const n = Number(x);
    if (!Number.isFinite(n) || n < min || n > max) bad(`${what} must be between ${min} and ${max}`);
    return Math.round(n);
  };
  const delaySec = num(t.delaySec, 'The delay', 0, 3600);
  const scrollPct = num(t.scrollPct, 'The scroll depth', 1, 100);
  const trigger = t.trigger != null ? parseTrigger(t.trigger) : legacyTrigger(optStr(t.event, 200, 'The event name'))
  if (delaySec) out.delaySec = delaySec;
  if (scrollPct) out.scrollPct = scrollPct;
  if (trigger?.length) out.trigger = trigger;
  return out;
}

const TRIGGER_FIELDS = new Set<string>(SURVEY_TRIGGER_FIELDS);

/** Event filters the SDK checks in the browser: only fields it knows when the event happens. */
function parseTrigger(v: unknown): Filter[] {
  if (!Array.isArray(v)) bad('trigger must be a list of filters');
  if ((v as unknown[]).length > 10) bad('A trigger can have at most 10 filters');
  const list = parseFilters(JSON.stringify(v));
  for (const f of list) {
    if (!TRIGGER_FIELDS.has(f.field) && !/^props\.[^.]/.test(f.field)) {
      bad(`${f.field} can't be checked in the browser; use one of ${SURVEY_TRIGGER_FIELDS.join(', ')} or props.<path>`);
    }
  }
  return list;
}

/** Surveys from before trigger filters had a custom event name (`event`). */
const legacyTrigger = (name: string | undefined): Filter[] | undefined =>
  name ? [{ field: 'type', op: 'eq', value: 'custom' }, { field: 'name', op: 'eq', value: name }] : undefined;

/** Stored targeting, upgraded: an old `event` becomes a trigger. */
function storedTargeting(v: unknown): SurveyTargeting {
  const t = j<SurveyTargeting & { event?: string }>(v);
  if (!t.event) return t;
  const { event, ...rest } = t;
  return { ...rest, trigger: rest.trigger ?? legacyTrigger(event) };
}

const status = (v: unknown): SurveyStatus => (STATUSES.includes(v as SurveyStatus) ? v as SurveyStatus : bad(`Unknown status: ${String(v)}`));

// ---------------------------------------------------------------- storage

interface SurveyRow {
  project_id: string; id: string; name: string; status: SurveyStatus; questions: unknown; display: unknown; targeting: unknown;
  created_by: string; created_at: Date; updated_at: Date;
}
/** jsonb comes back parsed from PostgreSQL, but as text from some drivers / DSQL paths */
const j = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

const toSurvey = (r: SurveyRow, stats?: { n: number; last: Date | null }): Survey => ({
  id: r.id,
  name: r.name,
  status: r.status,
  questions: j(r.questions),
  display: j(r.display),
  targeting: storedTargeting(r.targeting),
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  responses: stats?.n ?? 0,
  lastResponseAt: stats?.last ? new Date(stats.last).toISOString() : null,
});

async function stats(pid: string, id?: string): Promise<Map<string, { n: number; last: Date | null }>> {
  const rows = await query<{ survey_id: string; n: number; last: Date | null }>(
    `SELECT survey_id, count(*)::int AS n, max(created_at) AS last FROM survey_responses
      WHERE project_id = $1${id ? ' AND survey_id = $2' : ''} GROUP BY survey_id`,
    id ? [pid, id] : [pid],
  );
  return new Map(rows.map((r) => [r.survey_id, { n: r.n, last: r.last }]));
}

export async function listSurveys(pid: string): Promise<Survey[]> {
  const [rows, st] = await Promise.all([
    query<SurveyRow>('SELECT * FROM surveys WHERE project_id = $1 ORDER BY created_at DESC, id LIMIT $2', [pid, MAX_SURVEYS]),
    stats(pid),
  ]);
  return rows.map((r) => toSurvey(r, st.get(r.id)));
}

async function row(pid: string, id: string): Promise<SurveyRow> {
  if (!isUuid(id)) throw new HttpError(404, 'Survey not found');
  const [r] = await query<SurveyRow>('SELECT * FROM surveys WHERE project_id = $1 AND id = $2', [pid, id]);
  if (!r) throw new HttpError(404, 'Survey not found');
  return r;
}

export async function getSurvey(pid: string, id: string): Promise<Survey> {
  const [r, st] = await Promise.all([row(pid, id), stats(pid, id)]);
  return toSurvey(r, st.get(id));
}

export async function createSurvey(pid: string, email: string, body: Partial<SurveyInput>): Promise<Survey> {
  const b = obj(body);
  const s: SurveyInput = {
    name: surveyName(b.name),
    status: b.status == null ? 'draft' : status(b.status),
    questions: parseQuestions(b.questions),
    display: parseDisplay(b.display),
    targeting: parseTargeting(b.targeting),
  };
  const [{ n }] = await query<{ n: number }>('SELECT count(*)::int AS n FROM surveys WHERE project_id = $1', [pid]);
  if (n >= MAX_SURVEYS) throw new HttpError(400, `A project can have at most ${MAX_SURVEYS} surveys`);
  const id = randomUUID();
  await query(
    `INSERT INTO surveys (project_id, id, name, status, questions, display, targeting, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)`,
    [pid, id, s.name, s.status, JSON.stringify(s.questions), JSON.stringify(s.display), JSON.stringify(s.targeting), email],
  );
  forget(pid);
  return getSurvey(pid, id);
}

export async function updateSurvey(pid: string, id: string, body: Partial<SurveyInput>): Promise<Survey> {
  const cur = await row(pid, id);
  const b = obj(body);
  await query(
    `UPDATE surveys SET name = $3, status = $4, questions = $5::jsonb, display = $6::jsonb, targeting = $7::jsonb, updated_at = now()
      WHERE project_id = $1 AND id = $2`,
    [
      pid, id,
      b.name !== undefined ? surveyName(b.name) : cur.name,
      b.status !== undefined ? status(b.status) : cur.status,
      JSON.stringify(b.questions !== undefined ? parseQuestions(b.questions) : j(cur.questions)),
      JSON.stringify(b.display !== undefined ? parseDisplay(b.display) : j(cur.display)),
      JSON.stringify(b.targeting !== undefined ? parseTargeting(b.targeting) : storedTargeting(cur.targeting)),
    ],
  );
  forget(pid);
  return getSurvey(pid, id);
}

/** Deletes the survey and its responses (in batches: DSQL caps a transaction at 3,000 modified rows). */
export async function deleteSurvey(pid: string, id: string): Promise<void> {
  await row(pid, id);
  await query('DELETE FROM surveys WHERE project_id = $1 AND id = $2', [pid, id]);
  forget(pid);
  for (;;) {
    const n = await execute(
      `DELETE FROM survey_responses WHERE project_id = $1 AND survey_id = $2
         AND id IN (SELECT id FROM survey_responses WHERE project_id = $1 AND survey_id = $2 LIMIT 500)`,
      [pid, id],
    );
    if (n < 500) break;
  }
}

// ---------------------------------------------------------------- the SDK's endpoints

/** Wire shape of a survey in GET /surveys/config (sdk/src/types.ts PublicSurvey). */
export interface PublicSurvey { id: string; name: string; questions: SurveyQuestion[]; display: SurveyDisplay; targeting: SurveyTargeting }

const activeCache = new Map<string, { list: PublicSurvey[]; exp: number }>();
const forget = (pid: string) => activeCache.delete(pid);

/** The project's active surveys, cached for a few seconds per container (GET /replay/config asks on every page view). */
export async function activeSurveys(pid: string): Promise<PublicSurvey[]> {
  const hit = activeCache.get(pid);
  if (hit && hit.exp > Date.now()) return hit.list;
  const rows = await query<SurveyRow>(`SELECT * FROM surveys WHERE project_id = $1 AND status = 'active' ORDER BY created_at, id`, [pid]);
  const list = rows.map((r) => ({ id: r.id, name: r.name, questions: j<SurveyQuestion[]>(r.questions), display: j<SurveyDisplay>(r.display), targeting: storedTargeting(r.targeting) }));
  activeCache.set(pid, { list, exp: Date.now() + 30_000 });
  if (activeCache.size > 5000) activeCache.delete(activeCache.keys().next().value!);
  return list;
}

/** GET /surveys/config?k=: the active surveys of the write key's project (none when collection is paused). */
export async function publicSurveys(writeKey: string | undefined): Promise<{ s: PublicSurvey[] }> {
  const pid = await projectIdForWriteKey(writeKey);
  if (!pid) return { s: [] };
  const { collectionPaused } = await import('./budgets');
  if (await collectionPaused(pid)) return { s: [] };
  return { s: await activeSurveys(pid) };
}

/**
 * Checks answers against the survey's questions: known question ids only, values of the right kind, options that
 * exist, required questions answered. Returns the cleaned answers.
 */
export function validateAnswers(questions: SurveyQuestion[], raw: unknown): Record<string, SurveyAnswer> {
  const given = obj(raw);
  const out: Record<string, SurveyAnswer> = {};
  for (const q of questions) {
    const v = given[q.id];
    const empty = v == null || v === '' || (Array.isArray(v) && !v.length);
    if (empty) {
      if (q.required) bad(`"${q.title}" is required`);
      continue;
    }
    const wrong = () => bad(`Invalid answer to "${q.title}"`);
    switch (q.type) {
      case 'single':
        if (typeof v !== 'string' || !q.options?.includes(v)) wrong();
        out[q.id] = v as string;
        break;
      case 'multi': {
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !q.options?.includes(x))) wrong();
        out[q.id] = q.options!.filter((o) => (v as string[]).includes(o)); // option order, no repeats
        break;
      }
      case 'text':
        if (typeof v !== 'string') wrong();
        out[q.id] = (v as string).trim().slice(0, MAX_TEXT);
        if (!out[q.id]) { if (q.required) bad(`"${q.title}" is required`); delete out[q.id]; }
        break;
      case 'yesno':
        if (typeof v !== 'boolean') wrong();
        out[q.id] = v as boolean;
        break;
      case 'rating':
      case 'nps': {
        const [lo, hi] = q.type === 'nps' ? [0, 10] : [1, q.scale ?? 5];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) wrong();
        out[q.id] = v as number;
        break;
      }
    }
  }
  return out;
}

const cut = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);

/**
 * POST /surveys/respond {k, id, r, a, s, u, path, ans}: one submitted response. `r` is the response id the SDK made
 * up, so a retried request doesn't count twice. Paused surveys still take answers from visitors who had it open.
 */
export async function respond(body: unknown): Promise<{ ok: boolean }> {
  const b = obj(body);
  const pid = await projectIdForWriteKey(typeof b.k === 'string' ? b.k : undefined);
  if (!pid) return { ok: false };
  const id = typeof b.id === 'string' ? b.id : '';
  const rid = typeof b.r === 'string' && isUuid(b.r) ? b.r : '';
  if (!isUuid(id) || !rid) bad('Survey and response ids are required');
  const [s] = await query<SurveyRow>('SELECT * FROM surveys WHERE project_id = $1 AND id = $2', [pid, id]);
  if (!s || s.status === 'draft') return { ok: false };
  const answers = validateAnswers(j(s.questions), b.ans);
  if (!Object.keys(answers).length) bad('The response has no answers');
  await query(
    `INSERT INTO survey_responses (project_id, survey_id, id, created_at, anon_id, user_id, session_id, path, answers)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) ON CONFLICT (project_id, survey_id, id) DO NOTHING`,
    // a millisecond time from here, not now(): the responses cursor round-trips it through an ISO string
    [pid, id, rid, new Date(), cut(b.a, 64), cut(b.u, 256), cut(b.s, 64), cut(b.path, 1024), JSON.stringify(answers)],
  );
  return { ok: true };
}

// ---------------------------------------------------------------- results

interface ResponseRow { id: string; created_at: Date; anon_id: string | null; user_id: string | null; session_id: string | null; path: string | null; answers: unknown }

const toResponse = (r: ResponseRow): SurveyResponse => ({
  id: r.id, createdAt: r.created_at.toISOString(), anonId: r.anon_id, userId: r.user_id, sessionId: r.session_id, path: r.path,
  answers: j(r.answers) ?? {},
});

/** Per-question numbers over a set of responses (newest first). Exported for tests. */
export function aggregate(questions: SurveyQuestion[], responses: SurveyResponse[]): SurveyQuestionResult[] {
  return questions.map((q) => {
    const vals = responses.map((r) => ({ v: r.answers[q.id], r })).filter((x) => x.v !== undefined && x.v !== null);
    const out: SurveyQuestionResult = { id: q.id, answered: vals.length };
    const tally = (keys: string[], of: (v: SurveyAnswer) => string[]) => {
      const n = new Map(keys.map((k) => [k, 0]));
      for (const { v } of vals) for (const k of of(v)) if (n.has(k)) n.set(k, n.get(k)! + 1);
      out.counts = keys.map((value) => ({ value, n: n.get(value)! }));
    };
    switch (q.type) {
      case 'single': tally(q.options ?? [], (v) => [String(v)]); break;
      case 'multi': tally(q.options ?? [], (v) => (Array.isArray(v) ? v : [])); break;
      case 'yesno': tally(['Yes', 'No'], (v) => [v === true ? 'Yes' : v === false ? 'No' : '']); break;
      case 'rating':
      case 'nps': {
        const [lo, hi] = q.type === 'nps' ? [0, 10] : [1, q.scale ?? 5];
        const keys = Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));
        tally(keys, (v) => [String(v)]);
        const nums = vals.map((x) => Number(x.v)).filter((x) => Number.isFinite(x));
        if (nums.length) out.average = Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
        if (q.type === 'nps' && nums.length) {
          const pro = nums.filter((x) => x >= 9).length, det = nums.filter((x) => x <= 6).length;
          out.nps = Math.round(((pro - det) / nums.length) * 100);
        }
        break;
      }
      case 'text':
        out.texts = vals.slice(0, TEXTS_SHOWN).map(({ v, r }) => ({ text: String(v), at: r.createdAt, responseId: r.id }));
        break;
    }
    return out;
  });
}

/** GET /surveys/{id}/results?from&to */
export async function surveyResults(pid: string, id: string, p: Record<string, string | undefined>): Promise<SurveyResults> {
  const range = parseRange(p, 30 * 86400_000);
  const s = toSurvey(await row(pid, id));
  const rows = await query<ResponseRow>(
    `SELECT id, created_at, anon_id, user_id, session_id, path, answers FROM survey_responses
      WHERE project_id = $1 AND survey_id = $2 AND created_at >= $3 AND created_at < $4
      ORDER BY created_at DESC LIMIT ${MAX_AGGREGATED + 1}`,
    [pid, id, range.from, range.to],
  );
  const truncated = rows.length > MAX_AGGREGATED;
  const list = rows.slice(0, MAX_AGGREGATED).map(toResponse);
  const step = (range.to.getTime() - range.from.getTime()) / SPARK_BUCKETS;
  const series = new Array<number>(SPARK_BUCKETS).fill(0);
  for (const r of list) {
    const b = Math.floor((Date.parse(r.createdAt) - range.from.getTime()) / step);
    if (b >= 0 && b < SPARK_BUCKETS) series[b]++;
  }
  const seen = await shownCounts(pid, id, range);
  return { responses: list.length, shown: seen.shown, dismissed: seen.dismissed, questions: aggregate(s.questions, list), series, truncated };
}

async function shownCounts(pid: string, id: string, range: { from: Date; to: Date }): Promise<{ shown: number; dismissed: number }> {
  const params: unknown[] = [pid, range.from, range.to, id];
  const rows = await rawQuery<{ name: string; n: number }>(pid, range,
    `SELECT name, count(*)::int AS n FROM events
      WHERE project_id = $1 AND ts >= $2 AND ts < $3 AND type = 'custom' AND name IN ('survey_shown', 'survey_dismissed')
        AND json_extract_string(props, '$."props"."survey_id"') = $4
      GROUP BY name`,
    params,
  );
  const n = (k: string) => Number(rows.find((r) => r.name === k)?.n ?? 0);
  return { shown: n('survey_shown'), dismissed: n('survey_dismissed') };
}

/** GET /surveys/{id}/responses?from&to[&before][&limit]: newest first. `before` is the `next` of the previous page. */
export async function surveyResponses(pid: string, id: string, p: Record<string, string | undefined>): Promise<SurveyResponsesPage> {
  const range = parseRange(p, 30 * 86400_000);
  await row(pid, id);
  const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 1000);
  const params: unknown[] = [pid, id, range.from, range.to];
  let after = '';
  if (p.before) {
    const [t, rid] = p.before.split('|');
    const at = new Date(t);
    if (Number.isNaN(at.getTime()) || !isUuid(rid ?? '')) bad('Invalid `before`');
    params.push(at, rid);
    after = ' AND (created_at < $5 OR (created_at = $5 AND id < $6))';
  }
  const rows = await query<ResponseRow>(
    `SELECT id, created_at, anon_id, user_id, session_id, path, answers FROM survey_responses
      WHERE project_id = $1 AND survey_id = $2 AND created_at >= $3 AND created_at < $4${after}
      ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { responses: page.map(toResponse), next: rows.length > limit && last ? `${last.created_at.toISOString()}|${last.id}` : null };
}
