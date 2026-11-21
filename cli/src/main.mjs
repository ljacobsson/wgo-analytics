// The `wgo` command: sign-in and settings commands, plus one command per tool of the server's MCP endpoint.
import { readFile } from 'node:fs/promises'
import { accessToken, AuthRequiredError, login, logout, openBrowser } from './auth.mjs'
import { asCommands, kebab, missingRequired, parseToolArgs, toolHelp, toolName, wrap } from './args.mjs'
import { render } from './format.mjs'
import { McpClient } from './mcp.mjs'
import { mcpUrl, Store } from './store.mjs'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

/** Tool lists are cached per server so help and argument parsing don't cost an extra request every time. */
const TOOLS_TTL_MS = 24 * 3600_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class UsageError extends Error {}

const USAGE = `wgo ${pkg.version} - WGO analytics (product analytics, errors, traces, logs, metrics) from the command line

Usage
  wgo login [--url <address>] [--no-browser]   Sign in (Cognito, in the browser); the server becomes the default
  wgo logout | status                          Sign out | show server, account and default project
  wgo use <project name or id>                 Default project for commands that take one (--clear unsets it)
  wgo guide                                    How the commands fit together: read this first
  wgo <command> --help                         A command's options
  wgo tools [--refresh]                        The command list (cached for a day; --refresh after a server upgrade)
  wgo <command> [options]                      Run a command

Global options
  --url <address>      WGO server, its dashboard address or /mcp URL       (env WGO_URL)
  -p, --project <p>    Project name or id                                  (env WGO_PROJECT)
  --fields a,b.c       Keep only these fields of each result row
  --format tsv         Rows as tab-separated values (fewer tokens than JSON)
  --pretty             Indent JSON (default when stdout is a terminal)

Results go to stdout as JSON. Exit status: 1 when a command fails, 2 for invalid usage.`

