/** Deterministic pseudo-random helpers: the same input always gives the same output. */
export function hash(...n: number[]): number {
  let h = 2166136261 >>> 0;
  for (const x of n) {
    h ^= (x | 0) + 0x9e3779b9 + ((h << 6) >>> 0) + (h >>> 2);
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
  }
  return h >>> 0;
}
export const rnd = (...n: number[]) => hash(...n) / 4294967296;
export function pick<T>(arr: readonly T[], ...seed: number[]): T { return arr[Math.floor(rnd(...seed) * arr.length)]; }
export function weighted<T extends { w: number }>(arr: readonly T[], ...seed: number[]): T {
  const total = arr.reduce((a, b) => a + b.w, 0);
  let r = rnd(...seed) * total;
  for (const a of arr) { r -= a.w; if (r <= 0) return a; }
  return arr[arr.length - 1];
}
export function hex(len: number, ...seed: number[]): string {
  let out = '';
  for (let i = 0; out.length < len; i++) out += hash(...seed, i).toString(16).padStart(8, '0');
  return out.slice(0, len);
}
/** A deterministic UUID v4 lookalike, the shape of the SDK's anonymous ids (crypto.randomUUID). */
export function uuidOf(...seed: number[]): string {
  const h = hex(32, ...seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Events per second at a given time: diurnal + weekly curve. */
export function rate(tMs: number): number {
  const d = new Date(tMs);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const diurnal = 0.55 + 0.45 * Math.sin(((h - 7) / 24) * Math.PI * 2);
  const wk = [0.7, 1, 1.05, 1.05, 1, 0.95, 0.65][d.getUTCDay()];
  return 0.22 * diurnal * wk + 0.03;
}
