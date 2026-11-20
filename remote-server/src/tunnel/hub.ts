import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import type { AuthService } from '../auth.js'
import type { Config } from '../config.js'
import { ApiError, errorBody } from '../errors.js'
import type { Logger } from '../logger.js'
import type { PairingService } from '../pairing.js'
import type { HostRow, Repositories } from '../repositories.js'
import {
  HOST_TO_NODE_FRAME_TYPES,
  TUNNEL_BACKPRESSURE_HIGH_WATER,
  TUNNEL_BACKPRESSURE_LOW_WATER,
  TUNNEL_HEARTBEAT_INTERVAL_MS,
  TUNNEL_HEARTBEAT_TIMEOUT_MS,
  TUNNEL_HELLO_TIMEOUT_MS,
  TUNNEL_MESSAGE_MAX,
  TUNNEL_PATH,
  TunnelFrameError,
  decodeTunnelFrame,
  encodeTunnelFrame,
  type TunnelFrame,
  type TunnelHelloFrame,
} from '../../../src/remote/tunnel-protocol.js'

/** A consumer of Host → node frames; the HTTP/WS reverse proxy registers one. */
export interface TunnelFrameHandler {
  onFrame(hostId: string, frame: TunnelFrame, payload: Uint8Array): boolean | void
  onClose?(hostId: string): void
}

export interface TunnelHubDeps {
  config: Config
  logger: Logger
  repos: Repositories
  auth: AuthService
  pairing: PairingService
}

interface HostConnection {
  ws: WebSocket
  hostId: string
  authenticated: boolean
  direct?: boolean
  lastActivity: number
  helloDeadline: NodeJS.Timeout | null
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
}

/** Seconds to wait for ws.bufferedAmount to drop before dropping a frame. */
const DRAIN_TIMEOUT_MS = 30_000
const DRAIN_POLL_MS = 10

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

/**
 * One reverse-tunnel endpoint per connected Host. `/v1/tunnel` carries framed
 * HTTP/WS traffic for paired devices; this class owns framing, authentication,
 * liveness and Host → node frame routing only. Proxy state lives in
 * `TunnelProxy`, which registers as a frame handler.
 */
export class TunnelHub {
  private readonly wss: WebSocketServer
  private readonly hosts = new Map<string, HostConnection>()
  private readonly connections = new Set<HostConnection>()
  private readonly handlers = new Set<TunnelFrameHandler>()
  private readonly heartbeat: NodeJS.Timeout
  private closed = false

