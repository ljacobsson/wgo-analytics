import type { Goal, ReleaseHealth, ReleaseMarker, ReleasesResponse, ServiceVersionHealth } from '../api/contract';
import { totalsFor } from './data';

/**
 * Mock releases: a web release every few days (the latest one, a few hours old, made things worse) and a few
 * service versions. Health numbers scale with the part of the range each version was live in.
 */
const H = 3600_000;
const WEB = [
  { v: '2.7.0', ago: 216 * H, err: 0.031, fail: 0.012, lcp: 2050, inp: 190, cls: 0.06, conv: 0.041 },
  { v: '2.7.1', ago: 140 * H, err: 0.029, fail: 0.011, lcp: 2010, inp: 185, cls: 0.05, conv: 0.043 },
  { v: '2.8.0', ago: 60 * H, err: 0.027, fail: 0.010, lcp: 1980, inp: 120, cls: 0.05, conv: 0.044 },
  { v: '2.8.1', ago: 5 * H, err: 0.081, fail: 0.034, lcp: 2900, inp: 125, cls: 0.05, conv: 0.031 },
];
const SVC = [
  { s: 'api-gateway', v: '1.14.1', ago: 170 * H, er: 0.004, p50: 48, p95: 210 },
  { s: 'api-gateway', v: '1.14.2', ago: 30 * H, er: 0.004, p50: 46, p95: 205 },
  { s: 'payment-service', v: '3.2.0', ago: 300 * H, er: 0.011, p50: 320, p95: 820 },
  { s: 'payment-service', v: '3.3.0', ago: 6 * H, er: 0.052, p50: 410, p95: 1900 },
];
const NEW_ERRORS: Record<string, Array<{ fingerprint: string; message: string; share: number }>> = {
  '2.8.1': [{ fingerprint: 'fp_cart_null', message: "TypeError: Cannot read properties of null (reading 'items')", share: 0.6 }],
  '2.8.0': [{ fingerprint: 'fp_img_lazy', message: 'Failed to load resource: hero@2x.webp', share: 0.2 }],
};

const overlap = (a: number, b: number, from: number, to: number) => Math.max(0, Math.min(b, to) - Math.max(a, from));

export function releases(from: number, to: number, goals: Goal[], markersOnly = false): ReleasesResponse {
  const now = Date.now();
  const markers: ReleaseMarker[] = [
    ...WEB.map((w) => ({ kind: 'web' as const, service: '', version: w.v, firstSeen: new Date(now - w.ago).toISOString() })),
    ...SVC.map((s) => ({ kind: 'service' as const, service: s.s, version: s.v, firstSeen: new Date(now - s.ago).toISOString() })),
  ].filter((m) => Date.parse(m.firstSeen) >= from && Date.parse(m.firstSeen) < to).sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen));
  if (markersOnly) return { web: [], services: [], markers };

  const sessions = totalsFor(from, to).sessions;
  const span = Math.max(1, to - from);
  const web: ReleaseHealth[] = [];
  WEB.forEach((w, i) => {
    const start = now - w.ago, end = i + 1 < WEB.length ? now - WEB[i + 1].ago : now;
    const share = overlap(start, end, from, to) / span;
    if (share <= 0) return;
    const n = Math.max(1, Math.round(sessions * share));
    const prev = i > 0 && overlap(now - WEB[i - 1].ago, start, from, to) > 0 ? WEB[i - 1] : null;
    const errSessions = Math.round(n * w.err), errors = Math.round(errSessions * 2.4);
    const worse = (a: number, b: number) => (a > b * 1.4 ? 'worse' : a < b / 1.4 ? 'better' : null);
    web.push({
      version: w.v, firstSeen: new Date(start).toISOString(), lastSeen: new Date(i + 1 < WEB.length ? end : now).toISOString(),
      sessions: n, errorSessions: errSessions, failedRequestSessions: Math.round(n * w.fail), errors,
      vitals: { samples: Math.round(n * 0.8), lcp: w.lcp, inp: w.inp, cls: w.cls },
      goals: goals.map((g, k) => { const rate = w.conv * (1 + k * 0.6); return { id: g.id, name: g.name, converted: Math.round(n * rate), rate }; }),
      newErrors: start >= from ? (NEW_ERRORS[w.v] ?? []).map((e) => ({ fingerprint: e.fingerprint, message: e.message, count: Math.max(1, Math.round(errors * e.share)) })) : [],
      previous: prev?.v ?? null,
      verdicts: prev ? {
        errorSessions: worse(w.err, prev.err), failedRequestSessions: worse(w.fail, prev.fail),
        lcp: w.lcp > prev.lcp * 1.1 ? 'worse' : w.lcp < prev.lcp / 1.1 ? 'better' : null,
        inp: w.inp > prev.inp * 1.1 ? 'worse' : w.inp < prev.inp / 1.1 ? 'better' : null, cls: null,
        ...Object.fromEntries(goals.map((g) => [`goal:${g.id}`, w.conv < prev.conv / 1.2 ? 'worse' : null])),
      } : {},
    });
  });
  const services: ServiceVersionHealth[] = [];
  for (const [i, v] of SVC.entries()) {
    const next = SVC.slice(i + 1).find((x) => x.s === v.s);
    const start = now - v.ago, end = next ? now - next.ago : now;
    const share = overlap(start, end, from, to) / span;
    if (share <= 0) continue;
    const spans = Math.round(sessions * share * 9);
    const before = SVC.slice(0, i).reverse().find((x) => x.s === v.s);
    const prev = before && overlap(now - before.ago, start, from, to) > 0 ? before : null;
    services.push({
      service: v.s, version: v.v, firstSeen: new Date(start).toISOString(), lastSeen: new Date(end).toISOString(), spans, errors: Math.round(spans * v.er),
      p50Ms: v.p50, p95Ms: v.p95, previous: prev?.v ?? null,
      verdicts: prev ? { errorRate: v.er > prev.er * 1.5 ? 'worse' : null, p95: v.p95 > prev.p95 * 1.1 ? 'worse' : v.p95 < prev.p95 / 1.1 ? 'better' : null } : {},
    });
  }
  const newest = (a: { firstSeen: string }, b: { firstSeen: string }) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen);
  return { web: web.sort(newest), services: services.sort((a, b) => a.service.localeCompare(b.service) || newest(a, b)), markers };
}
