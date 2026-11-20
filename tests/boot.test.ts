import { expect, it } from 'vitest'
import { BOOT_PATH, bootScript, injectBoot, type BootContext } from '../src/boot.js'
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
  id = ''; type = ''; src = ''; href = ''; async = false; disabled = false; focused = false; className = ''
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
  showModal(): void { this.setAttribute('open', '') }
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
/** One boot graph as the Host composes it: a revision, ordered rows and the initial combos carrying them. */
const bootGraph = (rev: string, ids: string[], batches?: Array<{ phase: string; url: string; entries: string[] }>) => ({
  rev,
  entries: ids.map(id => ({ id, url: '/plugins/??' + id + '/client.js&rev=' + rev, rev })),
  batches: (batches ?? [{ phase: 'bootstrap', url: '/plugins/??' + ids.join('/client.js,') + '/client.js&rev=' + rev, entries: ids }])
    .map(batch => ({ ...batch, rev })),
})
/** The Host's HTML facade: a pending queue before create(), the live sink the module system installs. */
function hostFacade() {
  const live: StandInElement[] = []
  const registrations: Array<{ id: string; chunk?: string }> = []
  const facade: Record<string, any> = {
    mode: 'queue',
    pendingQueue: [] as Array<{ id: string; chunk?: string }>,
    load(registration: { id: string; chunk?: string }) { facade.pendingQueue.push(registration) },
    create(options: unknown) {
      facade.mode = 'live'
      facade.load = (registration: { id: string; chunk?: string }) => { registrations.push(registration) }
      for (const registration of facade.pendingQueue.splice(0)) facade.load(registration)
      return { options, live: registrations }
    },
  }
  return { facade, registrations }
}
function bootPage(
  crypto: Record<string, unknown> = { getRandomValues: (array: Uint8Array) => array },
  transport: Record<string, unknown> = {},
  session: { context?: BootContext; search?: string; href?: string; boot?: unknown; loader?: unknown; store?: unknown; deferPaint?: boolean } = {},
) {
  StandInSocket.all = []
  const requests: Array<{ url: string; body?: string; method?: string }> = []
  const waiting: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void }> = []
  const clock = { now: 0 }
  const frames: Array<() => void> = []
  const timers: Array<{ delay: number; due: number; run: () => void; cancelled: boolean }> = []
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  const fire = (type: string, event: unknown) => { for (const listener of listeners.get(type) ?? []) listener(event) }
  const replacements: string[] = []
  const historyReplacements: string[] = []
  const NativeEventSource = class { constructor(readonly url: string, readonly init?: EventSourceInit) {} }
  const window: Record<string, any> = {
    fetch: (input: unknown, init?: { body?: string; method?: string }) => { requests.push({ url: String(input), body: init?.body, method: init?.method }); return new Promise<Response>((resolve, reject) => waiting.push({ resolve, reject })) },
    addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, [...listeners.get(type) ?? [], listener]) },
    dispatchEvent: (event: Event) => { fire(event.type, event); return true }, WebSocket: StandInSocket, EventSource: NativeEventSource, __DSH_TRANSPORT__: transport,
    __DSH_BOOT__: session.boot, __ModuleLoader__: session.loader, localStorage: session.store,
    requestAnimationFrame: (run: () => void) => { if (session.deferPaint) frames.push(run); else run() },
    history: { replaceState: (_state: unknown, _title: string, url: string) => { historyReplacements.push(url) } },
  }
  const elements: StandInElement[] = []
  const createElement = (tag: string): StandInElement => {
    const node = new StandInElement(tag.toUpperCase())
    elements.push(node)
    return node
  }
  const root = createElement('div'); root.id = 'root'
  const document = { documentElement: createElement('html'), head: createElement('head'), addEventListener: () => {}, getElementById: (id: string) => elements.find(node => node.id === id && node.parentElement) ?? null, createElement, body: createElement('body') }
  document.documentElement.append(document.head, document.body)
  document.body.append(root)
  let mutation: (() => void) | undefined
  const MutationObserver = class { constructor(listener: () => void) { mutation = listener } observe() {} disconnect() { mutation = undefined } }
  let reloads = 0
  const location = { href: session.href ?? 'https://rc.example/app?token=page-secret#credential', search: session.search ?? '?token=page-secret', origin: 'https://rc.example', protocol: 'https:', assign: () => {}, reload: () => { reloads++ }, replace: (href: string) => { replacements.push(href) } }
  new Function('window', 'document', 'location', 'crypto', 'setTimeout', 'clearTimeout', 'MutationObserver', 'navigator', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'performance', bootScript(session.context))(
    window, document, location, crypto,
    (run: () => void, delay: number) => { timers.push({ delay, due: clock.now + delay, run, cancelled: false }); return timers.length },
    (id: number) => { if (timers[id - 1]) timers[id - 1]!.cancelled = true },
    MutationObserver, { userAgent: 'test browser' }, 390, 844, 1, { now: () => clock.now },
  )
  /** Run every timer that is due, in order, including the ones a run schedules. */
  const advance = (ms: number): void => {
    clock.now += ms
    for (;;) {
      const due = timers.filter(timer => !timer.cancelled && timer.due <= clock.now).sort((left, right) => left.due - right.due)[0]
      if (!due) return
      due.cancelled = true
      due.run()
    }
  }
  const mountBoot = () => {
    const boot = createElement('div'); boot.dataset.dshBoot = ''
    const card = createElement('div'), spinner = createElement('div'), hint = createElement('p')
    spinner.dataset.dshBootSpinner = ''; hint.textContent = 'Loading plugins…'
    card.append(spinner, hint); boot.append(card); root.replaceChildren(boot); mutation?.()
    return { boot, spinner, card }
  }
  const stored = session.store as { getItem?: (key: string) => string | null; setItem?: (key: string, value: string) => void } | undefined
  return {
    window, NativeEventSource, requests, timers, sockets: StandInSocket.all, document, root, createElement, mountBoot, advance, clock,
    mutate: () => { mutation?.() }, frame: () => frames.splice(0).forEach(run => run()), reloads: () => reloads, replacements, historyReplacements,
    store: stored,
    fire,
    rejectRequest: () => waiting.shift()?.reject(new TypeError('Network unavailable')),
    report: () => { advance(8000); return JSON.parse(requests.filter(request => request.url === '/rc/boot-report').at(-1)!.body!) },
    answer: () => waiting.shift()?.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
    answerWith: (status: number, body: string) => waiting.shift()?.resolve(new Response(body, { status, headers: { 'content-type': 'application/json' } })),
    elements,
  }
}
/** The startup scene lives beside #root, so it survives the renderer replacement. */
const screenOf = (f: ReturnType<typeof bootPage>): StandInElement | undefined => f.document.body.children.find(node => node.id === 'dsh-rc-boot-screen')
const byClass = (node: StandInElement | undefined, name: string): StandInElement | undefined => {
  if (!node) return undefined
  for (const child of node.children) {
    if (child.className === name) return child
    const found = byClass(child, name)
    if (found) return found
  }
  return undefined
}
const lines = (f: ReturnType<typeof bootPage>) => {
  const screen = screenOf(f)
  return {
    screen,
    stage: byClass(screen, 'stage')?.textContent,
    count: byClass(screen, 'count')?.textContent,
    detail: byClass(screen, 'detail')?.textContent,
  }
}
const storage = (map: Map<string, string>) => ({
  getItem: (key: string) => map.get(key) ?? null,
  setItem: (key: string, value: string) => { map.set(key, value) },
})

