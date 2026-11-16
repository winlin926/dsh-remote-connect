import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import type { AuthService } from '../auth.js'
import type { Config } from '../config.js'
import { ApiError, errorBody } from '../errors.js'
import { sendJson } from '../http/util.js'
import type { Logger } from '../logger.js'
import type { RateLimiter } from '../rate-limit.js'
import type { Repositories } from '../repositories.js'
import { clientIp, originAllowed } from '../security.js'
import type { SessionContext } from '../sessions.js'
import {
  TUNNEL_IDLE_TIMEOUT_MS,
  TUNNEL_MAX_REQUESTS_PER_DEVICE,
  TUNNEL_MAX_REQUESTS_PER_HOST,
  TUNNEL_MESSAGE_MAX,
  TUNNEL_REQUEST_TIMEOUT_MS,
  asTunnelHeaders,
  splitTunnelPayload,
  toTunnelHeaders,
  type TunnelFrame,
  type TunnelHeaders,
  type TunnelHttpCancelFrame,
  type TunnelHttpErrorFrame,
  type TunnelHttpResponseFrame,
  type TunnelWsAckFrame,
  type TunnelWsCloseFrame,
  type TunnelWsFrameFrame,
  type TunnelWsOpenFrame,
} from '../../../src/remote/tunnel-protocol.js'
import type { TunnelFrameHandler, TunnelHub } from './hub.js'
import { isNodeOwnedPath } from './paths.js'

const HOST_OFFLINE_MESSAGE = '公网节点已连接，但本机没有响应。请确认 DSH 正在运行。'
const TUNNEL_CLOSED_MESSAGE = '隧道已断开，请重试。'
const TUNNEL_TIMEOUT_MESSAGE = '隧道请求超时，请稍后再试。'
const TUNNEL_CANCELLED_MESSAGE = '隧道请求已取消。'
const TUNNEL_ERROR_MESSAGE = '隧道返回错误，请稍后再试。'
const TOO_MANY_TUNNEL_REQUESTS_MESSAGE = '隧道请求过多，请稍后再试。'
const SESSION_REQUIRED_MESSAGE = '请先完成设备配对后再访问此节点。'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

export interface TunnelProxyDeps {
  config: Config
  logger: Logger
  auth: AuthService
  repos: Repositories
  limiter: RateLimiter
  hub: TunnelHub
}

interface HttpExchange {
  id: string
  hostId: string
  deviceId: string
  req: IncomingMessage
  res: ServerResponse
  done: boolean
  headersSent: boolean
  streaming: boolean
  timer: NodeJS.Timeout | null
  /** Serializes response-header/chunk/end writes in wire order. */
  chain: Promise<void>
}

interface WsExchange {
  id: string
  hostId: string
  deviceId: string
  req: IncomingMessage
  socket: Duplex
  head: Buffer
  client: WebSocket | null
  done: boolean
  timer: NodeJS.Timeout | null
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

/** A close code we are allowed to put on the wire. */
function sendableCloseCode(code: number | undefined, fallback: number): number {
  if (code === undefined) return fallback
  if (code >= 3000 && code <= 4999) return code
  if (code >= 1000 && code <= 1014 && code !== 1005 && code !== 1006) return code
  return fallback
}

function sanitizeResponseHeaders(headers: TunnelHeaders): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    result[lower] = value
  }
  return result
}

function hostOfflineError(): ApiError {
  return new ApiError(503, 'HOST_OFFLINE', HOST_OFFLINE_MESSAGE)
}

function tooManyTunnelRequestsError(): ApiError {
  return new ApiError(429, 'TOO_MANY_REQUESTS', TOO_MANY_TUNNEL_REQUESTS_MESSAGE, 1_000)
}

/**
 * Reverse proxy for paired devices: HTTP requests and WebSocket upgrades are
 * forwarded over the Host tunnel instead of being served by this node.
 *
 * It is a {@link TunnelFrameHandler}: every Host → node frame for a request or
 * socket this class created is consumed here.
 */
export class TunnelProxy implements TunnelFrameHandler {
  private readonly wss: WebSocketServer
  private readonly preferredProtocols = new WeakMap<IncomingMessage, string>()
  private readonly httpExchanges = new Map<string, HttpExchange>()
  private readonly wsExchanges = new Map<string, WsExchange>()
  private readonly deviceRequests = new Map<string, number>()
  private readonly hostRequests = new Map<string, number>()
  private closed = false

