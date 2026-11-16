import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { statSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { identityOfPublicKey } from '../src/host-identity.js'
import { SERVICE_NODES_FILE, ServiceNode, unregisterServiceNode, type ServiceNodeOptions } from '../src/service-node.js'
import { TUNNEL_FRAME_PAYLOAD_MAX, TUNNEL_PATH, decodeTunnelFrame, encodeTunnelFrame, type TunnelFrame } from '../src/remote/tunnel-protocol.js'

const cleanups: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

async function folder(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-rc-service-'))
  cleanups.push(() => rm(value, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return value
}

// The suite runs alongside every other file; a loaded machine must not turn a correct tunnel into a
// failure, so the helper waits longer than a lone run ever needs (the test timeout stays the cap).
async function waitFor<T>(read: () => T | undefined | false | null, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function toBuffer(data: unknown): Buffer {
  if (typeof data === 'string') return Buffer.from(data)
  if (Buffer.isBuffer(data)) return Buffer.from(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data.map(item => Buffer.isBuffer(item) ? item : Buffer.from(String(item))))
  return Buffer.from([])
}

/** The node end of one tunnel: decodes every binary frame the Host sends. */
class TunnelPeer {
  private readonly received: Array<{ frame: TunnelFrame; payload: Buffer; index: number }> = []
  private cursor = 0

  constructor(readonly socket: WebSocket, readonly authorization?: string) {
    socket.on('message', (data: unknown, isBinary: boolean) => {
      if (!isBinary) return
      try {
        const { frame, payload } = decodeTunnelFrame(toBuffer(data))
        this.received.push({ frame, payload: Buffer.from(payload), index: this.received.length })
      } catch { /* the Host only sends this module's frames; a decode failure fails the assertion below */ }
    })
  }

  send(frame: TunnelFrame, payload?: Uint8Array): void {
    this.socket.send(encodeTunnelFrame(frame, payload))
  }

  async waitFrame<T extends TunnelFrame['t']>(type: T, timeoutMs = 4000): Promise<{ frame: Extract<TunnelFrame, { t: T }>; payload: Buffer; index: number }> {
    return waitFor(() => {
      const found = this.received.slice(this.cursor).find(entry => entry.frame.t === type)
      if (!found) return undefined
      this.cursor = found.index + 1
      return { frame: found.frame as Extract<TunnelFrame, { t: T }>, payload: found.payload, index: found.index }
    }, `隧道帧 ${type}`, timeoutMs)
  }

  framesOf<T extends TunnelFrame['t']>(type: T): Array<{ frame: Extract<TunnelFrame, { t: T }>; payload: Buffer; index: number }> {
    return this.received.filter(entry => entry.frame.t === type).map(entry => ({ frame: entry.frame as Extract<TunnelFrame, { t: T }>, payload: entry.payload, index: entry.index }))
  }

  close(): void { try { this.socket.terminate() } catch { /* already closed */ } }
}

interface Registration { authorization: string | undefined; body: Record<string, unknown> }
interface RegistrationAnswer { status: number; json?: unknown }
interface Pairing { authorization: string | undefined; body: Record<string, unknown> }
interface Unregistration { authorization: string | undefined; method: string; path: string }

interface FakeNodeOptions {
  /** Answer for `POST /v1/hosts`; the default echoes the requested deviceId back as the host id. */
  register?: (body: Record<string, unknown>, attempt: number) => RegistrationAnswer
  /** Answer for `POST /v1/pairings`; the default issues a fresh ticket for this Host. */
  pairing?: (body: Record<string, unknown>, attempt: number) => RegistrationAnswer
  /** Answer for `DELETE /v1/hosts/:hostId`; the default forgets the Host with HTTP 204. */
  unregister?: (attempt: number) => RegistrationAnswer
  /** Answer for `GET /v1/tunnel`; false refuses the credential with HTTP 401. */
  authorize?: (req: IncomingMessage) => boolean
  tunnel?: (peer: TunnelPeer, index: number) => void
}

async function startFakeNode(options: FakeNodeOptions = {}) {
  const registrations: Registration[] = []
  const pairings: Pairing[] = []
  const unregistrations: Unregistration[] = []
  const tunnels: TunnelPeer[] = []
  let refusals = 0
  const sockets = new Set<WebSocket>()
  const server = createServer((req, res) => {
    if (req.method === 'DELETE' && req.url?.startsWith('/v1/hosts/')) {
      unregistrations.push({ authorization: req.headers.authorization, method: 'DELETE', path: req.url })
      const answer = options.unregister?.(unregistrations.length) ?? { status: 204 }
      if (answer.json === undefined) { res.writeHead(answer.status); res.end() }
      else { res.writeHead(answer.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer.json)) }
      return
    }
    if (req.method === 'POST' && req.url === '/v1/hosts') {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(toBuffer(chunk)))
      req.on('end', () => {
        let body: Record<string, unknown> = {}
        try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown> } catch { /* asserted by the test */ }
        registrations.push({ authorization: req.headers.authorization, body })
        const answer = options.register?.(body, registrations.length) ?? { status: 201, json: { credential: `credential-${registrations.length}`, host: { hostId: String(body.deviceId ?? '') } } }
        res.writeHead(answer.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answer.json ?? {}))
      })
      return
    }
    if (req.method === 'POST' && req.url === '/v1/pairings') {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(toBuffer(chunk)))
      req.on('end', () => {
        let body: Record<string, unknown> = {}
        try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown> } catch { /* asserted by the test */ }
        pairings.push({ authorization: req.headers.authorization, body })
        const answer = options.pairing?.(body, pairings.length) ?? { status: 201, json: { ticket: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 300_000 } }
        res.writeHead(answer.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answer.json ?? {}))
      })
      return
    }
    res.writeHead(404); res.end()
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    // A refused or torn-down upgrade leaves a raw socket behind; its reset must not become an unhandled error.
    socket.on('error', () => {})
    if (req.url !== TUNNEL_PATH) { socket.destroy(); return }
    if (options.authorize && !options.authorize(req)) {
      refusals += 1
      socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.add(ws)
      ws.on('error', () => {})
      ws.on('close', () => sockets.delete(ws))
      const peer = new TunnelPeer(ws, req.headers.authorization)
      tunnels.push(peer)
      options.tunnel?.(peer, tunnels.length)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('假节点没有监听端口。')
  cleanups.push(async () => {
    for (const ws of sockets) { try { ws.terminate() } catch { /* already gone */ } }
    wss.close(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return {
    origin: `http://127.0.0.1:${address.port}`,
    registrations,
    pairings,
    unregistrations,
    tunnels,
    refusals: () => refusals,
    waitTunnel: (count = 1, timeoutMs = 4000) => waitFor(() => tunnels[count - 1], `第 ${count} 条隧道`, timeoutMs),
  }
}

interface UpstreamHandled { method?: string; url: string; headers: IncomingMessage['headers']; body: Buffer }
interface UpstreamOptions {
  /** Inspect one completed request (body already read); return true when it wrote the response. */
  handle?: (req: IncomingMessage, res: ServerResponse, body: Buffer) => boolean | void
  onWs?: (ws: WebSocket, req: IncomingMessage) => void
}

async function startUpstream(options: UpstreamOptions = {}) {
  const requests: UpstreamHandled[] = []
  const wsSockets: WebSocket[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(toBuffer(chunk)))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      requests.push({ method: req.method, url: req.url ?? '', headers: req.headers, body })
      if (options.handle?.(req, res, body)) return
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    wss.handleUpgrade(req, socket, head, ws => {
      wsSockets.push(ws)
      ws.on('error', () => {})
      ws.on('close', () => { const index = wsSockets.indexOf(ws); if (index >= 0) wsSockets.splice(index, 1) })
      if (options.onWs) options.onWs(ws, req)
      else ws.on('message', (data: unknown, isBinary: boolean) => ws.send(toBuffer(data), { binary: isBinary }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  cleanups.push(async () => {
    for (const ws of wsSockets.splice(0)) { try { ws.terminate() } catch { /* already gone */ } }
    wss.close(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { port: address.port, requests, wsSockets, last: () => requests[requests.length - 1] }
}

function hostIdentity() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  const parsed = identityOfPublicKey(Buffer.from(der))
  return { identityKey: Buffer.from(der).toString('base64url'), hostId: parsed.hostId }
}

interface ServiceFixture {
  node: ServiceNode
  storage: string
  identity: ReturnType<typeof hostIdentity>
  start: () => Promise<ServiceNode>
}

function serviceNode(origin: string, storage: string, upstreamPort: number, overrides: Partial<ServiceNodeOptions> = {}): ServiceFixture {
  const identity = hostIdentity()
  const node = new ServiceNode({
    origin, storage, upstreamPort,
    hostId: identity.hostId,
    identityKey: identity.identityKey,
    clientVersion: '9.9.9',
    upstreamCookie: () => 'session=host-cookie-secret',
    reconnect: { baseDelayMs: 20, maxDelayMs: 60, jitter: () => 0 },
    ...overrides,
  })
  cleanups.push(() => node.stop())
  return { node, storage, identity, start: async () => { await node.start(); return node } }
}

describe('service node tunnel', () => {
  it('registers this Host, opens the tunnel and persists the credential', async () => {
    const storage = await folder()
    const fake = await startFakeNode()
    const upstream = await startUpstream()
    const fixture = serviceNode(fake.origin, storage, upstream.port)
    await fixture.start()

    await waitFor(() => fixture.node.status().connected, '隧道已连接')
    expect(fake.registrations).toHaveLength(1)
    expect(fake.registrations[0]?.body).toEqual({
      deviceId: fixture.identity.hostId,
      name: 'DeepSeek Harness',
      identityKey: fixture.identity.identityKey,
      clientVersion: '9.9.9',
    })
    expect(fake.registrations[0]?.authorization).toBeUndefined()

    const tunnel = await fake.waitTunnel()
    const hello = await tunnel.waitFrame('hello')
    expect(hello.frame).toMatchObject({ t: 'hello', hostId: fixture.identity.hostId, version: '9.9.9', capabilities: ['http', 'ws', 'assets'] })

    const file = join(storage, SERVICE_NODES_FILE)
    type SavedNodes = { version: number; nodes: Record<string, { credential: string; hostId: string; registeredAt: number; lastConnectedAt: number | null }> }
    // The bookkeeping save runs right after the tunnel opens. Read the file after a quiet window:
    // a reader racing the atomic rename makes Windows reject it with EPERM, and that one failure is
    // swallowed, so there is no later write to wait for.
    await new Promise(resolve => setTimeout(resolve, 500))
    const saved = JSON.parse(await readFile(file, 'utf8')) as SavedNodes
    expect(saved.version).toBe(1)
    expect(saved.nodes[fake.origin]?.credential).toBe('credential-1')
    expect(saved.nodes[fake.origin]?.hostId).toBe(fixture.identity.hostId)
    expect(typeof saved.nodes[fake.origin]?.lastConnectedAt).toBe('number')
    // Node on Windows cannot express POSIX modes; the mode is only meaningful elsewhere.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(fixture.node.status().lastError).toBeUndefined()
  })

  it('refuses a credential whose fingerprint is not this Host', async () => {
    const storage = await folder()
    const fake = await startFakeNode({
      register: () => ({ status: 201, json: { credential: 'somebody-elses-credential', host: { hostId: 'A'.repeat(43) } } }),
    })
    const upstream = await startUpstream()
    const fixture = serviceNode(fake.origin, storage, upstream.port)
    await fixture.start()

    const status = fixture.node.status()
    expect(status.connected).toBe(false)
    expect(status.lastError).toContain('节点返回的主机指纹与本机不一致')
    expect(fake.tunnels).toHaveLength(0)
    const file = join(storage, SERVICE_NODES_FILE)
    let saved: { nodes: Record<string, unknown> } = { nodes: {} }
    try { saved = JSON.parse(await readFile(file, 'utf8')) as { nodes: Record<string, unknown> } } catch { /* no file is the expected state */ }
    expect(saved.nodes[fake.origin]).toBeUndefined()
  })

  it('reuses the saved credential after a restart instead of registering twice', async () => {
    const storage = await folder()
    const fake = await startFakeNode()
    const upstream = await startUpstream()
    const first = serviceNode(fake.origin, storage, upstream.port)
    await first.start()
    await waitFor(() => first.node.status().connected, '第一次连接')
    await first.node.stop()

    const second = serviceNode(fake.origin, storage, upstream.port, { hostId: first.identity.hostId, identityKey: first.identity.identityKey })
    await second.start()
    await waitFor(() => second.node.status().connected, '第二次连接')
    expect(fake.registrations).toHaveLength(1)
    const tunnel = await fake.waitTunnel(2)
    expect(tunnel.authorization).toBe('Bearer credential-1')
  })

  it('reconnects with exponential backoff after the node drops the tunnel', async () => {
    const storage = await folder()
    const fake = await startFakeNode({ tunnel: (_peer, index) => { if (index === 1) setTimeout(() => fake.tunnels[0]?.close(), 10) } })
    const upstream = await startUpstream()
    const fixture = serviceNode(fake.origin, storage, upstream.port)
    await fixture.start()
    await waitFor(() => fixture.node.status().connected, '首次连接')
    const tunnel = await fake.waitTunnel(2, 3000)
    await waitFor(() => fixture.node.status().connected && tunnel.socket.readyState === WebSocket.OPEN, '重连成功')
    expect(fake.tunnels).toHaveLength(2)
  })

  it('forwards a POST body and rewrites the request headers for the loopback Host', async () => {
    const storage = await folder()
    const fake = await startFakeNode()
    const upstream = await startUpstream({ handle: (_req, res, body) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`size=${body.length}`); return true } })
    const fixture = serviceNode(fake.origin, storage, upstream.port)
    await fixture.start()
    await waitFor(() => fixture.node.status().connected, '隧道已连接')
    const tunnel = await fake.waitTunnel()

    tunnel.send({
      t: 'http.request', id: 'upload', method: 'POST', path: '/api/upload',
      headers: { host: 'device.example', cookie: 'device-cookie-secret', authorization: 'Bearer device-secret', 'x-dsh-device': 'secret', 'x-forwarded-for': '203.0.113.9', 'content-type': 'text/plain' },
    })
    tunnel.send({ t: 'http.body', id: 'upload' }, Buffer.from('hello'))
    tunnel.send({ t: 'http.body.end', id: 'upload' })

    const response = await tunnel.waitFrame('http.response')
    expect(response.frame).toMatchObject({ id: 'upload', status: 200 })
    const end = await tunnel.waitFrame('http.end')
    expect(end.frame).toMatchObject({ id: 'upload' })

    const request = await waitFor(() => upstream.requests[0], '上游收到请求')
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/api/upload')
    expect(request.body.toString()).toBe('hello')
    expect(request.headers.host).toBe(`127.0.0.1:${upstream.port}`)
    expect(request.headers.cookie).toBe('session=host-cookie-secret')
    expect(request.headers.origin).toBe(`http://127.0.0.1:${upstream.port}`)
    expect(request.headers['x-dsh-rc-remote']).toBe('1')
    expect(request.headers['sec-fetch-site']).toBe('same-origin')
    expect(request.headers['accept-encoding']).toBe('identity')
    expect(request.headers['x-dsh-device']).toBeUndefined()
    expect(request.headers.authorization).toBeUndefined()
    expect(request.headers['x-forwarded-for']).toBeUndefined()
  })

  it('streams a large response in bounded chunks and passes a 404 through', async () => {
    const storage = await folder()
    const fake = await startFakeNode()
    const big = Buffer.alloc(100_000, 7)
    const upstream = await startUpstream({
      handle: (req, res) => {
        if (req.url === '/big') {
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'set-cookie': ['a=1', 'b=2'] })
          res.write(big.subarray(0, 40_000)); res.write(big.subarray(40_000, 80_000)); res.end(big.subarray(80_000))
          return true
        }
        if (req.url === '/missing') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not here'); return true }
        return false
      },
    })
    const fixture = serviceNode(fake.origin, storage, upstream.port)
    await fixture.start()
    await waitFor(() => fixture.node.status().connected, '隧道已连接')
    const tunnel = await fake.waitTunnel()

    tunnel.send({ t: 'http.request', id: 'big', method: 'GET', path: '/big', headers: { accept: '*/*' } })
    tunnel.send({ t: 'http.body.end', id: 'big' })
    const response = await tunnel.waitFrame('http.response')
    expect(response.frame).toMatchObject({ id: 'big', status: 200 })
    expect(response.frame.headers['set-cookie']).toEqual(['a=1', 'b=2'])
    expect(response.frame.headers['transfer-encoding']).toBeUndefined()
    await tunnel.waitFrame('http.end')
    const chunks = tunnel.framesOf('http.chunk').filter(entry => entry.frame.id === 'big')
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.payload.length).toBeLessThanOrEqual(TUNNEL_FRAME_PAYLOAD_MAX)
    expect(Buffer.concat(chunks.map(chunk => chunk.payload)).equals(big)).toBe(true)

    tunnel.send({ t: 'http.request', id: 'missing', method: 'GET', path: '/missing', headers: {} })
    tunnel.send({ t: 'http.body.end', id: 'missing' })
    const missing = await tunnel.waitFrame('http.response')
    expect(missing.frame).toMatchObject({ id: 'missing', status: 404 })
  })

  it('streams server-sent events before the response ends', async () => {
    const storage = await folder()
    const fake = await startFakeNode()
    const upstream = await startUpstream({
      handle: (req, res) => {
        if (req.url !== '/events') return false
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: first\n\n')
        setTimeout(() => res.write('data: second\n\n'), 80)
        setTimeout(() => res.end(), 160)
        return true
      },
    })
    const fixture = serviceNode(fake.origin, storage, upstream.port)
    await fixture.start()
    await waitFor(() => fixture.node.status().connected, '隧道已连接')
    const tunnel = await fake.waitTunnel()

    tunnel.send({ t: 'http.request', id: 'sse', method: 'GET', path: '/events', headers: { accept: 'text/event-stream' } })
    tunnel.send({ t: 'http.body.end', id: 'sse' })
    const response = await tunnel.waitFrame('http.response')
    expect(response.frame).toMatchObject({ id: 'sse', status: 200 })
    const first = await tunnel.waitFrame('http.chunk')
    expect(first.payload.toString()).toContain('data: first')
    const end = await tunnel.waitFrame('http.end')
    expect(first.index).toBeLessThan(end.index)
  })

  it('proxies a WebSocket both ways and relays close frames', async () => {
    const storage = await folder()
    const fake = await startFakeNode()
    const closes: Array<{ code: number; reason: string }> = []
    const upstream = await startUpstream({
      onWs: ws => {
        ws.on('message', (data: unknown, isBinary: boolean) => ws.send(toBuffer(data), { binary: isBinary }))
        ws.on('close', (code: number, reason: Buffer) => closes.push({ code, reason: reason.toString('utf8') }))
      },
    })
    const fixture = serviceNode(fake.origin, storage, upstream.port)
    await fixture.start()
    await waitFor(() => fixture.node.status().connected, '隧道已连接')
    const tunnel = await fake.waitTunnel()

    tunnel.send({ t: 'ws.open', id: 'w1', path: '/ws', headers: { cookie: 'device-cookie-secret', 'x-dsh-device': 'secret' } })
    const ack = await tunnel.waitFrame('ws.ack')
    expect(ack.frame).toMatchObject({ id: 'w1', ok: true })

    tunnel.send({ t: 'ws.frame', id: 'w1', binary: false }, Buffer.from('text-ping'))
    const text = await tunnel.waitFrame('ws.frame')
    expect(text.frame).toMatchObject({ id: 'w1', binary: false })
    expect(text.payload.toString()).toBe('text-ping')

    tunnel.send({ t: 'ws.frame', id: 'w1', binary: true }, Buffer.from([1, 2, 3]))
    const binary = await tunnel.waitFrame('ws.frame')
    expect(binary.frame).toMatchObject({ id: 'w1', binary: true })
    expect([...binary.payload]).toEqual([1, 2, 3])

    tunnel.send({ t: 'ws.close', id: 'w1', code: 1000, reason: '节点关闭' })
    await waitFor(() => closes[0], '上游收到关闭帧')
    expect(closes[0]).toEqual({ code: 1000, reason: '节点关闭' })

    tunnel.send({ t: 'ws.open', id: 'w2', path: '/ws', headers: {} })
    const ack2 = await tunnel.waitFrame('ws.ack')
    expect(ack2.frame).toMatchObject({ id: 'w2', ok: true })
    await waitFor(() => upstream.wsSockets[0], '上游 WebSocket 已建立')
    upstream.wsSockets[0]?.close(4001, '上游关闭')
    const closed = await tunnel.waitFrame('ws.close')
    expect(closed.frame).toMatchObject({ id: 'w2', code: 4001, reason: '上游关闭' })
  })

  it('keeps pairing requests until this computer answers, then relays the answer', async () => {
    const storage = await folder()
    const fake = await startFakeNode()
    const upstream = await startUpstream()
    const fixture = serviceNode(fake.origin, storage, upstream.port)
    await fixture.start()
    await waitFor(() => fixture.node.status().connected, '隧道已连接')
    const tunnel = await fake.waitTunnel()

    const request = { t: 'pair.request' as const, requestId: 'pair-1', clientDeviceId: 'device-1', clientName: 'Pixel 9', clientIdentityKey: 'spki-key', verificationCode: '123456', expiresAt: Date.now() + 60_000 }
    tunnel.send(request)
    const pending = await waitFor(() => fixture.node.status().pendingPairings.find(entry => entry.requestId === 'pair-1'), '待批准配对')
    expect(pending.deviceName).toBe('Pixel 9')
    fixture.node.approvePairing('pair-1')
    const approve = await tunnel.waitFrame('pair.approve')
    expect(approve.frame).toMatchObject({ requestId: 'pair-1' })
    expect(fixture.node.status().pendingPairings).toEqual([])

    tunnel.send({ ...request, requestId: 'pair-2' })
    await waitFor(() => fixture.node.status().pendingPairings.find(entry => entry.requestId === 'pair-2'), '第二个待批准配对')
    fixture.node.rejectPairing('pair-2')
    const reject = await tunnel.waitFrame('pair.reject')
    expect(reject.frame).toMatchObject({ requestId: 'pair-2' })
    expect(fixture.node.status().pendingPairings).toEqual([])
  })

  it('never logs the credential or the Host cookie', async () => {
    const storage = await folder()
    const calls: Array<[string, Record<string, unknown>]> = []
    let reject = false
    const fake = await startFakeNode({ authorize: () => !reject })
    const upstream = await startUpstream()
    const fixture = serviceNode(fake.origin, storage, upstream.port, {
      log: (event, fields) => calls.push([event, fields]),
      reconnect: { baseDelayMs: 20, maxDelayMs: 60, jitter: () => 0 },
    })
    await fixture.start()
    await waitFor(() => fixture.node.status().connected, '隧道已连接')
    await fake.waitTunnel()
    await fixture.node.stop()

    // Restarting against a node that now rejects the saved credential exercises the failure path.
    reject = true
    await fixture.node.start()
    await waitFor(() => fixture.node.status().lastError, '失败原因出现')
    expect(fake.refusals()).toBeGreaterThanOrEqual(1)
    expect(fixture.node.status().lastError).toContain('节点拒绝了本机凭据')

    expect(calls.map(([event]) => event)).toContain('service-node-register')
    expect(calls.map(([event]) => event)).toContain('service-node-connect')
    const text = JSON.stringify(calls)
    expect(text).not.toContain('credential-1')
    expect(text).not.toContain('host-cookie-secret')
    expect(text).not.toContain('device-cookie-secret')
  })

  it('asks the node for a pairing ticket and builds the page URL from it', async () => {
    const storage = await folder()
    const ticket = randomBytes(32).toString('base64url')
    const expiresAt = 1_900_000_000_000
    const fake = await startFakeNode({ pairing: () => ({ status: 201, json: { ticket, expiresAt } }) })
    const upstream = await startUpstream()
    const fixture = serviceNode(fake.origin, storage, upstream.port)
    await fixture.start()
    await waitFor(() => fixture.node.status().connected, '隧道已连接')

    const issued = await fixture.node.issueTicket()
    expect(issued.expiresAt).toBe(expiresAt)
    const url = new URL(issued.url)
    expect(url.origin).toBe(fake.origin)
    const hash = new URLSearchParams(url.hash.slice(1))
    // The node's pairing page reads `v`, `ticket` and this Host's identity key from the hash.
    expect(hash.get('v')).toBe('1')
    expect(hash.get('ticket')).toBe(ticket)
    expect(hash.get('key')).toBe(fixture.identity.identityKey)
    expect(fake.pairings).toHaveLength(1)
    expect(fake.pairings[0]?.authorization).toBe('Bearer credential-1')
    expect(fake.pairings[0]?.body).toEqual({})
    expect(fixture.node.status().lastError).toBeUndefined()
  })

  it('reports a node that refuses to issue a pairing ticket and keeps the tunnel up', async () => {
    const storage = await folder()
    const fake = await startFakeNode({ pairing: () => ({ status: 500 }) })
    const upstream = await startUpstream()
    const fixture = serviceNode(fake.origin, storage, upstream.port)
    await fixture.start()
    await waitFor(() => fixture.node.status().connected, '隧道已连接')

    await expect(fixture.node.issueTicket()).rejects.toThrow('节点没有签发配对票据（HTTP 500）。')
    expect(fixture.node.status().lastError).toBe('节点没有签发配对票据（HTTP 500）。')
    expect(fixture.node.status().connected).toBe(true)
  })

  it('refuses a pairing ticket that does not match the node protocol', async () => {
    const storage = await folder()
    const fake = await startFakeNode({ pairing: () => ({ status: 201, json: { ticket: 'too-short', expiresAt: Date.now() + 60_000 } }) })
    const upstream = await startUpstream()
    const fixture = serviceNode(fake.origin, storage, upstream.port)
    await fixture.start()
    await waitFor(() => fixture.node.status().connected, '隧道已连接')

    await expect(fixture.node.issueTicket()).rejects.toThrow('节点返回的配对票据格式不正确。')
    expect(fixture.node.status().lastError).toBe('节点返回的配对票据格式不正确。')
  })

  it('deletes this Host registration on the node when unregistering', async () => {
    const storage = await folder()
    const fake = await startFakeNode()
    const upstream = await startUpstream()
    const fixture = serviceNode(fake.origin, storage, upstream.port)
    await fixture.start()
    await waitFor(() => fixture.node.status().connected, '隧道已连接')

    await fixture.node.unregister()
    expect(fake.unregistrations).toHaveLength(1)
    expect(fake.unregistrations[0]?.method).toBe('DELETE')
    expect(fake.unregistrations[0]?.authorization).toBe('Bearer credential-1')
    expect(fake.unregistrations[0]?.path).toBe(`/v1/hosts/${fixture.identity.hostId}`)
  })

  it('treats 404 as already unregistered and reports every other refusal', async () => {
    const upstream = await startUpstream()
    const gone = await startFakeNode({ unregister: () => ({ status: 404 }) })
    const goneFixture = serviceNode(gone.origin, await folder(), upstream.port)
    await goneFixture.start()
    await waitFor(() => goneFixture.node.status().connected, '隧道已连接')
    await expect(goneFixture.node.unregister()).resolves.toBeUndefined()
    expect(gone.unregistrations).toHaveLength(1)
    await goneFixture.node.stop()

    const refusing = await startFakeNode({ unregister: () => ({ status: 500 }) })
    const refusingFixture = serviceNode(refusing.origin, await folder(), upstream.port)
    await refusingFixture.start()
    await waitFor(() => refusingFixture.node.status().connected, '隧道已连接')
    await expect(refusingFixture.node.unregister()).rejects.toThrow('节点没有撤销主机注册（HTTP 500），节点上的注册可能仍在。')
  })

  it('unregisters a stored node without a running tunnel', async () => {
    const storage = await folder()
    const fake = await startFakeNode({ unregister: () => ({ status: 404 }) })
    const file = join(storage, SERVICE_NODES_FILE)
    writeFileSync(file, JSON.stringify({ version: 1, nodes: { [fake.origin]: { credential: 'stored-credential', hostId: 'A'.repeat(43), registeredAt: 1, lastConnectedAt: null } } }), { mode: 0o600 })

    // A credential saved for another identity must not delete this Host's registration.
    await unregisterServiceNode(storage, fake.origin, { hostId: 'B'.repeat(43) })
    expect(fake.unregistrations).toHaveLength(0)
    expect(JSON.parse(await readFile(file, 'utf8')).nodes[fake.origin]?.credential).toBe('stored-credential')

    await unregisterServiceNode(storage, fake.origin, { hostId: 'A'.repeat(43) })
    expect(fake.unregistrations).toHaveLength(1)
    expect(fake.unregistrations[0]?.authorization).toBe('Bearer stored-credential')
    expect(fake.unregistrations[0]?.path).toBe(`/v1/hosts/${'A'.repeat(43)}`)
    expect(JSON.parse(await readFile(file, 'utf8')).nodes[fake.origin]).toBeUndefined()

    // Nothing is saved any more, so a second call is a no-op.
    await unregisterServiceNode(storage, fake.origin)
    expect(fake.unregistrations).toHaveLength(1)
  })
})
