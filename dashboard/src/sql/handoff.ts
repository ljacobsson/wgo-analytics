/**
 * Opening a query in the SQL editor from elsewhere (a SQL tile's "Open in SQL editor"): the query waits in this
 * browser's storage and the editor opens it in a new tab when it next loads.
 */
const key = (pid: string) => `wgo.sql.open.${pid}`;

export function openInSqlEditor(pid: string, query: string, name?: string) {
  try { localStorage.setItem(key(pid), JSON.stringify({ query, name })); } catch { /* storage disabled */ }
}

/** The query waiting to be opened, once. */
export function takeHandoff(pid: string): { query: string; name?: string } | null {
  try {
    const raw = localStorage.getItem(key(pid));
    if (!raw) return null;
    localStorage.removeItem(key(pid));
    const v = JSON.parse(raw) as { query?: unknown; name?: unknown };
    return typeof v.query === 'string' ? { query: v.query, name: typeof v.name === 'string' && v.name ? v.name : undefined } : null;
  } catch { return null; }
}
