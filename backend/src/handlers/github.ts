import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { completeInstall, completeManifest, fixAgentEnabled, type GithubState } from '../lib/github';

/**
 * GitHub's redirects back to WGO (public routes; each is authenticated by the signed state WGO sent along):
 *   GET /github/manifest?code&state                          an admin created the GitHub App from WGO's manifest
 *   GET /github/setup?code&installation_id&setup_action&state  an owner installed (and authorized) it for a project
 * Both go back to the project's GitHub Agent page with ?github=<result>.
 */
const text = (statusCode: number, body: string): APIGatewayProxyResultV2 => ({ statusCode, headers: { 'content-type': 'text/plain; charset=utf-8' }, body });

const back = (st: GithubState, result: string): APIGatewayProxyResultV2 => ({
  statusCode: 302,
  headers: { location: `${st.returnTo ?? ''}/#/p/${st.pid}/fix-agent?github=${encodeURIComponent(result)}` },
  body: '',
});

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await fixAgentEnabled())) return text(404, 'The GitHub Agent is off on this WGO.');
  const q = event.queryStringParameters ?? {};
  const path = event.rawPath.replace(/\/+$/, '');
  let st: GithubState;
  try {
    if (path.endsWith('/github/manifest')) {
      if (!q.code || !q.state) return text(400, 'GitHub didn’t send the app back. Start again from WGO.');
      st = await completeManifest(q.code, q.state);
      return back(st, 'created');
    }
    if (path.endsWith('/github/setup')) {
      if (!q.state) return text(400, 'This link has no state: install the app from WGO’s GitHub Agent page.');
      if (!q.installation_id) return text(400, 'GitHub didn’t say which installation this is. Start again from WGO.');
      st = await completeInstall(q.code ?? '', q.installation_id, q.state);
      return back(st, 'installed');
    }
    return text(404, 'Not found');
  } catch (err) {
    console.error('github callback failed', err);
    return text(400, `Couldn’t finish connecting GitHub: ${(err as Error).message}. Start again from WGO.`);
  }
}
