/** Runs before the remote app and the Host's client modules. No device or Host credential is embedded. */
import { localFilePath } from './local-file.js'

function remoteBoot(parseLocalFile: (href: string) => string | undefined): void {
  const globals = window as unknown as Record<string, any>
  globals.__DSH_REMOTE_CONTROL__ = true
  // The Host owns the document language, theme colour and keyboard policy since 0.2.2: a phone
  // gets its mobile layout from the Host itself. Only the browser's translate offer is ours to
  // refuse, because the app's own copy is what the reader is looking at.
  document.documentElement.setAttribute('translate', 'no')
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
    if (/\.html?$/i.test(path) || /\.svg$/i.test(path)) {
      // Open immediately: awaiting a fetch first would lose the tap's popup permission.
      // Both are documents; the gateway serves them under a sandbox CSP, so a blob URL
      // (which would inherit the gateway origin and drop that header) is never used.
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
      // A blob URL inherits the gateway origin, so the page opened from it must not hold a handle back.
      const opened = window.open(objectUrl, '_blank')
      if (opened) opened.opener = null
      // A tap grants popup permission on real browsers; where it is withheld, fall back to
      // navigating this tab — the file renders and the back button returns to the app.
      else location.assign(objectUrl)
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
    const box = document.getElementById('dsh-rc-boot-errors')
    if (!box) {
      const panel = document.createElement('div'); panel.id = 'dsh-rc-boot-errors'; panel.setAttribute('role', 'alert')
      panel.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-height:46%;overflow:auto;background:rgba(43,29,29,.96);color:#ffd9d9;font:11px/1.6 ui-monospace,Consolas,monospace;padding:10px 12px;border-top:2px solid #B34337;display:flex;flex-direction:column;gap:10px'
      const text = document.createElement('div'); text.id = 'dsh-rc-boot-errors-text'; text.style.cssText = 'white-space:pre-wrap;word-break:break-all'
      // Every boot asset is immutable and cached, so a reload refetches only what failed.
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试'
      retry.style.cssText = 'align-self:flex-start;padding:8px 20px;border:0;border-radius:999px;background:#B34337;color:#fff;font:inherit;cursor:pointer'
      retry.onclick = () => { retry.disabled = true; retry.textContent = '重试中…'; location.reload() }
      panel.append(text, retry)
      ;(document.body ?? document.documentElement).append(panel)
    }
    const text = document.getElementById('dsh-rc-boot-errors-text')
    if (text) text.textContent = bootErrors.join('\n———\n')
  }
  /** A combo URL carries fifty package ids: the head and the tail identify it, the middle only bloats the report. */
  const shorten = (url: string): string => url.length > 200 ? url.slice(0, 120) + '…' + url.slice(-40) + '（共 ' + url.length + ' 字节）' : url
  // One boot batch is several megabytes over Wi-Fi: a dropped connection is transient far more
  // often than the bytes are gone, and the revision makes the URL immutable, so a second fetch
  // of the same address is the whole repair.
  const RETRY_DELAYS = [400, 1500, 4000]
  const scriptAttempts = new Map<string, number>()
  const gaveUp = new Set<string>()
  const retryScript = (url: string): boolean => {
    const attempts = scriptAttempts.get(url) ?? 0
    if (attempts < RETRY_DELAYS.length) {
      scriptAttempts.set(url, attempts + 1)
      setTimeout(() => {
        // async=false keeps the retried batch registered before anything that follows it.
        const script = document.createElement('script'); script.src = url; script.async = false
        document.head.append(script)
      }, RETRY_DELAYS[attempts])
      return true
    }
    if (gaveUp.has(url)) return true
    gaveUp.add(url)
    // A HEAD has no body: the status alone separates a dropped Wi-Fi leg from a refused URL.
    void originalFetch(url, { method: 'HEAD', cache: 'no-store' })
      .then(response => response.status, () => 0)
      .then(status => {
        if (bootErrors.length < 8) bootErrors.push('资源加载失败: <script> ' + shorten(url) + '（重试 ' + attempts + ' 次后仍失败，最后 HTTP ' + (status || '无响应') + '）')
        showBootErrors(); scheduleReport(1500)
      })
    return true
  }
  // The browser reports a deferred ResizeObserver delivery through the error event.
  // Layout still settles on the next frame, so this is not a page failure.
  const deferredObservation = (message: string): boolean =>
    message === 'ResizeObserver loop completed with undelivered notifications.'
    || message === 'ResizeObserver loop limit exceeded'
  window.addEventListener('error', event => {
    const failure = event as ErrorEvent
    const target = event.target as (HTMLScriptElement & HTMLLinkElement & HTMLImageElement) | null
    // The retry owns its own reporting: a failed boot batch never spends the error budget.
    if (target?.tagName === 'SCRIPT' && target.src && retryScript(target.src)) return
    if (bootErrors.length >= 8) return
    // A missed <link rel=preload> costs one extra request, not the page: the <script> that needs
    // those bytes fetches them itself, so it must not raise the panel.
    if (target?.tagName === 'IMG' && target.src) {
      bootErrors.push(`资源加载失败: <img> ${shorten(target.src)}`)
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
    const notice = document.createElement('div'); notice.id = 'dsh-rc-disconnected'; notice.setAttribute('role', 'dialog'); notice.setAttribute('aria-modal', 'true')
    // The Host states its theme through color-scheme on the root element; fall back to the media query when it states none.
    const declared = getComputedStyle(document.documentElement).colorScheme.trim()
    const dark = declared === 'dark' || (declared !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
    notice.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:${dark ? 'rgba(36,35,33,.97)' : 'rgba(250,249,245,.97)'};display:flex;align-items:center;justify-content:center;padding:24px;font:16px/1.7 system-ui,sans-serif;text-align:center;color:${dark ? '#F0EEE8' : '#292724'}`
    const box = document.createElement('div'), text = document.createElement('p'), retry = document.createElement('button')
    text.id = 'dsh-rc-disconnected-text'; text.textContent = message; retry.textContent = '重新连接'; retry.onclick = () => location.reload()
    notice.setAttribute('aria-labelledby', text.id)
    retry.style.cssText = 'padding:12px 20px;border:0;border-radius:999px;background:#D97757;color:#fff;font:inherit'
    box.append(text, retry); notice.append(box); (document.body ?? document.documentElement).append(notice)
    // The overlay covers the page, so the keyboard and the screen reader start on its only action.
    retry.focus()
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
  /** One revocation probe at a time: a phone that reconnects in a loop closes faster than the Host answers. */
  let probing: Promise<unknown> | undefined
  const probeAuthorization = (): void => {
    if (probing) return
    probing = originalFetch('/api/dsh-remote-connect/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status' }) }).then(async response => {
      if (await unpaired(response)) disconnected('设备授权已撤销，远程连接已断开。请重新扫码。')
    }).catch(() => window.dispatchEvent(new Event('dsh-rc-offline'))).finally(() => { probing = undefined })
  }
  globals.WebSocket = class extends OriginalSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      // Only a socket that reached the Host says anything about the authorization, and the SSE
      // carrier reconnects by design, so probing it would be a heartbeat request of its own.
      const carrier = /\/rc\/sse(?:[?#]|$)/.test(String(url))
      let opened = false
      this.addEventListener('open', () => { opened = true; window.dispatchEvent(new Event('dsh-rc-online')) })
      this.addEventListener('close', () => { if (opened && !carrier) probeAuthorization() })
    }
  }
  if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value: () => '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (Number(c) ^ crypto.getRandomValues(new Uint8Array(1))[0]! & 15 >> Number(c) / 4).toString(16)), writable: true, configurable: true })
  // EventSource uses one authenticated WS carrier for both LAN and fixed-domain connections.
  const NativeSocket = window.WebSocket
  const NativeEventSource = globals.EventSource
  class RemoteEventSource extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2
    readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSED = 2
    readyState = 0; url: string; withCredentials: boolean
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    private socket?: WebSocket; private timer?: ReturnType<typeof setTimeout>
    private buffer = ''; private lastId = ''; private retry = 3000; private backoff = 0
    constructor(url: string | URL, init?: EventSourceInit) {
      super(); this.url = new URL(String(url), location.href).href; this.withCredentials = init?.withCredentials ?? false
      // The carrier only carries this origin. Anywhere else the browser's own EventSource owns the
      // cross-origin rules: it reports a refusal as an error event and honours CORS.
      if (new URL(this.url).origin !== location.origin) return new NativeEventSource(url, init)
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
        if (frame.type === 'ready') { this.readyState = 1; this.backoff = 0; this.emit('open', new Event('open')); return }
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
      // A sleeping computer or a restarting Host comes back in minutes, not in one fixed interval:
      // every failed attempt waits twice as long as the one before, up to 30s, and a live
      // connection resets the wait.
      socket.onclose = () => { if (this.readyState !== 2) { this.readyState = 0; this.buffer = ''; this.backoff = Math.min(30000, this.backoff ? this.backoff * 2 : this.retry); this.timer = setTimeout(() => this.connect(), this.backoff) } }
    }
    close(): void { this.readyState = 2; clearTimeout(this.timer); this.socket?.close() }
  }
  globals.EventSource = RemoteEventSource
}
/** The Host reads this same string every request, so it stays one self-contained function. */
export function bootScript(): string {
  return `(${remoteBoot.toString()})(${localFilePath.toString()});`
}
/** The boot script is a same-origin file, not an inline script, so a Host CSP cannot block it. */
export const BOOT_PATH = '/rc/boot.js'
const BOOT_TAG = `<script src="${BOOT_PATH}"></script>`
export function injectBoot(html: string): string {
  // Android keeps the 980px fallback layout when a script runs before the viewport meta.
  const viewport = /<meta\b[^>]*\bname=["']viewport["'][^>]*>/i.exec(html)
  if (viewport) return html.slice(0, viewport.index + viewport[0].length) + BOOT_TAG + html.slice(viewport.index + viewport[0].length)
  return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}<meta name="viewport" content="width=device-width, initial-scale=1">${BOOT_TAG}`)
}

