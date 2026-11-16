/**
 * The Host side of a self-hosted public node's reverse tunnel.
 *
 * The Host never listens on the public internet: it registers its host identity with the node,
 * keeps an outbound WebSocket open to `<node>/v1/tunnel`, and forwards every frame the node asks
 * for to its own loopback WebServer. The node therefore reaches this DSH exactly as a LAN phone
 * would, while the Host's firewall stays closed.
 *
 * Everything in this file is driven by the shared frame protocol in `remote/tunnel-protocol.ts`;
 * the node's implementation of the other end is documented by that same file.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import type { RawData, WebSocket as TunnelSocket } from 'ws'
import {
  TUNNEL_BACKPRESSURE_HIGH_WATER, TUNNEL_BACKPRESSURE_LOW_WATER, TUNNEL_HEARTBEAT_INTERVAL_MS, TUNNEL_HEARTBEAT_TIMEOUT_MS,
  TUNNEL_IDLE_TIMEOUT_MS, TUNNEL_MAX_REQUESTS_PER_HOST, TUNNEL_PATH, TUNNEL_REQUEST_TIMEOUT_MS, TunnelFrameError,
  decodeTunnelFrame, encodeTunnelFrame, splitTunnelPayload,
  type TunnelFrame, type TunnelHeaders,
} from './remote/tunnel-protocol.js'
import { upstreamRequestHeaders } from './upstream-http.js'

/** The durable per-node credential file inside the plugin storage directory. */
export const SERVICE_NODES_FILE = 'service-nodes.json'
const SERVICE_NODES_VERSION = 1
/** Name the Host registers with, so the node's panel can tell what kind of client it is. */
const REGISTER_NAME = 'DeepSeek Harness'
const REGISTER_TIMEOUT_MS = 20_000
const HANDSHAKE_TIMEOUT_MS = 15_000
const DEFAULT_RECONNECT_BASE_MS = 1_000
const DEFAULT_RECONNECT_MAX_MS = 60_000
/** The node may drop a caller's response once this much data waits for the tunnel socket. */
const OUTBOUND_HIGH_WATER = TUNNEL_BACKPRESSURE_HIGH_WATER
const OUTBOUND_LOW_WATER = TUNNEL_BACKPRESSURE_LOW_WATER
/** Connection response headers that describe the Host<->node hop, never the response itself. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection'])
/** WebSocket close reasons are capped at 123 bytes of UTF-8. */
const CLOSE_REASON_MAX = 123

export interface ServiceNodeLogger {
  (event: string, fields: Record<string, unknown>): void
}

export interface ServiceNodeReconnect {
  /** First retry delay; every failed attempt doubles it. */
  baseDelayMs?: number
  /** Retry ceiling. */
  maxDelayMs?: number
  /** A value in [0, 1] choosing where in the 0–20% jitter band this delay lands. */
  jitter?: () => number
}

export interface ServiceNodeOptions {
  /** Normalized node origin, e.g. `https://node.example.com`. */
  origin: string
  /** This Host's identity (43-character base64url) as advertised by discovery. */
  hostId: string
  /** SPKI DER public key, base64url, as handed to the node at registration. */
  identityKey: string
  /** Version shown to the node, from package.json. */
  clientVersion: string
  /** The Host WebServer's loopback port. */
  upstreamPort: number
  /** The Host session cookie used to speak to its own loopback WebServer. */
  upstreamCookie: () => string
  /** Plugin storage directory; the credential file lives directly inside it. */
  storage: string
  /** Structured diagnostics; never receives credentials, cookies, paths or bodies. */
  log?: ServiceNodeLogger
  now?: () => number
  reconnect?: ServiceNodeReconnect
}

/** One device waiting for this computer's answer in the panel. */
export interface ServicePairing {
  requestId: string
  deviceName: string
  expiresAt: number
}

export interface ServiceNodeStatus {
  origin: string
  connected: boolean
  lastError?: string
  pendingPairings: ServicePairing[]
}

