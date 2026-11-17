/**
 * Who is logged in, read from a JWT the app already holds (opt-in: `autoIdentify`). Tokens are decoded, never
 * verified: the result only labels analytics events, it grants nothing.
 */

/** Claims that name the user, best first: an email address, then username-like claims, then the opaque subject. */
const CLAIMS = ['email', 'preferred_username', 'upn', 'unique_name', 'username', 'cognito:username', 'sub']
const JWT = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*/g
const MAX_VALUE = 65536

/** [rank in CLAIMS, user id] of an unexpired token, or undefined. */
export function jwtIdentity(token: string): [number, string] | undefined {
  try {
    const b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b + '==='.slice((b.length + 3) % 4)), (c) => c.charCodeAt(0))))
    if (typeof p.exp === 'number' && p.exp * 1000 < Date.now()) return undefined
    for (let i = 0; i < CLAIMS.length; i++) {
      const v = p[CLAIMS[i]]
      if (typeof v === 'string' && v.trim()) return [i, v.trim().slice(0, 256)]
    }
  } catch { /* not a JWT after all */ }
  return undefined
}

/**
 * The best identity in any token kept in localStorage, sessionStorage or a readable cookie. Values may be a bare
 * token or JSON holding tokens (Amplify, Auth0, MSAL, Firebase), so the raw strings are searched.
 */
export function findIdentity(): string | undefined {
  let best: [number, string] | undefined
  const look = (s: string | null) => {
    if (!s || s.length > MAX_VALUE) return
    for (const m of s.match(JWT) || []) {
      const r = jwtIdentity(m)
      if (r && (!best || r[0] < best[0])) best = r
    }
  }
  for (const k of ['localStorage', 'sessionStorage'] as const) {
    try {
      const st = window[k]
      for (let i = 0; i < st.length; i++) look(st.getItem(st.key(i)!))
    } catch { /* storage disabled */ }
  }
  try { look(document.cookie) } catch { /* sandboxed */ }
  return best?.[1]
}

/**
 * The token in an `Authorization` value: `Bearer …`, or a bare JWT (API Gateway Cognito authorizers take the
 * id token as-is, so Amplify apps commonly send it without a scheme).
 */
export const bearer = (v: unknown): string | undefined => {
  const s = String(v).trim()
  return /^Bearer\s+(\S+)/i.exec(s)?.[1] ?? (/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*$/.test(s) ? s : undefined)
}
