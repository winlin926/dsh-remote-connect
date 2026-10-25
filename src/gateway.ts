import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse, ClientRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Duplex } from 'node:stream'
import type { WebSocket, WebSocketServer } from 'ws'
import type { PairingService, Device } from './pairing.js'
import { body, cookie, gzipFor, json, sameOrigin } from './http.js'
import { constants, createGzip } from 'node:zlib'
import { deniedPage, pairingPage, passwordPage } from './pages.js'
import { ACME_CHALLENGE_PREFIX } from './acme-certificate.js'
import type { PublicAccess } from './public-access.js'
import { injectBoot } from './boot.js'
import type { Accent } from './accent.js'
import { PREVIEW_MIME, PREVIEW_PREFIX, WorkspacePreviews, previewEntry } from './workspace-preview.js'

export const MANAGE_PATH = '/api/dsh-remote-connect/manage'
/** Set by the gateway on every request it forwards; the Host's local-only handlers refuse it. */
export const REMOTE_MARK = 'x-dsh-rc-remote'
/** Accept absolute Windows/Unix paths only; relative segments and UNC hosts stay out. */
function validLocalPath(value: string): boolean {
  if (/[\r\n]/.test(value) || value.startsWith('//')) return false
  if (/^[a-zA-Z]:[\\/]/.test(value)) return !value.split(/[\\/]/).includes('..')
  if (value.startsWith('/')) return !value.split('/').includes('..')
  return false
}
export interface GatewayOptions {
  pairing: PairingService
  upstreamPort: number
  upstreamCookie: () => string
  manage: (input: Record<string, unknown>, local: boolean) => Promise<unknown>
  /** Render the official Web GUI when the Desktop Host has no HTTP index. */
  index?: (ui?: 'custom' | 'native') => Promise<string>
  asset?: (path: string, res: ServerResponse, req: IncomingMessage) => Promise<boolean>
  /** Addresses this computer can currently be reached at (LAN mode); read on every request, since they change with the network. */
  addresses?: () => string[]
  /** The accent colour the user chose, for the pages the gateway serves itself. */
  accent?: () => Accent
  /** Fixed-domain public entry and its additional password gate. */
  public?: () => PublicAccess | undefined
  /** Password-direct pairing switch; read on every request so panel changes apply at once. */
  directPairing?: () => boolean
  /** Receives one diagnostic report per remote boot, also from devices that fail to pair. */
  onBootReport?: (report: Record<string, unknown>, device: { id: string; name: string } | undefined) => void
}
export function safePath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || /[\x00-\x1f\\]/.test(path)) return false
  try {
    const pathname = path.split('?')[0]!
    let decoded = pathname
    for (let i = 0; i < 3; i++) { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next }
    return !decoded.startsWith('//') && !decoded.includes('\\') && !/[\x00-\x1f]/.test(decoded) && !decoded.split('/').some(part => part === '..' || part === '.')
  } catch { return false }
}

/** `WebSocket.OPEN`, without needing the class at hand. */
const OPEN = 1

