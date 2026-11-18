/**
 * Local dev server: runs the real Lambda handlers over HTTP against plain PostgreSQL (projects, settings,
 * rollups) and a local directory of Parquet files (raw data, STORE_URL; default backend/.wgo-store).
 * No Cognito locally — every /api request acts as DEV_EMAIL. Live WebSocket fan-out is disabled.
 *
 *   docker run -d --rm --name wgo-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npm run dev
 *
 * Also serves ../examples and ../sdk/dist so the demo page works out of the box:
 *   http://localhost:8787/examples/demo.html
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

process.env.CONNECTIONS_TABLE ??= 'local';
process.env.STORE_URL ??= resolve(import.meta.dirname, '../.wgo-store');
const PORT = Number(process.env.PORT ?? 8787);
const DEV_EMAIL = process.env.DEV_EMAIL ?? 'dev@localhost.test';
const ROOT = resolve(import.meta.dirname, '../..');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (see header of dev/server.mts)');
  process.exit(1);
}

const { query } = await import('../src/lib/db');
const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
const { listProjects, createProject } = await import('../src/lib/projects');
const ingest = (await import('../src/handlers/ingest')).handler;
const otlp = (await import('../src/handlers/otlp')).handler;
const api = (await import('../src/handlers/api')).handler;
const widget = (await import('../src/handlers/widget')).handler;
const kiosk = (await import('../src/handlers/kiosk')).handler;
const replay = (await import('../src/handlers/replay')).handler;
const { mcpFetch } = await import('../src/lib/mcp/http');

for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
if (!(await listProjects(DEV_EMAIL)).length) await createProject(DEV_EMAIL, 'Local demo');
const [project] = await listProjects(DEV_EMAIL);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, content-encoding, x-wgo-key, x-wgo-device, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-max-age': '86400',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
};
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json' };

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function toEvent(req: IncomingMessage, url: URL, raw: Buffer): APIGatewayProxyEventV2 {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v ?? '']));
  return {
    rawPath: url.pathname,
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: raw.length ? raw.toString('base64') : undefined,
    isBase64Encoded: true,
    requestContext: { http: { method: req.method ?? 'GET' }, authorizer: { jwt: { claims: { email: DEV_EMAIL } } } },
  } as unknown as APIGatewayProxyEventV2;
}

function toRequest(req: IncomingMessage, url: URL, raw: Buffer): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(',') : v);
  return new Request(url, { method: req.method, headers, body: raw.length ? new Uint8Array(raw) : undefined });
}

async function sendFetch(res: ServerResponse, r: Response) {
  const headers: Record<string, string> = { ...CORS };
  r.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}

function send(res: ServerResponse, r: APIGatewayProxyStructuredResultV2) {
  res.writeHead(r.statusCode ?? 200, { ...CORS, ...(r.headers as Record<string, string>) });
  res.end(r.body ?? '');
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  try {
    if (req.method === 'OPTIONS') return send(res, { statusCode: 204 });
    const raw = await body(req);
    if (url.pathname === '/ingest' && req.method === 'POST') return send(res, (await ingest(toEvent(req, url, raw))) as APIGatewayProxyStructuredResultV2);
    // session recording: the SDK's config and slot requests (write-key auth, as deployed)
    if (url.pathname.startsWith('/replay/')) return send(res, (await replay(toEvent(req, url, raw))) as APIGatewayProxyStructuredResultV2);
    if (url.pathname.startsWith('/v1/') && req.method === 'POST') return send(res, (await otlp(toEvent(req, url, raw))) as APIGatewayProxyStructuredResultV2);
    if (url.pathname.startsWith('/api/')) return send(res, (await api(toEvent(req, url, raw) as never)) as APIGatewayProxyStructuredResultV2);
    // Android widget API: device-token auth, so it works locally exactly as deployed
    if (url.pathname.startsWith('/widget/')) return send(res, (await widget(toEvent(req, url, raw))) as APIGatewayProxyStructuredResultV2);
    // kiosk screens: kiosk-token auth, as deployed (open http://localhost:5173/#/kiosk/<token> with `npm run dev:local`)
    if (url.pathname.startsWith('/kiosk/')) return send(res, (await kiosk(toEvent(req, url, raw))) as APIGatewayProxyStructuredResultV2);
    // MCP server without OAuth: every call acts as DEV_EMAIL (`claude mcp add --transport http wgo-local http://localhost:8787/mcp`)
    if (url.pathname === '/mcp') return sendFetch(res, await mcpFetch(toRequest(req, url, raw), { publicOrigin: `http://localhost:${PORT}`, auth: null, devEmail: DEV_EMAIL }));

    // runtime config for the dashboard (`npm run dev:local` in dashboard/)
    if (url.pathname === '/config.json') {
      const origin = `http://localhost:${PORT}`;
      return send(res, {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiUrl: origin, ingestUrl: origin, wsUrl: 'ws://localhost:1/no-live-locally', sdkUrl: `${origin}/sdk/dist/wgo.js`,
          region: 'local', userPoolId: 'local', userPoolClientId: 'local', devEmail: DEV_EMAIL, mcpUrl: `${origin}/mcp`,
        }),
      });
    }

    // fake failing API used by the demo page
    if (url.pathname.startsWith('/api-demo/')) return send(res, { statusCode: url.pathname.includes('checkout') ? 500 : 404, body: '{}' });

    // static: /examples/*, /sdk/*; /sdk/v1/* is the deployed path of sdk/dist (wgo.js loads wgo-replay.js from there)
    const file = normalize(join(ROOT, url.pathname.replace(/^\/sdk\/v1\//, '/sdk/dist/')));
    if (!file.startsWith(join(ROOT, 'examples')) && !file.startsWith(join(ROOT, 'sdk', 'dist'))) return send(res, { statusCode: 404, body: 'not found' });
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', ...CORS });
    res.end(data);
  } catch (err) {
    const notFound = (err as { code?: string }).code === 'ENOENT';
    if (!notFound) console.error(err);
    send(res, { statusCode: notFound ? 404 : 500, body: notFound ? 'not found' : 'error' });
  }
}).listen(PORT, () => {
  console.log(`WGO dev server on http://localhost:${PORT}`);
  console.log(`  acting as ${DEV_EMAIL}; project "${project.name}" (${project.id})`);
  console.log(`  write key: ${project.writeKey}`);
  console.log(`  demo:      http://localhost:${PORT}/examples/demo.html?key=${project.writeKey}`);
  console.log(`  dashboard: cd dashboard && npm run dev:local`);
  console.log(`  mcp:       http://localhost:${PORT}/mcp  (no OAuth locally; acts as ${DEV_EMAIL})`);
});
