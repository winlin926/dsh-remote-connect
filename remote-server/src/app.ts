import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { TUNNEL_PATH } from '../../src/remote/tunnel-protocol.js'
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
import { Router } from './http/router.js'
import { sendError } from './http/util.js'
import { createLogger, type Logger } from './logger.js'
import { loadOrCreateNodeIdentity, type NodeIdentity } from './node-identity.js'
import { PairingService } from './pairing.js'
import { RateLimiter } from './rate-limit.js'
import { Repositories } from './repositories.js'
import { clientIp, isWriteMethod, originAllowed } from './security.js'
import type { AppServices } from './services.js'
import { SessionService } from './sessions.js'
import { TunnelHub } from './tunnel/hub.js'
import { isNodeOwnedPath } from './tunnel/paths.js'
import { TunnelProxy } from './tunnel/proxy.js'

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
  readonly nodeIdentity: NodeIdentity
  readonly services: AppServices
  /** Bind the HTTP server; resolves with the actual TCP address. */
  listen(port?: number, host?: string): Promise<AddressInfo>
  /** Graceful shutdown: tunnel sockets, HTTP server, database. */
  close(): Promise<void>
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
 * Assemble a running node: database (WAL SQLite), services, the HTTP router and
 * the Host reverse tunnel. `listen` is intentionally separate so tests and the
 * CLI can share one code path.
 */
export async function createApp(options: CreateAppOptions = {}): Promise<RemoteServerApp> {
  const config = options.config ?? loadConfig(options.env ?? process.env)
  const logger = options.logger ?? createLogger(config.logLevel)
  // A service node has its own identity from the first start: it exists before
  // (and independently of) any Host registration, and never changes afterwards.
  const nodeIdentity = loadOrCreateNodeIdentity(config.dataDir)
  const db = openDatabase(config.databasePath)
  const repos = new Repositories(db)
  const sessions = new SessionService(repos, config)
  const auth = new AuthService(repos, config, sessions)
  const pairing = new PairingService(repos, config, sessions)
  const assets = new AssetService(repos, config)
  const limiter = new RateLimiter()
  const tunnel = new TunnelHub({ config, logger, repos, auth, pairing })
  const tunnelProxy = new TunnelProxy({ config, logger, auth, repos, limiter, hub: tunnel })
  tunnel.addFrameHandler(tunnelProxy)

  pairing.attach({
    isHostOnline: hostId => tunnel.isHostOnline(hostId),
    sendToHost: (hostId, frame) => tunnel.sendHostFrame(hostId, frame),
  })
  const services: AppServices = {
    config,
    logger,
    db,
    nodeIdentity,
    repos,
    sessions,
    auth,
    pairing,
    assets,
    limiter,
    tunnel,
    tunnelProxy,
  }

  const router = new Router()
  registerDiscoveryRoutes(router, services)
  registerLandingRoutes(router, services)
  registerHostRoutes(router, services)
  registerPairingRoutes(router, services)
  registerAssetRoutes(router, services)

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
    runUpgrade(tunnelProxy.handleUpgrade(req, socket, head))
  })

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
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeIdleConnections()
      server.closeAllConnections()
    })
    db.close()
  }

  return { config, logger, server, db, nodeIdentity, services, listen, close }
}
