import { useMemo, useRef, useState, type ReactNode } from 'react';
import { FLOW_OTHER, type FlowLink, type FlowNode, type FlowsResponse } from '../api/contract';
import { cn, fmtNum } from '../lib/format';
import { Popover } from '../ui/Popover';
import { compact, useSize } from './util';

const NODE_W = 12;
const GAP = 24; // between the nodes of a column
const LABEL_W = 180; // room right of the last column
const PAD_T = 28; // step headings
const MIN_H = 2;
const COL_MIN = 210; // narrower than this per step, the chart scrolls sideways
const LINE = 14;

export interface LaidNode extends FlowNode { id: string; x: number; y: number; h: number; exitH: number; room: number }
export interface LaidLink extends FlowLink { id: string; src: string; dst: string; x0: number; x1: number; sy: number; ty: number; h: number }

const nodeId = (step: number, key: string) => `${step}\u0000${key}`;
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');

/**
 * Column per step, nodes stacked top-down in the order given (by sessions, '(other)' last), heights in proportion
 * to sessions on one scale for the whole chart. A node's bands leave from its top in the order of their targets
 * (so they don't cross on the way out) and arrive in the order of their sources; what's left at the bottom of a
 * node are the sessions that left there.
 */
export function layoutFlows(data: FlowsResponse, width: number, height: number): { nodes: LaidNode[]; links: LaidLink[]; span: number } {
  const steps = Math.max(2, data.steps);
  const span = (width - NODE_W - LABEL_W) / (steps - 1);
  const cols = Array.from({ length: data.steps }, (_, i) => data.nodes.filter((n) => n.step === i));
  const avail = height - PAD_T - 4;
  const scales = cols.filter((c) => c.length).map((c) => (avail - (c.length - 1) * GAP) / Math.max(1, c.reduce((a, n) => a + n.sessions, 0)));
  const k = scales.length ? Math.max(0, Math.min(...scales)) : 0;

  const nodes: LaidNode[] = [];
  for (const col of cols) {
    let y = PAD_T;
    col.forEach((n) => {
      const h = Math.max(MIN_H, n.sessions * k);
      nodes.push({ ...n, id: nodeId(n.step, n.key), x: n.step * span, y, h, exitH: Math.min(h, n.exits * k), room: 0 });
      y += h + GAP;
    });
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    const next = nodes.find((m) => m.step === n.step && m.y > n.y);
    n.room = (next ? next.y : height) - n.y;
  }

  const links: LaidLink[] = data.links.flatMap((l) => {
    const s = byId.get(nodeId(l.step, l.from)), t = byId.get(nodeId(l.step + 1, l.to));
    return s && t ? [{ ...l, id: `${s.id}\u0001${t.id}`, src: s.id, dst: t.id, x0: s.x + NODE_W, x1: t.x, sy: 0, ty: 0, h: Math.max(1, l.sessions * k) }] : [];
  });
  const yOf = (id: string) => byId.get(id)!.y;
  const out = new Map<string, number>(), inn = new Map<string, number>();
  for (const l of [...links].sort((a, b) => yOf(a.dst) - yOf(b.dst))) { const o = out.get(l.src) ?? yOf(l.src); l.sy = o; out.set(l.src, o + l.h); }
  for (const l of [...links].sort((a, b) => yOf(a.src) - yOf(b.src))) { const o = inn.get(l.dst) ?? yOf(l.dst); l.ty = o; inn.set(l.dst, o + l.h); }
  return { nodes, links, span };
}

function band(l: LaidLink): string {
  const m = (l.x0 + l.x1) / 2;
  return `M${l.x0},${l.sy} C${m},${l.sy} ${m},${l.ty} ${l.x1},${l.ty} L${l.x1},${l.ty + l.h} C${m},${l.ty + l.h} ${m},${l.sy + l.h} ${l.x0},${l.sy + l.h} Z`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + '…';
}

type Hover = { kind: 'node'; n: LaidNode; x: number; y: number } | { kind: 'link'; l: LaidLink; x: number; y: number };

