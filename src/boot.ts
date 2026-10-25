/** Runs before the remote app and the Host's client modules. No device or Host credential is embedded. */
import { localFilePath } from './local-file.js'

function remoteBoot(parseLocalFile: (href: string) => string | undefined): void {
  const globals = window as unknown as Record<string, any>
  globals.__DSH_REMOTE_CONTROL__ = true
  // The Host's page declares English; the app is Chinese, and browsers would offer to translate it.
  document.documentElement.lang = 'zh-CN'; document.documentElement.setAttribute('translate', 'no')
  globals.__DSH_TRANSPORT__ = { ...globals.__DSH_TRANSPORT__, ownsHost: true }
  const originalFetch = window.fetch.bind(window)
  globals.__DSH_FILE_UPLOAD__ = { fetch: originalFetch }
  function notice(message: string): void {
    const existing = document.getElementById('dsh-rc-notice')
    if (existing) existing.remove()
    const toast = document.createElement('div'); toast.id = 'dsh-rc-notice'; toast.setAttribute('role', 'status')
    toast.style.cssText = 'position:fixed;left:50%;top:20px;transform:translateX(-50%);z-index:2147483647;max-width:min(86vw,420px);padding:10px 16px;border-radius:999px;background:#242938;color:#fff;font:13px/1.6 system-ui,sans-serif;text-align:center;box-shadow:0 8px 28px #00000047'
    toast.textContent = message
    ;(document.body ?? document.documentElement).append(toast)
    setTimeout(() => toast.remove(), 2600)
  }
  /** Open computer files on the remote device instead of invoking the Desktop handler. */
  async function openLocalFile(href: string): Promise<void> {
    const path = parseLocalFile(href)
    if (!path) { notice('链接不是本机文件路径。'); return }
    if (/\.html?$/i.test(path)) {
      // Open immediately: awaiting a fetch first would lose the tap's popup permission.
      const address = '/rc/workspace-file?p=' + encodeURIComponent(path)
      const preview = window.open(address, '_blank')
      if (preview) preview.opener = null
      else location.assign(address)
      return
    }
    try {
      const response = await originalFetch('/rc/workspace-file?p=' + encodeURIComponent(path), { cache: 'no-store' })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        notice((data as { error?: string } | null)?.error ?? `无法读取文件（HTTP ${response.status}）。`)
        return
      }
      const objectUrl = URL.createObjectURL(await response.blob())
      // A tap grants popup permission on real browsers; where it is withheld, fall back to
      // navigating this tab — the file renders and the back button returns to the app.
      if (!window.open(objectUrl, '_blank')) location.assign(objectUrl)
      setTimeout(() => URL.revokeObjectURL(objectUrl), 120000)
    } catch { notice('读取文件失败，请检查电脑上的远程连接。') }
  }
  document.addEventListener('click', event => {
    const target = event.target as Element | null
    const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? ''
    if (!/^file:/i.test(href)) return
    event.preventDefault(); event.stopImmediatePropagation()
    void openLocalFile(anchor.href)
  }, true)
  /** Phone-only diagnosis: a page that dies before the app mounts would be a blank white
   *  screen with no way to see why, so the first failures surface right on the page. */
  const bootErrors: string[] = []
  const showBootErrors = (): void => {
    if (document.getElementById('dsh-rc-boot-errors')) return
    const box = document.createElement('div'); box.id = 'dsh-rc-boot-errors'; box.setAttribute('role', 'alert')
    box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-height:46%;overflow:auto;background:rgba(43,29,29,.96);color:#ffd9d9;font:11px/1.6 ui-monospace,Consolas,monospace;padding:10px 12px;white-space:pre-wrap;word-break:break-all;border-top:2px solid #B34337'
    box.textContent = bootErrors.join('\n———\n')
    ;(document.body ?? document.documentElement).append(box)
  }
  // The browser reports a deferred ResizeObserver delivery through the error event.
  // Layout still settles on the next frame, so this is not a page failure.
  const deferredObservation = (message: string): boolean =>
    message === 'ResizeObserver loop completed with undelivered notifications.'
    || message === 'ResizeObserver loop limit exceeded'
  window.addEventListener('error', event => {
    if (bootErrors.length >= 8) return
    const failure = event as ErrorEvent
    const target = event.target as (HTMLScriptElement & HTMLLinkElement & HTMLImageElement) | null
    if (target && target.tagName && (target.tagName === 'SCRIPT' || target.tagName === 'LINK' || target.tagName === 'IMG') && (target.src || target.href)) {
      const url = target.src || target.href || ''
      bootErrors.push(`资源加载失败: <${target.tagName.toLowerCase()}> ${url}`)
    } else if (failure.message && !deferredObservation(failure.message)) {
      bootErrors.push(`JS 错误: ${failure.message}\n  at ${(failure.filename || '?').split('/').pop()}:${failure.lineno}`)
    } else return
    showBootErrors()
    scheduleReport(1500)
  }, true)
  window.addEventListener('unhandledrejection', event => {
    if (bootErrors.length >= 8) return
    bootErrors.push(`Promise 拒绝: ${String((event as PromiseRejectionEvent).reason).slice(0, 400)}`)
    showBootErrors()
    scheduleReport(1500)
  })
  /** Phone-only boot failures can't be debugged from a screenshot: one small report per page
   *  load lands in the computer's storage, whatever pairing state the device ends up in. */
  let reported = 0
  let reportTimer: ReturnType<typeof setTimeout> | undefined
  const sendReport = (): void => {
    if (reported >= 3) return
    reported += 1
    const root = document.getElementById('root')
    void originalFetch('/rc/boot-report', {
      method: 'POST', keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        href: location.href, viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
        ua: navigator.userAgent, mounted: !!root?.children.length, errors: bootErrors.slice(0, 8),
      }),
    }).catch(() => { /* diagnostics must never disturb the page */ })
  }
  const scheduleReport = (delay: number): void => {
    if (reported >= 3) return
    clearTimeout(reportTimer)
    reportTimer = setTimeout(sendReport, delay)
  }
  scheduleReport(8000)
  function disconnected(message: string): void {
    if (document.getElementById('dsh-rc-disconnected')) return
    const notice = document.createElement('div'); notice.id = 'dsh-rc-disconnected'; notice.setAttribute('role', 'alert')
    const theme = document.documentElement.dataset.rcTheme
    const dark = theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches)
    notice.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:${dark ? 'rgba(36,35,33,.97)' : 'rgba(250,249,245,.97)'};display:flex;align-items:center;justify-content:center;padding:24px;font:16px/1.7 system-ui,sans-serif;text-align:center;color:${dark ? '#F0EEE8' : '#292724'}`
    const box = document.createElement('div'), text = document.createElement('p'), retry = document.createElement('button')
    text.textContent = message; retry.textContent = '重新连接'; retry.onclick = () => location.reload()
    let accent = ''
    try { accent = localStorage.getItem('dsrc-accent') ?? '' } catch { /* storage unavailable: default colour */ }
    const fill = accent === 'blue' ? '#3D63E6' : accent === 'black' ? (dark ? '#F0EEE8' : '#1F1E1D') : '#D97757'
    retry.style.cssText = `padding:12px 20px;border:0;border-radius:999px;background:${fill};color:${accent === 'black' && dark ? '#242321' : '#fff'};font:inherit`
    box.append(text, retry); notice.append(box); (document.body ?? document.documentElement).append(notice)
  }
  /** The gateway's own refusal. A 403 from the Host (a path it will not read, say) is an ordinary error. */
  async function unpaired(response: Response): Promise<boolean> {
    if (response.status !== 403 || !response.headers.get('content-type')?.includes('application/json')) return false
    try { return (await response.clone().json())?.code === 'unpaired' } catch { return false }
  }
  window.fetch = async (...args) => {
    const response = await originalFetch(...args)
    if (new URL(String(args[0] instanceof Request ? args[0].url : args[0]), location.href).origin === location.origin && await unpaired(response)) disconnected('设备授权已失效或撤销，请重新扫码并在电脑上确认。')
    return response
  }
  const OriginalSocket = window.WebSocket
  globals.WebSocket = class extends OriginalSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      this.addEventListener('open', () => window.dispatchEvent(new Event('dsh-rc-online')))
      this.addEventListener('close', () => {
        void originalFetch('/api/dsh-remote-control/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status' }) }).then(async response => {
          if (await unpaired(response)) disconnected('设备授权已撤销，远程连接已断开。请重新扫码。')
        }).catch(() => window.dispatchEvent(new Event('dsh-rc-offline')))
      })
    }
  }
  if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value: () => '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (Number(c) ^ crypto.getRandomValues(new Uint8Array(1))[0]! & 15 >> Number(c) / 4).toString(16)) })
  // EventSource uses one authenticated WS carrier for both LAN and fixed-domain connections.
  const NativeSocket = window.WebSocket
  class RemoteEventSource extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2
    readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSED = 2
    readyState = 0; url: string; withCredentials: boolean
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    private socket?: WebSocket; private timer?: ReturnType<typeof setTimeout>
    private buffer = ''; private lastId = ''; private retry = 3000
    constructor(url: string | URL, init?: EventSourceInit) {
      super(); this.url = new URL(String(url), location.href).href; this.withCredentials = init?.withCredentials ?? false
      if (new URL(this.url).origin !== location.origin) throw new Error('远程 EventSource 仅允许同源地址。')
      this.connect()
    }
    private emit(type: string, event: Event): void {
      this.dispatchEvent(event)
      const callback = type === 'open' ? this.onopen : type === 'error' ? this.onerror : type === 'message' ? this.onmessage : undefined
      callback?.call(this, event as MessageEvent)
    }
    private connect(): void {
      if (this.readyState === 2) return
      const url = new URL('/rc/sse', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const source = new URL(this.url); url.searchParams.set('path', source.pathname + source.search)
      if (this.lastId) url.searchParams.set('lastEventId', this.lastId)
      const socket = this.socket = new NativeSocket(url)
      socket.onmessage = event => {
        const frame = JSON.parse(event.data)
        if (frame.type === 'ready') { this.readyState = 1; this.emit('open', new Event('open')); return }
        if (frame.type === 'error') { this.close(); this.emit('error', new Event('error')); return }
        if (frame.type !== 'chunk') return
        this.buffer += frame.data
        let match: RegExpExecArray | null
        while ((match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer))) {
          const text = this.buffer.slice(0, match.index); this.buffer = this.buffer.slice(match.index + match[0].length)
          let type = 'message'; const data: string[] = []
          for (const line of text.split(/\r\n|\r|\n/)) {
            const colon = line.indexOf(':'); const field = colon < 0 ? line : line.slice(0, colon); const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
            if (field === 'data') data.push(value)
            else if (field === 'event') type = value || 'message'
            else if (field === 'id' && !value.includes('\0')) this.lastId = value
            else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Math.min(30000, Math.max(500, Number(value)))
          }
          if (data.length) this.emit(type, new MessageEvent(type, { data: data.join('\n'), lastEventId: this.lastId, origin: location.origin }))
        }
      }
      socket.onerror = () => this.emit('error', new Event('error'))
      socket.onclose = () => { if (this.readyState !== 2) { this.readyState = 0; this.buffer = ''; this.timer = setTimeout(() => this.connect(), this.retry) } }
    }
    close(): void { this.readyState = 2; clearTimeout(this.timer); this.socket?.close() }
  }
  globals.EventSource = RemoteEventSource
}
export const BOOT_SCRIPT = `(${remoteBoot.toString()})(${localFilePath.toString()});`
export function injectBoot(html: string): string {
  const script = `<script>${BOOT_SCRIPT.replace(/<\/script/gi, '<\\/script')}</script>`
  // Android keeps the 980px fallback layout when a script runs before the viewport meta.
  const viewport = /<meta\b[^>]*\bname=["']viewport["'][^>]*>/i.exec(html)
  if (viewport) return html.slice(0, viewport.index + viewport[0].length) + script + html.slice(viewport.index + viewport[0].length)
  return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}<meta name="viewport" content="width=device-width, initial-scale=1">${script}`)
}