/** Pulls the global options out of argv; everything else is left for the command. */
export function splitGlobals(argv) {
  const g = { rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
    const value = () => {
      if (inline !== undefined) return inline
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${flag}`)
      return argv[++i]
    }
    if (flag === '--url') g.url = value()
    else if (flag === '--project' || flag === '-p') g.project = value()
    else if (flag === '--args') g.args = value()
    else if (flag === '--fields') g.fields = value().split(',').map((f) => f.trim()).filter(Boolean)
    else if (flag === '--format') {
      g.format = value()
      if (!['json', 'tsv'].includes(g.format)) throw new UsageError('--format must be json or tsv')
    } else if (a === '--pretty') g.pretty = true
    else if (a === '--help' || a === '-h') g.help = true
    else if (a === '--version' || a === '-v') g.version = true
    else g.rest.push(a)
  }
  return g
}

export async function main(argv, io = {}) {
  const env = io.env ?? process.env
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const stdin = io.stdin ?? process.stdin
  const fetchImpl = io.fetchImpl ?? fetch
  const store = io.store ?? new Store()
  const width = Math.min(stdout.columns || 100, 110)
  const out = (s) => stdout.write(s + '\n')
  const err = (s) => stderr.write(s + '\n')

  try {
    const g = splitGlobals(argv)
    const [command, ...rest] = g.rest
    if (g.version) return out(pkg.version), 0
    const print = (data) => out(render(data, { format: g.format, fields: g.fields, pretty: g.pretty ?? !!stdout.isTTY }))

    const serverUrl = async () => {
      const u = g.url ?? env.WGO_URL ?? (await store.readConfig()).url
      if (!u) throw new UsageError('No WGO server yet. Sign in first: wgo login --url https://wgo.example.com')
      return mcpUrl(u)
    }
    const client = async () => new McpClient({ url: await serverUrl(), store, fetchImpl })

    /** The server's tools, from the cache unless stale or `refresh`. */
    const tools = async (refresh = false) => {
      const url = await serverUrl()
      const cached = (await store.server(url)).tools
      if (!refresh && cached && Date.now() - cached.fetchedAt < TOOLS_TTL_MS) return cached.list
      const list = await new McpClient({ url, store, fetchImpl }).listTools()
      await store.updateServer(url, (s) => (s.tools = { fetchedAt: Date.now(), list }))
      return list
    }
    const findTool = async (name) => {
      const want = toolName(name)
      return (await tools()).find((t) => t.name === want) ?? (await tools(true)).find((t) => t.name === want)
    }

    if (!command || command === 'help') {
      const topic = command === 'help' ? rest[0] : undefined
      if (topic) return main([topic, '--help', ...(g.url ? ['--url', g.url] : [])], io)
      out(USAGE)
      // list the commands when the server is known; help must not fail when it isn't reachable
      const list = await tools().catch(() => null)
      if (list) out(`\nCommands of ${await serverUrl()}\n${toolTable(list, width)}`)
      else out('\nSign in to see the commands of your WGO server.')
      return command || g.help ? 0 : 2
    }

    switch (command) {
      case 'login': {
        const browser = !rest.includes('--no-browser')
        const extra = rest.filter((a) => a !== '--no-browser')
        if (extra.length) throw new UsageError(`Unexpected argument for login: ${extra[0]}`)
        if (g.help) return out('wgo login [--url <address>] [--no-browser]\n\nSigns in with your WGO account in the browser (Cognito managed login) and makes the server the default.\nWithout a browser on this machine, use --no-browser, open the printed address elsewhere and paste back the address it ends up on.'), 0
        const url = await serverUrl()
        const status = await login({ store, url, browser, log: err, open: io.open ?? openBrowser, fetchImpl, input: stdin })
        await store.updateConfig((c) => (c.url = url))
        const list = await tools(true)
        const who = list.some((t) => t.name === 'list_projects') ? JSON.parse(textOf(await (await client()).callTool('list_projects', {})) || '{}') : {}
        err(status === 'no-auth' ? `${url} needs no sign-in${who.email ? `; it acts as ${who.email}` : ''}.` : `Signed in to ${url}${who.email ? ` as ${who.email}` : ''}.`)
        err('Try: wgo list-projects, or wgo --help for all commands.')
        return 0
      }

      case 'logout': {
        if (g.help) return out('wgo logout [--url <address>]\n\nSigns out: revokes the refresh token and deletes the stored tokens.'), 0
        const url = await serverUrl()
        err((await logout(store, url, fetchImpl)) ? `Signed out of ${url}.` : `Not signed in to ${url}.`)
        return 0
      }

      case 'status': {
        if (g.help) return out('wgo status [--url <address>]\n\nShows the server, whether you are signed in and as whom, and the default project.'), 0
        const url = await serverUrl()
        const creds = await store.credentials(url)
        const server = await store.server(url)
        out(`Server   ${url}`)
        let email
        try {
          await accessToken(store, url, { fetchImpl })
          const res = await (await client()).callTool('list_projects', {})
          email = JSON.parse(textOf(res) || '{}').email
          out(`Account  ${email ?? 'unknown'}${creds?.accessToken ? '' : ' (no sign-in needed)'}`)
        } catch (e) {
          out(`Account  not signed in${e instanceof AuthRequiredError ? '' : ` (${e.message})`}`)
        }
        out(`Project  ${env.WGO_PROJECT ?? server.project ?? 'none (wgo use <project>)'}`)
        return email ? 0 : 1
      }

      case 'use': {
        if (g.help) return out('wgo use <project name or id>\nwgo use --clear\n\nSets the project that commands use when you pass no --project.'), 0
        const url = await serverUrl()
        if (rest[0] === '--clear') {
          await store.updateServer(url, (s) => delete s.project)
          err('Default project cleared.')
          return 0
        }
        const wanted = [g.project, ...rest].filter(Boolean).join(' ')
        if (!wanted) {
          out((await store.server(url)).project ?? 'No default project. Set one with: wgo use <project name or id>')
          return 0
        }
        const project = await resolveProject(await client(), wanted)
        await store.updateServer(url, (s) => (s.project = project.id))
        err(`Default project: ${project.name} (${project.id})`)
        return 0
      }

      case 'guide': {
        if (g.help) return out('wgo guide\n\nThe server\'s own guide to its commands (the MCP server instructions), with MCP tool names shown as commands.'), 0
        const url = await serverUrl()
        const cached = (await store.server(url)).guide
        let text = cached && Date.now() - cached.fetchedAt < TOOLS_TTL_MS ? cached.text : null
        if (text === null) {
          text = await (await client()).instructions()
          await store.updateServer(url, (s) => (s.guide = { fetchedAt: Date.now(), text }))
        }
        out(asCommands(text, (await tools()).map((t) => t.name)))
        out('\nEvery command takes --help. Commands with a projectId use the default project (wgo use) unless you pass -p.')
        return 0
      }

      case 'tools': {
        if (g.help) return out('wgo tools [--refresh]\n\nLists the server\'s commands. --refresh fetches the list again (it is cached for a day).'), 0
        const list = await tools(rest.includes('--refresh'))
        out(toolTable(list, width))
        return 0
      }
    }

    // ----- a tool of the server -----
    const tool = await findTool(command)
    if (!tool) throw new UsageError(`Unknown command "${command}". See: wgo --help`)
    const url = await serverUrl()
    const takesProject = !!tool.inputSchema?.properties?.projectId
    const defaultProject = g.project ?? env.WGO_PROJECT ?? (await store.server(url)).project
    if (g.help) {
      const notes = takesProject
        ? { projectId: `Also -p/--project, which takes a project name too.${defaultProject ? ` Default: ${defaultProject}` : ' Set a default with: wgo use <project>'}` }
        : {}
      out(toolHelp(tool, width, notes, (await tools()).map((t) => t.name)))
      return 0
    }

    let base = {}
    if (g.args !== undefined) {
      const text = g.args === '-' ? await readAll(stdin) : g.args.startsWith('@') ? await readFile(g.args.slice(1), 'utf8') : g.args
      try {
        base = JSON.parse(text)
      } catch {
        throw new UsageError('--args must be a JSON object')
      }
      if (!base || typeof base !== 'object' || Array.isArray(base)) throw new UsageError('--args must be a JSON object')
    }
    let args
    try {
      args = parseToolArgs(rest, tool, base)
    } catch (e) {
      throw new UsageError(e.message)
    }

    const mcp = await client()
    if (takesProject) {
      const p = args.projectId ?? defaultProject
      if (p !== undefined) args.projectId = UUID_RE.test(String(p)) ? String(p) : (await resolveProject(mcp, String(p))).id
    }
    const missing = missingRequired(tool, args)
    if (missing.length) {
      const hint = missing.includes('--project-id') ? ' Pass -p <project> or set a default with: wgo use <project>.' : ''
      throw new UsageError(`Missing ${missing.join(', ')}.${hint} See: wgo ${kebab(tool.name)} --help`)
    }

    const res = await mcp.callTool(tool.name, args)
    if (res.isError) {
      err(textOf(res) || 'The command failed')
      return 1
    }
    if (res.structuredContent !== undefined) print(res.structuredContent)
    else for (const c of res.content ?? []) {
      if (c.type !== 'text') out(JSON.stringify(c))
      else {
        let data
        try {
          data = JSON.parse(c.text)
        } catch {
          out(c.text)
          continue
        }
        print(data)
      }
    }
    return 0
  } catch (e) {
    err(e instanceof UsageError || e instanceof AuthRequiredError || e?.name === 'McpError' || e instanceof Error ? e.message : String(e))
    if (env.WGO_DEBUG && e?.stack) err(e.stack)
    return e instanceof UsageError ? 2 : 1
  }
}

const textOf = (res) => (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')

async function readAll(stream) {
  let s = ''
  for await (const chunk of stream) s += chunk
  return s
}

function toolTable(list, width) {
  const names = list.map((t) => kebab(t.name))
  const col = Math.max(...names.map((n) => n.length), 0) + 4
  return list.map((t, i) => `  ${names[i].padEnd(col - 2)}${wrap(t.annotations?.title ?? t.title ?? '', width, col)}`).join('\n')
}

/** A project by id or (case-insensitive) name, via list_projects. */
async function resolveProject(mcp, wanted) {
  const res = await mcp.callTool('list_projects', {})
  if (res.isError) throw new Error(textOf(res))
  const { projects = [] } = JSON.parse(textOf(res))
  const byId = projects.find((p) => p.id === wanted)
  if (byId) return byId
  const byName = projects.filter((p) => p.name.toLowerCase() === wanted.toLowerCase())
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) throw new UsageError(`Several projects are named "${wanted}": ${byName.map((p) => p.id).join(', ')}. Use the id.`)
  const names = projects.map((p) => `${p.name} (${p.id})`).join('\n  ')
  throw new UsageError(`No project "${wanted}".${names ? ` Your projects:\n  ${names}` : ' You are not a member of any project yet: wgo create-project --name <name>'}`)
}
