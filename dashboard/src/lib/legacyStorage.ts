/**
 * One-time move of dashboard settings stored under the pre-release name (sign-in, theme, live watches,
 * preferences) to `wgo.*`, so nobody is signed out or loses their watches. Imported first in main.tsx,
 * before modules that read storage at load time. Safe to delete once old installs have upgraded.
 */
const OLD = '.setti.';

try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(OLD)) continue;
    const next = 'wgo.' + key.slice(OLD.length);
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key)!);
    localStorage.removeItem(key);
  }
} catch {
  /* storage unavailable: nothing to migrate */
}

export {};
