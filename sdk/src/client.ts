import type { Config, Ctx, EmitOpts, EventType, Hooks, ReplayConfig, ResolvedConfig, WireEvent } from './types'
import { SDK } from './types'
import { migrateStorage } from './legacy'
import { Session } from './session'
import { Transport } from './transport'
import { startClicks } from './capture/clicks'
import { ErrorReporter } from './capture/errors'
import { startHttp } from './capture/http'
import { startPageviews } from './capture/pageviews'
import { startVitals } from './capture/vitals'
import { bearer, findIdentity, jwtIdentity } from './identity'
import { ls, matchesAny, memoryStore, on, uuid } from './util'
import { unit } from './replay/sample'

function resolve(c: Config): ResolvedConfig {
  const a = c.autocapture || {}
  return {
    writeKey: c.writeKey,
    endpoint: c.endpoint.replace(/\/+$/, ''),
    autocapture: { clicks: a.clicks ?? true, errors: a.errors ?? true, http: a.http ?? true, pageviews: a.pageviews ?? true, vitals: a.vitals ?? true },
    flushInterval: c.flushInterval ?? 5000,
    priorityFlushDelay: c.priorityFlushDelay ?? 1000,
    maxBatchSize: c.maxBatchSize ?? 50,
    maxBatchBytes: c.maxBatchBytes ?? 60000,
    maxQueueSize: c.maxQueueSize ?? 1000,
    maxRetries: c.maxRetries ?? 6,
    cookieless: c.cookieless ?? false,
    persist: !c.cookieless && (c.persist ?? true),
    sessionTimeout: c.sessionTimeout ?? 30 * 60 * 1000,
    sampleRate: c.sampleRate ?? 1,
    httpIgnore: c.httpIgnore ?? [],
    tracePropagation: c.tracePropagation ?? true,
    traceOrigins: c.traceOrigins ?? [],
    captureQueryParams: c.captureQueryParams ?? false,
    compress: c.compress ?? true,
    beforeSend: c.beforeSend,
    respectDoNotTrack: c.respectDoNotTrack ?? false,
    release: c.release,
    environment: c.environment,
    debug: c.debug ?? false,
    priorityClicks: c.priorityClicks ?? [],
    autoIdentify: c.autoIdentify ?? false,
    record: c.record ?? true,
    surveys: c.surveys ?? true,
  }
}

export class Client {
  /** @internal also read by the recorder (replay/index.ts) */
  cfg: ResolvedConfig
  /** @internal */
  session: Session
  private transport: Transport
  private errors: ErrorReporter
  /** @internal */
  ctx: Ctx
  private ingest: string
  private stops: (() => void)[] = []
  private stopped = false
  private lastAuth?: string
  private lastScan = 0
  /** @internal SDK events the recorder watches for triggers */
  subs: ((e: WireEvent) => void)[] = []
  /** @internal the project's recording settings, once this page may record */
  rc?: ReplayConfig
  /** @internal custom events of this page until wgo-surveys.js takes over (its event triggers look back at them) */
  ev?: WireEvent[]
  /** @internal the survey WGO.showSurvey() asked for while wgo-surveys.js was loading */
  want?: string
  private svLoading = false

