import { resolve } from 'node:path'
import { CAPABILITY_VALUES, type Capability } from './contract.js'
import type { LogLevel } from './logger.js'

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export interface TurnConfig {
  /** `turn:`/`turns:` URLs advertised to clients. */
  urls: string[]
  /** Shared secret used for coturn REST HMAC credentials. Never logged. */
  secret: string
  ttlSeconds: number
}

export interface RateLimitRule {
  /** Sustained requests per second. */
  ratePerSecond: number
  /** Maximum burst. */
  burst: number
}

export interface Config {
  port: number
  bindHost: string
  dataDir: string
  databasePath: string
  webDir: string
  publicOrigin: string | null
  allowedOrigins: string[]
  trustProxy: boolean
  nodeName: string
  nodeVersion: string
  capabilities: Capability[]
  hostRegistrationToken: string | null
  pairingTicketTtlMs: number
  sessionTtlMs: number
  assetMaxBytes: number
  turn: TurnConfig | null
  helloTimeoutMs: number
  heartbeatIntervalMs: number
  heartbeatTimeoutMs: number
  maxConnectionsPerClient: number
  maxConnections: number
  logLevel: LogLevel
  limits: {
    http: RateLimitRule
    hostRegistration: RateLimitRule
    pairingCreate: RateLimitRule
    pairingClaim: RateLimitRule
    pairingDecision: RateLimitRule
    upgrade: RateLimitRule
    frames: RateLimitRule
  }
}

const MAX_PAIRING_TTL_MS = 5 * 60_000

