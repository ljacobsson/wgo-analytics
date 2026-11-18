import type { Batch, Ctx, WireEvent } from './types'
import { byteLen, ls } from './util'

export interface TransportOpts {
  url: string
  storageKey: string
  flushInterval: number
  priorityFlushDelay: number
  maxBatchSize: number
  maxBatchBytes: number
  maxQueueSize: number
  maxRetries: number
  persist: boolean
  compress: boolean
  /**
   * Send ordinary batches with `keepalive` (default true). Browsers cap all in-flight keepalive requests of a page
   * at 64 KB together: a second queue on the page (the session recorder) turns it off so it never crowds out events.
   */
  keepalive?: boolean
  meta: () => { k: string; a: string; ctx: Ctx }
  log: (...a: unknown[]) => void
}

interface Item { e: WireEvent; n: number }
type Result = 'ok' | 'retry' | 'drop'

const BEACON_LIMIT = 60000
const TEXT = 'text/plain;charset=UTF-8'

async function gzip(s: string): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip')
  const w = cs.writable.getWriter()
  w.write(new TextEncoder().encode(s)).catch(() => {})
  w.close().catch(() => {})
  const r = cs.readable.getReader()
  const chunks: Uint8Array[] = []
  let len = 0
  for (;;) {
    const { done, value } = await r.read()
    if (done) break
    chunks.push(value)
    len += value.length
  }
  const out = new Uint8Array(len)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

export class Transport {
  private q: Item[] = []
  private inflight: Item[] = []
  private bytes = 0
  private timer?: ReturnType<typeof setTimeout>
  private deadline = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private persistTimer?: ReturnType<typeof setTimeout>
  private blockedUntil = 0
  private attempt = 0
  private busy = false
  private running: Promise<void> = Promise.resolve()

  constructor(private o: TransportOpts) {}

  get length(): number { return this.q.length }
  has(e: WireEvent): boolean { return this.q.some((i) => i.e === e) }

  push(e: WireEvent, priority = false): void {
    const n = byteLen(JSON.stringify(e)) + 1
    if (n >= this.o.maxBatchBytes) { this.o.log('event too large, dropped', e.t); return }
    this.q.push({ e, n })
    this.bytes += n
    this.trim()
    this.persistSoon()
    if (this.q.length >= this.o.maxBatchSize || this.bytes >= this.o.maxBatchBytes * 0.8) this.schedule(0)
    else this.schedule(priority ? this.o.priorityFlushDelay : this.o.flushInterval)
  }

