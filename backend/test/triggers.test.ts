import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AnalyticsEvent, LogRecord, Span } from '../src/contract';
import { matchesAll } from '../src/lib/filterMatch';
import { createAppUrl, peekStateProject, signState, verifyState } from '../src/lib/slack';
import { assertPublicHttpsUrl, dashboardOrigin, matchesLink, sign, slackMessage } from '../src/lib/triggers';

const ev = (over: Partial<AnalyticsEvent> = {}): AnalyticsEvent => ({
  id: 'e1', type: 'click', ts: '2026-11-16T12:00:00.000Z', sessionId: 's', anonId: 'a', userId: null, url: 'https://shop.test/cart', path: '/cart',
  title: null, referrer: null, selector: 'button.buy', elementText: 'Buy now', elementTag: 'button', trackName: 'buy', errorMessage: null, errorStack: null,
  errorSource: null, fingerprint: null, httpMethod: null, httpUrl: null, httpRoute: null, httpStatus: null, durationMs: null, name: null,
  props: { rage: 3, props: { plan: 'pro', value: 120 } }, browser: 'Chrome', os: 'macOS', device: 'desktop', country: 'SE', region: null, city: 'Stockholm',
  lat: 59.3, lon: 18.1, bot: null, ...over,
});

describe('webhook URL guard', () => {
  it('accepts public https URLs', () => {
    expect(assertPublicHttpsUrl('https://hooks.slack.com/services/T/B/x').hostname).toBe('hooks.slack.com');
    expect(assertPublicHttpsUrl('https://example.com:8443/hook?x=1').port).toBe('8443');
  });
  it.each([
    'http://example.com/hook', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.1/x',
    'https://172.16.3.3/x', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://[fd00::1]/x', 'https://intranet/x',
    'https://db.internal/x', 'https://user:pw@example.com/x', 'ftp://example.com', 'not a url',
  ])('rejects %s', (url) => expect(() => assertPublicHttpsUrl(url)).toThrow());
});

