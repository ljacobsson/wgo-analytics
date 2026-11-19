/**
 * A snapshot of the page as static HTML: what the recording shows under the simulated cursor. The dashboard
 * renders it in a sandboxed iframe with scripts disabled.
 *
 * Privacy rules, applied while walking the DOM so nothing sensitive is ever serialized:
 * - form values are never captured: text fields become one `•` per typed character, so you see that someone
 *   typed but not what; checkboxes, radios and selects keep their state,
 * - `[data-wgo-mask]` subtrees (and every text node when `maskText` is on) have their text replaced by `*`,
 * - `[data-wgo-block]` elements are kept as an empty, hatched box of the same size,
 * - scripts, inline event handlers, `javascript:` URLs, iframes' contents and <meta http-equiv> are dropped.
 *
 * Inline CSS (<style> elements, CSS-in-JS rules added through the CSSOM, adopted style sheets) is returned
 * separately, so a recorder can skip it when it hasn't changed since the previous snapshot. The HTML refers to
 * each sheet with an empty `<style data-wgo-c="N">` the player fills in.
 */
export interface Snapshot {
  html: string
  css: string[]
}

const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/
const SKIP = /^(script|noscript|template|object|embed|base)$/
const URL_ATTR = /^(src|href|action|poster|background|data|xlink:href|formaction)$/
const TEXTLIKE = /^(|text|search|email|url|tel|number|password|date|datetime-local|month|week|time)$/
const MASK = '[data-wgo-mask],[contenteditable=""],[contenteditable="true"]'
/** a page this big is cut off: the rest of the body isn't serialized */
const MAX_CHARS = 4_000_000

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
const maskText = (s: string) => s.replace(/\S/g, '*')

