import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { createRequire } from 'node:module'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PairingService } from './pairing.js'
import { Gateway, MANAGE_PATH, REMOTE_MARK } from './gateway.js'
import { FRPC_CERTIFICATE_DIR, PUBLIC_PORT, PublicAccess } from './public-access.js'
import { normalizePublicUrl } from './public-url-settings.js'
import { body, gzipFor, isLoopback, json, sameOrigin } from './http.js'
import { gzipSync } from 'node:zlib'
import { isAccent, type Accent } from './accent.js'
import { detectSystemProxy, type SystemProxy } from './system-proxy.js'

export const name = '@copylee/dsh-remote-control'
export const inject = ['connection']
export const Config = z.object({
  gatewayPort: z.natural().max(65535).default(0).i18n({ 'zh-CN': { $description: '局域网网关端口；0 表示自动选择空闲端口。' } }),
  certificateDir: z.string().default('').i18n({ 'zh-CN': { $description: '证书部署目录；留空使用 SakuraFrp 的 FrpcWorkingDirectory。' } }),
})
export interface Config { gatewayPort?: number; certificateDir?: string }
type Mode = 'public' | 'lan'
/** Where outbound domain checks and certificate requests get their proxy. */
type ProxyMode = 'system' | 'manual' | 'off'
const isProxyMode = (value: unknown): value is ProxyMode => value === 'system' || value === 'manual' || value === 'off'
interface Preferences {
  autoStart: boolean; mode: Mode; proxy?: string; proxyMode: ProxyMode; accent: Accent; ui: 'custom' | 'native'
  /** The port last used, tried again so the address a phone knows keeps working after a restart. */
  port?: number
  /** Password-direct pairing: a new device that enters the fixed public password is paired at once. Off by default. */
  passwordPairing?: boolean
}
const mime: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
/** Adapters that are rarely the network a phone is on: virtual switches, VPN / proxy tunnels. */
const VIRTUAL_ADAPTER = /vethernet|wsl|hyper-v|vmware|virtualbox|vbox|docker|loopback|tailscale|zerotier|tap|tun|vpn|clash|meta|wintun|utun|bluetooth/i

/** This computer's IPv4 addresses, the ones a phone on the same network can most likely reach first. */
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  const rows = Object.entries(interfaces).flatMap(([name, list]) => (list ?? []).filter(row => row.family === 'IPv4' && !row.internal).map(row => ({ name, address: row.address })))
  const rank = (row: { name: string; address: string }) => {
    const [a = 0, b = 0] = row.address.split('.').map(Number)
    // Link-local and the 198.18/15 range used by TUN proxies are not reachable from a phone.
    if ((a === 169 && b === 254) || (a === 198 && (b === 18 || b === 19))) return 3
    if (VIRTUAL_ADAPTER.test(row.name)) return 2
    return a === 192 && b === 168 || a === 10 || (a === 172 && b >= 16 && b <= 31) ? 0 : 1
  }
  const ranked = rows.map((row, index) => ({ row, index, rank: rank(row) })).sort((x, y) => x.rank - y.rank || x.index - y.index)
  // Addresses no phone can reach are left out, unless there is nothing else.
  const usable = ranked.filter(item => item.rank < 3)
  return (usable.length ? usable : ranked).map(item => item.row.address)
}

/** Exchange the Host's launch token entirely inside the process. */
export function hostCookie(connection: Context['connection'], port: number): string {
  const base = `http://127.0.0.1:${port}/`
  const authenticated = new URL(connection.authenticatedUrl(base))
  let cookie = ''
  connection.authorizeIndex({ method: 'GET', url: authenticated.pathname + authenticated.search, headers: { host: `127.0.0.1:${port}` } }, {
    writeHead(_status, headers) { cookie = headers?.['set-cookie']?.split(';')[0] ?? '' }, end() {},
  })
  if (!cookie) throw new Error('DSH 宿主认证接口无法建立内部会话。')
  return cookie
}

