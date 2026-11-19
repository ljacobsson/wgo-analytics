import type { Hooks, HttpErrorData } from '../types'
import { absUrl } from '../util'

interface Info { method: string; url: string; start: number; trace?: string; span?: string }

const TP = 'traceparent'
const tp = (i: Info, tc: [string, string]) => `00-${i.trace = tc[0]}-${i.span = tc[1]}-01`

/** A header's value in fetch headers: a Headers object, [name, value] pairs or a plain record. */
function headerOf(hd: unknown, name: string): unknown {
  if (!hd) return undefined
  if (typeof (hd as Headers).get === 'function') return (hd as Headers).get(name) ?? undefined
  if (Array.isArray(hd)) return hd.find((p) => String(p[0]).toLowerCase() === name)?.[1]
  for (const k in hd as Record<string, unknown>) if (k.toLowerCase() === name) return (hd as Record<string, unknown>)[k]
  return undefined
}

/**
 * Wraps fetch and XHR. `errors` reports failed requests (autocapture.http); `h.onAuth` sees the Authorization
 * header of outgoing requests (autoIdentify); `h.traceparent` adds W3C trace context to the page's own requests
 * (tracePropagation), and a failed request reports the trace it started. Each can run without the others.
 */
export function startHttp(h: Hooks, errors = true): () => void {
  let active = true
  const restores: (() => void)[] = []
  const auth = (v: unknown) => { try { if (active && v) h.onAuth?.(String(v)) } catch { /* ignore */ } }

  const report = (i: Info, status: number, statusText: string | undefined, kind: 'fetch' | 'xhr') => {
    if (!errors) return
    try {
      // undefined fields (no status text, no trace) are left out when the batch is serialized
      const d: HttpErrorData = { method: i.method, url: h.clean(i.url), status, statusText: statusText || undefined, dur: Date.now() - i.start, kind, trace: i.trace, span: i.span }
      h.emit('http_error', d, { priority: true })
    } catch { /* never throw into the host */ }
  }

  const g = globalThis as typeof globalThis & { fetch?: typeof fetch }
  const origFetch = g.fetch
  if (typeof origFetch === 'function') {
    const wrapped = function (this: unknown, ...args: Parameters<typeof fetch>) {
      let info: Info | undefined
      if (active) {
        try {
          const [input, init] = args
          const r = input as Partial<Request> & Partial<URL>
          if (h.onAuth) auth(headerOf(init?.headers, 'authorization') ?? headerOf(r.headers, 'authorization'))
          const url = absUrl(typeof input === 'string' ? input : r.url ?? r.href ?? String(input))
          if (!h.skipUrl(url)) {
            info = { url, start: Date.now(), method: String(init?.method || r.method || 'GET').toUpperCase() }
            // init.headers replaces a Request's own headers; the app's own traceparent wins; no-cors forbids the header
            const own = init?.headers !== undefined ? init.headers : r.headers
            if ((init?.mode ?? r.mode) !== 'no-cors' && headerOf(own, TP) === undefined) {
              const tc = h.traceparent(url)
              if (tc) {
                const hd = new Headers(own as HeadersInit | undefined)
                hd.set(TP, tp(info, tc))
                args[1] = { ...init, headers: hd }
              }
            }
          }
        } catch { /* describe failed: just pass through */ }
      }
      const p = origFetch.apply(this as typeof globalThis, args)
      if (info) {
        const i = info
        // derived promise only observes; the caller still gets the original promise and its rejection
        p.then(
          (res) => { if (res.status >= 400) report(i, res.status, res.statusText, 'fetch') },
          (err) => { if (!(err && err.name === 'AbortError') && !args[1]?.signal?.aborted) report(i, 0, undefined, 'fetch') },
        )
      }
      return p
    }
    g.fetch = wrapped as typeof fetch
    restores.push(() => { if (g.fetch === wrapped) g.fetch = origFetch })
  }

  const X = (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest
  if (X && X.prototype) {
    const proto = X.prototype
    const origOpen = proto.open
    const origSend = proto.send
    const origSet = proto.setRequestHeader
    const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>()
    const ownTrace = new WeakSet<XMLHttpRequest>() // the app set its own traceparent

    const open = function (this: XMLHttpRequest, method: string, url: string | URL) {
      try { meta.set(this, { method: String(method).toUpperCase(), url: absUrl(String(url)) }) } catch { /* ignore */ }
      return (origOpen as (...a: unknown[]) => void).apply(this, arguments as unknown as unknown[])
    }
    const send = function (this: XMLHttpRequest) {
      try {
        const m = active && meta.get(this)
        if (m && !h.skipUrl(m.url)) {
          const info: Info = { ...m, start: Date.now() }
          const tc = ownTrace.has(this) ? null : h.traceparent(m.url)
          if (tc) {
            try { origSet.call(this, TP, tp(info, tc)) } catch { /* not opened: send will throw for the app anyway */ }
          }
          let aborted = false
          const onAbort = () => { aborted = true }
          this.addEventListener('abort', onAbort)
          this.addEventListener('loadend', () => {
            this.removeEventListener('abort', onAbort)
            if (!aborted && (this.status >= 400 || this.status === 0)) report(info, this.status, this.statusText, 'xhr')
          }, { once: true })
        }
      } catch { /* ignore */ }
      return (origSend as (...a: unknown[]) => void).apply(this, arguments as unknown as unknown[])
    }
    const setHeader = function (this: XMLHttpRequest, name: string, value: string) {
      const n = String(name).toLowerCase()
      if (h.onAuth && n === 'authorization') auth(value)
      if (n === TP) ownTrace.add(this)
      return origSet.call(this, name, value)
    }
    proto.open = open as typeof proto.open
    proto.send = send as typeof proto.send
    proto.setRequestHeader = setHeader
    restores.push(() => {
      if (proto.open === open) proto.open = origOpen
      if (proto.send === send) proto.send = origSend
      if (proto.setRequestHeader === setHeader) proto.setRequestHeader = origSet
    })
  }

  return () => { active = false; restores.forEach((r) => r()) }
}
