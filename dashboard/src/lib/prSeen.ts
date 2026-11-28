import { useSyncExternalStore } from 'react';

/**
 * When someone last opened a project's Pull requests page, per browser: the menu counts pull requests the GitHub
 * Agent opened after it, and the page marks them as new.
 */
const KEY = (pid: string) => `wgo.prsSeen.${pid}`;
const EVENT = 'wgo-prs-seen';

export function lastSeen(pid: string): string | null {
  try { return localStorage.getItem(KEY(pid)); } catch { return null; }
}

export function markSeen(pid: string, at = new Date().toISOString()): void {
  try { localStorage.setItem(KEY(pid), at); } catch { /* private mode: nothing to remember */ }
  window.dispatchEvent(new Event(EVENT));
}

const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', cb); // other tabs
  return () => { window.removeEventListener(EVENT, cb); window.removeEventListener('storage', cb); };
};

export const useLastSeen = (pid: string) => useSyncExternalStore(subscribe, () => lastSeen(pid));

/** When the agent opened the pull request (the run finished then). */
export const openedAt = (r: { finishedAt: string | null; createdAt: string }) => r.finishedAt ?? r.createdAt;
