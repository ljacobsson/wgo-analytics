/**
 * Install-wide switches admins set in the dashboard (they used to be deploy settings): the GitHub Agent, MCP (with the
 * Cognito client registration the MCP auth function controls) and the install's Slack app.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// the MCP auth function's view of Cognito: one pool, DCR as last set
const cognito = { dcr: undefined as unknown, updates: 0 };
vi.mock('@aws-sdk/client-cognito-identity-provider', () => {
  class Cmd { constructor(public input: Record<string, unknown>) {} }
  return {
    CognitoIdentityProviderClient: class {
      async send(c: Cmd) {
        if (c.constructor.name === 'UpdateUserPoolCommand') { cognito.dcr = c.input.DcrConfiguration; cognito.updates++; return {}; }
        return { UserPool: { Id: 'eu-west-1_pool', Name: 'wgo', DcrConfiguration: cognito.dcr } };
      }
    },
    DescribeUserPoolCommand: class DescribeUserPoolCommand extends Cmd {},
    UpdateUserPoolCommand: class UpdateUserPoolCommand extends Cmd {},
    ResourceNotFoundException: class extends Error {},
  };
});

const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('install settings (PostgreSQL)', async () => {
  if (!process.env.DATABASE_URL) return;
  const BASE = process.env.DATABASE_URL;
  const isolated = new URL(BASE);
  isolated.searchParams.set('options', '-c search_path=install_test');
  process.env.DATABASE_URL = isolated.toString();
  delete process.env.SECRET_PREFIX;
  delete process.env.MCP_AUTH_FUNCTION;
  delete process.env.SLACK_CLIENT_ID;
  delete process.env.SLACK_CLIENT_SECRET;
  const { Client } = await import('pg');
  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const api = (await import('../src/handlers/api')).handler;
  const IS = await import('../src/lib/installSettings');
  const mcpauth = (await import('../src/handlers/mcpauth')).handler;

  const ADMIN = 'admin@example.com', MEMBER = 'member@example.com';
  const ev = (method: string, path: string, body?: object, email = ADMIN) => ({
    rawPath: path, headers: { origin: 'https://wgo.example.com' }, queryStringParameters: {}, body: body && JSON.stringify(body), isBase64Encoded: false,
    requestContext: { http: { method }, domainName: 'api.example.com', authorizer: { jwt: { claims: { email } } } },
  }) as unknown as APIGatewayProxyEventV2;
  const call = async (method: string, path: string, body?: object, email = ADMIN) => {
    IS.forgetSettings();
    const res = (await api(ev(method, path, body, email) as never)) as APIGatewayProxyStructuredResultV2;
    return { status: res.statusCode!, body: JSON.parse(res.body as string) };
  };
  const cfn = async (type: 'Create' | 'Update', old?: Record<string, unknown>) => {
    const put = vi.fn(async () => new Response(''));
    vi.stubGlobal('fetch', put);
    IS.forgetSettings();
    await mcpauth({
      RequestType: type, ResponseURL: 'https://cfn.example/response', StackId: 's', RequestId: 'r', LogicalResourceId: 'McpAuth', ResourceType: 'Custom::CognitoMcpAuth', ServiceToken: 't',
      ResourceProperties: { ServiceToken: 't', UserPoolId: 'eu-west-1_pool', AllowedScopes: ['https://wgo.example.com/mcp/read'] },
      ...(type === 'Update' ? { PhysicalResourceId: 'p', OldResourceProperties: old ?? {} } : {}),
    } as never, { logStreamName: 'log' } as never);
    vi.unstubAllGlobals();
    return JSON.parse((put.mock.calls[0] as unknown as [string, { body: string }])[1].body) as { Status: string };
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS install_test CASCADE');
    await admin.query('CREATE SCHEMA install_test');
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    process.env.ADMIN_EMAILS = ADMIN;
    await call('POST', '/api/projects', { name: 'P' });
  });
  afterAll(async () => { delete process.env.ADMIN_EMAILS; await closeDb(); });

  it('starts with everything off and shows admins only', async () => {
    expect((await call('GET', '/api/me')).body.features).toEqual({ fixAgent: false, mcp: false, slackApp: false });
    expect((await call('GET', '/api/install', undefined, MEMBER)).status).toBe(403);
    expect((await call('PATCH', '/api/install/mcp', { enabled: true }, MEMBER)).status).toBe(403);
    expect((await call('PATCH', '/api/fix-agent', { enabled: true }, MEMBER)).status).toBe(403);
    const i = (await call('GET', '/api/install')).body;
    expect(i).toMatchObject({ fixAgent: false, mcp: false, slackApp: false, mcpUrl: 'https://wgo.example.com/mcp', slack: { clientId: null, secretSet: false, redirectUrl: 'https://api.example.com/slack/callback' } });
  });

  it('turns the GitHub Agent on and off', async () => {
    expect((await call('PATCH', '/api/fix-agent', { enabled: 'yes' })).status).toBe(400);
    const on = await call('PATCH', '/api/fix-agent', { enabled: true });
    expect(on.body).toMatchObject({ enabled: true, config: { updatedBy: null } }); // the switch alone leaves the model settings alone
    expect((await call('GET', '/api/me', undefined, MEMBER)).body.features.fixAgent).toBe(true);
    await call('PATCH', '/api/fix-agent', { enabled: false });
    expect((await call('GET', '/api/me')).body.features.fixAgent).toBe(false);
  });

  it('keeps MCP as installs had it, and as admins set it', async () => {
    // an install upgraded from the EnableMcp parameter (default on) keeps MCP on
    expect((await cfn('Update', { UserPoolId: 'eu-west-1_pool', Enabled: 'true' })).Status).toBe('SUCCESS');
    expect(cognito.dcr).toMatchObject({ EnableStatus: 'Enabled', OpenDcrEnabled: true, AllowedScopes: ['https://wgo.example.com/mcp/read'] });
    expect((await call('GET', '/api/me')).body.features.mcp).toBe(true);
    // the API flips it through the MCP auth function (locally: the setting only); here the function itself
    IS.forgetSettings();
    expect(await mcpauth({ action: 'set', enabled: false } as never, {} as never)).toEqual({ enabled: false });
    expect(cognito.dcr).toEqual({ EnableStatus: 'Disabled' });
    // a redeploy keeps the admins' choice, whatever the old parameter said
    await cfn('Update', { UserPoolId: 'eu-west-1_pool', Enabled: 'true' });
    expect(cognito.dcr).toEqual({ EnableStatus: 'Disabled' });
    expect(await IS.getSetting('mcp')).toMatchObject({ enabled: false, userPoolId: 'eu-west-1_pool', scopes: ['https://wgo.example.com/mcp/read'] });
    // without the function (local development) the API just saves it
    expect((await call('PATCH', '/api/install/mcp', { enabled: true })).body.mcp).toBe(true);
    expect(await IS.mcpOn()).toBe(true);
  });

  it('starts new installs with MCP off', async () => {
    await query(`DELETE FROM install_settings WHERE key = 'mcp'`);
    await cfn('Create');
    expect(cognito.dcr).toEqual({ EnableStatus: 'Disabled' });
    expect((await call('GET', '/api/me')).body.features.mcp).toBe(false);
  });

  it('saves the install’s Slack app after Slack accepts it', async () => {
    const slack = vi.fn(async (_u: string, init: { body: URLSearchParams }) => {
      const id = init.body.get('client_id'), secret = init.body.get('client_secret');
      const error = id !== '1234567890.9876543210' ? 'invalid_client_id' : secret !== 'b'.repeat(32) ? 'bad_client_secret' : 'invalid_code';
      return new Response(JSON.stringify({ ok: false, error }));
    });
    vi.stubGlobal('fetch', slack);
    try {
      expect((await call('PUT', '/api/install/slack', { clientId: 'nope', clientSecret: 'b'.repeat(32) })).body.error).toMatch(/client ID/);
      expect((await call('PUT', '/api/install/slack', { clientId: '1111111111.2222222222', clientSecret: 'b'.repeat(32) })).body.error).toMatch(/doesn’t know that client ID/);
      expect((await call('PUT', '/api/install/slack', { clientId: '1234567890.9876543210', clientSecret: 'c'.repeat(32) })).body.error).toMatch(/doesn’t belong to this app/);
      const ok = await call('PUT', '/api/install/slack', { clientId: '1234567890.9876543210', clientSecret: 'b'.repeat(32) });
      expect(ok.body).toMatchObject({ slackApp: true, slack: { clientId: '1234567890.9876543210', secretSet: true } });
      expect(JSON.stringify(ok.body)).not.toContain('b'.repeat(32));
      IS.forgetSettings();
      expect(await IS.slackApp()).toEqual({ clientId: '1234567890.9876543210', clientSecret: 'b'.repeat(32) });
      // "Add to Slack" works in every project now
      const { setupStatus } = await import('../src/lib/slack');
      const [{ id: pid }] = (await call('GET', '/api/projects')).body;
      expect((await setupStatus(pid, 'api.example.com')).addToSlack).toBe(true);
      // a new id with the saved secret
      expect((await call('PUT', '/api/install/slack', { clientId: '1234567890.9876543210' })).status).toBe(200);
      const gone = await call('DELETE', '/api/install/slack');
      expect(gone.body).toMatchObject({ slackApp: false, slack: { clientId: null, secretSet: false } });
      IS.forgetSettings();
      expect(await IS.slackApp()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
