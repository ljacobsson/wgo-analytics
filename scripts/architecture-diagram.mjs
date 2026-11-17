#!/usr/bin/env node
// Generates dashboard/public/docs/architecture-{light,dark}.svg, the architecture diagram in README.md.
//
// The AWS icons come from the aws-icons npm package (the official AWS Architecture Icons as SVG) and are
// inlined, so the output is self-contained (GitHub serves README images through <img>, which blocks
// external references). To regenerate:
//
//   mkdir -p /tmp/aws-icons && (cd /tmp/aws-icons && npm pack aws-icons && tar xzf aws-icons-*.tgz)
//   node scripts/architecture-diagram.mjs /tmp/aws-icons/package/icons
//
// Layout is a fixed grid: change the column/row constants and the node and edge lists below.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const iconDir = process.argv[2];
if (!iconDir) {
  console.error('usage: node scripts/architecture-diagram.mjs <aws-icons>/icons');
  process.exit(1);
}
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'public', 'docs');

const THEMES = {
  light: {
    bg: '#ffffff', text: '#232f3e', sub: '#5f6b7a', edge: '#7d8998', glyph: '#232f3e',
    cloud: '#232f3e', group: '#b6bec9', groupFill: '#f7f9fb', groupText: '#5f6b7a', pill: '#ffffff',
  },
  dark: {
    bg: '#0d1117', text: '#e6edf3', sub: '#9198a1', edge: '#8b949e', glyph: '#e6edf3',
    cloud: '#8b949e', group: '#3d444d', groupFill: '#151b23', groupText: '#9198a1', pill: '#0d1117',
  },
};

// ------------------------------------------------------------------ icons
const ICONS = {
  client: 'resource/Client.svg',
  servers: 'resource/Servers.svg',
  users: 'resource/Users.svg',
  chat: 'resource/Chat.svg',
  cloudLogo: 'architecture-group/AWSCloudlogo.svg',
  cloudfront: 'architecture-service/AmazonCloudFront.svg',
  apigw: 'architecture-service/AmazonAPIGateway.svg',
  lambda: 'architecture-service/AWSLambda.svg',
  sqs: 'architecture-service/AmazonSimpleQueueService.svg',
  s3: 'architecture-service/AmazonSimpleStorageService.svg',
  dynamodb: 'architecture-service/AmazonDynamoDB.svg',
  aurora: 'architecture-service/AmazonAurora.svg',
  cognito: 'architecture-service/AmazonCognito.svg',
  eventbridge: 'architecture-service/AmazonEventBridge.svg',
};
const GLYPHS = new Set(['client', 'servers', 'users', 'chat']); // single-colour resource icons, recoloured per theme

function icon(name, x, y, size, t) {
  let svg = readFileSync(join(iconDir, ICONS[name]), 'utf8').replace(/<title>.*?<\/title>/s, '');
  if (GLYPHS.has(name)) svg = svg.replace(/fill="#23?2?4?2f3[de]"/gi, `fill="${t.glyph}"`);
  return svg.replace('<svg ', `<svg x="${x}" y="${y}" width="${size}" height="${size}" `);
}

// ------------------------------------------------------------------ layout grid
const X = [96, 256, 396, 526, 656, 786, 916, 1070, 1234, 1420];
const Y = { live: 132, web: 262, mid: 342, otlp: 422, maint: 502, low: 642 };
const S = 52; // icon size
const W = 1530, H = 770;
const LINE = 17; // label line height
const LANE = { toApi: 326, toQueues: 465, toData: 988, toQuery: 1152 }; // vertical edge lanes between columns