export function FlowChart({ data, highlightErrors, panel }: {
  data: FlowsResponse;
  highlightErrors: boolean;
  /** What opens when a node is clicked. */
  panel: (n: FlowNode, close: () => void) => ReactNode;
}) {
  const [ref, w] = useSize<HTMLDivElement>();
  const maxNodes = Math.max(1, ...Array.from({ length: data.steps }, (_, i) => data.nodes.filter((n) => n.step === i).length));
  const height = PAD_T + Math.max(300, maxNodes * 62);
  const width = Math.max(w, data.steps * COL_MIN);
  const { nodes, links, span } = useMemo(() => layoutFlows(data, width, height), [data, width, height]);
  const [hover, setHover] = useState<Hover | null>(null);
  const [selected, setSelected] = useState<LaidNode | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const colTotal = (step: number) => nodes.filter((n) => n.step === step).reduce((a, n) => a + n.sessions, 0);

  // what the pointer is on lights up with everything connected to it
  const focus = hover?.kind === 'node' ? hover.n.id : selected?.id ?? null;
  const linkOn = (l: LaidLink) => (hover?.kind === 'link' ? hover.l.id === l.id : focus ? l.src === focus || l.dst === focus : null);
  const errShare = (n: FlowNode) => (n.sessions ? n.errors / n.sessions : 0);
  const at = (e: React.MouseEvent) => {
    const r = (e.currentTarget as Element).closest('svg')!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div ref={ref} className="overflow-x-auto">
      {w > 0 && (
        <div className="relative" style={{ width, height }}>
          <svg width={width} height={height} className="block select-none" onMouseLeave={() => setHover(null)}>
            {Array.from({ length: data.steps }, (_, i) => (
              <text key={i} x={i * span} y={12} fontSize="11" className="fill-faint">
                {i === 0 ? (data.start ? 'Start page' : 'Entry page') : `Page ${i + 1}`}
                <tspan className="tnum"> · {compact(colTotal(i))}</tspan>
              </text>
            ))}
            <g>
              {links.map((l) => {
                const on = linkOn(l);
                const errs = highlightErrors && (errShare(byId.get(l.src)!) > 0 || errShare(byId.get(l.dst)!) > 0);
                return (
                  <path key={l.id} d={band(l)} fill={errs ? 'var(--bad)' : 'var(--accent)'} className="cursor-default transition-[fill-opacity] duration-150"
                    fillOpacity={on === true ? 0.5 : on === false ? 0.06 : highlightErrors ? (errs ? 0.22 : 0.07) : 0.2}
                    onMouseMove={(e) => setHover({ kind: 'link', l, ...at(e) })} onMouseLeave={() => setHover(null)} />
                );
              })}
            </g>
            {nodes.map((n) => {
              const share = errShare(n);
              const dim = (highlightErrors && !n.errors) || (focus != null && focus !== n.id && !links.some((l) => (l.src === focus && l.dst === n.id) || (l.dst === focus && l.src === n.id)));
              const fill = n.key === FLOW_OTHER ? 'var(--faint)' : highlightErrors && n.errors ? 'var(--bad)' : 'var(--accent)';
              const chars = Math.floor(((n.step === data.steps - 1 ? LABEL_W : span) - NODE_W - 16) / 6.4);
              const lx = n.x + NODE_W + 6, ly = n.y + 11;
              const twoLines = n.room >= LINE * 2 + 4;
              return (
                <g key={n.id} opacity={dim ? 0.35 : 1} className="cursor-pointer transition-opacity duration-150"
                  onMouseMove={(e) => setHover({ kind: 'node', n, ...at(e) })} onMouseLeave={() => setHover(null)}
                  onClick={() => setSelected(selected?.id === n.id ? null : n)}>
                  <rect x={n.x} y={n.y} width={NODE_W} height={n.h} rx={2} fill={fill} fillOpacity={highlightErrors && n.errors ? 0.45 + 0.55 * Math.min(1, share * 3) : 0.9} />
                  {n.exitH > 0.5 && <rect x={n.x} y={n.y + n.h - n.exitH} width={NODE_W} height={n.exitH} rx={2} fill="var(--bad)" fillOpacity={0.75} />}
                  {n.errors > 0 && <rect x={n.x - 2} y={n.y - 2} width={NODE_W + 4} height={n.h + 4} rx={3} fill="none" stroke="var(--bad)" strokeWidth={highlightErrors ? 2 : 1.25} />}
                  {selected?.id === n.id && <rect x={n.x - 4} y={n.y - 4} width={NODE_W + 8} height={n.h + 8} rx={4} fill="none" stroke="var(--fg)" strokeWidth={1.25} />}
                  <rect x={n.x + NODE_W} y={n.y} width={Math.max(0, chars * 6.4)} height={Math.min(n.room - 4, twoLines ? LINE * 2 + 2 : LINE)} fill="transparent" />
                  <text x={lx} y={ly} fontSize="11.5" paintOrder="stroke" stroke="var(--bg)" strokeWidth={3} strokeLinejoin="round">
                    <tspan className={cn('fill-fg', n.key === FLOW_OTHER && 'fill-muted')} fontWeight={500}>{truncate(n.key, Math.max(4, chars - 6))}</tspan>
                    <tspan className="fill-muted tnum"> {compact(n.sessions)}</tspan>
                  </text>
                  {twoLines && (n.exits > 0 || n.errors > 0) && (
                    <text x={lx} y={ly + LINE} fontSize="10.5" paintOrder="stroke" stroke="var(--bg)" strokeWidth={3} strokeLinejoin="round" className="tnum">
                      {n.exits > 0 && <tspan className="fill-muted">{compact(n.exits)} left ({pct(n.exits, n.sessions)})</tspan>}
                      {n.errors > 0 && <tspan className="fill-bad" fontWeight={600}>{n.exits > 0 ? ' · ' : ''}⚠ {compact(n.errors)} hit errors</tspan>}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          {hover && !(hover.kind === 'node' && hover.n.id === selected?.id) && <Tip hover={hover} data={data} byId={byId} width={width} />}
          {selected && <div ref={anchor} className="pointer-events-none absolute" style={{ left: selected.x, top: selected.y, width: NODE_W, height: selected.h }} />}
          <Popover anchor={anchor} open={!!selected} onClose={() => setSelected(null)} align="start" width={340}>
            {selected && panel(selected, () => setSelected(null))}
          </Popover>
        </div>
      )}
    </div>
  );
}

function Tip({ hover, data, byId, width }: { hover: Hover; data: FlowsResponse; byId: Map<string, LaidNode>; width: number }) {
  const left = Math.min(width - 250, hover.x + 14), top = hover.y + 14;
  return (
    <div className="pointer-events-none absolute z-10 w-[240px] rounded-lg border border-line bg-[var(--raised)] px-2.5 py-2 text-[11.5px] shadow-xl" style={{ left: Math.max(0, left), top }}>
      {hover.kind === 'node' ? <NodeSummary n={hover.n} last={hover.n.step === data.steps - 1} /> : (() => {
        const from = byId.get(hover.l.src)!;
        return (
          <>
            <div className="break-all font-medium">{hover.l.from} <span className="text-faint">→</span> {hover.l.to}</div>
            <div className="mt-1 text-muted tnum">{fmtNum(hover.l.sessions)} sessions, {pct(hover.l.sessions, from.sessions)} of {hover.l.from}</div>
          </>
        );
      })()}
    </div>
  );
}

/** Sessions, how many went on or left, and the errors hit there. Shared by the tooltip and the click panel. */
export function NodeSummary({ n, last }: { n: FlowNode; last: boolean }) {
  const on = n.sessions - n.exits;
  const others = n.sessions - n.errors;
  return (
    <div className="space-y-1">
      <div className="break-all font-medium">{n.key}</div>
      <div className="text-faint">{n.step === 0 ? 'First page' : `Page ${n.step + 1}`} · {fmtNum(n.sessions)} sessions</div>
      <div className="tnum">
        <div><span className="text-muted">{last ? 'Went on' : 'Continued'}</span> {fmtNum(on)} ({pct(on, n.sessions)})</div>
        <div><span className="text-muted">Left here</span> <span className={n.exits ? 'text-bad' : ''}>{fmtNum(n.exits)} ({pct(n.exits, n.sessions)})</span></div>
        {n.errors > 0 && <>
          <div className="text-bad">{fmtNum(n.errors)} hit an error ({pct(n.errors, n.sessions)})</div>
          <div className="text-muted">Left after an error: {pct(n.errorExits, n.errors)}{others > 0 && <>, without: {pct(n.exits - n.errorExits, others)}</>}</div>
        </>}
      </div>
    </div>
  );
}
