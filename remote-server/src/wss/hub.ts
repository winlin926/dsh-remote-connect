import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebSocket, WebSocketServer } from 'ws'
import type { Config } from '../config.js'
import { ApiError } from '../errors.js'
import { hashToken, newRequestId } from '../identity.js'
import type { Logger } from '../logger.js'
import {
  decodeControlFrame,
  encodeControlFrame,
  MAX_CONTROL_FRAME_BYTES,
  MAX_RELAY_FRAME_BYTES,
  PROTOCOL_VERSION,
  SERVER_SHUTDOWN_CLOSE_CODE,
  SERVER_SHUTDOWN_CLOSE_REASON,
  type ControlErrorPayload,
  type ControlFrame,
  type ControlFrameType,
  type ConnectIncomingPayload,
  type ConnectRequestPayload,
  type HelloPayload,
} from '../protocol.js'
import type { PairingService } from '../pairing.js'
import type { RateLimiter } from '../rate-limit.js'
import type { Repositories } from '../repositories.js'
import { clientIp, canonicalOrigin, originAllowed } from '../security.js'
import type { SessionService } from '../sessions.js'
import type { AuthService } from '../auth.js'

const CLOSE_AUTH = 4001
const CLOSE_REPLACED = 4003
const CLOSE_REVOKED = 4004
const CLOSE_POLICY = 1008
const CLOSE_GOING_AWAY = 1001
const CLOSE_BACKPRESSURE = 1013
const CLOSE_SHUTDOWN = SERVER_SHUTDOWN_CLOSE_CODE
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

const FORWARDABLE_TYPES = new Set<ControlFrameType>([
  'secure.handshake',
  'relay',
  'signal.offer',
  'signal.answer',
  'signal.ice',
  'transport.selected',
  'connect.rejected',
  'connection.lease.request',
  'connection.lease.ack',
  'connection.lease.close',
])

interface Connection {
  ws: WebSocket
  role: 'host' | 'client'
  deviceId: string
  /** Host id for host connections. */
  hostId: string | null
  /** Origin of the upgrade request; browser sessions are bound to it. */
  origin: string
  cookieHeader: string | undefined
  alive: boolean
  lastActivity: number
  authenticated: boolean
  helloDeadline: NodeJS.Timeout | null
  connectionIds: Set<string>
  relayCounters: Map<string, number>
  frameTokens: number
  frameUpdatedAt: number
}

interface ActiveConnection {
  hostId: string
  hostDeviceId: string
  clientDeviceId: string
  clientIdentityKey: string
  clientConnection: Connection
  hostConnection: Connection
}

export interface HubDeps {
  config: Config
  logger: Logger
  repos: Repositories
  sessions: SessionService
  auth: AuthService
  pairing: PairingService
  limiter: RateLimiter
}

/**
 * Authenticated WSS control plane. The hub authorizes one Host/client pair,
 * coordinates connection setup and forwards opaque Noise frames; it never
 * decrypts, persists or logs relay payloads.
 */
export class ControlHub {
  private wss: WebSocketServer | null = null
  private readonly hosts = new Map<string, Connection>()
  private readonly clients = new Map<string, Connection>()
  private readonly connections = new Map<string, ActiveConnection>()
  private heartbeat: NodeJS.Timeout | null = null

  constructor(private readonly deps: HubDeps) {
    this.deps.pairing.attach({
      isHostOnline: hostId => this.hosts.has(hostId),
      sendToHost: (hostId, frame) => {
        const connection = this.hosts.get(hostId)
        return connection ? this.send(connection, frame) : false
      },
      sendToDevice: (deviceId, frame) => {
        const connection = this.clients.get(deviceId)
        return connection ? this.send(connection, frame) : false
      },
      closeDeviceSessions: (deviceId, code, reason) => {
        const connection = this.clients.get(deviceId)
        if (connection) this.abort(connection, code, reason)
      },
      closeHostConnections: (hostId, code, reason) => {
        const connection = this.hosts.get(hostId)
        if (connection) this.abort(connection, code, reason)
      },
    })
  }

  async attach(server: HttpServer): Promise<void> {
    const ws = await import('ws')
    this.wss = new ws.WebSocketServer({ noServer: true, maxPayload: MAX_RELAY_FRAME_BYTES + 4096 })
    this.heartbeat = setInterval(() => this.heartbeatTick(), this.deps.config.heartbeatIntervalMs)
    this.heartbeat.unref()
  }

