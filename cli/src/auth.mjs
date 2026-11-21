// Sign-in with Cognito, the same way MCP clients (Claude, VS Code…) do it against WGO:
//
//   1. Discovery: /mcp answers 401 with the protected resource metadata URL (RFC 9728), which names the
//      authorization server; its RFC 8414 document lists Cognito's managed login, token and revoke endpoints.
//   2. Dynamic client registration (RFC 7591) at /mcp/register, which WGO forwards to Cognito. Done once per
//      server and kept, together with the loopback port it was registered with.
//   3. Authorization code + PKCE in the browser (Cognito managed login), redirecting to http://localhost:<port>/callback.
//      The token request carries `resource` = the MCP URL (RFC 8707), so the access token's `aud` is that URL.
//   4. The access token lasts an hour; the refresh token (30 days) renews it without a browser.
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'

/**
 * @typedef {{
 *   resource: string, issuer: string, scope: string,
 *   tokenEndpoint: string, revocationEndpoint?: string,
 *   clientId: string, clientSecret?: string, redirectUri: string,
 *   accessToken?: string, refreshToken?: string, expiresAt?: number,
 * }} Credentials
 */

export const CLIENT_NAME = 'WGO CLI'
const CALLBACK_PATH = '/callback'
const LOGIN_TIMEOUT_MS = 5 * 60_000
/** Renew this long before the access token expires, so a slow request doesn't carry an expired one. */
const EXPIRY_MARGIN_MS = 60_000

export class AuthRequiredError extends Error {
  constructor(url, detail) {
    super(`Not signed in to ${url}${detail ? ` (${detail})` : ''}. Run: wgo login${url ? ` --url ${new URL(url).origin}` : ''}`)
    this.name = 'AuthRequiredError'
  }
}

const b64url = (buf) => buf.toString('base64url')

export function pkcePair() {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

async function getJson(fetchImpl, url, what) {
  let res
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' } })
  } catch (err) {
    throw new Error(`Could not reach ${url}: ${err.cause?.message ?? err.message}`)
  }
  if (!res.ok) return { status: res.status, body: null }
  try {
    return { status: res.status, body: await res.json() }
  } catch {
    throw new Error(`${what} at ${url} is not JSON`)
  }
}

/** `resource_metadata="…"` from a WWW-Authenticate: Bearer challenge. */
export function resourceMetadataUrl(header) {
  return header?.match(/resource_metadata="([^"]+)"/)?.[1]
}

/**
 * Finds out how to sign in to the MCP server at `url`. Returns null when it needs no sign-in (the local dev
 * server), else the resource, the scope to ask for and the authorization server's endpoints.
 */
export async function discover(url, fetchImpl = fetch) {
  let probe
  try {
    probe = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }),
    })
  } catch (err) {
    throw new Error(`Could not reach ${url}: ${err.cause?.message ?? err.message}`)
  }
  await probe.body?.cancel()
  if (probe.ok) return null
  if (probe.status === 404) throw new Error(`No MCP server at ${url}. Is MCP enabled on this WGO instance (MCP_ENABLED)?`)
  if (probe.status !== 401) throw new Error(`${url} answered ${probe.status}`)

  const u = new URL(url)
  const candidates = [
    resourceMetadataUrl(probe.headers.get('www-authenticate')),
    `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`,
    `${u.origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean)
  let prm
  for (const c of candidates) if ((prm = (await getJson(fetchImpl, c, 'Protected resource metadata')).body)) break
  if (!prm?.authorization_servers?.length) throw new Error(`${url} requires sign-in but publishes no OAuth metadata`)

  const issuer = String(prm.authorization_servers[0]).replace(/\/+$/, '')
  const is = new URL(issuer)
  const path = is.pathname === '/' ? '' : is.pathname
  let as
  for (const c of [`${is.origin}/.well-known/oauth-authorization-server${path}`, `${is.origin}/.well-known/openid-configuration${path}`, `${issuer}/.well-known/openid-configuration`]) {
    if ((as = (await getJson(fetchImpl, c, 'Authorization server metadata')).body)) break
  }
  if (!as?.authorization_endpoint || !as?.token_endpoint) throw new Error(`No authorization server metadata for ${issuer}`)
  if (!as.registration_endpoint) throw new Error(`${issuer} does not support client registration, which the CLI needs`)

  return {
    resource: String(prm.resource ?? url),
    issuer,
    scope: (prm.scopes_supported ?? []).join(' '),
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint,
    revocationEndpoint: as.revocation_endpoint,
  }
}

/** Registers the CLI as an OAuth client (public, PKCE) for one loopback redirect URI. */
export async function registerClient(meta, redirectUri, fetchImpl = fetch) {
  const res = await fetchImpl(meta.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(meta.scope ? { scope: meta.scope } : {}),
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.client_id) throw new Error(`Client registration failed (${res.status}): ${body.error_description ?? body.error ?? 'no client_id'}`)
  return { clientId: body.client_id, clientSecret: body.client_secret || undefined }
}

/** POSTs a form to the token (or revocation) endpoint, with HTTP Basic client auth when the client has a secret. */
async function tokenRequest(endpoint, params, creds, fetchImpl) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  const form = new URLSearchParams(params)
  if (creds.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(creds.clientId)}:${encodeURIComponent(creds.clientSecret)}`).toString('base64')}`
  } else form.set('client_id', creds.clientId)
  return fetchImpl(endpoint, { method: 'POST', headers, body: form })
}

function withTokens(creds, body) {
  if (!body.access_token) throw new Error('Token response has no access_token')
  return {
    ...creds,
    accessToken: body.access_token,
    // Cognito doesn't rotate refresh tokens unless configured to: keep the old one when none comes back
    refreshToken: body.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000,
  }
}

/** Exchanges a refresh token for a new access token. Returns null when the refresh token is no longer valid. */
export async function refresh(creds, fetchImpl = fetch) {
  if (!creds.refreshToken) return null
  const res = await tokenRequest(creds.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: creds.refreshToken, resource: creds.resource }, creds, fetchImpl)
  const body = await res.json().catch(() => ({}))
  if (res.status === 400 || res.status === 401) return null // invalid_grant: expired, revoked or the user was disabled
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${body.error_description ?? body.error ?? ''}`)
  return withTokens(creds, body)
}

