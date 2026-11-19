import { useMemo } from 'react';
import { Lightbulb } from 'lucide-react';
import type { ExplainDim, ExplainDriver, ExplainMetric, Explanation, Filter } from '../api/contract';
import { useExplain } from '../api/hooks';
import { TimeChart, type ChartMarker } from '../charts/TimeChart';
import { countryName, flag } from '../lib/geo';
import { fmtDateTime, fmtNum } from '../lib/format';
import { useProject } from '../lib/project';
import type { RowCondition } from '../lib/rowFilters';
import { useTime } from '../lib/time';
import { Drawer, ErrorState, Mono, Skeleton } from './kit';
import { RowActions } from './RowActions';

export interface ExplainSpec { metric: ExplainMetric; where?: Filter[]; goalId?: string; label: string }

/**
 * Whether a KPI's change is worth a "Why?": beyond ~3σ of Poisson noise for counts this size, and at least 5.
 * Cheap to check in the browser from the totals the page already has.
 */
export const worthExplaining = (cur?: number, prev?: number) =>
  cur != null && prev != null && Math.abs(cur - prev) >= Math.max(5, 3 * Math.sqrt(cur + prev));

const DIM_LABEL: Record<ExplainDim, string> = {
  path: 'Page', entry: 'Entry page', browser: 'Browser', os: 'Operating system', device: 'Device', country: 'Country',
  release: 'Release', source: 'Source', error: 'Error', request: 'Request',
};

/** The filter that narrows the dashboard to a driver's segment (none for composite keys). */
function conditionsOf(d: ExplainDriver): RowCondition[] {
  const f = (field: string, value: string, op: Filter['op'] = 'eq'): RowCondition[] => [{ filter: { field, op, value }, checked: true }];
  switch (d.dim) {
    case 'path': return f('path', d.key);
    case 'browser': case 'os': case 'device': case 'country': return f(d.dim, d.key);
    case 'release': return f('props.$ctx.release', d.key);
    case 'error': return f('errorMessage', d.key, d.key.length >= 200 ? 'starts_with' : 'eq');
    case 'source': return d.key === '(direct)' ? [] : f('referrer', d.key, 'contains');
    default: return [];
  }
}

const keyLabel = (d: ExplainDriver) => (d.dim === 'country' && /^[A-Z]{2}$/.test(d.key) ? `${flag(d.key)}  ${countryName(d.key)}` : d.key);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const rate = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;

function Drivers({ x }: { x: Explanation }) {
  const up = x.current > x.previous;
  if (!x.drivers.length) return <p className="text-[13px] text-muted">{x.significant ? 'No single page, browser, device, country or release stands out: the change is spread across them.' : 'Nothing to break down: the change is within normal variation.'}</p>;
  return (
    <div className="divide-y divide-line/60 rounded-xl border border-line">
      {x.drivers.map((d) => (
        <div key={`${d.dim}|${d.key}`} className="group flex items-center gap-3 px-3 py-2.5 text-[13px]">
          <div className="w-28 shrink-0 text-[12px] text-faint">{DIM_LABEL[d.dim]}</div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium" title={d.key}>{d.dim === 'path' || d.dim === 'entry' || d.dim === 'release' || d.dim === 'request' ? <Mono>{keyLabel(d)}</Mono> : keyLabel(d)}</div>
            <div className="text-[11.5px] text-muted">
              {d.rate
                ? <>Converts at {rate(d.rate.current)}, was {rate(d.rate.previous)}{d.previous < 20 && ' (overall, before)'} · {fmtNum(d.current)} sessions</>
                : <>{fmtNum(d.previous)} → {fmtNum(d.current)} · {pct(Math.min(1, Math.max(0, d.share)))} of the {up ? 'increase' : 'decrease'}{d.previous === 0 ? ', new in this period' : d.before < 0.5 && `, ${pct(d.before)} of the total before`}</>}
            </div>
          </div>
          <RowActions scope="events" conditions={conditionsOf(d)} />
        </div>
      ))}
    </div>
  );
}

export function ExplainDrawer({ spec, onClose }: { spec: ExplainSpec | null; onClose: () => void }) {
  const { project } = useProject(); const { range } = useTime();
  const x = useExplain(project.id, range, spec);
  const chart = useMemo(() => {
    const d = x.data;
    if (!d || !d.series.length) return null;
    const markers: ChartMarker[] = [{ t: Date.parse(d.from), label: 'Start of the selected range (before it: the comparison window)', color: 'var(--faint)' }];
    if (d.startedAt) markers.push({ t: Date.parse(d.startedAt), label: `The change started around ${fmtDateTime(d.startedAt)}`, color: 'var(--bad)' });
    if (d.release) markers.push({ t: Date.parse(d.release.firstSeen), label: `${d.release.kind === 'web' ? 'Release' : d.release.service} ${d.release.version} first seen ${fmtDateTime(d.release.firstSeen)}`, color: 'var(--accent)' });
    return {
      times: d.series.map((p) => Date.parse(p.t)),
      series: [{ key: 'v', label: d.label, color: 'var(--s7)', values: d.series.map((p) => p.value) }],
      markers,
    };
  }, [x.data]);
  return (
    <Drawer open={!!spec} onClose={onClose} width={680} title={<span className="flex items-center gap-2"><Lightbulb size={16} className="text-accent" />Why did {spec?.label.toLowerCase() ?? 'this'} change?</span>}>
      <div className="space-y-5 p-5">
        {x.isPending ? <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-[180px]" /><Skeleton className="h-40" /></div>
          : x.isError ? <ErrorState error={x.error} retry={() => x.refetch()} />
          : <>
            <p className="text-[14.5px] leading-relaxed">{x.data.summary}</p>
            {chart && (
              <div>
                <TimeChart times={chart.times} series={chart.series} mode="bars" height={180} markers={chart.markers} bucketMs={x.data.bucketSeconds * 1000} legend={false} />
                <p className="mt-1 text-[11.5px] text-faint">The comparison window, then the selected range. Dashed lines: where the range starts{x.data.startedAt && ', when the change started'}{x.data.release && ', when the release was first seen'}.</p>
              </div>
            )}
            <div>
              <h3 className="mb-2 text-[13px] font-semibold">What accounts for it</h3>
              <Drivers x={x.data} />
              {x.data.drivers.length > 0 && <p className="mt-2 text-[11.5px] text-faint">A segment shows up here when it changed more than the total did. One that grew in line with everything else isn't the cause, however big it is.</p>}
            </div>
          </>}
      </div>
    </Drawer>
  );
}
