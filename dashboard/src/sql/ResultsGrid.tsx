import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { SqlColumn } from '../api/contract';
import { cn } from '../lib/format';

const ROW_H = 28;
const HEAD_H = 46;
const OVERSCAN = 12;
const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL)/;

export const isNumericType = (type: string) => NUMERIC.test(type);

/** One line of text for a cell. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(parseFloat(v.toPrecision(12)));
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return cellText(a).localeCompare(cellText(b), undefined, { numeric: true });
}

export function ResultsGrid({ columns, rows, selected, onSelect }: {
  columns: SqlColumn[];
  rows: unknown[][];
  selected: number | null;
  onSelect: (row: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  useEffect(() => { setSort(null); scroller.current?.scrollTo({ top: 0, left: 0 }); setTop(0); }, [columns, rows]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const order = useMemo(() => {
    const idx = rows.map((_, i) => i);
    if (sort) idx.sort((a, b) => compare(rows[a][sort.col], rows[b][sort.col]) * sort.dir || a - b);
    return idx;
  }, [rows, sort]);

  // width from the header and a sample of values
  const widths = useMemo(() => columns.map((c, i) => {
    let chars = Math.max(c.name.length + 2, Math.min(c.type.length, 18));
    for (let r = 0; r < Math.min(rows.length, 200); r++) chars = Math.max(chars, Math.min(cellText(rows[r][i]).length, 60));
    return Math.max(72, Math.min(420, Math.round(chars * 7.3) + 26));
  }), [columns, rows]);
  const numW = Math.max(44, String(rows.length).length * 8 + 22);
  const total = numW + widths.reduce((a, b) => a + b, 0);
  const numeric = useMemo(() => columns.map((c) => isNumericType(c.type)), [columns]);

  const start = Math.max(0, Math.floor((top - HEAD_H) / ROW_H) - OVERSCAN);
  const end = Math.min(order.length, Math.ceil((top + height) / ROW_H) + OVERSCAN);

  const toggleSort = (col: number) => setSort((s) => (!s || s.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));

  return (
    <div ref={scroller} onScroll={(e) => setTop(e.currentTarget.scrollTop)} className="min-h-0 flex-1 overflow-auto font-mono text-[12px]">
      <div style={{ width: total, minWidth: '100%' }}>
        <div className="sticky top-0 z-10 flex border-b border-line bg-[var(--raised)]" style={{ height: HEAD_H }}>
          <div className="sticky left-0 z-10 shrink-0 border-r border-line bg-[var(--raised)]" style={{ width: numW }} />
          {columns.map((c, i) => (
            <button key={i} onClick={() => toggleSort(i)} title={`${c.name} ${c.type}\nClick to sort`}
              className={cn('group flex shrink-0 cursor-pointer flex-col justify-center gap-0.5 border-r border-line px-2.5 text-left hover:bg-[var(--hl)]', numeric[i] && 'items-end text-right')}
              style={{ width: widths[i] }}>
              <span className="flex max-w-full items-center gap-1 font-sans text-[12px] font-semibold text-fg">
                <span className="truncate">{c.name}</span>
                {sort?.col === i && (sort.dir === 1 ? <ArrowUp size={12} className="shrink-0 text-accent" /> : <ArrowDown size={12} className="shrink-0 text-accent" />)}
              </span>
              <span className="max-w-full truncate text-[10.5px] text-faint">{c.type}</span>
            </button>
          ))}
        </div>
        <div className="relative" style={{ height: order.length * ROW_H }}>
          {order.slice(start, end).map((ri, k) => {
            const row = rows[ri];
            const at = start + k;
            return (
              <div key={ri} onClick={() => onSelect(ri)}
                className={cn('absolute left-0 flex w-full cursor-pointer border-b border-line/50', selected === ri ? 'bg-accent/12' : at % 2 ? 'bg-[color-mix(in_srgb,var(--fg)_1.5%,transparent)] hover:bg-[var(--hl)]' : 'hover:bg-[var(--hl)]')}
                style={{ top: at * ROW_H, height: ROW_H }}>
                <div className="sticky left-0 shrink-0 border-r border-line bg-[var(--raised)] px-2 text-right leading-[27px] text-faint tnum" style={{ width: numW }}>{ri + 1}</div>
                {row.map((v, i) => {
                  const text = cellText(v);
                  return (
                    <div key={i} title={text.length > 30 ? text.slice(0, 2000) : undefined}
                      className={cn('shrink-0 truncate border-r border-line/50 px-2.5 leading-[27px]', numeric[i] && 'text-right tnum',
                        v === null || v === undefined ? 'italic text-faint' : typeof v === 'object' ? 'text-accent2' : typeof v === 'boolean' ? 'text-warn' : '')}
                      style={{ width: widths[i] }}>{text.length > 500 ? text.slice(0, 500) + '…' : text}</div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