  /** Load events left over from a previous page/offline session and send them. */
  restore(): void {
    if (!this.o.persist) return
    const raw = ls.get(this.o.storageKey)
    if (!raw) return
    ls.del(this.o.storageKey) // we own them now; persistSoon() rewrites if they stay queued
    try {
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr)) return
      const old = arr
        .filter((e) => e && typeof e.id === 'string' && typeof e.t === 'string')
        .map((e: WireEvent) => ({ e, n: byteLen(JSON.stringify(e)) + 1 }))
      this.q.unshift(...old)
      this.bytes += old.reduce((a, i) => a + i.n, 0)
      this.trim()
      if (this.q.length) { this.persistSoon(); this.schedule(0) }
    } catch { /* corrupt, ignore */ }
  }

  /** Max-latency deadline: an earlier deadline is never pushed later. */
  private schedule(delay: number): void {
    const at = Date.now() + delay
    if (this.timer !== undefined && this.deadline <= at) return
    clearTimeout(this.timer)
    this.deadline = at
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.deadline = 0
      void this.flush()
    }, delay)
  }

  private offline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false
  }

  flush(): Promise<void> {
    if (this.busy) return this.running
    this.busy = true
    return (this.running = this.drain())
  }

  /** Called when connectivity returns: skip any pending backoff. */
  online(): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.blockedUntil = 0
    void this.flush()
  }

  private async drain(): Promise<void> {
    try {
      while (this.q.length && !this.offline() && Date.now() >= this.blockedUntil) {
        const items = this.take(this.o.maxBatchBytes)
        this.inflight = items
        const r = await this.send(items.map((i) => i.e))
        this.inflight = []
        if (r !== 'retry') { this.attempt = 0; this.persistSoon(); continue }
        if (this.offline()) { this.requeue(items); break } // not the server's fault: don't burn a retry
        if (++this.attempt > this.o.maxRetries) {
          this.o.log('giving up on batch after', this.o.maxRetries, 'retries')
          this.attempt = 0
          this.persistSoon()
          continue
        }
        this.requeue(items)
        const delay = Math.min(60000, 1000 * 2 ** (this.attempt - 1) * (1 + Math.random() * 0.2))
        this.blockedUntil = Date.now() + delay
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined
          this.blockedUntil = 0
          void this.flush()
        }, delay)
        break
      }
    } finally {
      this.busy = false
    }
  }

  private take(maxBytes: number): Item[] {
    const m = this.o.meta()
    let size = JSON.stringify({ ...m, sentAt: Date.now(), e: [] }).length
    const out: Item[] = []
    while (this.q.length && out.length < this.o.maxBatchSize) {
      const it = this.q[0]
      if (out.length && size + it.n > maxBytes) break
      this.q.shift()
      this.bytes -= it.n
      size += it.n
      out.push(it)
    }
    return out
  }

  private requeue(items: Item[]): void {
    this.q.unshift(...items)
    this.bytes += items.reduce((a, i) => a + i.n, 0)
    this.trim()
    this.persistSoon()
  }

  private trim(): void {
    while (this.q.length > this.o.maxQueueSize) this.bytes -= this.q.shift()!.n
  }

  private body(events: WireEvent[]): string {
    const b: Batch = { ...this.o.meta(), sentAt: Date.now(), e: events }
    return JSON.stringify(b)
  }

  private async send(events: WireEvent[]): Promise<Result> {
    const body = this.body(events)
    let data: string | Uint8Array = body
    let type = TEXT
    // gzip makes the request non-simple (preflight); only worth it for bigger payloads
    if (this.o.compress && body.length > 1024 && typeof CompressionStream !== 'undefined') {
      try { data = await gzip(body); type = 'application/octet-stream' } catch { /* send raw */ }
    }
    const size = typeof data === 'string' ? byteLen(data) : data.byteLength
    try {
      const res = await globalThis.fetch(this.o.url, {
        method: 'POST',
        body: data as BodyInit,
        headers: { 'Content-Type': type },
        keepalive: this.o.keepalive !== false && size < BEACON_LIMIT,
      })
      if (res.status >= 200 && res.status < 300) return 'ok'
      if (res.status === 429 || res.status >= 500) return 'retry'
      this.o.log('batch rejected with', res.status, '- dropped')
      return 'drop'
    } catch (err) {
      this.o.log('send failed', err)
      return 'retry'
    }
  }

  /** Page is going away: send everything now, uncompressed, in chunks under 60 KB. */
  flushBeacon(): void {
    if (this.offline() || Date.now() < this.blockedUntil) { this.persistNow(); return }
    while (this.q.length) {
      const body = this.body(this.take(Math.min(this.o.maxBatchBytes, BEACON_LIMIT)).map((i) => i.e))
      let sent = false
      try { sent = navigator.sendBeacon(this.o.url, new Blob([body], { type: 'text/plain' })) } catch { /* fall through */ }
      if (!sent) {
        try { globalThis.fetch(this.o.url, { method: 'POST', body, headers: { 'Content-Type': TEXT }, keepalive: true }).catch(() => {}) } catch { /* nothing left to try */ }
      }
    }
    clearTimeout(this.timer)
    this.timer = undefined
    this.deadline = 0
    this.persistNow()
  }

  private persistSoon(): void {
    if (!this.o.persist || this.persistTimer !== undefined) return
    this.persistTimer = setTimeout(() => { this.persistTimer = undefined; this.persistNow() }, 1000)
  }

  persistNow(): void {
    if (!this.o.persist) return
    clearTimeout(this.persistTimer)
    this.persistTimer = undefined
    const all = [...this.inflight, ...this.q].map((i) => i.e).slice(-this.o.maxQueueSize)
    if (all.length) ls.set(this.o.storageKey, JSON.stringify(all))
    else ls.del(this.o.storageKey)
  }

  destroy(): void {
    this.persistNow()
    clearTimeout(this.timer)
    clearTimeout(this.retryTimer)
    this.timer = this.retryTimer = undefined
  }
}