function abs(v: string, base: string): string {
  const t = v.trim()
  if (/^(data:|blob:|#|mailto:|tel:)/i.test(t)) return t.startsWith('blob:') ? '' : v
  try { return new URL(t, base).href } catch { return v }
}

function srcset(v: string, base: string): string {
  return v.split(',').map((part) => {
    const [u, ...rest] = part.trim().split(/\s+/)
    return [abs(u, base), ...rest].join(' ')
  }).join(', ')
}

function sheetText(sheet: CSSStyleSheet | null | undefined, fallback = ''): string {
  try {
    if (sheet?.cssRules) return Array.from(sheet.cssRules, (r) => r.cssText).join('\n')
  } catch { /* cross-origin */ }
  return fallback
}

export interface SerializeOpts {
  /** replace every text node's characters with `*` */
  maskText?: boolean
}

export function serialize(doc: Document, opts: SerializeOpts = {}): Snapshot {
  const out: string[] = []
  const css: string[] = []
  let size = 0
  const base = doc.baseURI
  const push = (s: string) => { out.push(s); size += s.length }

  /** `bare`: no URLs at all (blocked elements and frames must not load what they show) */
  const attrs = (el: Element, extra: Record<string, string> = {}, bare = false): string => {
    let s = ''
    const tag = el.localName
    for (const a of Array.from(el.attributes)) {
      const n = a.name
      let v = a.value
      if (/^on/i.test(n) || n === 'srcdoc' || n === 'nonce' || n === 'integrity' || n === 'autofocus' || n === 'autoplay') continue
      // the replay loads stylesheets and images from the dashboard's origin, where a CORS request to the site's own
      // assets usually fails (no Access-Control-Allow-Origin); a plain request works
      if (n === 'crossorigin') continue
      if (n === 'value' || n === 'checked' || n === 'selected') continue // the live state is written below
      if (n === 'srcset' || n === 'imagesrcset') {
        if (bare) continue
        v = srcset(v, base)
      } else if (URL_ATTR.test(n)) {
        if (bare || /^\s*javascript:/i.test(v)) continue
        v = abs(v, base)
      }
      if (n === 'loading' && tag === 'img') continue // load every image: the replay may scroll anywhere
      if (n in extra) continue
      s += ` ${n}="${escAttr(v)}"`
    }
    for (const [n, v] of Object.entries(extra)) s += ` ${n}="${escAttr(v)}"`
    return s
  }

  /** form state: never the value itself */
  const formState = (el: Element): Record<string, string> => {
    const x: Record<string, string> = {}
    if (el.localName === 'input') {
      const i = el as HTMLInputElement
      const type = i.type.toLowerCase()
      if (type === 'checkbox' || type === 'radio') { if (i.checked) x.checked = '' }
      else if (/^(button|submit|reset)$/.test(type)) x.value = i.value // a caption, not user input
      else if (TEXTLIKE.test(type) && i.value) x.value = '•'.repeat(Math.min(i.value.length, 64))
    } else if (el.localName === 'option') {
      if ((el as HTMLOptionElement).selected) x.selected = ''
    }
    return x
  }

  const blocked = (el: Element): string => {
    const r = el.getBoundingClientRect()
    const style = `${el.getAttribute('style') ?? ''};width:${Math.round(r.width)}px;height:${Math.round(r.height)}px;` +
      'background:repeating-linear-gradient(45deg,#8882 0 8px,#8881 8px 16px);'
    return attrs(el, { style }, true)
  }

  const children = (n: Node, masked: boolean) => {
    for (let c = n.firstChild; c; c = c.nextSibling) node(c, masked)
  }

  const shadow = (el: Element, masked: boolean) => {
    const root = el.shadowRoot
    if (!root || root.mode !== 'open') return
    push('<template shadowrootmode="open">')
    for (const s of (root as ShadowRoot & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? []) {
      push(`<style>${sheetText(s).replace(/<\/style/gi, '<\\/style')}</style>`)
    }
    children(root, masked)
    push('</template>')
  }

  function node(n: Node, masked: boolean): void {
    if (size > MAX_CHARS) return
    if (n.nodeType === 3) {
      const p = n.parentNode as Element | null
      const raw = n.nodeValue ?? ''
      // style text is collected separately
      if (p?.localName === 'style') return
      push(escText(masked || opts.maskText ? maskText(raw) : raw))
      return
    }
    if (n.nodeType !== 1) return
    const el = n as Element
    const tag = el.localName
    if (SKIP.test(tag)) return
    if (tag === 'meta' && el.hasAttribute('http-equiv')) return
    if (tag === 'link') {
      const rel = (el.getAttribute('rel') ?? '').toLowerCase()
      if (!/stylesheet|icon/.test(rel) || /\balternate\b/.test(rel)) return
    }
    if (tag === 'style') {
      css.push(sheetText((el as HTMLStyleElement).sheet, el.textContent ?? ''))
      push(`<style data-wgo-c="${css.length - 1}"${el.hasAttribute('media') ? ` media="${escAttr(el.getAttribute('media')!)}"` : ''}></style>`)
      return
    }
    if (el.matches('[data-wgo-block]')) {
      push(`<${tag}${blocked(el)}></${tag}>`)
      return
    }
    const m = masked || el.matches(MASK)
    if (tag === 'iframe' || tag === 'frame') {
      // another document: shown as an empty box (same tag, so recorded selectors still match)
      push(`<${tag}${blocked(el)}></${tag}>`)
      return
    }
    const extra = formState(el)
    if (el.scrollTop || el.scrollLeft) extra['data-wgo-sc'] = `${Math.round(el.scrollLeft)},${Math.round(el.scrollTop)}`
    push(`<${tag}${attrs(el, extra)}>`)
    if (VOID.test(tag)) return
    if (tag === 'textarea') {
      const v = (el as HTMLTextAreaElement).value
      push(v ? '•'.repeat(Math.min(v.length, 500)) : '')
    } else if (tag === 'head') {
      push(`<base href="${escAttr(base)}">`)
      children(el, m)
    } else {
      shadow(el, m)
      children(el, m)
    }
    push(`</${tag}>`)
  }

  push('<!DOCTYPE html>')
  node(doc.documentElement, false)
  const adopted = (doc as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? []
  if (adopted.length) {
    // adopted sheets apply after the document's own: appended to the end of <head>
    const tags = adopted.map((s) => { css.push(sheetText(s)); return `<style data-wgo-c="${css.length - 1}"></style>` }).join('')
    const i = out.indexOf('</head>')
    if (i >= 0) out[i] = tags + out[i]
  }
  return { html: out.join(''), css }
}
