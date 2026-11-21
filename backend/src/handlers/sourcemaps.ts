import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { handleError, header, HttpError, json, jsonBody } from '../lib/http';
import { projectIdForUploadKey } from '../lib/projects';
import { normalizeMapFile, normalizeRelease, uploadUrl } from '../lib/sourcemaps';

/**
 * Source map uploads from CI, authenticated by the project's upload key instead of Cognito (see the Settings
 * page and the `wgo-sourcemaps` CLI).
 *
 *   POST /sourcemaps/upload-url   x-wgo-upload-key: uk_…   {"release": "v1.2.3", "file": "index-abc.js.map"}
 *     -> {"url": <presigned S3 PUT>, "key": "sourcemaps/project_id=…/release=v1.2.3/index-abc.js.map"}
 *
 * Without S3 (local dev server) the url points at the dev server, which accepts the PUT itself.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    if (event.rawPath !== '/sourcemaps/upload-url') throw new HttpError(404, 'Not found');
    if (event.requestContext.http.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const projectId = await projectIdForUploadKey(header(event, 'x-wgo-upload-key'));
    if (!projectId) throw new HttpError(401, 'Missing or unknown upload key (send header x-wgo-upload-key)');

    const body = jsonBody<{ release?: unknown; file?: unknown }>(event);
    const release = normalizeRelease(body.release);
    if (!release) throw new HttpError(400, 'release must be 1-100 characters: letters, digits and . _ ~ @ + = -');
    const file = normalizeMapFile(body.file);
    if (!file) throw new HttpError(400, 'file must be the name of a script or source map, e.g. index-abc123.js.map');

    const host = header(event, 'x-forwarded-host') ?? header(event, 'host') ?? 'localhost';
    const target = (await uploadUrl(projectId, release, file, `${header(event, 'x-forwarded-proto') ?? 'http'}://${host}`))!;
    return json(200, target, { 'cache-control': 'no-store' });
  } catch (err) {
    return handleError(err);
  }
}
