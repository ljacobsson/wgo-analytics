import { describe, expect, it } from 'vitest'
import { kebab, kindOf, missingRequired, parseToolArgs, toolHelp } from '../src/args.mjs'
import { render, selectFields, toTsv } from '../src/format.mjs'
import { mcpUrl } from '../src/store.mjs'
import { codeFromRedirect, resourceMetadataUrl } from '../src/auth.mjs'
import { parseSse } from '../src/mcp.mjs'

// shaped like the JSON Schema the MCP SDK makes of the zod input schemas in backend/src/lib/mcp/tools.ts
const tool = {
  name: 'find_recordings',
  description: 'Session recordings.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project id (UUID) from list_projects' },
      range: { type: 'string', pattern: '^(\\d+)\\s*(m|h|d)$' },
      device: { type: 'string', enum: ['desktop', 'mobile', 'tablet'] },
      minDurationSeconds: { type: 'number', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      identifiedOnly: { type: 'boolean' },
      did: { type: 'array', items: { type: 'object', properties: { action: { type: 'string' } } } },
      files: { type: 'array', items: { type: 'string' } },
      value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    },
    required: ['projectId', 'files'],
  },
}

describe('arguments', () => {
  it('names flags in kebab-case', () => {
    expect(kebab('minDurationSeconds')).toBe('min-duration-seconds')
    expect(kebab('list_errors')).toBe('list-errors')
    expect(kebab('projectId')).toBe('project-id')
  })

  it('classifies schema types', () => {
    expect(kindOf({ type: 'string' })).toBe('string')
    expect(kindOf({ enum: ['a', 'b'] })).toBe('string')
    expect(kindOf({ type: 'integer' })).toBe('integer')
    expect(kindOf({ type: 'array', items: { type: 'string' } })).toBe('strings')
    expect(kindOf({ type: 'array', items: { type: 'object' } })).toBe('json')
    expect(kindOf({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe('json')
  })

  it('parses every kind of option, in kebab-case or as named', () => {
    const args = parseToolArgs([
      '--project-id', 'p1', '--range=24h', '--device', 'mobile', '--minDurationSeconds', '2.5', '--limit', '-3',
      '--identified-only', '--did', '[{"action":"click"}]', '--files', 'a.map', '--files', 'b.map', '--value', '5',
    ], tool)
    expect(args).toEqual({
      projectId: 'p1', range: '24h', device: 'mobile', minDurationSeconds: 2.5, limit: -3, identifiedOnly: true,
      did: [{ action: 'click' }], files: ['a.map', 'b.map'], value: 5,
    })
  })

  it('handles negated booleans, JSON string arrays and a base object', () => {
    expect(parseToolArgs(['--no-identified-only', '--files', '["x","y"]'], tool, { range: '1h', files: ['old'] }))
      .toEqual({ range: '1h', identifiedOnly: false, files: ['x', 'y'] })
    expect(parseToolArgs(['--identified-only=false'], tool)).toEqual({ identifiedOnly: false })
  })

  it('explains bad input', () => {
    expect(() => parseToolArgs(['--nope', '1'], tool)).toThrow(/Unknown option --nope/)
    expect(() => parseToolArgs(['--device', 'tv'], tool)).toThrow(/one of: desktop, mobile, tablet/)
    expect(() => parseToolArgs(['--limit', '2.5'], tool)).toThrow(/whole number/)
    expect(() => parseToolArgs(['--limit', 'x'], tool)).toThrow(/whole number/)
    expect(() => parseToolArgs(['--did', '{oops'], tool)).toThrow(/expects JSON/)
    expect(() => parseToolArgs(['--range'], tool)).toThrow(/Missing value/)
    expect(() => parseToolArgs(['stray'], tool)).toThrow(/Unexpected argument "stray"/)
  })

  it('lists missing required options as flags', () => {
    expect(missingRequired(tool, { files: [] })).toEqual(['--project-id'])
  })

  it('prints help with every option', () => {
    const help = toolHelp(tool, 100)
    expect(help).toMatch(/^wgo find-recordings/)
    for (const f of ['--project-id <text>', '--device <desktop|mobile|tablet>', '--limit <n>', '--identified-only', '--did <json>', '--files <text>…']) expect(help).toContain(f)
  })
})

describe('output', () => {
  const result = { email: 'a@b.c', projects: [{ id: '1', name: 'Shop', role: 'owner', meta: { x: 1 } }, { id: '2', name: 'Blog\tx', role: 'member' }] }

  it('keeps only the asked fields of the rows', () => {
    expect(selectFields(result, ['id', 'name'])).toEqual({ email: 'a@b.c', projects: [{ id: '1', name: 'Shop' }, { id: '2', name: 'Blog\tx' }] })
    expect(selectFields([{ a: { b: 1 }, c: 2 }], ['a.b'])).toEqual([{ 'a.b': 1 }])
    expect(selectFields({ total: 3, other: 1 }, ['total'])).toEqual({ total: 3 })
  })

  it('renders rows as TSV, other values as comments', () => {
    expect(toTsv(result, ['id', 'name', 'meta'])).toBe('# email: a@b.c\nid\tname\tmeta\n1\tShop\t{"x":1}\n2\tBlog\\tx\t')
    expect(toTsv({ total: 3 })).toBeNull()
    expect(render({ total: 3 }, { format: 'tsv' })).toBe('{"total":3}')
  })

  it('selects top-level values when the fields name them (get_overview totals)', () => {
    const overview = { bucketSeconds: 60, totals: { events: 5 }, series: [{ t: 1 }, { t: 2 }] }
    expect(selectFields(overview, ['totals'])).toEqual({ totals: { events: 5 } })
    expect(render(overview, { format: 'tsv', fields: ['totals.events'] })).toBe('{"totals.events":5}')
    expect(selectFields(overview, ['t'])).toEqual({ bucketSeconds: 60, totals: { events: 5 }, series: [{ t: 1 }, { t: 2 }] })
  })

  it('handles results without rows', () => {
    expect(selectFields({ events: [], nextBefore: null }, ['type'])).toEqual({ events: [], nextBefore: null })
    expect(render({ events: [], nextBefore: null }, { format: 'tsv', fields: ['type', 'path'] })).toBe('# nextBefore: \ntype\tpath')
    expect(render([], { format: 'tsv' })).toBe('[]')
  })

  it('prints compact JSON unless asked to indent', () => {
    expect(render({ a: [1] })).toBe('{"a":[1]}')
    expect(render({ a: 1 }, { pretty: true })).toBe('{\n  "a": 1\n}')
  })
})

describe('helpers', () => {
  it('finds the MCP URL from what the user typed', () => {
    expect(mcpUrl('wgo.example.com')).toBe('https://wgo.example.com/mcp')
    expect(mcpUrl('https://wgo.example.com/')).toBe('https://wgo.example.com/mcp')
    expect(mcpUrl('https://wgo.example.com/mcp/')).toBe('https://wgo.example.com/mcp')
    expect(mcpUrl('localhost:8787')).toBe('http://localhost:8787/mcp')
    expect(() => mcpUrl('http://wgo.example.com')).toThrow(/https/)
  })

  it('reads the resource metadata URL from a Bearer challenge', () => {
    expect(resourceMetadataUrl('Bearer error="invalid_token", resource_metadata="https://h/.well-known/oauth-protected-resource/mcp"'))
      .toBe('https://h/.well-known/oauth-protected-resource/mcp')
  })

  it('takes the code from a pasted redirect URL', () => {
    expect(codeFromRedirect('http://localhost:1/callback?code=abc&state=s1', 's1')).toBe('abc')
    expect(() => codeFromRedirect('http://localhost:1/callback?code=abc&state=other', 's1')).toThrow(/state/)
    expect(() => codeFromRedirect('http://localhost:1/callback?error=access_denied&state=s1', 's1')).toThrow(/access_denied/)
    expect(() => codeFromRedirect('nonsense', 's1')).toThrow(/not a URL/)
  })

  it('reads the response from an event stream', () => {
    expect(parseSse('event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":1}}\n\n', 3)).toEqual({ jsonrpc: '2.0', id: 3, result: { ok: 1 } })
  })
})
