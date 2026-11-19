import type { ReactNode } from 'react';
import { fmtNum } from '../lib/format';

export interface BarRow { key: string; label: ReactNode; value: number; sub?: ReactNode; onClick?: () => void; actions?: ReactNode }
export function BarList({ rows, color = 'var(--s1)', mono, format = fmtNum }: { rows: BarRow[]; color?: string; mono?: boolean; format?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-0.5 px-2 pb-2">
      {rows.map((r) => (
        <li key={r.key} onClick={r.onClick} className={`group relative flex items-center justify-between gap-3 rounded-md px-2 py-[5px] ${r.onClick ? 'cursor-pointer' : ''} hover:bg-[var(--hl)] transition-colors`}>
          <div className="absolute inset-y-[3px] left-0 rounded-md opacity-[.16] transition-all duration-300 group-hover:opacity-25" style={{ width: `${(r.value / max) * 100}%`, background: color }} />
          <span className={`relative min-w-0 flex-1 truncate ${mono ? 'font-mono text-[12px]' : 'text-[12.5px]'}`}>{r.label}</span>
          {r.actions && <span className="relative -my-1">{r.actions}</span>}
          <span className="relative flex shrink-0 items-center gap-2 tnum text-[12.5px] font-medium">{r.sub && <span className="text-faint font-normal">{r.sub}</span>}{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}
