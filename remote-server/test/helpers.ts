import { randomBytes, randomUUID, createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  TUNNEL_PROTOCOL_VERSION,
  type TunnelFrame,
  type TunnelHelloFrame,
} from '../dist/src/remote/tunnel-protocol.js'
import { createApp } from '../dist/remote-server/src/app.js'

export interface TestNode {
  app: any
  baseUrl: string
  dataDir: string
  stop(): Promise<void>
}

export interface ApiResult {
  res: any
  status: number
  json: any
  text: string
  headers: any
  setCookies: string[]
}

/** Start an isolated node: temporary DATA_DIR, ephemeral port, error-only logs. */
export async function startNode(overrides: Record<string, string> = {}): Promise<TestNode> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-remote-server-test-'))
  const env: Record<string, string | undefined> = {
    ...process.env,
    PORT: '0',
    BIND_HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    LOG_LEVEL: 'error',
    HELLO_TIMEOUT_MS: '2000',
    ...overrides,
  }
  const app = await createApp({ env })
  const address = await app.listen()
  const baseUrl = `http://127.0.0.1:${address.port}`
  const node: TestNode = {
    app,
    baseUrl,
    dataDir,
    async stop() {
      await app.close()
      await rm(dataDir, { recursive: true, force: true })
    },
  }
  return node
}

/** JSON/HTTP helper with a bounded, uniformly shaped result. */
export async function api(
  baseUrl: string,
  method: string,
  path: string,
  options: {
    body?: unknown
    headers?: Record<string, string>
    token?: string
    cookie?: string
    origin?: string
    rawBody?: string | Uint8Array
    contentType?: string
  } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  if (options.cookie) headers.cookie = options.cookie
  if (options.origin) headers.origin = options.origin
  let body: any
  if (options.rawBody !== undefined) {
    body = options.rawBody
    headers['content-type'] = options.contentType ?? 'application/octet-stream'
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    headers['content-type'] = options.contentType ?? 'application/json'
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body })
  const text = await res.text()
  let json: any = null
  try {
    json = text.length > 0 ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return {
    res,
    status: res.status,
    json,
    text,
    headers: res.headers,
    setCookies: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [],
  }
}

/**
 * A real Base64URL(SPKI DER) identity key. Hosts publish the Ed25519 SPKI DER
 * from `src/host-identity.ts`; OAuth-style raw 32-byte keys are never accepted.
 */
export function randomIdentityKey(): string {
  const pair = generateKeyPairSync('ed25519')
  return pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
}

/** Opaque 32-byte Base64URL bearer token (not a public key). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

export function randomDeviceId(): string {
  return randomUUID()
}

/** Expected node-contract host identity, computed independently of the server. */
export function hostIdentityFromKey(identityKey: string): { hostId: string; fingerprint: string } {
  const der = Buffer.from(identityKey, 'base64url')
  const digest = createHash('sha256').update(der).digest()
  return { hostId: digest.toString('base64url'), fingerprint: digest.subarray(0, 16).toString('hex') }
}

/** Expected 8-digit verification code, computed independently of the server. */
export function verificationCodeFor(ticket: string, hostKey: string, clientKey: string): string {
  const transcript = `DSH-REMOTE-PAIR\0v=1\0${ticket}\0${hostKey}\0${clientKey}`
  const digest = createHash('sha256').update(transcript, 'utf8').digest()
  return String(digest.readUInt32BE(0) % 100_000_000).padStart(8, '0')
}

export function hostRegistration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceId: randomDeviceId(),
    name: '测试 Host',
    identityKey: randomIdentityKey(),
    clientVersion: '0.6.0-test',
    ...overrides,
  }
}

export interface RegisteredHost {
  registration: Record<string, any>
  credential: string
  host: any
}

export async function registerHost(
  node: TestNode,
  registration: Record<string, unknown> = hostRegistration(),
): Promise<RegisteredHost> {
  const result = await api(node.baseUrl, 'POST', '/v1/hosts', { body: registration })
  if (result.status !== 201) throw new Error(`host registration failed: ${result.status} ${result.text}`)
  return {
    registration: registration as Record<string, any>,
    credential: result.json.credential,
    host: result.json.host,
  }
}

