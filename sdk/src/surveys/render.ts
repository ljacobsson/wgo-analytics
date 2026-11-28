import type { PublicSurvey, SurveyAnswer, SurveyQuestion } from '../types'

/**
 * Draws a survey into `host` (inside a shadow root, so the page's CSS can't reach it and ours can't leak out).
 * Plain DOM, no framework: it's also imported by the dashboard's survey editor for the live preview, so what the
 * editor shows is what visitors get. Every piece of survey text goes in through textContent, never innerHTML.
 */
export interface RenderOptions {
  /** popover: position: fixed in the page's corner (default); false keeps it inside `host` (the editor's preview) */
  fixed?: boolean
  /** start at this question (steps layout), for the editor */
  step?: number
  /** lay it out for a phone (and start collapsed with `collapse: 'mobile'`); default: the viewport is at most 640px wide */
  narrow?: boolean
  onSubmit(answers: Record<string, SurveyAnswer>): void
  /** the visitor closed it before answering */
  onDismiss(): void
  /** after the thank-you message (popover: a few seconds after submitting) */
  onDone?(): void
}

type Answers = Record<string, SurveyAnswer | undefined>

const CSS = `
:host{all:initial}
.w{--a:#4f46e5;--bg:#fff;--fg:#18181b;--mu:#71717a;--ln:#e4e4e7;--hv:#f4f4f5;--on:#fff;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);-webkit-font-smoothing:antialiased;text-align:left;box-sizing:border-box}
.w.dark{--bg:#18181b;--fg:#fafafa;--mu:#a1a1aa;--ln:#3f3f46;--hv:#27272a}
@media (prefers-color-scheme:dark){.w.auto{--bg:#18181b;--fg:#fafafa;--mu:#a1a1aa;--ln:#3f3f46;--hv:#27272a}}
.w *{box-sizing:border-box;font:inherit;color:inherit;margin:0}
.pop{position:fixed;bottom:20px;z-index:2147483000;width:min(360px,calc(100vw - 24px));animation:in .22s ease-out}
.pop.abs{position:absolute}.pop.r{right:20px}.pop.l{left:20px}
.pop.sm{bottom:max(12px,env(safe-area-inset-bottom))}.pop.sm.r{right:12px}.pop.sm.l{left:12px}.pop.sm.abs{width:calc(100% - 24px)}
@keyframes in{from{opacity:0;transform:translateY(8px)}}
.c{position:relative;background:var(--bg);border:1px solid var(--ln);border-radius:14px;padding:18px;box-shadow:0 12px 32px -8px rgba(0,0,0,.25),0 2px 6px rgba(0,0,0,.06)}
.pop:not(.abs) .c{max-height:calc(100vh - 32px);overflow-y:auto}
.c.ex{animation:in .18s ease-out}
.in .c{box-shadow:none}
.x{position:absolute;top:10px;right:10px;width:28px;height:28px;border:0;border-radius:8px;background:none;color:var(--mu);cursor:pointer;font-size:18px;line-height:1;display:grid;place-items:center}
.x:hover{background:var(--hv);color:var(--fg)}
.x2{right:40px}
.x2:after{content:"";width:7px;height:7px;border:solid currentColor;border-width:0 2px 2px 0;transform:translateY(-2px) rotate(45deg)}
.c.min{padding:0;border-radius:12px}
.min .x{top:50%;transform:translateY(-50%)}
.cb{display:flex;align-items:center;gap:12px;width:100%;padding:12px 48px 12px 16px;border:0;border-radius:12px;background:none;cursor:pointer;text-align:left}
.cb span{flex:1;min-width:0;font-weight:600;font-size:14px;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.cb i{flex:none;width:28px;height:28px;border-radius:8px;background:var(--a);display:grid;place-items:center}
.cb i:after{content:"";width:7px;height:7px;border:solid var(--on);border-width:2px 2px 0 0;transform:translateY(2px) rotate(-45deg)}
.q+.q{margin-top:22px}
.t{font-weight:600;font-size:15px}
.pop .top .t{padding-right:26px}
.mn .top .t{padding-right:58px}
.mn .bar{margin-right:58px}
.rq{color:var(--mu);font-weight:400}
.d{color:var(--mu);font-size:13px;margin-top:3px}
.b{margin-top:12px;display:grid;gap:6px}
.o{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border:1px solid var(--ln);border-radius:9px;background:var(--bg);cursor:pointer;text-align:left}
.o:hover{background:var(--hv)}
.o[aria-checked=true]{border-color:var(--a);box-shadow:inset 0 0 0 1px var(--a)}
.m{flex:none;width:16px;height:16px;border:1.5px solid var(--ln);border-radius:50%;display:grid;place-items:center}
.ck .m{border-radius:4px}
.o[aria-checked=true] .m{border-color:var(--a);background:var(--a)}
.o[aria-checked=true] .m:after{content:"";width:6px;height:6px;border-radius:50%;background:var(--on)}
.ck .o[aria-checked=true] .m:after{width:8px;height:4px;border-radius:0;background:none;border:solid var(--on);border-width:0 0 2px 2px;transform:translateY(-1px) rotate(-45deg)}
.yn{grid-template-columns:1fr 1fr}.yn .o{justify-content:center}
input,textarea{width:100%;padding:9px 11px;border:1px solid var(--ln);border-radius:9px;background:var(--bg);outline:none;resize:vertical}
input:focus,textarea:focus{border-color:var(--a);box-shadow:0 0 0 3px color-mix(in srgb,var(--a) 20%,transparent)}
textarea{min-height:84px}
.sc{display:flex;gap:4px}
.n{flex:1;min-width:0;height:36px;border:1px solid var(--ln);border-radius:8px;background:var(--bg);cursor:pointer;font-variant-numeric:tabular-nums}
.n:hover{background:var(--hv)}
.n[aria-checked=true]{background:var(--a);border-color:var(--a);color:var(--on)}
.st .n{border:0;background:none;font-size:26px;height:34px;color:var(--ln);flex:0 0 auto;padding:0 2px}
.st .n:hover,.st .n.on{background:none;color:var(--a)}
.lb{display:flex;justify-content:space-between;gap:12px;color:var(--mu);font-size:12px;margin-top:6px}
.f{display:flex;align-items:center;gap:8px;margin-top:16px}
.p{color:var(--mu);font-size:12px;margin-right:auto;font-variant-numeric:tabular-nums}
.btn{border:0;border-radius:9px;padding:8px 16px;font-weight:600;background:var(--a);color:var(--on);cursor:pointer}
.btn:disabled{opacity:.45;cursor:default}
.bk{background:none;color:var(--mu);font-weight:500;padding:8px 10px}
.bk:hover{color:var(--fg)}
.bar{height:3px;border-radius:3px;background:var(--hv);margin:-4px 26px 14px 0;overflow:hidden}
.bar i{display:block;height:100%;background:var(--a);transition:width .2s}
.ty{padding:6px 26px 4px 0;font-weight:600;font-size:15px}
.in .ty{padding-right:0}
button:focus-visible,.o:focus-visible{outline:2px solid var(--a);outline-offset:2px}
`

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

