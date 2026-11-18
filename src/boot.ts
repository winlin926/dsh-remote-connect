/** Runs before the remote app and the Host's client modules. No device or Host credential is embedded. */
import { localFilePath } from './local-file.js'

/** The same computer's LAN entry, injected only into a paired device's public page. */
export interface LanFallback {
  /** Protocol-2 node identity the page must see in the answer; null when only flat aliases were known. */
  node: { id: string; fingerprint: string } | null
  /** Protocol-1 aliases, kept for an answer that only names the old flat fields. */
  hostId: string | null
  fingerprint: string | null
  url: string
}
export interface BootContext { fallback: LanFallback }

function remoteBoot(parseLocalFile: (href: string) => string | undefined, context: BootContext | null): void {
  const globals = window as unknown as Record<string, any>
  globals.__DSH_REMOTE_CONTROL__ = true
  // The Host owns the document language, theme colour and keyboard policy since 0.2.2: a phone
  // gets its mobile layout from the Host itself. Only the browser's translate offer is ours to
  // refuse, because the app's own copy is what the reader is looking at.
  document.documentElement.setAttribute('translate', 'no')
  // A page reached through the same-host fallback says so once, then drops the marker from the address.
  if (new URLSearchParams(location.search || '').get('rc') === 'lan') {
    try {
      const clean = new URL(location.href)
      clean.searchParams.delete('rc')
      window.history?.replaceState?.(null, '', clean.pathname + clean.search + clean.hash)
    } catch { /* the notice still shows if the address cannot be rewritten */ }
    notice('已切换到局域网')
  }
  const transport = globals.__DSH_TRANSPORT__ ?? {}
  globals.__DSH_TRANSPORT__ = transport
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
  const started = performance.now()
  let phase: 'checking' | 'loading' | 'initializing' | 'ready' | 'failed' = 'checking'
  let result: 'unknown' | 'pending' | 'ready' | 'failed' = 'unknown'
  let observedBoot = false, loading = 0, completedResources = 0
  const errors: string[] = []
  const resources: Array<{ origin: string; path: string; rev?: string; result: 'loaded' | 'error'; durationMs: number }> = []
  const resourceAddress = (value: string): { origin: string; path: string; rev?: string } => {
    try {
      const url = new URL(value, location.href), rev = url.searchParams.get('rev')
      return { origin: url.origin.slice(0, 120), path: url.pathname.slice(0, 160), ...rev && /^[\w-]{1,64}$/.test(rev) ? { rev } : {} }
    } catch { return { origin: '', path: '' } }
  }
  const recordError = (message: string): void => { if (errors.length < 6 && !errors.includes(message)) errors.push(message) }
  let reported = 0
  let reportTimer: ReturnType<typeof setTimeout> | undefined
  const sendReport = (): void => {
    if (reported >= 3) return
    reported += 1
    const report = {
      ...resourceAddress(location.href), viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
      ua: navigator.userAgent.slice(0, 300), phase, result, mounted: result === 'ready',
      durationMs: Math.max(0, Math.round(performance.now() - started)), completedResources,
      resources: resources.slice(), errors: errors.slice(),
    }
    let payload = JSON.stringify(report)
    // The gateway accepts 8 KiB; non-ASCII paths can use three bytes per character.
    while (new TextEncoder().encode(payload).length > 7000 && (report.resources.length || report.errors.length)) {
      if (report.resources.length) report.resources.shift(); else report.errors.pop()
      payload = JSON.stringify(report)
    }
    void originalFetch('/rc/boot-report', {
      method: 'POST', keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: payload,
    }).catch(() => { /* diagnostics must never disturb the page */ })
  }
  const scheduleReport = (delay: number): void => {
    if (reported >= 3) return
    clearTimeout(reportTimer)
    reportTimer = setTimeout(sendReport, delay)
  }
  // -------------------------------------------------------------- startup progress
  const STORE_KEY = 'dsh-rc-boot-graph'
  const SCREEN_CSS = `#dsh-rc-boot-screen{position:fixed;inset:0;z-index:2147483645;display:grid;place-items:center;padding:max(24px,env(safe-area-inset-top)) 24px max(24px,env(safe-area-inset-bottom));background:Canvas;color:CanvasText;color-scheme:inherit;font:14px/1.5 system-ui,sans-serif;pointer-events:none;transition:background-color 160ms ease-out}
#dsh-rc-boot-screen .content{display:flex;width:min(100%,340px);flex-direction:column;align-items:center;text-align:center;transition:opacity 160ms ease-out}
#dsh-rc-boot-screen .whale{width:72px;height:72px;background:CanvasText;-webkit-mask:url('./favicon.svg') center/contain no-repeat;mask:url('./favicon.svg') center/contain no-repeat}
#dsh-rc-boot-screen .eyebrow{margin-top:28px;color:GrayText;font-size:11px;letter-spacing:.16em;line-height:1;text-transform:uppercase}
#dsh-rc-boot-screen .stage{margin-top:28px;font-size:20px;font-weight:500}
#dsh-rc-boot-screen .count{min-height:20px;margin-top:8px;font-size:14px;font-variant-numeric:tabular-nums}
#dsh-rc-boot-screen .detail{min-height:24px;margin-top:3px;color:GrayText;font-size:13px}
#dsh-rc-boot-screen .track{position:relative;width:min(100%,280px);height:4px;margin-top:24px;overflow:hidden;border-radius:9px;background:color-mix(in srgb,CanvasText 12%,Canvas)}
#dsh-rc-boot-screen .fill{position:absolute;inset:0;background:CanvasText;transform:scaleX(0);transform-origin:left;transition:transform 180ms ease-out}
#dsh-rc-boot-screen .sweep{position:absolute;top:0;bottom:0;width:28%;background:linear-gradient(90deg,transparent,color-mix(in srgb,Canvas 70%,transparent),transparent);animation:dsh-rc-sweep 1.6s ease-in-out infinite}
#dsh-rc-boot-screen .hint{margin-top:20px;color:GrayText;font-size:11px}
#dsh-rc-boot-screen[data-ready=true]{background:transparent}
#dsh-rc-boot-screen[data-ready=true] .track{display:none}
#dsh-rc-boot-screen[data-fade=true] .content{opacity:0}
#dsh-rc-boot-live{position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@keyframes dsh-rc-sweep{from{transform:translateX(-110%)}to{transform:translateX(470%)}}
@media(prefers-reduced-motion:reduce){#dsh-rc-boot-screen .sweep{animation:none}#dsh-rc-boot-screen .fill,#dsh-rc-boot-screen .content{transition:none}}`
  type Graph = { rev: string; entries: Array<{ id: string; url: string }>; batches: Array<{ url: string; entries: string[] }> }
  /** The Host resolves `<package>/client` and its package onto one graph row. */
  const bare = (spec: string): string => (spec.endsWith('/client') ? spec.slice(0, -7) : spec)
  const addr = (value: string): string => {
    try { const url = new URL(value, location.href); url.searchParams.delete('rev'); return url.href } catch { return value }
  }
  const rowAt = new Map<string, number>(), batchAt = new Map<string, number[]>(), singleAt = new Map<string, number>()
  const registered = new Set<number>()
  const early: unknown[] = [], inFlight: string[] = []
  const timers: Record<string, ReturnType<typeof setTimeout> | undefined> = {}
  const screen: Record<string, HTMLElement | null> = {}
  const VERDICT: Record<string, string> = { same: '插件清单未变化', changed: '插件清单有变化', first: '首次核对完成', unavailable: '已读取本次插件清单', unknown: '无法核对插件变化' }
  let graph: Graph | null = null, check: 'pending' | 'same' | 'changed' | 'first' | 'unavailable' | 'unknown' = 'pending'
  let counting: 'unknown' | 'watching' | 'absent' = 'unknown', wrapped = false, completed = false, said = ''
  let recent: number[] = [], newest = -1, shownCheck = '', checkShownAt = 0
  const write = (node: HTMLElement | null | undefined, text: string): void => { if (node && node.textContent !== text) node.textContent = text }
  const node = (tag: string, cls: string, parent?: HTMLElement): HTMLElement => {
    const made = document.createElement(tag) as HTMLElement
    made.className = cls
    if (parent) parent.append(made)
    return made
  }
  /** This navigation's graph, or null unless the Host published one this page can count against. */
  const readGraph = (wire: unknown): Graph | null => {
    if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return null
    const value = wire as { rev?: unknown; entries?: unknown; batches?: unknown }
    if (typeof value.rev !== 'string' || !value.rev || !Array.isArray(value.entries)) return null
    const entries: Graph['entries'] = [], seen = new Set<string>()
    for (const row of value.entries as Array<{ id?: unknown; url?: unknown }>) {
      if (!row || typeof row.id !== 'string' || !row.id || typeof row.url !== 'string' || !row.url || seen.has(row.id)) return null
      seen.add(row.id); entries.push({ id: row.id, url: row.url })
    }
    return { rev: value.rev, entries, batches: (Array.isArray(value.batches) ? value.batches : []) as Graph['batches'] }
  }
  /** Only a Host that took the page over leaves a baseline, so a broken boot is retried as broken. */
  const baseline = (): string | null | false => {
    try { const store = (window as unknown as { localStorage?: Storage }).localStorage; return store ? store.getItem(STORE_KEY) : false } catch { return false }
  }
  const remember = (): void => { try { if (graph) (window as unknown as { localStorage?: Storage }).localStorage?.setItem(STORE_KEY, graph.rev) } catch { /* a page without storage keeps no baseline */ } }
  const observe = (registration: unknown): void => {
    if (!graph) { if (early.length < 1000) early.push(registration); return }
    const value = registration as { id?: unknown; chunk?: unknown }
    if (typeof value?.id !== 'string' || value.chunk !== undefined) return
    const at = rowAt.get(bare(value.id))
    if (at === undefined || registered.has(at)) return
    registered.add(at); recent.push(at); scheduleProgress()
  }
  const moduleName = (id: string): string => ({
    '@deepseek-ai/dsh-client-connection': '连接服务',
    '@deepseek-ai/dsh-client-ui-settings': '界面设置',
    '@deepseek-ai/dsh-client-ui-sidebar': '会话侧栏',
    '@deepseek-ai/dsh-client-ui-theme': '界面主题',
  }[id] ?? id.replace(/^@[^/]+\//, '').replace(/^dsh-client-/, '').replace(/-/g, ' '))
  const inFlightName = (): string => {
    if (!graph) return ''
    for (const url of inFlight) for (const at of batchAt.get(url) ?? (singleAt.has(url) ? [singleAt.get(url)!] : [])) if (!registered.has(at)) return '正在准备：' + moduleName(graph.entries[at]!.id)
    return newest < 0 ? '' : '刚完成：' + moduleName(graph.entries[newest]!.id)
  }
  const adopt = (snapshot: Graph | null): void => {
    if (!snapshot || graph) return
    graph = snapshot
    snapshot.entries.forEach((row, index) => rowAt.set(bare(row.id), index))
    for (const batch of snapshot.batches) {
      if (typeof batch?.url !== 'string' || !Array.isArray(batch.entries)) continue
      const positions = batch.entries.map(id => rowAt.get(bare(id))).filter((index): index is number => index !== undefined)
      if (positions.length) batchAt.set(addr(batch.url), positions)
    }
    // A batch that already executed without one row is retried once as that row's own bundle.
    for (const row of snapshot.entries) if (!singleAt.has(addr(row.url))) singleAt.set(addr(row.url), rowAt.get(bare(row.id))!)
    const kept = baseline()
    check = kept === false ? 'unavailable' : kept === null ? 'first' : kept === snapshot.rev ? 'same' : 'changed'
    for (const registration of early.splice(0)) observe(registration)
    paint()
  }
  const ensureScreen = (): void => {
    if (screen.root) return
    const style = document.createElement('style'); style.id = 'dsh-rc-boot-style'; style.textContent = SCREEN_CSS
    const root = node('div', ''); root.id = 'dsh-rc-boot-screen'
    const content = node('div', 'content', root)
    node('div', 'whale', content)
    const eyebrow = node('div', 'eyebrow', content); eyebrow.textContent = 'DSH'
    const live = node('div', ''); live.id = 'dsh-rc-boot-live'
    live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite')
    screen.root = root; screen.stage = node('div', 'stage', content); screen.count = node('div', 'count', content); screen.detail = node('div', 'detail', content)
    screen.track = node('div', 'track', content); screen.fill = node('div', 'fill', screen.track); screen.sweep = node('div', 'sweep', screen.track); screen.live = live
    const hint = node('div', 'hint', content); hint.textContent = '正在准备工作区'
    const host = document.body ?? document.documentElement
    host.append(live, root); document.head.append(style)
  }
  const removeScreen = (): void => { screen.root?.remove(); screen.live?.remove(); screen.root = null; screen.live = null }
  /** One writer, so no two paths can disagree about what the page shows. */
  const paint = (): void => {
    const root = screen.root
    if (!root) return
    clearTimeout(timers.progress); timers.progress = undefined
    const host = document.body ?? document.documentElement
    if (root.parentElement !== host) host.append(root)
    if (recent.length) { newest = Math.min(...recent); recent = [] }
    const total = graph?.entries.length ?? 0, counted = counting === 'watching' && total > 0
    const done = registered.size, settled = check !== 'pending'
    if (settled && shownCheck !== check) { shownCheck = check; checkShownAt = performance.now() }
    const holding = settled && performance.now() < checkShownAt + 320
    let stage = '', count = '', detail = ''
    const partial = completed && counted && done < total
    if (completed) {
      stage = partial ? '已就绪 · 部分模块未加载' : '✓ 启动完成'
      detail = partial ? done + ' / ' + total + ' 个模块已就绪' : '工作区已就绪'
    } else if (phase === 'loading' || phase === 'initializing') {
      stage = phase === 'loading' ? '正在加载模块' : '正在初始化插件'
      if (counted) count = done + ' / ' + total + ' 个模块'
      else if (graph) count = '共 ' + total + ' 个模块'
      if (!settled) detail = '正在检查插件变化…'
      else if (holding) detail = VERDICT[check] ?? '无法核对插件变化'
      else if (phase === 'loading') detail = inFlightName()
      else detail = '正在接管工作区…'
    } else if (!settled) { stage = '正在检查插件变化…'; detail = '正在读取插件清单…'; if (graph) count = total ? '共 ' + total + ' 个模块' : '无需加载模块' }
    else { stage = VERDICT[check] ?? '无法核对插件变化'; if (graph) count = total ? '共 ' + total + ' 个模块' : '无需加载模块' }
    write(screen.stage, stage); write(screen.count, count); write(screen.detail, detail)
    if (screen.track) screen.track.style.display = completed || (graph && !total) ? 'none' : 'block'
    if (screen.fill) { screen.fill.style.display = counted && !completed ? 'block' : 'none'; screen.fill.style.transform = 'scaleX(' + (counted ? done / total : 0) + ')' }
    if (screen.sweep) { screen.sweep.style.display = completed ? 'none' : 'block'; screen.sweep.style.left = counted ? done / total * 100 + '%' : '0%' }
    root.dataset.ready = completed ? 'true' : 'false'
    // One hidden live region: stages and the verdict are spoken, a module name never is.
    const spoken = (settled && VERDICT[check] !== stage ? VERDICT[check] + '。' : '') + stage
    if (screen.live && spoken !== said) { said = spoken; screen.live.textContent = spoken }
  }
  const scheduleProgress = (): void => {
    if (!screen.root || timers.progress !== undefined) return
    timers.progress = setTimeout(paint, 80)
  }
  /** Wrap the HTML facade once: its queue holds the parser batch, its live sink every later bundle. */
  const watchLoader = (): void => {
    if (wrapped) return
    const facade = (window as unknown as Record<string, any>).__ModuleLoader__ as Record<string, any> | undefined
    if (!facade || typeof facade !== 'object') return
    if (typeof facade.create !== 'function' || facade.mode !== 'queue') { wrapped = true; counting = 'absent'; return }
    const create = facade.create
    facade.create = function (this: Record<string, any>, ...options: unknown[]): unknown {
      adopt(readGraph((options[0] as { boot?: unknown } | undefined)?.boot))
      // create() drains the queue itself, so the parser batch is only countable before it runs.
      const pending = Array.isArray(this.pendingQueue) ? this.pendingQueue.slice() : []
      const system = create.apply(this, options)
      for (const registration of pending) observe(registration)
      const load = this.load
      if (typeof load === 'function') this.load = function (this: unknown, registration: unknown): unknown { observe(registration); return load.apply(this, [registration]) }
      counting = 'watching'; scheduleProgress()
      return system
    }
    wrapped = true
  }
  const finishReady = (): void => {
    if (result === 'ready') return
    phase = result = 'ready'; observer.disconnect(); scheduleReport(100); remember()
    clearTimeout(timers.check)
    if (check === 'pending') { check = 'unknown'; paint() }
    const wait = Math.max(0, checkShownAt + 320 - performance.now())
    timers.reveal = setTimeout(() => {
      completed = true; paint()
      timers.hold = setTimeout(() => {
        if (!screen.root) return
        screen.root.dataset.fade = 'true'
        timers.fade = setTimeout(removeScreen, 160)
      }, 440)
    }, wait)
  }
  const finishFailed = (boot: HTMLElement): void => {
    if (result === 'failed') return
    phase = result = 'failed'; recordError('official-startup-failure'); observer.disconnect(); scheduleReport(100)
    for (const name in timers) clearTimeout(timers[name])
    removeScreen()
    let status = boot.querySelector<HTMLElement>('[data-dsh-rc-boot-status]')
    if (!status) {
      status = node('div', '', (boot.firstElementChild ?? boot) as HTMLElement)
      status.dataset.dshRcBootStatus = ''
      status.style.cssText = 'margin:12px auto 0;text-align:center;opacity:.8'
      status.textContent = '启动失败，请查看上方错误。'
    }
    status.setAttribute('role', 'alert')
    const retry = node('button', '', status) as HTMLButtonElement
    retry.textContent = '重新加载'
    retry.style.cssText = 'margin:12px auto 0;padding:8px 16px;border:1px solid currentColor;border-radius:999px;background:none;color:inherit'
    retry.onclick = () => { retry.disabled = true; location.reload() }
  }
  const updateBoot = (): void => {
    watchLoader()
    if (!graph) adopt(readGraph((window as unknown as Record<string, any>).__DSH_BOOT__))
    if (result === 'ready' || result === 'failed') return
    const root = document.getElementById('root')
    const boot = root?.querySelector<HTMLElement>(':scope > [data-dsh-boot]')
    if (!boot) {
      // The renderer replaces its boot DOM after the first React layout effect.
      if (observedBoot && root?.childElementCount) finishReady()
      else scheduleProgress()
      return
    }
    observedBoot = true; result = 'pending'
    const failed = !boot.querySelector('[data-dsh-boot-spinner]') && /Failed to load plugins|插件加载失败/.test(boot.textContent ?? '')
    if (failed) { finishFailed(boot); return }
    // Real registrations outrank transport counts: 'initializing' means every graph row arrived.
    const total = graph?.entries.length ?? 0
    phase = loading ? 'loading'
      : counting === 'watching' && total ? registered.size >= total ? 'initializing' : 'loading'
      : completedResources ? 'initializing' : 'checking'
    scheduleProgress()
  }
  ensureScreen()
  paint()
  // A Host that never publishes a graph leaves nothing to compare, and the reader must be told.
  setTimeout(() => { if (check === 'pending' && !graph) { check = 'unknown'; paint() } }, 3000)
  const observer = new MutationObserver(updateBoot)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  const previousLoad = typeof transport.loadBundle === 'function' ? transport.loadBundle.bind(transport) as (url: string) => Promise<void> : undefined
  globals.__DSH_TRANSPORT__.loadBundle = (url: string): Promise<void> => {
    const began = performance.now(); loading++; inFlight.push(addr(url)); updateBoot()
    const request = new Promise<void>((resolve, reject) => {
      if (previousLoad) { resolve(previousLoad(url)); return }
      const script = document.createElement('script'); script.async = true; script.src = url
      script.addEventListener('load', () => { script.remove(); resolve() }, { once: true })
      script.addEventListener('error', () => { script.remove(); reject(new Error('client-modules: bundle script failed to load')) }, { once: true })
      document.head.append(script)
    })
    const record = (outcome: 'loaded' | 'error'): void => {
      const arrived = inFlight.indexOf(addr(url))
      if (arrived >= 0) inFlight.splice(arrived, 1)
      if (outcome === 'loaded') completedResources++
      resources.push({ ...resourceAddress(url), result: outcome, durationMs: Math.max(0, Math.round(performance.now() - began)) })
      if (resources.length > 8) resources.shift()
      loading--; updateBoot()
    }
    // The module loader owns retries and fallback; observing a request must not replay it.
    return request.then(() => { record('loaded') }, failure => { record('error'); throw failure })
  }
  window.addEventListener('error', event => {
    const failure = event as ErrorEvent
    if (failure.message === 'ResizeObserver loop completed with undelivered notifications.' || failure.message === 'ResizeObserver loop limit exceeded') return
    const target = event.target as HTMLScriptElement & HTMLLinkElement & HTMLImageElement | null
    if (target?.tagName && ['SCRIPT', 'LINK', 'IMG'].includes(target.tagName)) {
      const address = resourceAddress(target.src || target.href || '')
      recordError(`resource-event:${target.tagName.toLowerCase()}:${address.path}${address.rev ? '@' + address.rev : ''}`)
    } else if (failure.message) recordError(`javascript-error:${resourceAddress(failure.filename || '').path}:${failure.lineno || 0}`)
  }, true)
  window.addEventListener('unhandledrejection', () => { recordError('unhandled-rejection') })
  updateBoot()
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
  /** A restarted or sleeping Host closes the socket; without this line the phone simply looks frozen. */
  function connectionBanner(offline: boolean): void {
    const existing = document.getElementById('dsh-rc-reconnecting')
    if (!offline) { existing?.remove(); return }
    if (existing) return
    const bar = document.createElement('div'); bar.id = 'dsh-rc-reconnecting'; bar.setAttribute('role', 'status'); bar.setAttribute('aria-live', 'polite')
    bar.style.cssText = 'position:fixed;left:50%;top:0;transform:translateX(-50%);z-index:2147483646;display:flex;gap:10px;align-items:center;padding:6px 14px;border-radius:0 0 12px 12px;background:#B45309;color:#fff;font:12px/1.6 system-ui,sans-serif'
    const text = document.createElement('span'); text.textContent = '与电脑的连接已断开，正在重连…'
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '立即重试'
    retry.style.cssText = 'padding:2px 10px;border:1px solid currentColor;border-radius:999px;background:transparent;color:inherit;font:inherit'
    retry.onclick = () => location.reload()
    bar.append(text, retry); (document.body ?? document.documentElement).append(bar)
  }
  /** A public entry that dies must not strand the phone on a dead page. */
  const lanFallback = context?.fallback
  let fallbackTried = false
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined
  const rescan = (): void => disconnected('无法自动切换到局域网。请在电脑上打开远程控制面板，扫描新的二维码重新配对。')
  /**
   * Offered only when this same gateway answers that the LAN entry is the same Host, and the answer
   * must carry the identity this page was given. Anything else asks for a fresh QR code instead of
   * navigating to some other computer. The address itself is checked too, so a forged `url` is inert.
   */
  async function switchToLan(): Promise<void> {
    if (!lanFallback || fallbackTried) return
    fallbackTried = true
    try {
      const response = await originalFetch('/rc/fallback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const data = await response.json().catch(() => null) as { sameHost?: unknown; url?: unknown; node?: unknown; hostId?: unknown; fingerprint?: unknown } | null
      const target = typeof data?.url === 'string' ? data.url : ''
      // Protocol 2 names the node identity; protocol 1 names the same identity as two flat fields.
      const answerNode = data?.node && typeof data.node === 'object' && !Array.isArray(data.node) ? data.node as Record<string, unknown> : null
      const answer = answerNode && typeof answerNode.id === 'string' && typeof answerNode.fingerprint === 'string'
        ? { id: answerNode.id, fingerprint: answerNode.fingerprint }
        : typeof data?.hostId === 'string' && typeof data?.fingerprint === 'string' ? { id: data.hostId, fingerprint: data.fingerprint } : null
      const expected = lanFallback.node ?? (lanFallback.hostId !== null && lanFallback.fingerprint !== null ? { id: lanFallback.hostId, fingerprint: lanFallback.fingerprint } : null)
      let same = false
      try {
        const wanted = new URL(lanFallback.url), found = new URL(target)
        same = data?.sameHost === true && expected !== null && answer !== null && answer.id === expected.id && answer.fingerprint === expected.fingerprint && found.origin === wanted.origin && found.protocol === wanted.protocol
      } catch { same = false }
      if (!same) { rescan(); return }
      notice('已切换到局域网')
      location.replace(new URL('/?rc=lan', target).href)
    } catch { rescan() }
  }
  window.addEventListener('dsh-rc-offline', () => {
    connectionBanner(true)
    if (!lanFallback || fallbackTried) return
    // One short grace period: a reconnect that succeeds clears this timer.
    clearTimeout(fallbackTimer)
    fallbackTimer = setTimeout(() => { void switchToLan() }, 1500)
  })
  window.addEventListener('dsh-rc-online', () => { connectionBanner(false); clearTimeout(fallbackTimer) })

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
export function bootScript(context?: BootContext): string {
  return `(${remoteBoot.toString()})(${localFilePath.toString()},${JSON.stringify(context ?? null)});`
}
/** The boot script is a same-origin file, not an inline script, so a Host CSP cannot block it. */
export const BOOT_PATH = '/rc/boot.js'
const BOOT_TAG = `<script src="${BOOT_PATH}"></script>`
export function injectBoot(html: string): string {
  // Host injections precede the original viewport; the transport must precede them too.
  if (!/<head(?:\s[^>]*)?>/i.test(html)) return html
  const viewport = /<meta\b[^>]*\bname=["']viewport["'][^>]*>/i.exec(html)
  const body = viewport ? html.slice(0, viewport.index) + html.slice(viewport.index + viewport[0].length) : html
  return body.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${viewport?.[0] ?? '<meta name="viewport" content="width=device-width, initial-scale=1">'}${BOOT_TAG}`)
}

