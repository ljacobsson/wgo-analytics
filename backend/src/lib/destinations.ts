import { randomBytes, randomUUID } from 'node:crypto';
import type { Destination, DestinationInput, DestinationLevel, SlackIntegration, Trigger, TriggerDestination, TriggerTestResult } from '../contract';
import { query } from './db';
import { HttpError } from './http';
import { isUuid } from './projects';
import { channelTarget, deleteIntegration, listIntegrations, type SlackChannelConfig } from './slack';
import { assertPublicHttpsUrl, postNotification, samplePayload } from './triggers';

/**
 * Saved trigger destinations, reusable by many triggers. Two levels:
 * - project (project_id set): any member uses and manages them, like the project's triggers;
 * - account (owner_email set): one person's, usable by triggers in every project they're a member of. Only the owner
 *   manages them or picks them for a trigger; other members see the name, type and host. When the owner leaves a
 *   project, its triggers stop sending to the owner's destinations.
 * Project Slack channels live in `integrations` (from before saved destinations existed, and new ones still go there);
 * they are listed here as project destinations. Saved webhooks sign with their own secret.
 */

const MAX_PER_OWNER = 50;

interface Row {
  id: string; project_id: string | null; owner_email: string | null; name: string; type: 'webhook' | 'slack';
  config: { url?: string } & Partial<SlackChannelConfig>; signing_secret: string;
  created_by: string; created_at: Date;
}

/** Where a destination lives: one person's account, or a project. */
export type Owner = { level: 'account'; email: string } | { level: 'project'; pid: string };

const hostOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
};

const levelOf = (r: Row): DestinationLevel => (r.project_id ? 'project' : 'account');

function toDestination(r: Row, viewer: string): Destination {
  const level = levelOf(r);
  const editable = level === 'project' || r.owner_email === viewer;
  const webhook = r.type === 'webhook';
  return {
    id: r.id, level, type: r.type, name: r.name,
    detail: webhook ? hostOf(r.config.url) : r.config.teamName ?? null,
    ...(webhook && editable ? { url: r.config.url, signingSecret: r.signing_secret } : {}),
    owner: r.owner_email, editable, ref: { type: 'saved', destinationId: r.id },
    createdBy: r.created_by, createdAt: r.created_at.toISOString(),
  };
}

const ownerWhere = (o: Owner): [string, string] => (o.level === 'project' ? ['project_id = $1', o.pid] : ['owner_email = $1 AND project_id IS NULL', o.email]);

async function rowsOf(o: Owner): Promise<Row[]> {
  const [where, v] = ownerWhere(o);
  return query<Row>(`SELECT * FROM destinations WHERE ${where} ORDER BY created_at`, [v]);
}

async function getRow(o: Owner, id: string): Promise<Row> {
  const [where, v] = ownerWhere(o);
  const [r] = isUuid(id) ? await query<Row>(`SELECT * FROM destinations WHERE ${where} AND id = $2`, [v, id]) : [];
  if (!r) throw new HttpError(404, 'Destination not found');
  return r;
}

// ---------------------------------------------------------------- listing

/** Your account destinations. */
export async function listAccountDestinations(email: string): Promise<Destination[]> {
  return (await rowsOf({ level: 'account', email })).map((r) => toDestination(r, email));
}

/** What a trigger saved by `email` in project `pid` can pick: the project's destinations, then the caller's own. */
export async function listProjectDestinations(pid: string, email: string): Promise<Destination[]> {
  const [slack, rows, mine] = await Promise.all([listIntegrations(pid), rowsOf({ level: 'project', pid }), rowsOf({ level: 'account', email })]);
  const project = [...slack.map(integrationDestination), ...rows.map((r) => toDestination(r, email))].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return [...project, ...mine.map((r) => toDestination(r, email))];
}

/** A project Slack channel (stored in `integrations`) as a destination. */
export const integrationDestination = (i: SlackIntegration): Destination => ({
  id: i.id, level: 'project', type: 'slack', name: i.channel, detail: i.teamName, owner: null, editable: true,
  ref: { type: 'slack', integrationId: i.id }, createdBy: i.createdBy, createdAt: i.createdAt,
});

// ---------------------------------------------------------------- managing (webhooks; Slack channels come from "Add to Slack")

const destName = (v: unknown) => {
  const n = typeof v === 'string' ? v.trim() : '';
  if (!n || n.length > 120) throw new HttpError(400, 'Destination name must be 1-120 characters');
  return n;
};
const destUrl = (v: unknown) => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'url is required');
  return assertPublicHttpsUrl(v.trim()).toString();
};

export async function createDestination(o: Owner, email: string, body: Partial<DestinationInput>): Promise<Destination> {
  const name = destName(body.name);
  const url = destUrl(body.url);
  if ((await rowsOf(o)).length >= MAX_PER_OWNER) throw new HttpError(400, `At most ${MAX_PER_OWNER} destinations`);
  const id = randomUUID();
  await query(
    `INSERT INTO destinations (id, project_id, owner_email, name, type, config, signing_secret, created_by)
     VALUES ($1, $2, $3, $4, 'webhook', $5::jsonb, $6, $7)`,
    [id, o.level === 'project' ? o.pid : null, o.level === 'account' ? o.email : null, name, JSON.stringify({ url }), 'whsec_' + randomBytes(24).toString('base64url'), email],
  );
  return toDestination(await getRow(o, id), email);
}

