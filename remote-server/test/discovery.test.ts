import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { nodeDescriptorSchema, nodeIdentitySchema } from '../dist/remote-server/src/contract.js'
import {
  api,
  hostIdentityFromKey,
  hostRegistration,
  randomIdentityKey,
  registerHost,
  startNode,
  type TestNode,
} from './helpers.ts'

/** Independent expectation for a node identity: sha256(SPKI DER), 43 + 32 chars. */
async function identityFromFile(dataDir: string): Promise<{ nodeId: string; fingerprint: string; publicKey: string }> {
  const raw = JSON.parse(await readFile(join(dataDir, 'node-identity.json'), 'utf8'))
  assert.equal(nodeIdentitySchema.safeParse(raw).success, true, 'node-identity.json must satisfy the persisted schema')
  const der = Buffer.from(raw.publicKey, 'base64url')
  const digest = createHash('sha256').update(der).digest()
  return {
    nodeId: digest.toString('base64url'),
    fingerprint: digest.subarray(0, 16).toString('hex'),
    publicKey: raw.publicKey,
  }
}

test('well-known descriptor is a strict v2 service document with a persisted node identity', async () => {
  const node = await startNode()
  try {
    const result = await api(node.baseUrl, 'GET', '/.well-known/dsh-remote')
    assert.equal(result.status, 200)
    assert.equal(result.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff')

    const parsed = nodeDescriptorSchema.safeParse(result.json)
    assert.equal(parsed.success, true, 'well-known body must satisfy the strict v2 node descriptor schema')

    assert.equal(result.json.protocol, 2)
    assert.equal(result.json.kind, 'service')
    assert.equal(result.json.name, '我的公网节点')
    assert.equal(result.json.version, '0.6.2')
    assert.ok(result.json.capabilities.includes('pairing'))
    assert.equal(result.json.hostId, undefined, 'a service node must not publish a flat Host identity')
    assert.equal(result.json.fingerprint, undefined)
    assert.equal(Object.keys(result.json).sort().join(','), 'capabilities,kind,name,node,protocol,version')
    assert.equal(Object.keys(result.json.node).sort().join(','), 'fingerprint,id,publicKey')
    assert.equal(/credential|secret|token|private/i.test(result.text), false, 'discovery must not leak secrets')

    const expected = await identityFromFile(node.dataDir)
    assert.equal(result.json.node.id, expected.nodeId, 'node.id = base64url(sha256(SPKI DER)), 43 chars')
    assert.equal(result.json.node.fingerprint, expected.fingerprint, 'node.fingerprint = first 16 digest bytes, lowercase hex')
    assert.equal(result.json.node.publicKey, expected.publicKey)
    assert.equal(expected.nodeId.length, 43)
    assert.equal(expected.fingerprint.length, 32)
  } finally {
    await node.stop()
  }
})

test('node identity exists before the first Host and is unaffected by Host registration', async () => {
  const node = await startNode()
  try {
    const before = await api(node.baseUrl, 'GET', '/.well-known/dsh-remote')
    assert.match(before.json.node.id, /^[A-Za-z0-9_-]{43}$/u)

    await registerHost(node)
    await registerHost(node)
    const after = await api(node.baseUrl, 'GET', '/.well-known/dsh-remote')
    assert.deepEqual(after.json.node, before.json.node, 'registering Hosts must not change the node identity')
    assert.equal(after.json.node.id.length, 43)
  } finally {
    await node.stop()
  }
})

test('node identity survives a restart of the same DATA_DIR', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-node-identity-restart-'))
  const first = await startNode({ DATA_DIR: dataDir, NODE_NAME: '重启节点' })
  let second: TestNode | null = null
  try {
    const before = await api(first.baseUrl, 'GET', '/.well-known/dsh-remote')
    const fileBefore = await readFile(join(dataDir, 'node-identity.json'), 'utf8')
    await first.app.close()

    second = await startNode({ DATA_DIR: dataDir, NODE_NAME: '重启节点' })
    const after = await api(second.baseUrl, 'GET', '/.well-known/dsh-remote')
    const fileAfter = await readFile(join(dataDir, 'node-identity.json'), 'utf8')
    assert.deepEqual(after.json.node, before.json.node, 'restart must reuse the persisted node identity')
    assert.equal(fileAfter, fileBefore, 'the identity document must not be rewritten on load')
  } finally {
    await first.app.close().catch(() => {})
    if (second) await second.app.close().catch(() => {})
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a corrupted node identity fails fast and is never silently rebuilt', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-node-identity-broken-'))
  const file = join(dataDir, 'node-identity.json')
  const corrupted = '{"version":1,"algorithm":"ed25519","publicKey":"@@@@","createdAt":"2026-01-01T00:00:00.000Z"}\n'
  await writeFile(file, corrupted, 'utf8')
  try {
    await assert.rejects(
      () => startNode({ DATA_DIR: dataDir }),
      (error: any) => /节点身份文件已损坏：/u.test(error?.message ?? ''),
    )
    assert.equal(await readFile(file, 'utf8'), corrupted, 'the broken file must stay untouched')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('host identity matches src/identity.ts for an Ed25519 SPKI key', async () => {
  const identity = await import('../dist/remote-server/src/identity.js')
  const pair = generateKeyPairSync('ed25519')
  const der = pair.publicKey.export({ format: 'der', type: 'spki' })
  const identityKey = der.toString('base64url')
  assert.equal(identityKey.length, 59, 'Ed25519 SPKI DER is 44 bytes and encodes to 59 Base64URL characters')

  const digest = createHash('sha256').update(der).digest()
  const expected = {
    hostId: digest.toString('base64url'),
    fingerprint: digest.subarray(0, 16).toString('hex'),
  }

  assert.deepEqual(identity.deriveHostIdentity(identityKey), expected)
  assert.deepEqual(Buffer.from(identity.decodeIdentityKey(identityKey)), der, 'decodeIdentityKey returns the SPKI DER bytes')
  assert.equal(identity.decodeIdentityKey('A'.repeat(59)), null, 'valid Base64URL that is not SPKI DER must be rejected')
  assert.throws(
    () => identity.deriveHostIdentity('A'.repeat(59)),
    (error: any) => error.status === 400 && error.code === 'INVALID_IDENTITY_KEY',
  )
  const hostExpected = hostIdentityFromKey(identityKey)
  assert.deepEqual(hostExpected, expected)
})

test('healthz and /v1/config expose the v2 service identity and no Host fields', async () => {
  const node = await startNode()
  try {
    const health = await api(node.baseUrl, 'GET', '/healthz')
    assert.equal(health.status, 200)
    assert.deepEqual(health.json, { ok: true, version: '0.6.2' })

    const wellKnown = await api(node.baseUrl, 'GET', '/.well-known/dsh-remote')
    const config = await api(node.baseUrl, 'GET', '/v1/config')
    assert.equal(config.status, 200)
    assert.equal(config.json.protocol, 2)
    assert.equal(config.json.kind, 'service')
    assert.equal(Object.keys(config.json).sort().join(','), 'capabilities,kind,name,node,protocol,version')
    assert.deepEqual(config.json.node, wellKnown.json.node, '/v1/config and well-known must publish the same node identity')
    assert.equal(config.json.hostId, undefined, '/v1/config must not expose a Host identity')
    assert.equal(config.json.fingerprint, undefined)
    assert.equal(config.headers.get('cache-control'), 'no-store')
  } finally {
    await node.stop()
  }
})

test('node schema rejects a wrong protocol, flat Host fields or a malformed node block', () => {
  const valid = {
    protocol: 2,
    kind: 'service',
    name: '我的公网节点',
    version: '0.6.0',
    capabilities: ['pairing', 'cache'],
    node: { id: 'A'.repeat(43), fingerprint: '0'.repeat(32), publicKey: randomIdentityKey() },
  }
  assert.equal(nodeDescriptorSchema.safeParse(valid).success, true)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, protocol: 1 }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, protocol: 3 }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, protocol: '2' }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, kind: 'gateway' }).success, true, 'gateway is a valid contract kind')
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, kind: 'peer' }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, capabilities: ['cache'] }).success, false, 'pairing is required')
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, capabilities: ['pairing', 'cache', 'telepathy'] }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, capabilities: ['pairing', 'pairing'] }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, hostId: 'A'.repeat(43) }).success, false, 'service descriptors carry no flat Host id')
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, fingerprint: '0'.repeat(32) }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, node: undefined }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, node: { ...valid.node, id: 'short' } }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, node: { ...valid.node, fingerprint: 'A'.repeat(32) } }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, node: { ...valid.node, hostId: 'A'.repeat(43) } }).success, false)
  assert.equal(nodeDescriptorSchema.safeParse({ ...valid, extra: true }).success, false, 'descriptor is strict')
})

