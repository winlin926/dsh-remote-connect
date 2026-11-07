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

it('leaves the Host mobile layout alone and only refuses the browser translate offer', () => {
  const script = bootScript()
  expect(script).toContain('__DSH_REMOTE_CONTROL__')
  expect(script).toContain('translate')
  // 0.2.2 owns the viewport, the theme colour, the document language and the keyboard policy.
  expect(script).not.toContain('interactive-widget')
  expect(script).not.toContain('dsh-rc-mobile')
  expect(script).toContain('__DSH_TRANSPORT__')
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
function bootPage(crypto: Record<string, unknown> = { getRandomValues: (array: Uint8Array) => array }) {
  StandInSocket.all = []
  const requests: Array<{ url: string; body?: string }> = []
  const waiting: Array<(response: Response) => void> = []
  const timers: Array<{ delay: number; run: () => void }> = []
  const NativeEventSource = class { constructor(readonly url: string, readonly init?: EventSourceInit) {} }
  const window: Record<string, any> = {
    fetch: (input: unknown, init?: { body?: string }) => { requests.push({ url: String(input), body: init?.body }); return new Promise<Response>(resolve => waiting.push(resolve)) },
    addEventListener: () => {}, dispatchEvent: () => true, WebSocket: StandInSocket, EventSource: NativeEventSource,
  }
  const elements: Array<Record<string, any>> = []
  const createElement = (tag: string): Record<string, any> => {
    const node: Record<string, any> = { tag, id: '', textContent: '', children: [], attributes: {} as Record<string, string>, style: {} as Record<string, string>, focused: false }
    node.setAttribute = (name: string, value: string) => { node.attributes[name] = value }
    node.append = (...nodes: unknown[]) => { node.children.push(...nodes) }
    node.focus = () => { node.focused = true }
    elements.push(node)
    return node
  }
  const document = { documentElement: { setAttribute: () => {} }, addEventListener: () => {}, getElementById: (id: string) => elements.find(node => node.id === id) ?? null, createElement, body: { append: () => {} } }
  const location = { href: 'https://rc.example/app', origin: 'https://rc.example', protocol: 'https:', assign: () => {}, reload: () => {} }
  new Function('window', 'document', 'location', 'crypto', 'setTimeout', 'clearTimeout', bootScript())(
    window, document, location, crypto,
    (run: () => void, delay: number) => timers.push({ delay, run }),
    () => {},
  )
  return {
    window, NativeEventSource, requests, timers, sockets: StandInSocket.all,
    answer: () => waiting.shift()?.(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
    answerWith: (status: number, body: string) => waiting.shift()?.(new Response(body, { status, headers: { 'content-type': 'application/json' } })),
    elements,
  }
}

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
