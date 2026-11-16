import { randomBytes, randomUUID, createHash, createHmac, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
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
  registrationToken?: string,
): Promise<RegisteredHost> {
  const result = await api(node.baseUrl, 'POST', '/v1/hosts', {
    body: registration,
    headers: registrationToken ? { 'x-host-registration-token': registrationToken } : {},
  })
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

export interface ControlClient {
  ws: WebSocket
  /** Frames not yet consumed by `next`. */
  frames: any[]
  /** Every frame received, in arrival order (never consumed). */
  history: any[]
  send(type: string, payload?: unknown): void
  next(type: string, timeoutMs?: number): Promise<any>
  waitClose(timeoutMs?: number): Promise<{ code: number; reason: string }>
  close(): void
}

export interface ControlOptions {
  cookie?: string
  origin?: string
  /** Skip the hello handshake (used to test hello timeouts). */
  skipHello?: boolean
  hello?: Record<string, unknown>
}

/** Open a `/v1/control` WebSocket, perform hello and resolve on hello.ack. */
export async function connectControl(node: TestNode, hello: Record<string, unknown>, options: ControlOptions = {}): Promise<ControlClient> {
  const wsUrl = node.baseUrl.replace(/^http/u, 'ws') + '/v1/control'
  const headers: Record<string, string> = {}
  if (options.cookie) headers.cookie = options.cookie
  const ws = new WebSocket(wsUrl, { origin: options.origin ?? node.baseUrl, headers })
  const frames: any[] = []
  const history: any[] = []
  const waiters: Array<{ type: string; resolve: (frame: any) => void; reject: (error: Error) => void; timer: any }> = []
  let closeInfo: { code: number; reason: string } | null = null

  const settle = (frame: any): void => {
    for (const waiter of [...waiters]) {
      if (waiter.type !== frame.type) continue
      clearTimeout(waiter.timer)
      waiters.splice(waiters.indexOf(waiter), 1)
      const index = frames.indexOf(frame)
      if (index >= 0) frames.splice(index, 1)
      waiter.resolve(frame)
    }
  }

  ws.on('message', data => {
    let frame: any
    try {
      frame = JSON.parse(data.toString('utf8'))
    } catch {
      return
    }
    history.push(frame)
    frames.push(frame)
    settle(frame)
  })

  const closed = new Promise<{ code: number; reason: string }>(resolve => {
    ws.on('close', (code: number, reason: Buffer) => {
      closeInfo = { code, reason: reason.toString() }
      resolve(closeInfo)
    })
  })

  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', (error: Error) => reject(error))
    ws.once('unexpected-response', (_request: any, response: any) => {
      reject(Object.assign(new Error(`upgrade rejected with ${response.statusCode}`), { statusCode: response.statusCode }))
    })
  })
  await opened

  const client: ControlClient = {
    ws,
    frames,
    history,
    send(type: string, payload: unknown = {}) {
      ws.send(JSON.stringify({ v: 1, id: randomUUID(), type, timestamp: Date.now(), payload }))
    },
    next(type: string, timeoutMs = 5_000) {
      const existing = frames.find(frame => frame.type === type)
      if (existing) {
        frames.splice(frames.indexOf(existing), 1)
        return Promise.resolve(existing)
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          type,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            reject(new Error(`timed out waiting for frame "${type}" (received: ${frames.map(frame => frame.type).join(',')})`))
          }, timeoutMs),
        }
        waiters.push(waiter)
      })
    },
    waitClose(timeoutMs = 5_000) {
      if (closeInfo) return Promise.resolve(closeInfo)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs)
        void closed.then(info => {
          clearTimeout(timer)
          resolve(info)
        })
      })
    },
    close() {
      try {
        ws.close()
      } catch {
        // Already closed.
      }
    },
  }

  if (!options.skipHello) {
    ws.send(JSON.stringify(hello))
    await client.next('hello.ack')
  }
  return client
}

export function hostHello(node: TestNode, host: RegisteredHost, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: randomUUID(),
    type: 'hello',
    timestamp: Date.now(),
    payload: {
      role: 'host',
      deviceId: host.registration.deviceId,
      accessToken: host.credential,
      protocols: [1],
      capabilities: ['relay'],
      clientVersion: '0.6.0-test',
      ...overrides,
    },
  }
}

export function clientHello(node: TestNode, deviceId: string, sessionToken: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: randomUUID(),
    type: 'hello',
    timestamp: Date.now(),
    payload: {
      role: 'client',
      deviceId,
      accessToken: sessionToken,
      protocols: [1],
      capabilities: ['relay'],
      clientVersion: '0.6.0-test',
      ...overrides,
    },
  }
}

export async function connectHost(node: TestNode, host: RegisteredHost): Promise<ControlClient> {
  return connectControl(node, hostHello(node, host))
}

export async function connectClient(node: TestNode, deviceId: string, sessionToken: string): Promise<ControlClient> {
  return connectControl(node, clientHello(node, deviceId, sessionToken))
}

export interface PairedDevice {
  host: RegisteredHost
  hostClient: ControlClient
  client: Record<string, any>
  claim: any
  poll: any
  cookie: string
  cookieParts: ReturnType<typeof parseSetCookie>
  sessionToken: string
  hostId: string
  hostDeviceId: string
}

/**
 * Full QR pairing: register the Host, keep it online, claim the ticket, confirm
 * on the phone, approve on the desktop and collect the device cookie.
 */
export async function completePairing(
  node: TestNode,
  options: { registrationToken?: string; clientOverrides?: Record<string, unknown> } = {},
): Promise<PairedDevice> {
  const host = await registerHost(node, hostRegistration(), options.registrationToken)
  const hostClient = await connectHost(node, host)

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
  const pairRequest = await hostClient.next('pair.request')

  const confirm = await api(node.baseUrl, 'POST', `/v1/pairings/${claim.json.requestId}/confirm`, {
    headers: { 'x-pairing-token': claim.json.pairingToken },
  })
  if (confirm.status !== 200) throw new Error(`confirm failed: ${confirm.status} ${confirm.text}`)

  hostClient.send('pair.approve', { requestId: claim.json.requestId })
  await hostClient.next('pair.complete')

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

export function turnCredential(secret: string, username: string): string {
  return createHmac('sha1', secret).update(username).digest('base64')
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
