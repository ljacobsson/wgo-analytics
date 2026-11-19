import { useEffect, useMemo, useRef, useState } from 'react';
import { MousePointerClick } from 'lucide-react';
import { useHeatmap, usePages, useRecording } from '../api/hooks';
import type { HeatmapPoint } from '../api/contract';
import { fmtNum } from '../lib/format';
import { useProject } from '../lib/project';
import { pageHref, useRoute, useSetParams } from '../lib/router';
import { useTime } from '../lib/time';
import { buildTimeline, snapshotHtml, type Snap, type Timeline } from '../replay/timeline';
import { Card, EmptyState, ErrorState, Segmented, Skeleton } from '../ui/kit';

const MAX_H = 20_000;
const FALLBACK_H = 1600;

/** colour ramp for density 0..1: blue, cyan, yellow, red */
const STOPS: Array<[number, [number, number, number]]> = [[0, [59, 130, 246]], [0.35, [34, 211, 238]], [0.65, [250, 204, 21]], [1, [239, 68, 68]]];
function ramp(t: number): [number, number, number] {
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i];
      const f = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return STOPS[STOPS.length - 1][1];
}
const LUT = Array.from({ length: 256 }, (_, i) => ramp(i / 255));

/** Density map: radial blobs accumulate in the alpha channel, which is then coloured by the ramp. */
function paintHeat(canvas: HTMLCanvasElement, points: HeatmapPoint[], sx: number, sy: number, radius: number) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const max = Math.max(1, ...points.map((p) => p.n));
  for (const p of points) {
    const x = (p.x + 4) * sx, y = (p.y + 4) * sy;
    const a = Math.min(1, 0.12 + 0.55 * Math.sqrt(p.n / max));
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, `rgba(0,0,0,${a})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (!a) continue;
    const c = LUT[a];
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
    d[i + 3] = Math.min(235, a * 1.5);
  }
  ctx.putImageData(img, 0, 0);
}

const pathOf = (u: string | undefined) => { try { return u ? new URL(u).pathname : ''; } catch { return ''; } };

/** The snapshot of `path` closest to `at`. */
function pickSnap(tl: Timeline, path: string, at: number): Snap | null {
  let best: Snap | null = null;
  for (const s of tl.snaps) {
    if (pathOf(s.meta.u) !== path || s.meta.big) continue;
    if (!best || Math.abs(s.at - at) < Math.abs(best.at - at)) best = s;
  }
  return best;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    setW(el.clientWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function HeatSurface({ points, vw, html, snapW, snapH }: { points: HeatmapPoint[]; vw: number; html: string | null; snapW: number; snapH: number }) {
  const [box, boxW] = useWidth();
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [docH, setDocH] = useState(0);
  const W = html ? snapW : Math.max(vw, 320);
  const maxY = points.reduce((m, p) => Math.max(m, p.y), 0);
  const H = Math.min(MAX_H, Math.max(html ? docH || Math.max(snapH, FALLBACK_H) : 0, maxY + 160, html ? 0 : 600));
  const s = boxW ? Math.min(1, boxW / W) : 1;
  const xScale = html && vw ? snapW / vw : 1;

  useEffect(() => { setDocH(0); }, [html]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !boxW) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1, 16_000 / Math.max(1, H * s));
    c.width = Math.max(1, Math.round(W * s * dpr));
    c.height = Math.max(1, Math.round(H * s * dpr));
    paintHeat(c, points, s * dpr * xScale, s * dpr, 26 * Math.max(s, 0.6) * dpr);
  }, [points, W, H, s, boxW, xScale]);

  return (
    <div ref={box} className="w-full overflow-x-hidden">
      <div className="relative mx-auto overflow-hidden rounded-md border border-line" style={{ width: W * s, height: H * s, background: html ? '#fff' : 'var(--bg)' }}>
        {html ? (
          <iframe ref={frame} title="Page behind the heatmap" sandbox="allow-same-origin" tabIndex={-1} srcDoc={html}
            className="pointer-events-none absolute left-0 top-0 origin-top-left border-0 bg-white" style={{ width: W, height: H, transform: `scale(${s})` }}
            onLoad={() => { const h = frame.current?.contentDocument?.documentElement?.scrollHeight; if (h) setDocH(Math.min(MAX_H, h)); }} />
        ) : (
          <div className="absolute inset-0 opacity-60" style={{ backgroundImage: 'linear-gradient(var(--line) 1px, transparent 1px)', backgroundSize: `100% ${200 * s}px` }} />
        )}
        <canvas ref={canvas} className="pointer-events-none absolute left-0 top-0" style={{ width: W * s, height: H * s }} />
      </div>
    </div>
  );
}

export function HeatmapTab() {
  const { project } = useProject(); const { range } = useTime(); const route = useRoute(); const set = useSetParams();
  const pages = usePages(project.id, range, 50);
  const device = route.params.get('device') === 'mobile' ? 'mobile' : 'desktop';
  const path = route.params.get('hp') ?? pages.data?.[0]?.path ?? '';
  const hm = useHeatmap(project.id, range, path, device);
  const snapshot = hm.data?.snapshot ?? null;
  const rec = useRecording(project.id, snapshot?.sessionId ?? '', !!snapshot);
  const tl = useMemo(() => (rec.data ? buildTimeline(rec.data.chunks) : null), [rec.data]);
  const snap = useMemo(() => (tl && snapshot ? pickSnap(tl, path, snapshot.at) : null), [tl, snapshot, path]);
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setHtml(null);
    if (tl && snap) void snapshotHtml(tl, snap).then((h) => { if (live) setHtml(h); });
    return () => { live = false; };
  }, [tl, snap]);

  if (pages.isError) return <ErrorState error={pages.error} retry={() => pages.refetch()} />;
  if (hm.isError) return <ErrorState error={hm.error} retry={() => hm.refetch()} />;
  const data = hm.data;
  const loadingPage = !!snapshot && (rec.isPending || (!!snap && !html));
  const noSnapshot = !!data && !loadingPage && !html;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <select className="field !w-auto min-w-[220px] max-w-full" aria-label="Page" value={path} onChange={(e) => set({ hp: e.target.value })}>
          {(pages.data ?? []).map((p) => <option key={p.path} value={p.path}>{p.path}</option>)}
          {path && !(pages.data ?? []).some((p) => p.path === path) && <option value={path}>{path}</option>}
        </select>
        <Segmented value={device} onChange={(v) => set({ device: v === 'desktop' ? null : v })} options={[{ value: 'desktop', label: 'Desktop' }, { value: 'mobile', label: 'Mobile' }]} />
        <span className="ml-auto whitespace-nowrap text-[12.5px] text-muted tnum">{data ? `${fmtNum(data.total)} clicks${data.vw ? ` at about ${data.vw}px wide` : ''}` : ''}</span>
      </div>
      {noSnapshot && (
        <p className="text-[12.5px] text-muted">
          {snapshot ? 'The recording of this page could not be shown, so the clicks are drawn on a blank page.' : 'There is no recording of this page in this range, so the clicks are drawn on a blank page.'}{' '}
          Turn on <a className="text-accent hover:underline" href={'#' + pageHref(project.id, 'recordings', route.params)}>session recording</a> to see the page behind the heatmap.
        </p>
      )}
      <Card className="p-3">
        {!path || hm.isPending || loadingPage ? <Skeleton className="h-[420px]" /> : data && data.points.length === 0 ? (
          <EmptyState icon={<MousePointerClick size={22} />} title="No clicks on this page">No clicks with a position were recorded for this page and device in this range.</EmptyState>
        ) : data && <HeatSurface points={data.points} vw={data.vw} html={html} snapW={snap?.meta.w ?? data.vw} snapH={snap?.meta.h ?? 0} />}
      </Card>
    </div>
  );
}