interface StoredNode {
  credential: string
  hostId: string
  registeredAt: number
  lastConnectedAt: number | null
}

interface NodesFile { version: 1; nodes: Record<string, StoredNode> }

interface HttpCall {
  request: ClientRequest
  response?: IncomingMessage
  paused: boolean
  finished: boolean
}

interface WsCall {
  socket: TunnelSocket
  timer?: ReturnType<typeof setTimeout>
  /** Suppresses the close notification when the node itself asked for the close. */
  remoteClosed: boolean
}

/** A failure whose message is already the Chinese text shown by the panel. */
class ServiceNodeError extends Error {}

function tunnelEndpoint(origin: string): string {
  const url = new URL(origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = TUNNEL_PATH
  url.search = ''
  url.hash = ''
  return url.toString()
}

function bytesOf(data: RawData): Uint8Array {
  if (typeof data === 'string') return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data
}

function closeReason(reason: unknown): string | undefined {
  const text = typeof reason === 'string' ? reason.trim() : reason instanceof Uint8Array ? Buffer.from(reason).toString('utf8').trim() : ''
  if (!text) return undefined
  const encoded = Buffer.from(text)
  return encoded.length <= CLOSE_REASON_MAX ? text : encoded.subarray(0, CLOSE_REASON_MAX).toString('utf8')
}

function storedNodeOf(value: unknown): StoredNode | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  // An entry that cannot be used is ignored, never allowed to abort the whole credentials file.
  if (typeof row.credential !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(row.credential)) return null
  if (typeof row.hostId !== 'string' || !row.hostId) return null
  if (typeof row.registeredAt !== 'number' || !Number.isFinite(row.registeredAt)) return null
  const lastConnectedAt = row.lastConnectedAt === null || row.lastConnectedAt === undefined
    ? null
    : typeof row.lastConnectedAt === 'number' && Number.isFinite(row.lastConnectedAt) ? row.lastConnectedAt : undefined
  if (lastConnectedAt === undefined) return null
  return { credential: row.credential, hostId: row.hostId, registeredAt: row.registeredAt, lastConnectedAt }
}

/** Credentials are opaque tokens: printable, unbroken, and short enough for an HTTP header. */
function validCredential(value: string): string {
  if (!/^[\x21-\x7e]{1,512}$/.test(value)) throw new ServiceNodeError('节点返回的凭据格式不正确。')
  return value
}

async function readNodes(file: string): Promise<Record<string, StoredNode>> {
  let text: string
  try { text = await readFile(file, 'utf8') } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new ServiceNodeError(`服务节点凭据文件无法读取：${file}。`)
  }
  let value: unknown
  try { value = JSON.parse(text) } catch { return {} }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const row = value as Record<string, unknown>
  if (row.version !== SERVICE_NODES_VERSION || !row.nodes || typeof row.nodes !== 'object' || Array.isArray(row.nodes)) return {}
  const nodes: Record<string, StoredNode> = {}
  for (const [origin, record] of Object.entries(row.nodes as Record<string, unknown>)) {
    const node = storedNodeOf(record)
    if (node) nodes[origin] = node
  }
  return nodes
}

/** Windows can briefly refuse a rename while another process holds the destination open. */
const TRANSIENT_WRITE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

async function writeNodes(file: string, nodes: Record<string, StoredNode>): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ version: SERVICE_NODES_VERSION, nodes }), { mode: 0o600 })
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temporary, file); return } catch (failure) {
        const code = (failure as NodeJS.ErrnoException).code ?? ''
        if (attempt >= 4 || !TRANSIENT_WRITE_CODES.has(code)) throw failure
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
      }
    }
  } catch (failure) {
    await rmQuietly(temporary)
    throw failure
  }
}

async function rmQuietly(file: string): Promise<void> {
  try { const { unlink } = await import('node:fs/promises'); await unlink(file) } catch { /* already gone */ }
}