it('shows the full-screen startup scene outside the root and leaves pointer input unblocked', () => {
  const f = bootPage()
  expect(f.document.body.children).toContain(screenOf(f))
  expect(lines(f).stage).toBe('正在检查插件变化…')
  expect(lines(f).detail).toBe('正在读取插件清单…')
  expect(screenOf(f)!.id).toBe('dsh-rc-boot-screen')
  const style = f.document.head.children.find(node => node.id === 'dsh-rc-boot-style')!.textContent
  expect(style).toContain('position:fixed;inset:0')
  expect(style).toContain('background:Canvas;color:CanvasText')
  expect(style).toContain("mask:url('/favicon.svg')")
  expect(style).toContain('color-scheme:light dark')
  expect(style).toContain('pointer-events:none')
  f.mountBoot()
  expect(lines(f).screen!.parentElement).toBe(f.document.body)
  expect(f.root.children).toHaveLength(1)
  expect(byClass(screenOf(f), 'track')!.attributes['data-pending']).toBe('true')
  expect(byClass(screenOf(f), 'fill')!.style.width).toBe('')
})

it('switches boot-only themes, restores the device preference, and removes controls at app mount', () => {
  const store = storage(new Map())
  const f = bootPage(undefined, {}, { store })
  const screen = screenOf(f)!
  const [system, light, dark] = byClass(screen, 'theme')!.children
  expect(system!.attributes['aria-pressed']).toBe('true')
  dark!.onclick!()
  expect(dark!.attributes['aria-pressed']).toBe('true')
  expect(screen.attributes['data-theme']).toBe('dark')
  const restored = bootPage(undefined, {}, { store })
  expect(screenOf(restored)!.attributes['data-theme']).toBe('dark')
  light!.onclick!()
  expect(screen.attributes['data-theme']).toBe('light')
  system!.onclick!()
  expect(screen.attributes['data-theme']).toBe('system')
  f.mountBoot()
  f.root.replaceChildren(f.createElement('main')); f.mutate()
  expect(byClass(screen, 'theme')).toBeUndefined()
})

