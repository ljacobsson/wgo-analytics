import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as A from '../src/index'
import type { Client } from '../src/client'
import { render } from '../src/surveys/render'
import { allowed, pathMatches, start } from '../src/surveys/index'
import type { PublicSurvey, SurveyQuestion } from '../src/types'
import { EP, cfg, eventsOf, mockFetch } from './helpers'

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); document.head.innerHTML = ''; document.body.innerHTML = '' })
afterEach(() => { A.shutdown(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const survey = (questions: Partial<SurveyQuestion>[], over: Partial<PublicSurvey> = {}): PublicSurvey => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Feedback',
  questions: questions.map((q, i) => ({ id: `q${i + 1}`, type: 'text', title: `Question ${i + 1}`, required: false, ...q }) as SurveyQuestion),
  display: { mode: 'popover', layout: 'steps', theme: 'auto' },
  targeting: { paths: [], frequency: 'once' },
  ...over,
})

const sr = (host: Element) => host.shadowRoot!
const click = (root: ShadowRoot, sel: string, text?: string) => {
  const el = [...root.querySelectorAll<HTMLElement>(sel)].find((e) => text === undefined || e.textContent?.includes(text))
  if (!el) throw new Error(`no ${sel} ${text ?? ''}`)
  el.click()
}
const nextBtn = (root: ShadowRoot) => [...root.querySelectorAll<HTMLButtonElement>('.btn')].pop()!

describe('survey renderer', () => {
  it('steps through questions, holds Next until required ones are answered, then submits', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const onSubmit = vi.fn()
    render(host, survey([
      { type: 'single', title: 'Role', options: ['Dev', 'PM'], required: true },
      { type: 'multi', title: 'Uses', options: ['A', 'B', 'C'] },
      { type: 'yesno', title: 'Recommend?' },
      { type: 'nps', title: 'Score', lowLabel: 'No way', highLabel: 'Sure' },
    ]), { onSubmit, onDismiss: vi.fn() })
    const root = sr(host)
    expect(root.querySelector('.t')!.textContent).toBe('Role')
    expect(root.querySelector('.p')!.textContent).toBe('1 of 4')
    expect(nextBtn(root).disabled).toBe(true)
    click(root, '.o', 'PM')
    expect(nextBtn(root).disabled).toBe(false)
    nextBtn(root).click()
    expect(root.querySelector('.t')!.textContent).toContain('Uses')
    click(root, '.o', 'C'); click(root, '.o', 'A')
    nextBtn(root).click()
    click(root, '.o', 'No')
    nextBtn(root).click()
    expect(root.querySelectorAll('.n')).toHaveLength(11)
    expect(root.querySelector('.lb')!.textContent).toBe('No waySure')
    click(root, '.n', '9')
    expect(nextBtn(root).textContent).toBe('Submit')
    nextBtn(root).click()
    expect(onSubmit).toHaveBeenCalledWith({ q1: 'PM', q2: ['A', 'C'], q3: false, q4: 9 })
    expect(root.querySelector('.ty')!.textContent).toBe('Thanks for your feedback!')
  })

  it('shows every question on one form, with Back-free submit and text answers', () => {
    const host = document.createElement('div')
    const onSubmit = vi.fn()
    render(host, survey([{ title: 'Why?', long: true, required: true }, { type: 'rating', title: 'Docs', scale: 5 }],
      { display: { mode: 'inline', selector: '#x', layout: 'form', theme: 'dark', thankYou: 'Merci', submitLabel: 'Send' } }), { onSubmit, onDismiss: vi.fn() })
    const root = sr(host)
    expect(root.querySelectorAll('.q')).toHaveLength(2)
    expect(root.querySelector('.x')).toBeNull() // inline: no close button
    expect(nextBtn(root).textContent).toBe('Send')
    expect(nextBtn(root).disabled).toBe(true)
    const ta = root.querySelector('textarea')!
    ta.value = ' great '
    ta.dispatchEvent(new Event('input'))
    expect(nextBtn(root).disabled).toBe(false)
    click(root, '.n', '★') // first star = 1
    nextBtn(root).click()
    expect(onSubmit).toHaveBeenCalledWith({ q1: 'great', q2: 1 })
    expect(root.querySelector('.ty')!.textContent).toBe('Merci')
  })

  it('treats survey text as text, and closes with × or Escape', () => {
    const host = document.createElement('div')
    const onDismiss = vi.fn()
    render(host, survey([{ title: '<img src=x onerror=alert(1)>' }]), { onSubmit: vi.fn(), onDismiss })
    const root = sr(host)
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('.t')!.textContent).toBe('<img src=x onerror=alert(1)>')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(root.querySelector('.c')).toBeNull()
  })
})

