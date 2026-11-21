// Local state: config.json (default server, default project per server, cached tool lists) and
// credentials.json (OAuth client registration and tokens per server, mode 0600).
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `$WGO_CONFIG_DIR`, else `$XDG_CONFIG_HOME/wgo`, `%APPDATA%\wgo` on Windows, `~/.config/wgo`. */
export function configDir(env = process.env) {
  if (env.WGO_CONFIG_DIR) return env.WGO_CONFIG_DIR
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'wgo')
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'wgo')
  return join(homedir(), '.config', 'wgo')
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    if (err instanceof SyntaxError) throw new Error(`${file} is not valid JSON. Fix or delete it.`)
    throw err
  }
}

/** Writes through a temporary file so a crash never leaves half a file; `mode` applies to new and existing files. */
async function writeJson(file, data, mode) {
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode })
  await chmod(tmp, mode)
  await rename(tmp, file)
}

export class Store {
  constructor(dir = configDir()) {
    this.dir = dir
    this.configFile = join(dir, 'config.json')
    this.credentialsFile = join(dir, 'credentials.json')
  }

  async ensureDir() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
  }

  /** @returns {Promise<{ url?: string, servers?: Record<string, { project?: string, tools?: { fetchedAt: number, list: any[] } }> }>} */
  readConfig() {
    return readJson(this.configFile)
  }

  async updateConfig(fn) {
    await this.ensureDir()
    const cfg = await this.readConfig()
    fn(cfg)
    await writeJson(this.configFile, cfg, 0o600)
    return cfg
  }

  /** Settings of one server (by MCP URL) from config.json. */
  async server(url) {
    return (await this.readConfig()).servers?.[url] ?? {}
  }

  async updateServer(url, fn) {
    return this.updateConfig((cfg) => {
      cfg.servers ??= {}
      cfg.servers[url] ??= {}
      fn(cfg.servers[url])
    })
  }

  /** @returns {Promise<import('./auth.mjs').Credentials | undefined>} */
  async credentials(url) {
    return (await readJson(this.credentialsFile))[url]
  }

  async saveCredentials(url, creds) {
    await this.ensureDir()
    const all = await readJson(this.credentialsFile)
    if (creds) all[url] = creds
    else delete all[url]
    if (Object.keys(all).length) await writeJson(this.credentialsFile, all, 0o600)
    else await rm(this.credentialsFile, { force: true })
  }
}

/**
 * The MCP endpoint for what a user typed: a host (`wgo.example.com`), the dashboard's address or the /mcp URL.
 * Plain http is only accepted for localhost (the local dev server).
 */
export function mcpUrl(input) {
  let s = String(input ?? '').trim()
  if (!s) throw new Error('Missing server address')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `${/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(s) ? 'http' : 'https'}://${s}`
  let u
  try {
    u = new URL(s)
  } catch {
    throw new Error(`Not a valid address: ${input}`)
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error(`Use an https:// address (http only for localhost): ${input}`)
  u.hash = ''
  u.search = ''
  // the dashboard's address (or any path ending in /): the MCP server lives at /mcp
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/mcp'
  return u.toString().replace(/\/+$/, '')
}
