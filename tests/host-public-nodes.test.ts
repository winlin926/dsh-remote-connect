import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as Plugin from '../src/index.js'
import { Gateway, MANAGE_PATH } from '../src/gateway.js'
import { TUNNEL_PATH } from '../src/remote/tunnel-protocol.js'
import { identityOfPublicKey } from '../src/host-identity.js'
import type { PublicNodeIdentity } from '../src/public-node.js'
import { randomBytes, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'

const OWNER = { principal: { kind: 'owner' } } as Connection.PeerScope

interface Harness { command: (action: string, fields?: Record<string, unknown>) => Promise<any>; ctx: Context; storage: string; folder: string }

/** The Host names its profile; store the fixture under the same directory the plugin will use. */
function storageOf(folder: string): string { return join(folder, 'dsh-remote-connect', String(process.env.DSH_PROFILE || 'default')) }

async function withHost(run: (harness: Harness) => Promise<void>, prepare?: (storage: string) => void): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-rc-nodes-')), previous = process.env.DSH_HOME
  process.env.DSH_HOME = folder
  const storage = storageOf(folder)
  mkdirSync(storage, { recursive: true })
  prepare?.(storage)
  const ctx = new Context(); let record: unknown
  const removeCredentials = ctx.provide('credentials', { modifyRecord: async (_key: unknown, update: (value: unknown) => Promise<unknown>) => { const next = await update(record); if (next !== undefined) record = next; return record } })
  try {
    await ctx.plugin(Connection, {})
    await ctx.plugin(Plugin, { certificateDir: join(folder, 'certificates') })
    const command = async (action: string, fields: Record<string, unknown> = {}): Promise<any> => {
      const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://desktop.internal' + MANAGE_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...fields }) }), OWNER)
      const data = await response.json()
      return { ...data, status: response.status }
    }
    await vi.waitFor(async () => expect((await command('status')).status).toBe(200))
    await run({ command, ctx, storage, folder })
  } finally {
    ctx.registry.delete(Plugin); ctx.registry.delete(Connection); await new Promise(resolve => setTimeout(resolve, 100)); await removeCredentials(); vi.restoreAllMocks()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    rmSync(folder, { recursive: true, force: true })
  }
}

/** A real Ed25519 key is the only way to build a protocol-2 node identity the plugin will trust. */
function nodeIdentity(): PublicNodeIdentity {
  const der = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' })
  const derived = identityOfPublicKey(der)
  return { id: derived.hostId, fingerprint: derived.fingerprint, publicKey: der.toString('base64url') }
}
const NODE_A = nodeIdentity()
const NODE_B = nodeIdentity()

interface DiscoveryOptions { kind?: 'gateway' | 'service'; name?: string; version?: string; identity?: PublicNodeIdentity }
/** The protocol-2 document a node serves: the node identity plus the flat aliases ≤0.5.0 clients read. */
function discovery(options: DiscoveryOptions = {}): Response {
  const node = options.identity ?? NODE_A
  return Response.json({
    protocol: 2,
    kind: options.kind ?? 'service',
    name: options.name ?? '测试公网节点',
    version: options.version ?? '1.2.3',
    capabilities: ['pairing', 'cache'],
    node,
    hostId: node.id,
    fingerprint: node.fingerprint,
  })
}
/** A node that never upgraded still answers protocol 1 with the flat identity only. */
function legacyDiscovery(options: { kind?: 'gateway' | 'service'; name?: string; version?: string; hostId?: string; fingerprint?: string } = {}): Response {
  return Response.json({
    protocol: 1,
    kind: options.kind ?? 'gateway',
    name: options.name ?? '旧版公网节点',
    version: options.version ?? '0.5.1',
    capabilities: ['pairing', 'cache'],
    hostId: options.hostId ?? 'A'.repeat(43),
    fingerprint: options.fingerprint ?? 'a'.repeat(32),
  })
}
/** detectPublicNode uses the process-wide fetch; the suite stubs it instead of starting an HTTPS node. */
function stubDiscovery(handler: (url: string) => Response): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => handler(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url))
}

interface FakeServiceNode {
  origin: string
  pairings: Array<{ authorization: string | undefined; body: Record<string, unknown> }>
  tickets: string[]
  unregistrations: Array<{ authorization: string | undefined; method: string; path: string }>
  close: () => Promise<void>
}

