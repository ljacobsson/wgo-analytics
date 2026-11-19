import type { ClickData, Hooks, WireEvent } from '../types'
import { on } from '../util'
import { selector } from '../selector'

/** what a click (or, in recordings, a hover) is reported on: the closest of these around the target, or the target */
export const TARGET =
  'a,button,[role=button],[role=link],[role=menuitem],[role=tab],input[type=button],input[type=submit],input[type=checkbox],input[type=radio],select,summary,label,[data-track],[data-wgo]'
const MASKED = '[contenteditable=""],[contenteditable="true"],[data-wgo-mask]'
const FIELD = 'input,textarea,select'
const SENSITIVE = /pass|pwd|secret|token|cvv|ssn/i
const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL|OPTION|SELECT)$/
const MAX = 80
// clicks that should visibly do something (new-tab, download, mailto and tel links legitimately change nothing on this page)
const ACTIVE = 'a:not([target=_blank],[download],[href^=mailto],[href^=tel]),button,[role=button],input[type=submit],input[type=button],input[type=image]'

const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim()
const cut = (s: string) => (s.length > MAX ? s.slice(0, MAX - 1).trimEnd() + '…' : s)

/**
 * Visible text split into lines at block elements (textContent glues "Spelare" and "900" together), from a
 * bounded walk so a click on a huge container stays cheap. Skips <script>, <style> and hidden subtrees.
 */
function lines(root: Element, budget = 300): string[] {
  const out: string[] = []
  let cur = ''
  const flush = () => { const t = clean(cur); if (t) out.push(t); cur = '' }
  const walk = (n: Node) => {
    if (--budget < 0 || out.length >= 3) return
    if (n.nodeType === 3) { cur += n.nodeValue; return }
    if (n.nodeType !== 1) return
    const el = n as Element
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG)$/i.test(el.tagName) || el.getAttribute('aria-hidden') === 'true' || (el as HTMLElement).hidden) return
    if (el.tagName === 'IMG') { const alt = clean(el.getAttribute('alt')); if (alt) cur += ' ' + alt + ' '; return }
    const block = BLOCK.test(el.tagName)
    if (block) flush()
    for (let c = el.firstChild; c; c = c.nextSibling) walk(c)
    if (block) flush()
  }
  walk(root)
  flush()
  return out
}

function textBy(ids: string | null, doc: Document): string {
  return clean((ids || '').split(/\s+/).map((id) => doc.getElementById(id)?.textContent || '').join(' '))
}

/**
 * A human label for the clicked element, in the order screen readers use: explicit labels, then the
 * element's own wording. Never what a user typed into a field.
 */
export function labelOf(el: Element): string | undefined {
  if (el.closest(MASKED)) return
  if (SENSITIVE.test([el.getAttribute('type'), el.getAttribute('name'), el.id, el.getAttribute('autocomplete')].join(' '))) return
  const aria = clean(el.getAttribute('aria-label')) || textBy(el.getAttribute('aria-labelledby'), el.ownerDocument)
  if (aria) return cut(aria)

  if (el.matches(FIELD)) {
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (/^(button|submit|reset)$/.test(type)) return cut(clean((el as HTMLInputElement).value)) || undefined // a caption, not user data
    const label = (el as HTMLInputElement).labels?.[0]
    const viaLabel = label ? lines(label)[0] : ''
    return cut(viaLabel || clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title')) || clean(el.getAttribute('name'))) || undefined
  }
  if (el.tagName === 'IMG') return cut(clean(el.getAttribute('alt')) || clean(el.getAttribute('title'))) || undefined

  // a card or big link: its heading says what it is
  const heading = el.querySelector('h1,h2,h3,h4,h5,h6,[role=heading]')
  const text = (heading && lines(heading)[0]) || lines(el)[0] || clean(el.getAttribute('title'))
  return text ? cut(text) : undefined
}

export function startClicks(h: Hooks): () => void {
  let streak: { el: Element; times: number[]; ev: WireEvent | null } | null = null
  let stop = () => {}

  /** Dead click: nothing in the page changed within 1 s of clicking something that should have. */
  const watch = (ev: WireEvent) => {
    stop()
    try {
      const href = location.href
      const mo = new MutationObserver(() => stop())
      const t = setTimeout(() => {
        stop()
        if (location.href === href && h.queued(ev) && ev.d) ev.d.dead = 1
      }, 1000)
      stop = () => { mo.disconnect(); clearTimeout(t); stop = () => {} }
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    } catch { /* never throw into the host page */ }
  }

  const off = on(document, 'click', (e: MouseEvent) => {
    const raw = e.target as Element | null
    if (!raw || raw.nodeType !== 1 || raw.closest('[data-wgo-ignore]')) return
    const el = raw.closest(TARGET) || raw
    const now = Date.now()

    if (streak && streak.el === el) {
      streak.times = streak.times.filter((t) => now - t <= 1000)
      streak.times.push(now)
    } else streak = { el, times: [now], ev: null }
    const rage = streak.times.length
    if (rage < 3) streak.ev = null
    else if (streak.ev) {
      // already reported this rage burst: only bump the count while it's still queued
      const d = h.queued(streak.ev) ? streak.ev.d : undefined
      if (d) d.rage = rage
      return
    }

    const named = el.closest('[data-track],[data-wgo]')
    const d: ClickData = {
      sel: selector(el),
      tag: el.tagName.toLowerCase(),
      x: Math.round(e.pageX ?? e.clientX + window.scrollX) || 0,
      y: Math.round(e.pageY ?? e.clientY + window.scrollY) || 0,
      vw: window.innerWidth,
      vh: window.innerHeight,
    }
    const text = labelOf(el)
    if (text) d.text = text
    const name = named && (named.getAttribute('data-track') || named.getAttribute('data-wgo'))
    if (name) d.name = name
    if (el.tagName === 'A') {
      const href = (el as HTMLAnchorElement).href
      if (href) d.href = h.clean(href)
    }
    if (rage >= 3) d.rage = rage

    const priority = h.cfg.priorityClicks.some((s) => {
      try { return !!raw.closest(s) } catch { return false }
    })
    const ev = h.emit('click', d, { priority })
    if (rage >= 3) streak.ev = ev
    if (ev && el.matches(ACTIVE)) watch(ev)
  }, true)
  return () => { stop(); off() }
}
