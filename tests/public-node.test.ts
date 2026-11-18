import { afterEach, describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_IDENTITY_FILE, fingerprintGroupsOf, identityOfPublicKey, loadHostIdentity } from '../src/host-identity.js'
import {
  PUBLIC_NODE_PATH, PUBLIC_NODE_PROTOCOL_V1, PUBLIC_NODE_PROTOCOL_V2, detectPublicNode, nodeIdentityOf,
  normalizeNodeOrigin, parsePublicNodeIdentity,
  type PublicNodeDiscovery, type PublicNodeFetch, type PublicNodeIdentity,
} from '../src/public-node.js'
import { PUBLIC_NODES_FILE, PUBLIC_NODES_VERSION, PublicNodeConfig } from '../src/public-node-config.js'
import { Gateway } from '../src/gateway.js'
import { PairingService } from '../src/pairing.js'
import { writePublicUrl } from '../src/public-url-settings.js'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function folder(): string { const dir = mkdtempSync(join(tmpdir(), 'dsh-rc-node-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

const HOST_ID = '5QKQY_VIKcY52sBuej3ozcSh4gUAwAYe0YENr18qsfA'
const FINGERPRINT = 'e5029063f54829c639dac06e7a3de8cd'

/** A real Ed25519 key pair is the only way to build a protocol-2 identity: the digest must prove the key. */
function nodeIdentity(): PublicNodeIdentity {
  const { publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  const derived = identityOfPublicKey(der)
  return { id: derived.hostId, fingerprint: derived.fingerprint, publicKey: der.toString('base64url') }
}
const NODE_IDENTITY = nodeIdentity()
const OTHER_IDENTITY = nodeIdentity()

const V1_NODE: PublicNodeDiscovery = { protocol: PUBLIC_NODE_PROTOCOL_V1, kind: 'gateway', name: 'DeepSeek Harness', version: '0.6.0', capabilities: ['pairing', 'official-ui'], node: null, hostId: HOST_ID, fingerprint: FINGERPRINT }
const V2_NODE: PublicNodeDiscovery = { protocol: PUBLIC_NODE_PROTOCOL_V2, kind: 'gateway', name: 'DeepSeek Harness', version: '0.6.0', capabilities: ['pairing', 'cache', 'official-ui'], node: NODE_IDENTITY, hostId: null, fingerprint: null }
/** What the gateway actually puts on the wire: the `node` identity plus the flat aliases ≤0.5.0 reads. */
const V2_WIRE: Record<string, unknown> = { ...V2_NODE, hostId: NODE_IDENTITY.id, fingerprint: NODE_IDENTITY.fingerprint }

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> { return { ...V1_NODE, ...overrides } }
function v2Payload(overrides: Record<string, unknown> = {}): Record<string, unknown> { return { ...V2_WIRE, ...overrides } }
function responds(body: unknown, status = 200): PublicNodeFetch {
  return async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}
function throws(error: unknown): PublicNodeFetch { return async () => { throw error } }
async function codeOf(input: string, fetcher: PublicNodeFetch): Promise<string> {
  const result = await detectPublicNode(input, { fetch: fetcher })
  return result.ok ? 'ok' : result.code
}

describe('host identity', () => {
  it('creates one stable identity and derives hostId and fingerprint from the public key', async () => {
    const file = join(folder(), HOST_IDENTITY_FILE)
    const first = await loadHostIdentity(file)
    expect(first.hostId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.fingerprint).toMatch(/^[a-f0-9]{32}$/)
    expect(first.fingerprintGroups).toBe(fingerprintGroupsOf(first.fingerprint))
    expect(first.fingerprintGroups).toMatch(/^(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { version: number; algorithm: string; publicKey: string; privateKey: string; createdAt: string }
    expect(stored).toMatchObject({ version: 1, algorithm: 'ed25519' })
    expect(stored.privateKey.length).toBeGreaterThan(0)
    const digest = createHash('sha256').update(Buffer.from(stored.publicKey, 'base64url')).digest()
    expect(digest.toString('base64url')).toBe(first.hostId)
    expect(digest.subarray(0, 16).toString('hex')).toBe(first.fingerprint)
    expect(identityOfPublicKey(Buffer.from(stored.publicKey, 'base64url'))).toEqual({ hostId: first.hostId, fingerprint: first.fingerprint, fingerprintGroups: first.fingerprintGroups })
    // The file is written beside its destination, so an interrupted write leaves no key fragment behind.
    expect(readdirSync(dirname(file)).filter(name => name.endsWith('.tmp'))).toEqual([])
    const second = await loadHostIdentity(file)
    expect(second.hostId).toBe(first.hostId)
    expect(second.fingerprint).toBe(first.fingerprint)
  })
  it('refuses to rebuild a damaged identity file', async () => {
    const file = join(folder(), HOST_IDENTITY_FILE)
    await loadHostIdentity(file)
    writeFileSync(file, '{ damaged')
    await expect(loadHostIdentity(file)).rejects.toThrow(/已损坏/)
    expect(readFileSync(file, 'utf8')).toBe('{ damaged')
  })
  it('treats a public key that the private key did not produce as damage', async () => {
    const file = join(folder(), HOST_IDENTITY_FILE)
    await loadHostIdentity(file)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { publicKey: string }
    writeFileSync(file, JSON.stringify({ ...stored, publicKey: 'A'.repeat(43) }))
    await expect(loadHostIdentity(file)).rejects.toThrow(/已损坏/)
  })
  it('rejects malformed fingerprints when grouping them for people', () => {
    expect(() => fingerprintGroupsOf('abcd')).toThrow(/32 位/)
    expect(() => fingerprintGroupsOf(FINGERPRINT.toUpperCase())).toThrow(/32 位/)
  })
})

describe('node identity self-check', () => {
  it('accepts an identity whose public key derives both id and fingerprint', () => {
    expect(parsePublicNodeIdentity(NODE_IDENTITY)).toEqual(NODE_IDENTITY)
    expect(nodeIdentityOf({ node: NODE_IDENTITY })).toEqual({ id: NODE_IDENTITY.id, fingerprint: NODE_IDENTITY.fingerprint })
    expect(nodeIdentityOf({ hostId: HOST_ID, fingerprint: FINGERPRINT })).toEqual({ id: HOST_ID, fingerprint: FINGERPRINT })
    // The protocol-2 `node` object wins over any flat alias in the same document.
    expect(nodeIdentityOf({ node: NODE_IDENTITY, hostId: HOST_ID, fingerprint: FINGERPRINT })).toEqual({ id: NODE_IDENTITY.id, fingerprint: NODE_IDENTITY.fingerprint })
  })
  it('rejects a copied id, a foreign fingerprint and non-Ed25519 keys', () => {
    expect(parsePublicNodeIdentity({ ...NODE_IDENTITY, id: HOST_ID })).toBeNull()
    expect(parsePublicNodeIdentity({ ...NODE_IDENTITY, fingerprint: FINGERPRINT })).toBeNull()
    expect(parsePublicNodeIdentity({ ...NODE_IDENTITY, fingerprint: NODE_IDENTITY.fingerprint.toUpperCase() })).toBeNull()
    expect(parsePublicNodeIdentity({ ...NODE_IDENTITY, publicKey: '!' + NODE_IDENTITY.publicKey.slice(1) })).toBeNull()
    expect(parsePublicNodeIdentity({ ...NODE_IDENTITY, publicKey: NODE_IDENTITY.publicKey.slice(0, -2) })).toBeNull()
    const x25519 = generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' })
    const foreign = identityOfPublicKey(x25519)
    expect(parsePublicNodeIdentity({ id: foreign.hostId, fingerprint: foreign.fingerprint, publicKey: x25519.toString('base64url') })).toBeNull()
  })
  it('ignores documents that only look like an identity', () => {
    expect(parsePublicNodeIdentity(null)).toBeNull()
    expect(parsePublicNodeIdentity('identity')).toBeNull()
    expect(parsePublicNodeIdentity({ id: HOST_ID, fingerprint: FINGERPRINT })).toBeNull()
    expect(nodeIdentityOf(null)).toBeNull()
    expect(nodeIdentityOf({ node: { id: 'short', fingerprint: FINGERPRINT } })).toBeNull()
  })
})

describe('public node detection', () => {
  it('accepts a protocol-2 gateway document and requests only the discovery path without credentials', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher: PublicNodeFetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(v2Payload()), { status: 200 }) }
    const result = await detectPublicNode(' https://Node.Example.com/ ', { fetch: fetcher })
    if (!result.ok) throw new Error(result.message)
    // The flat aliases are for old clients only; this plugin records the one `node` identity.
    expect(result.node).toEqual({ ...V2_NODE, url: 'https://node.example.com' })
    expect(result.node.hostId).toBeNull()
    expect(result.node.fingerprint).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://node.example.com${PUBLIC_NODE_PATH}`)
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.init.redirect).toBe('manual')
    expect(calls[0]!.init.credentials).toBe('omit')
    expect(calls[0]!.init.referrerPolicy).toBe('no-referrer')
    expect(calls[0]!.init.headers).toEqual({ accept: 'application/json' })
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })
  it('still accepts a protocol-1 document and keeps its flat identity', async () => {
    const result = await detectPublicNode('https://node.example.com', { fetch: responds(payload()) })
    if (!result.ok) throw new Error(result.message)
    expect(result.node).toEqual({ ...V1_NODE, url: 'https://node.example.com' })
    expect(result.node.node).toBeNull()
  })
  it('still accepts a protocol-1 service document', async () => {
    const result = await detectPublicNode('https://node.example.com', { fetch: responds(payload({ kind: 'service' })) })
    if (!result.ok) throw new Error(result.message)
    expect(result.node).toMatchObject({ protocol: 1, kind: 'service', node: null, hostId: HOST_ID, fingerprint: FINGERPRINT })
  })
  it('keeps an explicit port and deduplicates known capabilities in order', async () => {
    const fetcher = responds(v2Payload({ capabilities: ['cache', 'pairing', 'cache'] }))
    const result = await detectPublicNode('https://node.example.com:8443/', { fetch: fetcher })
    if (!result.ok) throw new Error(result.message)
    expect(result.node.url).toBe('https://node.example.com:8443')
    expect(result.node.capabilities).toEqual(['cache', 'pairing'])
  })
  it('rejects a capability this client does not implement', async () => {
    const result = await detectPublicNode('https://node.example.com', { fetch: responds(v2Payload({ capabilities: ['pairing', 'relay'] })) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('bad-capability')
  })
  it('ignores unknown fields for forward compatibility', async () => {
    const result = await detectPublicNode('https://node.example.com', { fetch: responds(v2Payload({ futureField: true, hostId: 'not-validated', fingerprint: 'not-validated' })) })
    if (!result.ok) throw new Error(result.message)
    expect(result.node).toEqual({ ...V2_NODE, url: 'https://node.example.com' })
  })
  it('rejects every address that is not a bare HTTPS origin', async () => {
    expect(await codeOf('http://node.example.com', responds(v2Payload()))).toBe('not-https')
    expect(await codeOf('not a url', responds(v2Payload()))).toBe('bad-url')
    expect(await codeOf('https://node.example.com/path', responds(v2Payload()))).toBe('bad-url')
    expect(await codeOf('https://node.example.com?x=1', responds(v2Payload()))).toBe('bad-url')
    expect(await codeOf('https://node.example.com#x', responds(v2Payload()))).toBe('bad-url')
    expect(await codeOf('https://user:pass@node.example.com', responds(v2Payload()))).toBe('bad-url')
    expect(normalizeNodeOrigin('https://Node.Example.com/')).toBe('https://node.example.com')
    expect(normalizeNodeOrigin('https://node.example.com/path')).toBeNull()
  })
  it('classifies network failures as unreachable and certificate failures as bad-tls', async () => {
    expect(await codeOf('https://node.example.com', throws(new TypeError('fetch failed')))).toBe('unreachable')
    const tls = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) })
    expect(await codeOf('https://node.example.com', throws(tls))).toBe('bad-tls')
    // An aborted handshake names SSL in its message but says nothing about the certificate.
    const aborted = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('0A000086:SSL routines:ssl3_read_bytes:tlsv1 alert internal error'), { code: 'EPROTO' }) })
    expect(await codeOf('https://node.example.com', throws(aborted))).toBe('unreachable')
  })
  it('refuses any redirect, including a same-origin one', async () => {
    expect(await codeOf('https://node.example.com', responds('', 302))).toBe('redirect')
  })
  it('reports a timeout instead of hanging', async () => {
    const fetcher: PublicNodeFetch = (_url, init) => new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))) })
    const result = await detectPublicNode('https://slow.example.com', { fetch: fetcher, timeoutMs: 20 })
    expect(result.ok).toBe(false)
    if (!result.ok) { expect(result.code).toBe('unreachable'); expect(result.message).toContain('超时') }
  })
  it('rejects every protocol other than 1 and 2', async () => {
    expect(await codeOf('https://node.example.com', responds(payload({ protocol: 0 })))).toBe('bad-protocol')
    expect(await codeOf('https://node.example.com', responds(payload({ protocol: 3 })))).toBe('bad-protocol')
    expect(await codeOf('https://node.example.com', responds(payload({ protocol: '2' })))).toBe('bad-protocol')
    const missing = await detectPublicNode('https://node.example.com', { fetch: responds({ ...V2_WIRE, protocol: undefined }) })
    expect(missing.ok).toBe(false)
    if (!missing.ok) { expect(missing.code).toBe('bad-protocol'); expect(missing.message).toContain('1 和 2') }
  })
  it('rejects an unknown node kind in either protocol', async () => {
    expect(await codeOf('https://node.example.com', responds(payload({ kind: 'Gateway' })))).toBe('bad-kind')
    expect(await codeOf('https://node.example.com', responds(payload({ kind: 'relay' })))).toBe('bad-kind')
    expect(await codeOf('https://node.example.com', responds(v2Payload({ kind: undefined })))).toBe('bad-kind')
  })
  it('requires the pairing capability and only known capabilities', async () => {
    expect(await codeOf('https://node.example.com', responds(v2Payload({ capabilities: [] })))).toBe('bad-capability')
    expect(await codeOf('https://node.example.com', responds(v2Payload({ capabilities: ['official-ui'] })))).toBe('bad-capability')
    expect(await codeOf('https://node.example.com', responds(v2Payload({ capabilities: ['pairing', 'future'] })))).toBe('bad-capability')
    expect(await codeOf('https://node.example.com', responds(v2Payload({ capabilities: 'pairing' })))).toBe('bad-capability')
  })
  it('validates the human-facing name and the software version', async () => {
    expect(await codeOf('https://node.example.com', responds(v2Payload({ name: '' })))).toBe('bad-response')
    expect(await codeOf('https://node.example.com', responds(v2Payload({ name: 'x'.repeat(65) })))).toBe('bad-response')
    expect(await codeOf('https://node.example.com', responds(v2Payload({ name: 'bad\u0001name' })))).toBe('bad-response')
    expect(await codeOf('https://node.example.com', responds(v2Payload({ version: '' })))).toBe('bad-response')
    expect(await codeOf('https://node.example.com', responds(v2Payload({ version: 'x'.repeat(33) })))).toBe('bad-response')
    expect(await codeOf('https://node.example.com', responds(v2Payload({ version: '1 0' })))).toBe('bad-response')
  })
  it('validates the protocol-1 identity encodings strictly', async () => {
    expect(await codeOf('https://node.example.com', responds(payload({ hostId: 'x'.repeat(42) })))).toBe('bad-identity')
    expect(await codeOf('https://node.example.com', responds(payload({ hostId: '!'.repeat(43) })))).toBe('bad-identity')
    expect(await codeOf('https://node.example.com', responds(payload({ fingerprint: FINGERPRINT.toUpperCase() })))).toBe('bad-identity')
    expect(await codeOf('https://node.example.com', responds(payload({ fingerprint: 'abc' })))).toBe('bad-identity')
  })
  it('requires a protocol-2 node identity object', async () => {
    expect(await codeOf('https://node.example.com', responds(v2Payload({ node: null })))).toBe('bad-identity')
    expect(await codeOf('https://node.example.com', responds(v2Payload({ node: 'identity' })))).toBe('bad-identity')
    const missing = await detectPublicNode('https://node.example.com', { fetch: responds(v2Payload({ node: undefined })) })
    expect(missing.ok).toBe(false)
    if (!missing.ok) { expect(missing.code).toBe('bad-identity'); expect(missing.message).toContain('缺少 node') }
  })
  it('refuses a protocol-2 node whose key does not prove its id and fingerprint', async () => {
    expect(await codeOf('https://node.example.com', responds(v2Payload({ node: { ...NODE_IDENTITY, id: HOST_ID } })))).toBe('bad-identity')
    expect(await codeOf('https://node.example.com', responds(v2Payload({ node: { ...NODE_IDENTITY, fingerprint: FINGERPRINT } })))).toBe('bad-identity')
    expect(await codeOf('https://node.example.com', responds(v2Payload({ node: { ...NODE_IDENTITY, publicKey: OTHER_IDENTITY.publicKey } })))).toBe('bad-identity')
    expect(await codeOf('https://node.example.com', responds(v2Payload({ node: { ...NODE_IDENTITY, publicKey: 'x'.repeat(44) } })))).toBe('bad-identity')
  })
  it('rejects non-200, non-JSON and non-object responses', async () => {
    expect(await codeOf('https://node.example.com', responds(v2Payload(), 500))).toBe('bad-response')
    expect(await codeOf('https://node.example.com', responds('not json'))).toBe('bad-response')
    expect(await codeOf('https://node.example.com', responds([]))).toBe('bad-response')
  })
  it('classifies a real self-signed HTTPS endpoint as bad-tls', async () => {
    const key = readFileSync(fileURLToPath(new URL('./fixtures/lan-tls/key-1.pem', import.meta.url)))
    const cert = readFileSync(fileURLToPath(new URL('./fixtures/lan-tls/server.pem', import.meta.url)))
    const server = createHttpsServer({ key, cert }, (_req, res) => { res.end(JSON.stringify(v2Payload())) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
    const port = (server.address() as { port: number }).port
    const result = await detectPublicNode(`https://127.0.0.1:${port}`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('bad-tls')
  })
})

describe('public node config', () => {
  const NOW = 1_763_300_000_000
  function store(file: string, legacyFile?: string): PublicNodeConfig { return new PublicNodeConfig({ file, legacyFile, now: () => NOW }) }
  function readFile(file: string): { version: number; current: string | null; nodes: Array<Record<string, unknown>> } {
    return JSON.parse(readFileSync(file, 'utf8')) as { version: number; current: string | null; nodes: Array<Record<string, unknown>> }
  }
  it('starts empty and writes nothing until the first node is added', () => {
    const file = join(folder(), PUBLIC_NODES_FILE)
    const config = store(file)
    expect(config.current).toBeNull()
    expect(config.list()).toEqual([])
    expect(existsSync(file)).toBe(false)
    const record = config.add({ url: 'https://node.example.com/' })
    expect(record).toMatchObject({ url: 'https://node.example.com', kind: null, protocol: null, node: null, hostId: null, fingerprint: null, identityChange: null, pending: true, lastCheckAt: null, lastCheckOk: false, lastCheckError: null })
    expect(existsSync(file)).toBe(true)
    expect(readFile(file).version).toBe(PUBLIC_NODES_VERSION)
    expect(readdirSync(dirname(file)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
  it('persists a probed protocol-2 node without copying the identity into the flat fields', () => {
    const file = join(folder(), PUBLIC_NODES_FILE)
    const config = store(file)
    const record = config.add({ url: 'https://node.example.com', kind: 'gateway', name: 'DeepSeek Harness', version: '0.6.0', protocol: 2, capabilities: ['pairing', 'cache'], node: NODE_IDENTITY })
    expect(record.pending).toBe(false)
    expect(record.lastCheckOk).toBe(true)
    expect(record.lastCheckAt).toBe(NOW)
    expect(record.hostId).toBeNull()
    expect(record.fingerprint).toBeNull()
    expect(record.node).toEqual(NODE_IDENTITY)
    const stored = readFile(file)
    expect(stored.version).toBe(PUBLIC_NODES_VERSION)
    expect(stored.nodes[0]).toMatchObject({ node: NODE_IDENTITY, hostId: null, fingerprint: null })
    expect(store(file).list()).toEqual([record])
  })
  it('persists a probed protocol-1 node with its flat identity', () => {
    const file = join(folder(), PUBLIC_NODES_FILE)
    const config = store(file)
    const record = config.add({ url: 'https://node.example.com', kind: 'service', name: 'Studio', version: '0.5.1', protocol: 1, capabilities: ['pairing', 'cache'], hostId: HOST_ID, fingerprint: FINGERPRINT })
    expect(record.node).toBeNull()
    expect(record.hostId).toBe(HOST_ID)
    expect(store(file).list()).toEqual([record])
  })
  it('reads a version-1 file, keeps its fields and rewrites version 2 on the next save', () => {
    const file = join(folder(), PUBLIC_NODES_FILE)
    const legacyRecord = { id: 'legacy-1', url: 'https://old.example.com', kind: 'gateway', name: 'Old Node', version: '0.5.1', protocol: 1, capabilities: ['pairing'], hostId: HOST_ID, fingerprint: FINGERPRINT, addedAt: NOW, lastCheckAt: NOW - 1000, lastCheckOk: true, lastCheckError: null, pending: false }
    writeFileSync(file, JSON.stringify({ version: 1, current: 'legacy-1', nodes: [legacyRecord] }))
    const config = store(file)
    expect(config.current).toBe('legacy-1')
    expect(config.list()).toHaveLength(1)
    expect(config.list()[0]).toMatchObject({ ...legacyRecord, node: null, identityChange: null })
    // Reading a version-1 file does not rewrite it; the first mutation writes the current shape.
    expect(readFile(file).version).toBe(1)
    config.setCurrent(null)
    const upgraded = readFile(file)
    expect(upgraded.version).toBe(PUBLIC_NODES_VERSION)
    expect(upgraded.nodes[0]).toMatchObject({ node: null, identityChange: null, protocol: 1 })
  })
  it('adopts the first node identity silently and never replaces an existing one', () => {
    const file = join(folder(), PUBLIC_NODES_FILE)
    const config = store(file)
    const candidate = config.add({ url: 'https://node.example.com' })
    // A candidate with no identity at all is the only state that accepts an adoption, and only a proof passes.
    expect(() => config.adoptIdentity(candidate.id, { ...NODE_IDENTITY, id: HOST_ID })).toThrow(/身份无效/)
    const adopted = config.adoptIdentity(candidate.id, NODE_IDENTITY)
    expect(adopted).toMatchObject({ protocol: 2, node: NODE_IDENTITY, hostId: null, fingerprint: null, identityChange: null })
    // A later probe does not replace an identity that is already recorded.
    expect(config.adoptIdentity(candidate.id, OTHER_IDENTITY)).toEqual(adopted)
    expect(store(file).list()[0]!.node).toEqual(NODE_IDENTITY)
    expect(() => config.adoptIdentity('missing', NODE_IDENTITY)).toThrow(/不存在/)
  })
  it('records an identity change, blocks the node, then adopts it on confirmation', () => {
    const file = join(folder(), PUBLIC_NODES_FILE)
    const config = store(file)
    const record = config.add({ url: 'https://node.example.com', kind: 'gateway', name: 'DeepSeek Harness', version: '0.6.0', protocol: 2, capabilities: ['pairing'], node: NODE_IDENTITY })
    expect(config.blocked(record.id)).toBe(false)
    const changed = config.markIdentityChange(record.id, OTHER_IDENTITY)
    expect(changed.node).toEqual(NODE_IDENTITY)
    expect(changed.identityChange).toMatchObject({ from: NODE_IDENTITY, to: OTHER_IDENTITY, detectedAt: NOW })
    expect(config.blocked(record.id)).toBe(true)
    expect(store(file).list()[0]!.identityChange).toMatchObject({ from: NODE_IDENTITY, to: OTHER_IDENTITY })
    const confirmed = config.confirmIdentity(record.id)
    expect(confirmed.node).toEqual(OTHER_IDENTITY)
    expect(confirmed.identityChange).toBeNull()
    expect(config.blocked(record.id)).toBe(false)
    expect(store(file).list()[0]!.node).toEqual(OTHER_IDENTITY)
  })
  it('refuses identity changes that cannot be compared', () => {
    const file = join(folder(), PUBLIC_NODES_FILE)
    const config = store(file)
    const v1 = config.add({ url: 'https://old.example.com', kind: 'gateway', name: 'Old', version: '0.5.1', protocol: 1, capabilities: ['pairing'], hostId: HOST_ID, fingerprint: FINGERPRINT })
    expect(() => config.markIdentityChange(v1.id, NODE_IDENTITY)).toThrow(/还没有节点身份/)
    expect(() => config.confirmIdentity(v1.id)).toThrow(/没有待确认/)
    const v2 = config.add({ url: 'https://node.example.com', kind: 'gateway', name: 'DeepSeek Harness', version: '0.6.0', protocol: 2, capabilities: ['pairing'], node: NODE_IDENTITY })
    expect(() => config.markIdentityChange(v2.id, NODE_IDENTITY)).toThrow(/没有变化/)
    expect(() => config.markIdentityChange(v2.id, { ...OTHER_IDENTITY, id: HOST_ID })).toThrow(/身份无效/)
    expect(() => config.markIdentityChange('missing', OTHER_IDENTITY)).toThrow(/不存在/)
  })
  it('requires exactly one identity encoding per record', () => {
    const file = join(folder(), PUBLIC_NODES_FILE)
    const config = store(file)
    config.add({ url: 'https://node.example.com', kind: 'gateway', name: 'DeepSeek Harness', version: '0.6.0', protocol: 2, capabilities: ['pairing'], node: NODE_IDENTITY })
    const flatCopy = readFile(file)
    flatCopy.nodes[0]!.hostId = NODE_IDENTITY.id
    writeFileSync(file, JSON.stringify(flatCopy))
    expect(() => store(file)).toThrow(/已损坏/)
    const broken = readFile(file)
    broken.nodes[0]!.hostId = null
    broken.nodes[0]!.node = { ...NODE_IDENTITY, id: HOST_ID }
    writeFileSync(file, JSON.stringify(broken))
    expect(() => store(file)).toThrow(/已损坏/)
  })
  it('keeps an unprobed candidate pending until a probe fills its protocol fields', () => {
    const file = join(folder(), PUBLIC_NODES_FILE)
    const config = store(file)
    // A protocol cannot be recorded without the identity that protocol requires: an unprobed node carries all null.
    const candidate = config.add({ url: 'https://node.example.com' })
    expect(candidate.pending).toBe(true)
    const adopted = config.adoptIdentity(candidate.id, NODE_IDENTITY)
    expect(adopted).toMatchObject({ protocol: 2, pending: true, lastCheckAt: null })
    const probed = config.update(candidate.id, { lastCheckAt: NOW, lastCheckOk: true, pending: false })
    expect(probed).toMatchObject({ protocol: 2, node: NODE_IDENTITY, pending: false, lastCheckAt: NOW, lastCheckOk: true })
  })
  it('updates probe fields, selects a current node and removes it with its cache identity', () => {
    const file = join(folder(), PUBLIC_NODES_FILE)
    const config = store(file)
    const candidate = config.add({ url: 'https://node.example.com' })
    const probed = config.update(candidate.id, { kind: 'gateway', name: 'DeepSeek Harness', version: '0.6.0', protocol: 2, capabilities: ['pairing', 'official-ui'], node: NODE_IDENTITY, pending: false, lastCheckAt: NOW, lastCheckOk: true, lastCheckError: null })
    expect(probed.pending).toBe(false)
    expect(probed.node).toEqual(NODE_IDENTITY)
    config.setCurrent(candidate.id)
    expect(config.current).toBe(candidate.id)
    const removed = config.remove(candidate.id)
    expect(removed).toEqual({ origin: 'https://node.example.com', hostId: null })
    expect(config.current).toBeNull()
    expect(config.list()).toEqual([])
    expect(store(file).list()).toEqual([])
  })
  it('rejects invalid mutations without touching the stored list', () => {
    const file = join(folder(), PUBLIC_NODES_FILE)
    const config = store(file)
    expect(() => config.add({ url: 'http://node.example.com' })).toThrow(/无效/)
    expect(() => config.add({ url: 'https://node.example.com', kind: 'gateway', name: 'DeepSeek Harness', version: '0.6.0', protocol: 2, capabilities: ['pairing'], hostId: HOST_ID, fingerprint: FINGERPRINT })).toThrow(/无效/)
    expect(() => config.add({ url: 'https://node.example.com', kind: 'gateway', name: 'DeepSeek Harness', version: '0.6.0', protocol: 1, capabilities: ['cache'], hostId: HOST_ID, fingerprint: FINGERPRINT })).toThrow(/无效/)
    expect(config.list()).toEqual([])
    expect(() => config.update('missing', { pending: true })).toThrow(/不存在/)
    expect(() => config.setCurrent('missing')).toThrow(/不存在/)
    expect(config.remove('missing')).toBeNull()
  })
  it('rejects a v2 update that would add a flat identity copy', () => {
    const file = join(folder(), PUBLIC_NODES_FILE)
    const config = store(file)
    const record = config.add({ url: 'https://node.example.com', kind: 'gateway', name: 'DeepSeek Harness', version: '0.6.0', protocol: 2, capabilities: ['pairing'], node: NODE_IDENTITY })
    expect(() => config.update(record.id, { hostId: HOST_ID, fingerprint: FINGERPRINT })).toThrow(/无效/)
    expect(store(file).list()[0]!.hostId).toBeNull()
  })
  it('reports a damaged file instead of dropping nodes', () => {
    const file = join(folder(), PUBLIC_NODES_FILE)
    writeFileSync(file, '{ damaged')
    expect(() => store(file)).toThrow(/已损坏/)
    expect(readFileSync(file, 'utf8')).toBe('{ damaged')
  })
  it('rejects damaged nodes and duplicate ids', () => {
    const file = join(folder(), PUBLIC_NODES_FILE)
    const config = store(file)
    config.add({ url: 'https://node.example.com', kind: 'gateway', name: 'DeepSeek Harness', version: '0.6.0', protocol: 2, capabilities: ['pairing'], node: NODE_IDENTITY })
    const value = readFile(file)
    value.nodes[0]!.kind = 'relay'
    writeFileSync(file, JSON.stringify(value))
    expect(() => store(file)).toThrow(/已损坏/)
    value.nodes[0]!.kind = 'gateway'
    value.nodes.push({ ...value.nodes[0] })
    writeFileSync(file, JSON.stringify(value))
    expect(() => store(file)).toThrow(/已损坏/)
  })
  it('normalizes a dangling current id to null instead of failing', () => {
    const file = join(folder(), PUBLIC_NODES_FILE)
    const config = store(file)
    const first = config.add({ url: 'https://one.example.com' })
    config.add({ url: 'https://two.example.com' })
    config.setCurrent(first.id)
    const value = readFile(file)
    value.current = 'missing-id'
    writeFileSync(file, JSON.stringify(value))
    const reloaded = store(file)
    expect(reloaded.current).toBeNull()
    expect(reloaded.list()).toHaveLength(2)
  })
  it('migrates a legacy public address once as a pending candidate, never as current', async () => {
    const dir = folder(), file = join(dir, PUBLIC_NODES_FILE), legacy = join(dir, 'public-url.json')
    await writePublicUrl(legacy, 'https://node.example.com/')
    const config = store(file, legacy)
    expect(config.current).toBeNull()
    expect(config.list()).toHaveLength(1)
    expect(config.list()[0]).toMatchObject({ url: 'https://node.example.com', pending: true, kind: null, name: null, version: null, protocol: null, capabilities: null, node: null, hostId: null, fingerprint: null, identityChange: null, lastCheckAt: null, lastCheckOk: false })
    // A second load sees the node list file and must not migrate the same address again.
    expect(store(file, legacy).list()).toHaveLength(1)
    config.remove(config.list()[0]!.id)
    expect(store(file, legacy).list()).toEqual([])
  })
  it('does not migrate when a node list already exists and ignores an invalid legacy address', async () => {
    const dir = folder(), file = join(dir, PUBLIC_NODES_FILE), legacy = join(dir, 'public-url.json')
    const config = store(file)
    config.add({ url: 'https://node.example.com' })
    await writePublicUrl(legacy, 'https://other.example.com')
    expect(store(file, legacy).list()).toHaveLength(1)
    const emptyDir = folder()
    await writePublicUrl(join(emptyDir, 'public-url.json'), 'http://insecure.example.com')
    expect(store(join(emptyDir, PUBLIC_NODES_FILE), join(emptyDir, 'public-url.json')).list()).toEqual([])
  })
})

describe('gateway discovery endpoint', () => {
  /** The document the gateway really serves: the node identity plus the flat aliases old clients read. */
  const GATEWAY_DOC: PublicNodeDiscovery = { ...V2_NODE, hostId: NODE_IDENTITY.id, fingerprint: NODE_IDENTITY.fingerprint }
  async function gatewayWith(discovery?: PublicNodeDiscovery): Promise<string> {
    const dir = folder()
    const upstream = createHttpServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
    const upstreamPort = (upstream.address() as { port: number }).port
    let gateway: Gateway | undefined
    const pairing = new PairingService({ file: join(dir, 'devices.json'), onRevoke: id => gateway?.revoke(id) })
    gateway = new Gateway({ pairing, upstreamPort, upstreamCookie: () => 'host-private=secret', manage: async () => ({ ok: true }), index: async () => '<!doctype html><html><body></body></html>', boot: () => '', discovery })
    await gateway.listen('127.0.0.1')
    cleanup.push(() => gateway!.close())
    return `http://127.0.0.1:${gateway.port}`
  }
  it('serves the protocol-2 document to unpaired clients without caching and without internal details', async () => {
    const base = await gatewayWith(GATEWAY_DOC)
    const response = await fetch(`${base}${PUBLIC_NODE_PATH}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as Record<string, unknown>
    expect(body).toEqual(GATEWAY_DOC)
    expect(Object.keys(body).sort()).toEqual(['capabilities', 'fingerprint', 'hostId', 'kind', 'name', 'node', 'protocol', 'version'])
    expect(Object.keys(body.node as Record<string, unknown>).sort()).toEqual(['fingerprint', 'id', 'publicKey'])
    const text = JSON.stringify(body)
    expect(text).not.toContain('127.0.0.1')
    expect(text).not.toContain('device')
    expect(text).not.toContain('host-private')
  })
  it('answers HEAD with the same bytes and no body', async () => {
    const base = await gatewayWith(GATEWAY_DOC)
    const response = await fetch(`${base}${PUBLIC_NODE_PATH}`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(JSON.stringify(GATEWAY_DOC))))
    expect(await response.text()).toBe('')
  })
  it('rejects methods other than GET and HEAD', async () => {
    const base = await gatewayWith(GATEWAY_DOC)
    expect((await fetch(`${base}${PUBLIC_NODE_PATH}`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${base}${PUBLIC_NODE_PATH}`, { method: 'PUT' })).status).toBe(405)
  })
  it('serves only the exact discovery path', async () => {
    const base = await gatewayWith(GATEWAY_DOC)
    expect((await fetch(`${base}${PUBLIC_NODE_PATH}/child`)).status).toBe(403)
    expect((await fetch(`${base}/.well-known/other`)).status).toBe(403)
  })
  it('stays behind the Host header check', async () => {
    const base = await gatewayWith(GATEWAY_DOC)
    const status = await new Promise<number | undefined>(resolve => {
      const request = httpRequest(`${base}${PUBLIC_NODE_PATH}`, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode) })
      request.end()
    })
    expect(status).toBe(403)
  })
  it('is not advertised when no identity has been injected', async () => {
    const base = await gatewayWith(undefined)
    expect((await fetch(`${base}${PUBLIC_NODE_PATH}`)).status).toBe(404)
  })
})
