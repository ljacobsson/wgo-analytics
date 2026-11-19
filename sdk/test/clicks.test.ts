import { setTimeout as realSleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as A from '../src/index'
import { selector, stableClass, stableId } from '../src/selector'
import { labelOf } from '../src/capture/clicks'
import { NO_AUTO, cfg, eventsOf, mockFetch } from './helpers'

const on = { ...NO_AUTO, clicks: true }
let f: ReturnType<typeof mockFetch>

function html(s: string) {
  document.body.innerHTML = s
}
const q = (s: string) => document.querySelector(s) as HTMLElement
const click = (el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 20, ...init }))
const clicks = () => eventsOf(f).filter((e) => e.t === 'click')

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); f = mockFetch() })
afterEach(() => { A.shutdown(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('selector generation', () => {
  it('uses a stable #id and stops there', () => {
    html('<div><main><button id="save-btn" class="btn">Save</button></main></div>')
    expect(selector(q('button'))).toBe('#save-btn')
  })

  it('ignores unstable ids and walks up to a stable ancestor id when needed', () => {
    html('<section id="checkout"><div><button id="a8f3k29dj1x0q7z">Pay</button></div></section><div><button>Other</button></div>')
    expect(selector(q('#checkout button'))).toBe('#checkout > div > button')
    expect(stableId('12345678')).toBe(false)
    expect(stableId('item-98765')).toBe(false)
    expect(stableId(':r1:')).toBe(false)
    expect(stableId('550e8400-e29b-41d4-a716')).toBe(false)
    expect(stableId('main-nav')).toBe(true)
  })

  it('stops at the shortest selector that is unique on the page', () => {
    html('<div class="wrap"><div><div><button class="btn btn-primary">Go</button></div></div></div><button>Other</button>')
    expect(selector(q('.btn'))).toBe('button.btn.btn-primary')
  })

  it('skips generated and utility (Tailwind/Bootstrap) classes, keeps at most 2 meaningful ones', () => {
    html('<div><button class="css-1x2y3z sc-abcdef w-full py-6 md:flex btn btn-primary extra">Go</button></div><button>x</button>')
    expect(selector(q('.btn'))).toBe('button.btn.btn-primary')
    for (const c of ['css-1x2y3z', 'Button_root__3xK9d', 'a'.repeat(31), 'w-full', 'py-6', 'mt-2', 'text-2xl', 'grid-cols-1', 'flex-shrink-0', 'relative', 'mb-4',
      'overflow-visible', 'space-y-4', 'md:flex', 'w-[3px]', 'w-1/2', 'hover:bg-gray-100', 'bg-sky-900', 'rounded-xl', 'd-flex', 'justify-content-between'])
      expect(stableClass(c), c).toBe(false)
    for (const c of ['btn', 'btn-primary', 'home-search-card', 'player-row', 'card', 'nav-link']) expect(stableClass(c), c).toBe(true)
  })

  it('replaces a Tailwind div soup with a short path', () => {
    html(`<div class="w-full py-6"><div class="grid grid-cols-1"><div class="flex-shrink-0"><div class="relative mb-4">
      <input class="w-full rounded-lg" name="search" placeholder="Sök spelare"></div></div></div></div><input name="email">`)
    expect(selector(q('input'))).toBe('input[name="search"]')
  })

  it('prefers deliberate hooks: test ids, data-track, name, aria-label, role', () => {
    html('<nav><a data-track="nav-home" href="/">Home</a><a href="/x">X</a></nav><button data-testid="save">Save</button><button aria-label="Close dialog">×</button><button>b</button>')
    expect(selector(q('a'))).toBe('a[data-track="nav-home"]')
    expect(selector(q('[data-testid]'))).toBe('button[data-testid="save"]')
    expect(selector(q('[aria-label]'))).toBe('button[aria-label="Close dialog"]')
  })

  it('adds :nth-of-type only when siblings are ambiguous', () => {
    html('<ul><li><a>one</a></li><li><a>two</a></li><li class="last"><a>three</a></li></ul>')
    const as = document.querySelectorAll('a')
    expect(selector(as[1])).toBe('li:nth-of-type(2) > a')
    expect(selector(as[2])).toBe('li.last > a')
    html('<div><p>only</p><span>x</span></div>')
    expect(selector(q('p'))).toBe('p')
  })

  it('is at most 5 levels deep', () => {
    const nest = (inner: string) => '<div><div><div><div><div><div><div>' + inner + '</div></div></div></div></div></div></div>'
    html(nest('<button>x</button>') + nest('<button>y</button>'))
    expect(selector(q('button')).split(' > ')).toHaveLength(5)
  })
})

describe('click labels', () => {
  it('keeps block-level text apart and takes the first line, not the whole card', () => {
    html('<a href="/club" id="card"><h2>Ängby SK</h2><span>← Tillbaka till klubbranking</span><div><b>411</b>Spelare</div><div><b>900</b>Snittpoäng</div></a>')
    expect(labelOf(q('#card'))).toBe('Ängby SK')
    html('<a id="row"><div>Ungdomsträffen</div><div>24 oktober 2026</div></a>')
    expect(labelOf(q('#row'))).toBe('Ungdomsträffen')
  })

  it('uses accessible names: aria-label, aria-labelledby, alt, title', () => {
    html('<button id="a" aria-label="Close dialog">×</button><span id="lbl">Open menu</span><button id="b" aria-labelledby="lbl"><svg></svg></button><img id="c" alt="Club logo"><div id="d" title="Settings"></div>')
    expect(labelOf(q('#a'))).toBe('Close dialog')
    expect(labelOf(q('#b'))).toBe('Open menu')
    expect(labelOf(q('#c'))).toBe('Club logo')
    expect(labelOf(q('#d'))).toBe('Settings')
  })

  it('names form fields by their label or placeholder, never by what was typed', () => {
    html('<label for="f1">Search players</label><input id="f1" value="typed by user"><input id="f2" placeholder="Sök spelare" value="also typed"><input id="f3" type="submit" value="Send"><select id="f4" name="month"><option>jan</option><option>feb</option></select>')
    expect(labelOf(q('#f1'))).toBe('Search players')
    expect(labelOf(q('#f2'))).toBe('Sök spelare')
    expect(labelOf(q('#f3'))).toBe('Send')
    expect(labelOf(q('#f4'))).toBe('month')
  })

  it('truncates long text', () => {
    html('<button id="x">' + 'word '.repeat(40) + '</button>')
    expect(labelOf(q('#x'))!.length).toBeLessThanOrEqual(80)
    expect(labelOf(q('#x'))!.endsWith('…')).toBe(true)
  })
})

describe('click capture', () => {
  it('captures a click with selector, tag, text, name, href, coordinates and viewport', async () => {
    html('<a id="cta" data-track="hero-cta" href="/pricing?plan=pro#x">  Buy   <b>now</b> </a>')
    A.init(cfg({ autocapture: on }))
    click(q('b'), { clientX: 15, clientY: 25 })
    await A.flush()
    expect(clicks()[0].d).toMatchObject({
      sel: '#cta', tag: 'a', text: 'Buy now', name: 'hero-cta', href: 'http://localhost:3000/pricing#x',
      vw: window.innerWidth, vh: window.innerHeight,
    })
    expect(typeof clicks()[0].d!.x).toBe('number')
  })

  it('keeps href query with captureQueryParams; truncates text to 80 chars', async () => {
    html(`<a href="/p?x=1">${'word '.repeat(40)}</a>`)
    A.init(cfg({ autocapture: on, captureQueryParams: true }))
    click(q('a'))
    await A.flush()
    expect(clicks()[0].d!.href).toContain('?x=1')
    expect((clicks()[0].d!.text as string).length).toBeLessThanOrEqual(80)
  })

  it('never captures input values or text of inputs/selects/textareas/contenteditable/password-ish/masked elements', async () => {
    html(`
      <input id="i1" type="text" value="secret-value">
      <textarea id="i2">typed secret</textarea>
      <select id="i3"><option>opt secret</option></select>
      <div id="i4" contenteditable="true">my notes</div>
      <button id="i5" type="password">hunter2</button>
      <div data-wgo-mask><button id="i6">Alice Smith</button></div><div data-wgo-mask><button id="i8">Bob Smith</button></div>
      <input id="i7" type="button" value="Click me">`)
    A.init(cfg({ autocapture: on }))
    for (const id of ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8']) click(q('#' + id))
    await A.flush()
    const es = clicks()
    expect(es).toHaveLength(8)
    // only the button-type input has a label: its caption, which the page author wrote
    expect(es.filter((e) => e.d!.text).map((e) => e.d!.text)).toEqual(['Click me'])
    expect(JSON.stringify(eventsOf(f))).not.toMatch(/secret|hunter2|Alice|Bob|typed|notes/)
  })

  it('skips elements inside data-wgo-ignore', async () => {
    html('<div data-wgo-ignore><button id="x"><span id="y">no</span></button></div><div data-wgo-ignore><button id="w">other</button></div><button id="z">yes</button>')
    A.init(cfg({ autocapture: on }))
    click(q('#y')); click(q('#x')); click(q('#w')); click(q('#z'))
    await A.flush()
    expect(clicks().map((e) => e.d!.sel)).toEqual(['#z'])
  })

  it('resolves to the closest meaningful element, else the target itself', async () => {
    html('<button id="b"><span id="s">hi</span></button><p id="p">para</p>')
    A.init(cfg({ autocapture: on }))
    click(q('#s')); click(q('#p'))
    await A.flush()
    expect(clicks().map((e) => [e.d!.sel, e.d!.tag])).toEqual([['#b', 'button'], ['#p', 'p']])
  })

  it('priorityClicks pull the flush in; ordinary clicks wait for flushInterval', async () => {
    html('<button id="plain">a</button><button id="buy" class="buy">b</button>')
    A.init(cfg({ autocapture: on, priorityClicks: ['.buy'] }))
    click(q('#plain'))
    await vi.advanceTimersByTimeAsync(1500)
    expect(f).not.toHaveBeenCalled()
    click(q('#buy'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(clicks().map((e) => e.d!.sel)).toEqual(['#plain', '#buy'])
  })
})

describe('rage clicks', () => {
  it('marks the 3rd click rage:3, then updates the queued event instead of emitting more', async () => {
    html('<button id="b">x</button>')
    A.init(cfg({ autocapture: on }))
    for (let i = 0; i < 5; i++) { click(q('#b')); await vi.advanceTimersByTimeAsync(100) }
    await A.flush()
    const es = clicks()
    expect(es).toHaveLength(3)
    expect(es[0].d).not.toHaveProperty('rage')
    expect(es[1].d).not.toHaveProperty('rage')
    expect(es[2].d!.rage).toBe(5)
  })

  it('does not flag slow clicks or clicks on different elements', async () => {
    html('<button id="a">a</button><button id="b">b</button>')
    A.init(cfg({ autocapture: on }))
    for (let i = 0; i < 4; i++) { click(q('#a')); await vi.advanceTimersByTimeAsync(600) }
    click(q('#a')); click(q('#b')); click(q('#a'))
    await A.flush()
    expect(clicks().every((e) => !('rage' in e.d!))).toBe(true)
    expect(clicks()).toHaveLength(7)
  })

  it('starts a new rage burst after a pause', async () => {
    html('<button id="b">x</button>')
    A.init(cfg({ autocapture: on }))
    for (let i = 0; i < 3; i++) click(q('#b'))
    await vi.advanceTimersByTimeAsync(2000) // flushed, window expired
    for (let i = 0; i < 3; i++) click(q('#b'))
    await A.flush()
    expect(clicks().filter((e) => e.d!.rage)).toHaveLength(2)
  })
})

describe('dead clicks', () => {
  it('flags a click on a button when nothing changes within 1 s', async () => {
    html('<button id="b">x</button>')
    A.init(cfg({ autocapture: on }))
    click(q('#b'))
    await vi.advanceTimersByTimeAsync(1100)
    await A.flush()
    expect(clicks()[0].d!.dead).toBe(1)
  })

  it('flags links, role=button and submit inputs too', async () => {
    html('<a id="a">a</a><div id="r" role="button">r</div><input id="s" type="submit" value="Go">')
    A.init(cfg({ autocapture: on }))
    for (const id of ['#a', '#r', '#s']) { click(q(id)); await vi.advanceTimersByTimeAsync(1100) }
    await A.flush()
    expect(clicks().map((e) => e.d!.dead)).toEqual([1, 1, 1])
  })

  it('does not flag a click that changes the DOM', async () => {
    html('<button id="b">x</button><div id="out"></div>')
    A.init(cfg({ autocapture: on }))
    q('#b').addEventListener('click', () => { q('#out').textContent = 'done' })
    click(q('#b'))
    await realSleep(20) // happy-dom delivers mutation records on a real timer
    await vi.advanceTimersByTimeAsync(1100)
    await A.flush()
    expect(clicks()[0].d).not.toHaveProperty('dead')
  })

  it('does not flag when the location changes', async () => {
    html('<button id="b">x</button>')
    A.init(cfg({ autocapture: on }))
    click(q('#b'))
    history.pushState({}, '', '/after-click')
    await vi.advanceTimersByTimeAsync(1100)
    await A.flush()
    expect(clicks()[0].d).not.toHaveProperty('dead')
    history.pushState({}, '', '/')
  })

  it('does not mutate an event that was already sent', async () => {
    html('<button id="b">x</button>')
    A.init(cfg({ autocapture: on }))
    click(q('#b'))
    await A.flush()
    await vi.advanceTimersByTimeAsync(1100)
    expect(clicks()[0].d).not.toHaveProperty('dead')
  })

  it('never flags non-interactive elements or new-tab links', async () => {
    html('<div id="d">x</div><p id="p">y</p><a id="n" href="/x" target="_blank">n</a><a id="m" href="mailto:a@b.c">m</a>')
    A.init(cfg({ autocapture: on }))
    for (const id of ['#d', '#p', '#n', '#m']) { click(q(id)); await vi.advanceTimersByTimeAsync(1100) }
    await A.flush()
    expect(clicks().every((e) => !('dead' in e.d!))).toBe(true)
  })
})
