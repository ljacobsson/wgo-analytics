// The whole CLI against a fake WGO server that behaves like the real one (backend/src/lib/mcp/http.ts) with
// Cognito behind it: 401 challenge, discovery documents, registration, authorize redirect, PKCE token exchange.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main } from '../src/main.mjs'
import { Store } from '../src/store.mjs'

const PID = '11111111-2222-3333-4444-555555555555'
const fake = { registrations: [], codes: new Map(), tokens: new Set(), refreshes: 0, revoked: [], calls: [] }
let origin, server, dir

const TOOLS = [
  { name: 'list_projects', title: 'List projects', description: 'Projects you are a member of.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'list_errors', annotations: { title: 'JavaScript errors' }, description: 'Errors grouped by fingerprint.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, range: { type: 'string' }, limit: { type: 'integer' } }, required: ['projectId'] },
  },
]

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
}

async function body(req) {
  let s = ''
  for await (const c of req) s += c
  return s
}

async function handle(req, res) {
  const u = new URL(req.url, origin)
  const resource = `${origin}/mcp`
  if (u.pathname === '/.well-known/oauth-protected-resource/mcp') {
    return json(res, 200, { resource, authorization_servers: [origin], scopes_supported: [`${resource}/read`] })
  }
  if (u.pathname === '/.well-known/oauth-authorization-server') {
    return json(res, 200, {
      issuer: origin, authorization_endpoint: `${origin}/oauth2/authorize`, token_endpoint: `${origin}/oauth2/token`,
      registration_endpoint: `${origin}/mcp/register`, revocation_endpoint: `${origin}/oauth2/revoke`,
    })
  }
  if (u.pathname === '/mcp/register') {
    const meta = JSON.parse(await body(req))
    fake.registrations.push(meta)
    return json(res, 201, { client_id: `client-${fake.registrations.length}`, redirect_uris: meta.redirect_uris })
  }
  if (u.pathname === '/oauth2/authorize') {
    const p = u.searchParams
    const reg = fake.registrations.find((_, i) => `client-${i + 1}` === p.get('client_id'))
    if (!reg?.redirect_uris.includes(p.get('redirect_uri'))) return json(res, 400, { error: 'redirect_mismatch' })
    if (p.get('resource') !== resource || p.get('scope') !== `${resource}/read` || p.get('code_challenge_method') !== 'S256') return json(res, 400, { error: 'invalid_request' })
    const code = `code-${fake.codes.size + 1}`
    fake.codes.set(code, { challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri'), clientId: p.get('client_id') })
    res.writeHead(302, { location: `${p.get('redirect_uri')}?code=${code}&state=${p.get('state')}` }).end()
    return
  }
  if (u.pathname === '/oauth2/token') {
    const p = new URLSearchParams(await body(req))
    if (p.get('resource') !== resource) return json(res, 400, { error: 'invalid_target' })
    if (p.get('grant_type') === 'authorization_code') {
      const c = fake.codes.get(p.get('code'))
      fake.codes.delete(p.get('code'))
      const challenge = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url')
      if (!c || c.challenge !== challenge || c.redirectUri !== p.get('redirect_uri') || c.clientId !== p.get('client_id')) return json(res, 400, { error: 'invalid_grant' })
    } else if (p.get('grant_type') === 'refresh_token') {
      if (p.get('refresh_token') !== 'rt' || fake.revoked.includes('rt')) return json(res, 400, { error: 'invalid_grant' })
      fake.refreshes++
    } else return json(res, 400, { error: 'unsupported_grant_type' })
    const at = `at-${fake.tokens.size + 1}`
    fake.tokens.add(at)
    return json(res, 200, { access_token: at, expires_in: 3600, token_type: 'Bearer', ...(p.get('grant_type') === 'authorization_code' ? { refresh_token: 'rt' } : {}) })
  }
  if (u.pathname === '/oauth2/revoke') {
    fake.revoked.push(new URLSearchParams(await body(req)).get('token'))
    return json(res, 200, {})
  }
  if (u.pathname === '/mcp' && req.method === 'POST') {
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    if (!fake.tokens.has(token)) {
      return json(res, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` })
    }
    const msg = JSON.parse(await body(req))
    fake.calls.push(msg)
    const reply = (result) => json(res, 200, { jsonrpc: '2.0', id: msg.id, result })
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'wgo' }, instructions: 'Call list_projects first, then list_errors.' })
    if (msg.method === 'tools/list') return reply({ tools: TOOLS })
    if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params
      if (name === 'list_projects') return reply({ content: [{ type: 'text', text: JSON.stringify({ email: 'dev@example.com', projects: [{ id: PID, name: 'Shop', role: 'owner' }] }) }] })
      if (name === 'list_errors') {
        if (args.projectId !== PID) return reply({ content: [{ type: 'text', text: 'Project not found' }], isError: true })
        return reply({ content: [{ type: 'text', text: JSON.stringify([{ message: 'boom', count: 3, args }, { message: 'bang', count: 1, args }]) }] })
      }
    }
    return json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
  }
  json(res, 404, { error: 'Not found' })
}

/** Runs the CLI; the "browser" follows the sign-in page's redirect back to the CLI's loopback server. */
async function run(...argv) {
  let stdout = ''
  let stderr = ''
  const code = await main(argv, {
    env: {},
    store: new Store(dir),
    stdout: { write: (s) => (stdout += s), isTTY: false },
    stderr: { write: (s) => (stderr += s) },
    stdin: Readable.from([]),
    open: async (url) => {
      fetch(url).catch(() => {})
      return true
    },
  })
  return { code, stdout, stderr }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wgo-cli-'))
  server = createServer((req, res) => handle(req, res).catch((e) => json(res, 500, { error: String(e) })))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

describe('wgo CLI end to end', () => {
  it('needs a server before anything else', async () => {
    const r = await run('list-errors')
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/wgo login --url/)
  })

  it('signs in through registration, the browser and the PKCE token exchange', async () => {
    const r = await run('login', '--url', origin)
    expect(r.stderr).toContain(`Signed in to ${origin}/mcp as dev@example.com`)
    expect(r.code).toBe(0)
    expect(fake.registrations).toHaveLength(1)
    expect(fake.registrations[0]).toMatchObject({ client_name: 'WGO CLI', token_endpoint_auth_method: 'none', scope: `${origin}/mcp/read` })
    expect(fake.registrations[0].redirect_uris[0]).toMatch(/^http:\/\/localhost:\d+\/callback$/)

    const creds = JSON.parse(await readFile(join(dir, 'credentials.json'), 'utf8'))[`${origin}/mcp`]
    expect(creds).toMatchObject({ clientId: 'client-1', refreshToken: 'rt', resource: `${origin}/mcp` })
    if (process.platform !== 'win32') expect((await import('node:fs')).statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600)
  })

  it('lists the server\'s tools as commands in help', async () => {
    const r = await run('--help')
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/list-projects\s+List projects/)
    expect(r.stdout).toMatch(/list-errors\s+JavaScript errors/)
  })

  it('shows the server guide with command names', async () => {
    const r = await run('guide')
    expect(r.stdout).toContain('Call list-projects first, then list-errors.')
  })

  it('runs a tool and prints compact JSON', async () => {
    const r = await run('list-projects')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`{"email":"dev@example.com","projects":[{"id":"${PID}","name":"Shop","role":"owner"}]}\n`)
  })

  it('resolves projects by name, from -p or the default', async () => {
    expect((await run('list-errors')).stderr).toMatch(/Missing --project-id. Pass -p/)
    const byFlag = await run('list-errors', '-p', 'shop', '--limit', '2', '--range', '1h')
    expect(byFlag.code).toBe(0)
    expect(JSON.parse(byFlag.stdout)[0].args).toEqual({ projectId: PID, limit: 2, range: '1h' })

    expect((await run('use', 'Shop')).stderr).toContain(`Default project: Shop (${PID})`)
    const r = await run('list-errors', '--fields', 'message,count', '--format', 'tsv')
    expect(r.stdout).toBe('message\tcount\nboom\t3\nbang\t1\n')
    expect((await run('list-errors', '-p', 'nope')).stderr).toMatch(/No project "nope"/)
  })

  it('reports tool errors with exit status 1 and usage errors with 2', async () => {
    const r = await run('list-errors', '--project-id', '99999999-2222-3333-4444-555555555555')
    expect(r).toMatchObject({ code: 1, stderr: 'Project not found\n' })
    expect((await run('list-errors', '--bogus', '1')).code).toBe(2)
    expect((await run('no-such-command')).code).toBe(2)
  })

  it('renews an expired access token with the refresh token', async () => {
    const file = join(dir, 'credentials.json')
    const all = JSON.parse(await readFile(file, 'utf8'))
    all[`${origin}/mcp`].expiresAt = Date.now() - 1000
    await writeFile(file, JSON.stringify(all))
    const before = fake.refreshes
    expect((await run('list-projects')).code).toBe(0)
    expect(fake.refreshes).toBe(before + 1)
  })

  it('renews when the server rejects a token that looked valid', async () => {
    fake.tokens.clear()
    const before = fake.refreshes
    expect((await run('list-projects')).code).toBe(0)
    expect(fake.refreshes).toBe(before + 1)
  })

  it('signs out, revoking the refresh token, and signs in again with the same registration', async () => {
    expect((await run('logout')).stderr).toContain('Signed out')
    expect(fake.revoked).toContain('rt')
    const r = await run('list-projects')
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/Not signed in .* Run: wgo login/)

    fake.revoked.length = 0
    expect((await run('login')).code).toBe(0)
    expect(fake.registrations).toHaveLength(1)
    expect((await run('status')).stdout).toContain('Account  dev@example.com')
  })
})
