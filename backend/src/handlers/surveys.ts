import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { handleError, header, HttpError, json, jsonBody } from '../lib/http';
import { publicSurveys, respond } from '../lib/surveys';

/**
 * Survey endpoints for the browser SDK (wgo-surveys.js), authenticated by the project's write key (public, like
 * /ingest). See lib/surveys.ts.
 *
 *   GET  /surveys/config?k=wk_…   the project's active surveys; cached for a minute (browser and CloudFront)
 *   POST /surveys/respond {k, id, r, a, s, u, path, ans}   one submitted response: {"ok": true|false}
 *
 * The SDK posts text/plain, so browsers send it without a CORS preflight.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const method = event.requestContext.http.method;
    if (event.rawPath === '/surveys/config' && method === 'GET') {
      return json(200, await publicSurveys(event.queryStringParameters?.k), { 'cache-control': 'public, max-age=60' });
    }
    if (event.rawPath === '/surveys/respond' && method === 'POST') {
      return json(200, await respond(jsonBody(event), header(event, 'origin')), { 'cache-control': 'no-store' });
    }
    throw new HttpError(404, 'Not found');
  } catch (err) {
    return handleError(err);
  }
}
