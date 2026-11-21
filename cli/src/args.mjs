// Turns an MCP tool's JSON Schema input into command-line options, and back.
//
//   string / enum   --range 24h
//   number/integer  --limit 20
//   boolean         --errors-only, --no-errors-only, --errors-only=false
//   string array    --files a.js.map --files b.js.map (or one JSON array)
//   anything else   JSON: --filters '[{"field":"type","op":"eq","value":"error"}]'
//
// Property names are accepted in kebab-case (--project-id) and as written (--projectId).

export const kebab = (s) => s.replace(/_/g, '-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

/** The tool name for a command: `list-errors` and `list_errors` both name list_errors. */
export const toolName = (command) => command.replace(/-/g, '_')

/** @returns {'string' | 'number' | 'integer' | 'boolean' | 'strings' | 'json'} */
export function kindOf(schema = {}) {
  const t = Array.isArray(schema.type) ? schema.type.filter((x) => x !== 'null') : [schema.type]
  if (t.length === 1) {
    if (t[0] === 'string') return 'string'
    if (t[0] === 'integer') return 'integer'
    if (t[0] === 'number') return 'number'
    if (t[0] === 'boolean') return 'boolean'
    if (t[0] === 'array' && kindOf(schema.items) === 'string') return 'strings'
  }
  if (!schema.type && Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === 'string')) return 'string'
  return 'json'
}

/** The options of a tool, in schema order. */
export function optionsOf(tool) {
  const schema = tool.inputSchema ?? {}
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([name, s]) => ({
    name, flag: kebab(name), kind: kindOf(s), required: required.has(name), schema: s,
  }))
}

function parseValue(opt, raw) {
  const flag = `--${opt.flag}`
  switch (opt.kind) {
    case 'string': {
      const allowed = opt.schema.enum
      if (allowed && !allowed.includes(raw)) throw new Error(`${flag} must be one of: ${allowed.join(', ')}`)
      return raw
    }
    case 'number':
    case 'integer': {
      const n = raw.trim() === '' ? NaN : Number(raw)
      if (!Number.isFinite(n) || (opt.kind === 'integer' && !Number.isInteger(n))) throw new Error(`${flag} expects ${opt.kind === 'integer' ? 'a whole number' : 'a number'}, got "${raw}"`)
      return n
    }
    case 'boolean':
      if (/^(true|1|yes)$/i.test(raw)) return true
      if (/^(false|0|no)$/i.test(raw)) return false
      throw new Error(`${flag} expects true or false, got "${raw}"`)
    default:
      try {
        return JSON.parse(raw)
      } catch {
        throw new Error(`${flag} expects JSON, e.g. ${example(opt)}`)
      }
  }
}

function example(opt) {
  const s = opt.schema
  if (s.type === 'array') return `'[${s.items?.type === 'object' ? '{…}' : '…'}]'`
  return `'{…}'`
}

/**
 * Parses a tool's options. Returns the arguments object (merged over `base`, e.g. from --args) .
 * Throws Error with a message meant for the user.
 * @param {string[]} argv
 * @param {any} tool
 * @param {Record<string, unknown>} [base]
 */
