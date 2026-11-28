import { Client } from './client'
import type { Config } from './types'

export type { Config, AutocaptureConfig, Batch, Ctx, WireEvent, EventType, ClickData, ErrorData, HttpErrorData, VitalsData, PublicSurvey, SurveyQuestion, SurveyAnswer } from './types'

// Kept on the global object so several copies of the SDK on one page (script tag inserted twice,
// re-rendered by a framework, bundled + tag) share one client instead of each starting their own.
interface G { __wgo?: { client: Client | null; disabled: boolean; endpoint?: string } }
const state = () => ((globalThis as G).__wgo ??= { client: null, disabled: false })
const current = () => (typeof globalThis === 'undefined' ? null : state().client)

function dnt(): boolean {
  const n = navigator as Navigator & { msDoNotTrack?: string }
  const w = window as Window & { doNotTrack?: string }
  return [n.doNotTrack, w.doNotTrack, n.msDoNotTrack].some((v) => v === '1' || v === 'yes')
}

export function init(config: Config): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return // SSR
  const st = state()
  if (st.client || st.disabled) { if (config?.debug) console.debug('[wgo] already initialised; ignoring init()'); return }
  if (!config || !config.writeKey || !config.endpoint) { console.warn('[wgo] writeKey and endpoint are required'); return }
  try {
    if (config.respectDoNotTrack && dnt()) { st.disabled = true; console.info('[wgo] Do Not Track is on; not collecting'); return }
    st.client = new Client(config)
    st.endpoint = config.endpoint
    if (config.debug) console.debug('[wgo] initialised →', config.endpoint)
  } catch (e) {
    console.warn('[wgo] init failed', e)
  }
}

export function track(name: string, props?: Record<string, unknown>): void { current()?.track(name, props) }
export function identify(userId: string, traits?: Record<string, unknown>): void { current()?.identify(userId, traits) }
export function page(): void { current()?.page() }
export function captureException(error: unknown, extra?: object): void { current()?.captureException(error, extra) }
/** Call on logout: forgets the user and continues as a new anonymous visitor. */
export function reset(): void { current()?.reset() }
export function setContext(obj: Record<string, unknown>): void { current()?.setContext(obj) }
/** Opens an active survey by its id (from the dashboard), wherever its targeting would show it. */
export function showSurvey(id: string): void { current()?.surveys(id) }
export function flush(): Promise<void> { const c = current(); return c ? c.flush() : Promise.resolve() }
/** For debugging from the console: `WGO.status()` */
export function status(): { initialized: boolean; disabled: boolean; endpoint: string | null; queued: number } {
  const st = state()
  return { initialized: !!st.client, disabled: st.disabled, endpoint: st.endpoint ?? null, queued: st.client?.queued ?? 0 }
}
export function shutdown(): void {
  const st = state()
  st.client?.stop()
  st.client = null
  st.disabled = false
  st.endpoint = undefined
}
