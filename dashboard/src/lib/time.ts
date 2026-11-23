import { createContext, useContext } from 'react';
import type { Route } from './router';

export const PRESETS = ['15m', '1h', '24h', '7d', '30d'] as const;
export type Preset = (typeof PRESETS)[number];
export const PRESET_MS: Record<Preset, number> = {
  '15m': 15 * 60e3, '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3,
};
const SNAP_MS: Record<Preset, number> = { '15m': 15e3, '1h': 15e3, '24h': 60e3, '7d': 5 * 60e3, '30d': 15 * 60e3 };

/**
 * The comparison window (same length, right before `from`), snapped to a coarse grid: it lies entirely in the
 * past, so it only needs re-fetching when it has moved noticeably.
 */
export function previousWindow(r: TimeRange): { from: string; to: string } {
  const grid = r.ms <= 3600e3 ? 60e3 : r.ms <= 86400e3 ? 15 * 60e3 : 3600e3;
  const to = r.preset === 'custom' ? Date.parse(r.from) : Math.floor(Date.parse(r.from) / grid) * grid;
  return { from: new Date(to - r.ms).toISOString(), to: new Date(to).toISOString() };
}

export interface TimeRange { from: string; to: string; label: string; preset: Preset | 'custom'; ms: number }

export function resolveRange(params: URLSearchParams, now: number): TimeRange {
  const r = params.get('range') ?? '24h';
  if (r === 'custom' && params.get('from') && params.get('to')) {
    const from = params.get('from')!, to = params.get('to')!;
    return { from, to, preset: 'custom', label: windowLabel(from, to), ms: Date.parse(to) - Date.parse(from) };
  }
  const preset = (PRESETS as readonly string[]).includes(r) ? (r as Preset) : '24h';
  const ms = PRESET_MS[preset];
  // snap `to` so that query keys are stable between renders, and so auto-refresh re-queries a long range
  // only as often as its numbers can visibly change (each refresh re-reads the whole range)
  const snap = SNAP_MS[preset];
  const to = Math.floor(now / snap) * snap;
  return { from: new Date(to - ms).toISOString(), to: new Date(to).toISOString(), preset, label: `Last ${preset}`, ms };
}
export const TimeCtx = createContext<{ range: TimeRange; refresh: () => void; auto: boolean; setAuto: (b: boolean) => void }>(null as never);
export const useTime = () => useContext(TimeCtx);
export type { Route };

/** "Nov 23, 14:05–14:35", or with both dates when the window spans days. */
export function windowLabel(from: string, to: string): string {
  const a = new Date(from), b = new Date(to);
  const day = (d: Date) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const time = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return a.toDateString() === b.toDateString() ? `${day(a)}, ${time(a)}–${time(b)}` : `${day(a)} ${time(a)} – ${day(b)} ${time(b)}`;
}
