/**
 * A session's place in [0, 1): it's recorded by sampling when this is below the project's rate. Derived from the
 * session id, so every page of a session (and the main SDK and the recorder) agree without storing anything.
 */
export function unit(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}
