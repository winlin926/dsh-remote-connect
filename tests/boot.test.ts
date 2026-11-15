import { expect, it } from 'vitest'
import { BOOT_PATH, bootScript, injectBoot } from '../src/boot.js'
import { localFilePath } from '../src/local-file.js'

const page = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DeepSeek Harness</title></head><body><div id="root"></div></body></html>'

it('loads the same-origin boot script only after the viewport meta', () => {
  const html = injectBoot(page)
  const viewport = html.indexOf('name="viewport"')
  const script = html.indexOf(`<script src="${BOOT_PATH}">`)
  const title = html.indexOf('<title>')
  expect(viewport).toBeGreaterThan(0)
  expect(script).toBeGreaterThan(viewport)
  expect(title).toBeGreaterThan(script)
  expect(html).not.toContain(`<script>${bootScript()}`)
  expect(injectBoot('<head><title>x</title></head>')).toMatch(/^<head><meta name="viewport" content="width=device-width, initial-scale=1"><script src="\/rc\/boot\.js"><\/script>/)
})

it('installs the transport ahead of Host head injections without changing their order', () => {
  const html = injectBoot('<head><script>queue()</script><link rel="preload" as="script" href="plugins/batch"><script src="plugins/bootstrap"></script><meta name="viewport" content="width=device-width,interactive-widget=resizes-content"><script type="module" src="app.js"></script></head>')
  expect(html).toMatch(/^<head><meta name="viewport" content="width=device-width,interactive-widget=resizes-content"><script src="\/rc\/boot\.js"><\/script><script>queue\(\)<\/script>/)
  expect(html.match(/name="viewport"/g)).toHaveLength(1)
  expect(html.indexOf('queue()')).toBeLessThan(html.indexOf('plugins/batch'))
  expect(html.indexOf('plugins/batch')).toBeLessThan(html.indexOf('plugins/bootstrap'))
  expect(html.indexOf('plugins/bootstrap')).toBeLessThan(html.indexOf('app.js'))
})

it('leaves the Host mobile layout alone and only refuses the browser translate offer', () => {
  const script = bootScript()
  expect(script).toContain('__DSH_REMOTE_CONTROL__')
  expect(script).toContain('translate')
  // 0.2.2 owns the viewport, the theme colour, the document language and the keyboard policy.
  expect(script).not.toContain('interactive-widget')
  expect(script).not.toContain('dsh-rc-mobile')
  expect(script).toContain('__DSH_TRANSPORT__')
  expect(script).not.toContain('ownsHost: true')
})

