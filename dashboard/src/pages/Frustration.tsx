import { useMemo } from 'react';
import { MousePointerClick } from 'lucide-react';
import { useFrustration } from '../api/hooks';
import type { FrustrationRow } from '../api/contract';
import { clickLabel, shortSelector } from '../lib/events';
import { fmtNum, relTime } from '../lib/format';
import { useProject } from '../lib/project';
import { clickConditions } from '../lib/rowFilters';
import { pageHref, useRoute } from '../lib/router';
import { useTime } from '../lib/time';
import { Card, EmptyState, ErrorState } from '../ui/kit';
import { RowActions } from '../ui/RowActions';
import { RowsSkeleton, TableHead, useSort } from './common';

const COLS = 'grid-cols-[minmax(180px,1.6fr)_minmax(90px,.6fr)_minmax(90px,.6fr)_minmax(90px,.6fr)_70px_minmax(170px,1.2fr)_44px]';

/** "12 clicks in 5 sessions", or a dash. */
function Signal({ clicks, sessions }: { clicks: number; sessions: number }) {
  if (!clicks) return <span className="text-faint">–</span>;
  return (
    <div className="tnum">
      <span className="font-medium">{fmtNum(clicks)}</span>
      <span className="text-[11.5px] text-faint"> in {fmtNum(sessions)} {sessions === 1 ? 'session' : 'sessions'}</span>
    </div>
  );
}

const total = (r: FrustrationRow) => r.rageClicks + r.deadClicks + r.errorClicks;

/**
 * Click targets where visitors got stuck: rage clicks (3+ quick clicks), dead clicks (nothing changed within a
 * second) and error clicks (a JavaScript error or failed request within 2 s after the click).
 */
export function FrustrationTab() {
  const { project } = useProject(); const { range } = useTime(); const route = useRoute();
  const { data, isPending, isError, error, refetch } = useFrustration(project.id, range);
  const getters = useMemo(() => ({
    target: (r: FrustrationRow) => clickLabel(r).toLowerCase(),
    rage: (r: FrustrationRow) => r.rageClicks,
    dead: (r: FrustrationRow) => r.deadClicks,
    error: (r: FrustrationRow) => r.errorClicks,
    clicks: (r: FrustrationRow) => r.clicks,
    total,
  }), []);
  const { sorted, sort, onSort } = useSort(data, getters, { key: 'total', dir: 'desc' });
  if (isError) return <ErrorState error={error} retry={() => refetch()} />;
  const rows = sorted ?? [];
  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-muted">
        Rage clicks are three or more quick clicks on one element. A dead click is a click on a link or button after which nothing on the page changed within a second.
        An error click is followed by a JavaScript error or failed request within two seconds.
      </p>
      <Card className="@container overflow-x-auto">
        <div className="min-w-[900px]">
          <TableHead className={COLS} sort={sort} onSort={(k) => onSort(k as never)}
            cols={[['Element', '', 'target'], ['Rage clicks', '', 'rage'], ['Dead clicks', '', 'dead'], ['Error clicks', '', 'error'], ['Clicks', 'text-right', 'clicks'], 'Recordings', '']} />
          {isPending ? <RowsSkeleton /> : rows.length === 0 ? (
            <EmptyState pinned icon={<MousePointerClick size={22} />} title="No frustrated clicks">Nothing in this range looked like rage, dead or error clicks.</EmptyState>
          ) : rows.map((r) => (
            <div key={JSON.stringify([r.selector, r.elementText, r.trackName])} className={`grid ${COLS} items-center gap-4 border-b border-line/60 px-4 py-2.5 text-[13px] transition-colors hover:bg-[var(--hl)]`}>
              <div className="min-w-0">
                <div className="truncate font-medium" title={r.selector}>{clickLabel(r)}</div>
                <div className="truncate font-mono text-[11px] text-faint" title={r.selector}>{shortSelector(r.selector)}</div>
              </div>
              <Signal clicks={r.rageClicks} sessions={r.rageSessions} />
              <Signal clicks={r.deadClicks} sessions={r.deadSessions} />
              <Signal clicks={r.errorClicks} sessions={r.errorSessions} />
              <div className="text-right tnum text-muted">{fmtNum(r.clicks)}</div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                {r.samples.length === 0 ? <span className="text-faint">–</span> : r.samples.map((s) => (
                  <a key={s.sessionId} className="text-accent hover:underline" title="Open the recording at this click"
                    href={'#' + pageHref(project.id, `recordings/${encodeURIComponent(s.sessionId)}`, route.params, { t: String(s.at) })}>
                    Watch {relTime(s.at)}
                  </a>
                ))}
              </div>
              <div className="flex justify-end"><RowActions scope="events" conditions={clickConditions({ ...r, count: r.clicks, sessions: 0, lastSeen: '' })} /></div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
