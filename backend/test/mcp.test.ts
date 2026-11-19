import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mcpFetch, readScope, type McpAuthConfig } from '../src/lib/mcp/http';
import { windowParams } from '../src/lib/mcp/tools';
import { dcrConfig, updateRequest } from '../src/handlers/mcpauth';

const ORIGIN = 'https://wgo.example.com';
const RESOURCE = `${ORIGIN}/mcp`;
const SCOPE = readScope(RESOURCE);

/** Fake Cognito: tokens are `aud|scope1,scope2|username`, or `bad` for a signature failure. */
const auth: McpAuthConfig = {
  cognitoDomain: 'wgo-1a2b3c4d.auth.eu-west-1.amazoncognito.com',
  cognitoIssuer: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_abc',
  verifier: {
    async verifyAccessToken(token) {
      if (token === 'bad') throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid signature');
      const [aud, scope, username] = token.split('|');
      return {
        token, clientId: 'dcr-client', scopes: scope.split(','), expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource: aud ? new URL(aud) : undefined, extra: { username },
      } satisfies AuthInfo;
    },
  },
  resolveEmail: async (info) => (info.extra?.username === 'ghost' ? null : `${info.extra?.username}@example.com`),
};

const listTools = (token?: string, headers: Record<string, string> = {}) =>
  mcpFetch(
    new Request(RESOURCE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25',
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
    { publicOrigin: ORIGIN, auth },
  );

describe('MCP OAuth discovery', () => {
  it('serves RFC 9728 protected resource metadata pointing at this origin as the authorization server', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const res = await mcpFetch(new Request(`${ORIGIN}${path}`), { publicOrigin: ORIGIN, auth });
      expect(res.status).toBe(200);
      const doc = await res.json();
      expect(doc.resource).toBe(RESOURCE);
      expect(doc.authorization_servers).toEqual([ORIGIN]);
      expect(doc.scopes_supported).toEqual([SCOPE]);
    }
  });

  it('describes Cognito managed login, token and DCR endpoints in RFC 8414 metadata', async () => {
    const res = await mcpFetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), { publicOrigin: ORIGIN, auth });
    expect(res.status).toBe(200);
    const doc = await res.json();
    const as = `https://${auth.cognitoDomain}`;
    expect(doc).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${as}/oauth2/authorize`,
      token_endpoint: `${as}/oauth2/token`,
      registration_endpoint: `${as}/oauth2/register`,
      jwks_uri: `${auth.cognitoIssuer}/.well-known/jwks.json`,
      code_challenge_methods_supported: ['S256'],
    });
    expect(doc.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('has no discovery documents in local development', async () => {
    const res = await mcpFetch(new Request('http://localhost:8787/.well-known/oauth-protected-resource/mcp'), { publicOrigin: 'http://localhost:8787', auth: null });
    expect(res.status).toBe(404);
  });
});

describe('MCP bearer auth', () => {
  it('challenges unauthenticated requests with the resource metadata URL and scope', async () => {
    const res = await listTools();
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate')!;
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect(challenge).toContain(`scope="${SCOPE}"`);
  });

  it('rejects invalid tokens and tokens issued for another resource (RFC 8707 audience)', async () => {
    expect((await listTools('bad')).status).toBe(401);
    expect((await listTools(`https://evil.example/mcp|${SCOPE}|alice`)).status).toBe(401);
    expect((await listTools(`|${SCOPE}|alice`)).status).toBe(401); // no aud: token not bound to any resource
  });

  it('answers insufficient_scope when the read scope is missing', async () => {
    const res = await listTools(`${RESOURCE}|openid,email|alice`);
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('insufficient_scope');
  });

  it('rejects users that no longer exist', async () => {
    expect((await listTools(`${RESOURCE}|${SCOPE}|ghost`)).status).toBe(401);
  });

  it('enforces the email-domain allowlist', async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.test';
    const res = await listTools(`${RESOURCE}|${SCOPE}|alice`);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('@corp.test');
  });

  it('serves MCP for a valid token', async () => {
    const res = await listTools(`${RESOURCE}|openid,${SCOPE}|alice`);
    expect(res.status).toBe(200);
    const body = await res.text();
    const msg = JSON.parse(body.startsWith('{') ? body : body.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
    const names = msg.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('list_projects');
    expect(names).toContain('get_trace');
    const find = msg.result.tools.find((t: { name: string }) => t.name === 'find_recordings');
    expect(find.inputSchema.properties.did.items.properties.action.enum).toEqual(['hover', 'click', 'rage_click', 'pageview', 'event', 'error']);
    expect(find.inputSchema.properties.did.items.properties).toHaveProperty('notClicked');
    // the only tool that writes is naming a click target, and it's marked as such
    const writes = msg.result.tools.filter((t: { annotations?: { readOnlyHint?: boolean } }) => !t.annotations?.readOnlyHint);
    expect(writes.map((t: { name: string }) => t.name)).toEqual(['set_click_alias']);
    expect(writes[0].annotations).toMatchObject({ destructiveHint: false, idempotentHint: true });
  });

  it('only accepts browser origins of its own host or localhost', async () => {
    const token = `${RESOURCE}|${SCOPE}|alice`;
    expect((await listTools(token, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await listTools(token, { origin: ORIGIN })).status).toBe(200);
    expect((await listTools(token, { origin: 'http://localhost:6274' })).status).toBe(200); // MCP Inspector
  });

  afterEach(() => {
    delete process.env.ALLOWED_EMAIL_DOMAINS;
  });
});

