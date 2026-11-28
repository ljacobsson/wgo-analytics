import type { Client } from '../client'
import type { PublicSurvey, SurveyAnswer, WireEvent } from '../types'
import { ls, memoryStore, on, uuid } from '../util'
import { matches } from './match'
import { render } from './render'

/**
 * Entry of wgo-surveys.js. The main SDK (same version, same directory) loads it when GET /replay/config says the
 * project has active surveys, or when WGO.showSurvey() is called (see Client.surveys in ../client.ts). It fetches the
 * definitions, decides which survey this page shows and when (targeting), draws it (./render.ts) and posts the answers.
 *
 * Targeting: a survey waits for a page whose path matches one of its globs (any page without globs), then for its
 * delay, scroll depth and an event matching its trigger filters (./match.ts), all that are set. Frequency is remembered per browser (in memory only with
 * `cookieless`). At most one floating survey is open at a time; inline ones render wherever their element exists.
 */

type G = { __wgo?: { client: Client | null; sv?: (id: string) => void; ss?: () => void } }
type Seen = Record<string, { d?: 1; x?: string }> // per survey: d = answered, x = closed in that session

export const glob = (p: string) => new RegExp('^' + p.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
export const pathMatches = (paths: string[], path: string) => !paths.length || paths.some((p) => glob(p).test(path))

/** Whether this browser may see the survey again (frequency). */
export function allowed(s: PublicSurvey, seen: Seen, sid: string): boolean {
  const f = seen[s.id]
  if (!f || s.targeting.frequency === 'always') return true
  if (s.targeting.frequency === 'once') return false
  return !f.d && f.x !== sid // until_answered: closed ones come back next session
}

const KEY = 'wgo:sv'

export function start(cl: Client): () => void {
  const g = globalThis as G
  const { endpoint: ep, writeKey: k, debug } = cl.cfg
  const log = (...a: unknown[]) => { if (debug) console.debug('[wgo surveys]', ...a) }
  const store = cl.cfg.cookieless ? memoryStore() : ls
  const read = (): Seen => { try { return JSON.parse(store.get(KEY) || '{}') || {} } catch { return {} } }
  const mark = (id: string, v: Seen[string]) => { const s = read(); s[id] = { ...s[id], ...v }; store.set(KEY, JSON.stringify(s)) }

  let list: PublicSurvey[] = []
  let stopped = false
  let popOpen = false
  /** surveys shown on the current page (by id), and what removes them */
  const open = new Map<string, () => void>()
  /** what to cancel when the page changes: timers, scroll listeners, observers */
  let pending: (() => void)[] = []
  /** the SDK's events on the current page (the newest 50), for event triggers */
  let seen: WireEvent[] = []
  /** surveys waiting for their delay, scroll depth or event on the current page, and their re-check */
  const armed = new Map<string, () => void>()
  /** surveys already shown on the current page (also `always` ones: once per page view) */
  const shownHere = new Set<string>()
  let lastPath = location.pathname
  /** bumped on every navigation, so late timers of the previous page do nothing */
  let page = 0

  const track = (name: string, s: PublicSurvey) => cl.track(name, { survey_id: s.id, survey_name: s.name })

  const post = (s: PublicSurvey, ans: Record<string, SurveyAnswer>) => {
    const body = JSON.stringify({ k, id: s.id, r: uuid(), a: cl.session.aid, s: cl.session.peek(), u: cl.session.uid, path: location.pathname, ans })
    // text/plain: no CORS preflight. keepalive: the visitor may navigate away right after submitting.
    const send = (n: number): void => {
      fetch(`${ep}/surveys/respond`, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } })
        .then((r) => { if (!r.ok && r.status >= 500 && n < 3) setTimeout(() => send(n + 1), 2000 * (n + 1)) })
        .catch(() => { if (n < 3) setTimeout(() => send(n + 1), 2000 * (n + 1)) })
    }
    send(0)
  }

  /** Draws a survey now. `force`: from WGO.showSurvey, wherever its targeting would show it. */
  const show = (s: PublicSurvey, force = false): boolean => {
    if (stopped || open.has(s.id)) return false
    const pop = s.display.mode !== 'inline'
    if (pop && popOpen) return false
    let host: HTMLElement
    if (pop) {
      host = document.createElement('div')
      host.setAttribute('data-wgo-survey', s.id)
      document.body.appendChild(host)
    } else {
      let target: Element | null = null
      try { target = document.querySelector(s.display.selector || '') } catch { log('invalid selector', s.display.selector) }
      if (!target) return false
      host = document.createElement('div')
      host.setAttribute('data-wgo-survey', s.id)
      target.appendChild(host)
    }
    log('showing', s.name, force ? '(from code)' : '')
    if (pop) popOpen = true
    shownHere.add(s.id)
    const finish = () => {
      open.delete(s.id)
      if (pop) { popOpen = false; host.remove(); setTimeout(evaluate, 0) }
    }
    const remove = render(host, s, {
      onSubmit: (ans) => { mark(s.id, { d: 1 }); post(s, ans); track('survey_sent', s) },
      onDismiss: () => { mark(s.id, { x: cl.session.peek() }); track('survey_dismissed', s); finish() },
      onDone: () => { if (pop) finish() },
    })
    open.set(s.id, () => { remove(); host.remove(); if (pop) popOpen = false })
    track('survey_shown', s)
    return true
  }

  /** Arms every survey this page may show: waits for its delay, scroll depth and event, then shows it. */
  const evaluate = () => {
    if (stopped) return
    const seen = read()
    const sid = cl.session.peek()
    for (const s of list) {
      if (shownHere.has(s.id) || armed.has(s.id) || !allowed(s, seen, sid) || !pathMatches(s.targeting.paths, location.pathname)) continue
      arm(s)
    }
  }

  const arm = (s: PublicSurvey) => {
    const t = s.targeting
    const gen = page
    let delayed = !t.delaySec
    let scrolled = !t.scrollPct
    let watching = false
    const fire = () => {
      if (gen !== page || watching || !delayed || !scrolled || (t.trigger?.length && !seen.some((e) => matches(t.trigger!, e)))) return
      if (show(s)) { armed.delete(s.id); return }
      // a floating survey is already open (it re-evaluates once closed), or the inline element isn't there yet
      if (s.display.mode === 'inline' && typeof MutationObserver !== 'undefined') {
        watching = true
        const mo = new MutationObserver(() => { if (show(s)) { mo.disconnect(); armed.delete(s.id) } })
        mo.observe(document.body, { childList: true, subtree: true })
        pending.push(() => mo.disconnect())
      } else armed.delete(s.id)
    }
    if (t.delaySec) {
      const tm = setTimeout(() => { delayed = true; fire() }, t.delaySec * 1000)
      pending.push(() => clearTimeout(tm))
    }
    if (t.scrollPct) {
      const check = () => {
        const h = document.documentElement.scrollHeight - innerHeight
        if (!scrolled && (h <= 0 || (scrollY / h) * 100 >= t.scrollPct!)) { scrolled = true; fire() }
      }
      pending.push(on(window, 'scroll', check))
      setTimeout(check, 0)
    }
    armed.set(s.id, fire)
    fire()
  }

  /** a new page (SPA navigation): pending surveys start over, floating ones that are open stay */
  const navigate = () => {
    if (location.pathname === lastPath) return
    lastPath = location.pathname
    page++
    pending.forEach((f) => f())
    pending = []
    armed.clear()
    shownHere.clear()
    seen = []
    for (const [id, rm] of open) {
      const s = list.find((x) => x.id === id)
      if (s?.display.mode === 'inline') { rm(); open.delete(id) } // its element likely went with the old page
    }
    evaluate()
  }

  const onEvent = (e: WireEvent) => {
    if (e.t === 'pageview') navigate()
    if (e.t === 'custom' && String((e.d as { name?: unknown } | undefined)?.name ?? '').startsWith('survey_')) return // our own
    if (seen.push(e) > 50) seen.shift()
    armed.forEach((f) => f())
  }
  cl.subs.push(onEvent)
  // events from before this script loaded (same page only)
  for (const e of cl.ev ?? []) if (e.path === location.pathname) onEvent(e)
  cl.ev = undefined
  const offPop = on(window, 'popstate', () => setTimeout(navigate, 0))

  const showById = (id: string) => {
    const s = list.find((x) => x.id === id)
    if (!s) return log('no active survey with id', id)
    if (!allowed(s, read(), cl.session.peek())) return log('already answered or closed', s.name)
    show(s, true)
  }
  let loaded = false
  const wanted: string[] = []
  g.__wgo!.sv = (id) => { if (loaded) showById(id); else wanted.push(id) }
  if (cl.want) { wanted.push(cl.want); cl.want = undefined }

  fetch(`${ep}/surveys/config?k=${encodeURIComponent(k)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((c: { s?: PublicSurvey[] } | null) => {
      if (stopped) return
      list = c?.s ?? []
      loaded = true
      log(list.length, 'active surveys')
      const go = () => { evaluate(); wanted.splice(0).forEach(showById) }
      if (document.body) go()
      else document.addEventListener('DOMContentLoaded', go, { once: true })
    })
    .catch(() => { /* no surveys */ })

  return () => {
    stopped = true
    pending.forEach((f) => f())
    open.forEach((rm) => rm())
    open.clear()
    offPop()
    cl.subs = cl.subs.filter((f) => f !== onEvent)
  }
}

const g = (globalThis as G).__wgo
const cl = g?.client
// unsampled sessions send nothing, so they get no surveys either
if (g && cl && !g.sv && cl.session.touch().sampled) {
  try {
    const stop = start(cl)
    g.ss = () => { g.ss = g.sv = undefined; stop() }
  } catch (e) {
    if (cl.cfg.debug) console.debug('[wgo surveys] failed to start', e)
  }
}