export function parseSetCookie(raw: string): {
  name: string
  value: string
  attributes: string[]
  secure: boolean
  httpOnly: boolean
  sameSite: string | null
  maxAge: number | null
  path: string | null
} {
  const [pair, ...attributes] = raw.split(';').map(part => part.trim())
  const index = pair.indexOf('=')
  const name = pair.slice(0, index)
  const value = decodeURIComponent(pair.slice(index + 1))
  const attributeValue = (prefix: string): string | null => {
    for (const attribute of attributes) {
      const lower = attribute.toLowerCase()
      if (lower.startsWith(`${prefix}=`)) return attribute.slice(prefix.length + 1)
    }
    return null
  }
  const maxAge = attributeValue('max-age')
  return {
    name,
    value,
    attributes,
    secure: attributes.some(attribute => attribute.toLowerCase() === 'secure'),
    httpOnly: attributes.some(attribute => attribute.toLowerCase() === 'httponly'),
    sameSite: attributeValue('samesite'),
    maxAge: maxAge === null ? null : Number(maxAge),
    path: attributeValue('path'),
  }
}

export interface HostFrame {
  frame: TunnelFrame
  payload: Buffer
}

interface HostWaiter {
  match: (frame: TunnelFrame) => boolean
  resolve: (value: HostFrame) => void
  timer: NodeJS.Timeout
}

/** A stand-in for the desktop Host process speaking the binary tunnel protocol. */
export class TestHost {
  readonly received: HostFrame[] = []
  readonly ws: WebSocket
  private readonly waiters: HostWaiter[] = []
  private closeInfo: { code: number; reason: string } | null = null
  readonly closed: Promise<{ code: number; reason: string }>

  private readonly node: TestNode
  readonly hostId: string

  constructor(ws: WebSocket, node: TestNode, hostId: string) {
    this.ws = ws
    this.node = node
    this.hostId = hostId
    this.closed = new Promise(resolve => {
      ws.on('close', (code, reason) => {
        this.closeInfo = { code, reason: reason.toString() }
        resolve(this.closeInfo)
      })
    })
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      let decoded: ReturnType<typeof decodeTunnelFrame>
      try {
        decoded = decodeTunnelFrame(buffer)
      } catch {
        return
      }
      const entry: HostFrame = { frame: decoded.frame, payload: Buffer.from(decoded.payload) }
      if (entry.frame.t === 'ping') {
        void this.send({ t: 'pong', at: entry.frame.at })
        return
      }
      const waiter = this.waiters.find(candidate => candidate.match(entry.frame))
      if (waiter) {
        clearTimeout(waiter.timer)
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve(entry)
        return
      }
      this.received.push(entry)
    })
    ws.on('error', () => {
      // A socket error is always followed by close.
    })
  }

  static async connect(node: TestNode, host: RegisteredHost): Promise<TestHost> {
    const ws = new WebSocket(`${node.baseUrl.replace(/^http/u, 'ws')}/v1/tunnel`, {
      headers: { authorization: `Bearer ${host.credential}` },
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', (error: Error) => reject(error))
    })
    const testHost = new TestHost(ws, node, host.host.hostId)
    const hello: TunnelHelloFrame = {
      t: 'hello',
      hostId: host.host.hostId,
      version: TUNNEL_PROTOCOL_VERSION,
      capabilities: ['http', 'ws', 'assets'],
    }
    testHost.send(hello)
    const deadline = Date.now() + 5_000
    while (!node.app.services.tunnel.isHostOnline(host.host.hostId)) {
      if (Date.now() > deadline) throw new Error('the tunnel hello handshake did not complete')
      await delay(5)
    }
    return testHost
  }

  send(frame: TunnelFrame, payload?: Uint8Array): void {
    this.ws.send(encodeTunnelFrame(frame, payload))
  }

  count(type: string): number {
    return this.received.filter(entry => entry.frame.t === type).length
  }

  next(match: (frame: TunnelFrame) => boolean, timeoutMs = 5_000): Promise<HostFrame> {
    const index = this.received.findIndex(entry => match(entry.frame))
    if (index >= 0) {
      const [entry] = this.received.splice(index, 1)
      return Promise.resolve(entry!)
    }
    return new Promise((resolve, reject) => {
      const waiter: HostWaiter = {
        match,
        resolve,
        timer: setTimeout(() => {
          const pending = this.waiters.indexOf(waiter)
          if (pending >= 0) this.waiters.splice(pending, 1)
          const seen = [...new Set(this.received.map(entry => entry.frame.t))].join(',')
          reject(new Error(`timed out waiting for a tunnel frame (received: ${seen || 'none'})`))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  nextOfType(type: string, timeoutMs = 5_000): Promise<HostFrame> {
    return this.next(frame => frame.t === type, timeoutMs)
  }

  waitClose(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for the tunnel to close')), timeoutMs)
      void this.closed.then(info => {
        clearTimeout(timer)
        resolve(info)
      })
    })
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // Already closed.
    }
  }

  /** Wait until the node has dropped this Host's tunnel (its ws close event has been processed). */
  async waitOffline(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.node.app.services.tunnel.isHostOnline(this.hostId)) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the Host tunnel to go offline')
      await delay(5)
    }
  }

  terminate(): void {
    try {
      this.ws.terminate()
    } catch {
      // Already closed.
    }
  }
}