describe('MCP tool arguments', () => {
  it('turns a relative range into from/to', () => {
    const q = windowParams({ range: '2h', to: '2026-01-01T12:00:00.000Z' });
    expect(q).toEqual({ from: '2026-01-01T10:00:00.000Z', to: '2026-01-01T12:00:00.000Z' });
    expect(windowParams({ range: '7d', from: '2025-12-01T00:00:00Z' }).from).toBe('2025-12-01T00:00:00Z'); // explicit from wins
    expect(windowParams({})).toEqual({ from: undefined, to: undefined });
  });
});

describe('MCP Lambda glue', () => {
  let lambda: typeof import('../src/handlers/mcp');
  beforeAll(async () => {
    process.env.USER_POOL_ID = 'eu-west-1_abc';
    process.env.COGNITO_DOMAIN = 'wgo-x.auth.eu-west-1.amazoncognito.com';
    process.env.EDGE_SECRET = 'edge-secret';
    lambda = await import('../src/handlers/mcp');
  });

  const event = (headers: Record<string, string>) =>
    ({
      rawPath: '/mcp', rawQueryString: '', headers, body: Buffer.from('{"a":1}').toString('base64'), isBase64Encoded: true,
      requestContext: { domainName: 'abc123.execute-api.eu-west-1.amazonaws.com', http: { method: 'POST' } },
    }) as unknown as APIGatewayProxyEventV2;

  it('trusts the forwarded host only with the CloudFront edge secret', () => {
    expect(lambda.publicOrigin(event({ 'x-forwarded-host': 'wgo.example.com', 'x-wgo-edge': 'edge-secret' }))).toBe('https://wgo.example.com');
    expect(lambda.publicOrigin(event({ 'x-forwarded-host': 'evil.example' }))).toBe('https://abc123.execute-api.eu-west-1.amazonaws.com');
  });

  it('converts API Gateway events to fetch Requests', async () => {
    const req = lambda.toRequest(event({ authorization: 'Bearer t', 'content-type': 'application/json' }), ORIGIN);
    expect(req.url).toBe(RESOURCE);
    expect(req.headers.get('authorization')).toBe('Bearer t');
    expect(await req.text()).toBe('{"a":1}');
  });

  it('answers 401 with a challenge through the real handler when no token is sent', async () => {
    const res = await lambda.handler(event({ 'content-type': 'application/json', 'x-forwarded-host': 'wgo.example.com', 'x-wgo-edge': 'edge-secret' }));
    expect(res.statusCode).toBe(401);
    expect(res.headers!['www-authenticate']).toContain('https://wgo.example.com/.well-known/oauth-protected-resource/mcp');
  });
});

describe('Cognito MCP auth custom resource', () => {
  it('enables open registration for the authorization code grant with the MCP scope', () => {
    expect(dcrConfig(true, [SCOPE])).toEqual({
      EnableStatus: 'Enabled', OpenDcrEnabled: true, OpenDcrGrantTypes: ['code'], AuthenticatedGrantTypes: ['code'], AllowedScopes: [SCOPE],
    });
    expect(dcrConfig(false, [SCOPE])).toEqual({ EnableStatus: 'Disabled' });
  });

  it('sends the current pool settings back unchanged next to the DCR configuration', () => {
    const req = updateRequest(
      {
        Id: 'eu-west-1_abc', Name: 'wgo-users', Arn: 'arn:…', EstimatedNumberOfUsers: 3, UsernameAttributes: ['email'], Domain: 'wgo-x',
        Policies: { PasswordPolicy: { MinimumLength: 8 } }, AutoVerifiedAttributes: ['email'], UserPoolTier: 'ESSENTIALS',
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: false }, LambdaConfig: { PreSignUp: 'arn:fn' }, MfaConfiguration: 'OFF',
      },
      dcrConfig(true, [SCOPE]),
    );
    expect(req).toEqual({
      UserPoolId: 'eu-west-1_abc', PoolName: 'wgo-users', DcrConfiguration: dcrConfig(true, [SCOPE]),
      Policies: { PasswordPolicy: { MinimumLength: 8 } }, AutoVerifiedAttributes: ['email'], UserPoolTier: 'ESSENTIALS',
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false }, LambdaConfig: { PreSignUp: 'arn:fn' }, MfaConfiguration: 'OFF',
    });
  });
});
