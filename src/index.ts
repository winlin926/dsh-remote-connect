import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PairingService } from './pairing.js'
import { Gateway, MANAGE_PATH, REMOTE_MARK } from './gateway.js'
import { FRPC_CERTIFICATE_DIR, PUBLIC_PORT, PublicAccess } from './public-access.js'
import { normalizePublicUrl } from './public-url-settings.js'
import { PublicNodeConfig, type PublicNodeRecord } from './public-node-config.js'
import { ServiceNode, forgetServiceNode } from './service-node.js'
import { body, isLoopback, json, sameOrigin } from './http.js'
import { bootScript } from './boot.js'
import { detectSystemProxy, type SystemProxy } from './system-proxy.js'
import { readLanTls, type LanTlsConfig, type LanTlsMaterial } from './lan-tls.js'
import { loadHostIdentity, fingerprintGroupsOf } from './host-identity.js'
import { PUBLIC_NODE_PROTOCOL, detectPublicNode, type PublicNodeDiscovery } from './public-node.js'

/** Advertised by discovery; read from the installed package so it always matches the running build. */
const NODE_VERSION = (() => {
  try { const value: unknown = createRequire(import.meta.url)('../package.json').version; return typeof value === 'string' && value ? value : '0.0.0' } catch { return '0.0.0' }
})()