it('converts local file links to computer paths without losing Unix roots', () => {
  expect(localFilePath('file:///C:/Users/example/Documents/a%20b.html')).toBe('C:/Users/example/Documents/a b.html')
  expect(localFilePath('file:///home/user/workspace/index.html')).toBe('/home/user/workspace/index.html')
  expect(localFilePath('file://server/share/index.html')).toBeUndefined()
  expect(localFilePath('file:///C:/workspace/../secret.html')).toBe('C:/secret.html')
  expect(localFilePath('file:///C:/bad%ZZ.html')).toBeUndefined()
  expect(localFilePath('https://example.com/index.html')).toBeUndefined()
})
/** The Host serves the boot script as text, so its browser behaviour is only observable through a stand-in. */
class StandInSocket {
  static all: StandInSocket[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  private readonly listeners = new Map<string, Array<(event: Event) => void>>()
  constructor(readonly url: unknown, readonly protocols?: unknown) { StandInSocket.all.push(this) }
  addEventListener(type: string, listener: (event: Event) => void): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]) }
  fire(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener(new Event(type)) }
}
class StandInElement {
  id = ''; type = ''; src = ''; href = ''; async = false; disabled = false; focused = false
  style: Record<string, any> = {}
  attributes: Record<string, string> = {}
  dataset = new Proxy<Record<string, string>>({}, { set: (_target, key, value) => { this.attributes['data-' + String(key).replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())] = value; return true } })
  parentElement: StandInElement | null = null
  children: StandInElement[] = []
  onclick?: () => void
  private text = ''
  private listeners = new Map<string, Array<() => void>>()
  constructor(readonly tagName: string) {}
  get firstElementChild(): StandInElement | null { return this.children[0] ?? null }
  get childElementCount(): number { return this.children.length }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join('') }
  set textContent(value: string) { this.text = value; this.replaceChildren() }
  setAttribute(name: string, value: string): void { this.attributes[name] = value }
  append(...nodes: StandInElement[]): void { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node) } }
  replaceChildren(...nodes: StandInElement[]): void { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...nodes) }
  remove(): void { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null } }
  focus(): void { this.focused = true }
  addEventListener(type: string, listener: () => void): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]) }
  fire(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener() }
  querySelector(selector: string): StandInElement | null {
    const direct = selector.startsWith(':scope > '), attribute = selector.match(/\[([^\]]+)\]/)?.[1]
    for (const child of this.children) {
      if (attribute && attribute in child.attributes) return child
      if (!direct) { const match = child.querySelector(selector); if (match) return match }
    }
    return null
  }
}
function bootPage(crypto: Record<string, unknown> = { getRandomValues: (array: Uint8Array) => array }, transport: Record<string, unknown> = {}) {
  StandInSocket.all = []
  const requests: Array<{ url: string; body?: string; method?: string }> = []
  const waiting: Array<(response: Response) => void> = []
  const timers: Array<{ delay: number; run: () => void; cancelled: boolean }> = []
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  const NativeEventSource = class { constructor(readonly url: string, readonly init?: EventSourceInit) {} }
  const window: Record<string, any> = {
    fetch: (input: unknown, init?: { body?: string; method?: string }) => { requests.push({ url: String(input), body: init?.body, method: init?.method }); return new Promise<Response>(resolve => waiting.push(resolve)) },
    addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, [...listeners.get(type) ?? [], listener]) },
    dispatchEvent: () => true, WebSocket: StandInSocket, EventSource: NativeEventSource, __DSH_TRANSPORT__: transport,
  }
  const elements: StandInElement[] = []
  const createElement = (tag: string): StandInElement => {
    const node = new StandInElement(tag.toUpperCase())
    elements.push(node)
    return node
  }
  const root = createElement('div'); root.id = 'root'
  const document = { documentElement: createElement('html'), head: createElement('head'), addEventListener: () => {}, getElementById: (id: string) => elements.find(node => node.id === id) ?? null, createElement, body: createElement('body') }
  let mutation: (() => void) | undefined
  const MutationObserver = class { constructor(listener: () => void) { mutation = listener } observe() {} disconnect() { mutation = undefined } }
  let reloads = 0
  const location = { href: 'https://rc.example/app?token=page-secret#credential', origin: 'https://rc.example', protocol: 'https:', assign: () => {}, reload: () => { reloads++ } }
  new Function('window', 'document', 'location', 'crypto', 'setTimeout', 'clearTimeout', 'MutationObserver', 'navigator', 'innerWidth', 'innerHeight', 'devicePixelRatio', bootScript())(
    window, document, location, crypto,
    (run: () => void, delay: number) => { timers.push({ delay, run, cancelled: false }); return timers.length },
    (id: number) => { if (timers[id - 1]) timers[id - 1]!.cancelled = true },
    MutationObserver, { userAgent: 'test browser' }, 390, 844, 1,
  )
  const mountBoot = () => {
    const boot = createElement('div'); boot.dataset.dshBoot = ''
    const card = createElement('div'), spinner = createElement('div'), hint = createElement('p')
    spinner.dataset.dshBootSpinner = ''; hint.textContent = 'Loading plugins…'
    card.append(spinner, hint); boot.append(card); root.replaceChildren(boot); mutation?.()
    return { boot, spinner, card }
  }
  return {
    window, NativeEventSource, requests, timers, sockets: StandInSocket.all, document, root, createElement, mountBoot,
    mutate: () => { mutation?.() }, reloads: () => reloads,
    fire: (type: string, event: unknown) => { for (const listener of listeners.get(type) ?? []) listener(event) },
    report: () => { timers.filter(timer => !timer.cancelled).at(-1)!.run(); return JSON.parse(requests.at(-1)!.body!) },
    answer: () => waiting.shift()?.(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
    answerWith: (status: number, body: string) => waiting.shift()?.(new Response(body, { status, headers: { 'content-type': 'application/json' } })),
    elements,
  }
}

