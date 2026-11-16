import type { IncomingMessage } from 'node:http'
import type { Config } from './config.js'

/** Best-effort client address; forwarded headers are only trusted with TRUST_PROXY=1. */
export function clientIp(req: IncomingMessage, config: Config): string {
  if (config.trustProxy) {
    const forwarded = firstHeaderValue(req.headers['x-forwarded-for'])
    if (forwarded) {
      const candidate = forwarded.split(',')[0]?.trim() ?? ''
      if (/^[0-9a-fA-F:.]{3,45}$/u.test(candidate)) return candidate
    }
  }
  return req.socket.remoteAddress ?? 'unknown'
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null
  const raw = Array.isArray(value) ? value[0] : value
  return raw !== undefined && raw.length > 0 ? raw : null
}

/** Canonical origin clients use to reach this node. */
export function canonicalOrigin(req: IncomingMessage, config: Config): string {
  if (config.publicOrigin) return config.publicOrigin
  const forwardedProto = config.trustProxy
    ? firstHeaderValue(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim()
    : undefined
  const proto = forwardedProto === 'https' ? 'https' : 'http'
  const forwardedHost = config.trustProxy
    ? firstHeaderValue(req.headers['x-forwarded-host'])?.split(',')[0]?.trim()
    : undefined
  const host = forwardedHost ?? firstHeaderValue(req.headers.host) ?? 'localhost'
  return `${proto}://${host}`
}

/**
 * Browser writes must come from the configured origin (or the request's own
 * origin in development). Requests without an `Origin` header are non-browser
 * clients (Host CLI, curl, health checks) and are allowed through.
 */
export function originAllowed(req: IncomingMessage, config: Config): boolean {
  const origin = firstHeaderValue(req.headers.origin)
  if (origin === null) return true
  if (config.allowedOrigins.includes(origin)) return true
  return origin === canonicalOrigin(req, config)
}

export function isWriteMethod(method: string | undefined): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = firstHeaderValue(req.headers.cookie)
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name.length === 0) continue
    try {
      cookies[name] = decodeURIComponent(value)
    } catch {
      cookies[name] = value
    }
  }
  return cookies
}

export interface CookieOptions {
  maxAgeSeconds?: number
  secure: boolean
  httpOnly: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
  path: string
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path}`]
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`)
  if (options.secure) parts.push('Secure')
  if (options.httpOnly) parts.push('HttpOnly')
  parts.push(`SameSite=${options.sameSite}`)
  return parts.join('; ')
}

/** Bearer token from the Authorization header, or null when absent/malformed. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = firstHeaderValue(req.headers.authorization)
  if (!header) return null
  const match = /^Bearer ([A-Za-z0-9_-]{16,8192})$/u.exec(header)
  return match ? match[1]! : null
}
