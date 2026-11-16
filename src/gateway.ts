import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse, ClientRequest } from 'node:http'
import { createServer as createSecureServer, Server as HttpsServer } from 'node:https'
import { createSecureContext } from 'node:tls'
import { createHash, randomBytes } from 'node:crypto'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { pipeline, type Duplex } from 'node:stream'
import type { WebSocket, WebSocketServer } from 'ws'
import type { PairingService, Device } from './pairing.js'
import { body, cookie, gzipFor, json, sameOrigin } from './http.js'
import { constants, createGzip } from 'node:zlib'
import { deniedPage, pairingPage, unavailablePage, type PairingNode } from './pages.js'
import { ACME_CHALLENGE_PREFIX } from './acme-certificate.js'
import type { PublicAccess } from './public-access.js'
import { BOOT_PATH, injectBoot, type BootContext } from './boot.js'
import { PREVIEW_MIME, PREVIEW_PREFIX, WorkspacePreviews, previewEntry } from './workspace-preview.js'
import type { LanTlsMaterial } from './lan-tls.js'
import { fingerprintGroupsOf } from './host-identity.js'
import { PUBLIC_NODE_PATH, PUBLIC_NODE_PROTOCOL, type PublicNodeDiscovery } from './public-node.js'

export const MANAGE_PATH = '/api/dsh-remote-connect/manage'
/** The paired browser asks this same-host route whether the LAN entry is the same computer. */
export const FALLBACK_PATH = '/rc/fallback'
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
  /** The Host's own index page, rendered by the Host so the phone always runs its current version. */
  index: () => Promise<string>
  /** The boot script the page loads from {@link BOOT_PATH}, built per request from the plugin settings. */
  boot: (context?: BootContext) => string
  /** Addresses this computer can currently be reached at; read on every request, since they change with the network. */
  addresses?: () => string[]
  lanTls?: LanTlsMaterial
  /** Fixed-domain public entry: its domain admits the tunnel, and its mode turns on the double confirmation. */
  public?: () => PublicAccess | undefined
  /** This computer's LAN origin while a public entry is running, for the same-host fallback. */
  lanFallback?: () => string | undefined
  /** Compress the WebSocket legs; a phone with a long session history spends most of its time here. */
  websocketCompression?: boolean
  /** Receives one diagnostic report per remote boot, also from devices that fail to pair. */
  onBootReport?: (report: Record<string, unknown>, device: { id: string; name: string } | undefined) => void
  /** Public identity document at {@link PUBLIC_NODE_PATH}; served before pairing, absent means "not advertised". */
  discovery?: PublicNodeDiscovery
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

/** `ws` throws on a close code it may not send, and a Host close frame can carry 1005/1006. */
export function closeCode(code: number): number {
  return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999) ? code : 1011
}