function readString(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = readString(env, name)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigError(`${name} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = readString(env, name)
  if (raw === null) return fallback
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false
  throw new ConfigError(`${name} must be a boolean (1/0, true/false).`)
}

function readLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = readString(env, 'LOG_LEVEL')?.toLowerCase() ?? 'info'
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
  throw new ConfigError('LOG_LEVEL must be one of debug, info, warn, error.')
}

function readOrigin(env: NodeJS.ProcessEnv): string | null {
  const raw = readString(env, 'PUBLIC_ORIGIN')
  if (raw === null) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError('PUBLIC_ORIGIN must be an absolute URL such as https://remote.example.com.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError('PUBLIC_ORIGIN must use http or https.')
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new ConfigError('PUBLIC_ORIGIN must be an origin only (no path, query or fragment).')
  }
  return url.origin
}

function readAllowedOrigins(env: NodeJS.ProcessEnv): string[] {
  const raw = readString(env, 'ALLOWED_ORIGINS')
  if (raw === null) return []
  const origins: string[] = []
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      throw new ConfigError(`ALLOWED_ORIGINS entry "${trimmed}" is not an absolute URL.`)
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ConfigError(`ALLOWED_ORIGINS entry "${trimmed}" must use http or https.`)
    }
    origins.push(url.origin)
  }
  return origins
}

function readTurn(env: NodeJS.ProcessEnv): TurnConfig | null {
  const urlsRaw = readString(env, 'TURN_URLS')
  const secret = readString(env, 'TURN_SECRET')
  if (urlsRaw === null && secret === null) return null
  if (urlsRaw === null || secret === null) {
    throw new ConfigError('TURN_URLS and TURN_SECRET must be configured together.')
  }
  const urls = urlsRaw.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
  if (urls.length === 0) throw new ConfigError('TURN_URLS must contain at least one TURN URL.')
  for (const url of urls) {
    if (!/^turns?:[A-Za-z0-9.-]+(?::\d{1,5})?(?:\?.*)?$/u.test(url)) {
      throw new ConfigError(`TURN_URLS entry "${url}" must be a turn: or turns: URL.`)
    }
  }
  if (secret.length < 16) throw new ConfigError('TURN_SECRET must be at least 16 characters.')
  const ttlSeconds = readInt(env, 'TURN_TTL_SECONDS', 3600, 60, 86_400)
  return { urls, secret, ttlSeconds }
}

function readCapabilities(env: NodeJS.ProcessEnv, turn: TurnConfig | null): Capability[] {
  const raw = readString(env, 'CAPABILITIES')
  if (raw === null) {
    const defaults: Capability[] = ['pairing', 'cache', 'official-ui', 'relay']
    return turn ? [...defaults, 'turn'] : defaults
  }
  const values: Capability[] = []
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    if (!(CAPABILITY_VALUES as readonly string[]).includes(trimmed)) {
      throw new ConfigError(`CAPABILITIES entry "${trimmed}" is not one of ${CAPABILITY_VALUES.join(', ')}.`)
    }
    const capability = trimmed as Capability
    if (!values.includes(capability)) values.push(capability)
  }
  if (!values.includes('pairing')) throw new ConfigError('CAPABILITIES must include "pairing".')
  if (values.includes('turn') && !turn) {
    throw new ConfigError('CAPABILITIES includes "turn" but TURN_URLS/TURN_SECRET are not configured.')
  }
  if (turn && !values.includes('turn')) values.push('turn')
  return values
}

function readName(env: NodeJS.ProcessEnv): string {
  const raw = readString(env, 'NODE_NAME') ?? '我的公网节点'
  if ([...raw].length > 64) throw new ConfigError('NODE_NAME must be at most 64 characters.')
  return raw
}

function readVersion(env: NodeJS.ProcessEnv): string {
  const raw = readString(env, 'NODE_VERSION') ?? '0.6.0'
  if ([...raw].length > 64) throw new ConfigError('NODE_VERSION must be at most 64 characters.')
  return raw
}

/**
 * Build the runtime configuration from environment variables. Throws
 * `ConfigError` with an actionable message; the process exits non-zero.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(readString(env, 'DATA_DIR') ?? './data')
  const publicOrigin = readOrigin(env)
  const allowedOrigins = readAllowedOrigins(env)
  if (publicOrigin && !allowedOrigins.includes(publicOrigin)) allowedOrigins.unshift(publicOrigin)
  const turn = readTurn(env)
  const pairingTicketTtlMs = readInt(env, 'PAIRING_TICKET_TTL_SECONDS', 300, 30, 300) * 1_000
  if (pairingTicketTtlMs > MAX_PAIRING_TTL_MS) {
    throw new ConfigError('PAIRING_TICKET_TTL_SECONDS must not exceed 300.')
  }
  return {
    port: readInt(env, 'PORT', 8787, 0, 65_535),
    bindHost: readString(env, 'BIND_HOST') ?? '0.0.0.0',
    dataDir,
    databasePath: resolve(dataDir, 'remote-server.sqlite'),
    webDir: resolve(process.cwd(), readString(env, 'WEB_DIR') ?? 'web'),
    publicOrigin,
    allowedOrigins,
    trustProxy: readBoolean(env, 'TRUST_PROXY', false),
    nodeName: readName(env),
    nodeVersion: readVersion(env),
    capabilities: readCapabilities(env, turn),
    hostRegistrationToken: readString(env, 'HOST_REGISTRATION_TOKEN'),
    pairingTicketTtlMs,
    sessionTtlMs: readInt(env, 'SESSION_TTL_DAYS', 30, 1, 365) * 86_400_000,
    assetMaxBytes: readInt(env, 'ASSET_MAX_BYTES', 16 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    turn,
    helloTimeoutMs: readInt(env, 'HELLO_TIMEOUT_MS', 5_000, 100, 60_000),
    heartbeatIntervalMs: 25_000,
    heartbeatTimeoutMs: 75_000,
    maxConnectionsPerClient: readInt(env, 'MAX_CONNECTIONS_PER_CLIENT', 8, 1, 64),
    maxConnections: readInt(env, 'MAX_CONNECTIONS', 256, 1, 4096),
    logLevel: readLevel(env),
    limits: {
      http: { ratePerSecond: 20, burst: 200 },
      hostRegistration: { ratePerSecond: 0.2, burst: 10 },
      pairingCreate: { ratePerSecond: 0.5, burst: 30 },
      pairingClaim: { ratePerSecond: 0.5, burst: 30 },
      pairingDecision: { ratePerSecond: 1, burst: 60 },
      upgrade: { ratePerSecond: 0.5, burst: 30 },
      frames: { ratePerSecond: 500, burst: 1_500 },
    },
  }
}