describe('notifications', () => {
  it('signs webhook bodies with HMAC-SHA256', () => {
    const body = JSON.stringify({ a: 1 });
    expect(sign('whsec_x', body)).toBe('sha256=' + createHmac('sha256', 'whsec_x').update(body).digest('hex'));
  });

  it('formats a Slack message with a header, summary, recent matches and a link', () => {
    const msg = slackMessage({
      trigger: { id: 't', name: 'Checkout errors' }, project: { id: 'p', name: 'Shop <prod>' }, firedAt: '', scope: 'events', matches: 7,
      events: [ev(), ev({ id: 'e2', type: 'http_error', httpMethod: 'POST', httpRoute: '/api/pay', httpStatus: 502, elementText: null })],
      url: 'https://wgo.example.com/#/p/p/events',
    }) as { text: string; blocks: Array<{ type: string; text?: { text: string }; elements?: Array<{ url: string }> }> };
    expect(msg.text).toBe('🔔 Checkout errors: 7 matching events');
    expect(msg.blocks.map((b) => b.type)).toEqual(['header', 'section', 'section', 'actions']);
    expect(msg.blocks[1].text!.text).toContain('Shop &lt;prod&gt;'); // escaped for mrkdwn
    expect(msg.blocks[2].text!.text).toMatch(/POST \/api\/pay → 502[\s\S]*click “buy”/); // newest first
    expect(msg.blocks[3].elements![0].url).toBe('https://wgo.example.com/#/p/p/events');
  });

  it('describes log records and spans for log and span triggers', () => {
    const log: LogRecord = { id: 'l1', ts: '', severityNumber: 17, severityText: null, body: 'payment\n  declined', service: 'checkout', traceId: null, spanId: null, attributes: {}, resource: {} };
    const span: Span = { traceId: 't', spanId: 's', parentSpanId: null, name: 'POST /pay', kind: 2, service: 'api', start: '', end: '', durationMs: 2500, statusCode: 2, statusMessage: 'boom', attributes: {}, resource: {}, events: [] };
    const base = { trigger: { id: 't', name: 'Pay' }, project: { id: 'p', name: 'Shop' }, firedAt: '', events: [], url: '' };
    const logMsg = slackMessage({ ...base, scope: 'logs', matches: 1, logs: [log] }) as { text: string; blocks: Array<{ text?: { text: string } }> };
    expect(logMsg.text).toBe('🔔 Pay: 1 matching log record');
    expect(logMsg.blocks[2].text!.text).toBe('• [ERROR] checkout: payment declined');
    const spanMsg = slackMessage({ ...base, scope: 'spans', matches: 3, spans: [span] }) as { text: string; blocks: Array<{ text?: { text: string } }> };
    expect(spanMsg.text).toBe('🔔 Pay: 3 matching spans');
    expect(spanMsg.blocks[2].text!.text).toBe('• api: POST /pay · 2.50 s · error: boom');
  });

  it('links to the page of the trigger’s scope with its filters applied', () => {
    const f = [{ field: 'service', op: 'eq' as const, value: 'api' }];
    expect(matchesLink('https://w.test', 'p', f, 'logs')).toBe(`https://w.test/#/p/p/logs?range=24h&lf=${encodeURIComponent(JSON.stringify(f))}`);
    expect(matchesLink('https://w.test', 'p', f, 'spans')).toMatch(/\/#\/p\/p\/traces\?range=24h&tf=/);
    expect(matchesLink('https://w.test', 'p', f)).toMatch(/\/#\/p\/p\/events\?range=24h&f=/);
    expect(matchesLink(null, 'p', f, 'logs')).toBe('');
  });

  it('only keeps https (or local http) dashboard origins for links', () => {
    expect(dashboardOrigin('https://wgo.example.com')).toBe('https://wgo.example.com');
    expect(dashboardOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(dashboardOrigin('http://evil.example.com')).toBeNull();
    expect(dashboardOrigin('javascript:alert(1)')).toBeNull();
    expect(dashboardOrigin(undefined)).toBeNull();
  });
});

describe('Slack install state', () => {
  it('round-trips and rejects tampering, expiry and other apps’ secrets', () => {
    const state = signState('secret-1', 'pid-1', 'me@example.com', 'https://wgo.example.com', 1_000);
    expect(peekStateProject(state)).toBe('pid-1');
    expect(verifyState('secret-1', state, 2_000)).toEqual({ pid: 'pid-1', email: 'me@example.com', returnTo: 'https://wgo.example.com', level: 'project' });
    // "Add to Slack" for your own destinations carries the level through Slack and back
    const mine = signState('secret-1', 'pid-1', 'me@example.com', null, 1_000, 'account');
    expect(verifyState('secret-1', mine, 2_000)).toMatchObject({ pid: 'pid-1', level: 'account' });
    const [data, sig] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ p: 'other', e: 'x', r: null, x: 9e15 })).toString('base64url');
    expect(() => verifyState('secret-1', `${forged}.${sig}`, 2_000)).toThrow(/signature/);
    expect(() => verifyState('secret-1', `${data}.${sig}`, 1_000 + 16 * 60_000)).toThrow(/expired/);
    expect(() => verifyState('rotated', state, 2_000)).toThrow(/signature/);
    expect(peekStateProject('garbage')).toBeNull();
  });

  it('builds a pre-filled Slack app manifest link with our redirect URL', () => {
    const url = new URL(createAppUrl('abc.execute-api.eu-west-1.amazonaws.com'));
    expect(url.origin + url.pathname).toBe('https://api.slack.com/apps');
    expect(url.searchParams.get('new_app')).toBe('1');
    const manifest = JSON.parse(url.searchParams.get('manifest_json')!);
    expect(manifest.oauth_config).toEqual({
      redirect_urls: ['https://abc.execute-api.eu-west-1.amazonaws.com/slack/callback'],
      scopes: { bot: ['chat:write', 'chat:write.public', 'channels:read', 'groups:read'] },
    });
    // the bot token must not expire
    expect(manifest.settings.token_rotation_enabled).toBe(false);
    expect(manifest.display_information.name).toBe('WGO');
    // Slack refuses bot scopes without a bot user
    expect(manifest.features.bot_user.display_name).toBe('WGO');
  });
});