export async function updateDestination(o: Owner, email: string, id: string, body: Partial<DestinationInput>): Promise<Destination> {
  const cur = await getRow(o, id);
  const name = body.name !== undefined ? destName(body.name) : cur.name;
  let config = cur.config;
  if (body.url !== undefined) {
    if (cur.type !== 'webhook') throw new HttpError(400, 'A Slack channel has no URL to change');
    config = { ...config, url: destUrl(body.url) };
  }
  await query('UPDATE destinations SET name = $2, config = $3::jsonb WHERE id = $1', [id, name, JSON.stringify(config)]);
  return toDestination(await getRow(o, id), email);
}

/** Refuses while a trigger uses it, naming the triggers (and, for account destinations, their projects). */
export async function deleteDestination(o: Owner, id: string): Promise<void> {
  if (o.level === 'project' && isUuid(id)) {
    const [legacy] = await query(`SELECT 1 FROM integrations WHERE project_id = $1 AND id = $2 AND type = 'slack'`, [o.pid, id]);
    if (legacy) return deleteIntegration(o.pid, id);
  }
  await getRow(o, id);
  const used = await query<{ name: string; project: string | null }>(
    `SELECT t.name, p.name AS project FROM triggers t LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.destination->>'destinationId' = $1 ORDER BY p.name, t.name`,
    [id],
  );
  if (used.length) {
    const names = used.map((u) => (o.level === 'account' && u.project ? `${u.name} (${u.project})` : u.name));
    throw new HttpError(409, `Still used by trigger${used.length > 1 ? 's' : ''}: ${names.join(', ')}`);
  }
  await query('DELETE FROM destinations WHERE id = $1', [id]);
}

/** Saves a Slack channel of the person's own workspace as their own destination. */
export async function saveAccountSlack(email: string, config: SlackChannelConfig): Promise<Destination> {
  const o: Owner = { level: 'account', email };
  if ((await rowsOf(o)).length >= MAX_PER_OWNER) throw new HttpError(400, `At most ${MAX_PER_OWNER} destinations`);
  const id = randomUUID();
  await query(
    `INSERT INTO destinations (id, project_id, owner_email, name, type, config, signing_secret, created_by)
     VALUES ($1, NULL, $2, $3, 'slack', $4::jsonb, $5, $2)`,
    [id, email, config.channel, JSON.stringify(config), 'whsec_' + randomBytes(24).toString('base64url')],
  );
  return toDestination(await getRow(o, id), email);
}

/** A sample notification to a destination, marked as a test. */
export async function testDestination(o: Owner, id: string, projectName: string | null): Promise<TriggerTestResult> {
  if (o.level === 'project' && isUuid(id)) {
    const [channel] = await query<{ config: SlackChannelConfig }>(`SELECT config FROM integrations WHERE project_id = $1 AND id = $2 AND type = 'slack'`, [o.pid, id]);
    if (channel) return testTarget(await channelTarget(channel.config, null), o.pid, projectName);
  }
  const r = await getRow(o, id);
  return testTarget(await targetOf(r), o.level === 'project' ? o.pid : '', projectName);
}

async function testTarget(target: Target | string, pid: string, projectName: string | null): Promise<TriggerTestResult> {
  const status = typeof target === 'string' ? target : await postNotification(target, samplePayload(pid, projectName));
  return { ok: /^2\d\d$/.test(status), status };
}

// ---------------------------------------------------------------- used by triggers

/** Where a notification goes: a URL (a webhook, or an older Slack channel's incoming webhook), or a channel via a bot token. */
export type Target = { url: string; slack: boolean; secret: string | null; id: string | null } | { token: string; channelId: string };

const targetOf = async (r: Row): Promise<Target | string> =>
  r.type === 'slack' ? channelTarget(r.config as SlackChannelConfig, r.id) : { url: r.config.url!, slack: false, secret: r.signing_secret, id: r.id };

/**
 * Where a trigger of project `pid` with a saved destination sends, or why it can't (as a delivery status): the
 * destination was deleted, or it is someone's account destination and they're no longer a member of the project.
 */
export async function savedTarget(pid: string, id: string): Promise<Target | string> {
  const [r] = isUuid(id) ? await query<Row>('SELECT * FROM destinations WHERE id = $1', [id]) : [];
  if (!r) return 'destination deleted';
  if (r.project_id) return r.project_id === pid ? targetOf(r) : 'destination deleted';
  const [member] = await query('SELECT 1 FROM project_members WHERE project_id = $1 AND email = $2', [pid, r.owner_email]);
  return member ? targetOf(r) : 'destination owner is no longer a member';
}

/** Whether `email` may newly point a trigger of `pid` at saved destination `id`: the project's, or their own. */
export async function canPick(pid: string, email: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await query('SELECT 1 FROM destinations WHERE id = $1 AND (project_id = $2 OR (project_id IS NULL AND owner_email = $3))', [id, pid, email]);
  return rows.length > 0;
}

/** Display labels of the saved destinations the triggers use (visible to every member, unlike the URLs). */
export async function labelsFor(destinations: TriggerDestination[]): Promise<Map<string, NonNullable<Trigger['destinationLabel']>>> {
  const ids = [...new Set(destinations.flatMap((d) => (d.type === 'saved' && isUuid(d.destinationId) ? [d.destinationId] : [])))];
  const out = new Map<string, NonNullable<Trigger['destinationLabel']>>();
  if (!ids.length) return out;
  const rows = await query<Row>('SELECT * FROM destinations WHERE id = ANY($1::uuid[])', [ids]);
  for (const r of rows) out.set(r.id, { name: r.name, type: r.type, owner: r.owner_email, detail: r.type === 'webhook' ? hostOf(r.config.url) : r.config.teamName ?? null });
  return out;
}