it('states the stage without a count when the Host published no graph, and keeps the reload with its own error area', () => {
  const f = bootPage()
  f.advance(3000)
  expect(lines(f).stage).toBe('无法核对插件变化')
  expect(lines(f).count).toBe('')
  const { spinner, card } = f.mountBoot()
  spinner.remove(); card.textContent = 'Failed to load plugins'; f.mutate()
  expect(screenOf(f)).toBeUndefined()
  const status = f.root.querySelector('[data-dsh-rc-boot-status]')!
  expect(status.attributes.role).toBe('alert')
  expect(status.textContent).toContain('启动失败')
  expect(status.children.find(child => child.tagName === 'BUTTON')).toBeTruthy()
  expect(f.report()).toMatchObject({ phase: 'failed', result: 'failed', errors: expect.arrayContaining(['official-startup-failure']) })
})

it('counts the parser batch the HTML facade queued before the graph row arrived', async () => {
  const { facade } = hostFacade()
  const graph = bootGraph('r1', ['@deepseek-ai/dsh-client-modules', 'one', 'two'])
  // The facade only exists once its inline script has run, so the first observation finds nothing.
  const f = bootPage(undefined, {}, { store: storage(new Map()) })
  f.mutate()
  f.window.__ModuleLoader__ = facade
  facade.pendingQueue.push({ id: '@deepseek-ai/dsh-client-modules/client' }, { id: 'one/client' })
  f.mutate()
  expect(lines(f).count).toBe('')
  f.window.__DSH_BOOT__ = graph
  f.mutate()
  const { boot } = f.mountBoot()
  expect(boot.textContent).toContain('Loading plugins')
  facade.create({ boot: graph })
  expect(lines(f).stage).toBe('首次核对完成')
  const loading = f.window.__DSH_TRANSPORT__.loadBundle('/plugins/??one/client.js&rev=r1')
  f.advance(80)
  expect(lines(f).count).toBe('2 / 3 个模块')
  expect(byClass(screenOf(f), 'fill')!.style.width).toBe(2 / 3 * 100 + '%')
  createElementScript(f).fire('load')
  await loading
})