// label lines: [bold title, ...grey sub-lines]
const nodes = [
  { id: 'sdk', icon: 'client', x: X[0], y: Y.web, label: ['Your web app', 'WGO SDK, ~9 KB'] },
  { id: 'otel', icon: 'servers', x: X[0], y: Y.otlp, label: ['Your services', 'any OpenTelemetry SDK'] },
  { id: 'notify', icon: 'chat', x: X[0], y: Y.low, label: ['Slack · webhooks', 'trigger alerts'] },
  { id: 'readers', icon: 'users', x: X[9], y: Y.mid, label: ['You and your team', 'dashboard · widget', 'kiosks · AI via MCP'] },

  { id: 'static', icon: 's3', x: X[1], y: Y.live, label: ['S3', 'dashboard + SDK'] },
  { id: 'cf', icon: 'cloudfront', x: X[1], y: Y.mid, label: ['CloudFront', 'your domain', 'geo at the edge'] },

  // API Gateway writes SDK batches and OTLP requests straight to SQS: no Lambda in the request path
  { id: 'rest', icon: 'apigw', x: X[2], y: Y.mid, label: ['REST API', '/ingest · /v1/*'] },
  { id: 'ingestq', icon: 'sqs', x: X[3], y: Y.web, label: ['SQS', 'SDK batches'] },
  { id: 'ingest', icon: 'lambda', x: X[4], y: Y.web, label: ['Ingest'] },
  { id: 'eventsq', icon: 'sqs', x: X[5], y: Y.web, label: ['SQS', 'events'] },
  { id: 'writer', icon: 'lambda', x: X[6], y: Y.web, label: ['Writer'] },

  { id: 'otlpq', icon: 'sqs', x: X[3], y: Y.otlp, label: ['SQS', 'OTLP'] },
  { id: 'otlp', icon: 'lambda', x: X[6], y: Y.otlp, label: ['OTLP'] },

  { id: 'trigger', icon: 'lambda', x: X[4], y: Y.low, label: ['Trigger'] },

  { id: 'data', icon: 's3', x: X[7], y: Y.mid, label: ['S3 · Parquet', 'events · spans', 'logs · metrics'] },
  { id: 'maint', icon: 'lambda', x: X[7], y: Y.maint, label: ['Maintenance', 'every 15 min'], badge: 'eventbridge' },
  { id: 'dsql', icon: 'aurora', x: X[7], y: Y.low, label: ['Aurora DSQL', 'projects · settings', 'hourly rollups'] },

  { id: 'ws', icon: 'apigw', x: X[8], y: Y.live, label: ['WebSocket API', 'live · DynamoDB'], badge: 'dynamodb' },
  { id: 'query', icon: 'lambda', x: X[8], y: Y.mid, label: ['API · MCP', 'widget · kiosk', 'in-process DuckDB'] },
  { id: 'cognito', icon: 'cognito', x: X[8], y: Y.low, label: ['Cognito', 'accounts'] },
];
const N = Object.fromEntries(nodes.map((n) => [n.id, n]));
const half = S / 2;
const labelBottom = (n) => n.y + half + 10 + LINE * n.label.length;

// edges point from caller to callee; label: [text, x, y]; dashed for async side paths
const G = 7; // gap between an arrow and the icon it touches
const L = (n, dy = 0) => [n.x - half - G, n.y + dy];
const R = (n, dy = 0) => [n.x + half + G, n.y + dy];
const T = (n) => [n.x, n.y - half - G];
const B = (n) => [n.x, labelBottom(n) + 2];
const edges = [
  { pts: [R(N.sdk), [178, Y.web], [178, Y.mid - 10], L(N.cf, -10)] },
  { pts: [R(N.otel), [178, Y.otlp], [178, Y.mid + 10], L(N.cf, 10)] },
  { pts: [T(N.cf), B(N.static)] },
  { pts: [R(N.cf), L(N.rest)] },

  { pts: [R(N.rest, -10), [LANE.toQueues, Y.mid - 10], [LANE.toQueues, Y.web], L(N.ingestq)] },
  { pts: [R(N.rest, 10), [LANE.toQueues, Y.mid + 10], [LANE.toQueues, Y.otlp], L(N.otlpq)] },
  { pts: [R(N.ingestq), L(N.ingest)] },
  { pts: [R(N.ingest), L(N.eventsq)] },
  { pts: [R(N.eventsq), L(N.writer)] },
  { pts: [R(N.writer), [LANE.toData, Y.web], [LANE.toData, Y.mid - 10], L(N.data, -10)] },
  { pts: [R(N.otlpq), L(N.otlp)] },
  { pts: [R(N.otlp), [LANE.toData, Y.otlp], [LANE.toData, Y.mid + 10], L(N.data, 10)] },

  { pts: [T(N.ingest), [N.ingest.x, Y.live], L(N.ws)], label: ['matching events, pushed live', (N.ingest.x + N.ws.x) / 2, Y.live - 13] },
  { pts: [B(N.ingest), T(N.trigger)], dashed: true },
  { pts: [B(N.otlp), [N.otlp.x, Y.low], R(N.trigger)], dashed: true },
  { pts: [L(N.trigger), R(N.notify)], dashed: true },

  { pts: [T(N.maint), B(N.data)], inGroup: true, label: ['compact · expire', N.maint.x, (labelBottom(N.data) + N.maint.y - half) / 2 - 2] },
  { pts: [B(N.maint), T(N.dsql)], inGroup: true, label: ['roll up', N.maint.x, (labelBottom(N.maint) + N.dsql.y - half) / 2 - 2] },
  { pts: [L(N.query, -10), R(N.data, -10)] },
  { pts: [L(N.query, 10), [LANE.toQuery, Y.mid + 10], [LANE.toQuery, Y.low], R(N.dsql)] },

  { pts: [T(N.readers), [X[9], Y.live], R(N.ws)] },
  { pts: [L(N.readers), R(N.query)] },
  { pts: [B(N.readers), [X[9], Y.low], R(N.cognito)], label: ['sign in', X[9], (labelBottom(N.readers) + Y.low) / 2] },
];