/**
 * Delete one node's saved credential without a running tunnel, e.g. after the user removes that
 * node from the list. A missing file or entry is a no-op.
 */
export async function forgetServiceNode(storage: string, origin: string): Promise<void> {
  const file = join(storage, SERVICE_NODES_FILE)
  const nodes = await readNodes(file)
  if (!(origin in nodes)) return
  delete nodes[origin]
  await writeNodes(file, nodes)
}

export class ServiceNode {
  private readonly origin: string
  private readonly hostId: string
  private readonly identityKey: string
  private readonly clientVersion: string
  private readonly upstreamPort: number
  private readonly upstreamCookie: () => string
  private readonly storage: string
  private readonly file: string
  private readonly log: ServiceNodeLogger
  private readonly now: () => number
  private readonly reconnectBase: number
  private readonly reconnectMax: number
  private readonly jitter: () => number

  /** Saved per-origin credentials; loaded before the first attempt. */
  private nodes: Record<string, StoredNode> = {}
  /** A serialized writer so two saves can never race on the credential file. */
  private writing: Promise<void> = Promise.resolve()
  private active = false
  private connected = false
  private lastError: string | undefined
  private ws?: typeof import('ws')
  private socket?: TunnelSocket
  private attempts = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private heartbeatWatchdog?: ReturnType<typeof setInterval>
  private lastFrameAt = 0
  private drainTimer?: ReturnType<typeof setTimeout>
  private readonly httpCalls = new Map<string, HttpCall>()
  private readonly wsCalls = new Map<string, WsCall>()
  private readonly pairings = new Map<string, { deviceName: string; expiresAt: number }>()

  constructor(options: ServiceNodeOptions) {
    this.origin = options.origin
    this.hostId = options.hostId
    this.identityKey = options.identityKey
    this.clientVersion = options.clientVersion
    this.upstreamPort = options.upstreamPort
    this.upstreamCookie = options.upstreamCookie
    this.storage = options.storage
    this.file = join(options.storage, SERVICE_NODES_FILE)
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
    this.reconnectBase = options.reconnect?.baseDelayMs ?? DEFAULT_RECONNECT_BASE_MS
    this.reconnectMax = options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_MS
    this.jitter = options.reconnect?.jitter ?? Math.random
  }

  /** Load saved credentials, then open the tunnel; a first failure only schedules a retry. */
  async start(): Promise<void> {
    if (this.active) return
    this.active = true
    this.lastError = undefined
    try { this.nodes = await readNodes(this.file) }
    catch (failure) { this.lastError = failure instanceof Error ? failure.message : '服务节点凭据读取失败。'; this.nodes = {} }
    try { await this.connect() }
    catch (failure) {
      if (!this.active) return
      this.lastError = this.describe(failure)
      this.log('service-node-error', { origin: this.origin, hostId: this.hostId, message: this.lastError })
      this.scheduleReconnect()
    }
  }