describe('in-memory filter matching', () => {
  it('evaluates the same operators as SQL', () => {
    const e = ev();
    expect(matchesAll(e, [{ field: 'type', op: 'eq', value: 'click' }, { field: 'trackName', op: 'eq', value: 'buy' }])).toBe(true);
    expect(matchesAll(e, [{ field: 'elementText', op: 'contains', value: 'BUY' }])).toBe(true);
    expect(matchesAll(e, [{ field: 'path', op: 'starts_with', value: '/ca' }, { field: 'path', op: 'ends_with', value: 'rt' }])).toBe(true);
    expect(matchesAll(e, [{ field: 'props.props.value', op: 'gt', value: '100' }])).toBe(true);
    expect(matchesAll(e, [{ field: 'props.props.value', op: 'lte', value: '100' }])).toBe(false);
    expect(matchesAll(e, [{ field: 'props.props.plan', op: 'gt', value: '5' }])).toBe(false); // non-numeric never matches a number compare
    expect(matchesAll(e, [{ field: 'props.rage', op: 'set' }, { field: 'userId', op: 'not_set' }])).toBe(true);
    expect(matchesAll(e, [{ field: 'httpStatus', op: 'neq', value: '500' }])).toBe(true); // NULL is distinct from 500
    expect(matchesAll(e, [{ field: 'elementText', op: 'not_contains', value: 'buy' }])).toBe(false);
    expect(matchesAll(ev({ httpStatus: 503, type: 'http_error' }), [{ field: 'httpStatus', op: 'gte', value: '500' }])).toBe(true);
    expect(matchesAll(e, [{ field: 'nope', op: 'set' }])).toBe(false);
  });

  it('matches log records and spans, with OTel attribute keys kept whole', () => {
    const log: LogRecord = {
      id: 'l1', ts: '', severityNumber: 17, severityText: 'ERROR', body: 'Payment declined for order 42', service: 'checkout',
      traceId: 'abc', spanId: null, attributes: { 'http.route': '/pay', retries: 3, user: { id: 'u1' } }, resource: { 'service.version': '1.2.0' },
    };
    expect(matchesAll(log, [{ field: 'severityNumber', op: 'gte', value: '17' }, { field: 'service', op: 'eq', value: 'checkout' }], 'logs')).toBe(true);
    expect(matchesAll(log, [{ field: 'body', op: 'starts_with', value: 'payment declined' }], 'logs')).toBe(true);
    expect(matchesAll(log, [{ field: 'attributes.http.route', op: 'eq', value: '/pay' }], 'logs')).toBe(true);
    expect(matchesAll(log, [{ field: 'attributes.retries', op: 'gt', value: '2' }], 'logs')).toBe(true);
    expect(matchesAll(log, [{ field: 'attributes.user', op: 'eq', value: '{"id":"u1"}' }], 'logs')).toBe(true); // jsonb #>> text
    expect(matchesAll(log, [{ field: 'resource.service.version', op: 'eq', value: '1.2.0' }], 'logs')).toBe(true);
    expect(matchesAll(log, [{ field: 'spanId', op: 'not_set' }], 'logs')).toBe(true);
    expect(matchesAll(log, [{ field: 'severityNumber', op: 'eq', value: 'ERROR' }], 'logs')).toBe(false); // numeric field, text value
    expect(matchesAll(log, [{ field: 'type', op: 'set' }], 'logs')).toBe(false); // an events field means nothing for logs

    const span: Span = {
      traceId: 't', spanId: 's', parentSpanId: null, name: 'POST /pay', kind: 2, service: 'api', start: '', end: '', durationMs: 812.5,
      statusCode: 2, statusMessage: 'boom', attributes: { 'http.status_code': 502 }, resource: {}, events: [],
    };
    expect(matchesAll(span, [{ field: 'statusCode', op: 'eq', value: '2' }, { field: 'durationMs', op: 'gt', value: '500' }], 'spans')).toBe(true);
    expect(matchesAll(span, [{ field: 'attributes.http.status_code', op: 'gte', value: '500' }], 'spans')).toBe(true);
    expect(matchesAll(span, [{ field: 'name', op: 'contains', value: '/PAY' }], 'spans')).toBe(true);
    expect(matchesAll(span, [{ field: 'kind', op: 'eq', value: '3' }], 'spans')).toBe(false);
  });
});
