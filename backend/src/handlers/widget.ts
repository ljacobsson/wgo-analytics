import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { WidgetMe } from '../contract';
import { authenticateDevice } from '../lib/devices';
import { allowlistMessage, emailAllowed } from '../lib/allowlist';
import { handleError, header, HttpError, json } from '../lib/http';
import { getProject, listProjects } from '../lib/projects';
import { catalog, overview, summary } from '../lib/widget';

/**
 * Read-only API for the Android widget, authenticated with a device token instead of Cognito
 * (a widget refreshing in the background can't run an interactive sign-in).
 *
 *   GET /widget/v1/me
 *   GET /widget/v1/projects/{pid}/catalog
 *   GET /widget/v1/projects/{pid}/summary?range=24h&stats=pageviews,errors
 *   GET /widget/v1/overview?range=24h&stats=visitors_now,pageviews,errors
 */
export function deviceToken(event: APIGatewayProxyEventV2): string | undefined {
  const bearer = header(event, 'authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  return bearer ?? header(event, 'x-wgo-device');
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    if (event.requestContext.http.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const { email } = await authenticateDevice(deviceToken(event));
    if (!emailAllowed(email)) throw new HttpError(403, allowlistMessage());
    const [w, v, resource, pid, sub] = event.rawPath.split('/').filter(Boolean);
    if (w !== 'widget' || v !== 'v1') throw new HttpError(404, 'Not found');

    let result: unknown;
    if (resource === 'me' && !pid) {
      const projects = await listProjects(email);
      result = { email, projects: projects.map((p) => ({ id: p.id, name: p.name })) } satisfies WidgetMe;
    } else if (resource === 'overview' && !pid) {
      result = await overview(await listProjects(email), event.queryStringParameters ?? {});
    } else if (resource === 'projects' && pid && (sub === 'catalog' || sub === 'summary')) {
      const project = await getProject(email, pid); // membership check: 404 for projects the user can't see
      result = sub === 'catalog' ? await catalog(project.id) : await summary({ id: project.id, name: project.name }, event.queryStringParameters ?? {});
    } else {
      throw new HttpError(404, 'Not found');
    }
    return json(200, result, { 'cache-control': 'private, no-store' });
  } catch (err) {
    return handleError(err);
  }
}