export function parseToolArgs(argv, tool, base = {}) {
  const opts = optionsOf(tool)
  const byFlag = new Map()
  for (const o of opts) {
    byFlag.set(o.flag, o)
    byFlag.set(o.name, o)
  }
  const args = { ...base }
  const seenStrings = new Set()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`Unexpected argument "${a}". Options start with --; see: wgo ${kebab(tool.name)} --help`)
    let key = a.slice(2)
    let value
    const eq = key.indexOf('=')
    if (eq >= 0) {
      value = key.slice(eq + 1)
      key = key.slice(0, eq)
    }
    let opt = byFlag.get(key)
    if (!opt && key.startsWith('no-') && value === undefined) {
      const neg = byFlag.get(key.slice(3))
      if (neg?.kind === 'boolean') {
        args[neg.name] = false
        continue
      }
    }
    if (!opt) throw new Error(`Unknown option --${key} for ${kebab(tool.name)}. See: wgo ${kebab(tool.name)} --help`)
    if (opt.kind === 'boolean' && value === undefined) {
      args[opt.name] = true
      continue
    }
    if (value === undefined) {
      if (i + 1 >= argv.length) throw new Error(`Missing value for --${opt.flag}`)
      value = argv[++i]
    }
    if (opt.kind === 'strings') {
      // repeated flags add up; a JSON array is taken as the whole list
      if (!seenStrings.has(opt.name)) args[opt.name] = []
      seenStrings.add(opt.name)
      if (value.trimStart().startsWith('[')) {
        let list
        try {
          list = JSON.parse(value)
        } catch {
          throw new Error(`--${opt.flag} expects a value, or a JSON array of strings`)
        }
        if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) throw new Error(`--${opt.flag} expects a JSON array of strings`)
        args[opt.name].push(...list)
      } else args[opt.name].push(value)
    } else args[opt.name] = parseValue(opt, value)
  }
  return args
}

/** Names (as flags) of required options missing from `args`. */
export function missingRequired(tool, args) {
  return optionsOf(tool).filter((o) => o.required && args[o.name] === undefined).map((o) => `--${o.flag}`)
}

/** Word-wraps `text` to `width` columns, indenting continuation lines by `indent`. */
export function wrap(text, width, indent = 0) {
  const out = []
  for (const para of String(text).split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width - indent) {
        out.push(line)
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    out.push(line)
  }
  return out.map((l, i) => (i ? ' '.repeat(indent) + l : l)).join('\n')
}

function placeholder(o) {
  if (o.kind === 'boolean') return ''
  if (o.kind === 'string' && o.schema.enum) return ` <${o.schema.enum.join('|')}>`
  if (o.kind === 'strings') return ' <text>…'
  if (o.kind === 'string') return ' <text>'
  if (o.kind === 'json') return ' <json>'
  return ' <n>'
}

/** Writes the MCP tool names in `text` (list_projects) as the commands they are in the CLI (list-projects). */
export function asCommands(text, toolNames) {
  const names = [...toolNames].sort((a, b) => b.length - a.length)
  if (!names.length || !text) return text ?? ''
  const re = new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g')
  return text.replace(re, (n) => kebab(n))
}

const sentence = (s) => (s && !/[.!?)]$/.test(s.trim()) ? `${s.trim()}.` : s)

/**
 * Help text of one tool command. `notes` adds text per option name (e.g. where a default comes from);
 * `toolNames` are the server's tools, whose names in descriptions are shown as commands.
 */
export function toolHelp(tool, width = 100, notes = {}, toolNames = []) {
  const cmd = (s) => asCommands(s, toolNames)
  const title = tool.annotations?.title ?? tool.title
  const lines = [`wgo ${kebab(tool.name)}${title ? ` - ${title}` : ''}`, '', wrap(cmd(tool.description), width), '']
  const opts = optionsOf(tool)
  if (opts.length) {
    lines.push('Options')
    const heads = opts.map((o) => `  --${o.flag}${placeholder(o)}`)
    const col = Math.min(Math.max(...heads.map((h) => h.length)) + 2, 40)
    opts.forEach((o, i) => {
      const parts = [o.required && !notes[o.name] ? '(required)' : '', sentence(cmd(o.schema.description)), notes[o.name] ?? '']
      if (o.kind === 'strings') parts.push('Repeat the option for several values.')
      if (o.kind === 'boolean') parts.push(`--no-${o.flag} for false.`)
      const text = parts.filter(Boolean).join(' ')
      const head = heads[i]
      lines.push(head.length + 1 >= col ? `${head}\n${' '.repeat(col)}${wrap(text, width, col)}` : `${head.padEnd(col)}${wrap(text, width, col)}`)
    })
    lines.push('')
  }
  lines.push('Output: --fields a,b.c (keep only these fields of each row), --format tsv, --pretty. --args <json|@file|->: all arguments as one JSON object.')
  return lines.join('\n')
}
