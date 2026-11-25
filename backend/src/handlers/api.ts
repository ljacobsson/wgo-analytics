import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { allowlistMessage, emailAllowed } from '../lib/allowlist';
import { handleError, HttpError, json, jsonBody } from '../lib/http';
import * as CA from '../lib/clickAliases';
import { isAdmin, requireAdmin } from '../lib/admins';
import * as DST from '../lib/destinations';
import * as B from '../lib/budgets';
import * as C from '../lib/costs';
import * as U from '../lib/uptime';
import * as D from '../lib/devices';
import * as DB from '../lib/dashboards';
import * as G from '../lib/goals';
import * as GF from '../lib/funnel';
import * as K from '../lib/kiosks';
import * as P from '../lib/projects';
import * as R from '../lib/recordings';
import { READ_ROUTES } from '../lib/readRoutes';
import * as S from '../lib/slack';
import * as SITE from '../lib/sites';
import * as T from '../lib/triggers';
import * as SUP from '../lib/suppressions';
import * as M from '../lib/monitor';
import * as V from '../lib/views';

type Q = Record<string, string | undefined>;

const projectName = (body: { name?: unknown }) => {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100) throw new HttpError(400, 'Project name must be 1-100 characters');
  return name;
};

async function route(method: string, parts: string[], q: Q, email: string, event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<unknown> {
  // parts: ['api', ...]; for /api/devices/{id}, `pid` holds the device id
  const [, resource, pid, sub, ...rest] = parts;

  if (resource === 'me' && method === 'GET') {
    const [projects, admin] = await Promise.all([P.listProjects(email), isAdmin(email)]);
    return { email, projects, admin };
  }
  // your own trigger destinations (`pid` holds the destination id)
  if (resource === 'destinations') {
    const [id, action] = [pid, sub];
    const me = { level: 'account', email } as const;
    if (!id && method === 'GET') return DST.listAccountDestinations(email);
    if (!id && method === 'POST') return DST.createDestination(me, email, jsonBody(event));
    if (id && action === 'test' && method === 'POST') return DST.testDestination(me, id, null);
    if (id && !action && method === 'PATCH') return DST.updateDestination(me, email, id, jsonBody(event));
    if (id && !action && method === 'DELETE') { await DST.deleteDestination(me, id); return { ok: true }; }
    throw new HttpError(405, 'Method not allowed');
  }
  if (resource === 'devices') {
    if (!pid && method === 'GET') return D.listDevices(email);
    if (!pid && method === 'POST') return D.createDevice(email, jsonBody<{ name?: unknown }>(event).name);
    if (pid && method === 'DELETE') {
      await D.revokeDevice(email, pid);
      return { ok: true };
    }
    throw new HttpError(405, 'Method not allowed');
  }
  if (resource === 'costs' && pid === 'budgets') { // admins only, checked in lib/budgets.ts
    const [id, action] = [sub, rest[0]];
    if (!id && method === 'GET') return B.listBudgets(email);
    if (!id && method === 'POST') return B.createBudget(email, jsonBody(event));
    if (id && action === 'resume' && method === 'POST') return B.resumeBudget(email, id);
    if (id && !action && method === 'PATCH') return B.updateBudget(email, id, jsonBody(event));
    if (id && !action && method === 'DELETE') { await B.deleteBudget(email, id); return { ok: true }; }
    throw new HttpError(405, 'Method not allowed');
  }
  if (resource === 'costs') {
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
    await requireAdmin(email);
    const projects = await P.listProjects(email);
    // `pid` only adds that project's share; it must be one of the caller's own projects
    const own = q.pid;
    if (own && !projects.some((p) => p.id === own)) throw new HttpError(404, 'Project not found');
    return C.getCosts(own);
  }
  if (resource !== 'projects') throw new HttpError(404, 'Not found');

  if (!pid) {
    if (method === 'GET') return P.listProjects(email);
    if (method === 'POST') return P.createProject(email, projectName(jsonBody(event)));
    throw new HttpError(405, 'Method not allowed');
  }

  if (!sub) {
    if (method === 'GET') return P.getProject(email, pid);
    if (method === 'PATCH') {
      const body = jsonBody<{ name?: unknown; retentionDays?: unknown }>(event);
      if (body.retentionDays !== undefined) await P.setRetention(email, pid, body.retentionDays);
      if (body.name !== undefined || body.retentionDays === undefined) return P.renameProject(email, pid, projectName(body));
      return P.getProject(email, pid);
    }
    if (method === 'DELETE') {
      await P.deleteProject(email, pid);
      return { ok: true };
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (sub === 'rotate-key' && method === 'POST') return P.rotateKey(email, pid);
  // source map upload key (CI secret): owners only
  if (sub === 'upload-key' && method === 'GET') return P.getUploadKey(email, pid);
  if (sub === 'rotate-upload-key' && method === 'POST') return P.rotateUploadKey(email, pid);

  if (sub === 'members') {
    if (method === 'GET') return P.listMembers(email, pid);
    if (method === 'POST') return P.addMember(email, pid, String(jsonBody<{ email?: string }>(event).email ?? ''));
    if (method === 'DELETE' && rest[0]) {
      await P.removeMember(email, pid, decodeURIComponent(rest[0]));
      return { ok: true };
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (sub === 'kiosks') {
    await P.getProject(email, pid); // authorization: caller must be a member
    const [id, action] = rest;
    if (!id && method === 'GET') return K.listKiosks(pid);
    if (!id && method === 'POST') return K.createKiosk(pid, email, jsonBody(event));
    if (id && action === 'rotate' && method === 'POST') return K.rotateKioskToken(pid, id);
    if (id && !action && method === 'PATCH') return K.updateKiosk(pid, id, jsonBody(event));
    if (id && !action && method === 'DELETE') { await K.deleteKiosk(pid, id); return { ok: true }; }
    throw new HttpError(405, 'Method not allowed');
  }

  if (sub === 'uptime') {
    await P.getProject(email, pid); // authorization: caller must be a member
    const [id, action] = rest;
    if (!id && method === 'GET') return U.listChecks(pid, U.parseWindow(q));
    if (!id && method === 'POST') return U.createCheck(pid, email, jsonBody(event));
    if (id && action === 'run' && method === 'POST') return U.runNow(pid, id);
    if (id && action === 'results' && method === 'GET') return U.results(pid, id, U.parseWindow(q));
    if (id && !action && method === 'PATCH') return U.updateCheck(pid, id, jsonBody(event));
    if (id && !action && method === 'DELETE') { await U.deleteCheck(pid, id); return { ok: true }; }
    throw new HttpError(405, 'Method not allowed');
  }

  if (sub === 'views') {
    await P.getProject(email, pid); // authorization: caller must be a member
    const [id] = rest;
    if (!id && method === 'GET') return V.listViews(pid);
    if (!id && method === 'POST') return V.createView(pid, email, jsonBody(event));
    if (id && method === 'PATCH') return V.updateView(pid, id, jsonBody(event));
    if (id && method === 'DELETE') { await V.deleteView(pid, id); return { ok: true }; }
    throw new HttpError(405, 'Method not allowed');
  }

  if (sub === 'dashboards') {
    await P.getProject(email, pid); // authorization: caller must be a member
    const [id, action] = rest;
    if (!id && method === 'GET') return DB.listDashboards(pid);
    if (!id && method === 'POST') return DB.createDashboard(pid, email, jsonBody(event));
    if (id && !action && method === 'GET') return DB.getDashboard(pid, id);
    if (id && !action && method === 'PATCH') return DB.updateDashboard(pid, id, jsonBody(event));
    if (id && !action && method === 'DELETE') { await DB.deleteDashboard(pid, id); return { ok: true }; }
    if (id && action === 'duplicate' && method === 'POST') return DB.duplicateDashboard(pid, id, email);
    if (id && action === 'tiles' && method === 'POST') return DB.addTile(pid, id, jsonBody(event));
    throw new HttpError(405, 'Method not allowed');
  }

  if (sub === 'click-aliases') {
    await P.getProject(email, pid); // authorization: caller must be a member
    if (method === 'GET') return CA.listAliases(pid);
    if (method === 'POST') return CA.setAlias(pid, email, jsonBody(event));
    if (method === 'DELETE') { await CA.deleteAlias(pid, q.selector); return { ok: true }; }
    throw new HttpError(405, 'Method not allowed');
  }

  // the project's public website and its daily homepage screenshot (the All projects page)
  if (sub === 'site' && method === 'GET') {
    await P.getProject(email, pid); // authorization: caller must be a member
    if (!rest[0]) return SITE.getSite(pid);
    if (rest[0] === 'image' && !rest[1]) return SITE.getSiteImage(pid, q.day);
    throw new HttpError(404, 'Not found');
  }

  // whether a cost budget stopped collection for this project (shown as a banner to every member)
  if (sub === 'collection' && method === 'GET') {
    await P.getProject(email, pid);
    return { paused: await B.collectionPaused(pid) };
  }

  if (sub === 'error-suppressions') {
    await P.getProject(email, pid); // authorization: caller must be a member
    const [id] = rest;
    if (!id && method === 'GET') return SUP.listSuppressions(pid);
    if (!id && method === 'POST') return SUP.createSuppression(pid, email, jsonBody(event));
    if (id && method === 'DELETE') { await SUP.deleteSuppression(pid, id); return { ok: true }; }
    throw new HttpError(405, 'Method not allowed');
  }

  if (sub === 'goals') {
    await P.getProject(email, pid); // authorization: caller must be a member
    const [id, action] = rest;
    if (!id && method === 'GET') return G.listGoals(pid);
    if (!id && method === 'POST') return G.createGoal(pid, email, jsonBody(event));
    if (id && action === 'funnel' && method === 'GET') return GF.goalFunnel(pid, id, q);
    if (id && !action && method === 'PATCH') return G.updateGoal(pid, id, jsonBody(event));
    if (id && !action && method === 'DELETE') { await G.deleteGoal(pid, id); return { ok: true }; }
    throw new HttpError(405, 'Method not allowed');
  }

  if (sub === 'triggers' || sub === 'integrations' || sub === 'slack' || sub === 'destinations') {
    const project = await P.getProject(email, pid); // authorization: caller must be a member
    const [id, action] = rest;
    if (sub === 'triggers') {
      if (!id && method === 'GET') return T.listTriggers(pid);
      if (!id && method === 'POST') return T.createTrigger(pid, email, jsonBody(event), event.headers?.origin);
      if (id === 'preview' && !action && method === 'POST') return M.previewTrigger(pid, jsonBody(event));
      if (id && action === 'test' && method === 'POST') return T.testTrigger(pid, id, jsonBody(event));
      if (id && !action && method === 'PATCH') return T.updateTrigger(pid, email, id, jsonBody(event), event.headers?.origin);
      if (id && !action && method === 'DELETE') { await T.deleteTrigger(pid, id); return { ok: true }; }
    }
    if (sub === 'destinations') {
      const here = { level: 'project', pid } as const;
      if (!id && method === 'GET') return DST.listProjectDestinations(pid, email);
      if (!id && method === 'POST') return DST.createDestination(here, email, jsonBody(event));
      if (id && action === 'test' && method === 'POST') return DST.testDestination(here, id, project.name);
      if (id && !action && method === 'PATCH') return DST.updateDestination(here, email, id, jsonBody(event));
      if (id && !action && method === 'DELETE') { await DST.deleteDestination(here, id); return { ok: true }; }
    }
    if (sub === 'integrations') {
      if (!id && method === 'GET') return S.listIntegrations(pid);
      if (id && method === 'DELETE') { await S.deleteIntegration(pid, id); return { ok: true }; }
    }
    if (sub === 'slack') {
      const domain = event.requestContext.domainName;
      if (!id && method === 'GET') return S.setupStatus(pid, domain, email);
      // connect a workspace with a bot token: for the project (any member) or for yourself
      if (id === 'workspaces' && !action && method === 'POST') {
        const b = jsonBody<{ token?: unknown; level?: unknown }>(event);
        return S.connectWithToken(pid, email, b.token, b.level === 'account' ? 'account' : 'project');
      }
      // workspaces/{wid}[/channels]: the project's or your own
      if (id === 'workspaces' && action) {
        const more = rest[2];
        if (more === 'channels' && method === 'GET') return S.listChannels(pid, email, action);
        if (more === 'channels' && method === 'POST') return S.addChannel(pid, email, action, jsonBody<{ channelId?: unknown }>(event).channelId);
        if (!more && method === 'DELETE') { await S.disconnectWorkspace(pid, email, action); return S.setupStatus(pid, domain, email); }
      }
      if (id === 'install' && method === 'GET') return { url: await S.installUrl(pid, email, domain, T.dashboardOrigin(event.headers?.origin), q.level === 'account' ? 'account' : 'project') };
    }
    throw new HttpError(405, 'Method not allowed');
  }

  // session recordings: members watch them; only owners decide whether and how much is recorded. Not on kiosks.
  if (sub === 'recordings' && method === 'GET') {
    await P.getProject(email, pid);
    return rest[0] ? R.getRecording(pid, decodeURIComponent(rest[0]), q) : R.listRecordings(pid, q);
  }
  if (sub === 'recording-settings') {
    if (method === 'GET') { await P.getProject(email, pid); return R.getSettings(pid); }
    if (method === 'PATCH') { await P.requireOwner(email, pid); return R.saveSettings(pid, email, jsonBody(event)); }
    throw new HttpError(405, 'Method not allowed');
  }

  const read = READ_ROUTES[sub];
  if (read && method === 'GET') {
    await P.getProject(email, pid); // authorization: caller must be a member
    return read(pid, q, rest);
  }
  throw new HttpError(404, 'Not found');
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  try {
    const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
    if (!email) throw new HttpError(401, 'Token has no email claim (use the Cognito ID token)');
    // email allowlist: also covers accounts created before it was set, or whose email changed since
    if (!emailAllowed(email)) throw new HttpError(403, allowlistMessage());
    const parts = event.rawPath.split('/').filter(Boolean);
    const result = await route(event.requestContext.http.method, parts, event.queryStringParameters ?? {}, email, event);
    return json(200, result, { 'cache-control': 'private, max-age=5' });
  } catch (err) {
    return handleError(err);
  }
}