const answered = (v: SurveyAnswer | undefined) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)

/** Draws the survey; returns a function that removes it. */
export function render(host: HTMLElement, s: PublicSurvey, o: RenderOptions): () => void {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  root.textContent = ''
  const style = el('style')
  style.textContent = CSS
  const d = s.display
  const pop = d.mode !== 'inline'
  const narrow = o.narrow ?? (typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches)
  const w = el('div', `w ${d.theme || 'auto'} ${pop ? `pop ${d.position === 'bottom-left' ? 'l' : 'r'}${o.fixed === false ? ' abs' : ''}${narrow ? ' sm' : ''}` : 'in'}`)
  if (d.accent) w.style.setProperty('--a', d.accent)
  const card = el('div', 'c')
  if (pop) { card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', s.name) }
  w.appendChild(card)
  root.append(style, w)

  const qs = s.questions
  const steps = d.layout !== 'form'
  const ans: Answers = {}
  let step = Math.min(Math.max(o.step ?? 0, 0), qs.length - 1)
  let done = false
  // a floating survey can shrink to a slim bar with just the question; it starts that way on phones (by default)
  const canCollapse = pop && d.collapse !== 'never'
  let collapsed = canCollapse && (d.collapse === 'always' || narrow)
  let timer: ReturnType<typeof setTimeout> | undefined

  const close = () => { o.onDismiss(); remove() }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && pop && !done) close() }
  if (pop) document.addEventListener('keydown', onKey)
  const remove = () => {
    clearTimeout(timer)
    document.removeEventListener('keydown', onKey)
    root.textContent = ''
  }

  const xButton = () => {
    const x = el('button', 'x', '×')
    x.type = 'button'
    x.setAttribute('aria-label', 'Close')
    x.onclick = () => (done ? (o.onDone?.(), remove()) : close())
    return x
  }

  /** one question's block; `changed` redraws what depends on its answer (the Next button) */
  const question = (q: SurveyQuestion, changed: () => void) => {
    const box = el('div', 'q')
    const t = el('div', 't', q.title)
    t.id = `wgo-${q.id}`
    if (!q.required && !(steps && qs.length === 1)) t.appendChild(el('span', 'rq', ' (optional)'))
    box.appendChild(t)
    if (q.description) box.appendChild(el('div', 'd', q.description))
    const body = el('div', 'b')
    body.setAttribute('aria-labelledby', t.id)
    box.appendChild(body)
    const set = (v: SurveyAnswer | undefined) => { ans[q.id] = v; draw(); changed() }

    const choice = (label: string, on: () => boolean, pick: () => void, multi = false) => {
      const b = el('button', 'o')
      b.type = 'button'
      b.setAttribute('role', multi ? 'checkbox' : 'radio')
      b.append(el('span', 'm'), el('span', '', label))
      b.onclick = pick
      return [b, on] as const
    }
    let items: (readonly [HTMLElement, () => boolean])[] = []
    const draw = () => {
      for (const [b, on] of items) b.setAttribute('aria-checked', String(on()))
      if (q.type === 'rating' && (q.scale ?? 5) === 5) {
        const v = Number(ans[q.id] ?? 0)
        items.forEach(([b], i) => b.classList.toggle('on', i < v))
      }
    }

    switch (q.type) {
      case 'single':
      case 'multi': {
        const multi = q.type === 'multi'
        body.setAttribute('role', multi ? 'group' : 'radiogroup')
        if (multi) body.classList.add('ck')
        items = (q.options ?? []).map((opt) => choice(opt,
          () => (multi ? ((ans[q.id] as string[] | undefined) ?? []).includes(opt) : ans[q.id] === opt),
          () => {
            if (!multi) return set(ans[q.id] === opt && !q.required ? undefined : opt)
            const cur = (ans[q.id] as string[] | undefined) ?? []
            const next = cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt]
            set(next.length ? (q.options ?? []).filter((x) => next.includes(x)) : undefined)
          }, multi))
        break
      }
      case 'yesno':
        body.setAttribute('role', 'radiogroup')
        body.classList.add('yn')
        items = ([['Yes', true], ['No', false]] as const).map(([label, v]) => choice(label, () => ans[q.id] === v, () => set(ans[q.id] === v && !q.required ? undefined : v)))
        break
      case 'text': {
        const f = q.long ? el('textarea') : el('input')
        f.setAttribute('aria-labelledby', t.id)
        if (q.placeholder) f.placeholder = q.placeholder
        f.maxLength = 2000
        f.value = String(ans[q.id] ?? '')
        f.oninput = () => { ans[q.id] = f.value.trim() ? f.value : undefined; changed() }
        if (!q.long) f.onkeydown = (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); (card.querySelector('.btn') as HTMLButtonElement | null)?.click() } }
        body.appendChild(f)
        break
      }
      case 'rating':
      case 'nps': {
        const [lo, hi] = q.type === 'nps' ? [0, 10] : [1, q.scale ?? 5]
        const stars = q.type === 'rating' && hi === 5
        const row = el('div', `sc${stars ? ' st' : ''}`)
        row.setAttribute('role', 'radiogroup')
        row.setAttribute('aria-labelledby', t.id)
        for (let v = lo; v <= hi; v++) {
          const b = el('button', 'n', stars ? '★' : String(v))
          b.type = 'button'
          b.setAttribute('role', 'radio')
          b.setAttribute('aria-label', String(v))
          b.onclick = () => set(ans[q.id] === v && !q.required ? undefined : v)
          row.appendChild(b)
          items.push([b, () => ans[q.id] === v] as const)
        }
        body.appendChild(row)
        if (q.lowLabel || q.highLabel) {
          const lb = el('div', 'lb')
          lb.append(el('span', '', q.lowLabel ?? ''), el('span', '', q.highLabel ?? ''))
          body.appendChild(lb)
        }
        break
      }
    }
    for (const [b] of items) if (b.classList.contains('o')) body.appendChild(b)
    draw()
    return box
  }

  const submit = () => {
    const out: Record<string, SurveyAnswer> = {}
    for (const q of qs) {
      const v = ans[q.id]
      if (answered(v)) out[q.id] = typeof v === 'string' ? v.trim() : v!
    }
    done = true
    o.onSubmit(out)
    card.textContent = ''
    card.classList.remove('mn')
    if (pop) card.appendChild(xButton())
    card.appendChild(el('div', 'ty', d.thankYou || 'Thanks for your feedback!'))
    if (pop) timer = setTimeout(() => { o.onDone?.(); remove() }, 3500)
    else o.onDone?.()
  }

  const footer = (ok: () => boolean, last: boolean, next: () => void, back?: () => void, progress?: string) => {
    const f = el('div', 'f')
    f.appendChild(el('span', 'p', progress ?? ''))
    if (back) {
      const b = el('button', 'btn bk', 'Back')
      b.type = 'button'
      b.onclick = back
      f.appendChild(b)
    }
    const n = el('button', 'btn', last ? d.submitLabel || 'Submit' : 'Next')
    n.type = 'button'
    n.onclick = () => { if (ok()) next() }
    f.appendChild(n)
    const sync = () => { n.disabled = !ok() }
    sync()
    return [f, sync] as const
  }

  const page = () => {
    card.textContent = ''
    card.classList.toggle('min', collapsed)
    card.classList.toggle('mn', canCollapse && !collapsed)
    if (collapsed) {
      const b = el('button', 'cb')
      b.type = 'button'
      b.setAttribute('aria-expanded', 'false')
      b.append(el('span', '', qs[steps ? step : 0].title), el('i'))
      b.onclick = (e) => {
        collapsed = false
        page()
        card.classList.add('ex')
        if (!e.detail) card.querySelector<HTMLElement>('.x2')?.focus() // opened with the keyboard: keep focus in the survey
      }
      card.append(b, xButton())
      return
    }
    if (pop) card.appendChild(xButton())
    if (canCollapse) {
      const m = el('button', 'x x2')
      m.type = 'button'
      m.setAttribute('aria-label', 'Minimize')
      m.onclick = () => { collapsed = true; card.classList.remove('ex'); page() }
      card.appendChild(m)
    }
    if (steps) {
      const q = qs[step]
      const last = step === qs.length - 1
      if (qs.length > 1) {
        const bar = el('div', 'bar')
        const fill = el('i')
        fill.style.width = `${((step + 1) / qs.length) * 100}%`
        bar.appendChild(fill)
        card.appendChild(bar)
      }
      let sync = () => {}
      card.appendChild(question(q, () => sync()))
      const [f, s2] = footer(() => !q.required || answered(ans[q.id]), last,
        () => { if (last) submit(); else { step++; page() } },
        step > 0 ? () => { step--; page() } : undefined,
        qs.length > 1 ? `${step + 1} of ${qs.length}` : '')
      sync = s2
      card.appendChild(f)
    } else {
      let sync = () => {}
      for (const q of qs) card.appendChild(question(q, () => sync()))
      const [f, s2] = footer(() => qs.every((q) => !q.required || answered(ans[q.id])), true, submit)
      sync = s2
      card.appendChild(f)
    }
    card.querySelector('.q')?.classList.add('top')
  }
  page()
  return remove
}