describe('survey targeting rules', () => {
  it('matches path globs', () => {
    expect(pathMatches([], '/anything')).toBe(true)
    expect(pathMatches(['/pricing'], '/pricing')).toBe(true)
    expect(pathMatches(['/pricing'], '/pricing/team')).toBe(false)
    expect(pathMatches(['/docs/*', '/a'], '/docs/x/y')).toBe(true)
  })
  it('follows the frequency', () => {
    const s = (frequency: PublicSurvey['targeting']['frequency']) => survey([{}], { targeting: { paths: [], frequency } })
    const id = s('once').id
    expect(allowed(s('once'), {}, 'S1')).toBe(true)
    expect(allowed(s('once'), { [id]: { x: 'S1' } }, 'S2')).toBe(false)
    expect(allowed(s('until_answered'), { [id]: { x: 'S1' } }, 'S1')).toBe(false)
    expect(allowed(s('until_answered'), { [id]: { x: 'S1' } }, 'S2')).toBe(true)
    expect(allowed(s('until_answered'), { [id]: { d: 1 } }, 'S2')).toBe(false)
    expect(allowed(s('always'), { [id]: { d: 1 } }, 'S1')).toBe(true)
  })
})

const tick = () => new Promise((r) => setTimeout(r, 0))
const client = () => (globalThis as unknown as { __wgo: { client: Client } }).__wgo.client
const scripts = () => [...document.querySelectorAll('script')].map((s) => s.getAttribute('src'))

describe('loading surveys', () => {
  it('loads wgo-surveys.js when the project has active surveys', async () => {
    mockFetch(undefined, () => ({ ok: true, json: async () => ({ on: false, sv: true }) }))
    A.init(cfg())
    await tick(); await tick()
    expect(scripts()).toEqual([`${EP}/sdk/v1/wgo-surveys.js`])
  })
  it('does not without surveys, or with surveys: false', async () => {
    mockFetch(undefined, () => ({ ok: true, json: async () => ({ on: false }) }))
    A.init(cfg())
    await tick(); await tick()
    expect(scripts()).toEqual([])
    A.shutdown()
    mockFetch(undefined, () => ({ ok: true, json: async () => ({ on: false, sv: true }) }))
    A.init(cfg({ surveys: false, record: false }))
    A.showSurvey('x')
    await tick(); await tick()
    expect(scripts()).toEqual([])
  })
  it('showSurvey loads the script and remembers the survey', async () => {
    mockFetch(undefined, () => ({ ok: false, status: 404 }))
    A.init(cfg())
    A.showSurvey('abc')
    expect(scripts()).toEqual([`${EP}/sdk/v1/wgo-surveys.js`])
    expect(client().want).toBe('abc')
  })
})

describe('showing surveys', () => {
  const setup = (list: PublicSurvey[]) => {
    const f = mockFetch((url) => (url.includes('/surveys/config') ? { ok: true, json: async () => ({ s: list }) } : { ok: true, status: 200 }))
    A.init(cfg())
    const stop = start(client())
    return { f, stop }
  }
  const hostOf = (id = survey([]).id) => document.querySelector(`[data-wgo-survey="${id}"]`)

  it('shows a matching popover, posts the answers and sends the custom events', async () => {
    const { f, stop } = setup([survey([{ type: 'yesno', title: 'Ok?', required: true }])])
    await tick(); await tick()
    const host = hostOf()!
    expect(host.parentElement).toBe(document.body)
    click(sr(host), '.o', 'Yes')
    nextBtn(sr(host)).click()
    const post = f.mock.calls.find((c) => String(c[0]) === `${EP}/surveys/respond`)!
    const body = JSON.parse(String((post[1] as RequestInit).body))
    expect(body).toMatchObject({ k: 'wk_test', id: survey([]).id, ans: { q1: true }, a: client().session.aid, path: location.pathname })
    expect(body.r).toMatch(/^[0-9a-f-]{36}$/)
    await A.flush()
    expect(eventsOf(f).map((e) => (e.d as { name: string }).name)).toEqual(['survey_shown', 'survey_sent'])
    expect(eventsOf(f)[0].d).toEqual({ name: 'survey_shown', props: { survey_id: survey([]).id, survey_name: 'Feedback' } })
    stop()
    // answered, frequency once: never again
    start(client())
    await tick(); await tick()
    expect(hostOf()).toBeNull()
  })

  it('waits for the path, delay and custom event', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    setup([survey([{}], { targeting: { paths: [location.pathname], delaySec: 5, event: 'paid', frequency: 'always' } }),
      survey([{}], { id: '22222222-2222-4222-8222-222222222222', targeting: { paths: ['/elsewhere'], frequency: 'always' } })])
    await vi.advanceTimersByTimeAsync(10)
    expect(hostOf()).toBeNull()
    await vi.advanceTimersByTimeAsync(5000)
    expect(hostOf()).toBeNull() // delay over, no event yet
    A.track('paid')
    expect(hostOf()).not.toBeNull()
    expect(hostOf('22222222-2222-4222-8222-222222222222')).toBeNull()
  })

  it('renders inline surveys into their element, once it exists', async () => {
    setup([survey([{}], { display: { mode: 'inline', selector: '#feedback', layout: 'form', theme: 'auto' } })])
    await tick(); await tick()
    expect(hostOf()).toBeNull()
    const box = document.createElement('section')
    box.id = 'feedback'
    document.body.appendChild(box)
    await tick()
    expect(hostOf()!.parentElement).toBe(box)
  })

  it('remembers a closed survey', async () => {
    const { stop } = setup([survey([{}])])
    await tick(); await tick()
    click(sr(hostOf()!), '.x')
    expect(hostOf()).toBeNull()
    expect(JSON.parse(localStorage.getItem('wgo:sv')!)).toEqual({ [survey([]).id]: { x: client().session.peek() } })
    stop()
  })
})
