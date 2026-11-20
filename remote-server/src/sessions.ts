import { createToken, hashToken } from './identity.js'
import type { Config } from './config.js'
import type { DeviceRow, DeviceSessionRow, Repositories } from './repositories.js'

export interface SessionContext {
  session: DeviceSessionRow
  device: DeviceRow
}

export interface IssuedSession {
  token: string
  expiresAt: number
}

/**
 * Browser sessions. The plaintext token lives only in the caller's cookie; the
 * database stores a SHA-256 hash plus the HTTPS origin it was issued for.
 */
export class SessionService {
  constructor(
    private readonly repos: Repositories,
    private readonly config: Config,
  ) {}

  issue(deviceId: string, boundOrigin: string, hostId: string, now = Date.now()): IssuedSession {
    const { token, hash } = createToken(32)
    const expiresAt = now + this.config.sessionTtlMs
    this.repos.insertSession({ credentialHash: hash, deviceId, boundOrigin, hostId, now, expiresAt })
    this.repos.touchSession(hash, now)
    return { token, expiresAt }
  }

  /** Resolve a session token for a request originating from `boundOrigin`. */
  resolve(token: string | null, boundOrigin: string, now = Date.now()): SessionContext | null {
    if (!token) return null
    const hash = hashToken(token)
    const session = this.repos.findSession(hash)
    if (!session) return null
    if (session.expires_at <= now) {
      this.repos.deleteSession(hash)
      return null
    }
    if (session.bound_origin !== boundOrigin) return null
    const device = this.repos.findDevice(session.device_id)
    if (!device) return null
    this.repos.touchSession(hash, now)
    this.repos.touchDevice(device.device_id, now)
    return { session, device }
  }

  /** Remove a single session (logout/revocation of one browser credential). */
  revokeToken(token: string): void {
    this.repos.deleteSession(hashToken(token))
  }

  /** Remove every browser session of a device (device revocation). */
  revokeDevice(deviceId: string): void {
    this.repos.deleteSessionsForDevice(deviceId)
  }
}
