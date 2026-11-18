import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as A from '../src/index'
import { serialize } from '../src/replay/serialize'
import { clickTrigger, eventTrigger, MIN_SESSION_MS, start } from '../src/replay/recorder'
import { unit } from '../src/replay/sample'
import type { ReplayHost, WireEvent } from '../src/types'
import { EP, INGEST, batchOf, cfg, mockFetch, setBeacon } from './helpers'

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); document.head.innerHTML = ''; document.body.innerHTML = '' })
afterEach(() => { A.shutdown(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('snapshot serializer', () => {
  it('never captures what was typed: text fields become bullets, textareas too', () => {
    document.body.innerHTML = '<input id="a" value="default"><input id="p" type="password"><textarea id="t"></textarea><input type="submit" value="Send">'
    ;(document.getElementById('a') as HTMLInputElement).value = 'hunter2'
    ;(document.getElementById('p') as HTMLInputElement).value = 'secret!'
    ;(document.getElementById('t') as HTMLTextAreaElement).value = 'my address'
    const { html } = serialize(document)
    expect(html).not.toMatch(/hunter2|secret!|my address|default/)
    expect(html).toContain('id="a" value="•••••••"')
    expect(html).toContain('id="p" type="password" value="•••••••"')
    expect(html).toContain('<textarea id="t">••••••••••</textarea>')
    expect(html).toContain('value="Send"') // a button caption is not user input
  })

  it('keeps checkbox and select state', () => {
    document.body.innerHTML = '<input type="checkbox" id="c"><select><option>a</option><option>b</option></select>'
    ;(document.getElementById('c') as HTMLInputElement).checked = true
    document.querySelector('select')!.selectedIndex = 1
    const { html } = serialize(document)
    expect(html).toContain('<input type="checkbox" id="c" checked="">')
    expect(html).toContain('<option>a</option><option selected="">b</option>')
  })

  it('drops scripts, inline handlers and javascript: URLs; blanks iframes', () => {
    document.body.innerHTML = '<script>alert(1)</script><a href="javascript:void(0)" onclick="x()">go</a><iframe src="https://x.test" class="f"></iframe><noscript>n</noscript>'
    const { html } = serialize(document)
    expect(html).not.toMatch(/<script|alert|onclick|javascript:|x\.test|<noscript/)
    expect(html).toContain('<a>go</a>')
    expect(html).toMatch(/<iframe class="f" style="[^"]*width:\d+px/)
  })

  it('masks [data-wgo-mask] text and blocks [data-wgo-block] elements', () => {
    document.body.innerHTML = '<p data-wgo-mask>Jane Doe <b>42</b></p><div data-wgo-block class="card">card 4242</div><p>visible</p>'
    const { html } = serialize(document)
    expect(html).toContain('<p data-wgo-mask="">**** *** <b>**</b></p>')
    expect(html).not.toContain('4242')
    expect(html).toContain('<div data-wgo-block="" class="card" style=')
    document.body.innerHTML = '<img data-wgo-block src="/face.jpg" srcset="/face@2x.jpg 2x">'
    expect(serialize(document).html).not.toContain('face')
    expect(html).toContain('<p>visible</p>')
  })

  it('maskText masks every text node', () => {
    document.body.innerHTML = '<h1>Hello world</h1>'
    expect(serialize(document, { maskText: true }).html).toContain('<h1>***** *****</h1>')
  })

  it('makes URLs absolute and adds a <base>', () => {
    document.head.innerHTML = '<link rel="stylesheet" href="/app.css"><link rel="preload" href="/x.js">'
    document.body.innerHTML = '<img src="/logo.png" srcset="/a.png 1x, /b.png 2x" loading="lazy">'
    const { html } = serialize(document)
    const origin = location.origin
    expect(html).toContain(`<base href="${location.href}">`)
    expect(html).toContain(`<link rel="stylesheet" href="${origin}/app.css">`)
    expect(html).not.toContain('preload')
    expect(html).toContain(`<img src="${origin}/logo.png" srcset="${origin}/a.png 1x, ${origin}/b.png 2x">`)
  })

  it('returns inline CSS separately, with placeholders in the HTML', () => {
    document.head.innerHTML = '<style>p { color: red; }</style>'
    const { html, css } = serialize(document)
    expect(html).toContain('<style data-wgo-c="0"></style>')
    expect(css[0]).toMatch(/p\s*{\s*color: red;\s*}/)
  })
})

describe('triggers', () => {
  it('match pages by glob, custom events by name and errors by text', () => {
    const trg = [{ type: 'page' as const, value: '/checkout*' }, { type: 'event' as const, value: 'signup' }, { type: 'error' as const, value: 'price' }]
    expect(eventTrigger(trg, { t: 'pageview', path: '/checkout/pay' })?.type).toBe('page')
    expect(eventTrigger(trg, { t: 'pageview', path: '/cart' })).toBeUndefined()
    expect(eventTrigger(trg, { t: 'custom', path: '/', d: { name: 'signup' } })?.type).toBe('event')
    expect(eventTrigger(trg, { t: 'error', path: '/', d: { msg: "Cannot read 'price'" } })?.type).toBe('error')
    expect(eventTrigger(trg, { t: 'error', path: '/', d: { msg: 'other' } })).toBeUndefined()
    expect(eventTrigger([{ type: 'error' }], { t: 'http_error', path: '/', d: { url: '/api' } })?.type).toBe('error')
  })

  it('match clicks on the element or inside it; a bad selector never matches', () => {
    document.body.innerHTML = '<button id="buy"><span>Buy</span></button>'
    const span = document.querySelector('span')!
    expect(clickTrigger([{ type: 'click', value: '#buy' }], span)?.value).toBe('#buy')
    expect(clickTrigger([{ type: 'click', value: '#nope' }, { type: 'click', value: '[[' }], span)).toBeUndefined()
  })
})

describe('loading the recorder', () => {
  const scripts = () => Array.from(document.querySelectorAll('script')).map((s) => s.getAttribute('src'))
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('does not load it when the project does not record', async () => {
    mockFetch(undefined, () => ({ ok: true, status: 200, json: async () => ({ on: false }) }))
    A.init(cfg())
    await settle()
    expect(scripts()).toEqual([])
  })

  it('loads it for a sampled-in session, and asks the right project', async () => {
    let asked = ''
    mockFetch(undefined, (url) => { asked = url; return { ok: true, status: 200, json: async () => ({ on: true, rate: 1 }) } })
    A.init(cfg())
    await settle()
    expect(asked).toBe(`${EP}/replay/config?k=wk_test`)
    expect(scripts()).toEqual([`${EP}/sdk/v1/wgo-replay.js`])
  })

  it('loads it when triggers are set even if the session is not sampled', async () => {
    mockFetch(undefined, () => ({ ok: true, status: 200, json: async () => ({ on: true, rate: 0, trg: [{ type: 'error' }] }) }))
    A.init(cfg())
    await settle()
    expect(scripts()).toHaveLength(1)
  })

  it('record: false never asks', async () => {
    const replay = vi.fn(() => ({ ok: true, status: 200, json: async () => ({ on: true, rate: 1 }) }))
    mockFetch(undefined, replay)
    A.init(cfg({ record: false }))
    await settle()
    expect(replay).not.toHaveBeenCalled()
    expect(scripts()).toEqual([])
  })
})

describe('recorder', () => {
  beforeEach(() => {
    setBeacon(undefined) // the last chunks go out by fetch, where the tests can see them
    Object.defineProperty(navigator, 'webdriver', { value: false, configurable: true }) // happy-dom says true
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  function host(over: Partial<ReplayHost> = {}, subs: ((e: WireEvent) => void)[] = []): ReplayHost {
    return {
      c: { on: true, rate: 1 }, k: 'wk_test', ep: EP, debug: false, mem: true, ctx: { sdk: 'wgo-js/0.1.0' },
      sid: () => 'sess-1', aid: () => 'anon-1', clean: (u) => u,
      on: (f) => { subs.push(f); return () => {} },
      ...over,
    }
  }
  const replayEvents = (f: ReturnType<typeof mockFetch>) =>
    f.mock.calls.filter((c) => String(c[0]) === INGEST).flatMap((c) => batchOf(c).e) as unknown as Array<{ t: string; s: string; d: { p: string; q: number; r: unknown[][] } }>

  it('asks for a slot, then sends the snapshot and what the visitor did', async () => {
    document.body.innerHTML = '<button id="b">Go</button><input id="i">'
    const f = mockFetch((url, init) => {
      if (url.endsWith('/replay/start')) {
        expect(JSON.parse(String(init.body))).toMatchObject({ k: 'wk_test', s: 'sess-1', a: 'anon-1', r: 'sample' })
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
      }
      return { ok: true, status: 200 }
    })
    const stop = start(host())
    await vi.advanceTimersByTimeAsync(MIN_SESSION_MS) // a sampled session asks after 3 s on the page
    await vi.waitFor(() => expect(replayEvents(f).length).toBeGreaterThan(0)) // granted: the buffer went out
    // never with keepalive: the page's 64 KB keepalive quota is left to the event queue
    expect(f.mock.calls.filter((c) => String(c[0]) === INGEST).map((c) => (c[1] as RequestInit).keepalive)).toEqual([false])
    document.getElementById('b')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 20 }))
    const input = document.getElementById('i') as HTMLInputElement
    input.value = 'private'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    stop() // flushes by beacon / fetch
    await vi.waitFor(() => expect(replayEvents(f).flatMap((e) => e.d.r).some((r) => r[0] === 5)).toBe(true))
    const evs = replayEvents(f)
    expect(evs.every((e) => e.t === 'replay' && e.s === 'sess-1')).toBe(true)
    const recs = evs.flatMap((e) => e.d.r)
    expect(recs.find((r) => r[0] === 0)).toBeTruthy() // a snapshot
    expect(recs).toContainEqual([2, expect.any(Number), 10, 20])
    expect(recs).toContainEqual([5, expect.any(Number), '#i', 0, 7]) // the length only
    expect(JSON.stringify(evs)).not.toContain('private')
    expect(sessionStorage.length + localStorage.length).toBe(0) // mem: nothing stored on the device
  })

  it('waits for a trigger without sending anything, then sends the lead-up', async () => {
    document.body.innerHTML = '<p>hi</p>'
    const f = mockFetch((url) => (url.endsWith('/replay/start') ? { ok: true, status: 200, json: async () => ({ ok: true }) } : { ok: true, status: 200 }))
    const subs: ((e: WireEvent) => void)[] = []
    const stop = start(host({ c: { on: true, rate: 0, trg: [{ type: 'event', value: 'checkout' }] } }, subs))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 6 }))
    await new Promise((r) => setTimeout(r, 20))
    expect(f).not.toHaveBeenCalled()
    subs.forEach((s) => s({ id: 'x', t: 'custom', ts: Date.now(), s: 'sess-1', url: '', path: '/', d: { name: 'checkout' } }))
    await vi.waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).endsWith('/replay/start'))).toBe(true))
    expect(JSON.parse(String(f.mock.calls.find((c) => String(c[0]).endsWith('/replay/start'))![1]!.body)).r).toBe('trigger:event:checkout')
    await vi.waitFor(() => expect(replayEvents(f).length).toBeGreaterThan(0))
    stop()
    await vi.waitFor(() => expect(replayEvents(f).flatMap((e) => e.d.r)).toContainEqual([1, expect.any(Number), 5, 6]))
  })

  it('never records an automated browser', async () => {
    Object.defineProperty(navigator, 'webdriver', { value: true, configurable: true })
    try {
      const f = mockFetch()
      start(host())()
      await new Promise((r) => setTimeout(r, 20))
      expect(f).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'webdriver', { value: false, configurable: true })
    }
  })

  it('sends nothing for a visitor who leaves within 3 seconds', async () => {
    const f = mockFetch()
    const stop = start(host())
    await vi.advanceTimersByTimeAsync(MIN_SESSION_MS - 500)
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(f).not.toHaveBeenCalled()
  })

  it('records nothing when the limit is reached', async () => {
    const f = mockFetch((url) => (url.endsWith('/replay/start') ? { ok: true, status: 200, json: async () => ({ ok: false }) } : { ok: true, status: 200 }))
    const stop = start(host())
    await vi.advanceTimersByTimeAsync(MIN_SESSION_MS)
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1))
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    stop()
    await new Promise((r) => setTimeout(r, 20))
    expect(replayEvents(f)).toEqual([])
  })

  it('records a session granted on an earlier page straight away', async () => {
    sessionStorage.setItem('wgo:rec:sess-1', '1')
    const f = mockFetch()
    const stop = start(host({ mem: false, c: { on: true, rate: 0, trg: [{ type: 'error' }] } }))
    stop()
    await vi.waitFor(() => expect(replayEvents(f).length).toBeGreaterThan(0))
    expect(f.mock.calls.some((c) => String(c[0]).endsWith('/replay/start'))).toBe(false)
  })
})

describe('sampling', () => {
  it('spreads sessions evenly and is stable', () => {
    const ids = Array.from({ length: 4000 }, (_, i) => crypto.randomUUID?.() ?? `id-${i}`)
    const hit = ids.filter((id) => unit(id) < 0.25).length / ids.length
    expect(hit).toBeGreaterThan(0.2)
    expect(hit).toBeLessThan(0.3)
    expect(unit('abc')).toBe(unit('abc'))
  })
})