  constructor(config: Config) {
    const cfg = (this.cfg = resolve(config))
    const log = (...a: unknown[]) => { if (cfg.debug) console.debug('[wgo]', ...a) }
    this.ingest = `${cfg.endpoint}/ingest`
    if (!cfg.cookieless) migrateStorage(cfg.writeKey)
    this.session = new Session(cfg.sessionTimeout, cfg.sampleRate, cfg.cookieless ? memoryStore() : ls)
    this.ctx = { sdk: SDK }
    try {
      Object.assign(this.ctx, { ua: navigator.userAgent, lang: navigator.language, sw: screen.width, sh: screen.height })
      this.ctx.tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (navigator.webdriver) this.ctx.wd = true // automated browser: the backend flags it as a bot
    } catch { /* partial ctx is fine */ }
    if (cfg.release) this.ctx.release = cfg.release
    if (cfg.environment) this.ctx.env = cfg.environment

    this.transport = new Transport({
      ...cfg,
      url: this.ingest,
      storageKey: `wgo:q:${cfg.writeKey}`,
      meta: () => ({ k: cfg.writeKey, a: this.session.aid, ctx: this.ctx }),
      log,
    })
    const hooks: Hooks = {
      cfg,
      emit: (t, d, o) => this.emit(t, d, o),
      queued: (e) => this.transport.has(e),
      skipUrl: (u) => u.startsWith(this.ingest) || u.startsWith(`${cfg.endpoint}/replay/`) || matchesAny(cfg.httpIgnore, u),
      clean: (u) => this.clean(u),
      traceparent: (u) => this.traceparent(u),
      log,
    }
    if (cfg.autoIdentify) hooks.onAuth = (v) => this.fromHeader(v)
    this.errors = new ErrorReporter(hooks)

    this.transport.restore()
    const ac = cfg.autocapture
    const start = (enabled: boolean, fn: () => () => void) => {
      if (!enabled) return
      try { this.stops.push(fn()) } catch (e) { log('capture failed to start', e) }
    }
    start(ac.clicks, () => startClicks(hooks))
    start(ac.errors, () => this.errors.listen())
    start(ac.http || cfg.autoIdentify || cfg.tracePropagation, () => startHttp(hooks, ac.http))
    if (cfg.autoIdentify) {
      this.scan()
      // another tab logged in or out
      this.stops.push(on(window, 'storage', () => { if (Date.now() - this.lastScan > 1000) this.scan() }))
    }
    start(ac.vitals, () => startVitals(hooks)) // before our hide listener below, see vitals.ts
    start(ac.pageviews, () => startPageviews(hooks))

    if (cfg.surveys) this.ev = []
    if (cfg.record || cfg.surveys) this.config()

    const hide = () => this.transport.flushBeacon()
    this.stops.push(
      on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') hide() }),
      on(window, 'pagehide', hide),
      on(window, 'online', () => this.transport.online()),
    )
  }