it('counts every entry of one combo once and never a package-local chunk', async () => {
  const { facade } = hostFacade()
  const graph = bootGraph('r1', ['one', 'two'], [{ phase: 'application', url: '/plugins/??one/client.js,two/client.js&rev=r1', entries: ['one', 'two'] }])
  const f = bootPage(undefined, {}, { boot: graph, loader: facade }); f.mountBoot()
  facade.create({ boot: graph })
  const loading = f.window.__DSH_TRANSPORT__.loadBundle('/plugins/??one/client.js,two/client.js&rev=r1')
  f.advance(400)
  expect(lines(f).count).toBe('0 / 2 个模块')
  expect(lines(f).detail).toBe('正在准备：one')
  facade.load({ id: 'one/client' })
  facade.load({ id: 'one/chunk-abc.js', chunk: 'chunk-abc.js' })
  facade.load({ id: 'one/client' })
  f.advance(80)
  expect(lines(f).count).toBe('1 / 2 个模块')
  expect(lines(f).detail).toBe('正在准备：two')
  createElementScript(f).fire('load')
  await loading
  f.advance(80)
  expect(lines(f).detail).toBe('刚完成：one')
  facade.load({ id: 'two/client' })
  f.advance(80)
  expect(lines(f).count).toBe('2 / 2 个模块')
  expect(lines(f).detail).toBe('刚完成：two')
})
function createElementScript(f: ReturnType<typeof bootPage>): StandInElement {
  return f.document.head.children.at(-1)!
}

it('keeps counting when a partially executed batch falls back to one package', async () => {
  const { facade } = hostFacade()
  const graph = bootGraph('r1', ['one', 'two'], [{ phase: 'application', url: '/plugins/??one/client.js,two/client.js&rev=r1', entries: ['one', 'two'] }])
  const f = bootPage(undefined, {}, { boot: graph, loader: facade }); f.mountBoot()
  facade.create({ boot: graph })
  const batch = f.window.__DSH_TRANSPORT__.loadBundle('/plugins/??one/client.js,two/client.js&rev=r1')
  facade.load({ id: 'one/client' })
  createElementScript(f).fire('load')
  await batch
  const fallback = f.window.__DSH_TRANSPORT__.loadBundle('/plugins/??two/client.js&rev=r1')
  facade.load({ id: 'two/client' })
  f.advance(80)
  expect(lines(f).count).toBe('2 / 2 个模块')
  createElementScript(f).fire('load')
  await fallback
})

it('uses a readable label for known DSH modules instead of their package identifiers', async () => {
  const { facade } = hostFacade()
  const graph = bootGraph('r1', ['@deepseek-ai/dsh-client-ui-theme'])
  const f = bootPage(undefined, {}, { boot: graph, loader: facade }); f.mountBoot()
  facade.create({ boot: graph })
  const loading = f.window.__DSH_TRANSPORT__.loadBundle('/plugins/??@deepseek-ai/dsh-client-ui-theme/client.js&rev=r1')
  f.advance(320)
  expect(lines(f).detail).toBe('正在准备：界面主题')
  facade.load({ id: '@deepseek-ai/dsh-client-ui-theme/client' })
  f.advance(80)
  expect(lines(f).count).toBe('1 / 1 个模块')
  expect(lines(f).detail).toBe('刚完成：界面主题')
  createElementScript(f).fire('load')
  await loading
})

it('compares the manifest revision and stores a baseline only after the Host took the page over', () => {
  const first = new Map<string, string>()
  const fresh = bootPage(undefined, {}, { boot: bootGraph('r1', ['one']), store: storage(first) }); fresh.mountBoot()
  expect(lines(fresh).stage).toBe('首次核对完成')
  expect(first.size).toBe(0)
  fresh.root.replaceChildren(fresh.createElement('main')); fresh.mutate()
  expect(first.get('dsh-rc-boot-graph')).toBe('r1')

  const same = bootPage(undefined, {}, { boot: bootGraph('r1', ['one']), store: storage(new Map([['dsh-rc-boot-graph', 'r1']])) })
  expect(lines(same).stage).toBe('插件清单未变化')
  const changed = bootPage(undefined, {}, { boot: bootGraph('r2', ['one']), store: storage(new Map([['dsh-rc-boot-graph', 'r1']])) })
  expect(lines(changed).stage).toBe('插件清单有变化')
  const denied = bootPage(undefined, {}, { boot: bootGraph('r1', ['one']), store: { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } } })
  expect(lines(denied).stage).toBe('已读取本次插件清单')
})