/** One JSON line per remote boot report; the oldest lines drop once the file passes 256 KB. */
const BOOT_REPORT_LIMIT = 256 * 1024
function appendBootReport(file: string, report: Record<string, unknown>, device: { id: string; name: string } | undefined): void {
  const line = JSON.stringify({ time: new Date().toISOString(), device, ...report }) + '\n'
  let previous = ''
  try { previous = readFileSync(file, 'utf8') } catch { /* the first report creates the file */ }
  const kept = previous.length > BOOT_REPORT_LIMIT ? previous.slice(previous.indexOf('\n', previous.length - BOOT_REPORT_LIMIT / 2) + 1) : previous
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, kept + line, { mode: 0o600 }); renameSync(temporary, file)
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const profile = ctx.get('profileContext') as { name?: string } | undefined
  const storage = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-remote-control', String(profile?.name || process.env.DSH_PROFILE || 'default').replace(/[^a-zA-Z0-9_-]/g, '_'))
  mkdirSync(storage, { recursive: true })
  const prefsFile = join(storage, 'preferences.json')
  let preferences: Preferences = { autoStart: false, mode: 'lan', proxyMode: 'off', accent: 'orange', ui: 'custom' }
  let error: string | undefined
  if (existsSync(prefsFile)) {
    try {
      const stored = JSON.parse(readFileSync(prefsFile, 'utf8')) as Partial<Preferences>
      preferences = { ui: stored.ui === 'native' ? 'native' : 'custom', autoStart: stored.autoStart === true, mode: stored.mode === 'public' ? 'public' : 'lan', proxy: typeof stored.proxy === 'string' ? stored.proxy : undefined,
        // An address typed before proxy modes existed is still an explicit manual choice.
        proxyMode: isProxyMode(stored.proxyMode) ? stored.proxyMode : stored.proxy ? 'manual' : 'off', port: Number.isInteger(stored.port) && stored.port! > 0 && stored.port! < 65536 ? stored.port : undefined, accent: isAccent(stored.accent) ? stored.accent : 'orange', passwordPairing: stored.passwordPairing === true }
    } catch {
      // A damaged preferences file must not keep the plugin from loading; device authorizations live elsewhere.
      error = '远程控制的偏好设置文件已损坏，已恢复默认设置（设备授权不受影响）。'
    }
  }
  function savePreferences(): void {
    const temporary = `${prefsFile}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(preferences), { mode: 0o600 }); renameSync(temporary, prefsFile)
  }
  let gateway: Gateway | undefined
  let access: PublicAccess | undefined
  let enabled = false, busy = false, disposed = false
  let activeMode: Mode | undefined
  let generation = 0
  let qr: { token: string; expiresAt: number } | undefined
  const pairing = new PairingService({ file: join(storage, 'devices.json'), onRevoke: id => gateway?.revoke(id), isOnline: id => gateway?.onlineIds().includes(id) ?? false })
  pairing.prune(device => !!device.host && /(?:\.trycloudflare\.com|\.lhr\.life)$/i.test(device.host))
  const ownedServer = !ctx.get('webServer')
  if (ownedServer) ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  let shutdown: () => Promise<void> = async () => {}
  ctx.effect(() => () => { disposed = true; return shutdown() }, 'remote-control cleanup')

  ctx.inject(['webServer'], async ready => {
    const upstreamPort = ready.webServer.port
    if (!upstreamPort) throw new Error('DSH WebServer 尚未就绪。')
    let credential = hostCookie(ready.connection, upstreamPort)
    // The Host session cookie is absolute (30 days by default). Refresh it well before that,
    // so a gateway left running for weeks never starts answering 401 to every remote request.
    const credentialTimer = setInterval(() => { try { credential = hostCookie(ready.connection, upstreamPort) } catch { /* keep the current cookie */ } }, 12 * 3600_000)
    credentialTimer.unref()
    const require = createRequire(import.meta.url)
    const distRoot = join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist')
    const renderIndex = async (ui = preferences.ui) => {
      let html = await readFile(join(distRoot, 'index.html'), 'utf8')
      if (ui === 'custom') {
        html = html.replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/, '<script type="module" src="/rc-assets/remote.js"></script><link rel="stylesheet" href="/rc-assets/style.css">')
          .replace('<div id="root"></div>', '<div id="root"><p>正在加载远程界面…</p><a href="/?ui=native">打开原生界面</a></div>')
          .replace('<title>DeepSeek Harness</title>', '<title>DSH · 远程</title>')
      }
      return ready.webServer.renderIndex(html)
    }
    // Files of the app are compressed once and kept: they are the bulk of what a phone first downloads.
    const packed = new Map<string, Buffer>()
    const send = (req: IncomingMessage | undefined, res: ServerResponse, headers: Record<string, string>, key: string, data: Buffer): void => {
      if (data.length < 1024 || !gzipFor(req, headers['content-type'])) { res.writeHead(200, headers); res.end(data); return }
      let small = packed.get(key)
      if (!small) { if (packed.size > 256) packed.clear(); packed.set(key, small = gzipSync(data, { level: 9 })) }
      res.writeHead(200, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' }); res.end(small)
    }
    const asset = async (pathname: string, res: ServerResponse, req?: IncomingMessage): Promise<boolean> => {
      if (pathname.startsWith('/rc-assets/')) {
        const path = resolve(dirname(fileURLToPath(import.meta.url)), '.' + pathname.replace('/rc-assets/', '/'))
        if (!/^\/rc-assets\/[a-zA-Z0-9_.-]+\.(js|css|woff2?|ttf)$/.test(pathname)) { res.writeHead(404).end(); return true }
        try {
          const info = await stat(path), etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
          // Chunks carry a content hash in their name. The entry and stylesheet do not, and must be
          // revalidated: a stale entry after a plugin update would ask for chunks that no longer exist.
          const hashed = /^\/rc-assets\/remote-.+-[A-Za-z0-9_-]{8}\.js$/.test(pathname)
          const headers = { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'cache-control': hashed ? 'private, max-age=31536000, immutable' : 'private, no-cache', etag }
          if (req?.headers['if-none-match'] === etag) { res.writeHead(304, headers).end(); return true }
          send(req, res, headers, `${path}:${etag}`, await readFile(path))
        } catch { res.writeHead(404).end() }
        return true
      }
      if (!pathname.startsWith('/assets/') && !['/favicon.svg', '/favicon-dark.svg', '/manifest.webmanifest'].includes(pathname)) return false
      const path = resolve(distRoot, `.${decodeURIComponent(pathname)}`)
      if (!path.startsWith(resolve(distRoot) + sep)) { res.writeHead(403).end(); return true }
      try { const info = await stat(path); send(req, res, { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'cache-control': 'private, max-age=3600' }, `${path}:${info.size}:${info.mtimeMs}`, await readFile(path)) }
      catch { res.writeHead(404).end() }
      return true
    }
    const baseURLs = () => !enabled || !gateway ? [] : activeMode === 'public' ? (access?.domain ? [access.domain] : []) : lanAddresses().map(ip => `http://${ip}:${gateway!.port}`)
    // The system's proxy is looked up at most every 15 seconds; the panel asks for status far more often.
    let detected: { at: number; value: SystemProxy | null } | undefined
    const systemProxy = async (fresh = false) => {
      if (fresh || !detected || Date.now() - detected.at > 15_000) detected = { at: Date.now(), value: await detectSystemProxy().catch(() => null) }
      return detected.value
    }
    access = new PublicAccess({ certificateDir: config.certificateDir || process.env.DSH_RC_CERTIFICATE_DIR || FRPC_CERTIFICATE_DIR, storage, legacyStorage: join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-roam'), proxy: async () => {
      if (preferences.proxyMode === 'manual') return preferences.proxy
      if (preferences.proxyMode === 'system') return (await systemProxy(true))?.url
      return undefined
    }, beforeIssue: async () => {
      if (!enabled || activeMode !== 'public' || gateway?.port !== PUBLIC_PORT) throw new Error('请先开启固定公网连接，再申请证书。')
    }, log: message => ready.logger?.warn?.(message) })
    await access.migrate()
    access.certificates.startAutoRenew()
    // The QR library is loaded with the first code drawn, and a code is only redrawn when its link changes.
    let drawn: { url: string; image: string } | undefined
    const qrImage = async (url: string) => {
      if (drawn?.url !== url) drawn = { url, image: await (await import('qrcode')).default.toDataURL(url, { width: 260, margin: 2, errorCorrectionLevel: 'M' }) }
      return drawn.image
    }
    const status = async (local: boolean) => {
      const links = baseURLs().map(base => ({ base, url: qr ? `${base}/pair#pair=${qr.token}` : undefined }))
      const active = new Set(gateway?.onlineIds() ?? [])
      return {
        enabled, busy, mode: preferences.mode, activeMode, autoStart: preferences.autoStart,
        proxyConfigured: !!preferences.proxy, proxyMode: preferences.proxyMode, manualProxy: local ? preferences.proxy : undefined,
        systemProxy: preferences.proxyMode === 'system' && preferences.mode === 'public' ? await systemProxy() : undefined,
        accent: preferences.accent, ui: preferences.ui,
        publicUrl: access?.domain, publicPort: PUBLIC_PORT, pairingPin: access?.password(local), pinFixed: access?.fixedPin, passwordPairing: preferences.passwordPairing === true,
        publicUrlCheck: local ? access?.lastCheck : undefined, certificate: local && access?.domain ? await access.certificateStatus() : undefined,
        phase: enabled ? 'ready' : error ? 'error' : 'off', error, gatewayPort: gateway?.port ?? 0, local,
        expiresAt: qr?.expiresAt, links, qr: links[0]?.url ? await qrImage(links[0].url) : undefined,
        requests: local ? pairing.requests() : [],
        devices: pairing.list().map(({ host, ...device }) => ({
          ...device, via: host === undefined ? undefined : access?.domain && host.toLowerCase() === new URL(access.domain).host.toLowerCase() ? 'public' : 'lan', online: active.has(device.id)
        })),
        lanHint: '手机需与电脑处于同一局域网。若连接被防火墙阻断，请手动允许网关端口；插件不会修改防火墙。',
      }
    }
    // A QR is useless when the public entry is down. Probe it when public access starts and
    // every two minutes after, so the panel can say why a phone cannot open the link.
    let monitor: ReturnType<typeof setInterval> | undefined
    let probing = false
    const stopMonitor = () => { if (monitor) clearInterval(monitor); monitor = undefined }
    const probe = () => {
      if (probing || !enabled || activeMode !== 'public' || !access?.domain) return
      probing = true
      void access.checkDomain().catch(() => undefined).finally(() => { probing = false })
    }
    const startMonitor = () => { stopMonitor(); monitor = setInterval(probe, 120_000); monitor.unref(); probe() }
    const stop = async () => {
      ++generation
      enabled = false; activeMode = undefined; access?.setActive(false); qr = undefined; pairing.invalidate()
      stopMonitor()
      const current = gateway; gateway = undefined
      await current?.close()
    }
    shutdown = stop
    const start = async () => {
      if (busy) throw new Error('连接操作正在进行，请稍后再试。')
      if (preferences.mode === 'public' && !access?.domain) throw new Error('请先填写固定公网域名，再开启“任意网络”。')
      busy = true; error = undefined
      let ticket: number | undefined
      try {
        const mode = preferences.mode
        const stopping = stop(); ticket = generation
        await stopping; if (disposed || ticket !== generation) return
        credential = hostCookie(ready.connection, upstreamPort)
        const create = () => new Gateway({ pairing, upstreamPort, upstreamCookie: () => credential, manage, index: renderIndex, asset, addresses: mode === 'lan' ? lanAddresses : undefined, public: mode === 'public' ? () => access : undefined, accent: () => preferences.accent, directPairing: () => preferences.passwordPairing === true, onBootReport: (report, device) => { try { appendBootReport(join(storage, 'boot-reports.jsonl'), report, device) } catch { /* diagnostics must never break the gateway */ } } })
        const host = mode === 'lan' ? '0.0.0.0' : '127.0.0.1'
        let next = gateway = create()
        // The port of last time first: a phone's bookmark or open tab then still points at this computer.
        const wanted = mode === 'public' ? PUBLIC_PORT : config.gatewayPort || preferences.port || 0
        try { await next.listen(host, wanted) }
        catch (failure) {
          const code = (failure as NodeJS.ErrnoException).code ?? ''
          if (mode === 'public' && code === 'EADDRINUSE') throw new Error(`公网端口 ${wanted} 已被占用：可能另一个 DSH 配置正在使用公网模式，请先关闭它的远程连接。`)
          // Only a port that cannot be had is worth a second try on another one.
          if (mode === 'public' || config.gatewayPort || !wanted || !['EADDRINUSE', 'EACCES'].includes(code)) throw failure
          next = gateway = create(); await next.listen(host, 0)   // taken by something else since
        }
        if (mode === 'lan' && !config.gatewayPort && next.port !== preferences.port) { preferences = { ...preferences, port: next.port }; try { savePreferences() } catch { /* only a convenience */ } }
        if (disposed || ticket !== generation) { await next.close(); return }
        enabled = true; activeMode = mode; access?.setActive(mode === 'public'); qr = pairing.issue()
        if (mode === 'public') startMonitor(); else stopMonitor()
      } catch (failure) { if (ticket === generation) { error = failure instanceof Error ? failure.message : '启动失败。'; await stop() }; throw failure }
      finally { busy = false }
    }
    async function manage(input: Record<string, unknown>, local: boolean): Promise<unknown> {
      switch (input.action) {
        case 'status': return status(local)
        // What the always-mounted sidebar entry polls: no QR code is rendered for it.
        case 'requests': return { enabled, accent: preferences.accent, requests: local ? pairing.requests() : [] }
        case 'scheduleCapabilities': return { available: !!ready.get('schedule') }
        case 'scheduleCreate': {
          const service = ready.get('schedule') as { create(sessionId: string, request: unknown): Promise<unknown> } | undefined
          if (!service) throw new Error('此宿主尚未启用自动化服务。请在插件管理中启用实验性自动化插件。')
          if (typeof input.sessionId !== 'string' || !input.request || typeof input.request !== 'object') throw new Error('自动化请求格式不正确。')
          // rc.2 exposes list/update/delete over Remote but no create RPC.
          // Delegate directly to the existing Host service, retaining its validation,
          // persistence and scheduling semantics; no second task database.
          return service.create(input.sessionId, input.request)
        }
        case 'start': if (!enabled) await start(); return status(local)
        case 'switch': {
          if (busy) throw new Error('连接操作正在进行，请稍后再试。')
          if (preferences.mode === activeMode && enabled) return status(local)
          if (local) { await start(); return status(local) }
          busy = true
          const ticket = generation
          setTimeout(() => { busy = false; if (!disposed && ticket === generation) void start().catch(() => {}) }, 75)
          return { switching: true, mode: preferences.mode }
        }
        case 'stop': if (local) await stop(); else { ++generation; setTimeout(() => { void stop() }, 75) }; return { stopped: true }
        case 'refresh': {
          if (!enabled) throw new Error('请先开启远程连接。')
          if (pairing.outstanding()) throw new Error('还有配对请求在等待确认，请先处理后再刷新二维码。')
          qr = pairing.issue(); return status(local)
        }
        case 'approve': if (!local) throw new Error('首次配对必须在本机确认。'); pairing.approve(String(input.id)); return status(local)
        case 'reject': if (!local) throw new Error('配对请求由本机处理。'); pairing.reject(String(input.id)); return status(local)
        case 'revoke': {
          const id = String(input.id)
          // Allow the management acknowledgement to reach the revoked caller.
          setTimeout(() => { try { pairing.revoke(id) } catch { error = '撤销失败，授权文件未能保存；请在本机重试。' } }, 75)
          return { revoked: true }
        }
        case 'rename': pairing.rename(String(input.id), String(input.name ?? '')); return status(local)
        case 'revokeAll': setTimeout(() => { try { pairing.revokeAll(); qr = undefined } catch { error = '撤销失败，请在本机重试。' } }, 75); return { revoked: true }
        case 'preferences': {
          const previous = preferences, previousDomain = access?.domain
          if (busy && Object.keys(input).some(key => key !== 'action' && key !== 'accent')) throw new Error('请等待当前连接操作完成。')
          const next = { ...preferences }
          if (input.ui !== undefined) { if (input.ui !== 'custom' && input.ui !== 'native') throw new Error('界面选项不正确。'); next.ui = input.ui }
          if (typeof input.autoStart === 'boolean') next.autoStart = input.autoStart
          if (input.mode !== undefined) { if (input.mode !== 'public' && input.mode !== 'lan') throw new Error('连接模式不正确。'); next.mode = input.mode }
          if (input.accent !== undefined) { if (!isAccent(input.accent)) throw new Error('强调色不正确。'); next.accent = input.accent }
          if (input.passwordPairing !== undefined) {
            if (!local) throw new Error('密码直连配对开关只能在本机面板修改。')
            if (typeof input.passwordPairing !== 'boolean') throw new Error('密码直连配对选项不正确。')
            next.passwordPairing = input.passwordPairing
          }
          if (input.proxyMode !== undefined) { if (!isProxyMode(input.proxyMode)) throw new Error('代理方式不正确。'); next.proxyMode = input.proxyMode }
          if (input.publicUrl !== undefined) {
            if (!local) throw new Error('公网域名只能在本机面板修改。')
            const nextDomain = normalizePublicUrl(String(input.publicUrl))
            if (enabled && activeMode === 'public' && nextDomain !== access?.domain) throw new Error('请先关闭远程连接，再修改公网域名。')
            await access?.saveDomain(String(input.publicUrl))
          }
          if (input.proxy !== undefined) {
            const value = String(input.proxy).trim()
            if (value) { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('代理需为不带用户名和密码的 HTTP(S) 地址。'); }
            next.proxy = value || undefined
          }
          preferences = next
          try { savePreferences() } catch (failure) {
            preferences = previous
            if (input.publicUrl !== undefined) {
              try { await access?.saveDomain(previousDomain ?? '') }
              catch { throw new Error('偏好设置保存失败，且公网域名回滚失败，请检查配置文件。') }
            }
            throw failure
          }
          if (previous.proxy !== next.proxy || previous.proxyMode !== next.proxyMode) await access?.resetOutbound()
          return status(local)
        }
        case 'setPin': {
          if (!local) throw new Error('连接密码只能在本机面板修改。')
          if (typeof input.pin !== 'string') throw new Error('请提供连接密码。')
          if (await access?.setPin(input.pin)) { gateway?.revokeEntries(); pairing.revokeAll(); qr = enabled ? pairing.issue() : undefined }
          return status(local)
        }
        case 'checkPublicUrl': {
          if (!local) throw new Error('公网检测只能在本机面板执行。')
          await access?.checkDomain(); return status(local)
        }
        case 'certificate': {
          if (!local) throw new Error('证书只能在本机面板管理。')
          if (!access?.domain) throw new Error('请先保存固定公网域名。')
          if (!enabled || activeMode !== 'public') throw new Error('请先开启“任意网络”，再申请证书。')
          if (gateway?.port !== PUBLIC_PORT) throw new Error('公网监听端口与固定域名转发目标不一致，请先修复端口配置。')
          const domain = access.domain
          void access.renew(domain, true).catch(() => undefined)
          return status(local)
        }
        default: throw new Error('未知的远程控制操作。')
      }
    }
    const localHandler = async (req: IncomingMessage, res: ServerResponse) => {
      const rejection = ready.connection.requestRejection(req)
      // The gateway is itself a loopback caller holding the Host session; what it forwards is never local.
      if (rejection || req.headers[REMOTE_MARK] !== undefined || !isLoopback(req.socket.remoteAddress) || !sameOrigin(req)) { json(res, rejection ?? 403, { error: '本机面板需要宿主认证和本机连接。' }); return }
      if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return }
      try { json(res, 200, await manage(await body(req), true)) }
      catch (failure) { json(res, 400, { error: failure instanceof Error ? failure.message : '操作失败。' }) }
    }
    ready.effect(() => () => { stopMonitor(); clearInterval(credentialTimer); void access?.certificates.stop(); void access?.resetOutbound() }, 'remote-control public access')
    ready.effect(() => ready.webServer.register({ kind: 'exact', path: MANAGE_PATH, handler: localHandler }), 'remote-control local management')
    // Desktop's trusted IPC/Fetch carrier bypasses node:http. The outer gateway
    // handles this exact route itself and never forwards remote approval requests.
    ready.effect(() => ready.connection.fetch.register({ path: MANAGE_PATH, methods: ['POST'], requestBody: 'buffered', fetch: async request => {
      if (request.headers.has(REMOTE_MARK)) return Response.json({ error: '本机面板需要宿主认证和本机连接。' }, { status: 403 })
      try { const input = await request.json(); return Response.json(await manage(input as Record<string, unknown>, true), { headers: { 'cache-control': 'no-store' } }) }
      catch (failure) { return Response.json({ error: failure instanceof Error ? failure.message : '操作失败。' }, { status: 400 }) }
    } }), 'remote-control Desktop management')
    if (preferences.autoStart && !disposed) await start().catch(failure => {
      if (disposed) return
      const message = failure instanceof Error ? failure.message : '启动失败。'
      error = preferences.mode === 'public' && /请先填写固定公网域名/.test(message)
        ? '未开启远程连接：旧版临时公共隧道已移除，请配置固定公网域名后再开启。'
        : message
    })
  })
}
