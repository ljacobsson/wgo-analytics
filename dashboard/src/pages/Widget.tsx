import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { renderSVG } from 'uqr';
import { CheckCircle2, Download, Link2, RefreshCw, ShieldCheck, Smartphone, Trash2, Wifi } from 'lucide-react';
import { getConfig } from '../api/config';
import type { DeviceCreated } from '../api/contract';
import { useCreateDevice, useDevices, usePreviousTotals, useRevokeDevice, useStats } from '../api/hooks';
import { Sparkline } from '../charts/Sparkline';
import { cn, fmtNum, relTime } from '../lib/format';
import { useProject } from '../lib/project';
import { resolveRange } from '../lib/time';
import { LogoMark } from '../ui/Logo';
import { Badge, Button, Card, CardHeader, CopyButton, Dialog, Skeleton, useToast } from '../ui/kit';

/** Written by scripts/build-android.sh next to the APK. */
interface AndroidBuild {
  file: string;
  applicationId: string;
  versionName: string;
  versionCode: number;
  size: number;
  sha256: string;
  builtAt: string;
}

const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

/** Where the dashboard is served from, without index.html or a trailing slash. */
function dashboardBase(): string {
  return (window.location.origin + window.location.pathname).replace(/\/(index\.html)?$/, '');
}

function useAndroidBuild() {
  return useQuery({
    queryKey: ['android-build'],
    queryFn: async (): Promise<AndroidBuild | null> => {
      const res = await fetch(`${dashboardBase()}/downloads/android.json`, { cache: 'no-store' });
      if (!res.ok) return null;
      try { return (await res.json()) as AndroidBuild; } catch { return null; } // e.g. an SPA fallback page
    },
    staleTime: 5 * 60_000,
  });
}

function Qr({ text, size = 176 }: { text: string; size?: number }) {
  const svg = useMemo(() => renderSVG(text, { border: 2, ecc: 'M', whiteColor: '#ffffff', blackColor: '#0a0a0f' }), [text]);
  return (
    <div className="shrink-0 overflow-hidden rounded-xl bg-white p-1.5 shadow-[0_8px_30px_-12px_rgba(139,124,246,.6)]" style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg.replace('<svg ', '<svg width="100%" height="100%" ') }} />
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12.5px] font-bold', done ? 'bg-good/15 text-good' : 'grad-bg text-white')}>
          {done ? <CheckCircle2 size={15} /> : n}
        </span>
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
      </div>
      <div className="mt-4 pl-10">{children}</div>
    </Card>
  );
}

