import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AnalyticsEvent, Span, TriggerWebhookPayload } from '../src/contract';
import { defaultSlackTemplate, renderSlackTemplate, sampleAggregate, sampleRows, slackMessage, slackTemplateProblem } from '../src/lib/slackTemplate';

const ev = (over: Partial<AnalyticsEvent> = {}): AnalyticsEvent => ({
  id: 'e1', type: 'error', ts: '2026-11-16T12:00:00.000Z', sessionId: 's', anonId: 'a', userId: 'u1', url: null, path: '/cart',
  title: null, referrer: null, selector: null, elementText: null, elementTag: null, trackName: null, errorMessage: 'Boom <b>', errorStack: null,
  errorSource: null, fingerprint: null, httpMethod: null, httpUrl: null, httpRoute: null, httpStatus: null, durationMs: null, name: null,
  props: { props: { plan: 'pro & co' } }, browser: 'Chrome', os: 'macOS', device: 'desktop', country: 'SE', region: null, city: 'Stockholm',
  lat: null, lon: null, bot: null, ...over,
});
const base: TriggerWebhookPayload = {
  trigger: { id: 't', name: 'Checkout errors' }, project: { id: 'p', name: 'Shop & co' }, firedAt: '2026-11-16T12:00:00.000Z', scope: 'events',
  matches: 2, events: [ev({ id: 'old', path: '/old' }), ev()], url: 'https://wgo.example.com/#/p/p/events',
};
const md = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const render = (blocks: Array<Record<string, unknown>>, p: TriggerWebhookPayload = base) => renderSlackTemplate({ blocks }, p)?.blocks;