it('observes native script transport while leaving retry and fallback to the Host', async () => {
  const f = bootPage(), { boot } = f.mountBoot()
  expect(boot.textContent).toContain('正在核对插件版本')
  const load = f.window.__DSH_TRANSPORT__.loadBundle as (url: string) => Promise<void>
  const first = load('/plugins/??one/client.js,two/client.js&rev=batch').catch(error => error)
  const script = f.document.head.children[0]!
  expect(script.async).toBe(true)
  expect(boot.textContent).toContain('正在加载资源')
  script.fire('error')
  expect(await first).toBeInstanceOf(Error)
  expect(f.document.head.children).toHaveLength(0)
  expect(f.elements.filter(element => element.tagName === 'SCRIPT')).toHaveLength(1)
  expect(boot.textContent).not.toContain('启动失败')
  const fallback = load('/plugins/??one/client.js&rev=one')
  f.document.head.children[0]!.fire('load')
  await fallback
  expect(boot.textContent).toContain('正在初始化插件 · 已加载 1 个资源')
  expect(f.requests).toHaveLength(0)
  expect(f.report()).toMatchObject({ result: 'pending', mounted: false, completedResources: 1, resources: [{ result: 'error' }, { result: 'loaded' }] })
})

it('delegates an existing transport and preserves its rejection without adding scripts', async () => {
  const failure = new Error('transport failed'), calls: string[] = []
  const transport = { loadBundle(this: unknown, url: string): Promise<void> { expect(this).toBe(transport); calls.push(url); return Promise.reject(failure) } }
  const f = bootPage(undefined, transport)
  const pending = f.window.__DSH_TRANSPORT__.loadBundle('/plugins/one.js?rev=x')
  expect(calls).toEqual(['/plugins/one.js?rev=x'])
  await expect(pending).rejects.toBe(failure)
  expect(f.document.head.children).toHaveLength(0)
})

it('reports ready only after the official boot DOM is replaced by the application', () => {
  const unknown = bootPage()
  unknown.root.append(unknown.createElement('div')); unknown.mutate()
  expect(unknown.report()).toMatchObject({ result: 'unknown', mounted: false })
  const f = bootPage(); f.mountBoot()
  expect(f.report()).toMatchObject({ result: 'pending', mounted: false })
  f.root.replaceChildren(); f.mutate()
  expect(f.report()).toMatchObject({ result: 'pending', mounted: false })
  f.root.replaceChildren(f.createElement('main')); f.mutate()
  expect(f.report()).toMatchObject({ phase: 'ready', result: 'ready', mounted: true })
  expect(f.elements.some(element => element.id === 'dsh-rc-boot-errors')).toBe(false)
})

it('offers reload only for the official final failure and never for an intermediate resource error', () => {
  const f = bootPage(), { boot, spinner, card } = f.mountBoot()
  f.fire('error', { target: { tagName: 'LINK', href: '/plugins/??one/client.js&rev=x' } })
  expect(boot.textContent).not.toContain('启动失败')
  spinner.remove(); const failure = f.createElement('div'); failure.textContent = 'Failed to load plugins'; card.append(failure); f.mutate()
  const status = boot.querySelector('[data-dsh-rc-boot-status]')!
  expect(status.attributes.role).toBe('alert')
  expect(status.textContent).toContain('启动失败')
  status.children.find(child => child.tagName === 'BUTTON')!.onclick!()
  expect(f.reloads()).toBe(1)
  expect(f.report()).toMatchObject({ phase: 'failed', result: 'failed', mounted: false, errors: expect.arrayContaining(['official-startup-failure']) })
})

