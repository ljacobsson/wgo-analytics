const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null
export const byteLen = (s: string): number => (enc ? enc.encode(s).length : s.length)

export function uuid(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const b = new Uint8Array(16)
  if (c && c.getRandomValues) c.getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = Math.random() * 256
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** True when `u` matches a string (substring) or RegExp of `list`. */
export const matchesAny = (list: (string | RegExp)[], u: string): boolean =>
  list.some((p) => (typeof p === 'string' ? u.includes(p) : (p.lastIndex = 0, p.test(u))))

/** localStorage that never throws (Safari private mode, quota, disabled storage). */
export const ls = {
  get(k: string): string | null {
    try { return localStorage.getItem(k) } catch { return null }
  },
  set(k: string, v: string): boolean {
    try { localStorage.setItem(k, v); return true } catch { return false }
  },
  del(k: string): void {
    try { localStorage.removeItem(k) } catch { /* ignore */ }
  },
}

export type Store = typeof ls

/** Same interface as `ls`, but lives and dies with the page: nothing touches the device. */
export function memoryStore(): Store {
  const m = new Map<string, string>()
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => { m.set(k, v); return true },
    del: (k) => { m.delete(k) },
  }
}

/** addEventListener whose handler can never throw into the host page. Returns the remover. */
export function on(t: EventTarget, type: string, fn: (e: any) => void, capture = false): () => void {
  const w = (e: Event) => { try { fn(e) } catch { /* never throw into the host */ } }
  t.addEventListener(type, w, capture)
  return () => t.removeEventListener(type, w, capture)
}

export const absUrl = (u: string): string => {
  try { return new URL(u, location.href).href } catch { return u }
}
