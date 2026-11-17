import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as A from '../src/index'
import { findIdentity, jwtIdentity } from '../src/identity'
import type { Batch } from '../src/types'
import { NO_AUTO, batchOf, cfg, eventsOf, ingestCalls, mockFetch, setBeacon } from './helpers'

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const jwt = (p: object) => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(p))}.c2lnbmF0dXJl`
const future = () => Math.floor(Date.now() / 1000) + 3600

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  sessionStorage.clear()
  document.cookie.split(';').forEach((c) => { document.cookie = `${c.split('=')[0].trim()}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/` })
  history.replaceState(null, '', '/start')
})
afterEach(() => {
  A.shutdown()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setBeacon(undefined)
})

describe('jwtIdentity', () => {
  it('prefers the email, then username-like claims, then sub', () => {
    expect(jwtIdentity(jwt({ sub: 's1', username: 'bob', email: 'Bob@x.com' }))).toEqual([0, 'Bob@x.com'])
    expect(jwtIdentity(jwt({ sub: 's1', 'cognito:username': 'bob' }))).toEqual([5, 'bob'])
    expect(jwtIdentity(jwt({ sub: 's1' }))).toEqual([6, 's1'])
    expect(jwtIdentity(jwt({ sub: 's1', email: '  ' }))).toEqual([6, 's1'])
  })

  it('reads UTF-8 claims and payloads without padding', () => {
    expect(jwtIdentity(jwt({ preferred_username: 'jörg' }))?.[1]).toBe('jörg')
    expect(jwtIdentity(jwt({ email: 'a@b.c' }))?.[1]).toBe('a@b.c')
    expect(jwtIdentity(jwt({ email: 'ab@b.c' }))?.[1]).toBe('ab@b.c')
  })

  it('ignores expired, malformed and claimless tokens', () => {
    expect(jwtIdentity(jwt({ email: 'a@x.com', exp: Math.floor(Date.now() / 1000) - 10 }))).toBeUndefined()
    expect(jwtIdentity(jwt({ email: 'a@x.com', exp: future() }))?.[1]).toBe('a@x.com')
    expect(jwtIdentity('eyJhbGciOiJub25lIn0.eyJub3QganNvbg.x')).toBeUndefined()
    expect(jwtIdentity('not.a.token')).toBeUndefined()
    expect(jwtIdentity(jwt({ name: 'Bob', scope: 'read' }))).toBeUndefined()
  })

  it('truncates very long ids', () => {
    expect(jwtIdentity(jwt({ email: 'x'.repeat(400) }))?.[1]).toHaveLength(256)
  })
})

describe('findIdentity', () => {
  it('finds tokens in localStorage JSON, sessionStorage and cookies, preferring an email', () => {
    expect(findIdentity()).toBeUndefined()
    localStorage.setItem('auth', JSON.stringify({ accessToken: jwt({ sub: 'abc', username: 'abc' }) }))
    expect(findIdentity()).toBe('abc')
    sessionStorage.setItem('CognitoIdentityServiceProvider.c.u.idToken', jwt({ email: 'u@x.com', sub: 'abc' }))
    expect(findIdentity()).toBe('u@x.com')
    sessionStorage.clear()
    localStorage.clear()
    document.cookie = `id_token=${jwt({ upn: 'u@corp' })}; path=/`
    expect(findIdentity()).toBe('u@corp')
  })

  it('skips huge values', () => {
    localStorage.setItem('blob', 'x'.repeat(70000) + jwt({ email: 'u@x.com' }))
    expect(findIdentity()).toBeUndefined()
  })
})

const auto = (over = {}) => cfg({ autoIdentify: true, ...over })

describe('autoIdentify', () => {
  it('is off by default: no token is read', async () => {
    localStorage.setItem('t', jwt({ email: 'u@x.com' }))
    const f = mockFetch()
    A.init(cfg({ autocapture: { ...NO_AUTO, pageviews: true } }))
    await fetch('https://app.test/api', { headers: { Authorization: `Bearer ${jwt({ email: 'h@x.com' })}` } })
    A.track('x')
    await A.flush()
    expect(eventsOf(f).map((e) => [e.t, e.u])).toEqual([['pageview', undefined], ['custom', undefined]])
  })

  it('identifies from storage before the first pageview, once', async () => {
    localStorage.setItem('session', JSON.stringify({ idToken: jwt({ email: 'u@x.com', exp: future() }) }))
    const f = mockFetch()
    A.init(auto({ autocapture: { ...NO_AUTO, pageviews: true } }))
    A.page()
    await A.flush()
    const ev = eventsOf(f)
    expect(ev.map((e) => [e.t, e.u])).toEqual([['identify', 'u@x.com'], ['pageview', 'u@x.com'], ['pageview', 'u@x.com']])
    expect(ev[0].d).toEqual({ traits: { $source: 'jwt' } })
    expect(localStorage.getItem('wgo:uid')).toBe('u@x.com')
  })

  it('picks up a login on the next SPA navigation, keeping the anonymous id', async () => {
    const f = mockFetch()
    A.init(auto({ autocapture: { ...NO_AUTO, pageviews: true } }))
    A.track('before')
    localStorage.setItem('token', jwt({ email: 'u@x.com' }))
    history.pushState(null, '', '/home')
    await vi.advanceTimersByTimeAsync(0)
    await A.flush()
    const ev = eventsOf(f)
    expect(ev.map((e) => [e.t, e.u])).toEqual([
      ['pageview', undefined], ['custom', undefined], ['identify', 'u@x.com'], ['pageview', 'u@x.com'],
    ])
    expect(new Set(ingestCalls(f).map((c) => batchOf(c).a)).size).toBe(1)
  })

  it('reads Bearer tokens on fetch, even with http autocapture off', async () => {
    const f = mockFetch()
    A.init(auto())
    await fetch('https://app.test/api', { headers: { authorization: `Bearer ${jwt({ sub: 's-1', email: 'h@x.com' })}` } })
    await fetch(new Request('https://app.test/b', { headers: { Authorization: `Bearer ${jwt({ email: 'h@x.com' })}` } }))
    A.track('x')
    await A.flush()
    expect(eventsOf(f).map((e) => [e.t, e.u])).toEqual([['identify', 'h@x.com'], ['custom', 'h@x.com']])
  })

  it('reads Bearer tokens set on XHR', async () => {
    const f = mockFetch()
    A.init(auto())
    const x = new XMLHttpRequest()
    x.open('GET', 'https://app.test/api')
    x.setRequestHeader('Authorization', `Bearer ${jwt({ preferred_username: 'bob' })}`)
    A.track('x')
    await A.flush()
    expect(eventsOf(f).map((e) => e.u)).toEqual(['bob', 'bob'])
    A.shutdown()
    expect(XMLHttpRequest.prototype.setRequestHeader.name).not.toBe('setHeader')
  })

  it('reads a bare JWT header, catching a token refreshed in this tab after an expired one at load', async () => {
    const key = 'CognitoIdentityServiceProvider.c.u.idToken'
    localStorage.setItem(key, jwt({ email: 'h@x.com', exp: Math.floor(Date.now() / 1000) - 60 }))
    const f = mockFetch()
    A.init(auto())
    const fresh = jwt({ email: 'h@x.com' })
    localStorage.setItem(key, fresh) // same-tab write: no storage event
    await fetch('https://app.test/api', { headers: { Authorization: fresh } })
    await fetch('https://app.test/b', { headers: { Authorization: 'not-a-jwt' } })
    A.track('x')
    await A.flush()
    expect(eventsOf(f).map((e) => [e.t, e.u])).toEqual([['identify', 'h@x.com'], ['custom', 'h@x.com']])
  })

  it('prefers a stored token over an opaque header token', async () => {
    localStorage.setItem('id', jwt({ email: 'u@x.com' }))
    const f = mockFetch()
    A.init(auto())
    await fetch('https://app.test/api', { headers: [['Authorization', `Bearer ${jwt({ sub: 'opaque' })}`]] })
    A.track('x')
    await A.flush()
    expect(eventsOf(f).map((e) => e.u)).toEqual(['u@x.com', 'u@x.com'])
  })

  it('never overrides an id the app set with identify(), across page loads', async () => {
    const f = mockFetch()
    A.init(auto())
    A.identify('user_42')
    localStorage.setItem('t', jwt({ email: 'u@x.com' }))
    A.page()
    const aid = localStorage.getItem('wgo:aid')
    await A.flush()
    A.shutdown()
    A.init(auto({ autocapture: { ...NO_AUTO, pageviews: true } })) // next page load
    await A.flush()
    expect(eventsOf(f).map((e) => [e.t, e.u])).toEqual([['identify', 'user_42'], ['pageview', 'user_42'], ['pageview', 'user_42']])
    expect(localStorage.getItem('wgo:aid')).toBe(aid)
  })

  it('starts a new anonymous id when a different user logs in on this browser', async () => {
    const beacons: Batch[] = []
    setBeacon((_u, blob) => { void blob.text().then((t) => beacons.push(JSON.parse(t))); return true })
    localStorage.setItem('t', jwt({ email: 'a@x.com' }))
    const f = mockFetch()
    A.init(auto())
    const aid1 = localStorage.getItem('wgo:aid')
    A.track('as-a')
    localStorage.setItem('t', jwt({ email: 'b@x.com' }))
    A.page()
    await A.flush()
    await vi.runAllTimersAsync()
    // A's queued events went out with A's anonymous id before the switch
    expect(beacons.flatMap((b) => b.e.map((e) => [e.t, e.u, b.a]))).toEqual([['identify', 'a@x.com', aid1], ['custom', 'a@x.com', aid1]])
    const after = ingestCalls(f).map(batchOf)
    expect(after.flatMap((b) => b.e.map((e) => [e.t, e.u]))).toEqual([['identify', 'b@x.com'], ['pageview', 'b@x.com']])
    expect(after[0].a).not.toBe(aid1)
    expect(after[0].a).toBe(localStorage.getItem('wgo:aid'))
  })
})

describe('reset', () => {
  it('forgets the user and continues as a new anonymous visitor', async () => {
    setBeacon(() => true)
    const f = mockFetch()
    A.init(cfg())
    A.identify('user_1')
    const aid = localStorage.getItem('wgo:aid')
    A.reset()
    A.track('after')
    await A.flush()
    const [b] = ingestCalls(f).map(batchOf)
    expect(b.e.map((e) => [e.t, e.u])).toEqual([['custom', undefined]])
    expect(b.a).not.toBe(aid)
    expect(localStorage.getItem('wgo:uid')).toBeNull()
    expect(localStorage.getItem('wgo:um')).toBeNull()
  })

  it('is a no-op before init', () => {
    expect(() => A.reset()).not.toThrow()
  })
})
