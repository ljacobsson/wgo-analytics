import type { ReplayHost, ReplayTrigger, WireEvent } from '../types'
import { Transport } from '../transport'
import { selector } from '../selector'
import { ls, memoryStore, on, uuid } from '../util'
import { serialize } from './serialize'
import { unit } from './sample'

/**
 * Session recording, without video: snapshots of the page (serialize.ts) and a compact stream of what the visitor
 * does between them. Each record is a tuple `[kind, t, ...]`, `t` in ms after the chunk's `ts`:
 *
 *   [0, t, snapshot]          page snapshot {z: gzip+base64 of {html, css}, w, h, sx, sy, u: url, ti: title, ch}
 *   [1, t, x, y]              pointer moved (viewport coordinates)
 *   [2, t, x, y, touch?]      click or tap
 *   [3, t, x, y, selector?]   scroll position of the window, or of the element
 *   [4, t, w, h]              viewport resized
 *   [5, t, selector, kind, v] form field changed: kind 0 = text (v = length), 1 = checked (v = 0/1), 2 = select (v = index)
 *   [6, t, hidden]            tab hidden (1) or visible again (0)
 *
 * Chunks travel as `replay` events through their own queue to /ingest. A session is recorded only once the server
 * grants it a slot (POST /replay/start), which enforces the project's hourly and daily limits. Until then (and
 * while waiting for a trigger) the last minute is kept in memory, so a recording that a trigger starts shows what
 * led up to it.
 */
type Rec = unknown[]
/** `css`: hash of the inline CSS its snapshot carries, if it carries it */
interface Chunk { ts: number; r: Rec[]; snap: boolean; bytes: number; last: number; css?: string }

const FLUSH_MS = 5000
/**
 * A sampled session asks for its slot only after this long on the page: a visitor who bounces sooner sent nothing
 * and used none of the project's hourly and daily recordings. (The dashboard doesn't list shorter recordings.)
 */
export const MIN_SESSION_MS = 3000
/** a trigger's recording starts this long before it matched */
const BUFFER_MS = 60_000
const BUFFER_BYTES = 3_000_000
/** below the backend's MAX_CHUNK_CHARS (lib/recordings.ts), with room for the snapshot's metadata (it has a chunk of its own) */
const MAX_SNAPSHOT = 150_000
const MOVE_MS = 50
const SCROLL_MS = 100

function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36) + s.length.toString(36)
}

async function gzip64(s: string): Promise<string | null> {
  if (typeof CompressionStream === 'undefined') return null
  const buf = new Uint8Array(await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000) as unknown as number[])
  return btoa(bin)
}

