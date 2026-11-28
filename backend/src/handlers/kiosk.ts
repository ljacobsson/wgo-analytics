import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDashboard, tileData } from '../lib/dashboards';
import { authenticateKiosk, kioskState } from '../lib/kiosks';
import { handleError, header, HttpError, json } from '../lib/http';
import { READ_ROUTES } from '../lib/readRoutes';

/**
 * API for kiosk screens, authenticated with the kiosk token from the kiosk URL instead of Cognito
 * (a wall display has nobody to sign in). The token pins the project; only read-only analytics are served.
 *
 *   GET /kiosk/v1/state?w=1920&h=1080
 *   GET /kiosk/v1/{stats|clicks|pages|…}[/…]     same as /api/projects/{pid}/… for the kiosk's project
 *   GET /kiosk/v1/dashboards/{id}                a custom dashboard of the kiosk's project
 *   GET /kiosk/v1/dashboards/{id}/tiles/{tileId}/data   the result of one of its SQL tiles
 */
export function kioskToken(event: APIGatewayProxyEventV2): string | undefined {
  return header(event, 'authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    if (event.requestContext.http.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const auth = await authenticateKiosk(kioskToken(event));
    const [k, v, resource, ...rest] = event.rawPath.split('/').filter(Boolean);
    if (k !== 'kiosk' || v !== 'v1' || !resource) throw new HttpError(404, 'Not found');
    const q = event.queryStringParameters ?? {};

    let result: unknown;
    if (resource === 'state' && !rest.length) result = await kioskState(auth, q);
    else if (resource === 'dashboards' && rest.length === 1) result = await getDashboard(auth.projectId, rest[0]);
    else if (resource === 'dashboards' && rest.length === 4 && rest[1] === 'tiles' && rest[3] === 'data') result = await tileData(auth.projectId, rest[0], rest[2], q);
    else if (Object.hasOwn(READ_ROUTES, resource)) result = await READ_ROUTES[resource](auth.projectId, q, rest);
    else throw new HttpError(404, 'Not found');
    return json(200, result, { 'cache-control': 'private, no-store' });
  } catch (err) {
    return handleError(err);
  }
}