describe('Slack message templates', () => {
  it('fills in variables, escaped in mrkdwn and as typed in plain text', () => {
    expect(render([
      { type: 'header', text: { type: 'plain_text', text: '{{ headline }} for {{project.name}}' } },
      md('{{summary}}: {{event.errorMessage}} on {{event.path}} ({{matches}})'),
    ])).toEqual([
      { type: 'header', text: { type: 'plain_text', text: '🔔 Checkout errors for Shop & co' } },
      md('2 matching events in *Shop &amp; co*: Boom &lt;b&gt; on /cart (2)'),
    ]);
  });

  it('shows when it fired in each reader’s time zone in mrkdwn, and in UTC in plain text', () => {
    const unix = Date.parse(base.firedAt) / 1000;
    expect(render([{ type: 'header', text: { type: 'plain_text', text: 'At {{time}}' } }, md('At {{time}}')])).toEqual([
      { type: 'header', text: { type: 'plain_text', text: 'At 2026-11-16 12:00 UTC' } },
      md(`At <!date^${unix}^{date_short_pretty} {time}|2026-11-16 12:00 UTC>`),
    ]);
  });

  it('reads fields of the most recent match, nested props and dotted attribute keys', () => {
    const span: Span = { traceId: 't', spanId: 's', parentSpanId: null, name: 'GET /pay', kind: 2, service: 'api', start: '', end: '', durationMs: 812, statusCode: 2, statusMessage: null, attributes: { 'http.route': '/pay/:id', 'http.status_code': 502 }, resource: {}, events: [] };
    expect(render([md('{{event.props.props.plan}} {{event.userId}} {{event.nope}}|')])).toEqual([md('pro &amp; co u1 |')]);
    expect(render([md('{{span.attributes.http.route}} {{span.attributes.http.status_code}} {{span.durationMs}}')], { ...base, scope: 'spans', events: [], spans: [span] }))
      .toEqual([md('/pay/:id 502 812')]);
  });

  it('lists recent matches, newest first', () => {
    expect(render([md('{{matches_list}}')])).toEqual([md('• error: Boom &lt;b&gt;  (/cart · Stockholm, SE)\n• error: Boom &lt;b&gt;  (/old · Stockholm, SE)')]);
  });

  it('leaves out blocks, buttons and fields that come out empty, and links that are not links', () => {
    const blocks = [
      md('{{explanation}}'),
      { type: 'section', fields: [{ type: 'mrkdwn', text: '*Path*\n{{event.path}}' }, { type: 'mrkdwn', text: '{{state}}' }], text: { type: 'mrkdwn', text: '{{value}}' } },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open' }, url: '{{url}}' }, { type: 'button', text: { type: 'plain_text', text: 'Docs' }, url: 'https://docs.example.com' }] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '{{state}}' }] },
      { type: 'image', image_url: '{{event.nope}}', alt_text: 'x' },
      { type: 'divider' },
    ];
    expect(render(blocks, { ...base, url: '' })).toEqual([
      { type: 'section', fields: [{ type: 'mrkdwn', text: '*Path*\n/cart' }] },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Docs' }, url: 'https://docs.example.com' }] },
      { type: 'divider' },
    ]);
    expect(renderSlackTemplate({ blocks: [md('{{state}}')] }, base)).toBeNull();
  });

  it('cuts text to what Slack accepts', () => {
    const [h, s, a] = render([
      { type: 'header', text: { type: 'plain_text', text: 'h'.repeat(200) } }, md('{{event.errorMessage}}'),
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'b'.repeat(100) }, url: '{{url}}' }] },
    ], { ...base, events: [ev({ errorMessage: 'x'.repeat(5000) })] })!;
    expect((h.text as { text: string }).text).toHaveLength(150);
    expect((s.text as { text: string }).text).toHaveLength(3000);
    expect(((a.elements as Array<{ text: { text: string } }>)[0]).text.text).toHaveLength(75);
  });

  it('has threshold/anomaly variables', () => {
    const p = { ...base, ...sampleAggregate({ kind: 'threshold', scope: 'events', metric: { agg: 'count' }, condition: { op: 'above', value: 20 }, windowMinutes: 15 }) } as TriggerWebhookPayload;
    expect(render([md('{{state}} {{value}} | {{summary}} | {{matches_list}}|')], p)).toEqual([md('firing 30 | Count in the last 15 minutes is 30, above 20. Project *Shop &amp; co*. | |')]);
    const resolved = { ...base, ...sampleAggregate({ kind: 'threshold', scope: 'events', metric: { agg: 'count' }, condition: { op: 'above', value: 20 }, windowMinutes: 15 }, 'resolved') } as TriggerWebhookPayload;
    expect(render([{ type: 'header', text: { type: 'plain_text', text: '{{headline}}' } }, md('{{explanation}}')], resolved)).toEqual([{ type: 'header', text: { type: 'plain_text', text: '✅ Resolved Checkout errors' } }]);
  });

  it('keeps the default message when a design renders to nothing', () => {
    expect(slackMessage(base, { blocks: [md('{{state}}')] })).toEqual(slackMessage(base));
    expect(slackMessage(base, defaultSlackTemplate('match'))).toEqual(slackMessage(base));
    const p = { ...base, scope: 'logs', ...sampleRows('logs') } as TriggerWebhookPayload;
    expect(slackMessage(p).blocks.map((b) => b.type)).toEqual(['header', 'section', 'section', 'actions']);
  });

  it('checks the shape of a design', () => {
    expect(slackTemplateProblem({ blocks: [md('x'), { type: 'divider' }] })).toBeNull();
    expect(slackTemplateProblem([])).toMatch(/blocks/);
    expect(slackTemplateProblem({ blocks: [] })).toMatch(/at least one/);
    expect(slackTemplateProblem({ blocks: Array.from({ length: 51 }, () => ({ type: 'divider' })) })).toMatch(/50/);
    expect(slackTemplateProblem({ blocks: [{ text: 'x' }] })).toBe('Block 1 needs a "type"');
    expect(slackTemplateProblem({ blocks: [{ type: 'input' }] })).toMatch(/"input" blocks aren't supported/);
    expect(slackTemplateProblem({ blocks: [md('x'.repeat(30_000))] })).toMatch(/too large/);
  });

  it('is the same code as the dashboard’s copy (its preview shows what is sent)', () => {
    const strip = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8').split('\n').slice(1).join('\n');
    expect(strip('../../dashboard/src/lib/slackTemplate.ts')).toBe(strip('../src/lib/slackTemplate.ts'));
  });
});