it('names the graph size and no denominator when the loader interface does not match', () => {
  const graph = bootGraph('r1', ['one', 'two'])
  const f = bootPage(undefined, {}, { boot: graph, loader: { mode: 'live', load() {}, create() { throw new Error('late') } } })
  f.mountBoot()
  f.advance(80)
  expect(lines(f).count).toBe('共 2 个模块')
  f.advance(400)
  expect(lines(f).count).toBe('共 2 个模块')
})

it('keeps the verdict for 320ms, then shows only the completion for 440ms before fading', () => {
  const map = new Map<string, string>()
  const f = bootPage(undefined, {}, { boot: bootGraph('r1', ['one']), store: storage(map) })
  f.mountBoot()
  f.advance(100)
  f.root.replaceChildren(f.createElement('main')); f.mutate()
  f.advance(219)
  expect(lines(f).stage).toBe('首次核对完成')
  f.advance(1)
  expect(lines(f).stage).toBe('✓ 启动完成')
  expect(lines(f).screen!.attributes['data-ready']).toBe('true')
  expect(byClass(lines(f).screen, 'track')!.style.display).toBe('none')
  expect(lines(f).detail).toBe('工作区已就绪')
  expect(lines(f).count).toBe('')
  f.advance(439)
  expect(lines(f).screen!.attributes['data-fade']).toBeUndefined()
  f.advance(1)
  expect(lines(f).screen!.attributes['data-fade']).toBe('true')
  f.advance(160)
  expect(screenOf(f)).toBeUndefined()
  expect(map.get('dsh-rc-boot-graph')).toBe('r1')
})

it('holds a late plugin-check verdict for 320ms from when it first appears', () => {
  const f = bootPage(undefined, {}, { store: storage(new Map()), deferPaint: true })
  f.advance(500)
  f.window.__DSH_BOOT__ = bootGraph('r1', ['one'])
  f.mutate()
  expect(lines(f).stage).toBe('首次核对完成')
  const { boot } = f.mountBoot()
  f.root.replaceChildren(f.createElement('main')); f.mutate()
  f.advance(1000)
  expect(lines(f).stage).toBe('首次核对完成')
  f.frame(); f.frame()
  f.advance(319)
  expect(lines(f).stage).toBe('首次核对完成')
  f.advance(1)
  expect(lines(f).stage).toBe('✓ 启动完成')
  expect(boot.textContent).toContain('Loading plugins')
})

