import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorX, WifiOff } from 'lucide-react';
import { api, ApiError } from '../api/client';
import type { KioskPage, KioskState, Project, Watch } from '../api/contract';
import { KIOSK_TOKEN, normParams } from '../lib/kiosk';
import { PAGES, ProjectCtx } from '../lib/project';
import { navigate, useRoute } from '../lib/router';
import { resolveRange, TimeCtx } from '../lib/time';
import { cn } from '../lib/format';
import { LiveProvider } from '../live/LiveProvider';
import { LiveCtx } from '../live/store';
import { LogoMark } from '../ui/Logo';
import { ToastProvider } from '../ui/kit';
import { Overview } from '../pages/Overview';
import { LivePage } from '../pages/LivePage';
import { ClicksPage } from '../pages/Clicks';
import { ErrorsPage } from '../pages/Errors';
import { NetworkPage } from '../pages/Network';
import { EventsPage } from '../pages/Events';
import { TracesPage } from '../pages/Traces';
import { LogsPage } from '../pages/Logs';
import { MetricsPage } from '../pages/Metrics';
import { DashboardPage } from '../dashboards/DashboardPage';
import { useDashboard } from '../api/hooks';

/**
 * The dashboard as a wall display, at #/kiosk/<token>. No sign-in: the token in the URL authenticates every
 * request (api/client.ts) and the live WebSocket (live/store.ts). The screen polls its configuration, so
 * project members change what it shows from the dashboard; a change starts the rotation over right away.
 *
 * Built to run unattended for months on a Raspberry Pi: it keeps showing the last data while offline, keeps the
 * display awake, hides the cursor, fits each page to the screen, and reloads itself now and then (only
 * when the dashboard is reachable, so Chromium never ends up on its offline error page).
 */
const POLL_MS = 15_000;
const RELOAD_EVERY_MS = 12 * 3600e3; // pick up new dashboard builds, release memory
const RELOAD_RETRY_MS = 5 * 60e3;

const PAGE: Record<KioskPage, () => React.ReactNode> = {
  overview: () => <Overview />,
  live: () => <LivePage />,
  clicks: () => <ClicksPage />,
  errors: () => <ErrorsPage />,
  network: () => <NetworkPage />,
  events: () => <EventsPage />,
  traces: () => <TracesPage traceId={null} />,
  logs: () => <LogsPage />,
  metrics: () => <MetricsPage />,
  dashboard: () => <KioskDashboard />,
};
const pageLabel = (p: KioskPage) => (p === 'dashboard' ? 'Dashboard' : PAGES.find((x) => x.id === p)?.label ?? p);

/** A custom dashboard screen: its id is in the screen's params; members' edits show up within half a minute. */
function KioskDashboard() {
  const id = useRoute().params.get('id');
  return id ? <DashboardPage id={id} readOnly pollMs={30_000} /> : null;
}
/** The screen's caption: its own, the dashboard's name, or the page's. */
function ScreenTitle({ scr, pid }: { scr: { page: KioskPage; params: string; title?: string }; pid: string }) {
  const id = scr.page === 'dashboard' ? new URLSearchParams(scr.params).get('id') : null;
  const dash = useDashboard(pid, id ?? '', undefined, !!id && !scr.title);
  return <>{scr.title || dash.data?.name || pageLabel(scr.page)}</>;
}