export interface PairedDevice {
  host: RegisteredHost
  hostClient: TestHost
  client: Record<string, any>
  claim: any
  poll: any
  cookie: string
  cookieParts: ReturnType<typeof parseSetCookie>
  sessionToken: string
  hostId: string
  hostDeviceId: string
  pairRequest: HostFrame
}

/**
 * Full QR pairing: register the Host, keep it online, claim the ticket, confirm
 * on the phone, approve on the desktop and collect the device cookie.
 */
export async function completePairing(
  node: TestNode,
  options: { clientOverrides?: Record<string, unknown> } = {},
): Promise<PairedDevice> {
  const host = await registerHost(node, hostRegistration())
  const hostClient = await TestHost.connect(node, host)

  const ticketResult = await api(node.baseUrl, 'POST', '/v1/pairings', { token: host.credential })
  if (ticketResult.status !== 201) throw new Error(`ticket creation failed: ${ticketResult.status} ${ticketResult.text}`)

  const client = {
    deviceId: randomDeviceId(),
    name: '测试手机',
    platform: 'ios',
    identityKey: randomIdentityKey(),
    ...(options.clientOverrides ?? {}),
  }
  const claim = await api(node.baseUrl, 'POST', '/v1/pairings/claim', {
    body: { ticket: ticketResult.json.ticket, client },
  })
  if (claim.status !== 201) throw new Error(`claim failed: ${claim.status} ${claim.text}`)
  const pairRequest = await hostClient.nextOfType('pair.request')

  const confirm = await api(node.baseUrl, 'POST', `/v1/pairings/${claim.json.requestId}/confirm`, {
    headers: { 'x-pairing-token': claim.json.pairingToken },
  })
  if (confirm.status !== 200) throw new Error(`confirm failed: ${confirm.status} ${confirm.text}`)

  hostClient.send({ t: 'pair.approve', requestId: claim.json.requestId })
  await hostClient.nextOfType('pair.complete')

  const poll = await api(node.baseUrl, 'GET', `/v1/pairings/${claim.json.requestId}`, {
    headers: { 'x-pairing-token': claim.json.pairingToken },
  })
  if (poll.status !== 200) throw new Error(`poll failed: ${poll.status} ${poll.text}`)
  const cookie = poll.setCookies[0]
  if (!cookie) throw new Error('pairing did not issue a device cookie')
  const cookieParts = parseSetCookie(cookie)

  return {
    host,
    hostClient,
    client,
    claim: claim.json,
    poll: poll.json,
    cookie,
    cookieParts,
    sessionToken: cookieParts.value,
    hostId: host.host.hostId,
    hostDeviceId: host.registration.deviceId,
    pairRequest,
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Raw HTTP request, needed when a test must control the `Host` header. */
export async function rawRequest(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: any; text: string }> {
  const { request } = await import('node:http')
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: { host: `127.0.0.1:${port}`, ...(options.headers ?? {}) },
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}
