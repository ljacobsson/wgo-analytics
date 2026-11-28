import { useMemo, useState } from 'react';
import { ArrowLeft, Code2 } from 'lucide-react';
import type { DashboardTile } from '../api/contract';
import { useProject } from '../lib/project';
import { navigate, pageHref, useRoute } from '../lib/router';
import { PRESETS, type TimeRange } from '../lib/time';
import { Button, useDebounced } from '../ui/kit';
import { resolveChart, tileSql, type ChartSpec, type ChartViz } from '../sql/chart';
import { ChartConfig } from '../sql/ChartConfig';
import { openInSqlEditor } from '../sql/handoff';
import { defaultSize } from './layout';
import { tileHeight, useTileData } from './Tile';
import { TileFrame, tileTitle } from './TileFrame';

const STARTER = `SELECT date_trunc('hour', ts) AS hour, count(*) AS events
FROM events
GROUP BY ALL
ORDER BY hour`;

/** Add or edit a SQL tile: the query, how its result is charted, and a live preview over the dashboard's range. */
export function SqlTileEditor({ initial, range, onSave, onClose, onBack }: {
  initial: DashboardTile | null;
  range: TimeRange;
  onSave: (t: DashboardTile) => void;
  onClose: () => void;
  onBack?: () => void; // a new tile: back to picking a measure
}) {
  const { project } = useProject();
  const route = useRoute();
  const [draft, setDraft] = useState<DashboardTile>(() => initial?.sql ? initial : {
    id: initial?.id ?? Math.random().toString(36).slice(2, 10), viz: 'line', measures: [], sql: { query: STARTER }, layout: { x: 0, y: 0, ...defaultSize('line') },
  });
  const sql = draft.sql!;
  const spec: ChartSpec = { ...sql, viz: draft.viz as ChartViz };
  // the preview reruns once typing pauses
  const query = useDebounced(sql.query, 700);
  const previewTile = useMemo(() => ({ ...draft, sql: { ...sql, query } }), [draft, sql, query]);
  const data = useTileData(project.id, previewTile, range, undefined);
  const result = data.sql;
  const resolved = result ? resolveChart(result, spec) : spec;

  const setSpec = (s: ChartSpec) => setDraft((d) => ({ ...d, viz: s.viz, sql: tileSql(d.sql!.query, s) }));
  const save = () => onSave({ ...draft, measures: [], sql: tileSql(sql.query, result ? resolved : spec), viz: resolved.viz });
  const h = tileHeight(draft.viz === 'number' ? 2 : 3);

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 border-b border-line bg-[var(--raised)] p-4">
        <div style={{ height: h }}><TileFrame data={data} height={h} readOnly /></div>
      </div>

      <div className="flex-1 space-y-6 p-5">
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h4 className="text-[12.5px] font-semibold text-muted">SQL query</h4>
            <button onClick={() => { openInSqlEditor(project.id, sql.query, draft.title); navigate(pageHref(project.id, 'sql', route.params)); }}
              className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-fg cursor-pointer" title="Write it with autocomplete, in a new tab of the SQL editor">
              <Code2 size={13} />Open in SQL editor
            </button>
          </div>
          <textarea className="field min-h-[170px] resize-y font-mono !text-[12.5px] leading-relaxed" spellCheck={false} value={sql.query} maxLength={20000}
            onChange={(e) => setDraft((d) => ({ ...d, sql: { ...d.sql!, query: e.target.value } }))} />
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-faint">
            DuckDB SQL over events, logs, spans, metric_points, checks and visitor_days. The tables hold the rows of the tile’s time range, so
            there’s no need to filter on time. Dashboard filters don’t apply.
          </p>
        </section>

        <section>
          <h4 className="mb-2 text-[12.5px] font-semibold text-muted">Show as</h4>
          {result
            ? <ChartConfig compact columns={result.columns} spec={spec} resolved={resolved} onChange={setSpec} />
            : <p className="text-[12px] text-faint">{data.error ? 'Fix the query to pick how its result is shown.' : 'Running the query…'}</p>}
        </section>

        <section>
          <h4 className="mb-2 text-[12.5px] font-semibold text-muted">Title and time range</h4>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px]">
            <input className="field" value={draft.title ?? ''} maxLength={120} placeholder={tileTitle({ ...draft, title: undefined, sql: tileSql(sql.query, resolved) })}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value || undefined }))} />
            <select className="field" value={draft.range ?? ''} onChange={(e) => setDraft((d) => ({ ...d, range: e.target.value || undefined }))} aria-label="Time range">
              <option value="">Dashboard’s range</option>
              {PRESETS.map((p) => <option key={p} value={p}>Always last {p}</option>)}
            </select>
          </div>
        </section>
      </div>

      <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-line bg-[var(--raised)] px-5 py-3">
        {onBack && <Button variant="ghost" className="mr-auto" onClick={onBack}><ArrowLeft size={13} />Pick a measure instead</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!sql.query.trim()} onClick={save}>{initial ? 'Save tile' : 'Add tile'}</Button>
      </div>
    </div>
  );
}