/**
 * A valid access token for `url`: the stored one, or a refreshed one (saved). Null when there is no session
 * (never signed in, signed out, or a server that needs no sign-in). Throws AuthRequiredError when the session can't be renewed.
 * `force` renews even if the stored token looks valid (after the server rejected it).
 */
export async function accessToken(store, url, { force = false, fetchImpl = fetch } = {}) {
  const creds = await store.credentials(url)
  if (!creds?.accessToken) return null
  if (!force && creds.expiresAt && creds.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return creds.accessToken
  const renewed = await refresh(creds, fetchImpl)
  if (!renewed) {
    await store.saveCredentials(url, { ...creds, accessToken: undefined, refreshToken: undefined, expiresAt: undefined })
    throw new AuthRequiredError(url, 'session expired')
  }
  await store.saveCredentials(url, renewed)
  return renewed.accessToken
}

/** Opens `url` in the default browser. Resolves false if no browser could be started. */
export function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
      child.once('error', () => resolve(false))
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}

const PAGE = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#222">
<h1 style="font-size:1.4rem;font-weight:600">${title}</h1><p>${text}</p></body>`

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Listens on `port` (0 = any free one) on IPv4 and, when available, IPv6 loopback. */
async function listenLoopback(port, onRequest) {
  const listen = (host, p) => new Promise((resolve, reject) => {
    const server = createServer(onRequest)
    server.once('error', reject)
    server.listen(p, host, () => resolve(server))
  })
  const v4 = await listen('127.0.0.1', port)
  const actual = v4.address().port
  // `localhost` may resolve to ::1 in the browser; best effort, as some machines have no IPv6
  const v6 = await listen('::1', actual).catch(() => null)
  return { port: actual, close: () => { v4.close(); v4.closeAllConnections?.(); v6?.close(); v6?.closeAllConnections?.() } }
}

/** The code from a pasted redirect URL (for when the browser runs on another machine). */
export function codeFromRedirect(text, state) {
  let u
  try {
    u = new URL(text.trim())
  } catch {
    throw new Error('That is not a URL. Paste the full address from the browser\'s address bar.')
  }
  const err = u.searchParams.get('error')
  if (err) throw new Error(`Sign-in failed: ${u.searchParams.get('error_description') ?? err}`)
  if (u.searchParams.get('state') !== state) throw new Error('That URL belongs to another sign-in attempt (state mismatch)')
  const code = u.searchParams.get('code')
  if (!code) throw new Error('That URL has no ?code=')
  return code
}

/**
 * Signs in to the MCP server at `url` in the browser and saves the tokens.
 * @param {{ store: import('./store.mjs').Store, url: string, browser?: boolean, log?: (s: string) => void,
 *   open?: (url: string) => Promise<boolean>, fetchImpl?: typeof fetch, input?: NodeJS.ReadableStream & { isTTY?: boolean } }} opts
 * @returns {Promise<'signed-in' | 'no-auth'>}
 */
export async function login({ store, url, browser = true, log = (s) => process.stderr.write(s + '\n'), open = openBrowser, fetchImpl = fetch, input = process.stdin }) {
  const meta = await discover(url, fetchImpl)
  if (!meta) return 'no-auth'

  const previous = await store.credentials(url)
  // keep the registration when it was made with this authorization server (it's tied to its redirect port)
  const reuse = previous?.clientId && previous.issuer === meta.issuer && previous.tokenEndpoint === meta.tokenEndpoint && previous.scope === meta.scope
  const wantedPort = reuse ? Number(new URL(previous.redirectUri).port) : 0

  const state = b64url(randomBytes(16))
  let settle
  const result = new Promise((resolve, reject) => (settle = { resolve, reject }))
  const onRequest = (req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    if (u.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end()
      return
    }
    const err = u.searchParams.get('error')
    if (u.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in not completed', 'This link belongs to another sign-in attempt. Run <code>wgo login</code> again.'))
      return
    }
    if (err) {
      const detail = u.searchParams.get('error_description') ?? err
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in failed', escapeHtml(detail)))
      settle.reject(new Error(`Sign-in failed: ${detail}`))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Signed in to WGO', 'You can close this tab and return to the terminal.'))
    settle.resolve(u.searchParams.get('code'))
  }

  let loopback
  try {
    loopback = await listenLoopback(wantedPort, onRequest)
  } catch (err) {
    if (!wantedPort || err.code !== 'EADDRINUSE') throw err
    loopback = await listenLoopback(0, onRequest) // the registered port is taken: register again with a new one
  }
  let stopPaste = () => {}
  const timer = setTimeout(() => settle.reject(new Error('Sign-in timed out after 5 minutes')), LOGIN_TIMEOUT_MS)
  try {
    const redirectUri = `http://localhost:${loopback.port}${CALLBACK_PATH}`
    const client = reuse && previous.redirectUri === redirectUri
      ? { clientId: previous.clientId, clientSecret: previous.clientSecret }
      : await registerClient(meta, redirectUri, fetchImpl)

    const pkce = pkcePair()
    const authUrl = new URL(meta.authorizationEndpoint)
    authUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      resource: meta.resource,
      ...(meta.scope ? { scope: meta.scope } : {}),
    }).toString()

    const opened = browser && (await open(authUrl.toString()))
    log(opened ? 'Opened the sign-in page in your browser. If it did not open, visit:' : 'Open this address in a browser to sign in:')
    log(`\n  ${authUrl}\n`)
    if (input.isTTY) {
      log('Waiting for the browser… If it runs on another machine, paste the address it ends up on (http://localhost…/callback?code=…) here:')
      const rl = createInterface({ input, terminal: false })
      rl.on('line', (line) => {
        if (!line.trim()) return
        try {
          settle.resolve(codeFromRedirect(line, state))
        } catch (err) {
          log(err.message)
        }
      })
      stopPaste = () => rl.close()
    } else log('Waiting for the browser…')

    const code = await result
    const res = await tokenRequest(meta.tokenEndpoint, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: pkce.verifier, resource: meta.resource }, client, fetchImpl)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`Token request failed (${res.status}): ${body.error_description ?? body.error ?? ''}`)

    await store.saveCredentials(url, withTokens({
      resource: meta.resource, issuer: meta.issuer, scope: meta.scope,
      tokenEndpoint: meta.tokenEndpoint, revocationEndpoint: meta.revocationEndpoint,
      ...client, redirectUri,
    }, body))
    return 'signed-in'
  } finally {
    clearTimeout(timer)
    stopPaste()
    loopback.close()
  }
}

/** Revokes the refresh token (best effort) and forgets the tokens. The client registration is kept for the next login. */
export async function logout(store, url, fetchImpl = fetch) {
  const creds = await store.credentials(url)
  if (!creds?.refreshToken && !creds?.accessToken) return false
  if (creds.refreshToken && creds.revocationEndpoint) {
    await tokenRequest(creds.revocationEndpoint, { token: creds.refreshToken }, creds, fetchImpl).catch(() => {})
  }
  await store.saveCredentials(url, { ...creds, accessToken: undefined, refreshToken: undefined, expiresAt: undefined })
  return true
}