it('bounds boot reports and removes credentials, arbitrary query parameters and fragments', async () => {
  const f = bootPage(undefined, { loadBundle: async () => {} }); f.mountBoot()
  for (let index = 0; index < 12; index++) await f.window.__DSH_TRANSPORT__.loadBundle(`https://user:password@rc.example/plugins/??one/client.js&rev=r${index}&token=resource-secret#key`)
  f.fire('error', { message: 'secret in message', filename: 'https://rc.example/app.js?token=script-secret#key', lineno: 7 })
  const report = f.report(), serialized = JSON.stringify(report)
  expect(report.resources).toHaveLength(8)
  expect(report.resources[0]).toMatchObject({ origin: 'https://rc.example', path: '/plugins/', rev: 'r4', result: 'loaded' })
  expect(report).toMatchObject({ origin: 'https://rc.example', path: '/app', completedResources: 12 })
  expect(serialized).not.toMatch(/page-secret|credential|password|resource-secret|script-secret|secret in message|token=|#key/)
  expect(serialized.length).toBeLessThan(7000)
})

it('defines the randomUUID fallback as a property the Host can replace again', () => {
  const crypto: Record<string, any> = { getRandomValues: (array: Uint8Array) => array.fill(0x12) }
  bootPage(crypto)
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID')!
  expect(descriptor.writable).toBe(true)
  expect(descriptor.configurable).toBe(true)
  expect(descriptor.value()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  // A Host that installs its own fallback replaces ours instead of throwing in strict mode.
  Object.defineProperty(crypto, 'randomUUID', { value: () => 'host-owned' })
  expect(crypto.randomUUID()).toBe('host-owned')
})

it('hands a cross-origin EventSource to the browser instead of throwing on construction', () => {
  const { window, NativeEventSource, sockets } = bootPage()
  const cross = new window.EventSource('https://other.example/events')
  expect(cross).toBeInstanceOf(NativeEventSource)
  expect(cross.url).toBe('https://other.example/events')
  expect(sockets).toHaveLength(0)
  const same = new window.EventSource('/api/sse')
  expect(same).not.toBeInstanceOf(NativeEventSource)
  expect(sockets).toHaveLength(1)
})

it('probes the authorization once for a socket that opened, never for the SSE carrier', async () => {
  const { window, requests, answer } = bootPage()
  const open = (path: string) => { const socket = new window.WebSocket(path); socket.fire('open'); return socket }
  open('/rc/sse?path=%2Fapi%2Fsse').fire('close')
  // A socket that never opened says nothing about the authorization.
  new window.WebSocket('/api/remote.mux').fire('close')
  expect(requests).toHaveLength(0)
  open('/api/remote.mux').fire('close')
  open('/api/remote.mux').fire('close')
  expect(requests).toHaveLength(1)
  expect(JSON.parse(requests[0]!.body!)).toEqual({ action: 'status' })
  answer()
  await new Promise(resolve => setImmediate(resolve))
  open('/api/remote.mux').fire('close')
  expect(requests).toHaveLength(2)
})

it('backs a failing carrier off from 3s to 30s and resets after a live connection', () => {
  const { window, sockets, timers } = bootPage()
  const source = new window.EventSource('/api/sse')
  const delays: number[] = []
  for (let attempt = 0; attempt < 6; attempt++) {
    sockets.at(-1)!.onclose!()
    delays.push(timers.at(-1)!.delay)
    timers.at(-1)!.run()
  }
  expect(delays).toEqual([3000, 6000, 12000, 24000, 30000, 30000])
  // A frame the Host answered is a live connection, so the wait starts over.
  const live = sockets.at(-1)!
  live.onmessage!({ data: JSON.stringify({ type: 'ready' }) })
  expect(source.readyState).toBe(1)
  live.onclose!()
  expect(timers.at(-1)!.delay).toBe(3000)
})

it('shows a revoked device as a modal dialog that starts on its only action', async () => {
  const globals = globalThis as Record<string, any>
  globals.getComputedStyle = () => ({ colorScheme: 'light' })
  globals.matchMedia = () => ({ matches: false })
  try {
    const { window, requests, answerWith, elements } = bootPage()
    const socket = new window.WebSocket('/api/remote.mux'); socket.fire('open'); socket.fire('close')
    expect(requests).toHaveLength(1)
    answerWith(403, JSON.stringify({ code: 'unpaired' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    const notice = elements.find(node => node.id === 'dsh-rc-disconnected')!
    expect(notice.attributes.role).toBe('dialog')
    expect(notice.attributes['aria-modal']).toBe('true')
    expect(notice.attributes['aria-labelledby']).toBe('dsh-rc-disconnected-text')
    const retry = notice.children[0].children[1]
    expect(retry.textContent).toBe('重新连接')
    expect(retry.focused).toBe(true)
  } finally {
    delete globals.getComputedStyle; delete globals.matchMedia
  }
})
