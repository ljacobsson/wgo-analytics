import { ls, uuid, type Store } from './util'

interface Rec { id: string; last: number; smp: 0 | 1 }

export class Session {
  aid: string
  uid?: string
  /** the user id came from the app's identify(), not a token: tokens don't override it */
  manual: boolean
  private cur?: Rec
  private wrote = 0

  constructor(private timeout: number, private sampleRate: number, private store: Store = ls) {
    let a = store.get('wgo:aid')
    if (!a) { a = uuid(); store.set('wgo:aid', a) }
    this.aid = a
    this.uid = store.get('wgo:uid') || undefined
    this.manual = !!this.uid && store.get('wgo:um') === '1'
  }

  private read(): Rec | undefined {
    try {
      const r = JSON.parse(this.store.get('wgo:sid') || 'null')
      if (r && typeof r.id === 'string' && typeof r.last === 'number') return r
    } catch { /* corrupt */ }
    return undefined
  }

  /** Marks activity; rotates the session after `timeout` of inactivity. Sampling is decided once per session. */
  touch(): { id: string; sampled: boolean } {
    const now = Date.now()
    let r = this.read() || this.cur // storage first: other tabs share the session
    let fresh = false
    if (!r || now - r.last > this.timeout) {
      r = { id: uuid(), last: now, smp: this.sampleRate >= 1 || Math.random() < this.sampleRate ? 1 : 0 }
      fresh = true
    } else r.last = now
    this.cur = r
    if (fresh || now - this.wrote >= 1000) { this.wrote = now; this.store.set('wgo:sid', JSON.stringify(r)) }
    return { id: r.id, sampled: r.smp === 1 }
  }

  /** The current session's id without marking activity (a new one if it timed out). */
  peek(): string {
    const r = this.read() || this.cur
    return r && Date.now() - r.last <= this.timeout ? r.id : this.touch().id
  }

  identify(id: string, manual = true): void {
    this.uid = id
    this.store.set('wgo:uid', id)
    this.manual = manual
    if (manual) this.store.set('wgo:um', '1')
    else this.store.del('wgo:um')
  }

  /** Forget the user and start over as a new anonymous visitor with a new session (logout). */
  reset(): void {
    this.aid = uuid()
    this.store.set('wgo:aid', this.aid)
    this.uid = this.cur = undefined
    this.manual = false
    this.store.del('wgo:uid')
    this.store.del('wgo:um')
    this.store.del('wgo:sid')
  }
}
