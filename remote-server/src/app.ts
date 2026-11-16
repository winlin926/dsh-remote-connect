import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { TUNNEL_PATH, type TunnelFrame } from '../../src/remote/tunnel-protocol.js'
import { AssetService } from './assets.js'
import { AuthService } from './auth.js'
import { loadConfig, type Config } from './config.js'
import { openDatabase, type Database } from './db.js'
import { ApiError, rateLimited } from './errors.js'
import { registerAssetRoutes } from './http/routes/assets.js'
import { registerDiscoveryRoutes } from './http/routes/discovery.js'
import { registerHostRoutes } from './http/routes/hosts.js'
import { registerLandingRoutes } from './http/routes/landing.js'
import { registerPairingRoutes } from './http/routes/pairings.js'
import { registerTurnRoutes } from './http/routes/turn.js'
import { Router } from './http/router.js'
import { sendError } from './http/util.js'
import { createLogger, type Logger } from './logger.js'
import { PairingService } from './pairing.js'
import type { ControlFrame } from './protocol.js'
import { RateLimiter } from './rate-limit.js'
import { Repositories } from './repositories.js'
import { clientIp, isWriteMethod, originAllowed } from './security.js'
import type { AppServices } from './services.js'
import { SessionService } from './sessions.js'
import { TunnelHub } from './tunnel/hub.js'
import { isNodeOwnedPath } from './tunnel/paths.js'
import { TunnelProxy } from './tunnel/proxy.js'
import { TurnService } from './turn.js'
import { ControlHub } from './wss/hub.js'

export interface CreateAppOptions {
  env?: NodeJS.ProcessEnv
  config?: Config
  logger?: Logger
}