/** Reload only if the dashboard answers: reloading while offline would leave Chromium on its error page for good. */
async function safeReload(): Promise<boolean> {
  try {
    const res = await fetch(window.location.pathname, { cache: 'no-store' });
    if (!res.ok) return false;
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

const is401 = (e: unknown) => e instanceof ApiError && e.status === 401;

export function KioskApp() {
  const state = useQuery({
    queryKey: ['kiosk-state'],
    queryFn: () => api<KioskState>('/kiosk/v1/state', {
      params: { w: Math.round(window.innerWidth * devicePixelRatio), h: Math.round(window.innerHeight * devicePixelRatio) },
    }),
    refetchInterval: (q) => (is401(q.state.error) ? 60_000 : POLL_MS),
    refetchIntervalInBackground: true,
    retry: (n, e) => !is401(e) && n < 2,
    staleTime: 0,
  });
  useKeepAlive();

  // "Reload screen" in the dashboard bumps reloadAt
  const bootReloadAt = useRef<string | null | undefined>(undefined);
  const reloadAt = state.data?.reloadAt;
  useEffect(() => {
    if (reloadAt === undefined) return;
    if (bootReloadAt.current === undefined) bootReloadAt.current = reloadAt;
    else if (reloadAt !== bootReloadAt.current) void safeReload();
  }, [reloadAt, state.dataUpdatedAt]);

  useEffect(() => {
    if (state.data) document.title = `${state.data.kiosk.name} · WGO`;
    if (state.data) document.documentElement.dataset.theme = state.data.config.theme;
  }, [state.data]);

  if (!KIOSK_TOKEN || is401(state.error)) {
    return <Notice icon={<MonitorX size={28} />} title="This kiosk link no longer works">
      It was removed or replaced in WGO. Open <b>Kiosks</b> in the dashboard and set up this screen again with the current link.
    </Notice>;
  }
  if (!state.data) {
    return <Notice title={state.isError ? 'Can’t reach WGO yet' : 'Connecting to WGO…'} pulse>
      {state.isError ? 'Retrying every few seconds. Check the network if this doesn’t go away.' : 'Loading what to show.'}
    </Notice>;
  }
  return <ToastProvider><Screens st={state.data} offline={state.isError} /></ToastProvider>;
}

function Screens({ st, offline }: { st: KioskState; offline: boolean }) {
  const qc = useQueryClient();
  const { config, project } = st;
  const { screens } = config;

  // rotation; a change from the dashboard starts over at the first screen, so it shows up at once
  const [idx, setIdx] = useState(0);
  const [seenVersion, setSeenVersion] = useState(st.version);
  if (st.version !== seenVersion) { setSeenVersion(st.version); setIdx(0); }
  const i = idx % screens.length;
  const scr = screens[i];
  useEffect(() => {
    if (screens.length < 2) return;
    const t = setTimeout(() => setIdx((x) => (x + 1) % screens.length), config.rotateSeconds * 1000);
    return () => clearTimeout(t);
  }, [i, st.version, screens.length, config.rotateSeconds]);

  // pages read their range, filters and options from the hash, exactly as in the dashboard
  const want = normParams(scr.params);
  const route = useRoute();
  const atScreen = route.segments[0] === 'kiosk' && route.segments[1] === KIOSK_TOKEN && route.segments.length === 2 && route.params.toString() === want;
  useLayoutEffect(() => {
    if (!atScreen) navigate(`/kiosk/${KIOSK_TOKEN}${want ? `?${want}` : ''}`, true); // also undoes taps that navigate away
  }, [atScreen, want]);

  // data refresh: a new `now` moves the time range, which re-queries; screens share it between rotations
  const refreshMs = config.refreshSeconds * 1000;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), refreshMs); return () => clearInterval(t); }, [refreshMs]);
  const paramsKey = route.params.toString();
  const range = useMemo(() => resolveRange(route.params, now), [paramsKey, now]); // eslint-disable-line react-hooks/exhaustive-deps
  const timeCtx = useMemo(() => ({ range, refresh: () => { setNow(Date.now()); void qc.invalidateQueries(); }, auto: true, setAuto: () => {} }), [range, qc]);
  const projectCtx = useMemo(() => ({
    // a kiosk only knows the project's id and name; pages don't need more
    project: { id: project.id, name: project.name, role: 'member', writeKey: '', createdAt: '' } as unknown as Project,
    projects: [], email: '',
  }), [project.id, project.name]);

  // zoom for screens read from across the room: a wrapper scaled up to fill the window
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const h = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', h); return () => window.removeEventListener('resize', h);
  }, []);
  const zoom = config.zoom || 1;

  const mainRef = useRef<HTMLElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const screenKey = `${i}:${st.version}`;
  useFitToScreen(mainRef, pageRef, `${screenKey}:${atScreen}`);
  const idle = useIdleCursor();

  return (
    <ProjectCtx.Provider value={projectCtx}>
      <TimeCtx.Provider value={timeCtx}>
        <LiveProvider pid={project.id}>
          <KioskWatches watches={scr.page === 'live' ? scr.watches ?? [] : []} />
          <div className={cn('bg-atmos flex flex-col overflow-hidden', idle && 'cursor-none [&_*]:cursor-none')} style={{ zoom, width: vp.w / zoom, height: vp.h / zoom }}>
            <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] px-6 backdrop-blur-xl">
              <LogoMark size={28} />
              <div className="min-w-0">
                <div className="truncate text-[17px] font-semibold leading-tight tracking-tight"><ScreenTitle scr={scr} pid={project.id} /></div>
                <div className="truncate text-[12px] text-muted">{project.name} · {range.preset === 'custom' ? 'Fixed dates' : range.label}</div>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-5">
                {offline && <span className="inline-flex items-center gap-1.5 rounded-full border border-warn/40 bg-warn/10 px-3 py-1 text-[12px] font-medium text-warn"><WifiOff size={13} />Offline · showing the last data</span>}
                {screens.length > 1 && (
                  <div className="flex items-center gap-1.5" aria-label={`Screen ${i + 1} of ${screens.length}`}>
                    {screens.map((_, j) => <i key={j} className={cn('h-1.5 rounded-full transition-all duration-300', j === i ? 'w-5 bg-accent' : 'w-1.5 bg-[var(--line-strong)]')} />)}
                  </div>
                )}
                <Clock />
              </div>
            </header>
            {screens.length > 1 && (
              <div className="h-[2px] shrink-0 bg-[var(--line)]">
                <div key={screenKey} className="h-full origin-left grad-bg" style={{ animation: `kiosk-progress ${config.rotateSeconds}s linear forwards` }} />
              </div>
            )}
            <main ref={mainRef} className="min-h-0 flex-1 overflow-hidden">
              {atScreen && <div key={screenKey} ref={pageRef} className="page-in p-5">{PAGE[scr.page]()}</div>}
            </main>
          </div>
          <style>{'@keyframes kiosk-progress { from { transform: scaleX(0) } to { transform: scaleX(1) } }'}</style>
        </LiveProvider>
      </TimeCtx.Provider>
    </ProjectCtx.Provider>
  );
}