  /** Close the tunnel and every timer; no automatic reconnect happens afterwards. */
  async stop(): Promise<void> {
    this.active = false
    this.connected = false
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = undefined }
    this.stopHeartbeat()
    const socket = this.socket
    this.socket = undefined
    if (socket) { try { socket.terminate() } catch { /* already gone */ } }
    this.failAll()
    this.pairings.clear()
  }

  status(): ServiceNodeStatus {
    this.prunePairings()
    return {
      origin: this.origin,
      connected: this.connected,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      pendingPairings: [...this.pairings].map(([requestId, pairing]) => ({ requestId, deviceName: pairing.deviceName, expiresAt: pairing.expiresAt })),
    }
  }

  /** Answer the node's pairing request; a request that already expired is silently ignored. */
  approvePairing(requestId: string): void {
    if (!this.takePairing(requestId)) return
    this.send({ t: 'pair.approve', requestId })
  }

  rejectPairing(requestId: string): void {
    if (!this.takePairing(requestId)) return
    this.send({ t: 'pair.reject', requestId })
  }

  /** Forget one origin's credential (atomic rewrite); a missing entry is a no-op. */
  async forget(origin: string): Promise<void> {
    if (origin in this.nodes) {
      delete this.nodes[origin]
      await this.persist()
      return
    }
    await forgetServiceNode(this.storage, origin)
  }

  private takePairing(requestId: string): boolean {
    this.prunePairings()
    if (!this.pairings.delete(requestId)) return false
    return true
  }

  private prunePairings(): void {
    const now = this.now()
    for (const [id, pairing] of this.pairings) if (now >= pairing.expiresAt) this.pairings.delete(id)
  }

  private describe(failure: unknown): string {
    if (failure instanceof ServiceNodeError) return failure.message
    const code = (failure as NodeJS.ErrnoException).code
    if (code) return `无法连接服务节点（${code}）。`
    if (failure instanceof Error && failure.message) return failure.message
    return '无法连接服务节点。'
  }

  // ── connection lifecycle ──────────────────────────────────────────────────────────────────────

  private async loadWs(): Promise<typeof import('ws')> {
    this.ws ??= await import('ws')
    return this.ws
  }

  private async connect(): Promise<void> {
    const credential = await this.ensureCredential()
    if (!this.active) throw new ServiceNodeError('隧道已停止。')
    const ws = await this.loadWs()
    const socket = new ws.WebSocket(tunnelEndpoint(this.origin), {
      headers: { authorization: `Bearer ${credential}` },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: 32 * 1024 * 1024,
    })
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let handshake: Error | undefined
      const settle = (failure?: Error): void => {
        if (settled) return
        settled = true
        if (failure) reject(failure)
        else resolve()
      }
      socket.on('open', () => {
        this.connected = true
        this.attempts = 0
        this.lastError = undefined
        this.lastFrameAt = this.now()
        this.startHeartbeat()
        this.send({ t: 'hello', hostId: this.hostId, version: this.clientVersion, capabilities: ['http', 'ws', 'assets'] })
        this.log('service-node-connect', { origin: this.origin, hostId: this.hostId })
        void this.touchConnectedAt()
        settle()
      })
      socket.on('message', (data: RawData, isBinary: boolean) => this.receive(socket, data, isBinary))
      socket.on('error', (failure: Error) => {
        // Errors before the handshake decide why the attempt failed; later ones are reported by close.
        if (!settled) handshake ??= failure
      })
      socket.on('unexpected-response', (request, response) => {
        const status = response.statusCode ?? 0
        response.resume()
        request.destroy()
        const authFailure = status === 401 || status === 403 || status === 404
        if (authFailure) void this.forgetCredential(credential)
        const message = authFailure
          ? `节点拒绝了本机凭据（HTTP ${status}），将重新注册。`
          : `节点拒绝了隧道连接（HTTP ${status}）。`
        handshake = new ServiceNodeError(message)
        socket.terminate()
      })
      socket.on('close', (code: number, reason: Buffer) => {
        const wasConnected = this.connected
        this.connected = false
        this.stopHeartbeat()
        if (this.socket === socket) this.socket = undefined
        this.failAll()
        const text = closeReason(reason)
        const message = handshake?.message ?? (text ? `与节点的连接已断开：${text}` : `与节点的连接已断开（${code}）。`)
        if (wasConnected) this.log('service-node-disconnect', { origin: this.origin, hostId: this.hostId, code, message })
        if (!settled) { settled = true; reject(handshake ?? new ServiceNodeError(message)); return }
        if (this.active) this.scheduleReconnect()
      })
    })
  }

  private scheduleReconnect(): void {
    if (!this.active || this.reconnectTimer) return
    const raw = Math.min(this.reconnectMax, this.reconnectBase * 2 ** Math.min(this.attempts, 30))
    const factor = 1 + Math.min(0.2, Math.max(0, this.jitter()))
    this.attempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.active) return
      void this.connect().catch(failure => {
        if (!this.active) return
        this.lastError = this.describe(failure)
        this.log('service-node-error', { origin: this.origin, hostId: this.hostId, message: this.lastError })
        this.scheduleReconnect()
      })
    }, Math.max(0, Math.round(raw * factor)))
    this.reconnectTimer.unref?.()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => { this.send({ t: 'ping', at: this.now() }) }, TUNNEL_HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref?.()
    this.heartbeatWatchdog = setInterval(() => {
      if (!this.socket) return
      if (this.now() - this.lastFrameAt < TUNNEL_HEARTBEAT_TIMEOUT_MS) return
      this.lastError = '长时间没有收到节点的数据，正在重新连接。'
      this.log('service-node-error', { origin: this.origin, hostId: this.hostId, message: this.lastError })
      try { this.socket?.terminate() } catch { /* close handler reconnects */ }
    }, TUNNEL_HEARTBEAT_INTERVAL_MS)
    this.heartbeatWatchdog.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined }
    if (this.heartbeatWatchdog) { clearInterval(this.heartbeatWatchdog); this.heartbeatWatchdog = undefined }
  }

  // ── registration and persistence ─────────────────────────────────────────────────────────────

  private async ensureCredential(): Promise<string> {
    const stored = this.nodes[this.origin]
    // A credential belongs to the identity that registered it; a changed host identity must register again.
    if (stored && stored.hostId === this.hostId) return stored.credential
    return this.register()
  }

  private async register(): Promise<string> {
    let response: Response
    try {
      response = await fetch(`${this.origin}/v1/hosts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: this.hostId, name: REGISTER_NAME, identityKey: this.identityKey, clientVersion: this.clientVersion }),
        signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      })
    } catch (failure) {
      const code = (failure as NodeJS.ErrnoException).code
      throw new ServiceNodeError(code ? `无法连接服务节点注册接口（${code}）。` : '无法连接服务节点注册接口。')
    }
    if (response.status === 409) {
      const body = await response.text().catch(() => '')
      let code = ''
      try { const parsed: unknown = JSON.parse(body); if (parsed && typeof parsed === 'object') { const value = (parsed as Record<string, unknown>).code; if (typeof value === 'string') code = value } } catch { /* the message below covers an opaque 409 */ }
      if (code === 'IDENTITY_IN_USE') throw new ServiceNodeError('该主机身份已被其他注册占用，请检查节点配置。')
      if (code === 'HOST_ALREADY_REGISTERED') throw new ServiceNodeError('节点上已存在该主机的注册记录，但本机没有保存凭据。请在节点上重置该主机，或恢复本机的服务节点凭据文件。')
      throw new ServiceNodeError('节点拒绝了本机注册（HTTP 409）。')
    }
    if (response.status !== 201) {
      response.body?.cancel().catch(() => undefined)
      throw new ServiceNodeError(`节点注册失败（HTTP ${response.status}）。`)
    }
    let body: unknown
    try { body = await response.json() } catch { throw new ServiceNodeError('节点返回的注册结果不是有效的 JSON。') }
    if (!body || typeof body !== 'object') throw new ServiceNodeError('节点返回的注册结果格式不正确。')
    const row = body as Record<string, unknown>
    // The node's answer must name this Host: a credential for somebody else's fingerprint is never used.
    const host = row.host && typeof row.host === 'object' ? row.host as Record<string, unknown> : undefined
    const returnedHostId = host && typeof host.hostId === 'string' ? host.hostId : undefined
    if (returnedHostId !== this.hostId) throw new ServiceNodeError('节点返回的主机指纹与本机不一致，已拒绝使用该节点。')
    if (typeof row.credential !== 'string') throw new ServiceNodeError('节点没有返回可用的凭据。')
    const credential = validCredential(row.credential)
    this.nodes[this.origin] = { credential, hostId: this.hostId, registeredAt: this.now(), lastConnectedAt: null }
    await this.persist()
    this.log('service-node-register', { origin: this.origin, hostId: this.hostId })
    return credential
  }

  private async forgetCredential(credential: string): Promise<void> {
    const stored = this.nodes[this.origin]
    if (!stored || stored.credential !== credential) return
    delete this.nodes[this.origin]
    try { await this.persist() } catch { /* the next registration overwrites the file anyway */ }
  }

  private async touchConnectedAt(): Promise<void> {
    const stored = this.nodes[this.origin]
    if (!stored) return
    this.nodes[this.origin] = { ...stored, lastConnectedAt: this.now() }
    try { await this.persist() } catch { /* bookkeeping only */ }
  }

  private persist(): Promise<void> {
    const snapshot: Record<string, StoredNode> = JSON.parse(JSON.stringify(this.nodes)) as Record<string, StoredNode>
    // A failed attempt must not poison the queue: the next save still runs (and reports its own failure).
    this.writing = this.writing.then(() => writeNodes(this.file, snapshot), () => writeNodes(this.file, snapshot))
    return this.writing
  }

  // ── frames ───────────────────────────────────────────────────────────────────────────────────

  private send(frame: TunnelFrame, payload?: Uint8Array): void {
    const socket = this.socket
    if (!socket || socket.readyState !== socket.OPEN) return
    let data: Buffer
    try { data = encodeTunnelFrame(frame, payload) } catch (failure) {
      // An oversized frame is a programming error: log the reason, never the payload.
      this.log('service-node-error', { origin: this.origin, hostId: this.hostId, message: failure instanceof Error ? failure.message : '发送隧道帧失败。' })
      return
    }
    socket.send(data, { binary: true }, failure => {
      if (!failure) return
      this.log('service-node-error', { origin: this.origin, hostId: this.hostId, message: '向节点发送数据失败。' })
    })
  }

  private receive(socket: TunnelSocket, data: RawData, isBinary: boolean): void {
    if (socket !== this.socket) return
    this.lastFrameAt = this.now()
    try {
      if (!isBinary) throw new TunnelFrameError('FRAME_INVALID', '节点发送了非二进制帧。')
      const { frame, payload } = decodeTunnelFrame(bytesOf(data))
      this.handle(frame, payload)
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '无法解析节点的数据。'
      this.lastError = '与节点的通信格式不正确，正在重新连接。'
      this.log('service-node-error', { origin: this.origin, hostId: this.hostId, message })
      try { socket.terminate() } catch { /* the close handler reconnects */ }
    }
  }

  private handle(frame: TunnelFrame, payload: Uint8Array): void {
    switch (frame.t) {
      case 'ping': this.send({ t: 'pong', at: frame.at }); break
      case 'pong': break
      case 'http.request': this.openHttp(frame.id, frame.method, frame.path, frame.headers); break
      case 'http.body': this.writeHttp(frame.id, payload); break
      case 'http.body.end': this.endHttp(frame.id); break
      case 'http.cancel': this.cancelHttp(frame.id); break
      case 'ws.open': this.openWs(frame.id, frame.path, frame.headers, frame.protocol); break
      case 'ws.frame': this.deliverWs(frame.id, frame.binary, payload); break
      case 'ws.close': this.closeWs(frame.id, frame.code, frame.reason); break
      case 'pair.request': this.addPairing(frame.requestId, frame.clientName, frame.expiresAt); break
      case 'pair.complete':
      case 'pair.reject': this.pairings.delete(frame.requestId); break
      // Node-bound frame types never travel to the Host; a peer sending one is simply ignored.
      default: break
    }
  }

  // ── HTTP forwarding ─────────────────────────────────────────────────────────────────────────

  private openHttp(id: string, method: string, path: string, headers: TunnelHeaders): void {
    if (this.httpCalls.size >= TUNNEL_MAX_REQUESTS_PER_HOST) {
      this.send({ t: 'http.error', id, code: 'TOO_MANY_REQUESTS', message: '同时进行的远程请求过多，请稍后再试。' })
      return
    }
    let request: ClientRequest
    try {
      request = httpRequest({
        hostname: '127.0.0.1', port: this.upstreamPort, path, method,
        headers: upstreamRequestHeaders({ headers }, { upstreamPort: this.upstreamPort, cookie: this.upstreamCookie() }),
      })
    } catch {
      this.send({ t: 'http.error', id, code: 'UPSTREAM_FAILED', message: '本机 DSH 没有接受这个请求。' })
      return
    }
    const call: HttpCall = { request, paused: false, finished: false }
    this.httpCalls.set(id, call)
    const fail = (): void => {
      if (call.finished) return
      call.finished = true
      this.httpCalls.delete(id)
      this.send({ t: 'http.error', id, code: 'UPSTREAM_FAILED', message: '本机 DSH 没有完成这个请求。' })
    }
    request.setTimeout(TUNNEL_REQUEST_TIMEOUT_MS, () => request.destroy(new Error('上游请求超时。')))
    request.on('error', fail)
    request.on('response', response => {
      if (call.finished) { response.destroy(); return }
      call.response = response
      const outgoing: TunnelHeaders = {}
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue
        outgoing[name] = value
      }
      this.send({ t: 'http.response', id, status: response.statusCode ?? 502, headers: outgoing })
      response.on('data', (chunk: Buffer) => {
        if (call.finished) return
        // Streamed, never buffered: an SSE response must reach the phone chunk by chunk.
        for (const part of splitTunnelPayload(chunk)) this.send({ t: 'http.chunk', id }, part)
        if (call.paused) return
        if ((this.socket?.bufferedAmount ?? 0) > OUTBOUND_HIGH_WATER) { call.paused = true; response.pause(); this.armDrain() }
      })
      response.on('end', () => {
        if (call.finished) return
        call.finished = true
        this.httpCalls.delete(id)
        this.send({ t: 'http.end', id })
      })
      response.on('error', () => { response.destroy(); fail() })
    })
    request.on('close', () => {
      // The upstream connection can close before the response stream ends; the error path reports it.
      if (call.finished) return
      if (!call.response) { fail(); return }
    })
  }

  private writeHttp(id: string, payload: Uint8Array): void {
    const call = this.httpCalls.get(id)
    if (!call || call.finished || payload.length === 0) return
    call.request.write(payload)
  }

  private endHttp(id: string): void {
    const call = this.httpCalls.get(id)
    if (!call || call.finished) return
    call.request.end()
  }

  private cancelHttp(id: string): void {
    const call = this.httpCalls.get(id)
    if (!call) return
    call.finished = true
    this.httpCalls.delete(id)
    call.response?.destroy()
    call.request.destroy()
  }

  // ── WebSocket forwarding ────────────────────────────────────────────────────────────────────

  private async openWs(id: string, path: string, headers: TunnelHeaders, protocol?: string): Promise<void> {
    const ws = await this.loadWs().catch(() => undefined)
    if (!ws) { this.send({ t: 'ws.ack', id, ok: false, status: 502, message: '本机 WebSocket 客户端不可用。' }); return }
    const outgoing = upstreamRequestHeaders({ headers }, { upstreamPort: this.upstreamPort, cookie: this.upstreamCookie() })
    delete outgoing['sec-websocket-protocol']
    let socket: TunnelSocket
    try {
      socket = new ws.WebSocket(`ws://127.0.0.1:${this.upstreamPort}${path}`, protocol ? [protocol] : [], { headers: outgoing, handshakeTimeout: HANDSHAKE_TIMEOUT_MS, maxPayload: 32 * 1024 * 1024 })
    } catch {
      this.send({ t: 'ws.ack', id, ok: false, status: 502, message: '本机 WebSocket 服务没有接受连接。' })
      return
    }
    const call: WsCall = { socket, remoteClosed: false }
    this.wsCalls.set(id, call)
    this.touchWs(id, call)
    socket.on('open', () => {
      const negotiated = socket.protocol || protocol
      this.send({ t: 'ws.ack', id, ok: true, ...(negotiated ? { protocol: negotiated } : {}) })
    })
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (this.wsCalls.get(id) !== call) return
      this.touchWs(id, call)
      this.send({ t: 'ws.frame', id, binary: isBinary }, bytesOf(data))
      if ((this.socket?.bufferedAmount ?? 0) > OUTBOUND_HIGH_WATER) { socket.pause(); this.armDrain() }
    })
    socket.on('close', (code: number, reason: Buffer) => {
      if (this.wsCalls.get(id) !== call) return
      this.wsCalls.delete(id)
      clearTimeout(call.timer)
      if (call.remoteClosed) return
      const text = closeReason(reason)
      this.send({ t: 'ws.close', id, code: code || 1005, ...(text ? { reason: text } : {}) })
    })
    socket.on('error', () => {
      if (this.wsCalls.get(id) !== call) return
      // A failed local handshake gets a refusal; an established socket's error is reported by close.
      if (socket.readyState !== socket.OPEN) {
        this.wsCalls.delete(id)
        clearTimeout(call.timer)
        this.send({ t: 'ws.ack', id, ok: false, status: 502, message: '本机 WebSocket 服务没有接受连接。' })
        try { socket.terminate() } catch { /* already gone */ }
      }
    })
  }

  /** Restart one tunneled WebSocket's idle clock; no frame in either direction for 120 s closes it. */
  private touchWs(id: string, call: WsCall): void {
    clearTimeout(call.timer)
    call.timer = setTimeout(() => {
      if (this.wsCalls.get(id) !== call) return
      this.wsCalls.delete(id)
      this.send({ t: 'ws.close', id, code: 1000, reason: '空闲超时。' })
      try { call.socket.close(1000, '空闲超时。') } catch { /* already closed */ }
    }, TUNNEL_IDLE_TIMEOUT_MS)
    call.timer.unref?.()
  }

  private deliverWs(id: string, binary: boolean, payload: Uint8Array): void {
    const call = this.wsCalls.get(id)
    if (!call) return
    this.touchWs(id, call)
    if (call.socket.readyState !== call.socket.OPEN) return
    call.socket.send(payload, { binary })
  }

  private closeWs(id: string, code?: number, reason?: string): void {
    const call = this.wsCalls.get(id)
    if (!call) return
    call.remoteClosed = true
    this.wsCalls.delete(id)
    clearTimeout(call.timer)
    try { call.socket.close(code ?? 1000, reason) } catch { /* already closed */ }
  }

  // ── outbound backpressure ────────────────────────────────────────────────────────────────────

  private armDrain(): void {
    if (this.drainTimer) return
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined
      const socket = this.socket
      if (!socket) return
      if (socket.bufferedAmount >= OUTBOUND_LOW_WATER) { this.armDrain(); return }
      for (const call of this.httpCalls.values()) {
        if (!call.paused) continue
        call.paused = false
        call.response?.resume()
      }
      for (const call of this.wsCalls.values()) if (call.socket.isPaused) call.socket.resume()
    }, 25)
    this.drainTimer.unref?.()
  }

  // ── pairing ──────────────────────────────────────────────────────────────────────────────────

  private addPairing(requestId: string, clientName: string, expiresAt: number): void {
    this.prunePairings()
    const expires = Number.isFinite(expiresAt) && expiresAt > this.now() ? expiresAt : this.now() + 5 * 60_000
    this.pairings.set(requestId, { deviceName: clientName.slice(0, 80), expiresAt: expires })
  }

  // ── teardown ─────────────────────────────────────────────────────────────────────────────────

  private failAll(): void {
    for (const [id, call] of this.httpCalls) {
      call.finished = true
      this.httpCalls.delete(id)
      call.response?.destroy()
      call.request.destroy()
    }
    for (const [id, call] of this.wsCalls) {
      this.wsCalls.delete(id)
      clearTimeout(call.timer)
      try { call.socket.terminate() } catch { /* already gone */ }
    }
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = undefined }
  }
}