/** A real HTTPS node: the Host registers there, opens the tunnel and asks it for pairing tickets. */
async function startFakeServiceNode(options: { pairing?: (attempt: number) => { status: number; json?: unknown }; unregister?: (attempt: number) => { status: number; json?: unknown } } = {}): Promise<FakeServiceNode> {
  const key = readFileSync(new URL('./fixtures/lan-tls/key-1.pem', import.meta.url))
  const cert = readFileSync(new URL('./fixtures/lan-tls/server.pem', import.meta.url))
  const pairings: FakeServiceNode['pairings'] = []
  const tickets: string[] = []
  const unregistrations: FakeServiceNode['unregistrations'] = []
  let registrations = 0
  const server = createHttpsServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown> } catch { /* an empty body is valid */ }
      if (req.method === 'POST' && req.url === '/v1/hosts') {
        registrations += 1
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ credential: `node-credential-${registrations}`, host: { hostId: String(body.deviceId ?? '') } }))
        return
      }
      if (req.method === 'POST' && req.url === '/v1/pairings') {
        pairings.push({ authorization: req.headers.authorization, body })
        const ticket = randomBytes(32).toString('base64url')
        tickets.push(ticket)
        const answer = options.pairing?.(pairings.length) ?? { status: 201, json: { ticket, expiresAt: Date.now() + 300_000 } }
        res.writeHead(answer.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answer.json ?? {}))
        return
      }
      if (req.method === 'DELETE' && req.url && req.url.startsWith('/v1/hosts/')) {
        unregistrations.push({ authorization: req.headers.authorization, method: 'DELETE', path: req.url })
        const answer = options.unregister?.(unregistrations.length) ?? { status: 204 }
        if (answer.json === undefined) { res.writeHead(answer.status); res.end() }
        else { res.writeHead(answer.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer.json)) }
        return
      }
      res.writeHead(404); res.end()
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  const sockets = new Set<WebSocket>()
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    if (req.url !== TUNNEL_PATH) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, ws => { sockets.add(ws); ws.on('error', () => {}); ws.on('close', () => sockets.delete(ws)) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('假节点没有监听端口。')
  return {
    origin: `https://127.0.0.1:${address.port}`,
    pairings,
    tickets,
    unregistrations,
    close: async () => {
      for (const ws of sockets) { try { ws.terminate() } catch { /* already gone */ } }
      wss.close(); server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/**
 * This suite runs a self-signed loopback node; the TLS check is relaxed for that test only. A real
 * service node is reached over its own valid HTTPS certificate.
 */
function allowSelfSignedTls(): () => void {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  return () => { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous }
}

/** Discovery probes stay stubbed; every other request reaches the loopback node. */
function stubDiscoveryAndNetwork(): void {
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/.well-known/dsh-remote')) return discovery()
    return realFetch(input, init)
  })
}

it('migrates the old public URL into a pending candidate, never into the current node', () => withHost(async ({ command }) => {
  const state = await command('status')
  expect(state.publicUrl).toBe('https://old.example.com')
  expect(state.publicNodes).toMatchObject({ current: null, pendingReview: true })
  expect(state.publicNodes.list).toHaveLength(1)
  expect(state.publicNodes.list[0]).toMatchObject({ url: 'https://old.example.com', kind: null, pending: true })
}, storage => writeFileSync(join(storage, 'public-url.json'), JSON.stringify({ publicUrl: 'https://old.example.com' }))))

it('refuses to store a node that cannot be detected or is not HTTPS', () => withHost(async ({ command, storage }) => {
  stubDiscovery(() => new Response('busy', { status: 503 }))
  const failed = await command('addPublicNode', { url: 'https://down.example.com' })
  expect(failed).toMatchObject({ status: 200, ok: false })
  expect(failed.message).toBe('节点发现接口返回 HTTP 503。')
  // Nothing was persisted, so a later retry is judged only by the probe.
  expect((await command('status')).publicNodes).toEqual({ current: null, list: [], pendingReview: false })
  expect(existsSync(join(storage, 'public-nodes.json'))).toBe(false)
  const insecure = await command('addPublicNode', { url: 'http://plain.example.com' })
  expect(insecure).toMatchObject({ status: 200, ok: false })
  expect(insecure.message).toBe('公网节点必须使用 https:// 地址。')
  const empty = await command('addPublicNode', {})
  expect(empty).toMatchObject({ status: 400, error: '请填写公网节点地址。' })
}))

it('adds a detected service node, refuses duplicates, and shows it as the connecting current node', () => withHost(async ({ command, storage }) => {
  stubDiscovery(() => discovery())
  const added = await command('addPublicNode', { url: 'https://service.example.com' })
  expect(added).toMatchObject({ status: 200, ok: true })
  expect(added.node).toMatchObject({ url: 'https://service.example.com', kind: 'service', name: '测试公网节点', version: '1.2.3', protocol: 2, node: NODE_A, hostId: null, fingerprint: null, pending: false, lastCheckOk: true, identityChange: null })
  const stored = JSON.parse(readFileSync(join(storage, 'public-nodes.json'), 'utf8'))
  expect(stored).toMatchObject({ version: 2, current: null })
  expect(stored.nodes).toHaveLength(1)
  expect(stored.nodes[0]).toMatchObject({ protocol: 2, node: NODE_A, hostId: null, fingerprint: null })
  const duplicate = await command('addPublicNode', { url: 'https://service.example.com' })
  expect(duplicate).toMatchObject({ status: 200, ok: false, message: '该公网节点已存在。' })
  const state = await command('status')
  expect(state.publicNodes).toMatchObject({ current: null, pendingReview: false })
  expect(state.publicNodes.list).toHaveLength(1)
  // A service node is not connected before the public entry is opened; the panel still names it.
  expect(state.serviceNode).toBeNull()
  expect(state.phase).toBe('off')
}))

it('re-checks a node and records both the successful and the failed probe', () => withHost(async ({ command }) => {
  stubDiscovery(() => discovery({ kind: 'gateway', version: '1.0.0' }))
  const added = await command('addPublicNode', { url: 'https://gateway.example.com' })
  stubDiscovery(() => discovery({ kind: 'gateway', version: '2.0.0' }))
  const checked = await command('checkPublicNode', { id: added.node.id })
  expect(checked).toMatchObject({ status: 200, ok: true })
  expect(checked.node).toMatchObject({ version: '2.0.0', lastCheckOk: true, lastCheckError: null, pending: false })
  expect(checked.node.lastCheckAt).toEqual(expect.any(Number))
  stubDiscovery(() => new Response('down', { status: 502 }))
  const failed = await command('checkPublicNode', { id: added.node.id })
  expect(failed).toMatchObject({ status: 200, ok: false, message: '节点发现接口返回 HTTP 502。' })
  const listed = (await command('status')).publicNodes.list
  expect(listed).toHaveLength(1)
  expect(listed[0]).toMatchObject({ lastCheckOk: false, lastCheckError: '节点发现接口返回 HTTP 502。', version: '2.0.0' })
  expect(await command('checkPublicNode', { id: 'missing' })).toMatchObject({ status: 400, error: '公网节点不存在。' })
}))

it('still adds a protocol-1 node and records its flat identity', () => withHost(async ({ command, storage }) => {
  stubDiscovery(() => legacyDiscovery({ kind: 'gateway' }))
  const added = await command('addPublicNode', { url: 'https://old.example.com' })
  expect(added).toMatchObject({ status: 200, ok: true })
  expect(added.node).toMatchObject({ protocol: 1, node: null, hostId: 'A'.repeat(43), fingerprint: 'a'.repeat(32), kind: 'gateway', pending: false })
  const stored = JSON.parse(readFileSync(join(storage, 'public-nodes.json'), 'utf8'))
  expect(stored).toMatchObject({ version: 2, current: null })
  expect(stored.nodes[0]).toMatchObject({ node: null, hostId: 'A'.repeat(43), fingerprint: 'a'.repeat(32) })
}))

it('adopts the first node identity silently and records a later change as a blocked state', () => withHost(async ({ command }) => {
  stubDiscovery(() => discovery())
  const added = await command('addPublicNode', { url: 'https://service.example.com' })
  expect(added.node).toMatchObject({ protocol: 2, node: NODE_A, hostId: null, fingerprint: null, identityChange: null })
  // Re-checking against the same identity is a plain successful probe, not a review request.
  const checked = await command('checkPublicNode', { id: added.node.id })
  expect(checked).toMatchObject({ status: 200, ok: true })
  expect(checked.node).toMatchObject({ protocol: 2, node: NODE_A, lastCheckOk: true })
  stubDiscovery(() => discovery({ identity: NODE_B }))
  const changed = await command('checkPublicNode', { id: added.node.id })
  expect(changed).toMatchObject({ status: 200, ok: false, message: '节点身份已变化，需要重新确认。' })
  const listed = (await command('status')).publicNodes.list[0]
  expect(listed).toMatchObject({ node: NODE_A, protocol: 2, hostId: null, fingerprint: null, lastCheckOk: false, lastCheckError: '节点身份已变化，需要重新确认。', identityChange: { from: NODE_A, to: NODE_B } })
  expect(listed.identityChange.detectedAt).toEqual(expect.any(Number))
  // A second probe must not rotate the stored identity: the user decides from the panel.
  expect((await command('checkPublicNode', { id: added.node.id })).message).toBe('公网节点的身份已变化，请先在面板确认。')
  expect((await command('status')).publicNodes.list[0].node).toEqual(NODE_A)
}))

it('blocks a current node whose identity changed until the panel confirms it', () => withHost(async ({ command }) => {
  stubDiscovery(() => discovery())
  const added = await command('addPublicNode', { url: 'https://service.example.com' })
  await command('setCurrentPublicNode', { id: added.node.id })
  await command('preferences', { mode: 'public' })
  stubDiscovery(() => discovery({ identity: NODE_B }))
  await command('checkPublicNode', { id: added.node.id })
  const blocked = await command('status')
  expect(blocked).toMatchObject({
    phase: 'error', links: [],
    error: '公网节点的身份已变化，请先在面板确认。', lastError: '公网节点的身份已变化，请先在面板确认。',
  })
  expect(blocked.qr).toBeUndefined()
  expect(blocked.serviceNode).toMatchObject({ connected: false })
  expect(blocked.expiresAt).toBeUndefined()
  expect(await command('refresh')).toMatchObject({ status: 400, error: '公网节点的身份已变化，请先在面板确认。' })
  expect(await command('start')).toMatchObject({ status: 400, error: '公网节点的身份已变化，请先在面板确认。' })
  expect(await command('setCurrentPublicNode', { id: added.node.id })).toMatchObject({ status: 400, error: '公网节点的身份已变化，请先在面板确认。' })
  // Confirming adopts the identity the node presents now; the next probe agrees and the block clears.
  stubDiscovery(() => discovery({ identity: NODE_B }))
  const confirmed = await command('confirmPublicNodeIdentity', { id: added.node.id })
  expect(confirmed).toMatchObject({ status: 200, ok: true })
  expect(confirmed.node).toMatchObject({ protocol: 2, node: NODE_B, identityChange: null, lastCheckOk: true })
  const recovered = await command('status')
  expect(recovered.publicNodes.list[0]).toMatchObject({ node: NODE_B, identityChange: null, lastCheckOk: true })
  expect(recovered.error).toBeUndefined()
  expect(recovered.phase).toBe('off')
}))

it('keeps a confirmed identity when the follow-up probe fails', () => withHost(async ({ command }) => {
  stubDiscovery(() => discovery())
  const added = await command('addPublicNode', { url: 'https://service.example.com' })
  stubDiscovery(() => discovery({ identity: NODE_B }))
  await command('checkPublicNode', { id: added.node.id })
  stubDiscovery(() => new Response('down', { status: 503 }))
  const confirmed = await command('confirmPublicNodeIdentity', { id: added.node.id })
  expect(confirmed).toMatchObject({ status: 200, ok: true })
  expect(confirmed.node).toMatchObject({ node: NODE_B, identityChange: null, lastCheckOk: false, lastCheckError: '节点发现接口返回 HTTP 503。' })
  expect((await command('status')).publicNodes.list[0].node).toEqual(NODE_B)
}))

it('does not accept a protocol-1 answer for a node that already proved protocol 2', () => withHost(async ({ command }) => {
  stubDiscovery(() => discovery())
  const added = await command('addPublicNode', { url: 'https://service.example.com' })
  stubDiscovery(() => legacyDiscovery({ kind: 'service' }))
  const downgraded = await command('checkPublicNode', { id: added.node.id })
  expect(downgraded).toMatchObject({ status: 200, ok: false, message: '节点已降级为旧版协议，需要重新检测。' })
  const listed = (await command('status')).publicNodes.list[0]
  expect(listed).toMatchObject({ protocol: 2, node: NODE_A, hostId: null, fingerprint: null, lastCheckOk: false, lastCheckError: '节点已降级为旧版协议，需要重新检测。', identityChange: null })
}))

it('switches the current gateway node and keeps PublicAccess on the same domain', () => withHost(async ({ command, storage }) => {
  stubDiscovery(() => discovery({ kind: 'gateway' }))
  const first = await command('addPublicNode', { url: 'https://first.example.com' })
  const second = await command('addPublicNode', { url: 'https://second.example.com' })
  const selected = await command('setCurrentPublicNode', { id: first.node.id })
  expect(selected.publicNodes.current).toBe(first.node.id)
  expect(selected.publicUrl).toBe('https://first.example.com')
  expect(JSON.parse(readFileSync(join(storage, 'public-url.json'), 'utf8'))).toMatchObject({ publicUrl: 'https://first.example.com' })
  const changed = await command('setCurrentPublicNode', { id: second.node.id })
  expect(changed.publicNodes.current).toBe(second.node.id)
  expect(changed.publicUrl).toBe('https://second.example.com')
  expect(changed.phase).toBe('off')
  expect(await command('setCurrentPublicNode', { id: 'missing' })).toMatchObject({ status: 400, error: '公网节点不存在。' })
}))

it('restarts a running public connection when a gateway node replaces the current one', () => withHost(async ({ command }) => {
  stubDiscovery(() => discovery({ kind: 'gateway' }))
  await command('preferences', { mode: 'public', publicUrl: 'https://initial.example.com' })
  // The public port is a fixed production port; the test only exercises the reconciliation path.
  const listen = vi.spyOn(Gateway.prototype, 'listen').mockImplementation(async function (this: Gateway, _host: '127.0.0.1' | '0.0.0.0', _port = 0): Promise<number> { this.port = 45871; return 45871 })
  const started = await command('start')
  expect(started).toMatchObject({ enabled: true, phase: 'ready', publicUrl: 'https://initial.example.com' })
  const added = await command('addPublicNode', { url: 'https://second.example.com' })
  const switched = await command('setCurrentPublicNode', { id: added.node.id })
  expect(switched).toMatchObject({ enabled: true, activeMode: 'public', phase: 'ready', publicUrl: 'https://second.example.com', gatewayPort: 45871 })
  expect(switched.publicNodes.current).toBe(added.node.id)
  expect(listen).toHaveBeenCalledTimes(2)
  await command('stop')
  expect((await command('status')).phase).toBe('off')
}))

it('removes a node, its Host credentials, and only the device authorizations scoped to its host', () => withHost(async ({ command, storage }) => {
  stubDiscovery(() => discovery())
  const added = await command('addPublicNode', { url: 'https://node.example.com' })
  writeFileSync(join(storage, 'service-nodes.json'), JSON.stringify({ version: 1, nodes: { 'https://node.example.com': { credential: 'node-credential-secret', hostId: 'A'.repeat(43), registeredAt: 1, lastConnectedAt: null } } }), { mode: 0o600 })
  const removed = await command('removePublicNode', { id: added.node.id })
  expect(removed).toMatchObject({ status: 200, publicNodes: { current: null, list: [], pendingReview: false } })
  expect(removed.devices.map((entry: { id: string }) => entry.id)).toEqual(['lan-device'])
  const stored = JSON.parse(readFileSync(join(storage, 'service-nodes.json'), 'utf8'))
  expect(stored.nodes['https://node.example.com']).toBeUndefined()
  expect(await command('removePublicNode', { id: 'missing' })).toMatchObject({ status: 400, error: '公网节点不存在。' })
}, storage => {
  const device = (id: string, host: string, via: 'lan' | 'public') => ({ id, name: `设备 ${id}`, createdAt: 1, lastSeenAt: Date.now(), hash: 'a'.repeat(64), host, via })
  writeFileSync(join(storage, 'devices.json'), JSON.stringify({ version: 1, devices: [device('public-device', 'node.example.com', 'public'), device('lan-device', '192.168.1.5:45871', 'lan')] }))
}))

it('keeps the panel usable when the node list file is damaged', () => withHost(async ({ command }) => {
  const state = await command('status')
  expect(state.publicNodes).toEqual({ current: null, list: [], pendingReview: false })
  expect(state.error).toContain('公网节点配置文件已损坏')
  const action = await command('addPublicNode', { url: 'https://service.example.com' })
  expect(action.status).toBe(400)
  expect(action.error).toBe(state.error)
  expect(await command('approveServicePairing', { id: 'pair-1' })).toMatchObject({ status: 400, error: '当前没有连接自托管公网节点。' })
  expect(await command('rejectServicePairing', {})).toMatchObject({ status: 400, error: '当前没有连接自托管公网节点。' })
}, storage => writeFileSync(join(storage, 'public-nodes.json'), '{not json')))

it('shows a service-node pairing QR from the ticket the node signs', async () => {
  const restoreTls = allowSelfSignedTls()
  const fake = await startFakeServiceNode()
  try {
    await withHost(async ({ command, storage }) => {
      stubDiscoveryAndNetwork()
      const added = await command('addPublicNode', { url: fake.origin })
      expect(added).toMatchObject({ status: 200, ok: true })
      await command('setCurrentPublicNode', { id: added.node.id })
      await command('preferences', { mode: 'public' })
      const listen = vi.spyOn(Gateway.prototype, 'listen').mockImplementation(async function (this: Gateway): Promise<number> { this.port = 45871; return 45871 })
      try {
        await command('start')
        await vi.waitFor(async () => expect((await command('status')).serviceNode?.connected).toBe(true), { timeout: 8000 })
        const state = await command('status')
        expect(state.phase).toBe('ready')
        expect(state.links).toHaveLength(1)
        expect(state.links[0].base).toBe(fake.origin)
        const url = new URL(state.links[0].url)
        expect(url.origin).toBe(fake.origin)
        const hash = new URLSearchParams(url.hash.slice(1))
        // The node's pairing page reads `v`, `ticket` and this Host's identity key from the hash.
        expect(hash.get('v')).toBe('1')
        expect(hash.get('ticket')).toBe(fake.tickets[0])
        const identity = JSON.parse(readFileSync(join(storage, 'host-identity.json'), 'utf8')) as { publicKey: string }
        expect(hash.get('key')).toBe(identity.publicKey)
        expect(state.expiresAt).toEqual(expect.any(Number))
        expect(state.qr).toMatch(/^data:image\/png;base64,/)
        expect(fake.pairings).toHaveLength(1)
        expect(fake.pairings[0]?.authorization).toBe('Bearer node-credential-1')
        expect(fake.pairings[0]?.body).toEqual({})
        // Refresh is the panel's way to get a fresh ticket without touching the tunnel.
        const refreshed = await command('refresh')
        expect(refreshed.status).toBe(200)
        expect(fake.pairings).toHaveLength(2)
        expect(new URLSearchParams(new URL(refreshed.links[0].url).hash.slice(1)).get('ticket')).toBe(fake.tickets[1])
        await command('stop')
      } finally {
        await command('stop').catch(() => undefined)
        listen.mockRestore()
      }
    })
  } finally {
    restoreTls()
    await fake.close()
  }
})

it('keeps the tunnel ready when the node refuses to sign a pairing QR', async () => {
  const restoreTls = allowSelfSignedTls()
  const fake = await startFakeServiceNode({ pairing: () => ({ status: 500 }) })
  try {
    await withHost(async ({ command }) => {
      stubDiscoveryAndNetwork()
      const added = await command('addPublicNode', { url: fake.origin })
      await command('setCurrentPublicNode', { id: added.node.id })
      await command('preferences', { mode: 'public' })
      const listen = vi.spyOn(Gateway.prototype, 'listen').mockImplementation(async function (this: Gateway): Promise<number> { this.port = 45871; return 45871 })
      try {
        await command('start')
        await vi.waitFor(async () => expect((await command('status')).serviceNode?.lastError).toBe('节点没有签发配对票据（HTTP 500）。'), { timeout: 8000 })
        const state = await command('status')
        // The tunnel itself is healthy: a refused ticket must not become a plugin error or an empty QR.
        expect(state.phase).toBe('ready')
        expect(state.serviceNode.connected).toBe(true)
        expect(state.qr).toBeUndefined()
        expect(state.links[0]?.url).toBeUndefined()
        expect(state.expiresAt).toBeUndefined()
        await command('stop')
      } finally {
        await command('stop').catch(() => undefined)
        listen.mockRestore()
      }
    })
  } finally {
    restoreTls()
    await fake.close()
  }
})

it('unregisters the Host on the service node before forgetting it locally', async () => {
  const restoreTls = allowSelfSignedTls()
  const fake = await startFakeServiceNode()
  try {
    await withHost(async ({ command, storage }) => {
      stubDiscoveryAndNetwork()
      const added = await command('addPublicNode', { url: fake.origin })
      await command('setCurrentPublicNode', { id: added.node.id })
      await command('preferences', { mode: 'public' })
      const listen = vi.spyOn(Gateway.prototype, 'listen').mockImplementation(async function (this: Gateway): Promise<number> { this.port = 45871; return 45871 })
      try {
        await command('start')
        await vi.waitFor(async () => expect((await command('status')).serviceNode?.connected).toBe(true), { timeout: 8000 })
        const removed = await command('removePublicNode', { id: added.node.id })
        expect(removed.status).toBe(200)
        expect(removed.publicNodes).toEqual({ current: null, list: [], pendingReview: false })
        expect(removed.serviceNode).toBeNull()
        expect(fake.unregistrations).toHaveLength(1)
        expect(fake.unregistrations[0]?.authorization).toBe('Bearer node-credential-1')
        expect(fake.unregistrations[0]?.path).toMatch(/^\/v1\/hosts\/[A-Za-z0-9_-]{43}$/u)
        const stored = JSON.parse(readFileSync(join(storage, 'service-nodes.json'), 'utf8'))
        expect(stored.nodes[fake.origin]).toBeUndefined()
        expect((await command('status')).serviceNode).toBeNull()
      } finally {
        await command('stop').catch(() => undefined)
        listen.mockRestore()
      }
    })
  } finally {
    restoreTls()
    await fake.close()
  }
})

it('reports a node registration that could not be revoked when removing the node', async () => {
  const restoreTls = allowSelfSignedTls()
  const fake = await startFakeServiceNode({ unregister: () => ({ status: 500, json: { error: 'busy' } }) })
  try {
    await withHost(async ({ command, storage }) => {
      stubDiscoveryAndNetwork()
      const added = await command('addPublicNode', { url: fake.origin })
      await command('setCurrentPublicNode', { id: added.node.id })
      await command('preferences', { mode: 'public' })
      const listen = vi.spyOn(Gateway.prototype, 'listen').mockImplementation(async function (this: Gateway): Promise<number> { this.port = 45871; return 45871 })
      try {
        await command('start')
        await vi.waitFor(async () => expect((await command('status')).serviceNode?.connected).toBe(true), { timeout: 8000 })
        const removed = await command('removePublicNode', { id: added.node.id })
        // The local record must go even when the node refuses to delete its Host row.
        expect(removed.status).toBe(200)
        expect(removed.publicNodes.list).toEqual([])
        expect(fake.unregistrations).toHaveLength(1)
        expect(removed.serviceNode?.lastError).toMatch(/节点上的主机注册可能仍在/u)
        expect(removed.serviceNode?.lastError).toContain('重新添加前需要在该节点上重置')
        const stored = JSON.parse(readFileSync(join(storage, 'service-nodes.json'), 'utf8'))
        expect(stored.nodes[fake.origin]).toBeUndefined()
        expect((await command('status')).serviceNode?.lastError).toContain('重新添加前需要在该节点上重置')
      } finally {
        await command('stop').catch(() => undefined)
        listen.mockRestore()
      }
    })
  } finally {
    restoreTls()
    await fake.close()
  }
})