// ------------------------------------------------------------------ rendering
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const textWidth = (s, size) => s.length * size * 0.56;

function roundedPath(pts, r = 10) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
    const d1 = Math.hypot(cx - px, cy - py), d2 = Math.hypot(nx - cx, ny - cy);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const ax = cx - ((cx - px) / d1) * rr, ay = cy - ((cy - py) / d1) * rr;
    const bx = cx + ((nx - cx) / d2) * rr, by = cy + ((ny - cy) / d2) * rr;
    d += ` L${ax},${ay} Q${cx},${cy} ${bx},${by}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return d + ` L${lx},${ly}`;
}

function group(t, x, y, w, h, title) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${t.groupFill}" stroke="${t.group}" stroke-dasharray="5 4"/>
  <text x="${x + 12}" y="${y + 20}" class="group">${esc(title)}</text>`;
}

function render(themeName) {
  const t = THEMES[themeName];
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif">
<title>WGO architecture on AWS</title>
<style>
  .title { font-size: 15px; font-weight: 600; fill: ${t.text}; }
  .sub { font-size: 13px; fill: ${t.sub}; }
  .group { font-size: 12px; font-weight: 600; fill: ${t.groupText}; letter-spacing: .02em; }
  .edge { fill: none; stroke: ${t.edge}; stroke-width: 1.6; }
  .dashed { stroke-dasharray: 5 4; }
  .elabel { font-size: 12.5px; fill: ${t.sub}; font-style: italic; }
</style>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
  <path d="M0,1 L9,5 L0,9 z" fill="${t.edge}"/></marker></defs>
<rect width="${W}" height="${H}" rx="14" fill="${t.bg}"/>`);

  // AWS account boundary (AWS Cloud group style: logo in the corner, solid outline)
  const ax = 184, ay = 28, aw = 1142, ah = H - 50;
  out.push(`<rect x="${ax}" y="${ay}" width="${aw}" height="${ah}" fill="none" stroke="${t.cloud}" stroke-width="1.4"/>`);
  out.push(icon('cloudLogo', ax, ay, 30, t));
  out.push(`<text x="${ax + 40}" y="${ay + 20}" class="title">Your AWS account</text>`);

  const gBottom = H - 32;
  out.push(group(t, 342, 196, 634, 318, 'INTAKE'));
  out.push(group(t, 998, 276, 144, gBottom - 276, 'STORAGE'));
  out.push(group(t, 1160, 62, 148, gBottom - 62, 'SERVE'));

  for (const e of edges) {
    out.push(`<path d="${roundedPath(e.pts)}" class="edge${e.dashed ? ' dashed' : ''}" marker-end="url(#arrow)"/>`);
  }
  for (const e of edges) {
    if (!e.label) continue;
    const [txt, lx, ly] = e.label;
    const w = textWidth(txt, 12.5) + 12;
    out.push(`<rect x="${lx - w / 2}" y="${ly - 10}" width="${w}" height="19" rx="4" fill="${e.inGroup ? t.groupFill : t.pill}"/>`);
    out.push(`<text x="${lx}" y="${ly + 4}" text-anchor="middle" class="elabel">${esc(txt)}</text>`);
  }

  for (const n of nodes) {
    out.push(icon(n.icon, n.x - half, n.y - half, S, t));
    if (n.badge) {
      out.push(`<rect x="${n.x + half - 14}" y="${n.y - half - 10}" width="28" height="28" rx="4" fill="${t.bg}"/>`);
      out.push(icon(n.badge, n.x + half - 12, n.y - half - 8, 24, t));
    }
    n.label.forEach((line, i) => {
      out.push(`<text x="${n.x}" y="${n.y + half + 22 + LINE * i}" text-anchor="middle" class="${i ? 'sub' : 'title'}">${esc(line)}</text>`);
    });
  }

  out.push('</svg>\n');
  return out.join('\n');
}

mkdirSync(outDir, { recursive: true });
for (const theme of Object.keys(THEMES)) {
  const file = join(outDir, `architecture-${theme}.svg`);
  writeFileSync(file, render(theme));
  console.log(`wrote ${file}`);
}