/** The live screen counts the watches saved with it. */
function KioskWatches({ watches }: { watches: Watch[] }) {
  const store = useContext(LiveCtx);
  const key = JSON.stringify(watches);
  useEffect(() => { store.setWatches(watches); }, [store, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function Clock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => { const i = setInterval(() => setT(new Date()), 5_000); return () => clearInterval(i); }, []);
  return <span className="tnum text-[20px] font-semibold tracking-tight">{t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>;
}

function Notice({ icon, title, children, pulse }: { icon?: React.ReactNode; title: string; children: React.ReactNode; pulse?: boolean }) {
  return (
    <div className="bg-atmos grid h-full place-items-center p-8 cursor-none">
      <div className="max-w-[560px] text-center">
        <div className={cn('mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-[var(--hl)] text-muted', pulse && 'pulse-dot')}>{icon ?? <LogoMark size={40} />}</div>
        <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
        <p className="mt-3 text-[15px] text-muted">{children}</p>
      </div>
    </div>
  );
}

const MIN_ZOOM = 0.3, ZOOM_STEP = 0.05;
const BREAKPOINTS: [string, number][] = [['sm', 640], ['md', 768], ['lg', 1024], ['xl', 1280], ['2xl', 1536]];
const SETTLE_MS = 6000; // while a screen loads, it is fitted afresh whenever its size changes
const GROW_CHECK_MS = 30_000; // after that, it shrinks when content grows, and checks now and then if it can grow back

/**
 * Pages fit the screen instead of scrolling: a TV has nobody to scroll it. The page is zoomed out until it fits,
 * down to MIN_ZOOM. A page that doesn't fit even then (a long list) shows at full size instead, cut off at the
 * bottom, so its first rows stay readable. Zooming out lays the page out wider, and the
 * breakpoints follow that width (data-vw, see index.css), so the widgets move side by side instead of only
 * getting smaller. The kiosk's own zoom setting is then the largest size a page is shown at.
 *
 * Each try lays the page out once, which is slow on a Raspberry Pi: a full search runs when a screen shows (and
 * while it loads), later checks only try the zoom next to the current one.
 */
function useFitToScreen(mainRef: RefObject<HTMLElement | null>, pageRef: RefObject<HTMLElement | null>, key: string) {
  useLayoutEffect(() => {
    document.documentElement.dataset.kiosk = '';
    const main = mainRef.current, page = pageRef.current;
    if (!main || !page) return;
    let zoom = 1, clipped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const shownAt = performance.now();
    const apply = (z: number) => {
      const width = main.clientWidth / z;
      page.style.zoom = String(z);
      page.dataset.vw = BREAKPOINTS.filter(([, px]) => width >= px).map(([bp]) => bp).join(' ');
    };
    const fits = () => main.scrollHeight <= main.clientHeight + 1; // reading it lays the page out at once
    // the largest zoom up to `from` that fits: down in steps, then halve the last step three times
    const search = (from: number) => {
      clipped = false;
      let bad: number | null = null;
      for (let z = from; z >= MIN_ZOOM - 1e-9; z = Math.round((z - ZOOM_STEP) * 1000) / 1000) {
        apply(z);
        if (!fits()) { bad = z; continue; }
        let ok = z;
        for (let k = 0; bad !== null && k < 3; k++) {
          const mid = (ok + bad) / 2;
          apply(mid);
          if (fits()) ok = mid; else bad = mid;
        }
        apply(ok);
        return ok;
      }
      clipped = true;
      apply(1);
      return 1;
    };
    zoom = search(1);
    let size = `${main.clientWidth}x${main.clientHeight}`;
    const check = () => {
      const now = `${main.clientWidth}x${main.clientHeight}`;
      if (now !== size || performance.now() - shownAt < SETTLE_MS) { size = now; zoom = search(1); }
      else if (!clipped && !fits()) zoom = search(zoom);
    };
    const ro = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(check, 200); });
    ro.observe(main);
    ro.observe(page);
    const grow = setInterval(() => {
      if (clipped) { // does it fit now?
        apply(MIN_ZOOM);
        if (fits()) zoom = search(1); else apply(1);
        return;
      }
      if (!fits()) { zoom = search(zoom); return; }
      if (zoom >= 1) return;
      apply(Math.min(1, zoom + ZOOM_STEP));
      if (fits()) zoom = search(1); // content got shorter: there is room to grow
      else apply(zoom);
    }, GROW_CHECK_MS);
    return () => { ro.disconnect(); clearTimeout(timer); clearInterval(grow); };
  }, [mainRef, pageRef, key]);
}

/** Hide the pointer unless someone moves the mouse. */
function useIdleCursor(): boolean {
  const [idle, setIdle] = useState(true);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const move = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 3000); };
    window.addEventListener('pointermove', move);
    return () => { window.removeEventListener('pointermove', move); clearTimeout(t); };
  }, []);
  return idle;
}

/** Keep the display awake, and reload now and then to pick up new dashboard builds and start fresh. */
function useKeepAlive() {
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null;
    const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    const acquire = () => { if (wl && document.visibilityState === 'visible') wl.request('screen').then((l) => { lock = l; }, () => {}); };
    acquire();
    document.addEventListener('visibilitychange', acquire); // the lock is dropped whenever the page is hidden

    let timer: ReturnType<typeof setTimeout>;
    const reload = async () => { if (!(await safeReload())) timer = setTimeout(reload, RELOAD_RETRY_MS); };
    timer = setTimeout(reload, RELOAD_EVERY_MS);
    return () => { document.removeEventListener('visibilitychange', acquire); void lock?.release(); clearTimeout(timer); };
  }, []);
}
