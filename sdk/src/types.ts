export const SDK = 'wgo-js/0.1.0' as const

export type EventType = 'pageview' | 'click' | 'error' | 'http_error' | 'custom' | 'vitals' | 'identify'

export interface WireEvent {
  id: string
  t: EventType
  ts: number
  s: string
  u?: string
  url: string
  path: string
  title?: string
  ref?: string
  d?: Record<string, unknown>
}

export interface Ctx {
  sdk: typeof SDK
  ua?: string
  lang?: string
  sw?: number
  sh?: number
  tz?: string
  release?: string
  env?: string
  [k: string]: unknown
}

export interface Batch {
  k: string
  a: string
  sentAt: number
  ctx: Ctx
  e: WireEvent[]
}

export interface ClickData { sel: string; tag: string; text?: string; name?: string; href?: string; x: number; y: number; vw: number; vh: number; rage?: number; dead?: number }
export interface ErrorData { msg: string; stack?: string; src?: string; line?: number; col?: number; kind: 'error' | 'rejection' | 'resource' | 'manual'; count?: number; extra?: object }
/** `trace`/`span`: the W3C trace context the SDK sent with the request (see tracePropagation), linking it to the backend trace */
export interface HttpErrorData { method: string; url: string; status: number; statusText?: string; dur: number; kind: 'fetch' | 'xhr'; trace?: string; span?: string }
export interface VitalsData { ttfb?: number; fcp?: number; lcp?: number; cls?: number; inp?: number; load?: number }

export interface AutocaptureConfig { clicks?: boolean; errors?: boolean; http?: boolean; pageviews?: boolean; vitals?: boolean }

export interface Config {
  writeKey: string
  endpoint: string
  autocapture?: AutocaptureConfig
  flushInterval?: number
  priorityFlushDelay?: number
  maxBatchSize?: number
  maxBatchBytes?: number
  maxQueueSize?: number
  maxRetries?: number
  /** Keep ids, session and queue in memory only; nothing is stored on the device. Overrides `persist`. */
  cookieless?: boolean
  persist?: boolean
  sessionTimeout?: number
  sampleRate?: number
  httpIgnore?: (string | RegExp)[]
  /**
   * Send a W3C `traceparent` header with the page's own requests, so a failed request links to its backend trace.
   * Same-origin requests only, plus the origins in `traceOrigins`. Default true.
   */
  tracePropagation?: boolean
  /**
   * Other APIs that get the header too: strings (substring match, e.g. "https://api.example.com/") or RegExps of
   * URLs, like `httpIgnore`. Their CORS configuration must allow the `traceparent` request header.
   */
  traceOrigins?: (string | RegExp)[]
  captureQueryParams?: boolean
  compress?: boolean
  beforeSend?: (event: WireEvent) => WireEvent | null
  respectDoNotTrack?: boolean
  release?: string
  environment?: string
  debug?: boolean
  priorityClicks?: string[]
  /** Use the email (or username) in the app's JWT as the user id. Off by default: it's personal data. */
  autoIdentify?: boolean
  /**
   * Session recording follows the project's settings in the dashboard (off until a project owner turns it on).
   * `false` never records on this site, whatever the project says.
   */
  record?: boolean
}

/** What to record, from GET /replay/config (the project's recording settings). */
export interface ReplayTrigger { type: 'page' | 'click' | 'event' | 'error'; value?: string }
export interface ReplayConfig { on: boolean; rate?: number; trg?: ReplayTrigger[]; mask?: boolean }

/** @internal what the recorder (sdk/src/replay, its own script) needs from the main SDK */
export interface ReplayHost {
  c: ReplayConfig
  k: string
  ep: string
  debug: boolean
  /** cookieless: nothing may be stored on the device */
  mem: boolean
  ctx: Ctx
  /** the current session id (without marking activity), and the anonymous id */
  sid(): string
  aid(): string
  clean(url: string): string
  /** every event the SDK sends (pageviews, custom events, errors): triggers watch them */
  on(fn: (e: WireEvent) => void): () => void
}

export type ResolvedConfig = Required<Omit<Config, 'beforeSend' | 'release' | 'environment' | 'autocapture'>> &
  Pick<Config, 'beforeSend' | 'release' | 'environment'> & { autocapture: Required<AutocaptureConfig> }

/** @internal what capture modules may use from the client */
export interface EmitOpts { priority?: boolean; ref?: string }
export interface Hooks {
  cfg: ResolvedConfig
  emit(t: EventType, d?: object, o?: EmitOpts): WireEvent | null
  queued(e: WireEvent): boolean
  /** true for our own ingest URL and anything in httpIgnore (absolute URL expected) */
  skipUrl(absUrl: string): boolean
  clean(url: string): string
  log(...a: unknown[]): void
  /** [trace id, span id] for a request's traceparent header, or null (cross-origin, turned off) */
  traceparent(absUrl: string): [string, string] | null
  /** an outgoing request's Authorization header (only set with autoIdentify) */
  onAuth?(value: string): void
}
