// Output shaping for agents and scripts: fewer tokens than the MCP's JSON. `--fields` keeps only some fields
// of the result's rows, `--format tsv` prints the rows as a table with one header line instead of repeating
// every key in every row.

/**
 * Where a result's rows are: the result itself when it's an array, else its first top-level property that
 * holds an array of objects (e.g. `projects` of list_projects, `recordings` of find_recordings), else its
 * first empty array (`events` of a search that found nothing).
 * @returns {{ rows: any[] | null, key: string | null }}
 */
export function findRows(data) {
  if (Array.isArray(data)) return { rows: data, key: null }
  if (data && typeof data === 'object') {
    const entries = Object.entries(data)
    for (const [k, v] of entries) {
      if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return { rows: v, key: k }
    }
    for (const [k, v] of entries) if (Array.isArray(v) && !v.length) return { rows: v, key: k }
  }
  return { rows: null, key: null }
}

/** Fields that name top-level values of an object result (`totals` of get_overview) select from it, not from its rows. */
const topLevel = (data, fields) =>
  !Array.isArray(data) && data && typeof data === 'object' && fields.some((f) => Object.hasOwn(data, f.split('.')[0]))

/** Value at a dotted path, e.g. `missingSourcemaps.release`. */
export function pick(obj, path) {
  let v = obj
  for (const part of path.split('.')) {
    if (v == null || typeof v !== 'object') return undefined
    v = v[part]
  }
  return v
}

function project(obj, fields) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj
  const out = {}
  for (const f of fields) {
    const v = pick(obj, f)
    if (v !== undefined) out[f] = v
  }
  return out
}

/** Keeps only `fields` of each row (or of the result itself when it has no rows); other top-level values stay. */
export function selectFields(data, fields) {
  if (!fields?.length) return data
  if (topLevel(data, fields)) return project(data, fields)
  const { rows, key } = findRows(data)
  if (!rows) return project(data, fields)
  const projected = rows.map((r) => project(r, fields))
  return key === null ? projected : { ...data, [key]: projected }
}

const cell = (v) => {
  if (v === undefined || v === null) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r?\n/g, '\\n')
}

/**
 * The rows as tab-separated values with a header; other top-level values come first as `# key: value` lines.
 * Returns null when the result has no rows (print it as JSON instead).
 */
export function toTsv(data, fields) {
  if (fields?.length && topLevel(data, fields)) return null
  const { rows, key } = findRows(data)
  if (!rows) return null
  const cols = fields?.length ? fields : [...new Set(rows.flatMap((r) => Object.keys(r)))]
  if (!cols.length) return null // no rows and no fields: there is no header to print
  const lines = []
  if (key !== null) {
    for (const [k, v] of Object.entries(data)) if (k !== key) lines.push(`# ${k}: ${cell(v)}`)
  }
  lines.push(cols.join('\t'))
  for (const r of rows) lines.push(cols.map((c) => cell(pick(r, c))).join('\t'))
  return lines.join('\n')
}

/** Renders a tool result for stdout. */
export function render(data, { format = 'json', fields, pretty = false } = {}) {
  if (format === 'tsv') {
    const tsv = toTsv(data, fields)
    if (tsv !== null) return tsv
  }
  const shaped = selectFields(data, fields)
  return pretty ? JSON.stringify(shaped, null, 2) : JSON.stringify(shaped)
}