test('node identity schema rejects a wrong algorithm, malformed key or non-ISO timestamp', () => {
  const valid = {
    version: 1,
    algorithm: 'ed25519',
    publicKey: randomIdentityKey(),
    createdAt: '2026-11-16T00:00:00.000Z',
  }
  assert.equal(nodeIdentitySchema.safeParse(valid).success, true)
  assert.equal(nodeIdentitySchema.safeParse({ ...valid, version: 2 }).success, false)
  assert.equal(nodeIdentitySchema.safeParse({ ...valid, algorithm: 'x25519' }).success, false)
  assert.equal(nodeIdentitySchema.safeParse({ ...valid, publicKey: 'short' }).success, false)
  assert.equal(nodeIdentitySchema.safeParse({ ...valid, createdAt: '2026-11-16' }).success, false)
  assert.equal(nodeIdentitySchema.safeParse({ ...valid, extra: true }).success, false)
})

test('unknown paths return a JSON 404 and wrong methods return 405, never 500', async () => {
  const node = await startNode()
  try {
    const missing = await api(node.baseUrl, 'GET', '/v1/does-not-exist')
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'NOT_FOUND')
    assert.equal(missing.headers.get('content-type'), 'application/json; charset=utf-8')

    const wrongMethod = await api(node.baseUrl, 'POST', '/healthz', { body: {} })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.json.error.code, 'METHOD_NOT_ALLOWED')
  } finally {
    await node.stop()
  }
})