  /** Handle an HTTP Upgrade for `/v1/control`. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const wss = this.wss
    if (!wss) {
      socket.destroy()
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/v1/control') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (req.method !== 'GET') {
      socket.write('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (!originAllowed(req, this.deps.config)) {
      this.deps.logger.warn({ event: 'control.upgrade.rejected', reason: 'origin' })
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const ip = clientIp(req, this.deps.config)
    if (!this.deps.limiter.take('upgrade', ip, this.deps.config.limits.upgrade).allowed) {
      this.deps.logger.warn({ event: 'control.upgrade.rejected', reason: 'rate-limit' })
      socket.write('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 5\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, client => {
      this.onConnection(client, req)
    })
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const connection: Connection = {
      ws,
      role: 'client',
      deviceId: '',
      hostId: null,
      origin: canonicalOrigin(req, this.deps.config),
      cookieHeader: req.headers.cookie,
      alive: true,
      lastActivity: Date.now(),
      authenticated: false,
      helloDeadline: null,
      connectionIds: new Set(),
      relayCounters: new Map(),
      frameTokens: this.deps.config.limits.frames.burst,
      frameUpdatedAt: Date.now(),
    }
    connection.helloDeadline = setTimeout(() => {
      if (!connection.authenticated) this.abort(connection, CLOSE_AUTH, 'hello timeout')
    }, this.deps.config.helloTimeoutMs)
    connection.helloDeadline.unref()

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      connection.lastActivity = Date.now()
      this.onMessage(connection, isBinary ? new Uint8Array(data) : data.toString('utf8'))
    })
    ws.on('pong', () => {
      connection.alive = true
      connection.lastActivity = Date.now()
    })
    ws.on('close', () => {
      this.cleanup(connection)
    })
    ws.on('error', () => {
      // Socket errors are surfaced through `close`; never log peer payloads.
    })
    this.deps.logger.debug({ event: 'control.opened', ip: clientIp(req, this.deps.config) })
  }

  private onMessage(connection: Connection, raw: Uint8Array | string): void {
    if (!this.takeFrameToken(connection)) {
      this.abort(connection, CLOSE_POLICY, 'rate limit exceeded')
      return
    }
    let frame: ControlFrame
    try {
      frame = decodeControlFrame(raw, {
        maxControlFrameBytes: MAX_CONTROL_FRAME_BYTES,
        maxRelayFrameBytes: MAX_RELAY_FRAME_BYTES,
      })
    } catch {
      this.abort(connection, CLOSE_POLICY, 'invalid control frame')
      return
    }
    if (!connection.authenticated) {
      if (frame.type !== 'hello') {
        this.abort(connection, CLOSE_AUTH, 'hello required')
        return
      }
      this.onHello(connection, frame)
      return
    }
    if (frame.type === 'ping') {
      this.send(connection, { ...frame, id: newRequestId(), type: 'pong', timestamp: Date.now() })
      return
    }
    if (frame.type === 'pong') return
    if (frame.type === 'hello') {
      this.fail(connection, 'INVALID_MESSAGE', 'hello was already completed')
      return
    }
    try {
      this.route(connection, frame)
    } catch (error) {
      if (error instanceof ApiError) {
        this.fail(connection, error.code, error.message)
        return
      }
      this.deps.logger.error({ event: 'control.route.failed', error })
      this.fail(connection, 'INTERNAL', 'internal error')
    }
  }

  private onHello(connection: Connection, frame: ControlFrame): void {
    const payload = frame.payload as HelloPayload
    if (!payload.protocols.includes(PROTOCOL_VERSION)) {
      this.fail(connection, 'UNSUPPORTED_VERSION', 'unsupported protocol version')
      this.abort(connection, CLOSE_AUTH, 'unsupported protocol version')
      return
    }
    try {
      if (payload.role === 'host') this.authenticateHost(connection, payload)
      else this.authenticateClient(connection, payload)
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'authentication failed'
      this.fail(connection, 'AUTH_INVALID', message)
      this.abort(connection, CLOSE_AUTH, 'authentication failed')
      return
    }
    connection.authenticated = true
    connection.lastActivity = Date.now()
    if (connection.helloDeadline) {
      clearTimeout(connection.helloDeadline)
      connection.helloDeadline = null
    }
    this.send(connection, {
      v: 1,
      id: newRequestId(),
      type: 'hello.ack',
      timestamp: Date.now(),
      payload: {
        protocol: PROTOCOL_VERSION,
        serverVersion: this.deps.config.nodeVersion,
        connectionSessionId: newRequestId(),
        heartbeatIntervalMs: this.deps.config.heartbeatIntervalMs,
        maxControlFrameBytes: MAX_CONTROL_FRAME_BYTES,
        maxRelayFrameBytes: MAX_RELAY_FRAME_BYTES,
        capabilities: [...this.deps.config.capabilities],
        webrtcEnabled: false,
      },
    })
    this.deps.logger.info({ event: 'control.authenticated', role: connection.role, deviceId: connection.deviceId })
  }

  private authenticateHost(connection: Connection, payload: HelloPayload): void {
    const host = this.deps.repos.findHostByCredentialHash(hashToken(payload.accessToken))
    if (!host) throw ApiError.unauthorized('AUTH_INVALID', 'The Host credential is not valid.')
    if (host.device_id !== payload.deviceId) {
      throw ApiError.unauthorized('AUTH_INVALID', 'The Host device id does not match the credential.')
    }
    const previous = this.hosts.get(host.host_id)
    connection.role = 'host'
    connection.deviceId = host.device_id
    connection.hostId = host.host_id
    this.hosts.set(host.host_id, connection)
    this.deps.repos.touchHost(host.host_id, Date.now())
    if (previous && previous !== connection) this.abort(previous, CLOSE_REPLACED, 'replaced by a newer connection')
  }

  private authenticateClient(connection: Connection, payload: HelloPayload): void {
    const context =
      this.deps.sessions.resolve(payload.accessToken, connection.origin) ??
      this.deps.auth.sessionFromCookieValue(connection.cookieHeader, connection.origin)
    if (!context) throw ApiError.unauthorized('AUTH_INVALID', 'The device session is not valid.')
    if (context.device.device_id !== payload.deviceId) {
      throw ApiError.unauthorized('AUTH_INVALID', 'The device id does not match the session.')
    }
    const previous = this.clients.get(context.device.device_id)
    connection.role = 'client'
    connection.deviceId = context.device.device_id
    this.clients.set(context.device.device_id, connection)
    this.deps.repos.touchDevice(context.device.device_id, Date.now())
    if (previous && previous !== connection) this.abort(previous, CLOSE_REPLACED, 'replaced by a newer connection')
  }

  private route(connection: Connection, frame: ControlFrame): void {
    switch (frame.type) {
      case 'pair.approve':
      case 'pair.reject': {
        if (connection.role !== 'host' || !connection.hostId) {
          throw ApiError.forbidden('METHOD_NOT_ALLOWED', 'Only a Host may answer pairing requests.')
        }
        const requestId = (frame.payload as { requestId: string }).requestId
        const host = this.deps.repos.findHostById(connection.hostId)
        if (!host) throw ApiError.unauthorized('AUTH_INVALID', 'The Host is no longer registered.')
        this.deps.pairing.hostDecision(host, requestId, frame.type === 'pair.approve')
        return
      }
      case 'connect.request': {
        if (connection.role !== 'client') {
          throw ApiError.forbidden('METHOD_NOT_ALLOWED', 'Only a paired client may request a connection.')
        }
        this.handleConnectRequest(connection, frame.payload as ConnectRequestPayload)
        return
      }
      case 'device.revoked': {
        if (connection.role !== 'host' || !connection.hostId) {
          throw ApiError.forbidden('METHOD_NOT_ALLOWED', 'Only a Host may revoke a device.')
        }
        this.handleHostRevoke(connection, (frame.payload as { deviceId: string }).deviceId)
        return
      }
      case 'connect.rejected':
        if (connection.role !== 'host') {
          throw ApiError.forbidden('METHOD_NOT_ALLOWED', 'Only a Host may reject a connection.')
        }
        this.forward(connection, frame)
        return
      default:
        this.forward(connection, frame)
    }
  }

  private handleConnectRequest(connection: Connection, payload: ConnectRequestPayload): void {
    const host = this.deps.repos.findHostByDeviceId(payload.hostDeviceId)
    if (!host) throw ApiError.notFound('DEVICE_NOT_FOUND', 'The requested Host does not exist.')
    const relationship = this.deps.repos.findRelationship(host.host_id, connection.deviceId)
    if (!relationship || relationship.revoked_at !== null) {
      throw ApiError.forbidden('DEVICE_REVOKED', 'This device is not paired with the requested Host.')
    }
    const device = this.deps.repos.findDevice(connection.deviceId)
    if (!device || device.identity_key !== relationship.client_identity_key) {
      throw ApiError.forbidden('DEVICE_REVOKED', 'This device identity is no longer valid.')
    }
    const hostConnection = this.hosts.get(host.host_id)
    if (!hostConnection) throw ApiError.conflict('HOST_OFFLINE', 'The Host is not connected to this relay.')
    const activeForClient = [...this.connections.values()].filter(
      entry => entry.clientDeviceId === connection.deviceId,
    )
    if (activeForClient.length >= this.deps.config.maxConnectionsPerClient) {
      throw ApiError.tooManyRequests('RATE_LIMITED', 'Too many active connections for this device.')
    }
    if (this.connections.size >= this.deps.config.maxConnections) {
      throw ApiError.tooManyRequests('RATE_LIMITED', 'The relay is at its connection capacity.')
    }
    const connectionId = newRequestId()
    this.connections.set(connectionId, {
      hostId: host.host_id,
      hostDeviceId: host.device_id,
      clientDeviceId: connection.deviceId,
      clientIdentityKey: device.identity_key,
      clientConnection: connection,
      hostConnection,
    })
    connection.connectionIds.add(connectionId)

    const incoming: ConnectIncomingPayload = {
      connectionId,
      clientDeviceId: connection.deviceId,
      clientIdentityKey: device.identity_key,
      authorization: 'account',
      preferredTransports: payload.preferredTransports,
    }
    this.send(hostConnection, this.makeFrame('connect.incoming', incoming))
    this.send(connection, this.makeFrame('connect.accepted', { connectionId }))
    this.deps.logger.info({ event: 'control.connect', hostId: host.host_id, deviceId: connection.deviceId })
  }

  private handleHostRevoke(connection: Connection, deviceId: string): void {
    const hostId = connection.hostId
    if (!hostId) return
    this.deps.repos.revokeRelationship(hostId, deviceId, Date.now())
    this.deps.sessions.revokeDevice(deviceId)
    for (const connectionId of [...connection.connectionIds]) {
      const entry = this.connections.get(connectionId)
      if (entry && entry.hostId === hostId && entry.clientDeviceId === deviceId) {
        this.connections.delete(connectionId)
        connection.connectionIds.delete(connectionId)
      }
    }
    this.send(connection, this.makeFrame('device.revoked', { deviceId }))
    const client = this.clients.get(deviceId)
    if (client) this.abort(client, CLOSE_REVOKED, 'device revoked')
    this.deps.logger.info({ event: 'control.device.revoked', hostId, deviceId })
  }

  private forward(connection: Connection, frame: ControlFrame): void {
    if (!FORWARDABLE_TYPES.has(frame.type)) {
      throw ApiError.badRequest('INVALID_MESSAGE', `Frames of type ${frame.type} are not forwarded by this node.`)
    }
    const payload = frame.payload as { connectionId?: string; targetDeviceId?: string; counter?: number }
    const connectionId = payload.connectionId
    if (!connectionId) throw ApiError.badRequest('INVALID_MESSAGE', 'connectionId is required.')
    const entry = this.connections.get(connectionId)
    if (!entry) throw ApiError.notFound('CONNECTION_NOT_FOUND', 'The connection is not active.')
    if (connection.role === 'host' ? entry.hostId !== connection.hostId : entry.clientDeviceId !== connection.deviceId) {
      throw ApiError.forbidden('AUTH_INVALID', 'This connection does not belong to the sender.')
    }
    const peerDeviceId = connection.role === 'host' ? entry.clientDeviceId : entry.hostDeviceId
    if (payload.targetDeviceId !== undefined && payload.targetDeviceId !== peerDeviceId) {
      throw ApiError.badRequest('INVALID_MESSAGE', 'targetDeviceId does not match the active peer.')
    }
    if (frame.type === 'relay') this.checkRelayCounter(connection, connectionId, payload.counter)

    const target = connection.role === 'host' ? this.clients.get(entry.clientDeviceId) : this.hosts.get(entry.hostId)
    if (!target) {
      this.send(
        connection,
        this.makeFrame('connect.rejected', {
          connectionId,
          code: 'PEER_OFFLINE',
          message: 'The peer is not connected.',
        }),
      )
      return
    }
    if (target.ws.bufferedAmount + 512 > MAX_BUFFERED_BYTES) {
      this.abort(target, CLOSE_BACKPRESSURE, 'backpressure limit exceeded')
      return
    }
    this.send(target, { ...frame, timestamp: Date.now() })
  }

  private checkRelayCounter(connection: Connection, connectionId: string, counter: number | undefined): void {
    if (counter === undefined) throw ApiError.badRequest('INVALID_MESSAGE', 'relay counter is required.')
    const key = `${connectionId}\0${connection.deviceId}`
    const last = connection.relayCounters.get(key)
    if (last !== undefined && counter <= last) {
      throw ApiError.badRequest('INVALID_MESSAGE', 'relay counter must strictly increase.')
    }
    connection.relayCounters.set(key, counter)
  }

  private makeFrame(type: ControlFrameType, payload: unknown): ControlFrame {
    return { v: 1, id: newRequestId(), type, timestamp: Date.now(), payload }
  }

  private send(connection: Connection, frame: ControlFrame): boolean {
    if (connection.ws.readyState !== 1) return false
    let encoded: string
    try {
      encoded = encodeControlFrame(frame, {
        maxControlFrameBytes: MAX_CONTROL_FRAME_BYTES,
        maxRelayFrameBytes: MAX_RELAY_FRAME_BYTES,
      })
    } catch {
      this.deps.logger.warn({ event: 'control.frame.rejected', type: frame.type })
      return false
    }
    connection.ws.send(encoded)
    return true
  }

  private fail(connection: Connection, code: string, message: string): void {
    const payload: ControlErrorPayload = { code: code as ControlErrorPayload['code'], message }
    this.send(connection, this.makeFrame('error', payload))
  }

  private takeFrameToken(connection: Connection): boolean {
    const rule = this.deps.config.limits.frames
    const now = Date.now()
    const elapsed = Math.max(0, now - connection.frameUpdatedAt) / 1_000
    connection.frameTokens = Math.min(rule.burst, connection.frameTokens + elapsed * rule.ratePerSecond)
    connection.frameUpdatedAt = now
    if (connection.frameTokens < 1) return false
    connection.frameTokens -= 1
    return true
  }

  private heartbeatTick(): void {
    const now = Date.now()
    for (const connection of [...this.hosts.values(), ...this.clients.values()]) {
      if (now - connection.lastActivity > this.deps.config.heartbeatTimeoutMs || !connection.alive) {
        this.abort(connection, CLOSE_SHUTDOWN, 'heartbeat timeout')
        continue
      }
      connection.alive = false
      try {
        connection.ws.ping()
      } catch {
        this.cleanup(connection)
      }
    }
  }

  private abort(connection: Connection, code: number, reason: string): void {
    this.cleanup(connection)
    try {
      connection.ws.close(code, reason)
    } catch {
      try {
        connection.ws.terminate()
      } catch {
        // Already gone.
      }
    }
  }

  private cleanup(connection: Connection): void {
    if (connection.helloDeadline) {
      clearTimeout(connection.helloDeadline)
      connection.helloDeadline = null
    }
    if (connection.role === 'host' && connection.hostId) {
      if (this.hosts.get(connection.hostId) === connection) this.hosts.delete(connection.hostId)
    } else if (connection.role === 'client' && connection.deviceId) {
      if (this.clients.get(connection.deviceId) === connection) this.clients.delete(connection.deviceId)
    }
    for (const connectionId of connection.connectionIds) {
      const entry = this.connections.get(connectionId)
      this.connections.delete(connectionId)
      if (!entry) continue
      const peer = connection.role === 'host' ? entry.clientConnection : entry.hostConnection
      if (peer && peer !== connection) {
        peer.connectionIds.delete(connectionId)
        this.send(
          peer,
          this.makeFrame('connect.rejected', {
            connectionId,
            code: 'PEER_DISCONNECTED',
            message: 'The peer disconnected.',
          }),
        )
      }
    }
    connection.connectionIds.clear()
    connection.relayCounters.clear()
  }

  /** Whether a Host currently holds a live control connection. */
  isHostOnline(hostId: string): boolean {
    return this.hosts.has(hostId)
  }

  /** Close the live control connection of a device (device revocation). */
  closeClientSessions(deviceId: string, code = CLOSE_REVOKED, reason = 'device revoked'): void {
    const connection = this.clients.get(deviceId)
    if (connection) this.abort(connection, code, reason)
  }

  /** Push a server-originated frame to a Host. */
  notifyHost(hostId: string, type: ControlFrameType, payload: unknown): boolean {
    const connection = this.hosts.get(hostId)
    return connection ? this.send(connection, this.makeFrame(type, payload)) : false
  }

  /** Close every control connection (graceful shutdown). */
  shutdown(): void {    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    for (const connection of [...this.hosts.values(), ...this.clients.values()]) {
      this.abort(connection, CLOSE_SHUTDOWN, SERVER_SHUTDOWN_CLOSE_REASON)
    }
    this.connections.clear()
    const wss = this.wss
    if (wss) {
      this.wss = null
      wss.close(() => undefined)
    }
    void CLOSE_GOING_AWAY
  }
}