  constructor(private readonly deps: TunnelHubDeps) {
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: TUNNEL_MESSAGE_MAX,
    })
    this.heartbeat = setInterval(() => this.heartbeatTick(), TUNNEL_HEARTBEAT_INTERVAL_MS)
    this.heartbeat.unref()
  }

  /** Accept the `/v1/tunnel` upgrade. Never throws; rejected sockets are closed. */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (this.closed) {
      socket.destroy()
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== TUNNEL_PATH) {
        this.rejectSocket(socket, 404)
        return
      }
      if (req.method !== 'GET') {
        this.rejectSocket(socket, 405)
        return
      }
      let host: HostRow
      try {
        host = this.deps.auth.authenticateHostRequest(req)
      } catch (error) {
        const status = error instanceof ApiError ? error.status : 401
        this.deps.logger.warn({
          event: 'tunnel.upgrade.rejected',
          status,
          reason: error instanceof ApiError ? error.code : 'AUTH_FAILED',
        })
        this.rejectSocket(socket, status)
        return
      }
      this.wss.handleUpgrade(req, socket, head, ws => {
        this.onConnection(ws, host)
      })
    } catch (error) {
      this.deps.logger.warn({ event: 'tunnel.upgrade.failed', error })
      socket.destroy()
    }
  }

  isHostOnline(hostId: string): boolean {
    return this.hosts.has(hostId)
  }

  supportsDirect(hostId: string): boolean { return this.hosts.get(hostId)?.direct === true }

  onlineHostIds(): string[] {
    return [...this.hosts.keys()]
  }

  /** Queue one frame for a Host. Returns false when the Host is not connected. */
  sendHostFrame(hostId: string, frame: TunnelFrame, payload?: Uint8Array): boolean {
    const connection = this.hosts.get(hostId)
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) return false
    let encoded: Buffer
    try {
      encoded = encodeTunnelFrame(frame, payload)
    } catch (error) {
      this.deps.logger.warn({
        event: 'tunnel.frame.encode.failed',
        hostId,
        type: frame.t,
        reason: error instanceof TunnelFrameError ? error.code : 'ENCODE_FAILED',
      })
      return false
    }
    try {
      connection.ws.send(encoded, error => {
        if (error) {
          this.deps.logger.debug({ event: 'tunnel.frame.send.failed', hostId, type: frame.t })
        }
      })
      return true
    } catch (error) {
      this.deps.logger.warn({ event: 'tunnel.frame.send.failed', hostId, type: frame.t, error })
      return false
    }
  }

  /**
   * Like {@link sendHostFrame} but waits for the Host socket to drain when its
   * send buffer is above the high-water mark. Used for request body backpressure.
   */
  async sendHostFrameAsync(hostId: string, frame: TunnelFrame, payload?: Uint8Array): Promise<boolean> {
    const connection = this.hosts.get(hostId)
    if (!connection) return false
    if (connection.ws.bufferedAmount > TUNNEL_BACKPRESSURE_HIGH_WATER) {
      const drained = await this.waitForDrain(connection)
      if (!drained) return false
    }
    return this.sendHostFrame(hostId, frame, payload)
  }

  addFrameHandler(handler: TunnelFrameHandler): void {
    this.handlers.add(handler)
  }

  removeFrameHandler(handler: TunnelFrameHandler): void {
    this.handlers.delete(handler)
  }

  shutdown(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    for (const connection of [...this.connections]) {
      this.abort(connection, 1001, 'server shutting down')
    }
    this.connections.clear()
    this.hosts.clear()
    try {
      this.wss.close()
    } catch {
      // The ws server may already be closed.
    }
  }

  private onConnection(ws: WebSocket, host: HostRow): void {
    const connection: HostConnection = {
      ws,
      hostId: host.host_id,
      authenticated: false,
      lastActivity: Date.now(),
      helloDeadline: null,
    }
    this.connections.add(connection)
    connection.helloDeadline = setTimeout(() => {
      if (!connection.authenticated) {
        this.deps.logger.warn({ event: 'tunnel.hello.timeout', hostId: host.host_id })
        this.abort(connection, 4001, 'hello timeout')
      }
    }, TUNNEL_HELLO_TIMEOUT_MS)
    connection.helloDeadline.unref()

    ws.on('message', (data, isBinary) => {
      connection.lastActivity = Date.now()
      this.onMessage(connection, data, isBinary)
    })
    ws.on('close', () => this.cleanup(connection))
    ws.on('error', () => {
      // A socket error is always followed by close; nothing to do here.
    })
    ws.on('pong', () => {
      connection.lastActivity = Date.now()
    })
    this.deps.logger.debug({ event: 'tunnel.connection.opened', hostId: host.host_id })
  }

  private onMessage(connection: HostConnection, data: RawData, isBinary: boolean): void {
    if (this.closed) return
    if (!isBinary) {
      this.deps.logger.warn({ event: 'tunnel.frame.rejected', hostId: connection.hostId, reason: 'TEXT_FRAME' })
      this.abort(connection, 1009, 'binary frames only')
      return
    }
    let frame: TunnelFrame
    let payload: Uint8Array
    try {
      const decoded = decodeTunnelFrame(toBuffer(data))
      frame = decoded.frame
      payload = decoded.payload
    } catch (error) {
      const reason = error instanceof TunnelFrameError ? error.code : 'FRAME_INVALID'
      this.deps.logger.warn({ event: 'tunnel.frame.rejected', hostId: connection.hostId, reason })
      this.abort(connection, 1009, reason === 'FRAME_TOO_LARGE' ? 'frame too large' : 'invalid frame')
      return
    }

    if (!connection.authenticated) {
      if (frame.t !== 'hello') {
        this.deps.logger.warn({ event: 'tunnel.frame.rejected', hostId: connection.hostId, reason: 'HELLO_REQUIRED' })
        this.abort(connection, 4001, 'hello required')
        return
      }
      this.onHello(connection, frame)
      return
    }

    if (!HOST_TO_NODE_FRAME_TYPES.has(frame.t)) {
      this.deps.logger.warn({ event: 'tunnel.frame.rejected', hostId: connection.hostId, type: frame.t })
      this.abort(connection, 1009, 'invalid frame type')
      return
    }
    switch (frame.t) {
      case 'hello':
        this.deps.logger.warn({ event: 'tunnel.frame.rejected', hostId: connection.hostId, reason: 'DUPLICATE_HELLO' })
        this.abort(connection, 4001, 'duplicate hello')
        return
      case 'ping':
        this.sendHostFrame(connection.hostId, { t: 'pong', at: frame.at })
        return
      case 'pong':
        return
      case 'pair.approve':
      case 'pair.reject':
        this.onPairDecision(connection, frame.requestId, frame.t === 'pair.approve')
        return
      default:
        this.dispatch(connection.hostId, frame, payload)
    }
  }

  private onHello(connection: HostConnection, frame: TunnelHelloFrame): void {
    if (frame.hostId !== connection.hostId) {
      this.deps.logger.warn({ event: 'tunnel.hello.rejected', hostId: connection.hostId, reason: 'HOST_ID_MISMATCH' })
      this.abort(connection, 4001, 'host id mismatch')
      return
    }
    const capabilities = Array.isArray(frame.capabilities) ? frame.capabilities : []
    if (!capabilities.includes('http')) {
      this.deps.logger.warn({ event: 'tunnel.hello.rejected', hostId: connection.hostId, reason: 'HTTP_CAPABILITY_REQUIRED' })
      this.abort(connection, 4001, 'http capability required')
      return
    }
    if (connection.helloDeadline) {
      clearTimeout(connection.helloDeadline)
      connection.helloDeadline = null
    }
    connection.direct = capabilities.includes('direct')
    connection.authenticated = true
    connection.lastActivity = Date.now()

    const previous = this.hosts.get(connection.hostId)
    this.hosts.set(connection.hostId, connection)
    if (previous && previous !== connection) {
      this.deps.logger.info({ event: 'tunnel.connection.replaced', hostId: connection.hostId })
      this.abort(previous, 4001, 'replaced by a newer connection')
      // The old Host process is gone: fail its in-flight exchanges instead of
      // letting them hang until the request timeout.
      this.notifyClose(connection.hostId)
    }
    if (connection.direct) {
      for (const clientDeviceId of this.deps.repos.listRevokedDevices(connection.hostId)) {
        this.sendHostFrame(connection.hostId, { t: 'pair.revoked', clientDeviceId })
      }
    }
    this.deps.logger.info({ event: 'tunnel.authenticated', hostId: connection.hostId })
  }

  private onPairDecision(connection: HostConnection, requestId: string, approve: boolean): void {
    try {
      const host = this.deps.repos.findHostById(connection.hostId)
      if (!host) {
        this.deps.logger.warn({ event: 'tunnel.pair.decision.rejected', hostId: connection.hostId, reason: 'HOST_UNKNOWN' })
        return
      }
      if (typeof requestId !== 'string' || requestId.length === 0) {
        this.deps.logger.warn({ event: 'tunnel.pair.decision.rejected', hostId: connection.hostId, reason: 'INVALID_REQUEST_ID' })
        return
      }
      this.deps.pairing.hostDecision(host, requestId, approve)
    } catch (error) {
      this.deps.logger.warn({
        event: 'tunnel.pair.decision.failed',
        hostId: connection.hostId,
        reason: error instanceof ApiError ? error.code : 'PAIRING_FAILED',
      })
    }
  }

  private dispatch(hostId: string, frame: TunnelFrame, payload: Uint8Array): void {
    let handled = false
    for (const handler of [...this.handlers]) {
      try {
        if (handler.onFrame(hostId, frame, payload)) handled = true
      } catch (error) {
        this.deps.logger.warn({ event: 'tunnel.handler.failed', hostId, type: frame.t, error })
      }
    }
    if (!handled) this.deps.logger.debug({ event: 'tunnel.frame.unhandled', hostId, type: frame.t })
  }

  private notifyClose(hostId: string): void {
    for (const handler of [...this.handlers]) {
      try {
        handler.onClose?.(hostId)
      } catch (error) {
        this.deps.logger.warn({ event: 'tunnel.handler.close.failed', hostId, error })
      }
    }
  }

  private heartbeatTick(): void {
    if (this.closed) return
    const now = Date.now()
    for (const connection of [...this.hosts.values()]) {
      if (now - connection.lastActivity > TUNNEL_HEARTBEAT_TIMEOUT_MS) {
        this.deps.logger.warn({ event: 'tunnel.heartbeat.timeout', hostId: connection.hostId })
        this.abort(connection, 1001, 'heartbeat timeout')
        continue
      }
      this.sendHostFrame(connection.hostId, { t: 'ping', at: now })
    }
  }

  private async waitForDrain(connection: HostConnection): Promise<boolean> {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS
    while (connection.ws.readyState === WebSocket.OPEN) {
      if (connection.ws.bufferedAmount <= TUNNEL_BACKPRESSURE_LOW_WATER) return true
      if (Date.now() >= deadline) {
        this.deps.logger.warn({ event: 'tunnel.backpressure.timeout', hostId: connection.hostId })
        return false
      }
      await new Promise<void>(resolve => {
        setTimeout(resolve, DRAIN_POLL_MS)
      })
    }
    return false
  }

  private cleanup(connection: HostConnection): void {
    if (connection.helloDeadline) {
      clearTimeout(connection.helloDeadline)
      connection.helloDeadline = null
    }
    this.connections.delete(connection)
    if (this.hosts.get(connection.hostId) === connection) {
      this.hosts.delete(connection.hostId)
      this.deps.logger.info({ event: 'tunnel.connection.closed', hostId: connection.hostId })
      this.notifyClose(connection.hostId)
    }
  }

  private abort(connection: HostConnection, code: number, reason: string): void {
    this.cleanup(connection)
    try {
      connection.ws.close(code, reason)
    } catch {
      try {
        connection.ws.terminate()
      } catch {
        // The socket is already gone.
      }
    }
  }

  private rejectSocket(socket: Duplex, status: number): void {
    const body = JSON.stringify(errorBody(status === 401 ? 'AUTH_REQUIRED' : 'UPGRADE_REJECTED', 'The tunnel upgrade was rejected.'))
    const head = [
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
      'content-type: application/json; charset=utf-8',
      `content-length: ${Buffer.byteLength(body)}`,
      'connection: close',
      '',
      body,
    ].join('\r\n')
    try {
      socket.write(head)
    } catch {
      // The peer may already be gone.
    }
    socket.destroy()
  }
}
