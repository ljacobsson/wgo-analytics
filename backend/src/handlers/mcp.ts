import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { mcpOn } from '../lib/installSettings';
import { AdminGetUserCommand, CognitoIdentityProviderClient, UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { header } from '../lib/http';
import { mcpFetch, type McpAuthConfig } from '../lib/mcp/http';

/**
 * MCP server Lambda: /mcp and the OAuth discovery documents (see lib/mcp/http.ts).
 * No API Gateway authorizer: unauthenticated requests must get the 401 + WWW-Authenticate challenge that
 * starts the MCP OAuth flow, so the access token is verified here.
 */

const { USER_POOL_ID, COGNITO_DOMAIN, EDGE_SECRET, AWS_REGION } = process.env;

const jwt = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID!,
  tokenUse: 'access',
  clientId: null, // MCP clients register themselves (Cognito DCR), so any app client of the pool; `aud` is what binds the token to us
});

const cognito = new CognitoIdentityProviderClient({});
const emails = new Map<string, { email: string | null; exp: number }>();

const auth: McpAuthConfig = {
  cognitoDomain: COGNITO_DOMAIN!,
  cognitoIssuer: `https://cognito-idp.${AWS_REGION}.amazonaws.com/${USER_POOL_ID}`,
  verifier: {
    async verifyAccessToken(token) {
      let claims;
      try {
        claims = await jwt.verify(token);
      } catch (err) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, (err as Error).message);
      }
      const aud = typeof claims.aud === 'string' ? claims.aud : undefined;
      return {
        token,
        clientId: claims.client_id,
        scopes: claims.scope?.split(' ').filter(Boolean) ?? [],
        expiresAt: claims.exp,
        resource: aud && URL.canParse(aud) ? new URL(aud) : undefined,
        extra: { username: claims.username, sub: claims.sub },
      } satisfies AuthInfo;
    },
  },
  // Access tokens have no email claim. Look the user up (also catches disabled and deleted users), cached briefly.
  async resolveEmail(info) {
    const username = String(info.extra?.username ?? '');
    const hit = emails.get(username);
    if (hit && hit.exp > Date.now()) return hit.email;
    let email: string | null = null;
    try {
      const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
      const attr = user.UserAttributes?.find((a) => a.Name === 'email')?.Value;
      email = user.Enabled !== false && attr ? attr.toLowerCase() : null;
    } catch (err) {
      if (!(err instanceof UserNotFoundException)) throw err;
    }
    emails.set(username, { email, exp: Date.now() + 5 * 60_000 });
    if (emails.size > 1000) emails.delete(emails.keys().next().value!);
    return email;
  },
};

/**
 * The origin clients see. Through CloudFront that's the dashboard host, which a CloudFront Function copies
 * into x-forwarded-host; it's only trusted together with the stack's edge secret. Called directly, it's the
 * API Gateway host (where no Cognito resource server exists, so OAuth only works through CloudFront).
 */
export function publicOrigin(event: APIGatewayProxyEventV2): string {
  const forwarded = header(event, 'x-forwarded-host');
  const viaEdge = !!EDGE_SECRET && header(event, 'x-wgo-edge') === EDGE_SECRET;
  return `https://${viaEdge && forwarded ? forwarded : event.requestContext.domainName}`;
}

export function toRequest(event: APIGatewayProxyEventV2, origin: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers.set(k, v);
  const method = event.requestContext.http.method;
  const body = event.body && method !== 'GET' && method !== 'HEAD' ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : undefined;
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  return new Request(`${origin}${event.rawPath}${qs}`, { method, headers, body });
}

export async function fromResponse(res: Response): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { statusCode: res.status, headers, body: await res.text() };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  // admins turn it on and off on the dashboard's MCP page
  if (!(await mcpOn())) return { statusCode: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"MCP is turned off on this WGO: an admin turns it on on the AI assistants page"}' };
  try {
    const origin = publicOrigin(event);
    return await fromResponse(await mcpFetch(toRequest(event, origin), { publicOrigin: origin, auth }));
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"Internal error"}' };
  }
}
