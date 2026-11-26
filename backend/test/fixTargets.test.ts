import { describe, expect, it } from 'vitest';
import { stackFiles } from '../src/lib/fixAgent/context';
import { backendFingerprint, parseTarget, topFrame } from '../src/lib/fixAgent/targets';

const NODE = 'TypeError: Cannot read properties of undefined (reading \'id\')\n    at loadOrder (/var/task/src/orders.ts:41:17)\n    at async handler (/var/task/src/api.ts:12:5)';
const PY = 'Traceback (most recent call last):\n  File "/app/shop/orders.py", line 88, in load_order\n    return db.get(order_id).id\nAttributeError: \'NoneType\' object has no attribute \'id\'';
const JAVA = 'java.lang.NullPointerException: order\n\tat com.acme.shop.Orders.load(Orders.java:40)\n\tat com.acme.shop.Api.handle(Api.java:12)';
const GO = 'panic: runtime error: invalid memory address\n\ngoroutine 1 [running]:\nmain.loadOrder(...)\n\t/src/orders.go:31 +0x1d';

describe('backend error fingerprints', () => {
  it('finds the top frame without line numbers, in several languages', () => {
    expect(topFrame(NODE)).toBe('at loadOrder (/var/task/src/orders.ts)');
    expect(topFrame(PY)).toBe('File "/app/shop/orders.py", in load_order');
    expect(topFrame(JAVA)).toBe('at com.acme.shop.Orders.load(Orders.java)');
    expect(topFrame(GO)).toBe('/src/orders.go');
    expect(topFrame('no frames here')).toBeNull();
  });

  it('is the same for repeats and different across services, kinds and frames', () => {
    const a = backendFingerprint('span', 'orders', 'Order 4411 not found', NODE);
    expect(a).toMatch(/^span:[0-9a-f]{16}$/);
    expect(backendFingerprint('span', 'orders', 'Order 9 not found', NODE.replace(':41:17', ':43:2'))).toBe(a);
    expect(backendFingerprint('span', 'billing', 'Order 9 not found', NODE)).not.toBe(a);
    expect(backendFingerprint('log', 'orders', 'Order 9 not found', NODE)).not.toBe(a);
    expect(backendFingerprint('span', 'orders', 'Order 9 not found', NODE.replace('loadOrder', 'saveOrder'))).not.toBe(a);
  });

  it('lists files with lines from stacks, skipping dependencies', () => {
    expect(stackFiles(NODE)).toEqual([{ file: '/var/task/src/orders.ts', line: 41 }, { file: '/var/task/src/api.ts', line: 12 }]);
    expect(stackFiles(PY)).toEqual([{ file: '/app/shop/orders.py', line: 88 }]);
    expect(stackFiles(JAVA)).toEqual([{ file: 'Orders.java', line: 40 }, { file: 'Api.java', line: 12 }]);
    expect(stackFiles(GO)).toEqual([{ file: '/src/orders.go', line: 31 }]);
    expect(stackFiles('at x (/app/node_modules/pg/lib/client.js:10:2)\n  File "/usr/lib/python3/site-packages/a.py", line 3')).toEqual([]);
  });

  it('reads targets from request bodies', () => {
    expect(parseTarget({ fingerprint: 'abc' })).toEqual({ kind: 'browser', fingerprint: 'abc' });
    expect(parseTarget({ kind: 'span', traceId: 't', spanId: 's', at: '2026-01-01T00:00:00Z' })).toEqual({ kind: 'span', traceId: 't', spanId: 's', at: '2026-01-01T00:00:00Z' });
    expect(parseTarget({ kind: 'log', logId: 'l', at: 'x' })).toEqual({ kind: 'log', logId: 'l', at: 'x' });
    expect(() => parseTarget({})).toThrow(/fingerprint/);
    expect(() => parseTarget({ kind: 'metric' })).toThrow(/kind/);
  });
});

describe('tools by kind', () => {
  it('offers browser occurrences only for browser errors, and logs for every kind', async () => {
    const { fixTools } = await import('../src/lib/fixAgent/tools');
    const { Workspace } = await import('../src/lib/fixAgent/workspace');
    const names = (kind: 'browser' | 'span' | 'log') => fixTools(new Workspace('/tmp', []), 'p', { kind, fingerprint: 'x' }, () => {}).map((t) => t.name);
    expect(names('browser')).toEqual(expect.arrayContaining(['get_error_occurrences', 'search_logs', 'get_trace', 'submit_result']));
    for (const k of ['span', 'log'] as const) {
      expect(names(k)).not.toContain('get_error_occurrences');
      expect(names(k)).toEqual(expect.arrayContaining(['search_logs', 'get_trace', 'read_file', 'edit_file', 'submit_result']));
    }
  });
});

describe('routing errors to repositories', () => {
  it('sends spans and logs by service, browser errors to the web app, the rest to the first', async () => {
    const { routeRepo } = await import('../src/lib/fixes');
    const repo = (fullName: string, browser: boolean, services: string[]) => ({ fullName, browser, services, baseBranch: null, rootPath: null, instructions: null, deniedPaths: [] });
    const repos = [repo('acme/platform', false, ['gateway']), repo('acme/web', true, []), repo('acme/api', false, ['billing-*', 'Orders'])];
    expect(routeRepo(repos, 'browser', null)?.fullName).toBe('acme/web');
    expect(routeRepo(repos, 'span', 'billing-worker')?.fullName).toBe('acme/api');
    expect(routeRepo(repos, 'log', 'orders')?.fullName).toBe('acme/api');
    expect(routeRepo(repos, 'span', 'billing')?.fullName).toBe('acme/platform'); // billing-* needs the dash
    expect(routeRepo(repos, 'span', 'search')?.fullName).toBe('acme/platform');
    expect(routeRepo([repo('acme/api', false, [])], 'browser', null)?.fullName).toBe('acme/api');
    expect(routeRepo([], 'span', 'x')).toBeNull();
  });
});