test('HEAD requests are served without a body and the landing page is self-contained', async () => {
  const node = await startNode()
  try {
    const head = await api(node.baseUrl, 'HEAD', '/.well-known/dsh-remote')
    assert.equal(head.status, 200)
    assert.equal(head.text, '')
    assert.ok(Number(head.headers.get('content-length')) > 0)

    for (const path of ['/', '/pair']) {
      const page = await api(node.baseUrl, 'GET', path)
      assert.equal(page.status, 200)
      assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
      assert.equal(page.headers.get('cache-control'), 'no-store')
      assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/u)
      assert.match(page.text, /DSH Remote/u)
      assert.match(page.text, /确认是本机/u)
      assert.match(page.text, /目标主机指纹/u)
      assert.doesNotMatch(page.text, /id="code"/u)
      assert.doesNotMatch(page.text, /\b\d{8}\b/u, 'the pairing page must not render an eight-digit short code')
    }
  } finally {
    await node.stop()
  }
})

test('invalid configuration fails fast instead of silently degrading', async () => {
  await assert.rejects(
    () => startNode({ CAPABILITIES: 'cache' }),
    (error: any) => error?.name === 'ConfigError' && /pairing/u.test(error.message),
  )
  await assert.rejects(
    () => startNode({ CAPABILITIES: 'pairing,turn' }),
    (error: any) => error?.name === 'ConfigError' && /is not one of/u.test(error.message),
  )
  await assert.rejects(
    () => startNode({ PAIRING_TICKET_TTL_SECONDS: '600' }),
    (error: any) => error?.name === 'ConfigError',
  )
  await assert.rejects(
    () => startNode({ NODE_VERSION: '1 2' }),
    (error: any) => error?.name === 'ConfigError' && /NODE_VERSION/u.test(error.message),
  )
})
