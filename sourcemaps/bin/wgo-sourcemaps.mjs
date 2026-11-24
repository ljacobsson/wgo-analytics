#!/usr/bin/env node
// Uploads source maps to WGO so JavaScript error stacks show your original code. No dependencies (Node 18+).
//
//   npx wgo-sourcemaps --endpoint https://wgo.example.com --key uk_… [--release v1.2.3] dist/
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HELP = `Upload source maps to WGO.

Usage
  wgo-sourcemaps [options] <dir|file.js.map>...

Options
  --endpoint <url>   Your WGO address, e.g. https://wgo.example.com   (env WGO_ENDPOINT)
  --key <uk_...>     The project's upload key from Settings           (env WGO_UPLOAD_KEY)
  --release <name>   Release label, the same value you pass to wgo.init({ release })   (env WGO_RELEASE)
  -h, --help         Show this help

Every *.js.map file under the given directories is uploaded. Exits with 1 if any upload fails.
Don't deploy the .map files to your site: build with hidden source maps and upload them here instead.`

/** Parses argv (without node and script) and env into options; throws Error with a readable message. */
export function parseArgs(argv, env = {}) {
  const o = { endpoint: env.WGO_ENDPOINT, key: env.WGO_UPLOAD_KEY, release: env.WGO_RELEASE, paths: [], help: false }
  const names = { '--endpoint': 'endpoint', '--key': 'key', '--release': 'release' }
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i]
    if (a === '-h' || a === '--help') { o.help = true; continue }
    if (a.startsWith('--')) {
      let value
      const eq = a.indexOf('=')
      if (eq > 0) { value = a.slice(eq + 1); a = a.slice(0, eq) }
      const name = names[a]
      if (!name) throw new Error(`Unknown option ${a}`)
      if (value === undefined) value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${a}`)
      o[name] = value
    } else o.paths.push(a)
  }
  if (o.help) return o
  if (!o.endpoint) throw new Error('Missing --endpoint (or WGO_ENDPOINT)')
  if (!/^https?:\/\//.test(o.endpoint)) throw new Error('--endpoint must start with https://')
  o.endpoint = o.endpoint.replace(/\/+$/, '')
  if (!o.key) throw new Error('Missing --key (or WGO_UPLOAD_KEY)')
  if (!o.paths.length) throw new Error('Missing directory to upload, e.g. dist/')
  return o
}

/** All *.js.map files under the given files and directories, sorted. */
export async function findMaps(paths) {
  const out = []
  async function walk(p) {
    const s = await stat(p)
    if (s.isDirectory()) {
      for (const e of (await readdir(p)).sort()) if (e !== 'node_modules') await walk(join(p, e))
    } else if (p.endsWith('.js.map')) out.push(p)
  }
  for (const p of paths) await walk(p)
  return out
}

async function uploadOne(o, path) {
  const file = basename(path)
  const res = await fetch(`${o.endpoint}/sourcemaps/upload-url`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wgo-upload-key': o.key },
    body: JSON.stringify({ file, ...(o.release ? { release: o.release } : {}) }),
  })
  if (!res.ok) {
    let msg = ''
    try { msg = (await res.json()).error ?? '' } catch { /* not JSON */ }
    throw new Error(`upload-url ${res.status}${msg ? `: ${msg}` : ''}`)
  }
  const { url } = await res.json()
  const put = await fetch(url, { method: 'PUT', body: await readFile(path) })
  if (!put.ok) throw new Error(`PUT ${put.status}`)
}

export async function run(argv, env = process.env, log = console) {
  let o
  try {
    o = parseArgs(argv, env)
  } catch (err) {
    log.error(`${err.message}\n\n${HELP}`)
    return 2
  }
  if (o.help) { log.log(HELP); return 0 }
  let files
  try {
    files = await findMaps(o.paths)
  } catch (err) {
    log.error(`Can't read ${err.path ?? 'input'}: ${err.code ?? err.message}`)
    return 2
  }
  if (!files.length) { log.error('No *.js.map files found. Build with hidden source maps first.'); return 1 }
  let uploaded = 0
  const failures = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (next < files.length) {
      const f = files[next++]
      try { await uploadOne(o, f); uploaded++ } catch (err) { failures.push(`${f}: ${err.message}`) }
    }
  }))
  log.log(`Uploaded ${uploaded} of ${files.length} source maps${o.release ? ` for release ${o.release}` : ''}.`)
  for (const f of failures) log.error(`Failed: ${f}`)
  return failures.length ? 1 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await run(process.argv.slice(2))
}
