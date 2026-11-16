import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as Plugin from '../src/index.js'
import { Gateway, MANAGE_PATH } from '../src/gateway.js'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

interface DiscoveryOptions { kind?: 'gateway' | 'service'; name?: string; version?: string; hostId?: string; fingerprint?: string }
function discovery(options: DiscoveryOptions = {}): Response {
  return Response.json({
    protocol: 1,
    kind: options.kind ?? 'service',
    name: options.name ?? '测试公网节点',
    version: options.version ?? '1.2.3',
    capabilities: ['pairing', 'cache'],
    hostId: options.hostId ?? 'A'.repeat(43),
    fingerprint: options.fingerprint ?? 'a'.repeat(32),
  })
}
/** detectPublicNode uses the process-wide fetch; the suite stubs it instead of starting an HTTPS node. */
function stubDiscovery(handler: (url: string) => Response): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => handler(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url))
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
  expect(added.node).toMatchObject({ url: 'https://service.example.com', kind: 'service', name: '测试公网节点', version: '1.2.3', hostId: 'A'.repeat(43), fingerprint: 'a'.repeat(32), pending: false, lastCheckOk: true })
  const stored = JSON.parse(readFileSync(join(storage, 'public-nodes.json'), 'utf8'))
  expect(stored).toMatchObject({ version: 1, current: null })
  expect(stored.nodes).toHaveLength(1)
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