/** Authenticates every remote request before the privileged loopback leg. */
export class Gateway {
  private server?: Server
  private readonly sockets = new Set<Duplex>()
  private readonly active = new Map<string, Set<() => void>>()
  // `ws` is loaded when the gateway is opened, not when the plugin is: most Host starts never open one.
  private ws!: typeof import('ws')
  private wss!: WebSocketServer
  private readonly rates = new Map<string, { count: number; until: number }>()
  private readonly authorities = new Set<string>()
  private readonly previews = new WorkspacePreviews()
  private readonly entries = new Map<string, number>()
  port = 0
  constructor(private readonly options: GatewayOptions) {}
  allowAuthority(authority: string): void { this.authorities.add(authority.toLowerCase()) }
  disallowAuthority(authority: string): void { this.authorities.delete(authority.toLowerCase()) }
  private validHost(req: IncomingMessage): boolean {
    const host = req.headers.host?.toLowerCase()
    if (!host) return false
    const publicHost = this.options.public?.()?.domain
    return this.authorities.has(host) || (publicHost !== null && publicHost !== undefined && host === new URL(publicHost).host.toLowerCase()) || (this.options.addresses?.().some(address => host === `${address}:${this.port}`) ?? false)
  }
  async listen(host: '127.0.0.1' | '0.0.0.0', port = 0): Promise<number> {
    if (this.server) throw new Error('远程网关已启动。')
    this.ws ??= await import('ws')
    this.wss ??= new this.ws.WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false })
    const server = this.server = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: '请求处理失败，请在本机查看状态。' }); else res.destroy() }) })
    server.on('connection', socket => { this.sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => this.sockets.delete(socket)) })
    server.on('upgrade', (req, socket, head) => { socket.on('error', () => {}); void this.upgrade(req, socket, head).catch(() => socket.destroy()) })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve() }) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('无法读取网关端口。')
    this.port = address.port
    this.allowAuthority(`127.0.0.1:${this.port}`); this.allowAuthority(`localhost:${this.port}`)
    return this.port
  }
  private publicRequest(req: IncomingMessage): boolean {
    const access = this.options.public?.()
    if (!access?.domain) return false
    if (req.headers.host?.toLowerCase() === new URL(access.domain).host.toLowerCase()) return true
    return Object.keys(req.headers).some(name => name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-') || name.startsWith('cf-'))
  }
  private hasEntry(req: IncomingMessage): boolean {
    const value = cookie(req, 'dsh_rc_entry')
    if (!value) return false
    const expires = this.entries.get(value)
    if (!expires || expires <= Date.now()) { this.entries.delete(value); return false }
    return true
  }
  private clientAddress(req: IncomingMessage): string {
    const remote = req.socket.remoteAddress ?? 'unknown'
    const forwarded = req.headers['x-forwarded-for']
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim()
    return (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') && first ? first.slice(0, 200) : remote
  }
  private async acme(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith(ACME_CHALLENGE_PREFIX)) return false
    const name = pathname.slice(ACME_CHALLENGE_PREFIX.length), directory = this.options.public?.()?.challengeDir
    if (req.method !== 'GET' || !directory || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) { json(res, 404, { error: 'not found' }); return true }
    try {
      const content = await readFile(join(directory, name))
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(content)
    } catch { json(res, 404, { error: 'not found' }) }
    return true
  }
  revokeEntries(): void { this.entries.clear() }
  private track(deviceId: string, cancel: () => void): () => void {
    let set = this.active.get(deviceId); if (!set) this.active.set(deviceId, set = new Set())
    set.add(cancel)
    return () => { set!.delete(cancel); if (!set!.size) this.active.delete(deviceId) }
  }
  onlineIds(): string[] { return [...this.active.keys()] }
  revoke(id: string): void { this.previews.revoke(id); for (const cancel of [...this.active.get(id) ?? []]) cancel(); this.active.delete(id) }
  private device(req: IncomingMessage): Device | undefined { return this.options.pairing.authenticate(cookie(req)) }
  private cookieHeader(req: IncomingMessage, credential: string, secure: boolean): string {
    // Trust forwarded protocol only after fixed-domain Host admission; frpc targets this private port.
    // Lax, not Strict: a link opened from another app (a QR scanner, a chat, a home-screen shortcut) is a
    // cross-site navigation, and Strict would leave a paired device looking unpaired. Cross-site requests
    // other than opening the app page are still refused below.
    return `dsh_rc=${credential}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`
  }
  private rate(req: IncomingMessage): boolean {
    const claim = req.url?.startsWith('/rc/pair/claim') === true
    const key = `${req.socket.remoteAddress ?? 'unknown'}:${claim ? 'claim' : 'request'}`, now = Date.now()
    if (this.rates.size > 1024) for (const [ip, row] of this.rates) if (row.until < now) this.rates.delete(ip)
    let row = this.rates.get(key)
    if (!row || row.until < now) this.rates.set(key, row = { count: 0, until: now + 60_000 })
    return ++row.count <= (claim ? 1000 : 120)
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!safePath(req.url ?? '/') || !this.validHost(req)) { json(res, 403, { error: '不受信任的访问地址。' }); return }
    const url = new URL(req.url ?? '/', 'http://gateway.invalid')
    const publicRequest = this.publicRequest(req)
    if (url.pathname.startsWith(ACME_CHALLENGE_PREFIX)) {
      if (!publicRequest) { json(res, 404, { error: 'not found' }); return }
      if (await this.acme(req, res, url.pathname)) return
    }
    if (url.pathname === '/rc/health') {
      if (!publicRequest) { json(res, 404, { error: 'not found' }); return }
      json(res, 200, { ok: true, service: 'dsh-remote-connect' }); return
    }
    if (url.pathname === '/pair' && req.method === 'GET') {
      const direct = publicRequest && this.options.directPairing?.() === true
      // Password verification is only the first gate. Once it has issued an entry,
      // resume the QR pairing flow instead of rendering the same blocking form again.
      const gate = direct ? 'direct' : !publicRequest || this.device(req) || this.hasEntry(req) ? 'open' : 'password'
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' }); res.end(pairingPage(this.options.accent?.(), gate)); return
    }
    if (url.pathname === '/rc/pair/verify') {
      const access = this.options.public?.()
      if (!publicRequest || !access || req.method !== 'POST' || !sameOrigin(req)) { json(res, 403, { error: '仅公网入口需要连接密码。' }); return }
      if (!this.rate(req)) { json(res, 429, { error: '请求过于频繁，请稍后再试。' }); return }
      try {
        const input = await body(req), result = access.verifyPin(String(input.pin ?? ''), this.clientAddress(req))
        if (!result.ok) {
          if (result.retryAfter) res.setHeader('retry-after', String(result.retryAfter))
          json(res, result.retryAfter ? 429 : 401, { error: result.retryAfter ? '尝试次数过多，请稍后再试。' : '连接密码不正确。', retryAfter: result.retryAfter }); return
        }
        const entry = randomBytes(32).toString('base64url'); this.entries.set(entry, Date.now() + 10 * 60_000)
        if (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value!)
        res.setHeader('set-cookie', `dsh_rc_entry=${entry}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600${req.headers['x-forwarded-proto'] === 'https' || publicRequest ? '; Secure' : ''}`)
        json(res, 200, { ok: true })
      } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '验证失败。' }) }
      return
    }
    if (url.pathname === '/rc/pair/direct') {
      const access = this.options.public?.()
      if (!publicRequest || !access || req.method !== 'POST' || !sameOrigin(req)) { json(res, 403, { error: '仅公网入口支持密码直连配对。' }); return }
      if (!this.options.directPairing?.()) { json(res, 403, { error: '密码直连配对未开启，请扫码配对。', code: 'direct_disabled' }); return }
      if (!this.rate(req)) { json(res, 429, { error: '请求过于频繁，请稍后再试。' }); return }
      try {
        const input = await body(req), result = access.verifyPin(String(input.pin ?? ''), this.clientAddress(req))
        if (!result.ok) {
          if (result.retryAfter) res.setHeader('retry-after', String(result.retryAfter))
          json(res, result.retryAfter ? 429 : 401, { error: result.retryAfter ? '尝试次数过多，请稍后再试。' : '连接密码不正确。', retryAfter: result.retryAfter }); return
        }
        const credential = this.options.pairing.pairDirectly(req.headers['user-agent'] ?? '', req.headers.host, typeof input.model === 'string' ? input.model : undefined)
        res.setHeader('set-cookie', this.cookieHeader(req, credential, publicRequest))
        json(res, 200, { ok: true })
      } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '配对失败。' }) }
      return
    }
    if (url.pathname === '/rc/pair/request' || url.pathname === '/rc/pair/claim') {
      if (publicRequest && !this.hasEntry(req)) { json(res, 403, { error: '请先输入连接密码。', code: 'password_required' }); return }
      if (req.method !== 'POST' || !sameOrigin(req)) { json(res, 403, { error: '需要同源 POST 请求。' }); return }
      if (!this.rate(req)) { json(res, 429, { error: '请求过于频繁，请稍后再试。' }); return }
      try {
        const input = await body(req)
        if (url.pathname.endsWith('/request')) json(res, 200, this.options.pairing.request(String(input.token ?? ''), req.headers['user-agent'] ?? '', req.headers.host, typeof input.model === 'string' ? input.model : undefined))
        else {
          const result = this.options.pairing.claim(String(input.id ?? ''), String(input.key ?? ''))
          if (result.credential) res.setHeader('set-cookie', this.cookieHeader(req, result.credential, publicRequest))
          json(res, 200, { state: result.state })
        }
      } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '配对失败。' }) }
      return
    }
    // A boot that only fails on the phone would otherwise be undebuggable: accept one small
    // diagnostic report per page load even from unpaired devices, and note who did report.
    if (url.pathname === '/rc/boot-report') {
      if (req.method !== 'POST' || !sameOrigin(req)) { json(res, 403, { error: '需要同源 POST 请求。' }); return }
      if (!this.rate(req)) { json(res, 429, { error: '请求过于频繁，请稍后再试。' }); return }
      try {
        const reporter = this.device(req)
        this.options.onBootReport?.(await body(req, 8192), reporter ? { id: reporter.id, name: reporter.name } : undefined)
      } catch { /* a malformed report is dropped, never a reason to fail the page */ }
      res.writeHead(204); res.end()
      return
    }
    if (url.pathname.startsWith(PREVIEW_PREFIX)) {
      const preview = this.previews.match(url.pathname)
      // Images and styles from an opaque origin may be marked cross-site without an Origin
      // header. The unguessable, read-only capability path is their authorization.
      if (!['GET', 'HEAD'].includes(req.method ?? '') || (req.headers.origin && req.headers.origin !== 'null' && !sameOrigin(req))) { json(res, 403, { error: '拒绝跨站请求。' }); return }
      if (!preview) { json(res, 404, { error: '预览已过期，请在对话中重新打开。' }); return }
      const untrack = this.track(preview.deviceId, () => { req.destroy(); res.destroy() }); res.once('close', untrack)
      await this.previews.serve(preview, req, res)
      return
    }
    const device = this.device(req)
    // With direct pairing on, an unpaired visitor is always offered the password page; entering the
    // correct password pairs the device on the spot, so no entry cookie can ever strand them on a denial.
    if (!device && publicRequest && req.headers.accept?.includes('text/html') && req.method === 'GET' && (!this.hasEntry(req) || this.options.directPairing?.() === true)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' }); res.end(passwordPage(this.options.accent?.(), this.options.directPairing?.() === true)); req.resume(); return
    }
    if (!device) {
      if (req.headers.accept?.includes('text/html') && req.method === 'GET') { res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(deniedPage(this.options.accent?.())) }
      else json(res, 403, { error: '设备尚未配对或授权已撤销。', code: 'unpaired' })
      req.resume(); return
    }
    // Arriving from elsewhere may only open the app page itself; that reads nothing and changes nothing.
    const opening = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document' && (url.pathname === '/' || url.pathname === '/index.html')
    if (!sameOrigin(req) && !opening) { json(res, 403, { error: '拒绝跨站请求。' }); return }
    // Renew the browser expiry along with the durable 30-day idle authorization.
    res.setHeader('set-cookie', this.cookieHeader(req, cookie(req)!, publicRequest))
    const untrack = this.track(device.id, () => { req.destroy(); res.destroy() }); res.once('close', untrack)
    if (decodeURIComponent(url.pathname) === MANAGE_PATH) {
      if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return }
      try { json(res, 200, await this.options.manage(await body(req), false)) }
      catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '操作失败。' }) }
      return
    }
    // A paired device already holds the computer's full authority; serving a local file it
    // points at (a workspace link in a message) is convenience, not a new capability.
    if (url.pathname === '/rc/workspace-file') {
      if (req.method !== 'GET') { json(res, 405, { error: 'GET only' }); return }
      const requested = url.searchParams.get('p') ?? ''
      const cleaned = requested.replace(/^\/+(?=[a-zA-Z]:[\\/])/, '').replace(/\0/g, '')
      if (!cleaned || !validLocalPath(cleaned)) { json(res, 400, { error: '文件路径不正确。' }); return }
      if (/\.html?$/i.test(cleaned)) {
        try {
          const path = await realpath(cleaned)
          if (!(await stat(path)).isFile()) { json(res, 404, { error: '请选择 HTML 文件。' }); return }
          const token = randomBytes(32).toString('base64url')
          this.previews.add(token, device.id, dirname(path))
          const location = PREVIEW_PREFIX + token + '/' + previewEntry(path)
          res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end()
        } catch { json(res, 404, { error: '文件不存在或无法读取，可能已被移动或删除。' }) }
        return
      }
      const mime = PREVIEW_MIME[cleaned.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream'
      try {
        const content = await readFile(cleaned)
        if (content.length > 48 * 1024 * 1024) { json(res, 413, { error: '文件超过 48 MB，请在电脑上打开。' }); return }
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...(mime === 'image/svg+xml' ? { 'content-security-policy': 'sandbox' } : {}) })
        res.end(content)
      } catch { json(res, 404, { error: '文件不存在或无法读取，可能已被移动或删除。' }) }
      return
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html') && this.options.index) {
      const ui = url.searchParams.get('ui')
      const html = injectBoot(await this.options.index(ui === 'custom' || ui === 'native' ? ui : undefined))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(html); return
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && this.options.asset && await this.options.asset(url.pathname, res, req)) return
    this.proxy(req, res, device.id)
  }
  private headers(req: IncomingMessage): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {}
    const blocked = new Set(['host', 'cookie', 'authorization', 'origin', 'referer', 'connection', 'upgrade', 'accept-encoding', 'forwarded', 'sec-fetch-site', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'])
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined && !blocked.has(name) && !name.startsWith('x-forwarded') && !name.startsWith('x-dsh')) headers[name] = value
    const host = `127.0.0.1:${this.options.upstreamPort}`
    return { ...headers, host, cookie: this.options.upstreamCookie(), [REMOTE_MARK]: '1', origin: `http://${host}`, 'sec-fetch-site': 'same-origin', 'accept-encoding': 'identity' }
  }
  private proxy(req: IncomingMessage, res: ServerResponse, deviceId: string): void {
    let upstream: ClientRequest
    upstream = httpRequest({ hostname: '127.0.0.1', port: this.options.upstreamPort, path: req.url, method: req.method, headers: this.headers(req) }, incoming => {
      const headers = { ...incoming.headers }
      delete headers['set-cookie']; delete headers['connection']; delete headers['transfer-encoding']
      if (headers.location) {
        try { const target = new URL(headers.location, `http://127.0.0.1:${this.options.upstreamPort}`); if (target.host === `127.0.0.1:${this.options.upstreamPort}`) headers.location = target.pathname + target.search } catch { delete headers.location }
      }
      res.once('close', () => incoming.destroy())
      if (!headers['content-encoding'] && req.method !== 'HEAD' && gzipFor(req, String(headers['content-type'] ?? ''))) {
        delete headers['content-length']
        res.writeHead(incoming.statusCode ?? 502, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' })
        // Flushed as it goes, so a response the Host writes in pieces still arrives in pieces.
        const gzip = createGzip({ flush: constants.Z_SYNC_FLUSH })
        gzip.on('error', () => res.destroy()); incoming.on('error', () => gzip.destroy())
        incoming.pipe(gzip).pipe(res)
        return
      }
      res.writeHead(incoming.statusCode ?? 502, headers)
      incoming.pipe(res)
    })
    const untrack = this.track(deviceId, () => upstream.destroy()); upstream.once('close', untrack)
    upstream.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'DSH 宿主连接失败。' }); else res.destroy() })
    upstream.setTimeout(120_000, () => upstream.destroy())
    req.once('aborted', () => upstream.destroy()); res.once('close', () => upstream.destroy())
    req.pipe(upstream)
  }
  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const device = this.device(req)
    if (!device || !this.validHost(req) || !sameOrigin(req) || !safePath(req.url ?? '/')) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
    const url = new URL(req.url ?? '/', 'http://gateway.invalid')
    if (url.pathname === '/rc/sse') {
      const target = url.searchParams.get('path') ?? ''
      if (!safePath(target) || target.startsWith('/rc/') || decodeURIComponent(target.split('?')[0]!) === MANAGE_PATH) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
      this.wss.handleUpgrade(req, socket, head, ws => this.sse(req, ws, target, url.searchParams.get('lastEventId') ?? '', device.id)); return
    }
    // Only registered Host WS routes are reachable; no port or destination supplied by clients.
    const headers = this.headers(req); delete headers['sec-websocket-protocol']
    const protocols = req.headers['sec-websocket-protocol']?.split(',').map(p => p.trim()) ?? []
    const upstream = new this.ws.WebSocket(`ws://127.0.0.1:${this.options.upstreamPort}${url.pathname}${url.search}`, protocols, { headers, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false })
    const release = this.track(device.id, () => { upstream.terminate(); socket.destroy() })
    socket.once('close', () => { upstream.terminate(); release() })
    upstream.on('error', () => socket.destroy())
    upstream.once('open', () => {
      if (socket.destroyed) { upstream.terminate(); return }
      this.wss.handleUpgrade(req, socket, head, ws => {
        let alive = true
        const heartbeat = setInterval(() => { if (!alive || !this.device(req)) { ws.terminate(); upstream.terminate(); return }; alive = false; ws.ping() }, 30000)
        heartbeat.unref(); ws.on('pong', () => { alive = true })
        const send = (destination: WebSocket, data: Buffer, binary: boolean) => {
          if (destination.readyState !== OPEN || destination.bufferedAmount > 8 * 1024 * 1024) { ws.terminate(); upstream.terminate(); return }
          destination.send(data, { binary })
        }
        ws.on('message', (data, binary) => send(upstream, data as Buffer, binary))
        upstream.on('message', (data, binary) => send(ws, data as Buffer, binary))
        ws.on('error', () => upstream.terminate())
        ws.once('close', () => { clearInterval(heartbeat); upstream.terminate(); release() })
        upstream.once('close', (code, reason) => { if (ws.readyState === OPEN) ws.close(code === 1006 ? 1011 : code, reason) })
      })
    })
  }
  private sse(req: IncomingMessage, ws: WebSocket, path: string, lastId: string, deviceId: string): void {
    const headers = this.headers(req); headers.accept = 'text/event-stream'
    if (lastId && lastId.length < 4096 && !/[\r\n]/.test(lastId)) headers['last-event-id'] = lastId
    const decoder = new StringDecoder('utf8')
    const upstream = httpRequest({ hostname: '127.0.0.1', port: this.options.upstreamPort, path, headers }, response => {
      if (response.statusCode !== 200 || !response.headers['content-type']?.includes('text/event-stream')) { ws.send(JSON.stringify({ type: 'error' })); response.destroy(); ws.close(); return }
      ws.send(JSON.stringify({ type: 'ready' }))
      response.on('data', chunk => {
        if (ws.readyState !== OPEN || ws.bufferedAmount > 1024 * 1024) { upstream.destroy(); ws.terminate(); return }
        ws.send(JSON.stringify({ type: 'chunk', data: decoder.write(chunk) }))
      })
      response.once('end', () => { const tail = decoder.end(); if (tail && ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'chunk', data: tail })); ws.close() })
      response.once('error', () => ws.terminate())
      ws.once('close', () => response.destroy())
    })
    const release = this.track(deviceId, () => { upstream.destroy(); ws.terminate() })
    let alive = true; ws.on('pong', () => { alive = true })
    const ping = setInterval(() => { if (!alive || !this.device(req)) { upstream.destroy(); ws.terminate(); return }; alive = false; if (ws.readyState === OPEN) ws.ping() }, 30000); ping.unref()
    ws.once('close', () => { clearInterval(ping); upstream.destroy(); release() })
    ws.on('error', () => upstream.destroy()); upstream.on('error', () => ws.close(1011, 'Host unavailable')); upstream.end()
  }
  async close(): Promise<void> {
    this.entries.clear()
    this.previews.clear()
    for (const id of [...this.active.keys()]) this.revoke(id)
    for (const socket of this.sockets) socket.destroy()
    for (const socket of this.wss?.clients ?? []) socket.terminate()
    const server = this.server; this.server = undefined
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    this.port = 0; this.authorities.clear()
  }
}