const glob = (pattern: string) => new RegExp('^' + pattern.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')

/** A trigger that an SDK event (pageview, custom event, error) matches. */
export function eventTrigger(trg: ReplayTrigger[], e: Pick<WireEvent, 't' | 'path' | 'd'>): ReplayTrigger | undefined {
  const d = (e.d ?? {}) as Record<string, unknown>
  return trg.find((g) => {
    const v = g.value?.trim() ?? ''
    if (g.type === 'page') return e.t === 'pageview' && !!v && glob(v).test(e.path)
    if (g.type === 'event') return e.t === 'custom' && d.name === v
    if (g.type === 'error') return (e.t === 'error' || e.t === 'http_error') && (!v || String(d.msg ?? d.url ?? '').includes(v))
    return false
  })
}

/** A click trigger the clicked element (or an ancestor) matches. */
export function clickTrigger(trg: ReplayTrigger[], el: Element): ReplayTrigger | undefined {
  return trg.find((g) => {
    if (g.type !== 'click' || !g.value?.trim()) return false
    try { return !!el.closest(g.value) } catch { return false }
  })
}

export function start(h: ReplayHost): () => void {
  const log = (...a: unknown[]) => { if (h.debug) console.debug('[wgo replay]', ...a) }
  const store = h.mem ? memoryStore() : { get: (k: string) => { try { return sessionStorage.getItem(k) } catch { return ls.get(k) } }, set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); return true } catch { return ls.set(k, v) } }, del: () => {} }
  const trg = h.c.trg ?? []
  const transport = new Transport({
    url: `${h.ep}/ingest`, storageKey: '', flushInterval: 3000, priorityFlushDelay: 1000, maxBatchSize: 20,
    maxBatchBytes: 200_000, maxQueueSize: 200, maxRetries: 4, persist: false, compress: true,
    // the page's keepalive quota (64 KB) is the event queue's: recording chunks must never make its sends fail
    keepalive: false,
    meta: () => ({ k: h.k, a: h.aid(), ctx: h.ctx }), log,
    sent: (events) => { for (const e of events) { const c = cssOf.get(e); if (c) acked.add(c) } },
  })
  const pageId = uuid()

  let sid = h.sid()
  let mode: 'buffer' | 'live' | 'off' = 'buffer'
  let asking = false
  let denied = 0
  let cur: Chunk | null = null
  let buf: Chunk[] = []
  let seq = 0
  let lastHash = ''
  /**
   * Hashes of inline CSS the server has accepted in a snapshot. Only those may be left out of later snapshots: the
   * player fills them in from the earlier one, so CSS that never arrived must be sent again.
   */
  const acked = new Set<string>()
  const cssOf = new WeakMap<WireEvent, string>()
  let lastSnap = 0
  let gap = 1000
  let snapTimer: ReturnType<typeof setTimeout> | undefined
  let stops: (() => void)[] = []

  const key = () => `wgo:rec:${sid}`

  const rec = (r: Rec, at = Date.now()) => {
    if (mode === 'off') return
    cur ??= { ts: at, r: [], snap: false, bytes: 0, last: 0 }
    const t = at - cur.ts
    r.splice(1, 0, t)
    cur.r.push(r)
    cur.last = Math.max(cur.last, t)
    if (r[0] === 0) { cur.snap = true; cur.bytes += JSON.stringify(r[2]).length } else cur.bytes += 16
    if (cur.r.length >= 400) flush()
  }

  const send = (c: Chunk) => {
    const ev = {
      id: uuid(), t: 'replay', ts: c.ts, s: sid, url: h.clean(location.href), path: location.pathname,
      d: { p: pageId, q: seq++, dur: c.last, r: c.r },
    } as unknown as WireEvent
    if (c.css) cssOf.set(ev, c.css)
    transport.push(ev, c.snap)
  }

  /** In buffer mode, keep from the newest snapshot older than BUFFER_MS on (a replay needs one to start from). */
  const trim = () => {
    const cut = Date.now() - BUFFER_MS
    let from = 0
    buf.forEach((c, i) => { if (c.snap && c.ts <= cut) from = i })
    let bytes = buf.reduce((a, c) => a + c.bytes, 0)
    if (bytes > BUFFER_BYTES) {
      const i = buf.map((c) => c.snap).lastIndexOf(true)
      if (i > from) from = i
      else { from = buf.length; void snap(true) } // too much since the only snapshot: start over from a new one
    }
    if (from) buf = buf.slice(from)
  }

  function flush(): void {
    const c = cur
    cur = null
    if (c?.r.length) {
      if (mode === 'live') send(c)
      else if (mode === 'buffer') { buf.push(c); trim() }
    }
  }

  const tick = () => {
    flush()
    if (mode !== 'off' && h.sid() !== sid) restart()
  }

  async function snap(force = false): Promise<void> {
    clearTimeout(snapTimer)
    snapTimer = undefined
    if (mode === 'off') return
    const at = Date.now()
    lastSnap = at
    let s
    try { s = serialize(document, { maskText: h.c.mask }) } catch (e) { log('snapshot failed', e); return }
    const ch = hash(s.css.join('\u0000'))
    const hh = hash(s.html) + ch
    if (hh === lastHash && !force) return
    lastHash = hh
    // in live mode CSS the server already has isn't sent again; buffered snapshots may be dropped, so they keep it
    const omit = mode === 'live' && acked.has(ch)
    const body = JSON.stringify({ html: s.html, css: omit ? null : s.css })
    const meta = { w: innerWidth, h: innerHeight, sx: Math.round(scrollX), sy: Math.round(scrollY), u: h.clean(location.href), ti: document.title, ch }
    let z: string | null = null
    try { z = await gzip64(body) } catch { /* sent as is */ }
    if ((mode as string) === 'off') return // stopped while compressing
    const size = z ? z.length : body.length
    if (size > MAX_SNAPSHOT) { rec([0, { ...meta, big: 1 }], at); log('page too large to record', size); return }
    // the snapshot gets a chunk of its own: the backend silently drops chunks over MAX_CHUNK_CHARS, and an accepted
    // request must mean the snapshot (and its CSS) was stored
    flush()
    rec([0, z ? { ...meta, z } : { ...meta, j: { html: s.html, css: omit ? null : s.css } }], at)
    if (cur && !omit) cur.css = ch
    flush()
  }

  /** after a click, typing or navigation the page usually changes: snapshot changes quickly again */
  const interacted = () => { gap = 1000 }

  const schedule = (delay?: number) => {
    if (snapTimer !== undefined || mode === 'off') return
    const d = delay ?? Math.max(300, lastSnap + gap - Date.now())
    snapTimer = setTimeout(() => {
      snapTimer = undefined
      // a page that keeps changing on its own (tickers, animations) is snapshotted less and less often
      gap = Math.min(gap * 2, 30_000)
      const run = () => void snap()
      const ric = (window as Window & { requestIdleCallback?: (f: () => void, o?: object) => number }).requestIdleCallback
      if (ric) ric(run, { timeout: 1000 }); else run()
    }, d)
  }

  async function ask(reason: string): Promise<void> {
    // after a "no" (the hourly or daily limit is reached) a trigger asks again at most once a minute
    if (asking || mode !== 'buffer' || Date.now() - denied < 60_000) return
    asking = true
    try {
      const res = await fetch(`${h.ep}/replay/start`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ k: h.k, s: sid, a: h.aid(), r: reason }),
      })
      const ok = res.ok && (await res.json())?.ok === true
      log(reason, ok ? 'granted' : 'denied')
      if (ok) live()
      else if (!trg.length) stop()
      else denied = Date.now() // sampled in, but the limit is reached: nothing left to wait for
    } catch (e) {
      log('slot request failed', e)
    } finally {
      asking = false
    }
  }

  /** A slot is ours: send what's buffered (the lead-up) and keep sending. */
  function live(): void {
    if (mode !== 'buffer') return
    store.set(key(), '1')
    flush()
    mode = 'live'
    buf.forEach(send)
    buf = []
    transport.flush()
  }

  const trigger = (g: ReplayTrigger | undefined) => {
    if (g && mode === 'buffer') void ask(`trigger:${g.type}${g.value ? ':' + g.value : ''}`.slice(0, 200))
  }

  function listen(): void {
    let moved = 0
    const scrolls = new Map<EventTarget, true>()
    let scrollTimer: ReturnType<typeof setTimeout> | undefined
    const sels = new WeakMap<Element, string>()
    const sel = (el: Element) => { let s = sels.get(el); if (!s) { s = selector(el); sels.set(el, s) } return s }
    const opts = { capture: true, passive: true } as unknown as boolean // `on` passes it through
    const xy = (e: { clientX: number; clientY: number }) => [Math.round(e.clientX), Math.round(e.clientY)]

    const mo = new MutationObserver(() => schedule())
    mo.observe(document, { childList: true, subtree: true, attributes: true, characterData: true })
    stops.push(
      () => mo.disconnect(),
      on(document, 'mousemove', (e: MouseEvent) => {
        const now = Date.now()
        if (now - moved < MOVE_MS) return
        moved = now
        rec([1, ...xy(e)])
      }, opts),
      on(document, 'click', (e: MouseEvent) => {
        rec([2, ...xy(e)])
        interacted()
        schedule()
        if (e.target instanceof Element) trigger(clickTrigger(trg, e.target))
      }, opts),
      on(document, 'touchstart', (e: TouchEvent) => { const t = e.touches[0]; if (t) rec([2, ...xy(t), 1]); interacted() }, opts),
      on(document, 'touchmove', (e: TouchEvent) => {
        const t = e.touches[0]
        const now = Date.now()
        if (!t || now - moved < MOVE_MS) return
        moved = now
        rec([1, ...xy(t)])
      }, opts),
      on(document, 'scroll', (e: Event) => {
        scrolls.set(e.target === document ? window : e.target!, true)
        scrollTimer ??= setTimeout(() => {
          scrollTimer = undefined
          for (const t of scrolls.keys()) {
            if (t === window) rec([3, Math.round(scrollX), Math.round(scrollY)])
            else if (t instanceof Element) rec([3, Math.round(t.scrollLeft), Math.round(t.scrollTop), sel(t)])
          }
          scrolls.clear()
        }, SCROLL_MS)
      }, opts),
      on(window, 'resize', () => rec([4, innerWidth, innerHeight])),
      on(document, 'input', (e: Event) => field(e.target)),
      on(document, 'change', (e: Event) => field(e.target)),
      on(document, 'visibilitychange', () => {
        rec([6, document.visibilityState === 'hidden' ? 1 : 0])
        if (document.visibilityState === 'hidden') hide()
      }),
      on(window, 'pagehide', () => hide()),
      h.on((e) => {
        if (e.t === 'pageview') { interacted(); schedule(300) }
        trigger(eventTrigger(trg, e))
      }),
      () => { clearTimeout(scrollTimer) },
    )
    const timer = setInterval(tick, FLUSH_MS)
    stops.push(() => clearInterval(timer))

    function field(t: EventTarget | null): void {
      if (!(t instanceof Element)) return
      interacted()
      schedule()
      if (t.closest('[data-wgo-block]')) return
      if (t instanceof HTMLInputElement && (t.type === 'checkbox' || t.type === 'radio')) rec([5, sel(t), 1, t.checked ? 1 : 0])
      else if (t instanceof HTMLSelectElement) rec([5, sel(t), 2, t.selectedIndex])
      else if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) rec([5, sel(t), 0, t.value.length])
    }
  }

  function hide(): void {
    flush()
    if (mode === 'live') transport.flushBeacon()
  }

  function stop(): void {
    if (mode === 'live') hide()
    mode = 'off'
    clearTimeout(snapTimer)
    stops.forEach((s) => { try { s() } catch { /* ignore */ } })
    stops = []
    buf = []
    cur = null
    transport.destroy()
  }

  /** the visitor's session timed out: the new one gets its own decision */
  function restart(): void {
    stop()
    const g = globalThis as { __wgo?: { rs?: () => void } }
    if (g.__wgo) g.__wgo.rs = start(h)
  }

  // automated browsers (crawlers, test runs) are flagged as bots by the backend: don't spend recordings on them
  if (navigator.webdriver) { log('automated browser: not recording'); return () => {} }
  // decide: already granted on an earlier page, sampled in (ask now), or wait for a trigger
  const granted = store.get(key()) === '1'
  const sampled = unit(sid) < (h.c.rate ?? 0)
  if (!granted && !sampled && !trg.length) return () => {}
  listen()
  rec([4, innerWidth, innerHeight])
  if (granted) live()
  void snap(true)
  if (!granted && sampled) {
    const t = setTimeout(() => void ask('sample'), MIN_SESSION_MS)
    stops.push(() => clearTimeout(t))
  } else if (!granted) trigger(eventTrigger(trg, { t: 'pageview', path: location.pathname }))
  log('recording', granted ? 'live' : sampled ? `sampled, asking for a slot in ${MIN_SESSION_MS / 1000} s` : 'buffered until a trigger matches')
  return stop
}