  constructor(private readonly deps: TunnelProxyDeps) {
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: TUNNEL_MESSAGE_MAX,
      handleProtocols: (protocols, request) => {
        const preferred = this.preferredProtocols.get(request)
        this.preferredProtocols.delete(request)
        if (preferred !== undefined && protocols.has(preferred)) return preferred
        const first = [...protocols][0]
        return first ?? false
      },
    })
  }

  /**
   * Close every live WebSocket this device holds through the tunnel. Called when
   * its relationship is revoked so the phone cannot keep streaming on a dead grant.
   */
  closeDevice(deviceId: string): void {
    for (const exchange of this.wsExchanges.values()) {
      if (exchange.deviceId !== deviceId || !exchange.client) continue
      exchange.client.close(4004, 'relationship revoked')
    }
  }

  /** Proxy one HTTP request for an already-authenticated paired device. */
  async handleRequest(req: IncomingMessage, res: ServerResponse, url: URL, session: SessionContext): Promise<void> {
    const deviceId = session.device.device_id
    const hostId = this.selectHost(deviceId)
    this.assertCapacity(deviceId, hostId)
    const id = randomUUID()
    const exchange: HttpExchange = {
      id,
      hostId,
      deviceId,
      req,
      res,
      done: false,
      headersSent: false,
      streaming: false,
      timer: null,
      chain: Promise.resolve(),
    }
    this.httpExchanges.set(id, exchange)
    this.acquire(deviceId, hostId)
    exchange.timer = setTimeout(() => this.onHttpTimeout(exchange), TUNNEL_REQUEST_TIMEOUT_MS)
    exchange.timer.unref()
    this.watchClient(exchange)

    const frame: TunnelFrame = {
      t: 'http.request',
      id,
      method: req.method ?? 'GET',
      path: req.url ?? url.pathname,
      headers: toTunnelHeaders(req.headers),
    }
    if (!this.deps.hub.sendHostFrame(hostId, frame)) {
      this.settleHttp(exchange)
      throw hostOfflineError()
    }
    void this.pipeRequestBody(exchange)
  }

  /** Proxy one WebSocket upgrade request for an already-authenticated paired device. */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (isNodeOwnedPath(url.pathname)) {
        this.rejectSocket(socket, 404, errorBody('NOT_FOUND', 'The requested resource does not exist.'))
        return
      }
      if (req.method !== 'GET') {
        this.rejectSocket(socket, 405, errorBody('METHOD_NOT_ALLOWED', 'Method not allowed.'))
        return
      }
      if (!originAllowed(req, this.deps.config)) {
        this.rejectSocket(socket, 403, errorBody('CROSS_ORIGIN_REJECTED', 'Cross-origin upgrades are not allowed.'))
        return
      }
      const session = this.deps.auth.sessionFromRequest(req)
      if (!session) {
        this.rejectSocket(socket, 401, errorBody('AUTH_REQUIRED', SESSION_REQUIRED_MESSAGE))
        return
      }
      const decision = this.deps.limiter.take('upgrade', clientIp(req, this.deps.config), this.deps.config.limits.upgrade)
      if (!decision.allowed) {
        this.rejectSocket(socket, 429, errorBody('RATE_LIMITED', 'Too many upgrade attempts; retry later.', true))
        return
      }
      const deviceId = session.device.device_id
      const hostId = this.selectHost(deviceId)
      this.assertCapacity(deviceId, hostId)

      const id = randomUUID()
      const exchange: WsExchange = {
        id,
        hostId,
        deviceId,
        req,
        socket,
        head,
        client: null,
        done: false,
        timer: null,
      }
      this.wsExchanges.set(id, exchange)
      this.acquire(deviceId, hostId)
      exchange.timer = setTimeout(() => this.onWsTimeout(exchange), TUNNEL_IDLE_TIMEOUT_MS)
      exchange.timer.unref()

      const protocols = this.readProtocols(req.headers['sec-websocket-protocol'])
      const frame: TunnelWsOpenFrame = {
        t: 'ws.open',
        id,
        path: req.url ?? url.pathname,
        headers: toTunnelHeaders(req.headers),
      }
      const protocol = protocols[0]
      if (protocol !== undefined) frame.protocol = protocol
      if (!this.deps.hub.sendHostFrame(hostId, frame)) {
        this.settleWs(exchange)
        this.rejectSocket(socket, 503, errorBody('HOST_OFFLINE', HOST_OFFLINE_MESSAGE))
      }
    } catch (error) {
      if (error instanceof ApiError) {
        this.rejectSocket(socket, error.status, errorBody(error.code, error.message, error.retryAfterMs !== undefined ? true : undefined))
      } else {
        this.deps.logger.warn({ event: 'tunnel.ws.upgrade.failed', error })
        try {
          socket.destroy()
        } catch {
          // The socket is already gone.
        }
      }
    }
  }

  onFrame(hostId: string, frame: TunnelFrame, payload: Uint8Array): boolean {
    switch (frame.t) {
      case 'http.response':
        this.enqueueHttpFrame(hostId, frame.id, exchange => this.writeResponseHead(exchange, frame))
        return true
      case 'http.chunk':
        this.enqueueHttpFrame(hostId, frame.id, exchange => this.writeChunk(exchange, payload))
        return true
      case 'http.end':
        this.enqueueHttpFrame(hostId, frame.id, exchange => this.finishHttp(exchange))
        return true
      case 'http.error':
        this.onHttpError(hostId, frame)
        return true
      case 'http.cancel':
        this.onHttpCancel(hostId, frame)
        return true
      case 'ws.ack':
        this.onWsAck(hostId, frame)
        return true
      case 'ws.frame':
        this.onHostWsFrame(hostId, frame, payload)
        return true
      case 'ws.close':
        this.onHostWsClose(hostId, frame)
        return true
      default:
        return false
    }
  }

  /** Called by the hub when the Host tunnel goes away: fail everything in flight. */
  onClose(hostId: string): void {
    for (const exchange of [...this.httpExchanges.values()]) {
      if (exchange.hostId !== hostId) continue
      this.failHttp(exchange, 502, 'TUNNEL_CLOSED', TUNNEL_CLOSED_MESSAGE)
    }
    for (const exchange of [...this.wsExchanges.values()]) {
      if (exchange.hostId !== hostId) continue
      const client = exchange.client
      this.settleWs(exchange)
      if (client) {
        try {
          client.close(1011, 'tunnel closed')
        } catch {
          client.terminate()
        }
      } else {
        try {
          exchange.socket.destroy()
        } catch {
          // The socket is already gone.
        }
      }
    }
  }

  shutdown(): void {
    if (this.closed) return
    this.closed = true
    for (const exchange of [...this.httpExchanges.values()]) {
      const res = exchange.res
      this.settleHttp(exchange)
      try {
        res.destroy()
      } catch {
        // The response is already gone.
      }
    }
    for (const exchange of [...this.wsExchanges.values()]) {
      const client = exchange.client
      this.settleWs(exchange)
      if (client) {
        try {
          client.close(1001, 'server shutting down')
        } catch {
          client.terminate()
        }
      } else {
        try {
          exchange.socket.destroy()
        } catch {
          // The socket is already gone.
        }
      }
    }
    try {
      this.wss.close()
    } catch {
      // The ws server may already be closed.
    }
  }

  // --- Host selection and limits -------------------------------------------------

  private selectHost(deviceId: string): string {
    const online = this.deps.hub.onlineHostIds()
    if (online.length === 0) throw hostOfflineError()
    if (online.length === 1) return online[0]
    const onlineSet = new Set(online)
    for (const relationship of this.deps.repos.listRelationshipsForDevice(deviceId)) {
      if (onlineSet.has(relationship.host_id)) return relationship.host_id
    }
    throw hostOfflineError()
  }

  private assertCapacity(deviceId: string, hostId: string): void {
    if ((this.deviceRequests.get(deviceId) ?? 0) >= TUNNEL_MAX_REQUESTS_PER_DEVICE) throw tooManyTunnelRequestsError()
    if ((this.hostRequests.get(hostId) ?? 0) >= TUNNEL_MAX_REQUESTS_PER_HOST) throw tooManyTunnelRequestsError()
  }

  private acquire(deviceId: string, hostId: string): void {
    this.deviceRequests.set(deviceId, (this.deviceRequests.get(deviceId) ?? 0) + 1)
    this.hostRequests.set(hostId, (this.hostRequests.get(hostId) ?? 0) + 1)
  }

  private release(deviceId: string, hostId: string): void {
    const devices = (this.deviceRequests.get(deviceId) ?? 1) - 1
    if (devices <= 0) this.deviceRequests.delete(deviceId)
    else this.deviceRequests.set(deviceId, devices)
    const hosts = (this.hostRequests.get(hostId) ?? 1) - 1
    if (hosts <= 0) this.hostRequests.delete(hostId)
    else this.hostRequests.set(hostId, hosts)
  }

  // --- HTTP proxying -------------------------------------------------------------

  private watchClient(exchange: HttpExchange): void {
    const cancel = (): void => {
      if (exchange.done) return
      this.deps.hub.sendHostFrame(exchange.hostId, { t: 'http.cancel', id: exchange.id })
      this.settleHttp(exchange)
    }
    exchange.req.on('aborted', cancel)
    exchange.res.on('close', () => {
      if (!exchange.done) cancel()
    })
  }

  private async pipeRequestBody(exchange: HttpExchange): Promise<void> {
    try {
      for await (const chunk of exchange.req) {
        if (exchange.done) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        for (const slice of splitTunnelPayload(buffer)) {
          if (exchange.done) return
          const sent = await this.deps.hub.sendHostFrameAsync(exchange.hostId, { t: 'http.body', id: exchange.id }, slice)
          if (!sent) {
            this.failHttp(exchange, 502, 'TUNNEL_CLOSED', TUNNEL_CLOSED_MESSAGE)
            return
          }
        }
      }
      if (exchange.done) return
      this.deps.hub.sendHostFrame(exchange.hostId, { t: 'http.body.end', id: exchange.id })
    } catch (error) {
      if (exchange.done) return
      this.deps.logger.warn({ event: 'tunnel.request.body.failed', id: exchange.id })
      this.failHttp(exchange, 502, 'TUNNEL_CLOSED', TUNNEL_CLOSED_MESSAGE)
    }
  }

  private enqueueHttpFrame(hostId: string, id: string, task: (exchange: HttpExchange) => void | Promise<void>): void {
    const exchange = this.httpExchanges.get(id)
    if (!exchange || exchange.hostId !== hostId) {
      this.deps.logger.debug({ event: 'tunnel.frame.unknown', hostId, type: 'http', id })
      return
    }
    this.enqueueHttp(exchange, () => task(exchange))
  }

  private enqueueHttp(exchange: HttpExchange, task: () => void | Promise<void>): void {
    exchange.chain = exchange.chain.then(task).catch(error => {
      this.deps.logger.warn({ event: 'tunnel.http.write.failed', hostId: exchange.hostId, id: exchange.id, error })
      this.failHttp(exchange, 502, 'TUNNEL_ERROR', TUNNEL_ERROR_MESSAGE)
    })
  }

  private writeResponseHead(exchange: HttpExchange, frame: TunnelHttpResponseFrame): void {
    if (exchange.done || exchange.headersSent) return
    const status =
      Number.isInteger(frame.status) && frame.status >= 200 && frame.status <= 599 ? frame.status : 502
    const headers = sanitizeResponseHeaders(asTunnelHeaders(frame.headers))
    exchange.headersSent = true
    exchange.res.writeHead(status, headers)
    const contentType = String(headers['content-type'] ?? '').toLowerCase()
    if (contentType.includes('text/event-stream')) {
      exchange.streaming = true
      this.armIdleTimer(exchange)
    }
  }

  private async writeChunk(exchange: HttpExchange, payload: Uint8Array): Promise<void> {
    if (exchange.done || !exchange.headersSent) return
    if (exchange.res.destroyed || exchange.res.writableEnded) return
    if (exchange.streaming) this.armIdleTimer(exchange)
    await new Promise<void>(resolve => {
      exchange.res.write(Buffer.from(payload), () => resolve())
    })
  }

  private finishHttp(exchange: HttpExchange): void {
    if (exchange.done) return
    const headersSent = exchange.headersSent || exchange.res.headersSent
    this.settleHttp(exchange)
    if (!headersSent) {
      this.sendHttpError(exchange, 502, 'TUNNEL_INVALID_RESPONSE', TUNNEL_ERROR_MESSAGE)
      return
    }
    try {
      exchange.res.end()
    } catch {
      exchange.res.destroy()
    }
  }

  private onHttpError(hostId: string, frame: TunnelHttpErrorFrame): void {
    const exchange = this.httpExchanges.get(frame.id)
    if (!exchange || exchange.hostId !== hostId) return
    this.enqueueHttp(exchange, () => {
      this.deps.logger.warn({
        event: 'tunnel.http.error',
        hostId,
        code: typeof frame.code === 'string' ? frame.code.slice(0, 64) : 'UNKNOWN',
      })
      this.failHttp(exchange, 502, 'TUNNEL_ERROR', TUNNEL_ERROR_MESSAGE)
    })
  }

  private onHttpCancel(hostId: string, frame: TunnelHttpCancelFrame): void {
    const exchange = this.httpExchanges.get(frame.id)
    if (!exchange || exchange.hostId !== hostId) return
    this.enqueueHttp(exchange, () => {
      this.failHttp(exchange, 502, 'TUNNEL_CANCELLED', TUNNEL_CANCELLED_MESSAGE)
    })
  }

  private armIdleTimer(exchange: HttpExchange): void {
    if (exchange.timer) clearTimeout(exchange.timer)
    exchange.timer = setTimeout(() => this.onHttpTimeout(exchange), TUNNEL_IDLE_TIMEOUT_MS)
    exchange.timer.unref()
  }

  private onHttpTimeout(exchange: HttpExchange): void {
    if (exchange.done) return
    this.deps.logger.warn({ event: 'tunnel.http.timeout', hostId: exchange.hostId, streaming: exchange.streaming })
    this.deps.hub.sendHostFrame(exchange.hostId, { t: 'http.cancel', id: exchange.id })
    const headersSent = exchange.headersSent || exchange.res.headersSent
    this.settleHttp(exchange)
    if (headersSent) {
      exchange.res.destroy()
      return
    }
    this.sendHttpError(exchange, 504, 'TUNNEL_TIMEOUT', TUNNEL_TIMEOUT_MESSAGE)
  }

  private failHttp(exchange: HttpExchange, status: number, code: string, message: string): void {
    if (exchange.done) return
    const headersSent = exchange.headersSent || exchange.res.headersSent
    this.settleHttp(exchange)
    if (headersSent) {
      exchange.res.destroy()
      return
    }
    this.sendHttpError(exchange, status, code, message)
  }

  private sendHttpError(exchange: HttpExchange, status: number, code: string, message: string): void {
    if (exchange.res.headersSent) {
      exchange.res.destroy()
      return
    }
    try {
      sendJson(exchange.res, status, errorBody(code, message), { head: exchange.req.method === 'HEAD' })
    } catch {
      exchange.res.destroy()
    }
  }

  private settleHttp(exchange: HttpExchange): void {
    if (exchange.done) return
    exchange.done = true
    if (exchange.timer) {
      clearTimeout(exchange.timer)
      exchange.timer = null
    }
    this.httpExchanges.delete(exchange.id)
    this.release(exchange.deviceId, exchange.hostId)
  }

  // --- WebSocket proxying --------------------------------------------------------

  private readProtocols(raw: string | string[] | undefined): string[] {
    const value = Array.isArray(raw) ? raw.join(',') : raw ?? ''
    return value
      .split(',')
      .map(part => part.trim())
      .filter(part => part.length > 0)
  }

  private onWsAck(hostId: string, frame: TunnelWsAckFrame): void {
    const exchange = this.wsExchanges.get(frame.id)
    if (!exchange || exchange.hostId !== hostId) {
      this.deps.logger.debug({ event: 'tunnel.frame.unknown', hostId, type: 'ws.ack', id: frame.id })
      return
    }
    if (exchange.done) return
    this.touchWs(exchange)
    if (!frame.ok) {
      const status =
        typeof frame.status === 'number' && Number.isInteger(frame.status) && frame.status >= 400 && frame.status <= 599
          ? frame.status
          : 502
      this.settleWs(exchange)
      this.rejectSocket(exchange.socket, status, errorBody('TUNNEL_UPGRADE_FAILED', '上游 WebSocket 拒绝连接。'))
      return
    }
    if (typeof frame.protocol === 'string' && frame.protocol.length > 0) {
      this.preferredProtocols.set(exchange.req, frame.protocol)
    }
    try {
      this.wss.handleUpgrade(exchange.req, exchange.socket, exchange.head, client => {
        this.onClientOpen(exchange, client)
      })
    } catch (error) {
      this.deps.logger.warn({ event: 'tunnel.ws.accept.failed', hostId, id: exchange.id, error })
      this.settleWs(exchange)
      try {
        exchange.socket.destroy()
      } catch {
        // The socket is already gone.
      }
    }
  }

  private onClientOpen(exchange: WsExchange, client: WebSocket): void {
    if (exchange.done) {
      try {
        client.close(1001, 'tunnel closed')
      } catch {
        client.terminate()
      }
      return
    }
    exchange.client = client
    this.touchWs(exchange)
    client.on('message', (data, isBinary) => {
      this.touchWs(exchange)
      if (exchange.done) return
      const buffer = toBuffer(data)
      for (const slice of splitTunnelPayload(buffer)) {
        this.deps.hub.sendHostFrame(exchange.hostId, { t: 'ws.frame', id: exchange.id, binary: isBinary }, slice)
      }
    })
    client.on('close', (code, reason) => {
      if (exchange.done) return
      this.deps.hub.sendHostFrame(exchange.hostId, {
        t: 'ws.close',
        id: exchange.id,
        code: sendableCloseCode(code, 1000),
        reason: reason.toString().slice(0, 120),
      })
      this.settleWs(exchange)
    })
    client.on('error', () => {
      // A socket error is always followed by close.
    })
    client.on('pong', () => this.touchWs(exchange))
  }

  private onHostWsFrame(hostId: string, frame: TunnelWsFrameFrame, payload: Uint8Array): void {
    const exchange = this.wsExchanges.get(frame.id)
    if (!exchange || exchange.hostId !== hostId) {
      this.deps.logger.debug({ event: 'tunnel.frame.unknown', hostId, type: 'ws.frame', id: frame.id })
      return
    }
    const client = exchange.client
    if (!client || exchange.done) return
    this.touchWs(exchange)
    try {
      client.send(Buffer.from(payload), { binary: frame.binary })
    } catch (error) {
      this.deps.logger.warn({ event: 'tunnel.ws.send.failed', hostId, id: exchange.id, error })
      this.settleWs(exchange)
      try {
        client.terminate()
      } catch {
        // The client socket is already gone.
      }
    }
  }

  private onHostWsClose(hostId: string, frame: TunnelWsCloseFrame): void {
    const exchange = this.wsExchanges.get(frame.id)
    if (!exchange || exchange.hostId !== hostId) return
    if (exchange.done) return
    const client = exchange.client
    this.settleWs(exchange)
    if (!client) {
      try {
        exchange.socket.destroy()
      } catch {
        // The socket is already gone.
      }
      return
    }
    try {
      client.close(sendableCloseCode(frame.code, 1000), frame.reason?.slice(0, 120))
    } catch {
      client.terminate()
    }
  }

  private touchWs(exchange: WsExchange): void {
    if (exchange.done) return
    if (exchange.timer) clearTimeout(exchange.timer)
    exchange.timer = setTimeout(() => this.onWsTimeout(exchange), TUNNEL_IDLE_TIMEOUT_MS)
    exchange.timer.unref()
  }

  private onWsTimeout(exchange: WsExchange): void {
    if (exchange.done) return
    this.deps.logger.warn({ event: 'tunnel.ws.timeout', hostId: exchange.hostId, id: exchange.id })
    this.deps.hub.sendHostFrame(exchange.hostId, { t: 'ws.close', id: exchange.id, code: 1001, reason: 'idle timeout' })
    const client = exchange.client
    this.settleWs(exchange)
    if (client) {
      try {
        client.close(1001, 'idle timeout')
      } catch {
        client.terminate()
      }
    } else {
      try {
        exchange.socket.destroy()
      } catch {
        // The socket is already gone.
      }
    }
  }

  private settleWs(exchange: WsExchange): void {
    if (exchange.done) return
    exchange.done = true
    if (exchange.timer) {
      clearTimeout(exchange.timer)
      exchange.timer = null
    }
    this.wsExchanges.delete(exchange.id)
    this.release(exchange.deviceId, exchange.hostId)
  }

  // --- Socket rejection ----------------------------------------------------------

  private rejectSocket(socket: Duplex, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    const lines = [
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
      'content-type: application/json; charset=utf-8',
      `content-length: ${Buffer.byteLength(payload)}`,
      'connection: close',
      '',
      payload,
    ]
    try {
      socket.write(lines.join('\r\n'))
    } catch {
      // The peer may already be gone.
    }
    socket.destroy()
  }
}