/** Authenticates every remote request before the privileged loopback leg. */
export class Gateway {
  private server?: Server | HttpsServer
  private lanTls?: LanTlsMaterial
  private readonly sockets = new Set<Duplex>()
  private readonly active = new Map<string, Set<() => void>>()
  // `ws` is loaded when the gateway is opened, not when the plugin is: most Host starts never open one.
  private ws!: typeof import('ws')
  private wss!: WebSocketServer
  private readonly rates = new Map<string, { count: number; until: number }>()
  private readonly authorities = new Set<string>()
  private readonly previews = new WorkspacePreviews()
  port = 0
  constructor(private readonly options: GatewayOptions) { this.lanTls = options.lanTls }
  /** Compression is on unless the user turns it off; both legs read it once per connection. */
  private get deflate(): boolean { return this.options.websocketCompression !== false }
  allowAuthority(authority: string): void { this.authorities.add(authority.toLowerCase()) }
  disallowAuthority(authority: string): void { this.authorities.delete(authority.toLowerCase()) }
  private validHost(req: IncomingMessage): boolean {
    const host = req.headers.host?.toLowerCase()
    if (!host) return false
    if (this.lanTls) return host === new URL(this.lanTls.origin).host
    const publicHost = this.options.public?.()?.domain
    return this.authorities.has(host) || (publicHost !== null && publicHost !== undefined && host === new URL(publicHost).host.toLowerCase()) || (this.options.addresses?.().some(address => host === `${address}:${this.port}`) ?? false)
  }
  async listen(host: '127.0.0.1' | '0.0.0.0', port = 0): Promise<number> {
    if (this.server) throw new Error('远程网关已启动。')
    if (this.lanTls && port !== Number(new URL(this.lanTls.origin).port || 443)) throw new Error('局域网 HTTPS 监听端口必须与配置地址一致。')
    this.ws ??= await import('ws')
    this.wss ??= new this.ws.WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024, perMessageDeflate: this.deflate })
    const listener = (req: IncomingMessage, res: ServerResponse): void => { void this.handle(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: '请求处理失败，请在本机查看状态。' }); else res.destroy() }) }
    const server = this.lanTls ? createSecureServer({ cert: this.lanTls.cert, key: this.lanTls.key }, listener) : createServer(listener)
    this.server = server
    server.on('connection', socket => { this.sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => this.sockets.delete(socket)) })
    server.on('upgrade', (req, socket, head) => { socket.on('error', () => {}); void this.upgrade(req, socket, head).catch(() => socket.destroy()) })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve() }) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('无法读取网关端口。')
    this.port = address.port
    if (!this.lanTls) { this.allowAuthority(`127.0.0.1:${this.port}`); this.allowAuthority(`localhost:${this.port}`) }
    return this.port
  }
  reloadLanCertificate(material: LanTlsMaterial): void {
    if (!(this.server instanceof HttpsServer) || !this.lanTls) throw new Error('局域网 HTTPS 尚未启动。')
    if (material.origin !== this.lanTls.origin) throw new Error('重新加载证书不能改变局域网 HTTPS 地址。')
    createSecureContext({ cert: material.cert, key: material.key })
    this.server.setSecureContext({ cert: material.cert, key: material.key })
    this.lanTls = material
  }
  private sameOrigin(req: IncomingMessage): boolean { return sameOrigin(req, this.lanTls?.origin) }
  private publicRequest(req: IncomingMessage): boolean {
    if (this.lanTls) return false
    const access = this.options.public?.()
    if (!access?.domain) return false
    if (req.headers.host?.toLowerCase() === new URL(access.domain).host.toLowerCase()) return true
    return Object.keys(req.headers).some(name => name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-') || name.startsWith('cf-'))
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
  /**
   * The discovery document is public by design: an unpaired device must be able to learn what this
   * node is. It still sits behind safePath/validHost and answers only this exact path with GET/HEAD,
   * so it cannot become a way around pairing for any other route.
   */
  private discovery(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: '发现接口只支持 GET 或 HEAD。' }); return }
    const document = this.options.discovery
    if (!document) { json(res, 404, { error: 'not found' }); return }
    const payload = JSON.stringify(document)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(payload) })
    // HEAD reports the bytes a GET would return without sending them.
    res.end(req.method === 'HEAD' ? undefined : payload)
  }
  /** The public pairing page shows the node before anything is sent; LAN pages stay as they were. */
  private pairingNode(): PairingNode | undefined {
    const discovery = this.options.discovery
    if (!discovery || this.lanTls) return undefined
    return { name: discovery.name, kind: discovery.kind, fingerprint: discovery.fingerprint, fingerprintGroups: fingerprintGroupsOf(discovery.fingerprint), protocol: discovery.protocol }
  }
  /** The LAN origin of this same computer while the public entry runs; nothing else may be a fallback target. */
  private lanFallback(): string | undefined {
    if (this.lanTls || !this.options.public?.()) return undefined
    return this.options.lanFallback?.()
  }
  /**
   * The LAN node's own discovery document must name this same computer: kind, protocol and both
   * identity fields. A LAN address belonging to another computer or another Host never passes.
   */
  private async sameLanNode(origin: string): Promise<boolean> {
    const discovery = this.options.discovery
    if (!discovery) return false
    try {
      const response = await globalThis.fetch(origin + PUBLIC_NODE_PATH, {
        method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
        headers: { accept: 'application/json' }, referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(3_000),
      })
      if (response.status !== 200 || response.type === 'opaqueredirect') return false
      const body: unknown = await response.json()
      if (!body || typeof body !== 'object' || Array.isArray(body)) return false
      const node = body as Record<string, unknown>
      return node.protocol === PUBLIC_NODE_PROTOCOL && node.kind === 'gateway' && node.hostId === discovery.hostId && node.fingerprint === discovery.fingerprint
    } catch { return false }
  }
  private bootContext(): BootContext | undefined {
    const discovery = this.options.discovery, lan = this.lanFallback()
    if (!discovery || !lan) return undefined
    return { fallback: { hostId: discovery.hostId, fingerprint: discovery.fingerprint, url: lan } }
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!safePath(req.url ?? '/') || !this.validHost(req)) { json(res, 403, { error: '不受信任的访问地址。' }); return }
    const url = new URL(req.url ?? '/', 'http://gateway.invalid')
    if (url.pathname === PUBLIC_NODE_PATH) { this.discovery(req, res); return }
    const publicRequest = this.publicRequest(req)
    if (url.pathname.startsWith(ACME_CHALLENGE_PREFIX)) {
      if (!publicRequest) { json(res, 404, { error: 'not found' }); return }
      if (await this.acme(req, res, url.pathname)) return
    }
    if (url.pathname === '/rc/health') {
      if (!publicRequest) { json(res, 404, { error: 'not found' }); return }
      json(res, 200, { ok: true, service: 'dsh-remote-connect', instanceId: this.options.public?.()?.instanceId }); return
    }
    if (url.pathname === '/pair' && req.method === 'GET') {
      // The public page starts with what node it reached: the browser and the computer each confirm
      // this same identity before any device cookie is issued. A LAN page keeps its single QR flow.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' })
      res.end(pairingPage(publicRequest ? this.pairingNode() : undefined)); return
    }
    if (url.pathname === '/rc/pair/request' || url.pathname === '/rc/pair/claim') {
      if (req.method !== 'POST' || !this.sameOrigin(req)) { json(res, 403, { error: '需要同源 POST 请求。' }); return }
      if (!this.rate(req)) { json(res, 429, { error: '请求过于频繁，请稍后再试。' }); return }
      try {
        const input = await body(req)
        if (url.pathname.endsWith('/request')) {
          // The public page confirms this host's fingerprint before it asks for a ticket. A page that
          // cannot show the same fingerprint as this gateway (a proxy, a stale copy) is refused, and
          // the panel learns why instead of waiting for a pairing that will never be approved.
          if (publicRequest) {
            const expected = this.options.discovery?.fingerprint
            if (!expected || String(input.fingerprint ?? '') !== expected) {
              const reason = '配对页面的主机指纹与这台电脑不一致，请重新打开配对页。'
              this.options.pairing.reportFailure('', reason)
              json(res, 403, { error: reason, code: 'fingerprint_mismatch' }); return
            }
          }
          json(res, 200, this.options.pairing.request(String(input.token ?? ''), req.headers['user-agent'] ?? '', req.headers.host, typeof input.model === 'string' ? input.model : undefined, publicRequest ? 'public' : 'lan', publicRequest))
        } else {
          const result = this.options.pairing.claim(String(input.id ?? ''), String(input.key ?? ''))
          if (result.credential) res.setHeader('set-cookie', this.cookieHeader(req, result.credential, !!this.lanTls || publicRequest))
          json(res, 200, { state: result.state })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '配对失败。'
        // Ticket expired or already used: the browser is told, and so is the panel.
        this.options.pairing.reportFailure('', message)
        json(res, 400, { error: message })
      }
      return
    }
    // A boot that only fails on the phone would otherwise be undebuggable: accept one small
    // diagnostic report per page load even from unpaired devices, and note who did report.
    if (url.pathname === '/rc/boot-report') {
      if (req.method !== 'POST' || !this.sameOrigin(req)) { json(res, 403, { error: '需要同源 POST 请求。' }); return }
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
      if (!['GET', 'HEAD'].includes(req.method ?? '') || (req.headers.origin && req.headers.origin !== 'null' && !this.sameOrigin(req))) { json(res, 403, { error: '拒绝跨站请求。' }); return }
      if (!preview) { json(res, 404, { error: '预览已过期，请在对话中重新打开。' }); return }
      const untrack = this.track(preview.deviceId, () => { req.destroy(); res.destroy() }); res.once('close', untrack)
      await this.previews.serve(preview, req, res)
      return
    }
    const device = this.device(req)
    if (!device) {
      if (req.headers.accept?.includes('text/html') && req.method === 'GET') {
        // A fallback landing without a LAN authorization is told to scan again on this same computer.
        const reason = url.searchParams.get('rc') === 'lan' ? '这台设备没有这台电脑的局域网授权，不能从公网连接自动切换。' : undefined
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(deniedPage(reason))
      }
      else json(res, 403, { error: '设备尚未配对或授权已撤销。', code: 'unpaired' })
      req.resume(); return
    }
    // Arriving from elsewhere may only open the app page itself; that reads nothing and changes nothing.
    const opening = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document' && (url.pathname === '/' || url.pathname === '/index.html')
    if (!this.sameOrigin(req) && !opening) { json(res, 403, { error: '拒绝跨站请求。' }); return }
    // A paired browser whose public connection died asks whether this computer's LAN entry is the
    // same Host. Only then may it navigate there; the browser verifies this answer against the
    // identity the boot script received, so a wrong or forged URL can never be followed.
    if (url.pathname === FALLBACK_PATH) {
      if (req.method !== 'POST' || !this.sameOrigin(req)) { json(res, 403, { error: '需要同源 POST 请求。' }); return }
      if (!this.rate(req)) { json(res, 429, { error: '请求过于频繁，请稍后再试。' }); return }
      const lan = this.lanFallback(), discovery = this.options.discovery
      if (!lan) { json(res, 200, { sameHost: false, reason: 'no-lan-entry' }); return }
      if (!discovery) { json(res, 200, { sameHost: false, reason: 'no-identity' }); return }
      if (!(await this.sameLanNode(lan))) { json(res, 200, { sameHost: false, reason: 'identity' }); return }
      json(res, 200, { sameHost: true, url: lan, hostId: discovery.hostId, fingerprint: discovery.fingerprint })
      return
    }
    // Renew the browser expiry along with the durable 30-day idle authorization.
    res.setHeader('set-cookie', this.cookieHeader(req, cookie(req)!, !!this.lanTls || publicRequest))
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
        const file = await open(cleaned, 'r')
        try {
          const info = await file.stat()
          if (!info.isFile()) { json(res, 404, { error: '请选择普通文件。' }); return }
          if (info.size > 48 * 1024 * 1024) { json(res, 413, { error: '文件超过 48 MiB，请在电脑上打开。' }); return }
          if (res.destroyed) return
          const stream = file.createReadStream({ autoClose: false })
          stream.on('error', () => res.destroy())
          res.once('close', () => stream.destroy())
          res.writeHead(200, { 'content-type': mime, 'content-length': info.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...(mime === 'image/svg+xml' ? { 'content-security-policy': 'sandbox' } : {}) })
          await new Promise<void>(resolve => { stream.once('close', resolve); stream.once('end', resolve); stream.pipe(res) })
        } finally { await file.close() }
      } catch { json(res, 404, { error: '文件不存在或无法读取，可能已被移动或删除。' }) }
      return
    }
    if (url.pathname === BOOT_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'GET only' }); return }
      // This is a blocking script in the page head, so a phone that already holds this exact
      // build must be able to revalidate it instead of downloading it again on every cold start.
      const script = this.options.boot(this.bootContext())
      const etag = '"' + createHash('sha256').update(script).digest('base64url').slice(0, 22) + '"'
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { 'cache-control': 'private, no-cache', etag }); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, no-cache', etag, 'x-content-type-options': 'nosniff' })
      res.end(req.method === 'HEAD' ? undefined : script)
      return
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      // `?ui=custom` and `?ui=native` were two phone interfaces in earlier releases; the phone now
      // shows the Host's own page, and a saved link or QR code must not 404 on the way there.
      if (url.searchParams.has('ui')) { res.writeHead(302, { location: '/', 'cache-control': 'no-store' }); res.end(); return }
      let html: string
      try { html = injectBoot(await this.options.index()) }
      catch (failure) {
        res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        res.end(unavailablePage(failure instanceof Error ? failure.message : undefined))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(html); return
    }
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
      const status = incoming.statusCode ?? 502
      // The Host now answers with ETag and 304, and a 304 must arrive without a body: it tells the
      // phone to reuse the copy it already has, which was this plugin's gzip variant.
      // A 304 carries no representation type, so it is always treated as the variant this gateway
      // would have compressed: the copy the phone kept is that gzip body.
      const compressible = !headers['content-encoding'] && req.headers.range === undefined && (status === 304 || gzipFor(req, String(headers['content-type'] ?? '')))
      if (compressible && (status === 304 || req.method === 'HEAD')) headers.vary = 'accept-encoding'
      if (compressible && status !== 204 && status !== 304 && req.method !== 'HEAD' && headers['content-length'] !== '0') {
        delete headers['content-length']
        res.writeHead(status, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' })
        // Flushed as it goes, so a response the Host writes in pieces still arrives in pieces.
        const gzip = createGzip({ flush: constants.Z_SYNC_FLUSH })
        pipeline(incoming, gzip, res, () => {})
        return
      }
      res.writeHead(status, headers)
      pipeline(incoming, res, () => {})
    })
    const untrack = this.track(deviceId, () => upstream.destroy()); upstream.once('close', untrack)
    upstream.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'DSH 宿主连接失败。' }); else res.destroy() })
    // The idle timer only covers the wait for response headers: a Host that streams a long
    // answer quietly for over two minutes is working, not stuck.
    upstream.setTimeout(120_000, () => upstream.destroy())
    upstream.once('response', () => upstream.setTimeout(0))
    req.once('aborted', () => upstream.destroy()); res.once('close', () => upstream.destroy())
    req.pipe(upstream)
  }
  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const device = this.device(req)
    if (!device || !this.validHost(req) || !this.sameOrigin(req) || !safePath(req.url ?? '/')) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
    const url = new URL(req.url ?? '/', 'http://gateway.invalid')
    if (url.pathname === '/rc/sse') {
      const target = url.searchParams.get('path') ?? ''
      if (!safePath(target) || target.startsWith('/rc/') || decodeURIComponent(target.split('?')[0]!) === MANAGE_PATH) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
      this.wss.handleUpgrade(req, socket, head, ws => this.sse(req, ws, target, url.searchParams.get('lastEventId') ?? '', device.id)); return
    }
    // Only registered Host WS routes are reachable; no port or destination supplied by clients.
    const headers = this.headers(req); delete headers['sec-websocket-protocol']
    const protocols = req.headers['sec-websocket-protocol']?.split(',').map(p => p.trim()) ?? []
    const upstream = new this.ws.WebSocket(`ws://127.0.0.1:${this.options.upstreamPort}${url.pathname}${url.search}`, protocols, { headers, maxPayload: 32 * 1024 * 1024, perMessageDeflate: this.deflate })
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
        // A close frame the Host sent with no code arrives as 1005, which `ws` refuses to send:
        // the throw happens inside an EventEmitter callback, where nothing can catch it for us.
        upstream.once('close', (code, reason) => {
          if (ws.readyState !== OPEN) return
          try { ws.close(closeCode(code), reason) } catch { ws.terminate() }
        })
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
    this.previews.clear()
    for (const id of [...this.active.keys()]) this.revoke(id)
    for (const socket of this.sockets) socket.destroy()
    for (const socket of this.wss?.clients ?? []) socket.terminate()
    const server = this.server; this.server = undefined
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    this.port = 0; this.authorities.clear()
  }
}
