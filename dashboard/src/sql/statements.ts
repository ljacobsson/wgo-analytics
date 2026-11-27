/**
 * Statements of a SQL document: split on semicolons outside strings, quoted names and comments. The editor runs
 * the statement the cursor is in, so a document can hold many queries.
 */
export interface Statement {
  /** document offsets of the statement text, without the semicolon and surrounding blank space */
  from: number;
  to: number;
  text: string;
}

/** Offsets where the code (not strings or comments) has a semicolon. */
function semicolons(doc: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < doc.length; ) {
    const c = doc[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < doc.length) {
        if (doc[j] === c && doc[j + 1] === c) j += 2;
        else if (doc[j] === c) break;
        else j++;
      }
      i = j + 1;
    } else if (c === '$' && doc[i + 1] === '$') {
      const j = doc.indexOf('$$', i + 2);
      i = j < 0 ? doc.length : j + 2;
    } else if (c === '-' && doc[i + 1] === '-') {
      const j = doc.indexOf('\n', i);
      i = j < 0 ? doc.length : j;
    } else if (c === '/' && doc[i + 1] === '*') {
      const j = doc.indexOf('*/', i + 2);
      i = j < 0 ? doc.length : j + 2;
    } else {
      if (c === ';') out.push(i);
      i++;
    }
  }
  return out;
}

/** True when the text is only blank space and comments. */
export function isBlank(text: string): boolean {
  return !text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

export function splitStatements(doc: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  for (const end of [...semicolons(doc), doc.length]) {
    const raw = doc.slice(start, end);
    if (!isBlank(raw)) {
      // leading comments describe the statement but aren't part of it (the editor marks the lines that run)
      const lead = /^(?:\s+|--[^\n]*|\/\*[\s\S]*?\*\/)*/.exec(raw)![0].length;
      const text = raw.slice(lead).trimEnd();
      out.push({ from: start + lead, to: start + lead + text.length, text });
    }
    start = end + 1;
  }
  return out;
}

/**
 * The statement at `pos`: the one containing it, else the one ending right before it on the same stretch (the
 * cursor sits after the semicolon), else the next one.
 */
export function statementAt(doc: string, pos: number): Statement | null {
  const all = splitStatements(doc);
  if (!all.length) return null;
  const inside = all.find((s) => pos >= s.from && pos <= s.to + 1);
  if (inside) return inside;
  const before = [...all].reverse().find((s) => s.to < pos);
  if (before && isBlank(doc.slice(before.to + 1, pos)) && !doc.slice(before.to + 1, pos).includes('\n\n')) return before;
  return all.find((s) => s.from > pos) ?? before ?? null;
}

/**
 * Where a DuckDB error points, as offsets in `sql`: errors end in "LINE n: <excerpt>" and a line of ^ under the
 * position. Long lines are cut down to an excerpt starting with "...".
 */
export function errorRange(sql: string, message: string): { from: number; to: number } | null {
  const m = /LINE (\d+): (.*)\n( *)(\^+)/.exec(message);
  if (!m) return null;
  const lineNo = Number(m[1]);
  const prefix = `LINE ${m[1]}: `.length;
  const lines = sql.split('\n');
  if (lineNo < 1 || lineNo > lines.length) return null;
  const lineStart = lines.slice(0, lineNo - 1).reduce((n, l) => n + l.length + 1, 0);
  const line = lines[lineNo - 1];
  let excerpt = m[2], cut = 0;
  if (excerpt.startsWith('...')) { excerpt = excerpt.slice(3); cut = 3; }
  if (excerpt.endsWith('...')) excerpt = excerpt.slice(0, -3);
  const at = line.indexOf(excerpt.slice(0, 40));
  const col = (at < 0 ? 0 : at) + Math.max(0, m[3].length - prefix - cut);
  const from = lineStart + Math.min(col, line.length);
  return { from, to: Math.min(lineStart + line.length, from + Math.max(1, m[4].length)) };
}
