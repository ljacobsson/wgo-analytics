import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { handleError, header, HttpError, json, jsonBody } from '../lib/http';
import { publicConfig, startRecording } from '../lib/recordings';

/**
 * Session recording endpoints for the browser SDK, authenticated by the project's write key (public, like
 * /ingest). See lib/recordings.ts.
 *
 *   GET  /replay/config?k=wk_…      what to record; cached for a minute (browser and CloudFront)
 *   POST /replay/start  {k, s, a, r}  a recording slot for session `s`: {"ok": true|false}
 *
 * The SDK posts text/plain, so browsers send it without a CORS preflight.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const method = event.requestContext.http.method;
    if (event.rawPath === '/replay/config' && method === 'GET') {
      return json(200, await publicConfig(event.queryStringParameters?.k), { 'cache-control': 'public, max-age=60' });
    }
    if (event.rawPath === '/replay/start' && method === 'POST') {
      return json(200, await startRecording(jsonBody(event), Date.now(), header(event, 'origin')), { 'cache-control': 'no-store' });
    }
    throw new HttpError(404, 'Not found');
  } catch (err) {
    return handleError(err);
  }
}
