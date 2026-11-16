import type { HostRow, Repositories } from './repositories.js'
import { bearerToken, canonicalOrigin, parseCookies } from './security.js'
import type { Config } from './config.js'
import type { SessionService } from './sessions.js'
import type { SessionContext } from './sessions.js'
import { ApiError } from './errors.js'
import { hashToken } from './identity.js'

/**
 * Request authentication. Host CLI calls carry a bearer credential; browsers
 * carry the `dsh_session` cookie, which is bound to the canonical HTTPS origin.
 */
export class AuthService {
  constructor(
    private readonly repos: Repositories,
    private readonly config: Config,
    readonly sessions: SessionService,
  ) {}

  authenticateHostRequest(req: Parameters<typeof bearerToken>[0]): HostRow {
    const token = bearerToken(req)
    if (!token) throw ApiError.unauthorized('AUTH_REQUIRED', 'A Host credential is required.')
    const host = this.repos.findHostByCredentialHash(hashToken(token))
    if (!host) throw ApiError.unauthorized('AUTH_INVALID', 'The Host credential is not valid.')
    this.repos.touchHost(host.host_id, Date.now())
    return host
  }

  sessionFromRequest(req: Parameters<typeof bearerToken>[0]): SessionContext | null {
    const cookies = parseCookies(req)
    return this.sessions.resolve(cookies['dsh_session'] ?? null, canonicalOrigin(req, this.config))
  }

  requireSession(req: Parameters<typeof bearerToken>[0]): SessionContext {
    const context = this.sessionFromRequest(req)
    if (!context) throw ApiError.unauthorized('AUTH_REQUIRED', 'A device session cookie is required.')
    return context
  }

  /** Resolve a browser cookie value during a WSS upgrade. */
  sessionFromCookieValue(cookieHeader: string | undefined, origin: string): SessionContext | null {
    if (!cookieHeader) return null
    const cookies: Record<string, string> = {}
    for (const part of cookieHeader.split(';')) {
      const index = part.indexOf('=')
      if (index <= 0) continue
      const name = part.slice(0, index).trim()
      try {
        cookies[name] = decodeURIComponent(part.slice(index + 1).trim())
      } catch {
        cookies[name] = part.slice(index + 1).trim()
      }
    }
    return this.sessions.resolve(cookies['dsh_session'] ?? null, origin)
  }

  sessionFromToken(token: string, origin: string): SessionContext | null {
    return this.sessions.resolve(token, origin)
  }

  findHost(hostId: string): HostRow | undefined {
    return this.repos.findHostById(hostId)
  }

  findHostByDeviceId(deviceId: string): HostRow | undefined {
    return this.repos.findHostByDeviceId(deviceId)
  }
}