it('uses a stationary indeterminate marker and no transitions for reduced motion', () => {
  const script = bootScript()
  expect(script).toContain('@media(prefers-reduced-motion:reduce)')
  expect(script).toContain('animation:dsh-rc-sweep 1.6s ease-in-out infinite')
  expect(script).toContain('transition:width 180ms ease-out')
  expect(script).toContain('pointer-events:none')
  expect(script).toContain("aria-live")
  expect(script).toContain('background:Canvas;color:CanvasText')
  expect(script).toContain('data-ready=true')
  expect(script).not.toContain('dsh-rc-pulse')
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

it('observes native script transport while leaving retry and fallback to the Host', async () => {
  const f = bootPage(), { boot } = f.mountBoot()
  const load = f.window.__DSH_TRANSPORT__.loadBundle as (url: string) => Promise<void>
  const first = load('/plugins/??one/client.js,two/client.js&rev=batch').catch(error => error)
  const script = f.document.head.children.at(-1)!
  expect(script.async).toBe(true)
  f.advance(80)
  expect(lines(f).stage).toBe('正在加载模块')
  script.fire('error')
  expect(await first).toBeInstanceOf(Error)
  expect(f.document.head.children.filter(node => node.tagName === 'SCRIPT')).toHaveLength(0)
  expect(f.elements.filter(element => element.tagName === 'SCRIPT')).toHaveLength(1)
  expect(boot.textContent).not.toContain('启动失败')
  const fallback = load('/plugins/??one/client.js&rev=one')
  createElementScript(f).fire('load')
  await fallback
  f.advance(80)
  expect(lines(f).stage).toBe('正在初始化插件')
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
  expect(f.document.head.children.filter(node => node.tagName === 'SCRIPT')).toHaveLength(0)
})

it('shows the reconnect status when a connected socket closes and its status check fails', async () => {
  const f = bootPage()
  const connection = new f.window.WebSocket('/api/remote.mux')
  connection.fire('open')
  connection.fire('close')
  f.rejectRequest()
  await new Promise(resolve => setImmediate(resolve))
  const banner = connectionStatus(f)!
  expect(banner.children.find(child => child.attributes.role === 'status')?.textContent).toBe('正在重新连接电脑…')
  const retry = banner.children.find(child => child.tagName === 'BUTTON')!
  expect(retry.textContent).toBe('正在重新连接…')
  expect(retry.attributes['aria-label']).toBe('正在重新连接，点击重试')
  f.fire('dsh-rc-offline', new Event('dsh-rc-offline'))
  expect(f.document.body.children.filter(element => element.id === banner.id)).toEqual([banner])
  retry.onclick!()
  expect(f.reloads()).toBe(1)
  new f.window.WebSocket('/api/remote.mux').fire('open')
  expect(banner.parentElement).toBeNull()
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

it('asks a revoked device to pair again in a modal without a reload action', async () => {
  const f = bootPage()
  f.fire('dsh-rc-offline', new Event('dsh-rc-offline'))
  const socket = new f.window.WebSocket('/api/remote.mux'); socket.fire('open'); socket.fire('close')
  f.answerWith(403, JSON.stringify({ code: 'unpaired' }))
  await settle()
  const modal = dialog(f.elements)!
  expect(modal.tagName).toBe('DIALOG')
  expect(modal.attributes.open).toBe('')
  expect(modal.attributes['aria-labelledby']).toBe('dsh-rc-disconnected-title')
  expect(modal.attributes['aria-describedby']).toBe('dsh-rc-disconnected-text')
  expect(modal.children.find(child => child.tagName === 'H2')?.textContent).toBe('设备授权已失效')
  expect(modal.children.find(child => child.tagName === 'P')?.textContent).toContain('扫描新的二维码')
  expect(modal.children.find(child => child.tagName === 'BUTTON')).toBeUndefined()
  f.fire('dsh-rc-offline', new Event('dsh-rc-offline'))
  expect(connectionStatus(f)).toBeUndefined()
})

const HOST_ID = '5QKQY_VIKcY52sBuej3ozcSh4gUAwAYe0YENr18qsfA'
const FINGERPRINT = 'e5029063f54829c639dac06e7a3de8cd'
const LAN_URL = 'http://192.168.1.9:59395'
const IDENTITY = { id: HOST_ID, fingerprint: FINGERPRINT }
const context = (): BootContext => ({ fallback: { node: IDENTITY, hostId: HOST_ID, fingerprint: FINGERPRINT, url: LAN_URL } })
const legacyContext = (): BootContext => ({ fallback: { node: null, hostId: HOST_ID, fingerprint: FINGERPRINT, url: LAN_URL } })
const v2OnlyContext = (): BootContext => ({ fallback: { node: IDENTITY, hostId: null, fingerprint: null, url: LAN_URL } })
const fallbackAnswer = () => ({ sameHost: true, node: IDENTITY, url: LAN_URL, hostId: HOST_ID, fingerprint: FINGERPRINT })
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setImmediate(resolve)) }
const dialog = (elements: StandInElement[]) => elements.find(node => node.id === 'dsh-rc-disconnected')
const connectionStatus = (f: ReturnType<typeof bootPage>) => f.document.getElementById('dsh-rc-connection-status') ?? undefined
const announcement = (f: ReturnType<typeof bootPage>) => connectionStatus(f)?.children.find(child => child.attributes.role === 'status')?.textContent

it('says it already switched to the LAN entry when the LAN page boots', () => {
  const f = bootPage(undefined, {}, { search: '?rc=lan', href: 'https://rc.example/?rc=lan' })
  expect(f.historyReplacements).toEqual(['/'])
  expect(announcement(f)).toBe('已切换到局域网')
  f.advance(2600)
  expect(connectionStatus(f)).toBeUndefined()
})

it('switches a paired browser to the same Host LAN entry when the public connection dies', async () => {
  const f = bootPage(undefined, {}, { context: context() })
  f.fire('dsh-rc-offline', new Event('dsh-rc-offline'))
  const timer = f.timers.at(-1)!
  expect(timer.delay).toBe(1500)
  timer.run()
  const request = f.requests.at(-1)!
  expect(request).toMatchObject({ url: '/rc/fallback', method: 'POST' })
  f.answerWith(200, JSON.stringify(fallbackAnswer()))
  await settle()
  expect(f.replacements).toEqual([`${LAN_URL}/?rc=lan`])
  expect(announcement(f)).toBe('正在重新连接电脑…')
  expect(dialog(f.elements)).toBeUndefined()
})

it('still follows a protocol-1 LAN gateway that only reports the flat host identity', async () => {
  const f = bootPage(undefined, {}, { context: legacyContext() })
  f.fire('dsh-rc-offline', new Event('dsh-rc-offline'))
  f.timers.at(-1)!.run()
  f.answerWith(200, JSON.stringify({ sameHost: true, url: LAN_URL, hostId: HOST_ID, fingerprint: FINGERPRINT }))
  await settle()
  expect(f.replacements).toEqual([`${LAN_URL}/?rc=lan`])
})

it('trusts the node identity over the flat compatibility aliases', async () => {
  const f = bootPage(undefined, {}, { context: v2OnlyContext() })
  f.fire('dsh-rc-offline', new Event('dsh-rc-offline'))
  f.timers.at(-1)!.run()
  f.answerWith(200, JSON.stringify({ ...fallbackAnswer(), hostId: 'A'.repeat(43), fingerprint: '0'.repeat(32) }))
  await settle()
  expect(f.replacements).toEqual([`${LAN_URL}/?rc=lan`])
})

it('cancels the fallback when the connection comes back first', async () => {
  const f = bootPage(undefined, {}, { context: context() })
  f.fire('dsh-rc-offline', new Event('dsh-rc-offline'))
  const timer = f.timers.at(-1)!
  f.fire('dsh-rc-online', new Event('dsh-rc-online'))
  expect(timer.cancelled).toBe(true)
  await settle()
  expect(f.requests).toHaveLength(0)
  expect(f.replacements).toEqual([])
})

it('never follows a LAN entry that reports another Host, another fingerprint or another address', async () => {
  for (const answer of [
    { sameHost: true, url: LAN_URL, hostId: 'A'.repeat(43), fingerprint: FINGERPRINT },
    { sameHost: true, url: LAN_URL, hostId: HOST_ID, fingerprint: '0'.repeat(32) },
    { sameHost: true, url: LAN_URL, node: { id: 'A'.repeat(43), fingerprint: FINGERPRINT }, hostId: HOST_ID, fingerprint: FINGERPRINT },
    { sameHost: true, url: LAN_URL, node: { id: HOST_ID, fingerprint: '0'.repeat(32) }, hostId: HOST_ID, fingerprint: FINGERPRINT },
    { sameHost: true, url: 'http://10.0.0.7:59395', hostId: HOST_ID, fingerprint: FINGERPRINT },
    { sameHost: false, reason: 'identity', url: LAN_URL, hostId: HOST_ID, fingerprint: FINGERPRINT },
  ]) {
    const f = bootPage(undefined, {}, { context: context() })
    f.fire('dsh-rc-offline', new Event('dsh-rc-offline'))
    f.timers.at(-1)!.run()
    f.answerWith(200, JSON.stringify(answer))
    await settle()
    expect(f.replacements).toEqual([])
    const modal = dialog(f.elements)!
    expect(modal.children.find(child => child.tagName === 'P')?.textContent).toContain('扫描新的二维码')
    const retry = modal.children.find(child => child.tagName === 'BUTTON')!
    expect(retry.textContent).toBe('重试当前入口')
    retry.onclick!()
    expect(f.reloads()).toBe(1)
  }
})

it('does not try a fallback when this page holds no same-host LAN entry', async () => {
  const f = bootPage()
  f.fire('dsh-rc-offline', new Event('dsh-rc-offline'))
  await settle()
  expect(f.requests).toHaveLength(0)
  expect(f.replacements).toEqual([])
})
