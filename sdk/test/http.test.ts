import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as A from '../src/index'
import { NO_AUTO, cfg, eventsOf, mockFetch } from './helpers'

const on = { ...NO_AUTO, http: true }
const httpErrors = (f: ReturnType<typeof mockFetch>) => eventsOf(f).filter((e) => e.t === 'http_error')

beforeEach(() => { vi.useFakeTimers(); localStorage.clear() })
afterEach(() => { A.shutdown(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function appFetch(status: number | Error) {
  return mockFetch((url) => {
    if (url.endsWith('/ingest')) return { ok: true, status: 200 }
    if (status instanceof Error) throw status
    return { ok: status < 400, status, statusText: 'ST' }
  })
}

describe('fetch interceptor', () => {
  it.each([404, 500])('reports %i with method, query-stripped url, status and duration', async (status) => {
    const f = appFetch(status)
    A.init(cfg({ autocapture: on }))
    const res = await fetch('https://app.test/api/items?secret=1', { method: 'post' })
    expect(res.status).toBe(status)
    await vi.advanceTimersByTimeAsync(1000)
    const [e] = httpErrors(f)
    expect(e.d).toMatchObject({ method: 'POST', url: 'https://app.test/api/items', status, statusText: 'ST', kind: 'fetch' })
    expect(typeof e.d!.dur).toBe('number')
  })

  it('keeps query params when captureQueryParams is on', async () => {
    const f = appFetch(500)
    A.init(cfg({ autocapture: on, captureQueryParams: true }))
    await fetch('https://app.test/x?a=1')
    await A.flush()
    expect(httpErrors(f)[0].d!.url).toBe('https://app.test/x?a=1')
  })

  it('does not report 2xx/3xx', async () => {
    const f = appFetch(200)
    A.init(cfg({ autocapture: on }))
    await fetch('/ok')
    await A.flush()
    expect(httpErrors(f)).toHaveLength(0)
  })

  it('reports network failures as status 0 and still rejects with the original error', async () => {
    const boom = new TypeError('Failed to fetch')
    const f = appFetch(boom)
    A.init(cfg({ autocapture: on }))
    await expect(fetch('https://app.test/down')).rejects.toBe(boom)
    await A.flush()
    expect(httpErrors(f)[0].d).toMatchObject({ status: 0, kind: 'fetch', method: 'GET' })
  })

  it('ignores aborted requests but still rejects', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    const f = appFetch(abort)
    A.init(cfg({ autocapture: on }))
    await expect(fetch('https://app.test/slow')).rejects.toBe(abort)
    await A.flush()
    expect(httpErrors(f)).toHaveLength(0)
  })

  it('returns the original Response object untouched', async () => {
    const response = { ok: false, status: 500, statusText: 'x' }
    mockFetch((url) => (url.endsWith('/ingest') ? { ok: true, status: 200 } : response))
    A.init(cfg({ autocapture: on }))
    expect(await fetch('https://app.test/a')).toBe(response)
  })

  it('never reports its own ingest requests, even when they fail', async () => {
    const f = mockFetch(() => ({ ok: false, status: 400 }))
    A.init(cfg({ autocapture: on }))
    A.track('x')
    await A.flush()
    await vi.advanceTimersByTimeAsync(5000)
    expect(f).toHaveBeenCalledTimes(1) // the ingest call; no http_error generated and sent
    expect(httpErrors(f)).toHaveLength(0)
  })

  it('respects httpIgnore (string and RegExp)', async () => {
    const f = appFetch(500)
    A.init(cfg({ autocapture: on, httpIgnore: ['/health', /\/metrics\/\d+/g] }))
    await fetch('https://app.test/health')
    await fetch('https://app.test/metrics/42')
    await fetch('https://app.test/metrics/43') // global regex: lastIndex must not leak between calls
    await fetch('https://app.test/real')
    await A.flush()
    expect(httpErrors(f).map((e) => e.d!.url)).toEqual(['https://app.test/real'])
  })

  it('accepts Request and URL inputs', async () => {
    const f = appFetch(503)
    A.init(cfg({ autocapture: on }))
    await fetch(new URL('https://app.test/u'))
    await fetch(new Request('https://app.test/r', { method: 'PUT' }))
    await A.flush()
    expect(httpErrors(f).map((e) => [e.d!.method, e.d!.url])).toEqual([['GET', 'https://app.test/u'], ['PUT', 'https://app.test/r']])
  })

  it('restores window.fetch on shutdown', () => {
    appFetch(200)
    const orig = globalThis.fetch
    A.init(cfg({ autocapture: on }))
    expect(globalThis.fetch).not.toBe(orig)
    A.shutdown()
    expect(globalThis.fetch).toBe(orig)
  })
})

describe('xhr interceptor', () => {
  class FakeXHR extends EventTarget {
    status = 0
    statusText = ''
    static outcome: { status: number; statusText?: string } | 'abort' = { status: 200 }
    opened?: [string, string]
    thisSeen: unknown
    open(method: string, url: string) { this.opened = [method, url] }
    send() {
      this.thisSeen = this
      setTimeout(() => {
        if (FakeXHR.outcome === 'abort') this.abort()
        else {
          this.status = FakeXHR.outcome.status
          this.statusText = FakeXHR.outcome.statusText ?? ''
          this.dispatchEvent(new Event('loadend'))
        }
      }, 10)
    }
    abort() { this.dispatchEvent(new Event('abort')); this.dispatchEvent(new Event('loadend')) }
  }
  const run = async (url = 'https://app.test/x?q=1', method = 'post') => {
    const x = new XMLHttpRequest() as unknown as FakeXHR
    x.open(method, url)
    const ret = x.send()
    await vi.advanceTimersByTimeAsync(20)
    return { x, ret }
  }
  beforeEach(() => { vi.stubGlobal('XMLHttpRequest', FakeXHR); FakeXHR.outcome = { status: 200 } })

  it('reports 4xx/5xx with method and stripped url, and preserves this / return value', async () => {
    const f = appFetch(200)
    A.init(cfg({ autocapture: on }))
    FakeXHR.outcome = { status: 502, statusText: 'Bad Gateway' }
    const { x, ret } = await run()
    expect(x.opened).toEqual(['post', 'https://app.test/x?q=1']) // original open still received the raw args
    expect(x.thisSeen).toBe(x)
    expect(ret).toBeUndefined()
    await A.flush()
    expect(httpErrors(f)[0].d).toMatchObject({ method: 'POST', url: 'https://app.test/x', status: 502, statusText: 'Bad Gateway', kind: 'xhr' })
  })

  it('reports network failure (status 0) but not aborts or successes', async () => {
    const f = appFetch(200)
    A.init(cfg({ autocapture: on }))
    FakeXHR.outcome = { status: 0 }
    await run('https://app.test/down')
    FakeXHR.outcome = 'abort'
    await run('https://app.test/aborted')
    FakeXHR.outcome = { status: 204 }
    await run('https://app.test/fine')
    await A.flush()
    expect(httpErrors(f).map((e) => [e.d!.url, e.d!.status])).toEqual([['https://app.test/down', 0]])
  })

  it('ignores the ingest url and httpIgnore', async () => {
    const f = appFetch(200)
    A.init(cfg({ autocapture: on, httpIgnore: ['/skip'] }))
    FakeXHR.outcome = { status: 500 }
    await run('https://api.test/ingest')
    await run('https://app.test/skip/me')
    await A.flush()
    expect(httpErrors(f)).toHaveLength(0)
  })

  it('restores XHR.prototype on shutdown', () => {
    const open = FakeXHR.prototype.open, send = FakeXHR.prototype.send
    appFetch(200)
    A.init(cfg({ autocapture: on }))
    expect(FakeXHR.prototype.open).not.toBe(open)
    A.shutdown()
    expect(FakeXHR.prototype.open).toBe(open)
    expect(FakeXHR.prototype.send).toBe(send)
  })
})