export function WidgetPage() {
  const build = useAndroidBuild();
  const devices = useDevices();
  const create = useCreateDevice();
  const revoke = useRevokeDevice();
  const toast = useToast();
  const [deviceName, setDeviceName] = useState(isAndroid ? 'This phone' : 'My Android phone');
  const [created, setCreated] = useState<DeviceCreated | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const base = dashboardBase();
  const apkUrl = build.data ? `${base}/downloads/${build.data.file}` : null;
  const pairParams = created
    ? new URLSearchParams({ api: getConfig().apiUrl, dash: base, token: created.token }).toString()
    : null;
  const appLink = pairParams && `wgo://pair?${pairParams}`;
  const pairPage = pairParams && `${base}/pair.html#${pairParams}`;
  // Chrome on Android: open the app, or download it if it isn't installed yet
  const intentLink = pairParams && apkUrl && `intent://pair?${pairParams}#Intent;scheme=wgo;S.browser_fallback_url=${encodeURIComponent(apkUrl)};end`;
  const isLocal = /^http:\/\/(localhost|127\.|\[::1\])/.test(getConfig().apiUrl);

  const connect = () => create.mutate(deviceName.trim() || 'Android phone', {
    onSuccess: setCreated,
    onError: (e) => toast({ title: 'Could not create a connection', body: (e as Error).message, tone: 'bad' }),
  });

  return (
    <div className="mx-auto grid grid-cols-1 max-w-[1180px] gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        <Card className="relative overflow-hidden p-6">
          <div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-[var(--glow1)] blur-3xl" />
          <div className="relative">
            <Badge tone="accent"><Smartphone size={12} />Android widget</Badge>
            <h2 className="mt-3 text-[24px] font-semibold leading-tight tracking-tight">Your stats, <span className="grad-text">on your home screen</span></h2>
            <p className="mt-2 max-w-[560px] text-[13.5px] text-muted">
              Pick the numbers that matter: visitors right now, errors, failed API calls, Web Vitals, backend latency, your tracked clicks
              or any OpenTelemetry metric. Resize the widget from a single number up to a full board. Tap a tile to jump to that page here.
            </p>
          </div>
        </Card>

        <Step n={1} title="Install the app">
          {build.isPending ? <Skeleton className="h-24" /> : !build.data ? (
            <p className="text-[13px] text-muted">
              The Android app isn't part of this deployment. Deploy again with <code className="font-mono text-fg">scripts/deploy.sh</code>, which uploads it.
            </p>
          ) : (
            <div className="flex flex-wrap items-start gap-5">
              {!isAndroid && <Qr text={apkUrl!} size={132} />}
              <div className="min-w-[220px] flex-1 space-y-3">
                <a href={apkUrl!} download className="inline-flex items-center gap-2 rounded-lg grad-bg px-4 py-2 text-[13.5px] font-semibold text-white shadow-[0_6px_20px_-6px_rgba(124,108,240,.7)] hover:brightness-110">
                  <Download size={15} />Download WGO for Android
                </a>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-faint">
                  <span>Version {build.data.versionName}</span><span>{(build.data.size / 1024 / 1024).toFixed(1)} MB</span><span>Android 8+</span>
                  <span>Built {relTime(build.data.builtAt)}</span>
                </div>
                <p className="text-[12.5px] text-muted">
                  {isAndroid ? 'Open the downloaded file to install it.' : 'Scan the code with your phone\'s camera, or send yourself the link.'} Android asks you to allow installs from your browser the first time.
                </p>
                <details className="text-[12px] text-faint">
                  <summary className="cursor-pointer hover:text-muted">Verify the download</summary>
                  <div className="mt-1.5 break-all font-mono text-[11px]">SHA-256 {build.data.sha256}</div>
                </details>
              </div>
            </div>
          )}
        </Step>

        <Step n={2} title="Connect your phone" done={!!created}>
          {!created ? (
            <div className="space-y-3">
              <p className="text-[13px] text-muted">Creates a read-only key for one device. It can only read stats for the projects you can see, and you can revoke it below at any time.</p>
              <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); connect(); }}>
                <input className="field max-w-[280px]" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="Device name" maxLength={60} />
                <Button variant="primary" disabled={create.isPending}><Link2 size={14} />{create.isPending ? 'Creating…' : 'Connect a device'}</Button>
              </form>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start gap-5">
                {!isAndroid && <Qr text={pairPage!} />}
                <div className="min-w-[220px] flex-1 space-y-3 text-[13px]">
                  {isAndroid ? (
                    <a href={intentLink ?? appLink!} className="inline-flex items-center gap-2 rounded-lg grad-bg px-4 py-2 text-[13.5px] font-semibold text-white hover:brightness-110">
                      <Smartphone size={15} />Open in the WGO app
                    </a>
                  ) : (
                    <p className="text-muted">Scan this with the phone the app is installed on. It opens a page with an <span className="text-fg">Open in WGO</span> button.</p>
                  )}
                  <div>
                    <div className="mb-1 text-[12px] text-faint">Or copy the connection link and paste it into the app:</div>
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-[var(--hl)] px-2.5 py-1.5 font-mono text-[11.5px]">{appLink}</code>
                      <CopyButton text={appLink!} />
                    </div>
                  </div>
                  <p className="flex items-start gap-1.5 text-[12px] text-warn"><ShieldCheck size={14} className="mt-[1px] shrink-0" />Anyone with this code can read your stats. It's shown only once. Close this when your phone says Connected.</p>
                  {isLocal && <p className="text-[12px] text-warn">This dashboard talks to {getConfig().apiUrl}. A phone can't reach localhost, so pair against a deployed stack.</p>}
                  <Button variant="secondary" size="sm" onClick={() => setCreated(null)}>Done</Button>
                </div>
              </div>
            </div>
          )}
        </Step>

        <Step n={3} title="Add the widget">
          <ol className="list-decimal space-y-1.5 pl-4 text-[13px] text-muted marker:text-faint">
            <li>In the app, tap <span className="text-fg">Add to home screen</span>. Or long-press your home screen, open <span className="text-fg">Widgets</span> and drag <span className="text-fg">WGO stats</span> out.</li>
            <li>Choose a project, a time range and up to 8 stats. The first stat is shown largest. Or choose <span className="text-fg">All projects</span> for one row per project with up to 3 stats.</li>
            <li>Resize it any way you like: 2×1 shows one number, 4×2 a row of tiles, 4×3 and up a full board with charts.</li>
            <li>Tap the project name to change the stats later, and <RefreshCw size={12} className="inline" /> to refresh right away. Background updates run every 15 to 180 minutes; you set the interval in the app.</li>
          </ol>
        </Step>

        <Card>
          <CardHeader title="Connected devices" sub="Revoking a device stops its widgets updating within a minute." />
          <div className="divide-y divide-line/60 border-t border-line">
            {devices.isPending ? <div className="space-y-2 p-4"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
              : !devices.data?.length ? <div className="px-4 py-5 text-[13px] text-faint">No devices yet.</div>
              : devices.data.map((d) => (
                <div key={d.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--hl)] text-muted"><Smartphone size={14} /></span>
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  <span className="hidden text-[12px] text-faint sm:inline">added {relTime(d.createdAt)}</span>
                  {d.lastUsedAt ? <Badge tone="good"><Wifi size={11} />{relTime(d.lastUsedAt)}</Badge> : <Badge>never used</Badge>}
                  <button onClick={() => setConfirmRevoke(d.id)} className="rounded-md p-1.5 text-faint hover:bg-bad/15 hover:text-bad cursor-pointer" title="Revoke"><Trash2 size={14} /></button>
                </div>
              ))}
          </div>
        </Card>
      </div>

      <div className="lg:sticky lg:top-6 lg:self-start"><PhonePreview /></div>

      <Dialog open={!!confirmRevoke} onClose={() => setConfirmRevoke(null)} title="Revoke device?"
        footer={<><Button variant="ghost" onClick={() => setConfirmRevoke(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => { revoke.mutate(confirmRevoke!, { onError: (e) => toast({ title: 'Could not revoke', body: (e as Error).message, tone: 'bad' }) }); setConfirmRevoke(null); }}>Revoke</Button></>}>
        <p className="text-[13px] text-muted">Its widgets stop updating and show Device disconnected. You can connect it again with a new code.</p>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------------ live preview

const W = { bg: '#0e0e15', tile: '#1a1a24', text: '#f0efec', muted: '#a3a2b0', faint: '#6c6b7a', good: '#34d399', bad: '#f87171' };

function pct(cur: number, prev: number, better: 'up' | 'down') {
  if (!prev) return null;
  const p = ((cur - prev) / prev) * 100;
  if (Math.abs(p) < 0.5) return { label: '±0%', color: W.muted };
  const good = better === 'up' ? p > 0 : p < 0;
  return { label: `${p > 0 ? '▲' : '▼'} ${Math.round(Math.abs(p))}%`, color: good ? W.good : W.bad };
}

/** What the widget looks like on a phone, with this project's real numbers (default stat selection, last 24h). */
function PhonePreview() {
  const { project } = useProject();
  const range = useMemo(() => resolveRange(new URLSearchParams('range=24h'), Date.now()), []);
  const stats = useStats(project.id, range);
  const prev = usePreviousTotals(project.id, range);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setClock(new Date()), 30_000); return () => clearInterval(t); }, []);
  const t = stats.data?.totals, p = prev.data, s = stats.data?.series;
  const tiles = [
    { label: 'Sessions', v: t?.sessions, d: t && p && pct(t.sessions, p.sessions, 'up') },
    { label: 'JS errors', v: t?.errors, d: t && p && pct(t.errors, p.errors, 'down'), spark: s?.map((x) => x.error), color: W.bad },
    { label: 'Clicks', v: t?.clicks, d: t && p && pct(t.clicks, p.clicks, 'up'), spark: s?.map((x) => x.click) },
    { label: 'Failed API calls', v: t?.httpErrors, d: t && p && pct(t.httpErrors, p.httpErrors, 'down') },
  ];
  const hero = t && p ? pct(t.pageviews, p.pageviews, 'up') : null;
  const time = clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="mx-auto w-[320px]">
      <div className="relative overflow-hidden rounded-[44px] border-[7px] border-[#1c1c24] bg-[#06060a] shadow-[0_30px_80px_-30px_rgba(139,124,246,.55)]" style={{ aspectRatio: '9 / 19' }}>
        {/* wallpaper */}
        <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 60% at 15% 10%, rgba(139,124,246,.55), transparent 60%), radial-gradient(90% 50% at 90% 85%, rgba(34,211,238,.35), transparent 60%), linear-gradient(180deg,#14121f,#07070b)' }} />
        <div className="relative flex items-center justify-between px-6 pt-3 text-[11px] font-medium text-white/85"><span>{time}</span><span className="h-4 w-16 rounded-full bg-black/70" /><span>5G ▮▮▮</span></div>

        <div className="relative mx-3 mt-6 rounded-[24px] p-3" style={{ background: W.bg }}>
          <div className="flex items-center gap-2">
            <LogoMark size={18} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[12px] font-bold" style={{ color: W.text }}>{project.name}</div>
              <div className="text-[9.5px]" style={{ color: W.faint }}>Last 24h · updated {time}</div>
            </div>
            <RefreshCw size={13} style={{ color: W.muted }} />
          </div>
          <div className="mt-2.5 rounded-[18px] px-3 py-2.5" style={{ background: W.tile }}>
            <div className="flex items-center justify-between text-[11px]" style={{ color: W.muted }}>
              <span>Pageviews</span>{hero && <span className="rounded-md px-1.5 text-[9px] font-bold" style={{ color: hero.color, background: hero.color + '29' }}>{hero.label}</span>}
            </div>
            <div className="tnum text-[28px] font-bold leading-tight" style={{ color: W.text }}>{t ? fmtNum(t.pageviews) : '–'}</div>
            <div className="h-12">{s ? <Sparkline data={s.map((x) => x.pageview)} color="#8b7cf6" height={48} /> : null}</div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {tiles.map((x) => (
              <div key={x.label} className="rounded-2xl px-2.5 py-2" style={{ background: W.tile }}>
                <div className="flex items-center justify-between gap-1 text-[9.5px]" style={{ color: W.muted }}>
                  <span className="truncate">{x.label}</span>{x.d && <span className="shrink-0 font-bold" style={{ color: x.d.color }}>{x.d.label}</span>}
                </div>
                <div className="tnum text-[17px] font-bold leading-tight" style={{ color: W.text }}>{x.v == null ? '–' : fmtNum(x.v)}</div>
                <div className="h-5">{x.spark && <Sparkline data={x.spark} color={x.color ?? '#22d3ee'} height={20} fill={false} />}</div>
              </div>
            ))}
          </div>
        </div>

        {/* home screen icons + dock */}
        <div className="relative mt-7 grid grid-cols-4 gap-y-5 px-7">
          {['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#0ca30c', '#e66767'].map((c) => (
            <span key={c} className="mx-auto h-11 w-11 rounded-full opacity-80" style={{ background: `linear-gradient(135deg, ${c}, ${c}99)` }} />
          ))}
        </div>
        <div className="absolute inset-x-5 bottom-6 flex justify-around rounded-[26px] bg-white/10 px-3 py-2.5 backdrop-blur">
          {[0, 1, 2, 3].map((i) => <span key={i} className="h-10 w-10 rounded-full bg-white/25" />)}
        </div>
      </div>
      <p className="mt-3 text-center text-[11.5px] text-faint">Preview with {project.name}'s live numbers</p>
    </div>
  );
}
