import {
  bearerAuthChallengeResponse, buildOAuthProtectedResourceMetadata, createMcpHandler, getOAuthProtectedResourceMetadataUrl,
  localhostAllowedOrigins, OAuthError, OAuthErrorCode, oauthMetadataResponse, originValidationResponse, verifyBearerToken,
  type AuthInfo, type AuthMetadataOptions, type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { allowlistMessage, emailAllowed } from '../allowlist';
import { buildMcpServer } from './tools';

/**
 * WGO's MCP endpoint as a web-standard fetch handler, shared by the Lambda (handlers/mcp.ts) and the local
 * dev server. Routes:
 *
 *   POST /mcp                                        Streamable HTTP, stateless (2026-07-28 + 2025-era clients)
 *   GET  /.well-known/oauth-protected-resource[/mcp] RFC 9728: the resource (= the /mcp URL) and its authorization server
 *   GET  /.well-known/oauth-authorization-server     RFC 8414 metadata describing Cognito's OAuth endpoints
 *   POST /mcp/register                               RFC 7591 registration, forwarded to Cognito DCR (see registerClient)
 *
 * Authorization is Cognito's MCP auth: clients self-register through Cognito dynamic client registration,
 * the user signs in on Cognito managed login, and the client asks for a token bound to this server's URL
 * (RFC 8707 resource indicator, which becomes the token's `aud`).
 */

export const MCP_PATH = '/mcp';
export const REGISTER_PATH = '/mcp/register';

export interface McpAuthConfig {
  /** Cognito user pool domain, e.g. `wgo-1a2b3c4d.auth.eu-west-1.amazoncognito.com` (managed login). */
  cognitoDomain: string;
  /** `https://cognito-idp.{region}.amazonaws.com/{userPoolId}`: where the signing keys live. */
  cognitoIssuer: string;
  /** Verifies a Cognito access token and returns its claims as AuthInfo (resource = the token's `aud`). */
  verifier: OAuthTokenVerifier;
  /** Maps a verified token to the WGO user's email (Cognito access tokens carry no email claim). */
  resolveEmail: (auth: AuthInfo) => Promise<string | null>;
}

export interface McpFetchOptions {
  /** Public origin clients use, e.g. `https://wgo.example.com` (no trailing slash). */
  publicOrigin: string;
  /** `null` = local development: no OAuth, every request acts as `devEmail`. */
  auth: McpAuthConfig | null;
  devEmail?: string;
}

/** The OAuth scope for read access: `<resource URL>/read`, the format Cognito gives resource server scopes. */
export const readScope = (resourceUrl: string) => `${resourceUrl}/read`;

const handler = createMcpHandler(
  (ctx) => {
    const email = ctx.authInfo?.extra?.email;
    if (typeof email !== 'string' || !email) throw new Error('MCP request without a resolved user');
    const { origin, ingestOrigin } = ctx.authInfo?.extra ?? {};
    return buildMcpServer(email, typeof origin === 'string' ? origin : undefined, typeof ingestOrigin === 'string' ? ingestOrigin : undefined);
  },
  { responseMode: 'json', keepAliveMs: 0, maxRequestBodySize: 256 * 1024, onerror: (err) => console.warn('mcp:', err.message) },
);

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function authMetadata(publicOrigin: string, auth: McpAuthConfig): AuthMetadataOptions {
  const resourceUrl = `${publicOrigin}${MCP_PATH}`;
  const as = `https://${auth.cognitoDomain}`;
  return {
    resourceServerUrl: new URL(resourceUrl),
    resourceName: 'WGO analytics',
    scopesSupported: [readScope(resourceUrl)],
    // Cognito publishes OIDC discovery under its issuer but no RFC 8414 document, and its tokens are
    // issued from a different host than the one users sign in on. We describe Cognito's endpoints here
    // so every MCP client (including ones that only try RFC 8414) finds them; clients never validate the
    // access token's `iss`, and this server checks it against Cognito directly.
    oauthMetadata: {
      issuer: publicOrigin,
      authorization_endpoint: `${as}/oauth2/authorize`,
      token_endpoint: `${as}/oauth2/token`,
      // ours, not Cognito's: registerClient makes sure the client may request the read scope
      registration_endpoint: `${publicOrigin}${REGISTER_PATH}`,
      revocation_endpoint: `${as}/oauth2/revoke`,
      jwks_uri: `${auth.cognitoIssuer}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      scopes_supported: [readScope(resourceUrl), 'openid', 'email', 'profile'],
    },
  };
}

/** Scopes every registered client may request: the read scope plus the OIDC ones in scopesSupported. */
const registeredScopes = (resourceUrl: string) => [readScope(resourceUrl), 'openid', 'email', 'profile'];

/**
 * Dynamic client registration, forwarded to Cognito's /oauth2/register. Cognito gives a client that registers
 * without a `scope` only `openid`, so its later authorization request for the read scope fails with
 * invalid_scope. ChatGPT registers that way (Claude sends a scope). The scopes we advertise are added to every
 * registration. The client still gets only the scopes it asks for when it authorizes.
 */
async function registerClient(request: Request, publicOrigin: string, auth: McpAuthConfig): Promise<Response> {
  const text = await request.text();
  if (text.length > 64 * 1024) return jsonResponse(413, { error: 'invalid_client_metadata', error_description: 'Request too large' });
  let metadata: unknown;
  try {
    metadata = JSON.parse(text);
  } catch {
    return jsonResponse(400, { error: 'invalid_client_metadata', error_description: 'Body must be JSON client metadata' });
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return jsonResponse(400, { error: 'invalid_client_metadata', error_description: 'Body must be a JSON object' });
  }
  const meta = metadata as Record<string, unknown>;
  const requested = typeof meta.scope === 'string' ? meta.scope.split(' ').filter(Boolean) : [];
  const scope = [...new Set([...requested, ...registeredScopes(`${publicOrigin}${MCP_PATH}`)])].join(' ');

  const res = await fetch(`https://${auth.cognitoDomain}/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ ...meta, scope }),
  });
  // only the body and status: Cognito also sets an XSRF cookie for its own host
  return new Response(await res.text(), {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
  });
}

export async function mcpFetch(request: Request, opts: McpFetchOptions): Promise<Response> {
  const url = new URL(request.url);
  const { auth, publicOrigin } = opts;

  if (url.pathname.startsWith('/.well-known/')) {
    if (!auth) return jsonResponse(404, { error: 'Not found (no OAuth in local development)' });
    const meta = authMetadata(publicOrigin, auth);
    // RFC 9728 path-aware location (/.well-known/oauth-protected-resource/mcp) and the AS document
    const doc = oauthMetadataResponse(request, meta);
    if (doc) return doc;
    // root location, which clients try after the path-aware one
    if (url.pathname === '/.well-known/oauth-protected-resource' && request.method === 'GET') {
      return jsonResponse(200, buildOAuthProtectedResourceMetadata(meta), { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });
    }
    return jsonResponse(404, { error: 'Not found' });
  }

  if (url.pathname === REGISTER_PATH) {
    if (!auth) return jsonResponse(404, { error: 'Not found (no OAuth in local development)' });
    if (request.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' }, { allow: 'POST' });
    return registerClient(request, publicOrigin, auth);
  }

  if (url.pathname !== MCP_PATH) return jsonResponse(404, { error: 'Not found' });

  // Bearer tokens (not cookies) protect this endpoint, but the spec requires Origin validation: browsers may
  // only call it from this host or a localhost tool such as the MCP Inspector. Non-browser clients send none.
  const rejected = originValidationResponse(request, [new URL(publicOrigin).hostname, ...localhostAllowedOrigins()]);
  if (rejected) return rejected;

  let authInfo: AuthInfo;
  if (!auth) {
    authInfo = { token: 'dev', clientId: 'dev', scopes: [], extra: { email: opts.devEmail ?? 'dev@localhost.test', ingestOrigin: publicOrigin } };
  } else {
    const resourceUrl = `${publicOrigin}${MCP_PATH}`;
    const bearer = {
      verifier: auth.verifier,
      requiredScopes: [readScope(resourceUrl)],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(resourceUrl)),
    };
    try {
      // checks signature/expiry (verifier), aud === this server's URL (RFC 8707) and the read scope
      authInfo = await verifyBearerToken(request.headers.get('authorization'), { ...bearer, expectedResource: new URL(resourceUrl) });
    } catch (err) {
      return bearerAuthChallengeResponse(err, bearer);
    }
    const email = await auth.resolveEmail(authInfo);
    if (!email) return bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, 'Unknown or disabled user'), bearer);
    if (!emailAllowed(email)) return jsonResponse(403, { error: allowlistMessage() });
    // through CloudFront, the public origin is the dashboard's: tools link to its pages
    // and it also serves the SDK and ingest (the IngestUrl and SdkUrl stack outputs)
    authInfo = { ...authInfo, extra: { ...authInfo.extra, email, origin: publicOrigin, ingestOrigin: publicOrigin } };
  }

  return handler.fetch(request, { authInfo });
}