export interface RemoteServerApp {
  readonly config: Config
  readonly logger: Logger
  readonly server: Server
  readonly db: Database
  readonly hub: ControlHub
  readonly services: AppServices
  /** Bind the HTTP server; resolves with the actual TCP address. */
  listen(port?: number, host?: string): Promise<AddressInfo>
  /** Graceful shutdown: control sockets, HTTP server, database. */
  close(): Promise<void>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

/**
 * Pairing pushes `ControlFrame`s even on a service node, which has no
 * `/v1/control`; mirror the three pairing frames onto the Host tunnel.
 */
function controlFrameToTunnelFrame(frame: ControlFrame): TunnelFrame | null {
  const payload = asRecord(frame.payload)
  if (!payload) return null
  switch (frame.type) {
    case 'pair.request': {
      const requestId = stringField(payload, 'requestId')
      const clientDeviceId = stringField(payload, 'clientDeviceId')
      const clientName = stringField(payload, 'clientName')
      const clientIdentityKey = stringField(payload, 'clientIdentityKey')
      const verificationCode = stringField(payload, 'verificationCode')
      const expiresAt = payload.expiresAt
      if (
        requestId === null ||
        clientDeviceId === null ||
        clientName === null ||
        clientIdentityKey === null ||
        verificationCode === null ||
        typeof expiresAt !== 'number'
      ) {
        return null
      }
      return { t: 'pair.request', requestId, clientDeviceId, clientName, clientIdentityKey, verificationCode, expiresAt }
    }
    case 'pair.complete': {
      const requestId = stringField(payload, 'requestId')
      const clientDeviceId = stringField(payload, 'clientDeviceId')
      const clientIdentityKey = stringField(payload, 'clientIdentityKey')
      if (requestId === null || clientDeviceId === null || clientIdentityKey === null) return null
      return { t: 'pair.complete', requestId, clientDeviceId, clientIdentityKey }
    }
    case 'pair.reject': {
      const requestId = stringField(payload, 'requestId')
      if (requestId === null) return null
      return { t: 'pair.reject', requestId }
    }
    default:
      return null
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  router: Router,
  services: AppServices,
): Promise<void> {
  const { config, logger, limiter } = services
  const method = req.method ?? 'GET'
  const head = method === 'HEAD'
  try {
    const ip = clientIp(req, config)
    const decision = limiter.take('http', ip, config.limits.http)
    if (!decision.allowed) throw rateLimited(decision.retryAfterMs)
    if (isWriteMethod(method) && !originAllowed(req, config)) {
      throw ApiError.forbidden('CROSS_ORIGIN_REJECTED', 'Cross-origin writes are not allowed.')
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      throw ApiError.badRequest('INVALID_URL', 'The request URL is not valid.')
    }
    // Everything outside the node's own namespace belongs to the paired Host:
    // including `/`, which serves the official DSH UI.
    if (!isNodeOwnedPath(url.pathname)) {
      const session = services.auth.sessionFromRequest(req)
      if (session) {
        await services.tunnelProxy.handleRequest(req, res, url, session)
        return
      }
    }
    const handled = await router.dispatch({ req, res, url, ip })
    if (handled) return
    if (isNodeOwnedPath(url.pathname)) {
      throw ApiError.notFound('NOT_FOUND', 'The requested resource does not exist.')
    }
    throw ApiError.unauthorized('AUTH_REQUIRED', '请先完成设备配对后再访问此节点。')
  } catch (error) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (!(error instanceof ApiError)) logger.error({ event: 'http.request.failed', method, error })
    sendError(res, error, head)
  }
}

/**
 * Assemble a running node: database (WAL SQLite), services, HTTP router, the
 * WSS control plane and the Host reverse tunnel. `listen` is intentionally
 * separate so tests and the CLI can share one code path.
 */
export async function createApp(options: CreateAppOptions = {}): Promise<RemoteServerApp> {
  const config = options.config ?? loadConfig(options.env ?? process.env)
  const logger = options.logger ?? createLogger(config.logLevel)
  const db = openDatabase(config.databasePath)
  const repos = new Repositories(db)
  const sessions = new SessionService(repos, config)
  const auth = new AuthService(repos, config, sessions)
  const pairing = new PairingService(repos, config, sessions)
  const assets = new AssetService(repos, config)
  const turn = new TurnService(config.turn)
  const limiter = new RateLimiter()
  const hub = new ControlHub({ config, logger, repos, sessions, auth, pairing, limiter })
  const tunnel = new TunnelHub({ config, logger, repos, auth, pairing })
  const tunnelProxy = new TunnelProxy({ config, logger, auth, repos, limiter, hub: tunnel })
  tunnel.addFrameHandler(tunnelProxy)

  // A service node has no `/v1/control`, so pairing notifications go to the
  // tunnel when the Host is connected there. The control hub keeps priority so
  // gateway deployments behave exactly as before.
  pairing.attach({
    isHostOnline: hostId => hub.isHostOnline(hostId) || tunnel.isHostOnline(hostId),
    sendToHost: (hostId, frame) => {
      if (hub.isHostOnline(hostId)) return hub.notifyHost(hostId, frame.type, frame.payload)
      if (tunnel.isHostOnline(hostId)) {
        const tunnelFrame = controlFrameToTunnelFrame(frame)
        if (tunnelFrame) return tunnel.sendHostFrame(hostId, tunnelFrame)
      }
      return false
    },
    sendToDevice: () => false,
    closeDeviceSessions: (deviceId, code, reason) => hub.closeClientSessions(deviceId, code, reason),
    closeHostConnections: () => undefined,
  })

  const services: AppServices = {
    config,
    logger,
    db,
    repos,
    sessions,
    auth,
    pairing,
    assets,
    turn,
    limiter,
    hub,
    tunnel,
    tunnelProxy,
  }

  const router = new Router()
  registerDiscoveryRoutes(router, services)
  registerLandingRoutes(router, services)
  registerHostRoutes(router, services)
  registerPairingRoutes(router, services)
  registerAssetRoutes(router, services)
  registerTurnRoutes(router, services)

  const server = createServer((req, res) => {
    void handleRequest(req, res, router, services)
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxRequestsPerSocket = 1_000

  const runUpgrade = (upgrade: Promise<void>): void => {
    void upgrade.catch(error => {
      logger.warn({ event: 'upgrade.failed', error })
    })
  }
  server.on('upgrade', (req, socket, head) => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      socket.destroy()
      return
    }
    if (pathname === TUNNEL_PATH) {
      runUpgrade(tunnel.handleUpgrade(req, socket, head))
      return
    }
    if (pathname === '/v1/control') {
      hub.handleUpgrade(req, socket, head)
      return
    }
    runUpgrade(tunnelProxy.handleUpgrade(req, socket, head))
  })

  await hub.attach(server)

  const sweepTimer = setInterval(() => {
    try {
      pairing.sweep()
    } catch (error) {
      logger.warn({ event: 'pairing.sweep.failed', error })
    }
  }, 60_000)
  sweepTimer.unref()

  let closed = false

  const listen = async (port = config.port, host = config.bindHost): Promise<AddressInfo> => {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(port, host, () => {
        server.off('error', onError)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('The server did not bind to a TCP address.')
    }
    return address
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    clearInterval(sweepTimer)
    tunnelProxy.shutdown()
    tunnel.shutdown()
    hub.shutdown()
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeIdleConnections()
      server.closeAllConnections()
    })
    db.close()
  }

  return { config, logger, server, db, hub, services, listen, close }
}