export const name = '@winlin926/dsh-remote-connect'
export const inject = ['connection']
export const Config = z.object({
  gatewayPort: z.natural().max(65535).default(0).i18n({ 'zh-CN': { $description: '局域网网关端口；0 表示自动选择空闲端口。' } }),
  lanTls: z.object({
    hostname: z.string().required(),
    certFile: z.string().required(),
    keyFile: z.string().required(),
  }).default(undefined as never).i18n({ 'zh-CN': { $description: '局域网 HTTPS：可信域名、PEM 证书及私钥文件路径；需固定网关端口并配置局域网 DNS。证书由外部签发和续期。' } }),
  certificateDir: z.string().default('').i18n({ 'zh-CN': { $description: '证书部署目录；留空使用 SakuraFrp 的 FrpcWorkingDirectory。' } }),
  websocketCompression: z.boolean().default(true).i18n({ 'zh-CN': { $description: '压缩远程连接的 WebSocket 消息，减少长会话历史的传输量；连接两端不再压缩时更省电但更费流量。' } }),
})
export interface Config { gatewayPort?: number; lanTls?: LanTlsConfig; certificateDir?: string; websocketCompression?: boolean }
type Mode = 'public' | 'lan'
/** Where outbound domain checks and certificate requests get their proxy. */
type ProxyMode = 'system' | 'manual' | 'off'
const isProxyMode = (value: unknown): value is ProxyMode => value === 'system' || value === 'manual' || value === 'off'
interface Preferences {
  autoStart: boolean; mode: Mode; proxy?: string; proxyMode: ProxyMode
  /** The port last used, tried again so the address a phone knows keeps working after a restart. */
  port?: number
}
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
function bootReport(report: Record<string, unknown>): Record<string, unknown> {
  const text = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : undefined
  const address = (origin: unknown, path: unknown, rev?: unknown) => {
    try {
      const url = new URL(String(path ?? '/'), String(origin))
      if (!['http:', 'https:'].includes(url.protocol)) return {}
      return { origin: url.origin, path: url.pathname.slice(0, 3000), ...(typeof rev === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(rev) ? { rev } : {}) }
    } catch { return {} }
  }
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
  const errors = Array.isArray(report.errors) ? report.errors.slice(0, 6).filter((value): value is string => typeof value === 'string').map(value => value
    .replace(/https?:\/\/[^\s]+/g, raw => { try { const url = new URL(raw); return url.origin + url.pathname } catch { return '[URL]' } })
    .replace(/\b(token|key|pin|password|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]').slice(0, 400)) : []
  return {
    ...address(report.origin, report.path), viewport: text(report.viewport, 60), ua: text(report.ua, 300),
    phase: text(report.phase, 32), result: text(report.result, 32), durationMs: number(report.durationMs), completedResources: number(report.completedResources),
    mounted: report.mounted === true, errors,
    resources: Array.isArray(report.resources) ? report.resources.slice(0, 12).flatMap(value => {
      if (!value || typeof value !== 'object') return []
      const resource = value as Record<string, unknown>
      return [{ ...address(resource.origin, resource.path, resource.rev), result: text(resource.result, 20), durationMs: number(resource.durationMs) }]
    }) : [],
  }
}
function appendBootReport(file: string, report: Record<string, unknown>, device: { id: string; name: string } | undefined): void {
  const line = JSON.stringify({ time: new Date().toISOString(), device, ...bootReport(report) }) + '\n'
  let previous = ''
  try { previous = readFileSync(file, 'utf8') } catch { /* the first report creates the file */ }
  const kept = previous.length > BOOT_REPORT_LIMIT ? previous.slice(previous.indexOf('\n', previous.length - BOOT_REPORT_LIMIT / 2) + 1) : previous
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, kept + line, { mode: 0o600 }); renameSync(temporary, file)
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const profile = ctx.get('profileContext') as { name?: string } | undefined
  const storage = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-remote-connect', String(profile?.name || process.env.DSH_PROFILE || 'default').replace(/[^a-zA-Z0-9_-]/g, '_'))
  const legacyStorage = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-roam')
  mkdirSync(storage, { recursive: true })
  // One identity per profile: the gateway advertises it now, and any future local service reuses the
  // same file, so the Host keeps one hostId across restarts and never shares a pairing/cache scope.
  const hostIdentity = await loadHostIdentity(join(storage, 'host-identity.json'))
  const discovery: PublicNodeDiscovery = { protocol: PUBLIC_NODE_PROTOCOL, kind: 'gateway', name: 'DeepSeek Harness', version: NODE_VERSION, capabilities: ['pairing', 'official-ui', 'cache'], hostId: hostIdentity.hostId, fingerprint: hostIdentity.fingerprint }
  const prefsFile = join(storage, 'preferences.json')
  let preferences: Preferences = { autoStart: false, mode: 'lan', proxyMode: 'off' }
  let error: string | undefined
  if (existsSync(prefsFile)) {
    try {
      const stored = JSON.parse(readFileSync(prefsFile, 'utf8')) as Partial<Preferences>
      preferences = { autoStart: stored.autoStart === true, mode: stored.mode === 'public' ? 'public' : 'lan', proxy: typeof stored.proxy === 'string' ? stored.proxy : undefined,
        // An address typed before proxy modes existed is still an explicit manual choice.
        proxyMode: isProxyMode(stored.proxyMode) ? stored.proxyMode : stored.proxy ? 'manual' : 'off', port: Number.isInteger(stored.port) && stored.port! > 0 && stored.port! < 65536 ? stored.port : undefined }
    } catch {
      // A damaged preferences file must not keep the plugin from loading; device authorizations live elsewhere.
      error = '远程控制的偏好设置文件已损坏，已恢复默认设置（设备授权不受影响）。'
    }
  }
  function savePreferences(): void {
    const temporary = `${prefsFile}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(preferences), { mode: 0o600 }); renameSync(temporary, prefsFile)
  }
  // The list is optional: a damaged file must not keep the plugin from loading. Its reason stays on the
  // panel, the node actions refuse to run, and the migration from the old public-url.json is preserved
  // by the module itself.
  let publicNodes: PublicNodeConfig | undefined
  let publicNodesError: string | undefined
  try {
    publicNodes = new PublicNodeConfig({ file: join(storage, 'public-nodes.json'), legacyFile: join(storage, 'public-url.json') })
  } catch (failure) {
    publicNodesError = failure instanceof Error ? failure.message : '公网节点配置文件读取失败。'
    error = publicNodesError
  }
  let gateway: Gateway | undefined
  let lanTls: LanTlsMaterial | undefined
  let lanTlsError: string | undefined
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
    // The phone runs the Host's own page. Asking the Host for it keeps the phone on the version the
    // computer is actually running: a DSH update reaches phones without a plugin release, and no
    // stale copy of the frontend can be served against a newer Host.
    const upstreamIndex = (cookie: string): Promise<string> => new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: upstreamPort, path: '/', method: 'GET', headers: { host: `127.0.0.1:${upstreamPort}`, cookie, 'accept-encoding': 'identity' } }, response => {
        const status = response.statusCode ?? 502
        if (status !== 200) { response.resume(); reject(Object.assign(new Error(`DSH 宿主首页返回 ${status}`), { status })); return }
        let html = ''
        response.setEncoding('utf8')
        response.once('error', reject)
        response.on('data', (chunk: string) => { html += chunk })
        response.once('end', () => resolve(html))
      })
      request.once('error', (failure: NodeJS.ErrnoException) => reject(new Error(failure.code === 'ECONNREFUSED' ? '电脑上的 DSH 没有在监听。' : failure.message)))
      request.setTimeout(10_000, () => request.destroy(new Error('DSH 宿主首页超时。')))
      request.end()
    })
    const renderIndex = async (): Promise<string> => {
      try { return await upstreamIndex(credential) }
      catch (failure) {
        // A gateway left running for weeks can outlive its Host session; renew once before failing.
        if ((failure as { status?: number }).status !== 401) throw failure
        credential = hostCookie(ready.connection, upstreamPort)
        return upstreamIndex(credential)
      }
    }
    const baseURLs = () => !enabled || !gateway ? [] : activeMode === 'public' ? (access?.domain ? [access.domain] : []) : lanTls ? [lanTls.origin] : lanAddresses().map(ip => `http://${ip}:${gateway!.port}`)
    // The system's proxy is looked up at most every 15 seconds; the panel asks for status far more often.
    let detected: { at: number; value: SystemProxy | null } | undefined
    const systemProxy = async (fresh = false) => {
      if (fresh || !detected || Date.now() - detected.at > 15_000) detected = { at: Date.now(), value: await detectSystemProxy().catch(() => null) }
      return detected.value
    }
    access = new PublicAccess({ certificateDir: config.certificateDir || process.env.DSH_RC_CERTIFICATE_DIR || FRPC_CERTIFICATE_DIR, storage, legacyStorage, identity: { hostId: hostIdentity.hostId, fingerprint: hostIdentity.fingerprint }, proxy: async () => {
      if (preferences.proxyMode === 'manual') return preferences.proxy
      if (preferences.proxyMode === 'system') return (await systemProxy(true))?.url
      return undefined
    }, beforeIssue: async () => {
      if (!enabled || activeMode !== 'public' || gateway?.port !== PUBLIC_PORT) throw new Error('请先开启固定公网连接，再申请证书。')
    }, log: message => ready.logger?.warn?.(message) })
    // An explicit, idempotent migration: authorizations issued through a public entry before the
    // double-confirmation flow stay readable in the panel, but are marked `requiresRepair` so an
    // upgrade cannot keep letting that cookie in. LAN authorizations are untouched.
    const migrateDevices = (): void => {
      try { pairing.migratePublicDevices(access?.domain ? [access.domain] : []) }
      catch (failure) { error = failure instanceof Error ? failure.message : '旧公网设备授权迁移失败。' }
    }
    await access.migrate()
    migrateDevices()
    access.certificates.startAutoRenew()
    // The QR library is loaded with the first code drawn, and a code is only redrawn when its link changes.
    let drawn: { url: string; image: string } | undefined
    const qrImage = async (url: string) => {
      if (drawn?.url !== url) drawn = { url, image: await (await import('qrcode')).default.toDataURL(url, { width: 260, margin: 2, errorCorrectionLevel: 'M' }) }
      return drawn.image
    }
    // ── self-hosted service node ────────────────────────────────────────────────────────────────
    // The node record owns more than the old public domain: a `service` node is reached through an
    // outbound tunnel this computer starts, so one instance follows the current record and every
    // lifecycle change (start, stop, switch, remove) reconciles through this function.
    let serviceNode: ServiceNode | undefined
    const currentNode = (): PublicNodeRecord | undefined => {
      const current = publicNodes?.current
      return current ? publicNodes?.list().find(record => record.id === current) : undefined
    }
    const nodeStore = (): PublicNodeConfig => {
      if (!publicNodes) throw new Error(publicNodesError ?? '公网节点配置不可用。')
      return publicNodes
    }
    const logServiceNode = (event: string, fields: Record<string, unknown>): void => {
      try { ready.logger?.warn?.(`[${event}] ${JSON.stringify(fields)}`) } catch { /* logging must never break the tunnel */ }
    }
    const reconcileServiceNode = async (): Promise<void> => {
      const record = currentNode()
      const wanted = enabled && activeMode === 'public' && preferences.mode === 'public' && record?.kind === 'service' ? record.url : undefined
      if (serviceNode && serviceNode.status().origin !== wanted) {
        const previous = serviceNode
        serviceNode = undefined
        await previous.stop()
      }
      if (!wanted || serviceNode || disposed) return
      const node = new ServiceNode({
        origin: wanted, hostId: hostIdentity.hostId, identityKey: hostIdentity.publicKey, clientVersion: NODE_VERSION,
        upstreamPort, upstreamCookie: () => credential, storage, log: logServiceNode,
      })
      serviceNode = node
      // start() reports failures through status().lastError and keeps retrying; it never rejects.
      await node.start()
    }
    const status = async (local: boolean) => {
      const links = baseURLs().map(base => ({ base, url: qr ? `${base}/pair#pair=${qr.token}` : undefined }))
      const active = new Set(gateway?.onlineIds() ?? [])
      const devices = pairing.list()
      const record = currentNode()
      const tunnel = serviceNode?.status()
      const publicNodeList = publicNodes?.list() ?? []
      const service = record?.kind === 'service'
        ? { origin: record.url, connected: tunnel?.connected ?? false, ...(tunnel?.lastError ? { lastError: tunnel.lastError } : {}), pendingPairings: tunnel?.pendingPairings ?? [] }
        : null
      // The tunnel is the public entry for a service node: report connecting until it is up, but never
      // let its failure become the plugin's error — LAN fallback and device access stay independent.
      const phase = enabled && activeMode === 'public' && record?.kind === 'service'
        ? (tunnel?.connected ? 'ready' : 'connecting')
        : enabled ? 'ready' : error ? 'error' : 'off'
      return {
        enabled, busy, mode: preferences.mode, activeMode, autoStart: preferences.autoStart,
        proxyConfigured: !!preferences.proxy, proxyMode: preferences.proxyMode, manualProxy: local ? preferences.proxy : undefined,
        systemProxy: preferences.proxyMode === 'system' && preferences.mode === 'public' ? await systemProxy() : undefined,
        publicUrl: access?.domain, publicPort: PUBLIC_PORT,
        // The public pairing page and the panel show the same identity; the browser and the
        // computer each confirm it before a device cookie is issued.
        node: { name: discovery.name, kind: discovery.kind, protocol: discovery.protocol, fingerprint: discovery.fingerprint, fingerprintGroups: fingerprintGroupsOf(discovery.fingerprint) },
        pairingFailure: local ? pairing.failure() : undefined,
        repairRequired: devices.filter(device => device.requiresRepair).length,
        publicUrlCheck: local ? access?.lastCheck : undefined, certificate: local && access?.domain ? await access.certificateStatus() : undefined,
        lanTls: config.lanTls ? { origin: lanTls?.origin, expiresAt: lanTls?.expiresAt, error: lanTlsError } : undefined,
        publicNodes: { current: publicNodes?.current ?? null, list: publicNodeList, pendingReview: publicNodeList.some(item => item.pending) },
        serviceNode: service,
        phase, error, gatewayPort: gateway?.port ?? 0, local,
        expiresAt: qr?.expiresAt, links, qr: links[0]?.url ? await qrImage(links[0].url) : undefined,
        requests: local ? pairing.requests() : [],
        devices: devices.map(({ host, via: pairedVia, ...device }) => ({
          ...device, via: pairedVia ?? (host && access?.domain && host.toLowerCase() === new URL(access.domain).host.toLowerCase() ? 'public' : 'lan'), online: active.has(device.id)
        })),
        lanHint: config.lanTls ? '手机需在同一局域网，并将 HTTPS 域名解析到电脑的局域网地址。证书需由手机信任；插件不修改 DNS、防火墙或证书信任。' : '手机需与电脑处于同一局域网。若连接被防火墙阻断，请手动允许网关端口；插件不会修改防火墙。',
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
      await reconcileServiceNode()
    }
    shutdown = stop
    const start = async () => {
      if (busy) throw new Error('连接操作正在进行，请稍后再试。')
      // A service node is reached through its own tunnel origin, so it needs no stored public domain.
      const serviceNodeMode = currentNode()?.kind === 'service'
      if (preferences.mode === 'public' && !serviceNodeMode && !access?.domain) throw new Error('请先填写固定公网域名，再开启“任意网络”。')
      busy = true; error = undefined
      let ticket = generation
      let next: Gateway | undefined
      let stopped = false
      try {
        const mode = preferences.mode
        let tls: LanTlsMaterial | undefined
        if (mode === 'lan' && config.lanTls) {
          try { tls = await readLanTls(config.lanTls, config.gatewayPort ?? 0); lanTlsError = undefined }
          catch (failure) { lanTlsError = failure instanceof Error ? failure.message : '局域网证书读取失败。'; throw failure }
        }
        if (disposed || ticket !== generation) return
        const stopping = stop(); ticket = generation
        stopped = true
        await stopping; if (disposed || ticket !== generation) return
        credential = hostCookie(ready.connection, upstreamPort)
        const create = () => new Gateway({
          pairing, upstreamPort, upstreamCookie: () => credential, manage, index: renderIndex,
          boot: context => bootScript(context), discovery, lanTls: tls,
          // Both modes listen on the LAN: a public phone can fall back to the same port, and those
          // addresses are exactly what the gateway's Host validation admits.
          addresses: lanAddresses,
          public: mode === 'public' ? () => access : undefined,
          // This same computer's LAN entry, handed only to an authorized public page through the
          // injected boot context; the fallback target never comes from the phone.
          lanFallback: () => {
            if (!enabled || activeMode !== 'public' || !gateway) return undefined
            const address = lanAddresses()[0]
            return address ? `http://${address}:${gateway.port}` : undefined
          },
          websocketCompression: config.websocketCompression !== false,
          onBootReport: (report, device) => { try { appendBootReport(join(storage, 'boot-reports.jsonl'), report, device) } catch { /* diagnostics must never break the gateway */ } },
        })
        const host = '0.0.0.0'
        next = create()
        // The port of last time first: a phone's bookmark or open tab then still points at this computer.
        const wanted = mode === 'public' ? PUBLIC_PORT : config.gatewayPort || preferences.port || 0
        try { await next.listen(host, wanted) }
        catch (failure) {
          const code = (failure as NodeJS.ErrnoException).code ?? ''
          if (mode === 'public' && code === 'EADDRINUSE') throw new Error(`公网端口 ${wanted} 已被占用：可能另一个 DSH 配置正在使用公网模式，请先关闭它的远程连接。`)
          // Only a port that cannot be had is worth a second try on another one.
          if (mode === 'public' || config.gatewayPort || !wanted || !['EADDRINUSE', 'EACCES'].includes(code)) throw failure
          await next.close(); next = create(); await next.listen(host, 0)
        }
        if (mode === 'lan' && !config.gatewayPort && next.port !== preferences.port) { preferences = { ...preferences, port: next.port }; try { savePreferences() } catch { /* only a convenience */ } }
        if (disposed || ticket !== generation) { await next.close(); return }
        gateway = next
        if (tls) lanTls = tls
        enabled = true; activeMode = mode; access?.setActive(mode === 'public'); qr = pairing.issue()
        if (mode === 'public') startMonitor(); else stopMonitor()
        // The tunnel is an extra outbound connection on top of the gateway; its failure is reported in
        // status().serviceNode.lastError and retried by the instance, never as a plugin error.
        try { await reconcileServiceNode() }
        catch (failure) { logServiceNode('service-node-error', { origin: currentNode()?.url ?? '', message: failure instanceof Error ? failure.message : '自托管节点启动失败。' }) }
      } catch (failure) {
        await next?.close()
        if (ticket === generation && !disposed) { error = failure instanceof Error ? failure.message : '启动失败。'; if (stopped) await stop() }
        throw failure
      }
      finally { busy = false }
    }
    async function manage(input: Record<string, unknown>, local: boolean): Promise<unknown> {
      switch (input.action) {
        case 'status': return status(local)
        // What the always-mounted sidebar entry polls: no QR code is rendered for it.
        // The popup confirms the same identity the pairing page showed: this node's name and fingerprint.
        case 'requests': return { enabled, node: { name: discovery.name, fingerprint: discovery.fingerprint, fingerprintGroups: fingerprintGroupsOf(discovery.fingerprint) }, requests: local ? pairing.requests() : [] }
        case 'start': if (!enabled) await start(); return status(local)
        case 'reloadLanCertificate': {
          if (!local) throw new Error('局域网证书只能在本机面板重载。')
          if (busy) throw new Error('连接操作正在进行，请稍后再试。')
          if (!config.lanTls || !enabled || activeMode !== 'lan' || !gateway) throw new Error('请先开启局域网 HTTPS。')
          busy = true
          const current = gateway, ticket = generation
          try {
            const next = await readLanTls(config.lanTls, config.gatewayPort ?? 0)
            if (disposed || ticket !== generation || gateway !== current) throw new Error('连接状态已变化，请重新开启后再重载证书。')
            current.reloadLanCertificate(next)
            lanTls = next; lanTlsError = undefined
            return status(local)
          } catch (failure) { lanTlsError = failure instanceof Error ? failure.message : '证书重载失败。'; throw failure }
          finally { busy = false }
        }
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
        case 'approve': {
          if (!local) throw new Error('首次配对必须在本机确认。')
          const id = String(input.id)
          const pending = pairing.requests().find(request => request.id === id)
          if (!pending) throw new Error('配对请求已失效，请重新扫码。')
          const reject = (reason: string): never => {
            pairing.reject(id)
            pairing.reportFailure(pending.name, reason)
            throw new Error(reason)
          }
          // The computer confirms the same device name and the same fingerprint the pairing page
          // showed; a mismatch cancels the request and leaves the reason on the panel.
          if (String(input.name ?? '') !== pending.name) reject('设备名与配对页不一致，本次配对已拒绝。')
          if (String(input.fingerprint ?? '') !== discovery.fingerprint) reject('主机指纹与配对页不一致，本次配对已拒绝。')
          pairing.approve(id)
          return status(local)
        }
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
          if (busy && Object.keys(input).some(key => key !== 'action')) throw new Error('请等待当前连接操作完成。')
          const next = { ...preferences }
          if (typeof input.autoStart === 'boolean') next.autoStart = input.autoStart
          if (input.mode !== undefined) { if (input.mode !== 'public' && input.mode !== 'lan') throw new Error('连接模式不正确。'); next.mode = input.mode }
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
          if (previous.mode !== next.mode) await reconcileServiceNode()
          if (input.publicUrl !== undefined) migrateDevices()
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
          void access.certificates.ensure(true).catch(() => undefined)
          return status(local)
        }
        case 'addPublicNode': {
          const store = nodeStore()
          const url = typeof input.url === 'string' ? input.url.trim() : ''
          if (!url) throw new Error('请填写公网节点地址。')
          const detected = await detectPublicNode(url)
          if (!detected.ok) return { ok: false, message: detected.message }
          // A service node may advertise a placeholder identity until this Host registers there, so only
          // its structure is judged here; ServiceNode asserts the real hostId during registration.
          if (store.list().some(record => record.url === detected.node.url)) return { ok: false, message: '该公网节点已存在。' }
          const record = store.add({
            url: detected.node.url, kind: detected.node.kind, name: detected.node.name, version: detected.node.version,
            protocol: detected.node.protocol, capabilities: detected.node.capabilities, hostId: detected.node.hostId,
            fingerprint: detected.node.fingerprint, pending: false,
          })
          return { ok: true, node: record }
        }
        case 'checkPublicNode': {
          const store = nodeStore()
          const id = String(input.id ?? '')
          const record = store.list().find(item => item.id === id)
          if (!record) throw new Error('公网节点不存在。')
          const detected = await detectPublicNode(record.url)
          if (!detected.ok) {
            store.update(id, { lastCheckAt: Date.now(), lastCheckOk: false, lastCheckError: detected.message })
            return { ok: false, message: detected.message }
          }
          return {
            ok: true,
            node: store.update(id, {
              url: detected.node.url, kind: detected.node.kind, name: detected.node.name, version: detected.node.version,
              protocol: detected.node.protocol, capabilities: detected.node.capabilities, hostId: detected.node.hostId,
              fingerprint: detected.node.fingerprint, lastCheckAt: Date.now(), lastCheckOk: true, lastCheckError: null, pending: false,
            }),
          }
        }
        case 'setCurrentPublicNode': {
          const store = nodeStore()
          const id = String(input.id ?? '')
          const record = store.list().find(item => item.id === id)
          if (!record) throw new Error('公网节点不存在。')
          if (enabled && preferences.mode === 'public' && busy) throw new Error('请等待当前连接操作完成。')
          // A gateway node's public entry still rides on the saved domain; a service node's entry is the
          // tunnel itself and leaves PublicAccess alone.
          if (record.kind === 'gateway') await access?.saveDomain(record.url)
          store.setCurrent(id)
          if (enabled && preferences.mode === 'public') {
            if (record.kind === 'service') await reconcileServiceNode()
            else { await stop(); await start() }
          } else await reconcileServiceNode()
          return status(local)
        }
        case 'removePublicNode': {
          const store = nodeStore()
          const id = String(input.id ?? '')
          const removed = store.remove(id)
          if (!removed) throw new Error('公网节点不存在。')
          if (serviceNode?.status().origin === removed.origin) {
            const current = serviceNode
            serviceNode = undefined
            await current.stop()
          }
          // The live tunnel instance also holds the credentials in memory; purge it there so a later
          // lastConnectedAt save cannot write the removed node back to disk.
          if (serviceNode) await serviceNode.forget(removed.origin)
          else await forgetServiceNode(storage, removed.origin)
          // Authorizations issued through this node are scoped to its host; every other entry stays.
          let hosts: string[] = []
          try { const origin = new URL(removed.origin); hosts = [origin.host.toLowerCase(), origin.hostname.toLowerCase()] } catch { hosts = [] }
          if (hosts.length) pairing.prune(device => !!device.host && hosts.includes(device.host.toLowerCase()))
          await reconcileServiceNode()
          return status(local)
        }
        case 'approveServicePairing': {
          if (!local) throw new Error('首次配对必须在本机确认。')
          if (!serviceNode) throw new Error('当前没有连接自托管公网节点。')
          const id = String(input.id ?? '')
          if (!id) throw new Error('缺少要处理的配对请求。')
          serviceNode.approvePairing(id)
          return status(local)
        }
        case 'rejectServicePairing': {
          if (!local) throw new Error('配对请求由本机处理。')
          if (!serviceNode) throw new Error('当前没有连接自托管公网节点。')
          const id = String(input.id ?? '')
          if (!id) throw new Error('缺少要处理的配对请求。')
          serviceNode.rejectPairing(id)
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
