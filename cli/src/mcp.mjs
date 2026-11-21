// A minimal MCP client for WGO's stateless Streamable HTTP endpoint: one JSON-RPC POST per call, no session.
import { accessToken, AuthRequiredError } from './auth.mjs'

export const PROTOCOL_VERSION = '2025-11-25'

export class McpError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'McpError'
    this.code = code
  }
}

/** The JSON-RPC response in a `text/event-stream` body: the last `data:` event that carries a result or error. */
export function parseSse(text, id) {
  let found
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
    if (!data) continue
    try {
      const msg = JSON.parse(data)
      if (msg.id === id && ('result' in msg || 'error' in msg)) found = msg
    } catch { /* keep-alive or partial event */ }
  }
  return found
}

export class McpClient {
  /** @param {{ url: string, store: import('./store.mjs').Store, fetchImpl?: typeof fetch }} opts */
  constructor({ url, store, fetchImpl = fetch }) {
    this.url = url
    this.store = store
    this.fetchImpl = fetchImpl
    this.nextId = 1
  }

  async post(body, token) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION }
    if (token) headers.authorization = `Bearer ${token}`
    try {
      return await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(body) })
    } catch (err) {
      throw new Error(`Could not reach ${this.url}: ${err.cause?.message ?? err.message}`)
    }
  }

  /** Sends one JSON-RPC request; renews the token once if the server rejects it. */
  async request(method, params) {
    const id = this.nextId++
    const body = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }
    let token = await accessToken(this.store, this.url, { fetchImpl: this.fetchImpl })
    let res = await this.post(body, token)
    if (res.status === 401 && token) {
      await res.body?.cancel()
      token = await accessToken(this.store, this.url, { force: true, fetchImpl: this.fetchImpl })
      res = await this.post(body, token)
    }
    if (res.status === 401) {
      await res.body?.cancel()
      throw new AuthRequiredError(this.url)
    }
    const text = await res.text()
    if (!res.ok) {
      let detail = text
      try {
        detail = JSON.parse(text).error ?? text
      } catch { /* not JSON */ }
      if (typeof detail === 'object') detail = detail.message ?? JSON.stringify(detail)
      if (res.status === 404) throw new Error(`No MCP server at ${this.url} (${detail || 404})`)
      throw new Error(`${this.url} answered ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    const msg = (res.headers.get('content-type') ?? '').includes('text/event-stream') ? parseSse(text, id) : JSON.parse(text)
    if (!msg) throw new Error('Empty response from the MCP server')
    if (msg.error) throw new McpError(msg.error.message ?? 'MCP error', msg.error.code)
    return msg.result
  }

  /** Every tool, following pagination. */
  async listTools() {
    const tools = []
    let cursor
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : undefined)
      tools.push(...(page.tools ?? []))
      cursor = page.nextCursor
    } while (cursor)
    return tools
  }

  /** The server's usage instructions (the `instructions` of its initialize result). */
  async instructions() {
    const res = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'wgo-cli', version: '1' },
    })
    return res?.instructions ?? ''
  }

  /** @returns {Promise<{ content?: { type: string, text?: string }[], structuredContent?: unknown, isError?: boolean }>} */
  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args })
  }
}