  /**
   * Session recording and surveys live in their own scripts (sdk/src/replay, sdk/src/surveys), loaded only when the
   * project's config (one request per page) asks for them. Recording: when the project records and this session may
   * be recorded: sampled in, or triggers are set (the recorder then waits for one to match). Surveys: when the
   * project has active ones.
   */
  private config(): void {
    const { endpoint: ep, writeKey: k } = this.cfg
    fetch(`${ep}/replay/config?k=${encodeURIComponent(k)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c: ReplayConfig | null) => {
        if (!c || this.stopped) return
        if (c.sv && this.cfg.surveys) this.surveys()
        else this.ev = undefined
        const s = this.session.touch()
        if (!this.cfg.record || !c.on || !s.sampled || !(c.trg?.length || unit(s.id) < (c.rate ?? 0))) return
        this.rc = c // the recorder picks up the rest from this client (`__wgo.client`, see replay/index.ts)
        this.load('wgo-replay.js')
      })
      .catch(() => { /* no recording, no surveys */ })
  }

  private load(file: string): void {
    const el = document.createElement('script')
    el.src = `${this.cfg.endpoint}/sdk/v1/${file}`
    el.async = true
    document.head.appendChild(el)
  }

  /** @internal loads wgo-surveys.js (once); with an id, opens that survey (WGO.showSurvey) */
  surveys(id?: string): void {
    if (this.stopped || !this.cfg.surveys) return
    const open = (globalThis as { __wgo?: { sv?: (id: string) => void } }).__wgo?.sv
    if (open) { if (id) open(id); return }
    if (id) this.want = id
    if (!this.svLoading) { this.svLoading = true; this.load('wgo-surveys.js') }
  }

  /**
   * W3C trace context ids for one of the page's requests: same-origin ones, and those matching `traceOrigins`. A
   * cross-origin header triggers a CORS preflight the API has to allow, so other origins are opt-in.
   */
  private traceparent(u: string): [string, string] | null {
    const c = this.cfg
    try { if (!c.tracePropagation || (new URL(u).origin !== location.origin && !matchesAny(c.traceOrigins, u))) return null } catch { return null }
    // random v4 uuids: never all zeros, as W3C requires
    return [uuid().replace(/-/g, ''), uuid().replace(/-/g, '').slice(16)]
  }

  /** @internal */
  clean(u: string): string {
    return this.cfg.captureQueryParams ? u : u.replace(/\?[^#]*/, '')
  }

  emit(t: EventType, d?: object, o: EmitOpts = {}): WireEvent | null {
    try {
      if (this.stopped) return null
      if (t === 'pageview') this.scan() // a login usually ends with a navigation: the pageview already carries u
      const s = this.session.touch()
      if (!s.sampled) return null
      let e: WireEvent = { id: uuid(), t, ts: Date.now(), s: s.id, url: this.clean(location.href), path: location.pathname }
      if (this.session.uid) e.u = this.session.uid
      if (document.title) e.title = document.title
      if (o.ref) e.ref = o.ref
      if (d) e.d = d as Record<string, unknown>
      if (this.cfg.beforeSend) {
        let r: WireEvent | null = e
        try { r = this.cfg.beforeSend(e) } catch { /* a throwing hook must not lose the event */ }
        if (!r) return null
        e = r
      }
      this.transport.push(e, o.priority || t === 'error' || t === 'http_error')
      this.subs.forEach((f) => { try { f(e) } catch { /* the recorder must not break tracking */ } })
      if (t === 'custom' && this.ev && this.ev.push(e) > 20) this.ev.shift()
      return e
    } catch (err) {
      if (this.cfg.debug) console.debug('[wgo] emit failed', err)
      return null
    }
  }

  track(name: string, props?: Record<string, unknown>): void { this.emit('custom', { name, props }) }
  identify(userId: string, traits?: Record<string, unknown>): void {
    this.setUser(userId, traits, true)
  }

  private setUser(id: string, traits: Record<string, unknown> | undefined, manual: boolean): void {
    this.session.identify(id, manual)
    this.emit('identify', { traits })
  }

  /** A user found in a token. A different user than before means someone else is using this browser. */
  private auto(id: string | undefined): void {
    if (!id || this.session.manual || id === this.session.uid) return
    if (this.session.uid) this.reset()
    this.setUser(id, { $source: 'jwt' }, false)
  }

  private scan(): void {
    if (!this.cfg.autoIdentify) return
    this.lastScan = Date.now()
    this.auto(findIdentity())
  }

  private fromHeader(v: string): void {
    const t = bearer(v)
    if (!t || t === this.lastAuth) return
    this.lastAuth = t
    // a stored token wins: an access token in the header often names the user only by an opaque `sub`
    this.auto(findIdentity() ?? jwtIdentity(t)?.[1])
  }

  /** Logout: send what's queued as the current visitor, then continue as a new anonymous one. */
  reset(): void {
    this.transport.flushBeacon()
    this.session.reset()
  }
  page(): void { this.emit('pageview', undefined, { ref: document.referrer ? this.clean(document.referrer) : undefined }) }
  captureException(error: unknown, extra?: object): void { try { this.errors.manual(error, extra) } catch { /* ignore */ } }
  setContext(obj: Record<string, unknown>): void { Object.assign(this.ctx, obj, { sdk: SDK }) }
  flush(): Promise<void> { return this.transport.flush() }
  get queued(): number { return this.transport.length }

  stop(): void {
    this.stopped = true
    this.subs = []
    const g = (globalThis as { __wgo?: { rs?: () => void; ss?: () => void } }).__wgo
    try { g?.rs?.() } catch { /* ignore */ }
    try { g?.ss?.() } catch { /* ignore */ }
    this.stops.forEach((s) => { try { s() } catch { /* ignore */ } })
    this.stops = []
    this.transport.destroy()
  }
}
